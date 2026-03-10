import { describe, it, expect } from 'vitest';
import { getPublicKey } from '@noble/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { utf8ToBytes, hexToBytes } from '@noble/hashes/utils.js';
import {
  signWithCustomNonce,
  deriveNonceFromSecret,
  extractHiddenMessage,
  verifySignature,
  createAnamorphicSignature,
  CURVE_ORDER,
} from './anamorphic';

const privateKey = hexToBytes('ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
const publicKey = getPublicKey(privateKey, false);
const sharedSecret = hexToBytes('deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef');

describe('Anamorphic ECDSA', () => {
  it('signs with custom nonce and verifies', () => {
    const message = 'Hello, world!';
    const msgHash = keccak_256(utf8ToBytes(message));
    const k = deriveNonceFromSecret(sharedSecret, msgHash, utf8ToBytes('test'));

    const sig = signWithCustomNonce(privateKey, msgHash, k);

    expect(sig.r).toHaveLength(64);
    expect(sig.s).toHaveLength(64);
    expect(verifySignature(publicKey, msgHash, sig)).toBe(true);
  });

  it('extracts hidden message from anamorphic signature', () => {
    const hiddenMessage = 'VOTE_YES';
    const publicMessage = 'Transfer 0.001 ETH';
    const candidates = ['VOTE_YES', 'VOTE_NO', 'VOTE_ABSTAIN', 'INVALID'];

    const { signature } = createAnamorphicSignature(
      privateKey,
      sharedSecret,
      publicMessage,
      hiddenMessage
    );

    const extracted = extractHiddenMessage(signature, publicMessage, sharedSecret, candidates);
    expect(extracted).toBe('VOTE_YES');
  });

  it('returns null when hidden message is not in candidates', () => {
    const { signature } = createAnamorphicSignature(
      privateKey,
      sharedSecret,
      'some message',
      'SECRET'
    );

    const extracted = extractHiddenMessage(
      signature,
      'some message',
      sharedSecret,
      ['WRONG1', 'WRONG2', 'WRONG3']
    );
    expect(extracted).toBeNull();
  });

  it('anamorphic signature is indistinguishable from normal signature', () => {
    const publicMessage = 'Normal ETH transfer';
    const { signature: anamorphicSig } = createAnamorphicSignature(
      privateKey,
      sharedSecret,
      publicMessage,
      'HIDDEN_DATA'
    );

    // Both r and s should be 64-char hex strings (32 bytes)
    expect(anamorphicSig.r).toMatch(/^[0-9a-f]{64}$/);
    expect(anamorphicSig.s).toMatch(/^[0-9a-f]{64}$/);
    expect(anamorphicSig.recovery).toBeGreaterThanOrEqual(0);
    expect(anamorphicSig.recovery).toBeLessThanOrEqual(1);

    // Verify the anamorphic signature is valid ECDSA
    const msgHash = keccak_256(utf8ToBytes(publicMessage));
    expect(verifySignature(publicKey, msgHash, anamorphicSig)).toBe(true);

    // Structurally identical to any ECDSA signature
    const rBigint = BigInt('0x' + anamorphicSig.r);
    const sBigint = BigInt('0x' + anamorphicSig.s);
    expect(rBigint > 0n).toBe(true);
    expect(sBigint > 0n).toBe(true);
    expect(rBigint < CURVE_ORDER).toBe(true);
    expect(sBigint <= CURVE_ORDER / 2n).toBe(true); // low-S normalized
  });
});
