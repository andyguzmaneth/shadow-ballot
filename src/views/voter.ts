/**
 * Voter View
 *
 * Displays proposals, manages wallet, and handles the full anamorphic voting flow.
 * The voter sees proposals, clicks a vote button, and the app:
 * 1. Generates a stealth address for the coordinator
 * 2. Signs a 0.001 ETH transfer with an anamorphic nonce encoding the vote
 * 3. Broadcasts the transaction to Sepolia
 * 4. Stores the ephemeral public key for coordinator scanning
 */

import { loadOrCreateWallet, type Wallet } from '../lib/wallet.js';
import { getBalance } from '../lib/tx.js';
import {
  castVote,
  choiceLabel,
  VOTE_YES,
  VOTE_NO,
  VOTE_ABSTAIN,
  type VoteChoice,
} from '../lib/vote.js';
import { generateStealthKeys } from '../lib/stealth.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import {
  DEMO_PROPOSALS,
  ANNOUNCEMENTS_STORAGE_KEY,
  COORDINATOR_STORAGE_KEY,
  type DemoProposal,
} from '../config.js';

const VOTES_STORAGE_KEY = 'shadow-ballot-votes-cast';

interface VoteRecord {
  proposalId: number;
  choice: string;
  txHash: string;
}

interface VoteAnnouncement {
  txHash: string;
  ephemeralPubKey: string;
  proposalId: number;
  stealthAddress: string;
  r: string;
  s: string;
  signedTxHex: string;
}

/** Get or create coordinator stealth keys (shared across views via localStorage). */
function loadOrCreateCoordinator(): { metaAddress: string; spendingKey: Uint8Array; viewingKey: Uint8Array } {
  try {
    const stored = localStorage.getItem(COORDINATOR_STORAGE_KEY);
    if (stored) {
      const data = JSON.parse(stored) as {
        spendingKey: string;
        viewingKey: string;
        metaAddress: string;
      };
      return {
        metaAddress: data.metaAddress,
        spendingKey: hexToBytes(data.spendingKey),
        viewingKey: hexToBytes(data.viewingKey),
      };
    }
  } catch { /* corrupted — regenerate */ }

  const keys = generateStealthKeys();
  localStorage.setItem(
    COORDINATOR_STORAGE_KEY,
    JSON.stringify({
      spendingKey: bytesToHex(keys.spendingKey),
      viewingKey: bytesToHex(keys.viewingKey),
      metaAddress: keys.metaAddress,
    }),
  );
  return {
    metaAddress: keys.metaAddress,
    spendingKey: keys.spendingKey,
    viewingKey: keys.viewingKey,
  };
}

/** Load cast vote records from localStorage. */
function loadVoteRecords(): VoteRecord[] {
  try {
    const stored = localStorage.getItem(VOTES_STORAGE_KEY);
    return stored ? JSON.parse(stored) as VoteRecord[] : [];
  } catch {
    return [];
  }
}

/** Save a vote record. */
function saveVoteRecord(record: VoteRecord): void {
  const records = loadVoteRecords();
  records.push(record);
  localStorage.setItem(VOTES_STORAGE_KEY, JSON.stringify(records));
}

/** Save a vote announcement for coordinator scanning. */
function saveAnnouncement(announcement: VoteAnnouncement): void {
  let announcements: VoteAnnouncement[] = [];
  try {
    const stored = localStorage.getItem(ANNOUNCEMENTS_STORAGE_KEY);
    if (stored) announcements = JSON.parse(stored) as VoteAnnouncement[];
  } catch { /* empty */ }
  announcements.push(announcement);
  localStorage.setItem(ANNOUNCEMENTS_STORAGE_KEY, JSON.stringify(announcements));
}

/** Format ETH balance from wei. */
function formatEth(wei: bigint): string {
  const eth = Number(wei) / 1e18;
  return eth.toFixed(4);
}

/** Truncate address/hash for display. */
function truncateAddr(addr: string): string {
  return addr.slice(0, 6) + '...' + addr.slice(-4);
}

/** Format deadline as relative time. */
function formatDeadline(timestamp: number): string {
  const now = Math.floor(Date.now() / 1000);
  const diff = timestamp - now;
  if (diff <= 0) return 'Ended';
  const days = Math.floor(diff / 86400);
  if (days > 0) return `${days}d remaining`;
  const hours = Math.floor(diff / 3600);
  return `${hours}h remaining`;
}

export function initVoterView(): void {
  const panel = document.getElementById('panel-voter');
  if (!panel) return;

  const wallet = loadOrCreateWallet();
  const coordinator = loadOrCreateCoordinator();
  const voteRecords = loadVoteRecords();

  panel.innerHTML = renderVoterView(wallet, voteRecords);

  attachWalletListeners(wallet);
  attachVoteListeners(wallet, coordinator.metaAddress);
  refreshBalance(wallet.address);
}

function renderVoterView(wallet: Wallet, voteRecords: VoteRecord[]): string {
  const votedProposalIds = new Set(voteRecords.map((r) => r.proposalId));

  return `
    <div class="voter-header">
      <div class="wallet-info">
        <div class="wallet-label">Your Wallet</div>
        <div class="wallet-address">
          <span class="mono" id="voter-address">${truncateAddr(wallet.address)}</span>
          <button class="copy-btn" id="copy-address-btn" title="Copy full address">Copy</button>
        </div>
        <div class="wallet-balance">
          Balance: <span id="voter-balance" class="mono">loading...</span> ETH
          <button class="refresh-btn" id="refresh-balance-btn" title="Refresh balance">Refresh</button>
        </div>
      </div>
      <div id="balance-warning" class="balance-warning" style="display:none;">
        Insufficient balance. You need ~0.002 ETH per vote. Get Sepolia ETH from a faucet.
      </div>
    </div>

    <h2 class="section-title">Active Proposals</h2>

    <div class="proposals-list">
      ${DEMO_PROPOSALS.map((p) => renderProposalCard(p, votedProposalIds.has(p.id), voteRecords.find((r) => r.proposalId === p.id))).join('')}
    </div>

    <div id="vote-status" class="vote-status" style="display:none;"></div>
  `;
}

function renderProposalCard(proposal: DemoProposal, voted: boolean, record?: VoteRecord): string {
  const deadlineStr = formatDeadline(proposal.deadline);
  const isEnded = deadlineStr === 'Ended';

  if (voted && record) {
    return `
      <div class="proposal-card voted">
        <div class="proposal-header">
          <h3 class="proposal-title">${proposal.title}</h3>
          <span class="proposal-deadline">${deadlineStr}</span>
        </div>
        <div class="vote-cast-badge">
          Vote Cast: <strong>${record.choice}</strong>
        </div>
        <div class="vote-tx">
          <a href="https://sepolia.etherscan.io/tx/${record.txHash}" target="_blank" rel="noopener" class="mono etherscan-link">
            ${truncateAddr(record.txHash)}
          </a>
        </div>
      </div>
    `;
  }

  return `
    <div class="proposal-card${isEnded ? ' ended' : ''}" id="proposal-${proposal.id}">
      <div class="proposal-header">
        <h3 class="proposal-title">${proposal.title}</h3>
        <span class="proposal-deadline">${deadlineStr}</span>
      </div>
      ${isEnded ? '<div class="proposal-ended-label">Voting ended</div>' : `
      <div class="vote-buttons" id="vote-btns-${proposal.id}">
        <button class="vote-btn vote-yes" data-proposal="${proposal.id}" data-choice="${VOTE_YES}">YES</button>
        <button class="vote-btn vote-no" data-proposal="${proposal.id}" data-choice="${VOTE_NO}">NO</button>
        <button class="vote-btn vote-abstain" data-proposal="${proposal.id}" data-choice="${VOTE_ABSTAIN}">ABSTAIN</button>
      </div>`}
    </div>
  `;
}

function attachWalletListeners(wallet: Wallet): void {
  const copyBtn = document.getElementById('copy-address-btn');
  if (copyBtn) {
    copyBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(wallet.address).then(() => {
        copyBtn.textContent = 'Copied!';
        setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1500);
      });
    });
  }

  const refreshBtn = document.getElementById('refresh-balance-btn');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', () => {
      refreshBalance(wallet.address);
    });
  }
}

function attachVoteListeners(wallet: Wallet, metaAddress: string): void {
  const buttons = document.querySelectorAll<HTMLButtonElement>('.vote-btn');
  buttons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const proposalId = parseInt(btn.dataset.proposal!, 10);
      const choice = parseInt(btn.dataset.choice!, 10) as VoteChoice;
      handleVote(wallet, metaAddress, proposalId, choice);
    });
  });
}

async function refreshBalance(address: string): Promise<void> {
  const balanceEl = document.getElementById('voter-balance');
  const warningEl = document.getElementById('balance-warning');
  if (!balanceEl) return;

  try {
    const balance = await getBalance(address);
    balanceEl.textContent = formatEth(balance);

    const threshold = 2_000_000_000_000_000n; // 0.002 ETH
    if (warningEl) {
      warningEl.style.display = balance < threshold ? 'block' : 'none';
    }
  } catch (err) {
    balanceEl.textContent = 'error';
    console.error('[voter] Failed to fetch balance:', err);
  }
}

async function handleVote(
  wallet: Wallet,
  metaAddress: string,
  proposalId: number,
  choice: VoteChoice,
): Promise<void> {
  const statusEl = document.getElementById('vote-status');
  const btnsEl = document.getElementById(`vote-btns-${proposalId}`);
  if (!statusEl) return;

  // Disable all vote buttons during processing
  const allBtns = document.querySelectorAll<HTMLButtonElement>('.vote-btn');
  allBtns.forEach((b) => { b.disabled = true; });

  const proposal = DEMO_PROPOSALS.find((p) => p.id === proposalId);
  const proposalTitle = proposal?.title ?? `Proposal #${proposalId}`;

  statusEl.style.display = 'block';
  statusEl.className = 'vote-status loading';
  statusEl.innerHTML = `
    <div class="status-spinner"></div>
    <div class="status-text">
      <strong>Casting vote: ${choiceLabel(choice)}</strong> on "${proposalTitle}"
      <div class="status-detail">Generating stealth address and signing anamorphic transaction...</div>
    </div>
  `;

  try {
    console.log(`[voter] Casting vote: proposal=${proposalId}, choice=${choiceLabel(choice)}`);

    const result = await castVote(
      wallet.privateKey,
      metaAddress,
      proposalId,
      choice,
    );

    console.log(`[voter] Vote cast! txHash=${result.txHash}`);
    console.log(`[voter] Ephemeral pubkey: ${bytesToHex(result.ephemeralPubKey)}`);
    console.log(`[voter] Stealth address: ${result.stealthAddress}`);

    // Save vote record
    const record: VoteRecord = {
      proposalId,
      choice: choiceLabel(choice),
      txHash: result.txHash,
    };
    saveVoteRecord(record);

    // Save announcement for coordinator
    saveAnnouncement({
      txHash: result.txHash,
      ephemeralPubKey: bytesToHex(result.ephemeralPubKey),
      proposalId,
      stealthAddress: result.stealthAddress,
      r: result.r,
      s: result.s,
      signedTxHex: result.signedTxHex,
    });

    // Show success
    statusEl.className = 'vote-status success';
    statusEl.innerHTML = `
      <div class="status-text">
        <strong>Vote cast successfully!</strong>
        <div class="status-detail">
          Your vote was cast as a normal ETH transfer. No one can tell you voted.
        </div>
        <div class="status-tx">
          Transaction: <a href="https://sepolia.etherscan.io/tx/${result.txHash}" target="_blank" rel="noopener" class="mono etherscan-link">${result.txHash}</a>
        </div>
      </div>
    `;

    // Update the proposal card to show "Vote Cast"
    if (btnsEl) {
      const card = btnsEl.closest('.proposal-card');
      if (card) {
        card.classList.add('voted');
        btnsEl.outerHTML = `
          <div class="vote-cast-badge">
            Vote Cast: <strong>${choiceLabel(choice)}</strong>
          </div>
          <div class="vote-tx">
            <a href="https://sepolia.etherscan.io/tx/${result.txHash}" target="_blank" rel="noopener" class="mono etherscan-link">
              ${truncateAddr(result.txHash)}
            </a>
          </div>
        `;
      }
    }

    // Re-enable remaining vote buttons
    document.querySelectorAll<HTMLButtonElement>('.vote-btn').forEach((b) => {
      b.disabled = false;
    });

    // Refresh balance
    refreshBalance(wallet.address);
  } catch (err) {
    console.error('[voter] Vote failed:', err);
    const errorMsg = err instanceof Error ? err.message : String(err);

    statusEl.className = 'vote-status error';
    statusEl.innerHTML = `
      <div class="status-text">
        <strong>Vote failed</strong>
        <div class="status-detail">${errorMsg}</div>
        <button class="retry-btn" id="retry-vote-btn">Retry</button>
      </div>
    `;

    const retryBtn = document.getElementById('retry-vote-btn');
    if (retryBtn) {
      retryBtn.addEventListener('click', () => {
        handleVote(wallet, metaAddress, proposalId, choice);
      });
    }

    allBtns.forEach((b) => { b.disabled = false; });
  }
}
