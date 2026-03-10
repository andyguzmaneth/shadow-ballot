/**
 * Wallet Management
 *
 * Generates and persists voter wallets in localStorage.
 * Each wallet is a simple secp256k1 key pair with an Ethereum address.
 */

import { getPublicKey, utils } from '@noble/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { Point } from '@noble/secp256k1';

const WALLET_STORAGE_KEY = 'shadow-ballot-wallet';

export interface Wallet {
  privateKey: Uint8Array;
  publicKey: Uint8Array;
  address: string;
}

/**
 * Derive an Ethereum address from a public key.
 * address = '0x' + keccak256(uncompressedPubKey[1:])[12:]
 */
function pubKeyToAddress(pubKey: Uint8Array): string {
  const point = Point.fromHex(bytesToHex(pubKey));
  const uncompressed = point.toBytes(false); // 65 bytes: 04 || x || y
  const hash = keccak_256(uncompressed.slice(1));
  const addrBytes = hash.slice(12);
  return '0x' + bytesToHex(addrBytes);
}

/**
 * Generate a new random wallet.
 */
export function generateWallet(): Wallet {
  const privateKey = utils.randomSecretKey();
  const publicKey = getPublicKey(privateKey, true); // compressed
  const address = pubKeyToAddress(publicKey);
  return { privateKey, publicKey, address };
}

/**
 * Load wallet from localStorage, or create and persist a new one.
 */
export function loadOrCreateWallet(): Wallet {
  try {
    const stored = localStorage.getItem(WALLET_STORAGE_KEY);
    if (stored) {
      const data = JSON.parse(stored) as { privateKey: string };
      const privateKey = hexToBytes(data.privateKey);
      const publicKey = getPublicKey(privateKey, true);
      const address = pubKeyToAddress(publicKey);
      return { privateKey, publicKey, address };
    }
  } catch {
    // Corrupted storage — regenerate
  }

  const wallet = generateWallet();
  localStorage.setItem(
    WALLET_STORAGE_KEY,
    JSON.stringify({ privateKey: bytesToHex(wallet.privateKey) })
  );
  return wallet;
}
