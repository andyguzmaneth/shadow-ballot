/**
 * SPIKE tests (dissertation Ch6 §6.8). Excluded from the evaluated suite: see
 * vitest.config.ts. Run with `npx vitest run --config vitest.spike.config.ts`.
 */
import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { Point, getPublicKey } from '@noble/secp256k1';
import {
  voterKappa, coordinatorKappa, signCarryingVote, decodeVote,
  CURVE_ORDER, bytesToBigint,
} from './r-channel.js';

const TAG_BITS = 12;
const CHOICE_BITS = 2;
const randK = () => bytesToBigint(new Uint8Array(randomBytes(32))) % CURVE_ORDER;

function actors() {
  const voterPriv = new Uint8Array(randomBytes(32));
  const coordPriv = new Uint8Array(randomBytes(32));
  return {
    voterPriv, coordPriv,
    voterPub: getPublicKey(voterPriv, true),
    coordPub: getPublicKey(coordPriv, true),
  };
}

describe('r-channel: vote hidden in r, signed by the voter’s real key', () => {
  it('voter and coordinator derive the same kappa with nothing announced', () => {
    const a = actors();
    expect(voterKappa(a.voterPriv, a.coordPub, 7n))
      .toEqual(coordinatorKappa(a.coordPriv, a.voterPub, 7n));
  });

  it('round-trips every choice', () => {
    const a = actors();
    const kappa = voterKappa(a.voterPriv, a.coordPub, 7n);
    for (const choice of [0, 1, 2]) {
      const sig = signCarryingVote(a.voterPriv, new Uint8Array(randomBytes(32)),
        kappa, choice, TAG_BITS, CHOICE_BITS, randK);
      expect(decodeVote(kappa, sig.r, TAG_BITS, CHOICE_BITS)).toBe(choice);
    }
  });

  it('produces a signature that verifies under the voter’s REAL public key', () => {
    // The whole point: this is a normal, valid ECDSA signature by the eligible
    // address, so the transaction needs no disposable wallet.
    const a = actors();
    const kappa = voterKappa(a.voterPriv, a.coordPub, 7n);
    const z = new Uint8Array(randomBytes(32));
    const { r, s } = signCarryingVote(a.voterPriv, z, kappa, 1, TAG_BITS, CHOICE_BITS, randK);
    const zi = bytesToBigint(z);
    const w = modInv(s, CURVE_ORDER);
    const P = Point.BASE.multiply(mod(zi * w, CURVE_ORDER))
      .add(Point.fromBytes(a.voterPub).multiply(mod(r * w, CURVE_ORDER)));
    expect(mod(P.toAffine().x, CURVE_ORDER)).toBe(r);
  });

  it('a non-voter’s transaction decodes to null (the tag rejects it)', () => {
    const a = actors();
    const kappa = voterKappa(a.voterPriv, a.coordPub, 7n);
    let falsePositives = 0;
    for (let i = 0; i < 2000; i++) {
      if (decodeVote(kappa, randK(), TAG_BITS, CHOICE_BITS) !== null) falsePositives++;
    }
    // 12 tag bits => ~1 in 4096. Zero or one over 2000 draws.
    expect(falsePositives).toBeLessThanOrEqual(3);
  });

  it('the coordinator cannot recover the signing key: it never learns k', () => {
    // Ch3 §3.6.3a's attack needs k. Here the coordinator holds kappa, r and s
    // and nothing else; x = r^-1(s*k - z) is unavailable without k, and k is
    // the discrete log of a point with x-coordinate r.
    const a = actors();
    const kappa = voterKappa(a.voterPriv, a.coordPub, 7n);
    const z = new Uint8Array(randomBytes(32));
    const sig = signCarryingVote(a.voterPriv, z, kappa, 2, TAG_BITS, CHOICE_BITS, randK);
    expect(decodeVote(kappa, sig.r, TAG_BITS, CHOICE_BITS)).toBe(2);
    // The decode above used only kappa and r. Confirm that applying the §3.6.3a
    // algebra with the TRUE k would have worked, i.e. the only thing standing
    // between the coordinator and the key is its ignorance of k.
    const xRecovered = mod(modInv(sig.r, CURVE_ORDER) * (mod(sig.s * sig.k, CURVE_ORDER)
      - bytesToBigint(z)), CURVE_ORDER);
    expect(xRecovered).toBe(bytesToBigint(a.voterPriv));
  });
});

function mod(a: bigint, m: bigint): bigint { const r = a % m; return r >= 0n ? r : r + m; }
function modInv(a: bigint, m: bigint): bigint {
  let [old_r, r] = [mod(a, m), m], [old_s, s] = [1n, 0n];
  while (r !== 0n) { const q = old_r / r; [old_r, r] = [r, old_r - q * r]; [old_s, s] = [s, old_s - q * s]; }
  return mod(old_s, m);
}
