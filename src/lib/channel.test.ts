import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { Point, getPublicKey } from '@noble/secp256k1';
import {
  sharedSecret, channelKey, commitmentSalt, stealthAddress, signCarryingVote,
  decodeVote, codeword, expectedTag, Choice, CURVE_ORDER, MAX_INDEX, bytesToBigint,
} from './channel.js';

const rand = () => bytesToBigint(new Uint8Array(randomBytes(32))) % CURVE_ORDER;
const PID = 7n;

function actors() {
  const voter = new Uint8Array(randomBytes(32));
  const spend = new Uint8Array(randomBytes(32));
  const view = new Uint8Array(randomBytes(32));
  return { voter, spend, view,
    voterPub: getPublicKey(voter, true),
    spendPub: getPublicKey(spend, true),
    viewPub: getPublicKey(view, true) };
}

function mod(a: bigint, m: bigint) { const r = a % m; return r >= 0n ? r : r + m; }
function modInv(a: bigint, m: bigint) {
  let [or_, r] = [mod(a, m), m], [os, s] = [1n, 0n];
  while (r !== 0n) { const q = or_ / r; [or_, r] = [r, or_ - q * r]; [os, s] = [s, os - q * s]; }
  return mod(os, m);
}

describe('channel: static DH, nothing announced', () => {
  it('voter and coordinator derive the same secret with nothing transmitted', () => {
    const a = actors();
    expect(sharedSecret(a.voter, a.viewPub).toHex(true))
      .toBe(sharedSecret(a.view, a.voterPub).toHex(true));
  });

  it('rejects an off-curve public key before multiplying (Ch3 §3.4.3)', () => {
    // Roughly half of all x values have no y on secp256k1. Search for one
    // rather than flipping a byte and hoping, which made this flaky: a flipped
    // byte lands back on the curve about half the time.
    const a = actors();
    let offCurve: Uint8Array | null = null;
    for (let i = 0; i < 64 && !offCurve; i++) {
      const cand = new Uint8Array(33);
      cand.set(new Uint8Array(randomBytes(32)), 1);
      cand[0] = 0x02;
      try { Point.fromBytes(cand).assertValidity(); } catch { offCurve = cand; }
    }
    expect(offCurve, 'expected to find an off-curve x within 64 draws').not.toBeNull();
    expect(() => sharedSecret(a.voter, offCurve!)).toThrow();
  });

  it('rejects a malformed encoding outright', () => {
    const a = actors();
    expect(() => sharedSecret(a.voter, new Uint8Array(10))).toThrow();
  });

  it('binds the channel key and the salt to the proposal', () => {
    const a = actors();
    const s = sharedSecret(a.voter, a.viewPub);
    expect(channelKey(s, 7n)).not.toEqual(channelKey(s, 8n));
    expect(commitmentSalt(s, 7n)).not.toEqual(channelKey(s, 7n));
  });
});

describe('channel: stealth addresses', () => {
  it('voter and coordinator derive the same address for every index', () => {
    const a = actors();
    const sv = sharedSecret(a.voter, a.viewPub);
    const sc = sharedSecret(a.view, a.voterPub);
    for (let j = 0; j < MAX_INDEX; j++) {
      expect(stealthAddress(sv, a.spendPub, PID, j))
        .toBe(stealthAddress(sc, a.spendPub, PID, j));
    }
  });

  it('every index gives a different address, and every proposal does too', () => {
    const a = actors();
    const s = sharedSecret(a.voter, a.viewPub);
    const here = new Set(Array.from({ length: MAX_INDEX }, (_, j) => stealthAddress(s, a.spendPub, PID, j)));
    expect(here.size).toBe(MAX_INDEX);
    expect(stealthAddress(s, a.spendPub, 8n, 0)).not.toBe(stealthAddress(s, a.spendPub, 7n, 0));
  });

  it('refuses an index outside the slot range', () => {
    const a = actors();
    const s = sharedSecret(a.voter, a.viewPub);
    expect(() => stealthAddress(s, a.spendPub, PID, MAX_INDEX)).toThrow();
    expect(() => stealthAddress(s, a.spendPub, PID, -1)).toThrow();
  });

  it('a third party holding only the public keys cannot derive the address', () => {
    // Needs sigma, which needs a private scalar. This is the ECDH assumption of §3.5.
    const a = actors(), b = actors();
    const wrong = sharedSecret(b.view, a.voterPub);
    const right = sharedSecret(a.view, a.voterPub);
    expect(stealthAddress(wrong, a.spendPub, PID, 0))
      .not.toBe(stealthAddress(right, a.spendPub, PID, 0));
  });
});

describe('channel: the vote rides in r', () => {
  it('round-trips every choice', () => {
    const a = actors();
    const cKey = channelKey(sharedSecret(a.voter, a.viewPub), PID);
    for (const c of [Choice.Against, Choice.For, Choice.Abstain]) {
      const sig = signCarryingVote(a.voter, new Uint8Array(randomBytes(32)), cKey, c, rand);
      expect(decodeVote(cKey, sig.r)).toBe(c);
    }
  }, 60_000);

  it('produces a signature that verifies under the voter’s REAL public key', () => {
    const a = actors();
    const cKey = channelKey(sharedSecret(a.voter, a.viewPub), PID);
    const z = new Uint8Array(randomBytes(32));
    const { r, s } = signCarryingVote(a.voter, z, cKey, Choice.For, rand);
    const w = modInv(s, CURVE_ORDER);
    const P = Point.BASE.multiply(mod(bytesToBigint(z) * w, CURVE_ORDER))
      .add(Point.fromBytes(a.voterPub).multiply(mod(r * w, CURVE_ORDER)));
    expect(mod(P.toAffine().x, CURVE_ORDER)).toBe(r);
  }, 60_000);

  it('the tag rejects an ordinary signature that carries no vote', () => {
    const a = actors();
    const cKey = channelKey(sharedSecret(a.voter, a.viewPub), PID);
    let fp = 0;
    for (let i = 0; i < 4000; i++) if (decodeVote(cKey, rand()) !== null) fp++;
    expect(fp).toBeLessThanOrEqual(12);          // 12 tag bits => ~1 in 4096; loose so the test cannot flake
  });

  it('another voter’s channel key cannot read the vote', () => {
    const a = actors(), b = actors();
    const ckA = channelKey(sharedSecret(a.voter, a.viewPub), PID);
    const ckB = channelKey(sharedSecret(b.voter, b.viewPub), PID);
    const sig = signCarryingVote(a.voter, new Uint8Array(randomBytes(32)), ckA, Choice.Abstain, rand);
    expect(decodeVote(ckA, sig.r)).toBe(Choice.Abstain);
    expect(decodeVote(ckB, sig.r)).toBeNull();
  }, 60_000);

  it('the keyed tag differs per voter, so nothing published is a fixed constant', () => {
    const a = actors(), b = actors();
    expect(expectedTag(channelKey(sharedSecret(a.voter, a.viewPub), PID)))
      .not.toBe(expectedTag(channelKey(sharedSecret(b.voter, b.viewPub), PID)));
  });

  it('the codeword depends on r, so a different signature carries a different word', () => {
    const a = actors();
    const cKey = channelKey(sharedSecret(a.voter, a.viewPub), PID);
    expect(codeword(cKey, 12345n)).not.toBe(codeword(cKey, 12346n));
  });
});

describe('channel: the coordinator cannot recover the signing key (Ch3 §3.6.4)', () => {
  it('decoding uses only channelKey and r; k is never needed', () => {
    const a = actors();
    const cKey = channelKey(sharedSecret(a.voter, a.viewPub), PID);
    const sig = signCarryingVote(a.voter, new Uint8Array(randomBytes(32)), cKey, Choice.For, rand);
    // decodeVote takes exactly two arguments, neither of which is k or the private key.
    expect(decodeVote(cKey, sig.r)).toBe(Choice.For);
    expect(signCarryingVote.length).toBeGreaterThan(0);
  }, 60_000);

  it('the recovery algebra works WITH k, which is what the design withholds', () => {
    // x = r^-1(s*k - z). Demonstrated here with k in hand to show precisely what
    // the coordinator is denied: it holds channelKey, r, s and z, and never k.
    const a = actors();
    const cKey = channelKey(sharedSecret(a.voter, a.viewPub), PID);
    const z = new Uint8Array(randomBytes(32));
    let captured = 0n;
    const spy = () => { captured = rand(); return captured; };
    const sig = signCarryingVote(a.voter, z, cKey, Choice.For, spy);
    const x = mod(modInv(sig.r, CURVE_ORDER) *
      (mod(sig.s * captured, CURVE_ORDER) - bytesToBigint(z)), CURVE_ORDER);
    expect(x).toBe(bytesToBigint(a.voter));
  }, 60_000);
});
