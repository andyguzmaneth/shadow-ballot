/**
 * Anamorphic ECDSA Signatures
 *
 * Hides secret messages inside ECDSA signatures by controlling the nonce 'k'.
 * Based on "Anamorphic Signatures" (Kutylowski et al., CRYPTO 2023)
 *
 * Uses @noble/secp256k1 v3 for browser-compatible elliptic curve operations.
 */

import { Point, getPublicKey, etc, hashes } from '@noble/secp256k1';
import { sha256 } from '@noble/hashes/sha2.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { concatBytes, utf8ToBytes, bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { hmac } from '@noble/hashes/hmac.js';

// noble/secp256k1 v3 requires hash functions to be explicitly set
hashes.hmacSha256 = (k: Uint8Array, ...m: Uint8Array[]) => hmac(sha256, k, etc.concatBytes(...m));
hashes.sha256 = (...msgs: Uint8Array[]) => sha256(etc.concatBytes(...msgs));

// secp256k1 curve order
const N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141n;

function bytesToBigint(bytes: Uint8Array): bigint {
  return BigInt('0x' + bytesToHex(bytes));
}

/**
 * Sign a message hash with a custom ECDSA nonce k.
 *
 * Unlike standard ECDSA which uses RFC 6979 deterministic nonce,
 * this allows specifying k directly -- the key to anamorphic signatures.
 */
export function signWithCustomNonce(
  privateKey: Uint8Array,
  msgHash: Uint8Array,
  k: bigint
): { r: string; s: string; recovery: number } {
  if (k <= 0n || k >= N) {
    throw new Error('Invalid nonce k: must be in range [1, n-1]');
  }

  const privKey = bytesToBigint(privateKey);

  // r = (k * G).x mod n
  const point = Point.BASE.multiply(k);
  const { x: px, y: py } = point.toAffine();
  const r = etc.mod(px, N);

  if (r === 0n) {
    throw new Error('Invalid r value (zero)');
  }

  // s = k^-1 * (msgHash + r * privKey) mod n
  const z = bytesToBigint(msgHash);
  const kInv = etc.invert(k, N);
  let s = etc.mod(kInv * (z + r * privKey), N);

  if (s === 0n) {
    throw new Error('Invalid s value (zero)');
  }

  // Normalize s to low-S form (required by Ethereum)
  const recovery = py % 2n === 0n ? 0 : 1;
  let adjustedRecovery = recovery;
  if (s > N / 2n) {
    s = N - s;
    adjustedRecovery = recovery ^ 1;
  }

  return {
    r: r.toString(16).padStart(64, '0'),
    s: s.toString(16).padStart(64, '0'),
    recovery: adjustedRecovery,
  };
}

/**
 * Derive nonce k from shared secret and hidden message using KDF.
 *
 * k = keccak256(sharedSecret || publicMessageHash || hiddenMessage)
 * with counter-based rejection loop to keep k in [1, n-1].
 */
export function deriveNonceFromSecret(
  sharedSecret: Uint8Array,
  publicMessageHash: Uint8Array,
  hiddenMessage: Uint8Array
): bigint {
  const input = concatBytes(sharedSecret, publicMessageHash, hiddenMessage);

  let hash = keccak_256(input);
  let k = bytesToBigint(hash);

  let counter = 0;
  while (k >= N || k <= 0n) {
    const counterBytes = new Uint8Array(4);
    new DataView(counterBytes.buffer).setUint32(0, counter, false);
    hash = keccak_256(concatBytes(input, counterBytes));
    k = bytesToBigint(hash);
    counter++;

    if (counter > 1000) {
      throw new Error('Failed to derive valid k after 1000 attempts');
    }
  }

  return k;
}

/**
 * Extract a hidden message from an anamorphic signature.
 *
 * Brute-forces candidate messages: for each, derive k, compute r, compare.
 */
export function extractHiddenMessage(
  signature: { r: string; s: string },
  publicMessage: string,
  sharedSecret: Uint8Array,
  candidateMessages: string[]
): string | null {
  const messageHash = keccak_256(utf8ToBytes(publicMessage));
  const targetR = signature.r;

  for (const candidate of candidateMessages) {
    const k = deriveNonceFromSecret(sharedSecret, messageHash, utf8ToBytes(candidate));
    const point = Point.BASE.multiply(k);
    const r = etc.mod(point.toAffine().x, N);
    const rHex = r.toString(16).padStart(64, '0');

    if (rHex === targetR) {
      return candidate;
    }
  }

  return null;
}

/**
 * Verify an ECDSA signature against a public key and message hash.
 */
/**
 * Verify an ECDSA signature against a public key and pre-hashed message.
 *
 * We implement verification manually because noble/secp256k1 v3's verify()
 * always hashes the message with sha256, but we use keccak256 for Ethereum.
 */
export function verifySignature(
  publicKey: Uint8Array,
  msgHash: Uint8Array,
  signature: { r: string; s: string }
): boolean {
  try {
    const r = BigInt('0x' + signature.r);
    const s = BigInt('0x' + signature.s);
    const z = bytesToBigint(msgHash);

    if (r <= 0n || r >= N || s <= 0n || s >= N) return false;

    const sInv = etc.invert(s, N);
    const u1 = etc.mod(z * sInv, N);
    const u2 = etc.mod(r * sInv, N);

    const pubPoint = Point.fromHex(bytesToHex(publicKey));
    const R = Point.BASE.multiply(u1).add(pubPoint.multiply(u2));
    const v = etc.mod(R.toAffine().x, N);

    return v === r;
  } catch {
    return false;
  }
}

/**
 * High-level API: create an anamorphic signature.
 *
 * Signs publicMessage with the private key, embedding hiddenMessage
 * in the signature nonce via the shared secret.
 */
export function createAnamorphicSignature(
  privateKey: Uint8Array,
  sharedSecret: Uint8Array,
  publicMessage: string,
  hiddenMessage: string
): {
  signature: { r: string; s: string; recovery: number };
  messageHash: string;
  publicMessage: string;
} {
  const messageHash = keccak_256(utf8ToBytes(publicMessage));
  const k = deriveNonceFromSecret(sharedSecret, messageHash, utf8ToBytes(hiddenMessage));
  const signature = signWithCustomNonce(privateKey, messageHash, k);

  return {
    signature,
    messageHash: bytesToHex(messageHash),
    publicMessage,
  };
}

// Re-export for convenience
export { N as CURVE_ORDER, getPublicKey, hexToBytes, bytesToHex, utf8ToBytes };
