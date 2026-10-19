/**
 * SPIKE, not part of the evaluated implementation (dissertation Ch6 §6.8).
 *
 * The submitted protocol hides the vote in the ECDSA nonce k. Decoding means
 * re-deriving k, and k plus one signature yields the signing key (Ch3 §3.6.3a).
 * That is why the vote must be signed by a disposable key, which in turn forces
 * the registration phase and the funding-correlation problem (Ch6 §6.3).
 *
 * This spike tests the alternative: hide the vote in r instead.
 *
 *   - The voter samples k at random and keeps the signature whose
 *     r = (kG).x satisfies PRF_kappa(r) == tag || payload.
 *   - The coordinator reads the vote off the PUBLIC r. It never learns k, so
 *     it cannot solve x = r^-1(s*k - z): recovering k from r is the discrete
 *     logarithm.
 *   - kappa comes from a STATIC Diffie-Hellman secret on the voter's own public
 *     key, v*X = x*V, so nothing has to be announced and nothing registered.
 *     The coordinator already knows X: it is recoverable from any signature
 *     that address has ever made.
 *
 * Consequence: the vote can be signed by the voter's real key, inside a
 * transaction they were sending anyway.
 */
import { Point, getPublicKey, etc } from '@noble/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { concatBytes } from '@noble/hashes/utils.js';
import { CURVE_ORDER as N } from '../src/lib/anamorphic.js';

function bytesToBigint(b: Uint8Array): bigint {
  let v = 0n;
  for (const byte of b) v = (v << 8n) | BigInt(byte);
  return v;
}
function bigintTo32(v: bigint): Uint8Array {
  const out = new Uint8Array(32);
  for (let i = 31; i >= 0; i--) { out[i] = Number(v & 0xffn); v >>= 8n; }
  return out;
}

/**
 * kappa = keccak256(0x04 || compress(v*X) || proposalId).
 *
 * Domain tag 0x04 continues Ch3 §3.4.4's separation (0x01 stealth address,
 * 0x02 nonce key, 0x03 view tag). Binding proposalId keeps the static secret
 * from producing one long-lived key across every vote an address ever casts.
 */
export function deriveKappa(sharedPoint: Point, proposalId: bigint): Uint8Array {
  return keccak_256(
    concatBytes(new Uint8Array([0x04]), sharedPoint.toBytes(true), bigintTo32(proposalId))
  );
}

/** Voter side: kappa from their own private key and the coordinator's viewing pubkey. */
export function voterKappa(voterPriv: Uint8Array, coordViewPub: Uint8Array, proposalId: bigint) {
  return deriveKappa(Point.fromBytes(coordViewPub).multiply(bytesToBigint(voterPriv)), proposalId);
}
/** Coordinator side: the same kappa from its viewing key and the voter's pubkey. */
export function coordinatorKappa(coordViewPriv: Uint8Array, voterPub: Uint8Array, proposalId: bigint) {
  return deriveKappa(Point.fromBytes(voterPub).multiply(bytesToBigint(coordViewPriv)), proposalId);
}

/** The keyed codeword a candidate r must carry: tagBits of tag, then the choice. */
export function codeword(kappa: Uint8Array, r: bigint, tagBits: number, choiceBits: number): number {
  const h = keccak_256(concatBytes(kappa, bigintTo32(r)));
  const v = (h[0] << 16) | (h[1] << 8) | h[2];      // 24 bits is plenty
  return v >>> (24 - (tagBits + choiceBits));
}

export interface Encoded { r: bigint; s: bigint; k: bigint; trials: number; }

/**
 * Sign msgHash with the voter's REAL key, resampling k until r carries the vote.
 * Discarded attempts never leave the machine, so nothing extra is published.
 */
export function signCarryingVote(
  privateKey: Uint8Array, msgHash: Uint8Array, kappa: Uint8Array,
  choice: number, tagBits: number, choiceBits: number,
  rng: () => bigint
): Encoded {
  const x = bytesToBigint(privateKey);
  const z = bytesToBigint(msgHash);
  // The tag is itself keyed, so it is derived from kappa rather than fixed:
  // a constant tag would be the same bits for every voter and leak nothing to
  // an observer, but keying it costs nothing and keeps all published material
  // pseudorandom without kappa.
  const tag = keccak_256(concatBytes(kappa, new Uint8Array([0xff])))[0] & ((1 << tagBits) - 1);
  const target = (tag << choiceBits) | choice;

  for (let trials = 1; trials <= 1 << 24; trials++) {
    const k = rng();
    if (k <= 0n || k >= N) continue;
    const r = etc.mod(Point.BASE.multiply(k).toAffine().x, N);
    if (r === 0n) continue;
    if (codeword(kappa, r, tagBits, choiceBits) !== target) continue;
    const s = etc.mod(etc.invert(k, N) * (z + r * x), N);
    if (s === 0n) continue;
    return { r, s, k, trials };
  }
  throw new Error('no accepting nonce found');
}

/** Coordinator: read the vote from the public r alone. Returns null if this is not a vote. */
export function decodeVote(
  kappa: Uint8Array, r: bigint, tagBits: number, choiceBits: number
): number | null {
  const tag = keccak_256(concatBytes(kappa, new Uint8Array([0xff])))[0] & ((1 << tagBits) - 1);
  const word = codeword(kappa, r, tagBits, choiceBits);
  if (word >>> choiceBits !== tag) return null;
  return word & ((1 << choiceBits) - 1);
}

export { N as CURVE_ORDER, getPublicKey, bytesToBigint };
