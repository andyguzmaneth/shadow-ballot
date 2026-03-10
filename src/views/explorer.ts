/**
 * Explorer View
 *
 * The "holy shit" demo moment. Paste any tx hash, see what it looks
 * like publicly (normal ETH transfer), then click Decode to reveal
 * the hidden vote using anamorphic signature extraction.
 *
 * Left panel: "What the world sees" — boring ETH transfer
 * Right panel: "What's actually hidden" — the decoded vote (revealed on click)
 */

import { Transaction, formatEther } from 'ethers';
import { getPublicKey } from '@noble/secp256k1';
import { hexToBytes } from '@noble/hashes/utils.js';
import { decodeVote, type DecodedVote } from '../lib/vote.js';
import { scanForStealthTx } from '../lib/stealth.js';
import {
  DEMO_PROPOSALS,
  ANNOUNCEMENTS_STORAGE_KEY,
  COORDINATOR_STORAGE_KEY,
} from '../config.js';

interface VoteAnnouncement {
  txHash: string;
  ephemeralPubKey: string;
  proposalId: number;
  stealthAddress: string;
  r: string;
  s: string;
  signedTxHex: string;
}

interface StoredCoordinator {
  spendingKey: string;
  viewingKey: string;
  metaAddress: string;
}

interface TxPublicInfo {
  hash: string;
  from: string;
  to: string;
  value: string;
  valueEth: string;
  gasLimit: string;
  maxFeePerGas: string;
  nonce: number;
  chainId: number;
  type: number;
  r: string;
  s: string;
  v: number;
}

function loadAnnouncements(): VoteAnnouncement[] {
  try {
    const stored = localStorage.getItem(ANNOUNCEMENTS_STORAGE_KEY);
    return stored ? (JSON.parse(stored) as VoteAnnouncement[]) : [];
  } catch {
    return [];
  }
}

function loadCoordinator(): {
  spendingKey: Uint8Array;
  viewingKey: Uint8Array;
} | null {
  try {
    const stored = localStorage.getItem(COORDINATOR_STORAGE_KEY);
    if (!stored) return null;
    const data = JSON.parse(stored) as StoredCoordinator;
    return {
      spendingKey: hexToBytes(data.spendingKey),
      viewingKey: hexToBytes(data.viewingKey),
    };
  } catch {
    return null;
  }
}

function truncateHash(hash: string): string {
  return hash.slice(0, 10) + '...' + hash.slice(-6);
}

function truncateAddr(addr: string): string {
  return addr.slice(0, 8) + '...' + addr.slice(-6);
}

/** Parse transaction details from a signed tx hex string. */
function parseTxFromHex(signedTxHex: string, txHash: string): TxPublicInfo {
  const tx = Transaction.from(signedTxHex);
  const sig = tx.signature!;
  return {
    hash: txHash,
    from: tx.from ?? 'unknown',
    to: tx.to ?? 'unknown',
    value: (tx.value ?? 0n).toString(),
    valueEth: formatEther(tx.value ?? 0n),
    gasLimit: (tx.gasLimit ?? 0n).toString(),
    maxFeePerGas: tx.maxFeePerGas ? `${Number(tx.maxFeePerGas) / 1e9} gwei` : 'N/A',
    nonce: tx.nonce,
    chainId: Number(tx.chainId),
    type: tx.type ?? 0,
    r: sig.r,
    s: sig.s,
    v: sig.yParity,
  };
}

/** Attempt to decode the hidden vote from an announcement. */
function tryDecodeVote(
  announcement: VoteAnnouncement,
  coordinator: { spendingKey: Uint8Array; viewingKey: Uint8Array },
): DecodedVote | null {
  try {
    const spendingPubKey = getPublicKey(coordinator.spendingKey, true);
    const ephPub = hexToBytes(announcement.ephemeralPubKey);

    // Verify stealth match
    const stealthMatch = scanForStealthTx(
      coordinator.viewingKey,
      spendingPubKey,
      ephPub,
      announcement.stealthAddress,
    );
    if (!stealthMatch) return null;

    // Reconstruct unsigned tx hash from signed tx hex
    const tx = Transaction.from(announcement.signedTxHex);
    const unsignedTxHash = hexToBytes(tx.unsignedHash.slice(2));

    const proposalIds = DEMO_PROPOSALS.map((p) => p.id);
    return decodeVote(
      coordinator.viewingKey,
      spendingPubKey,
      ephPub,
      announcement.r,
      unsignedTxHash,
      proposalIds,
    );
  } catch (err) {
    console.error('[explorer] Failed to decode vote:', err);
    return null;
  }
}

function renderInitialView(): string {
  return `
    <div class="explorer-intro">
      <h2 class="explorer-title">Transaction Explorer</h2>
      <p class="explorer-subtitle">
        Paste a voting transaction hash to reveal the vote hidden inside a normal ETH transfer.
      </p>
    </div>

    <div class="explorer-input-group">
      <input
        type="text"
        id="explorer-tx-input"
        class="explorer-input mono"
        placeholder="0x..."
        spellcheck="false"
        autocomplete="off"
      />
      <button class="explorer-lookup-btn" id="explorer-lookup-btn">Look Up</button>
    </div>

    <div id="explorer-result"></div>
  `;
}

function renderPublicPanel(info: TxPublicInfo): string {
  return `
    <div class="explorer-panel public-panel">
      <div class="panel-label">What the world sees</div>
      <h3 class="panel-heading">Normal ETH Transfer</h3>
      <div class="panel-details">
        <div class="detail-row">
          <span class="detail-key">Transaction Hash</span>
          <span class="detail-value mono">${truncateHash(info.hash)}</span>
        </div>
        <div class="detail-row">
          <span class="detail-key">From</span>
          <span class="detail-value mono">${truncateAddr(info.from)}</span>
        </div>
        <div class="detail-row">
          <span class="detail-key">To</span>
          <span class="detail-value mono">${truncateAddr(info.to)}</span>
        </div>
        <div class="detail-row">
          <span class="detail-key">Value</span>
          <span class="detail-value">${info.valueEth} ETH</span>
        </div>
        <div class="detail-row">
          <span class="detail-key">Gas Limit</span>
          <span class="detail-value">${info.gasLimit}</span>
        </div>
        <div class="detail-row">
          <span class="detail-key">Max Fee</span>
          <span class="detail-value">${info.maxFeePerGas}</span>
        </div>
        <div class="detail-row">
          <span class="detail-key">Nonce</span>
          <span class="detail-value">${info.nonce}</span>
        </div>
        <div class="detail-row">
          <span class="detail-key">Type</span>
          <span class="detail-value">EIP-1559 (Type 2)</span>
        </div>
        <div class="detail-row">
          <span class="detail-key">Chain</span>
          <span class="detail-value">Sepolia (${info.chainId})</span>
        </div>
      </div>
      <div class="panel-verdict">
        <span class="verdict-icon">&#9679;</span>
        Nothing unusual. Just a simple ETH transfer.
      </div>
      <a href="https://sepolia.etherscan.io/tx/${info.hash}" target="_blank" rel="noopener" class="etherscan-verify-link">
        See for yourself on Etherscan &rarr;
      </a>
    </div>
  `;
}

function renderHiddenPanelLocked(): string {
  return `
    <div class="explorer-panel hidden-panel locked" id="hidden-panel">
      <div class="panel-label accent">What's actually hidden</div>
      <div class="locked-content">
        <div class="lock-icon">&#9881;</div>
        <p class="lock-text">Anamorphic signature detected.<br/>The vote is hidden in the ECDSA nonce.</p>
        <button class="decode-btn" id="decode-btn">
          <span class="decode-btn-text">Decode Hidden Vote</span>
        </button>
      </div>
    </div>
  `;
}

function renderHiddenPanelRevealed(decoded: DecodedVote, announcement: VoteAnnouncement): string {
  const proposal = DEMO_PROPOSALS.find((p) => p.id === decoded.proposalId);
  const proposalTitle = proposal?.title ?? `Proposal #${decoded.proposalId}`;
  const choiceClass = decoded.choiceLabel.toLowerCase();

  return `
    <div class="explorer-panel hidden-panel revealed" id="hidden-panel">
      <div class="panel-label accent">What's actually hidden</div>
      <h3 class="panel-heading">Hidden Vote Decoded</h3>
      <div class="revealed-vote">
        <div class="revealed-proposal">${proposalTitle}</div>
        <div class="revealed-choice ${choiceClass}">${decoded.choiceLabel}</div>
      </div>
      <div class="panel-details revealed-details">
        <div class="detail-row">
          <span class="detail-key">Proposal ID</span>
          <span class="detail-value">${decoded.proposalId}</span>
        </div>
        <div class="detail-row">
          <span class="detail-key">Vote</span>
          <span class="detail-value">${decoded.choiceLabel}</span>
        </div>
        <div class="detail-row">
          <span class="detail-key">Ephemeral Key</span>
          <span class="detail-value mono">${truncateHash(announcement.ephemeralPubKey)}</span>
        </div>
        <div class="detail-row">
          <span class="detail-key">Stealth Address</span>
          <span class="detail-value mono">${truncateAddr(announcement.stealthAddress)}</span>
        </div>
      </div>
      <div class="panel-verdict revealed-verdict">
        <span class="verdict-icon accent-icon">&#9679;</span>
        This "normal transfer" is actually a private vote, hidden in the signature's nonce using anamorphic cryptography.
      </div>
    </div>
  `;
}

function renderNotFound(txHash: string): string {
  return `
    <div class="explorer-not-found">
      <div class="not-found-icon">&#10007;</div>
      <h3>Transaction not found</h3>
      <p>
        No announcement found for <span class="mono">${truncateHash(txHash)}</span>.
        This transaction may not be a Shadow Ballot vote, or it was cast in a different session.
      </p>
    </div>
  `;
}

function renderNoCoordinator(): string {
  return `
    <div class="explorer-not-found">
      <div class="not-found-icon">&#9888;</div>
      <h3>No coordinator keys</h3>
      <p>Decoding requires coordinator keys. Cast a vote from the Voter tab first to generate them.</p>
    </div>
  `;
}

function renderDecodeFailed(): string {
  return `
    <div class="explorer-panel hidden-panel revealed" id="hidden-panel">
      <div class="panel-label accent">What's actually hidden</div>
      <div class="decode-failed">
        <div class="not-found-icon">&#10007;</div>
        <h3>This transaction does not contain a hidden vote</h3>
        <p>The signature could not be decoded against known proposals. It may be a regular transfer.</p>
      </div>
    </div>
  `;
}

// ── State ──

let currentAnnouncement: VoteAnnouncement | null = null;
let currentTxInfo: TxPublicInfo | null = null;
let currentDecoded: DecodedVote | null = null;

export function initExplorerView(): void {
  const panel = document.getElementById('panel-explorer');
  if (!panel) return;

  panel.innerHTML = renderInitialView();
  attachInputListeners();
}

function attachInputListeners(): void {
  const input = document.getElementById('explorer-tx-input') as HTMLInputElement | null;
  const btn = document.getElementById('explorer-lookup-btn');

  if (btn && input) {
    btn.addEventListener('click', () => handleLookup(input.value.trim()));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') handleLookup(input.value.trim());
    });
  }
}

function handleLookup(txHash: string): void {
  const resultEl = document.getElementById('explorer-result');
  if (!resultEl) return;

  if (!txHash) return;

  // Normalize hash
  if (!txHash.startsWith('0x')) txHash = '0x' + txHash;

  console.log(`[explorer] Looking up tx: ${txHash}`);

  // Check for coordinator keys
  const coordinator = loadCoordinator();
  if (!coordinator) {
    resultEl.innerHTML = renderNoCoordinator();
    return;
  }

  // Find announcement in localStorage
  const announcements = loadAnnouncements();
  const announcement = announcements.find(
    (a) => a.txHash.toLowerCase() === txHash.toLowerCase(),
  );

  if (!announcement) {
    resultEl.innerHTML = renderNotFound(txHash);
    return;
  }

  // Parse public tx info from the signed tx hex
  try {
    currentAnnouncement = announcement;
    currentTxInfo = parseTxFromHex(announcement.signedTxHex, announcement.txHash);

    // Pre-decode (but don't show yet — user clicks Decode)
    currentDecoded = tryDecodeVote(announcement, coordinator);

    console.log(`[explorer] TX parsed. Vote decoded: ${currentDecoded ? 'yes' : 'no'}`);

    // Render the split view
    resultEl.innerHTML = `
      <div class="explorer-split">
        ${renderPublicPanel(currentTxInfo)}
        ${renderHiddenPanelLocked()}
      </div>
    `;

    attachDecodeListener();
  } catch (err) {
    console.error('[explorer] Failed to parse transaction:', err);
    resultEl.innerHTML = renderNotFound(txHash);
  }
}

function attachDecodeListener(): void {
  const decodeBtn = document.getElementById('decode-btn');
  if (!decodeBtn) return;

  decodeBtn.addEventListener('click', () => {
    const hiddenPanel = document.getElementById('hidden-panel');
    if (!hiddenPanel || !currentAnnouncement) return;

    // Add decrypting animation class
    hiddenPanel.classList.add('decrypting');

    // Short delay for the decryption visual effect
    setTimeout(() => {
      if (currentDecoded && currentAnnouncement) {
        hiddenPanel.outerHTML = renderHiddenPanelRevealed(currentDecoded, currentAnnouncement);
      } else {
        hiddenPanel.outerHTML = renderDecodeFailed();
      }
    }, 800);
  });
}
