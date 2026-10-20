import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { getPublicKey } from '@noble/secp256k1';
import {
  sharedSecret, channelKey, commitmentSalt, stealthAddress, signCarryingVote,
  Choice, CURVE_ORDER, MAX_INDEX, bytesToBigint,
} from './channel.js';
import {
  tally, commitmentLeaf, merkleRoot, merkleProof, verifyInclusion,
  type EligibleVoter, type ObservedTransfer,
} from './coordinator.js';

const rand = () => bytesToBigint(new Uint8Array(randomBytes(32))) % CURVE_ORDER;
const PID = 11n;

function world(nVoters: number) {
  const spend = new Uint8Array(randomBytes(32));
  const view = new Uint8Array(randomBytes(32));
  const spendPub = getPublicKey(spend, true);
  const voters = Array.from({ length: nVoters }, () => {
    const priv = new Uint8Array(randomBytes(32));
    const pub = getPublicKey(priv, true);
    const addr = '0x' + Buffer.from(randomBytes(20)).toString('hex');
    return { priv, pub, addr };
  });
  const eligible: EligibleVoter[] = voters.map((v) => ({ address: v.addr, publicKey: v.pub }));
  return { spend, view, spendPub, voters, eligible };
}

/** Cast a vote and return the transfer an indexer would see. */
function cast(w: ReturnType<typeof world>, i: number, choice: Choice, index = 0): ObservedTransfer {
  const v = w.voters[i];
  const sigma = sharedSecret(v.priv, getPublicKey(w.view, true));
  const cKey = channelKey(sigma, PID);
  const sig = signCarryingVote(v.priv, new Uint8Array(randomBytes(32)), cKey, choice, rand);
  return { from: v.addr, to: stealthAddress(sigma, w.spendPub, PID, index), r: sig.r };
}

describe('coordinator: scanning and tallying', () => {
  it('counts one vote per voter and reads each choice correctly', () => {
    const w = world(3);
    const transfers = [
      cast(w, 0, Choice.For), cast(w, 1, Choice.Against), cast(w, 2, Choice.Abstain),
    ];
    const t = tally(w.view, w.spendPub, PID, w.eligible, transfers);
    expect([t.forVotes, t.againstVotes, t.abstainVotes]).toEqual([1, 1, 1]);
    expect(t.votes).toHaveLength(3);
  }, 60_000);

  it('ignores ordinary transfers that are not votes', () => {
    const w = world(2);
    const noise: ObservedTransfer[] = [
      { from: w.voters[0].addr, to: '0x' + 'ab'.repeat(20), r: rand() },
      { from: '0x' + 'cd'.repeat(20), to: '0x' + 'ef'.repeat(20), r: rand() },
    ];
    const t = tally(w.view, w.spendPub, PID, w.eligible, [...noise, cast(w, 0, Choice.For)]);
    expect(t.votes).toHaveLength(1);
    expect(t.forVotes).toBe(1);
  }, 60_000);

  it('ignores a transfer from an address outside the eligible set', () => {
    const w = world(2);
    const outsider = cast(w, 0, Choice.For);
    const t = tally(w.view, w.spendPub, PID, [w.eligible[1]], [outsider]);
    expect(t.votes).toHaveLength(0);
  }, 60_000);

  it('counts the HIGHEST index when a voter votes more than once (Ch3 §3.4.3a)', () => {
    // The whole bribery-resistance argument rests on this ordering: index, not
    // block order, so the voter can send the real vote first.
    const w = world(1);
    const shown = cast(w, 0, Choice.For, 0);
    const real = cast(w, 0, Choice.Against, 5);
    const t = tally(w.view, w.spendPub, PID, w.eligible, [real, shown]); // real broadcast FIRST
    expect(t.votes).toHaveLength(1);
    expect(t.votes[0].index).toBe(5);
    expect(t.againstVotes).toBe(1);
    expect(t.forVotes).toBe(0);
  }, 60_000);

  it('a vote at the top slot still counts', () => {
    const w = world(1);
    const t = tally(w.view, w.spendPub, PID, w.eligible, [cast(w, 0, Choice.For, MAX_INDEX - 1)]);
    expect(t.votes[0].index).toBe(MAX_INDEX - 1);
  }, 60_000);

  it('does not count a vote cast for a different proposal', () => {
    const w = world(1);
    const other = cast(w, 0, Choice.For);
    const t = tally(w.view, w.spendPub, 99n, w.eligible, [other]);
    expect(t.votes).toHaveLength(0);
  }, 60_000);
});

describe('coordinator: the commitment a voter checks (Ch3 §3.4.4a)', () => {
  it('a voter can reconstruct their own leaf and prove it is in the root', () => {
    const w = world(4);
    const transfers = [0, 1, 2, 3].map((i) => cast(w, i, Choice.For));
    const t = tally(w.view, w.spendPub, PID, w.eligible, transfers);

    // Voter 2 recomputes their leaf from their OWN key, with no help.
    const v = w.voters[2];
    const sigma = sharedSecret(v.priv, getPublicKey(w.view, true));
    const addr = stealthAddress(sigma, w.spendPub, PID, 0);
    const mine = commitmentLeaf(addr, commitmentSalt(sigma, PID));

    const path = merkleProof(t.votes.map((x) => x.leaf), mine);
    expect(path).not.toBeNull();
    expect(verifyInclusion(mine, path!, t.commitmentRoot)).toBe(true);
  }, 90_000);

  it('a dropped vote is detectable by its owner', () => {
    const w = world(3);
    const transfers = [0, 1, 2].map((i) => cast(w, i, Choice.For));
    const full = tally(w.view, w.spendPub, PID, w.eligible, transfers);

    // A censoring coordinator omits voter 1 and publishes a root over the rest.
    const kept = full.votes.filter((x) => x.voter !== w.voters[1].addr);
    const censoredRoot = merkleRoot(kept.map((x) => x.leaf));

    const dropped = full.votes.find((x) => x.voter === w.voters[1].addr)!.leaf;
    expect(merkleProof(kept.map((x) => x.leaf), dropped)).toBeNull();
    const path = merkleProof(full.votes.map((x) => x.leaf), dropped)!;
    expect(verifyInclusion(dropped, path, censoredRoot)).toBe(false);
  }, 90_000);

  it('the leaf is hiding: it reveals nothing without the salt', () => {
    const w = world(2);
    const a = sharedSecret(w.voters[0].priv, getPublicKey(w.view, true));
    const addr = stealthAddress(a, w.spendPub, PID, 0);
    expect(commitmentLeaf(addr, commitmentSalt(a, PID)))
      .not.toEqual(commitmentLeaf(addr, new Uint8Array(32)));
  });

  it('an empty tally commits to the zero root', () => {
    const w = world(1);
    const t = tally(w.view, w.spendPub, PID, w.eligible, []);
    expect(t.commitmentRoot).toEqual(new Uint8Array(32));
  });

  it('proofs verify for every leaf in trees of awkward sizes', () => {
    for (const n of [1, 2, 3, 5, 8, 9]) {
      const leaves = Array.from({ length: n }, () => new Uint8Array(randomBytes(32)));
      const root = merkleRoot(leaves);
      for (const l of leaves) {
        expect(verifyInclusion(l, merkleProof(leaves, l)!, root), `n=${n}`).toBe(true);
      }
    }
  });
});
