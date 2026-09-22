/**
 * ERC-5564 Announcer integration.
 *
 * Replaces the browser-localStorage demo shim (previously the only way ephemeralPubKey
 * reached the coordinator) with the real ERC-5564 transport: an on-chain Announcement
 * event, emitted by a separate transaction from the vote transfer itself.
 *
 * The vote transaction (tx.ts / vote.ts) remains a bare ETH transfer with zero calldata.
 * This module is the *second*, separate transaction that publishes R — dissertation
 * Ch3, §3.4.3 step 2a.
 */

import { Contract, JsonRpcProvider, Wallet, EventLog } from 'ethers';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, concatBytes } from '@noble/hashes/utils.js';
import { ANNOUNCER_ADDRESS, ERC5564_ANNOUNCER_ABI } from '../config.js';

// Scheme ID 1 = secp256k1, per ERC-5564.
export const SCHEME_ID_SECP256K1 = 1n;

/**
 * Domain tag for the view-tag derivation. Distinct from stealth.ts's 0x01 (address
 * offset) and vote.ts's 0x02 (nonce key) — a third independent use of the same raw
 * ECDH point needs its own tag, same discipline as the 2026-08-18 domain-separation
 * fix (Ch3 finding #7). Without this, the view tag would leak a bit-prefix of either
 * the address secret or the nonce key rather than being an independent value.
 */
const DOMAIN_VIEW_TAG = new Uint8Array([0x03]);

/**
 * Derive the 1-byte view tag from the raw ECDH point, per ERC-5564: metadata's first
 * byte MUST be the view tag, letting a scanner cheaply skip non-matching announcements
 * without a full ECDH recomputation for each one.
 */
export function deriveViewTag(sharedSecretPointBytes: Uint8Array): number {
  const tagged = keccak_256(concatBytes(DOMAIN_VIEW_TAG, sharedSecretPointBytes));
  return tagged[0];
}

/**
 * Build the metadata field for an Announcement: first byte is the view tag, per spec.
 * No additional metadata bytes are used by this protocol today.
 */
export function buildAnnouncementMetadata(viewTag: number): Uint8Array {
  if (viewTag < 0 || viewTag > 255) {
    throw new Error('viewTag must be a single byte (0-255)');
  }
  return new Uint8Array([viewTag]);
}

/**
 * Extract the view tag from a metadata field (first byte).
 */
export function extractViewTag(metadata: Uint8Array): number {
  if (metadata.length < 1) {
    throw new Error('metadata must contain at least the view tag byte');
  }
  return metadata[0];
}

function getProvider(rpcUrl: string): JsonRpcProvider {
  return new JsonRpcProvider(rpcUrl);
}

/**
 * Publish an Announcement for a cast vote. Separate transaction from the vote
 * transfer itself — requires its own signer and gas.
 *
 * NOT unit-tested here (needs a live provider) — consistent with contract.ts,
 * which is also untested for the same reason. Covered instead by the Hardhat-level
 * Announcer.test.cjs, which tests the contract this calls into.
 */
export async function announceVote(
  rpcUrl: string,
  senderPrivateKey: string,
  stealthAddress: string,
  ephemeralPubKeyHex: string,
  viewTag: number
): Promise<string> {
  const provider = getProvider(rpcUrl);
  const wallet = new Wallet(senderPrivateKey, provider);
  const announcer = new Contract(ANNOUNCER_ADDRESS, ERC5564_ANNOUNCER_ABI, wallet);

  const metadata = bytesToHex(buildAnnouncementMetadata(viewTag));
  const tx = await announcer.announce(SCHEME_ID_SECP256K1, stealthAddress, ephemeralPubKeyHex, '0x' + metadata);
  const receipt = await tx.wait();
  return receipt.hash as string;
}

export interface ScannedAnnouncement {
  stealthAddress: string;
  ephemeralPubKey: string;
  viewTag: number;
  txHash: string;
}

/**
 * Scan for Announcement events matching our scheme ID. Coordinator side —
 * cheap first-pass filter by schemeId; view-tag and full ECDH matching happen
 * per-candidate afterward (vote.ts's existing decodeVote logic), same two-stage
 * filtering the real ERC-5564 reference scanning flow uses.
 */
export async function scanAnnouncements(
  rpcUrl: string,
  fromBlock: number,
  toBlock: number | 'latest' = 'latest'
): Promise<ScannedAnnouncement[]> {
  const provider = getProvider(rpcUrl);
  const announcer = new Contract(ANNOUNCER_ADDRESS, ERC5564_ANNOUNCER_ABI, provider);

  const filter = announcer.filters.Announcement(SCHEME_ID_SECP256K1);
  const events = await announcer.queryFilter(filter, fromBlock, toBlock);

  return events
    .filter((e): e is EventLog => 'args' in e)
    .map((e) => ({
      stealthAddress: e.args.stealthAddress as string,
      ephemeralPubKey: e.args.ephemeralPubKey as string,
      viewTag: extractViewTag(Uint8Array.from(Buffer.from((e.args.metadata as string).slice(2), 'hex'))),
      txHash: e.transactionHash,
    }));
}
