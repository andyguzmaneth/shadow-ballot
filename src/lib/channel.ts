/**
 * The vote channel (dissertation Ch3 §3.4.3).
 *
 * The vote is carried by WHICH signature the voter chooses to publish, not by
 * anything hidden inside the nonce. The voter draws k at random, computes
 * r = (kG)_x, and keeps the first signature whose r satisfies
 *
 *     H(c ‖ r) truncated  ==  tag ‖ choice
 *
 * Rejected attempts never leave the machine. The coordinator reads the vote
 * from the public r and never learns k, so the §3.6.4 key-recovery algebra
 * x = r^-1(s·k − z) is closed to it: recovering k from r is the discrete
 * logarithm.
 *
 * Both c and the stealth address come from ONE static Diffie–Hellman secret
 * σ = x·V = v·X. Nothing is announced and nothing is registered: V is in the
 * coordinator's registry and X is recoverable from any signature the voter's
 * address has ever produced.
 */
import { Point, etc } from '@noble/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { concatBytes } from '@noble/hashes/utils.js';
import { CURVE_ORDER as N } from './anamorphic.js';

/** Domain tags. 0x01 stealth address, 0x02 channel key, 0x03 commitment salt (§3.4.4a). */
export const TAG_ADDR = 0x01;
export const TAG_CHANNEL = 0x02;
export const TAG_SALT = 0x03;

/** Vote slots per voter per proposal (Ch3 §3.4.3a). Highest index found wins. */
export const MAX_INDEX = 8;

/** Codeword layout: TAG_BITS of keyed tag, then CHOICE_BITS of choice. */
export const TAG_BITS = 12;
export const CHOICE_BITS = 2;
const CODEWORD_BITS = TAG_BITS + CHOICE_BITS;

export const Choice = { Against: 0, For: 1, Abstain: 2 } as const;
export type Choice = (typeof Choice)[keyof typeof Choice];

export function bytesToBigint(b: Uint8Array): bigint {
  let v = 0n;
  for (const byte of b) v = (v << 8n) | BigInt(byte);
  return v;
}
export function bigintTo32(v: bigint): Uint8Array {
  const out = new Uint8Array(32);
  for (let i = 31; i >= 0; i--) { out[i] = Number(v & 0xffn); v >>= 8n; }
  return out;
}

/**
 * σ = x·V (voter side) or v·X (coordinator side). The same point either way,
 * because scalar multiplication commutes: x(vG) = v(xG) = (xv)G.
 */
export function sharedSecret(scalar: Uint8Array, otherPub: Uint8Array): Point {
  const P = Point.fromBytes(otherPub);
  P.assertValidity();              // §3.4.3: reject off-curve points before multiplying
  return P.multiply(bytesToBigint(scalar));
}

function kdf(tag: number, sigma: Point, proposalId: bigint, index?: number): Uint8Array {
  const parts = [new Uint8Array([tag]), sigma.toBytes(true), bigintTo32(proposalId)];
  if (index !== undefined) parts.push(new Uint8Array([index]));
  return keccak_256(concatBytes(...parts));
}

/** channelKey = H(0x02 ‖ σ ‖ proposalId). One channel key per voter per proposal. */
export function channelKey(sigma: Point, proposalId: bigint): Uint8Array {
  return kdf(TAG_CHANNEL, sigma, proposalId);
}

/** The commitment salt a voter needs to check their own leaf (§3.4.4a). */
export function commitmentSalt(sigma: Point, proposalId: bigint): Uint8Array {
  return kdf(TAG_SALT, sigma, proposalId);
}

/**
 * addr_j = pubKeyToAddress(S + H(0x01 ‖ σ ‖ proposalId ‖ j)·G).
 * S is the coordinator's spending key; j selects one of MAX_INDEX slots.
 */
export function stealthAddress(
  sigma: Point, spendPub: Uint8Array, proposalId: bigint, index: number
): string {
  if (!Number.isInteger(index) || index < 0 || index >= MAX_INDEX) {
    throw new Error(`index out of range [0, ${MAX_INDEX})`);
  }
  const h = bytesToBigint(kdf(TAG_ADDR, sigma, proposalId, index)) % N;
  if (h === 0n) throw new Error('degenerate address tweak');
  const P = Point.fromBytes(spendPub).add(Point.BASE.multiply(h));
  const xy = P.toBytes(false).slice(1);          // drop the 0x04 prefix
  return '0x' + Buffer.from(keccak_256(xy).slice(12)).toString('hex');
}

/** The keyed codeword a candidate r must carry. */
export function codeword(channelKey: Uint8Array, r: bigint): number {
  const h = keccak_256(concatBytes(channelKey, bigintTo32(r)));
  return ((h[0] << 16) | (h[1] << 8) | h[2]) >>> (24 - CODEWORD_BITS);
}

/** The tag is itself keyed, so nothing published is a fixed constant. */
export function expectedTag(channelKey: Uint8Array): number {
  return keccak_256(concatBytes(channelKey, new Uint8Array([0xff])))[0] & ((1 << TAG_BITS) - 1);
}

export interface CarriedSignature { r: bigint; s: bigint; trials: number; }

/**
 * Sign msgHash with the voter's REAL key, resampling k until r carries the vote.
 * `rng` is injected so tests are deterministic; production passes a CSPRNG.
 */
export function signCarryingVote(
  privateKey: Uint8Array, msgHash: Uint8Array, channelKey: Uint8Array,
  choice: Choice, rng: () => bigint, maxTrials = 1 << 22
): CarriedSignature {
  const x = bytesToBigint(privateKey);
  const z = bytesToBigint(msgHash);
  const target = (expectedTag(channelKey) << CHOICE_BITS) | choice;

  for (let trials = 1; trials <= maxTrials; trials++) {
    const k = rng();
    if (k <= 0n || k >= N) continue;
    const r = etc.mod(Point.BASE.multiply(k).toAffine().x, N);
    if (r === 0n) continue;
    if (codeword(channelKey, r) !== target) continue;
    const s = etc.mod(etc.invert(k, N) * (z + r * x), N);
    if (s === 0n) continue;
    return { r, s, trials };
  }
  throw new Error('no accepting nonce found within maxTrials');
}

/** Read the vote from the public r alone. null means "not a vote of ours". */
export function decodeVote(channelKey: Uint8Array, r: bigint): Choice | null {
  const word = codeword(channelKey, r);
  if (word >>> CHOICE_BITS !== expectedTag(channelKey)) return null;
  const choice = word & ((1 << CHOICE_BITS) - 1);
  return choice <= Choice.Abstain ? (choice as Choice) : null;
}

export { N as CURVE_ORDER };
