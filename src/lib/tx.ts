/**
 * Raw Ethereum Transaction Signing with Custom ECDSA Nonce
 *
 * Builds EIP-1559 transactions and signs them with a custom nonce k
 * (for anamorphic signatures) instead of the standard RFC 6979 nonce.
 * Supports broadcasting to Sepolia via public RPC endpoints.
 *
 * Uses ethers.js v6 for RLP encoding and noble-secp256k1 for custom signing.
 */

import { Transaction, Signature, keccak256 as ethersKeccak256 } from 'ethers';
import { signWithCustomNonce } from './anamorphic.js';
import { hexToBytes } from '@noble/hashes/utils.js';

// Sepolia chain ID
const SEPOLIA_CHAIN_ID = 11155111;

// Public Sepolia RPC endpoints with fallbacks
const SEPOLIA_RPC_URLS = [
  'https://ethereum-sepolia-rpc.publicnode.com',
  'https://rpc.sepolia.org',
  'https://sepolia.gateway.tenderly.co',
];

export interface UnsignedTx {
  to: string;
  from: string;
  value: bigint;
  nonce: number;
  chainId: number;
  type: number;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  gasLimit: bigint;
}

/**
 * Build an unsigned EIP-1559 transaction object.
 */
export function buildTransaction(
  from: string,
  to: string,
  value: bigint,
  nonce: number,
  chainId: number = SEPOLIA_CHAIN_ID
): UnsignedTx {
  return {
    to,
    from,
    value,
    nonce,
    chainId,
    type: 2, // EIP-1559
    maxFeePerGas: 30_000_000_000n, // 30 gwei
    maxPriorityFeePerGas: 2_000_000_000n, // 2 gwei
    gasLimit: 21_000n, // simple ETH transfer
  };
}

/**
 * Sign a transaction with a custom ECDSA nonce k.
 *
 * 1. Build the unsigned tx using ethers.js Transaction for RLP encoding
 * 2. Get the unsigned hash (keccak256 of serialized unsigned tx)
 * 3. Sign with our custom k via noble-secp256k1
 * 4. Inject r, s, v back into the transaction
 * 5. Return the signed serialized tx hex
 */
export function signTransactionWithCustomK(
  unsignedTx: UnsignedTx,
  privateKey: Uint8Array,
  customK: bigint
): { signedTxHex: string; txHash: string; r: string; s: string; v: number } {
  // Build ethers Transaction for RLP encoding
  const tx = Transaction.from({
    to: unsignedTx.to,
    value: unsignedTx.value,
    nonce: unsignedTx.nonce,
    chainId: unsignedTx.chainId,
    type: unsignedTx.type,
    maxFeePerGas: unsignedTx.maxFeePerGas,
    maxPriorityFeePerGas: unsignedTx.maxPriorityFeePerGas,
    gasLimit: unsignedTx.gasLimit,
  });

  // Get the unsigned transaction hash (digest to sign)
  const unsignedHash = tx.unsignedHash;
  const msgHash = hexToBytes(unsignedHash.slice(2)); // remove 0x prefix

  // Sign with our custom nonce k
  const sig = signWithCustomNonce(privateKey, msgHash, customK);

  // Compute recovery bit for EIP-1559 (yParity: 0 or 1)
  const yParity = sig.recovery;

  // Inject the signature into the transaction
  tx.signature = Signature.from({
    r: '0x' + sig.r,
    s: '0x' + sig.s,
    yParity: yParity as 0 | 1,
  });

  // Get signed serialized tx and its hash
  const signedTxHex = tx.serialized;
  const txHash = ethersKeccak256(signedTxHex);

  return {
    signedTxHex,
    txHash,
    r: sig.r,
    s: sig.s,
    v: yParity,
  };
}

/**
 * Make a JSON-RPC call to a Sepolia endpoint with fallback.
 */
async function rpcCall(method: string, params: unknown[]): Promise<unknown> {
  let lastError: Error | null = null;

  for (const url of SEPOLIA_RPC_URLS) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method,
          params,
        }),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json() as { result?: unknown; error?: { message: string; code: number } };

      if (data.error) {
        throw new Error(`RPC error ${data.error.code}: ${data.error.message}`);
      }

      return data.result;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      console.warn(`RPC call to ${url} failed: ${lastError.message}`);
    }
  }

  throw new Error(`All RPC endpoints failed. Last error: ${lastError?.message}`);
}

/**
 * Broadcast a signed transaction to the Sepolia network.
 */
export async function broadcastTransaction(signedTxHex: string): Promise<string> {
  const result = await rpcCall('eth_sendRawTransaction', [signedTxHex]);
  return result as string; // returns tx hash
}

/**
 * Get the transaction count (nonce) for an address.
 */
export async function getTransactionCount(address: string): Promise<number> {
  const result = await rpcCall('eth_getTransactionCount', [address, 'latest']);
  return Number(result as string);
}

/**
 * Get the balance of an address in wei.
 */
export async function getBalance(address: string): Promise<bigint> {
  const result = await rpcCall('eth_getBalance', [address, 'latest']);
  return BigInt(result as string);
}

/**
 * Fetch current gas prices from the network.
 */
export async function getGasPrices(): Promise<{
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}> {
  const baseFee = await rpcCall('eth_gasPrice', []);
  const baseFeeWei = BigInt(baseFee as string);

  return {
    maxFeePerGas: baseFeeWei * 2n, // 2x base fee for safety margin
    maxPriorityFeePerGas: 2_000_000_000n, // 2 gwei tip
  };
}

// Re-export for convenience
export { SEPOLIA_CHAIN_ID, SEPOLIA_RPC_URLS };
