/**
 * Tests for raw transaction signing with custom ECDSA nonce.
 *
 * These are unit/integration tests that verify:
 * 1. Building unsigned transactions
 * 2. Signing with a custom k and getting valid signatures
 * 3. The r value matches the expected point from k * G
 * 4. Signed transaction can be parsed back correctly
 */

import { describe, it, expect } from 'vitest';
import { Transaction } from 'ethers';
import { Point, etc } from '@noble/secp256k1';
import { sha256 } from '@noble/hashes/sha2.js';
import { hmac } from '@noble/hashes/hmac.js';
import { hashes } from '@noble/secp256k1';
import { hexToBytes } from '@noble/hashes/utils.js';
import { buildTransaction, signTransactionWithCustomK, SEPOLIA_CHAIN_ID } from './tx.js';
import { deriveNonceFromSecret } from './anamorphic.js';

// Initialize noble hashes (required for noble v3)
hashes.hmacSha256 = (k: Uint8Array, ...m: Uint8Array[]) => hmac(sha256, k, etc.concatBytes(...m));
hashes.sha256 = (...msgs: Uint8Array[]) => sha256(etc.concatBytes(...msgs));

const N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141n;

// Test private key (DO NOT use on mainnet)
const TEST_PRIVATE_KEY = hexToBytes('ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');

describe('tx - buildTransaction', () => {
  it('should build a valid EIP-1559 unsigned transaction', () => {
    const tx = buildTransaction(
      '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
      '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
      1_000_000_000_000_000n, // 0.001 ETH
      0,
    );

    expect(tx.type).toBe(2);
    expect(tx.chainId).toBe(SEPOLIA_CHAIN_ID);
    expect(tx.value).toBe(1_000_000_000_000_000n);
    expect(tx.nonce).toBe(0);
    expect(tx.gasLimit).toBe(21_000n);
    expect(tx.maxFeePerGas).toBeGreaterThan(0n);
    expect(tx.maxPriorityFeePerGas).toBeGreaterThan(0n);
  });

  it('should accept custom chain ID', () => {
    const tx = buildTransaction(
      '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
      '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
      0n,
      0,
      1, // mainnet
    );
    expect(tx.chainId).toBe(1);
  });
});

describe('tx - signTransactionWithCustomK', () => {
  it('should sign a transaction with custom k and produce valid signature', () => {
    const unsignedTx = buildTransaction(
      '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
      '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
      1_000_000_000_000_000n,
      0,
    );

    // Use a deterministic k for testing
    const customK = deriveNonceFromSecret(
      hexToBytes('aa'.repeat(32)),
      hexToBytes('bb'.repeat(32)),
      hexToBytes('cc'.repeat(32)),
    );

    const result = signTransactionWithCustomK(unsignedTx, TEST_PRIVATE_KEY, customK);

    expect(result.signedTxHex).toBeTruthy();
    expect(result.signedTxHex.startsWith('0x')).toBe(true);
    expect(result.txHash).toBeTruthy();
    expect(result.txHash.startsWith('0x')).toBe(true);
    expect(result.r).toHaveLength(64);
    expect(result.s).toHaveLength(64);
    expect(result.v === 0 || result.v === 1).toBe(true);
  });

  it('should produce r value matching k * G point x-coordinate', () => {
    const unsignedTx = buildTransaction(
      '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
      '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
      1_000_000_000_000_000n,
      5,
    );

    const customK = deriveNonceFromSecret(
      hexToBytes('11'.repeat(32)),
      hexToBytes('22'.repeat(32)),
      hexToBytes('33'.repeat(32)),
    );

    const result = signTransactionWithCustomK(unsignedTx, TEST_PRIVATE_KEY, customK);

    // r should equal (k * G).x mod n
    const point = Point.BASE.multiply(customK);
    const expectedR = etc.mod(point.toAffine().x, N);
    const expectedRHex = expectedR.toString(16).padStart(64, '0');

    expect(result.r).toBe(expectedRHex);
  });

  it('should produce a parseable signed transaction with correct sender', () => {
    const unsignedTx = buildTransaction(
      '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
      '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
      1_000_000_000_000_000n,
      0,
    );

    const customK = deriveNonceFromSecret(
      hexToBytes('dd'.repeat(32)),
      hexToBytes('ee'.repeat(32)),
      hexToBytes('ff'.repeat(32)),
    );

    const result = signTransactionWithCustomK(unsignedTx, TEST_PRIVATE_KEY, customK);

    // Parse the signed transaction back
    const parsed = Transaction.from(result.signedTxHex);
    expect(parsed.type).toBe(2);
    expect(parsed.chainId).toBe(BigInt(SEPOLIA_CHAIN_ID));
    expect(parsed.to?.toLowerCase()).toBe('0x70997970C51812dc3A010C7d01b50e0d17dc79C8'.toLowerCase());
    expect(parsed.value).toBe(1_000_000_000_000_000n);
    expect(parsed.nonce).toBe(0);

    // Verify the recovered sender address matches
    expect(parsed.from?.toLowerCase()).toBe('0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'.toLowerCase());
  });

  it('should produce different r values for different k values', () => {
    const unsignedTx = buildTransaction(
      '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
      '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
      1_000_000_000_000_000n,
      0,
    );

    const k1 = deriveNonceFromSecret(
      hexToBytes('aa'.repeat(32)),
      hexToBytes('bb'.repeat(32)),
      hexToBytes('01'.padStart(64, '0')),
    );

    const k2 = deriveNonceFromSecret(
      hexToBytes('aa'.repeat(32)),
      hexToBytes('bb'.repeat(32)),
      hexToBytes('02'.padStart(64, '0')),
    );

    const result1 = signTransactionWithCustomK(unsignedTx, TEST_PRIVATE_KEY, k1);
    const result2 = signTransactionWithCustomK(unsignedTx, TEST_PRIVATE_KEY, k2);

    // Different k values should produce different r values
    expect(result1.r).not.toBe(result2.r);
  });
});
