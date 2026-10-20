/**
 * The coordinator's side (dissertation Ch3 §3.4.4).
 *
 * Stealth addresses do the selection work. The coordinator does not test every
 * transaction in the voting window: it derives each eligible voter's expected
 * addresses and looks for transfers to them. One scalar multiplication per
 * eligible address, then MAX_INDEX hashes, once per proposal.
 *
 * It also builds the commitment of §3.4.4a, so each voter can check their own
 * vote was counted and prove it if it was not.
 */
import { keccak_256 } from '@noble/hashes/sha3.js';
import { concatBytes, hexToBytes } from '@noble/hashes/utils.js';
import {
  sharedSecret, channelKey, commitmentSalt, stealthAddress, decodeVote,
  Choice, MAX_INDEX,
} from './channel.js';

/** A voter the coordinator must consider: eligible at the proposal's snapshot. */
export interface EligibleVoter {
  /** Checksummed or lowercase address; compared case-insensitively. */
  address: string;
  /** Compressed public key, recovered from any signature this address has made. */
  publicKey: Uint8Array;
}

/** A transfer seen in the voting window, as an indexer would return it. */
export interface ObservedTransfer {
  from: string;
  to: string;
  /** The signature's r component, as a bigint. */
  r: bigint;
}

export interface CountedVote {
  voter: string;
  /** Which of the voter's slots carried the counted vote (§3.4.3a). */
  index: number;
  choice: Choice;
  /** The leaf this voter can reconstruct to check inclusion (§3.4.4a). */
  leaf: Uint8Array;
}

export interface Tally {
  forVotes: number;
  againstVotes: number;
  abstainVotes: number;
  votes: CountedVote[];
  /** Root of the hiding commitment, published with the tally. */
  commitmentRoot: Uint8Array;
}

const lower = (a: string) => a.toLowerCase();

/** H(addr_j ‖ salt). Hiding: without the salt, the leaf says nothing. */
export function commitmentLeaf(addr: string, salt: Uint8Array): Uint8Array {
  return keccak_256(concatBytes(hexToBytes(addr.replace(/^0x/, '')), salt));
}

/**
 * Scan the window and tally.
 *
 * Where more than one of a voter's slots carried a vote, **the highest index
 * wins** (§3.4.3a). Ordering by index rather than by block is what stops a
 * briber demanding that nothing be sent after the transaction they were shown:
 * the voter can send the high-index vote first and the shown one second, and
 * the two are indistinguishable without the shared secret.
 */
export function tally(
  viewingPriv: Uint8Array,
  spendingPub: Uint8Array,
  proposalId: bigint,
  eligible: EligibleVoter[],
  transfers: ObservedTransfer[]
): Tally {
  const byRecipient = new Map<string, ObservedTransfer[]>();
  for (const t of transfers) {
    const k = lower(t.to);
    (byRecipient.get(k) ?? byRecipient.set(k, []).get(k)!).push(t);
  }

  const votes: CountedVote[] = [];
  for (const voter of eligible) {
    const sigma = sharedSecret(viewingPriv, voter.publicKey);
    const cKey = channelKey(sigma, proposalId);
    let best: CountedVote | null = null;

    for (let j = 0; j < MAX_INDEX; j++) {
      const addr = stealthAddress(sigma, spendingPub, proposalId, j);
      const hits = (byRecipient.get(lower(addr)) ?? [])
        .filter((t) => lower(t.from) === lower(voter.address));
      if (hits.length === 0) continue;

      // A second transfer to the SAME address is a double vote at one slot and
      // is discarded; only the first is read.
      const choice = decodeVote(cKey, hits[0].r);
      if (choice === null) continue;
      best = { voter: voter.address, index: j, choice,
               leaf: commitmentLeaf(addr, commitmentSalt(sigma, proposalId)) };
    }
    if (best) votes.push(best);
  }

  const count = (c: Choice) => votes.filter((v) => v.choice === c).length;
  return {
    forVotes: count(Choice.For),
    againstVotes: count(Choice.Against),
    abstainVotes: count(Choice.Abstain),
    votes,
    commitmentRoot: merkleRoot(votes.map((v) => v.leaf)),
  };
}

/**
 * Root of a sorted Merkle tree over the counted leaves.
 *
 * Sorting makes NON-membership provable, which is the point: a voter whose
 * vote was dropped must be able to prove the absence, not merely fail to find
 * it (§3.4.4a). Duplicate leaves cannot occur, since each is keyed to one
 * voter and one proposal.
 */
export function merkleRoot(leaves: Uint8Array[]): Uint8Array {
  if (leaves.length === 0) return new Uint8Array(32);
  let level = [...leaves].sort(compareBytes);
  while (level.length > 1) {
    const next: Uint8Array[] = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(i + 1 < level.length
        ? hashPair(level[i], level[i + 1])
        : level[i]);                       // odd node promotes unchanged
    }
    level = next;
  }
  return level[0];
}

/** The sibling path a voter needs to check their own leaf is in the root. */
export function merkleProof(leaves: Uint8Array[], leaf: Uint8Array): Uint8Array[] | null {
  let level = [...leaves].sort(compareBytes);
  let idx = level.findIndex((l) => compareBytes(l, leaf) === 0);
  if (idx < 0) return null;
  const path: Uint8Array[] = [];
  while (level.length > 1) {
    const sib = idx % 2 === 0 ? idx + 1 : idx - 1;
    if (sib < level.length) path.push(level[sib]);
    const next: Uint8Array[] = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(i + 1 < level.length
        ? hashPair(level[i], level[i + 1])
        : level[i]);
    }
    idx = Math.floor(idx / 2);
    level = next;
  }
  return path;
}

/** What a voter runs to check their vote was counted. */
export function verifyInclusion(leaf: Uint8Array, path: Uint8Array[], root: Uint8Array): boolean {
  let node = leaf;
  for (const sib of path) node = hashPair(node, sib);
  return compareBytes(node, root) === 0;
}

/** Hash a pair in sorted order, so a proof needs no left/right bookkeeping. */
function hashPair(a: Uint8Array, b: Uint8Array): Uint8Array {
  return compareBytes(a, b) < 0
    ? keccak_256(concatBytes(a, b))
    : keccak_256(concatBytes(b, a));
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}
