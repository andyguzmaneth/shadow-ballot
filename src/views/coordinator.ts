/**
 * Coordinator View
 *
 * Scans for incoming stealth transactions via localStorage announcements,
 * decodes hidden votes from anamorphic signatures, displays per-proposal
 * tallies, and optionally submits aggregated results on-chain.
 */

import { getPublicKey } from '@noble/secp256k1';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { Transaction } from 'ethers';
import { decodeVote, type DecodedVote } from '../lib/vote.js';
import { scanForStealthTx } from '../lib/stealth.js';
import { submitResults } from '../lib/contract.js';
import {
  DEMO_PROPOSALS,
  ANNOUNCEMENTS_STORAGE_KEY,
  COORDINATOR_STORAGE_KEY,
  CONTRACT_ADDRESS,
  type DemoProposal,
} from '../config.js';

interface StoredCoordinator {
  spendingKey: string;
  viewingKey: string;
  metaAddress: string;
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

interface DecodedAnnouncement {
  announcement: VoteAnnouncement;
  decoded: DecodedVote | null;
  stealthMatch: boolean;
}

interface ProposalTally {
  yes: number;
  no: number;
  abstain: number;
  total: number;
}

/** Load coordinator keys from localStorage. Returns null if not found. */
function loadCoordinator(): { spendingKey: Uint8Array; viewingKey: Uint8Array; metaAddress: string } | null {
  try {
    const stored = localStorage.getItem(COORDINATOR_STORAGE_KEY);
    if (!stored) return null;
    const data = JSON.parse(stored) as StoredCoordinator;
    return {
      spendingKey: hexToBytes(data.spendingKey),
      viewingKey: hexToBytes(data.viewingKey),
      metaAddress: data.metaAddress,
    };
  } catch {
    return null;
  }
}

/** Load vote announcements from localStorage. */
function loadAnnouncements(): VoteAnnouncement[] {
  try {
    const stored = localStorage.getItem(ANNOUNCEMENTS_STORAGE_KEY);
    return stored ? JSON.parse(stored) as VoteAnnouncement[] : [];
  } catch {
    return [];
  }
}

/** Reconstruct the unsigned tx hash from a signed tx hex string. */
function getUnsignedTxHash(signedTxHex: string): Uint8Array {
  const tx = Transaction.from(signedTxHex);
  return hexToBytes(tx.unsignedHash.slice(2));
}

/** Scan and decode all announcements. */
function scanAndDecode(
  viewingKey: Uint8Array,
  spendingKey: Uint8Array,
  announcements: VoteAnnouncement[],
): DecodedAnnouncement[] {
  const spendingPubKey = getPublicKey(spendingKey, true);
  const proposalIds = DEMO_PROPOSALS.map((p) => p.id);

  return announcements.map((ann) => {
    const ephPub = hexToBytes(ann.ephemeralPubKey);

    // Check stealth address match
    const stealthMatch = scanForStealthTx(
      viewingKey,
      spendingPubKey,
      ephPub,
      ann.stealthAddress,
    );

    let decoded: DecodedVote | null = null;
    if (stealthMatch) {
      try {
        const unsignedTxHash = getUnsignedTxHash(ann.signedTxHex);
        decoded = decodeVote(
          viewingKey,
          spendingPubKey,
          ephPub,
          ann.r,
          unsignedTxHash,
          proposalIds,
        );
      } catch (err) {
        console.error(`[coordinator] Failed to decode vote for tx ${ann.txHash}:`, err);
      }
    }

    return { announcement: ann, decoded, stealthMatch };
  });
}

/** Compute tally per proposal from decoded results. */
function computeTallies(results: DecodedAnnouncement[]): Map<number, ProposalTally> {
  const tallies = new Map<number, ProposalTally>();
  for (const p of DEMO_PROPOSALS) {
    tallies.set(p.id, { yes: 0, no: 0, abstain: 0, total: 0 });
  }

  for (const r of results) {
    if (!r.decoded) continue;
    const tally = tallies.get(r.decoded.proposalId);
    if (!tally) continue;

    tally.total++;
    switch (r.decoded.choice) {
      case 0x01: tally.yes++; break;
      case 0x02: tally.no++; break;
      case 0x03: tally.abstain++; break;
    }
  }

  return tallies;
}

function truncateHash(hash: string): string {
  return hash.slice(0, 10) + '...' + hash.slice(-6);
}

function renderNoCoordinator(): string {
  return `
    <div class="coordinator-empty">
      <h2>Coordinator Panel</h2>
      <p>No coordinator keys found. Cast a vote from the Voter tab first to generate coordinator keys.</p>
    </div>
  `;
}

function renderCoordinatorView(
  results: DecodedAnnouncement[],
  tallies: Map<number, ProposalTally>,
  isScanning: boolean,
): string {
  const decodedCount = results.filter((r) => r.decoded !== null).length;
  const totalAnnouncements = results.length;

  return `
    <div class="coordinator-header">
      <div class="coordinator-info">
        <div class="coordinator-label">Coordinator Panel</div>
        <p class="coordinator-desc">Scan stealth transactions, decode hidden votes, and publish results on-chain.</p>
      </div>
      <div class="coordinator-actions">
        <button class="scan-btn" id="scan-votes-btn" ${isScanning ? 'disabled' : ''}>
          ${isScanning ? '<span class="btn-spinner"></span> Scanning...' : 'Scan Votes'}
        </button>
      </div>
    </div>

    <div class="scan-status" id="scan-status" ${totalAnnouncements === 0 && !isScanning ? 'style="display:none"' : ''}>
      <div class="scan-stat">
        <span class="scan-stat-value">${totalAnnouncements}</span>
        <span class="scan-stat-label">Announcements</span>
      </div>
      <div class="scan-stat">
        <span class="scan-stat-value">${decodedCount}</span>
        <span class="scan-stat-label">Decoded</span>
      </div>
      <div class="scan-stat">
        <span class="scan-stat-value">${totalAnnouncements - decodedCount}</span>
        <span class="scan-stat-label">Failed</span>
      </div>
    </div>

    <h2 class="section-title">Vote Tallies</h2>
    <div class="tallies-list">
      ${DEMO_PROPOSALS.map((p) => renderTallyCard(p, tallies.get(p.id)!)).join('')}
    </div>

    ${results.length > 0 ? `
    <h2 class="section-title" style="margin-top:1.5rem;">Decoded Transactions</h2>
    <div class="decoded-list">
      ${results.map(renderDecodedRow).join('')}
    </div>
    ` : ''}

    <div id="submit-status" class="submit-status" style="display:none;"></div>
  `;
}

function renderTallyCard(proposal: DemoProposal, tally: ProposalTally): string {
  const maxVote = Math.max(tally.yes, tally.no, tally.abstain, 1);
  const contractDeployed = CONTRACT_ADDRESS !== '0x0000000000000000000000000000000000000000';

  return `
    <div class="tally-card">
      <div class="tally-header">
        <h3 class="tally-title">${proposal.title}</h3>
        <span class="tally-total">${tally.total} vote${tally.total !== 1 ? 's' : ''}</span>
      </div>
      <div class="tally-bars">
        <div class="tally-row">
          <span class="tally-label yes-label">YES</span>
          <div class="tally-bar-bg">
            <div class="tally-bar yes-bar" style="width:${(tally.yes / maxVote) * 100}%"></div>
          </div>
          <span class="tally-count">${tally.yes}</span>
        </div>
        <div class="tally-row">
          <span class="tally-label no-label">NO</span>
          <div class="tally-bar-bg">
            <div class="tally-bar no-bar" style="width:${(tally.no / maxVote) * 100}%"></div>
          </div>
          <span class="tally-count">${tally.no}</span>
        </div>
        <div class="tally-row">
          <span class="tally-label abstain-label">ABSTAIN</span>
          <div class="tally-bar-bg">
            <div class="tally-bar abstain-bar" style="width:${(tally.abstain / maxVote) * 100}%"></div>
          </div>
          <span class="tally-count">${tally.abstain}</span>
        </div>
      </div>
      ${tally.total > 0 ? `
      <div class="tally-actions">
        <button class="submit-btn" data-proposal="${proposal.id}" ${!contractDeployed ? 'disabled title="Contract not deployed"' : ''}>
          Submit Results On-Chain
        </button>
      </div>` : ''}
    </div>
  `;
}

function renderDecodedRow(result: DecodedAnnouncement): string {
  const ann = result.announcement;
  const statusClass = result.decoded ? 'decoded-success' : (result.stealthMatch ? 'decoded-fail' : 'decoded-no-match');
  const statusText = result.decoded
    ? `${result.decoded.choiceLabel} on "${DEMO_PROPOSALS.find((p) => p.id === result.decoded!.proposalId)?.title ?? `#${result.decoded.proposalId}`}"`
    : (result.stealthMatch ? 'Decode failed' : 'No stealth match');

  return `
    <div class="decoded-row ${statusClass}">
      <div class="decoded-tx">
        <a href="https://sepolia.etherscan.io/tx/${ann.txHash}" target="_blank" rel="noopener" class="mono etherscan-link">
          ${truncateHash(ann.txHash)}
        </a>
      </div>
      <div class="decoded-result">
        ${result.decoded ? `<span class="decoded-vote-badge ${result.decoded.choiceLabel.toLowerCase()}">${result.decoded.choiceLabel}</span>` : ''}
        <span class="decoded-detail">${statusText}</span>
      </div>
    </div>
  `;
}

// State
let scanResults: DecodedAnnouncement[] = [];
let tallies: Map<number, ProposalTally> = new Map();

export function initCoordinatorView(): void {
  const panel = document.getElementById('panel-coordinator');
  if (!panel) return;

  const coordinator = loadCoordinator();
  if (!coordinator) {
    panel.innerHTML = renderNoCoordinator();
    return;
  }

  // Initialize empty tallies
  tallies = computeTallies([]);
  panel.innerHTML = renderCoordinatorView([], tallies, false);

  attachListeners(coordinator);
}

function attachListeners(coordinator: { spendingKey: Uint8Array; viewingKey: Uint8Array; metaAddress: string }): void {
  const scanBtn = document.getElementById('scan-votes-btn');
  if (scanBtn) {
    scanBtn.addEventListener('click', () => handleScan(coordinator));
  }

  attachSubmitListeners(coordinator);
}

function attachSubmitListeners(coordinator: { spendingKey: Uint8Array; viewingKey: Uint8Array }): void {
  const submitBtns = document.querySelectorAll<HTMLButtonElement>('.submit-btn');
  submitBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      const proposalId = parseInt(btn.dataset.proposal!, 10);
      handleSubmitResults(coordinator, proposalId);
    });
  });
}

function handleScan(coordinator: { spendingKey: Uint8Array; viewingKey: Uint8Array; metaAddress: string }): void {
  const panel = document.getElementById('panel-coordinator');
  if (!panel) return;

  // Show scanning state
  tallies = computeTallies([]);
  panel.innerHTML = renderCoordinatorView([], tallies, true);

  // Use setTimeout to allow the UI to update before blocking on crypto
  setTimeout(() => {
    const announcements = loadAnnouncements();
    console.log(`[coordinator] Found ${announcements.length} announcements`);

    if (announcements.length === 0) {
      tallies = computeTallies([]);
      panel.innerHTML = renderCoordinatorView([], tallies, false);
      attachListeners(coordinator);

      const statusEl = document.getElementById('scan-status');
      if (statusEl) {
        statusEl.style.display = '';
        statusEl.innerHTML = `
          <div class="scan-empty">No vote announcements found. Votes need to be cast from the Voter tab first.</div>
        `;
      }
      return;
    }

    scanResults = scanAndDecode(coordinator.viewingKey, coordinator.spendingKey, announcements);
    tallies = computeTallies(scanResults);

    console.log(`[coordinator] Decoded ${scanResults.filter((r) => r.decoded).length}/${scanResults.length} votes`);

    panel.innerHTML = renderCoordinatorView(scanResults, tallies, false);
    attachListeners(coordinator);
  }, 50);
}

async function handleSubmitResults(
  coordinator: { spendingKey: Uint8Array; viewingKey: Uint8Array },
  proposalId: number,
): Promise<void> {
  const statusEl = document.getElementById('submit-status');
  if (!statusEl) return;

  const tally = tallies.get(proposalId);
  if (!tally || tally.total === 0) return;

  const proposal = DEMO_PROPOSALS.find((p) => p.id === proposalId);
  const proposalTitle = proposal?.title ?? `Proposal #${proposalId}`;

  statusEl.style.display = 'block';
  statusEl.className = 'submit-status loading';
  statusEl.innerHTML = `
    <div class="status-spinner"></div>
    <div class="status-text">
      <strong>Submitting results for "${proposalTitle}"</strong>
      <div class="status-detail">YES: ${tally.yes}, NO: ${tally.no}, ABSTAIN: ${tally.abstain}</div>
    </div>
  `;

  // Disable all submit buttons
  document.querySelectorAll<HTMLButtonElement>('.submit-btn').forEach((b) => { b.disabled = true; });

  try {
    // Use the coordinator spending key as the wallet key for contract interaction
    const privKeyHex = '0x' + bytesToHex(coordinator.spendingKey);
    const txHash = await submitResults(
      privKeyHex,
      BigInt(proposalId),
      BigInt(tally.yes),
      BigInt(tally.no),
      BigInt(tally.abstain),
    );

    statusEl.className = 'submit-status success';
    statusEl.innerHTML = `
      <div class="status-text">
        <strong>Results submitted on-chain!</strong>
        <div class="status-detail">
          "${proposalTitle}" — YES: ${tally.yes}, NO: ${tally.no}, ABSTAIN: ${tally.abstain}
        </div>
        <div class="status-tx">
          Transaction: <a href="https://sepolia.etherscan.io/tx/${txHash}" target="_blank" rel="noopener" class="mono etherscan-link">${txHash}</a>
        </div>
      </div>
    `;
  } catch (err) {
    console.error('[coordinator] Submit results failed:', err);
    const errorMsg = err instanceof Error ? err.message : String(err);

    statusEl.className = 'submit-status error';
    statusEl.innerHTML = `
      <div class="status-text">
        <strong>Failed to submit results</strong>
        <div class="status-detail">${errorMsg}</div>
      </div>
    `;
  }

  // Re-enable submit buttons
  document.querySelectorAll<HTMLButtonElement>('.submit-btn').forEach((b) => { b.disabled = false; });
}
