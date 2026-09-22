/**
 * Simplified ERC-5564 Stealth Addresses
 *
 * The coordinator publishes a stealth meta-address (spending + viewing public keys).
 * Voters generate one-time stealth addresses using ECDH.
 * The coordinator scans transactions to detect stealth address matches.
 *
 * Uses @noble/secp256k1 v3 for browser-compatible elliptic curve operations.
 */

import { Point, getPublicKey, etc, utils } from '@noble/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, hexToBytes, concatBytes } from '@noble/hashes/utils.js';

// secp256k1 curve order
const N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141n;

/**
 * Domain tag for the stealth-address offset derivation.
 * The raw ECDH point s_ecdh is used for two purposes in this protocol: deriving the
 * stealth-address offset (here, tag 0x01) and deriving the anamorphic nonce key
 * (vote.ts, tag 0x02). Without this tag both derivations would be the same value,
 * coupling two independent uses of one secret with no cryptographic separation
 * (dissertation Ch3, finding #7 from the 2026-08-17 adversarial review).
 */
const DOMAIN_STEALTH_ADDR = new Uint8Array([0x01]);

function bytesToBigint(bytes: Uint8Array): bigint {
  return BigInt('0x' + bytesToHex(bytes));
}

/**
 * Convert a public key (compressed or uncompressed) to an Ethereum address.
 * address = keccak256(uncompressedPubKey[1:])[12:]
 */
function pubKeyToAddress(pubKey: Uint8Array): string {
  // Ensure uncompressed format (65 bytes, starts with 0x04)
  const point = Point.fromHex(bytesToHex(pubKey));
  const uncompressed = point.toBytes(false); // 65 bytes: 04 || x || y
  const hash = keccak_256(uncompressed.slice(1)); // hash x || y (64 bytes)
  const addrBytes = hash.slice(12); // last 20 bytes
  return '0x' + bytesToHex(addrBytes);
}

export interface StealthKeys {
  spendingKey: Uint8Array;
  viewingKey: Uint8Array;
  spendingPubKey: Uint8Array;
  viewingPubKey: Uint8Array;
  metaAddress: string;
}

export interface StealthAddressResult {
  stealthAddress: string;
  ephemeralPubKey: Uint8Array;
  sharedSecret: Uint8Array;
}

/**
 * Generate stealth meta-address key pairs (spending + viewing).
 * The meta-address is the concatenation of both compressed public keys (hex).
 */
export function generateStealthKeys(): StealthKeys {
  const spendingKey = utils.randomSecretKey();
  const viewingKey = utils.randomSecretKey();
  const spendingPubKey = getPublicKey(spendingKey, true); // compressed 33 bytes
  const viewingPubKey = getPublicKey(viewingKey, true);

  // Meta-address: spending pub || viewing pub (hex)
  const metaAddress = bytesToHex(spendingPubKey) + bytesToHex(viewingPubKey);

  return { spendingKey, viewingKey, spendingPubKey, viewingPubKey, metaAddress };
}

/**
 * Parse a stealth meta-address into spending and viewing public keys.
 */
export function parseMetaAddress(metaAddress: string): {
  spendingPubKey: Uint8Array;
  viewingPubKey: Uint8Array;
} {
  // Each compressed public key is 33 bytes = 66 hex chars
  if (metaAddress.length !== 132) {
    throw new Error('Invalid meta-address length: expected 132 hex chars (two compressed public keys)');
  }
  return {
    spendingPubKey: hexToBytes(metaAddress.slice(0, 66)),
    viewingPubKey: hexToBytes(metaAddress.slice(66)),
  };
}

/**
 * Generate a one-time stealth address for sending funds.
 *
 * Sender side:
 * 1. Generate ephemeral key pair
 * 2. ECDH: sharedSecret = ephemeralPrivKey * viewingPubKey
 * 3. stealthPubKey = spendingPubKey + hash(sharedSecret) * G
 * 4. stealthAddress = pubKeyToAddress(stealthPubKey)
 */
export function generateStealthAddress(metaAddress: string): StealthAddressResult {
  const { spendingPubKey, viewingPubKey } = parseMetaAddress(metaAddress);

  // Generate ephemeral key pair
  const ephemeralPrivKey = utils.randomSecretKey();
  const ephemeralPubKey = getPublicKey(ephemeralPrivKey, true);

  // ECDH: shared secret = ephemeralPrivKey * viewingPubKey
  const viewingPoint = Point.fromHex(bytesToHex(viewingPubKey));
  const sharedSecretPoint = viewingPoint.multiply(bytesToBigint(ephemeralPrivKey));
  const sharedSecret = keccak_256(concatBytes(DOMAIN_STEALTH_ADDR, sharedSecretPoint.toBytes(true)));

  // Stealth public key: spendingPubKey + hash(sharedSecret) * G
  const stealthOffset = bytesToBigint(sharedSecret);
  const offsetPoint = Point.BASE.multiply(etc.mod(stealthOffset, N));
  const spendingPoint = Point.fromHex(bytesToHex(spendingPubKey));
  const stealthPubKey = spendingPoint.add(offsetPoint);

  const stealthAddress = pubKeyToAddress(stealthPubKey.toBytes(true));

  return { stealthAddress, ephemeralPubKey, sharedSecret };
}

/**
 * Generate a stealth address deterministically from a known ephemeral private key.
 * Used internally for testing. Same logic as generateStealthAddress but with provided keys.
 */
export function generateStealthAddressFromKeys(
  metaAddress: string,
  ephemeralPrivKey: Uint8Array
): StealthAddressResult {
  const { spendingPubKey, viewingPubKey } = parseMetaAddress(metaAddress);
  const ephemeralPubKey = getPublicKey(ephemeralPrivKey, true);

  const viewingPoint = Point.fromHex(bytesToHex(viewingPubKey));
  const sharedSecretPoint = viewingPoint.multiply(bytesToBigint(ephemeralPrivKey));
  const sharedSecret = keccak_256(concatBytes(DOMAIN_STEALTH_ADDR, sharedSecretPoint.toBytes(true)));

  const stealthOffset = bytesToBigint(sharedSecret);
  const offsetPoint = Point.BASE.multiply(etc.mod(stealthOffset, N));
  const spendingPoint = Point.fromHex(bytesToHex(spendingPubKey));
  const stealthPubKey = spendingPoint.add(offsetPoint);

  const stealthAddress = pubKeyToAddress(stealthPubKey.toBytes(true));

  return { stealthAddress, ephemeralPubKey, sharedSecret };
}

/**
 * Scan a transaction to check if it was sent to one of our stealth addresses.
 *
 * Coordinator side:
 * 1. ECDH: sharedSecret = viewingPrivKey * ephemeralPubKey
 * 2. expectedStealthPubKey = spendingPubKey + hash(sharedSecret) * G
 * 3. Compare expectedAddress with txRecipient
 */
export function scanForStealthTx(
  viewingPrivKey: Uint8Array,
  spendingPubKey: Uint8Array,
  ephemeralPubKey: Uint8Array,
  txRecipient: string
): boolean {
  try {
    // ECDH: shared secret = viewingPrivKey * ephemeralPubKey
    const ephemeralPoint = Point.fromHex(bytesToHex(ephemeralPubKey));
    const sharedSecretPoint = ephemeralPoint.multiply(bytesToBigint(viewingPrivKey));
    const sharedSecret = keccak_256(concatBytes(DOMAIN_STEALTH_ADDR, sharedSecretPoint.toBytes(true)));

    // Stealth public key: spendingPubKey + hash(sharedSecret) * G
    const stealthOffset = bytesToBigint(sharedSecret);
    const offsetPoint = Point.BASE.multiply(etc.mod(stealthOffset, N));
    const spendingPoint = Point.fromHex(bytesToHex(spendingPubKey));
    const stealthPubKey = spendingPoint.add(offsetPoint);

    const expectedAddress = pubKeyToAddress(stealthPubKey.toBytes(true));

    return expectedAddress.toLowerCase() === txRecipient.toLowerCase();
  } catch {
    return false;
  }
}

/**
 * Compute the private key for a stealth address (coordinator can spend received funds).
 *
 * stealthPrivKey = spendingPrivKey + hash(sharedSecret) mod n
 * where sharedSecret = viewingPrivKey * ephemeralPubKey
 */
export function computeStealthPrivateKey(
  spendingPrivKey: Uint8Array,
  viewingPrivKey: Uint8Array,
  ephemeralPubKey: Uint8Array
): Uint8Array {
  // ECDH: shared secret = viewingPrivKey * ephemeralPubKey
  const ephemeralPoint = Point.fromHex(bytesToHex(ephemeralPubKey));
  const sharedSecretPoint = ephemeralPoint.multiply(bytesToBigint(viewingPrivKey));
  const sharedSecret = keccak_256(concatBytes(DOMAIN_STEALTH_ADDR, sharedSecretPoint.toBytes(true)));

  // stealthPrivKey = spendingPrivKey + hash(sharedSecret) mod n
  const spendingScalar = bytesToBigint(spendingPrivKey);
  const offset = bytesToBigint(sharedSecret);
  const stealthScalar = etc.mod(spendingScalar + offset, N);

  const hex = stealthScalar.toString(16).padStart(64, '0');
  return hexToBytes(hex);
}

// Re-export for convenience
export { pubKeyToAddress, getPublicKey, hexToBytes, bytesToHex, Point };
