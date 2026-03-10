import { describe, it, expect } from 'vitest';
import {
  generateStealthKeys,
  generateStealthAddressFromKeys,
  scanForStealthTx,
  computeStealthPrivateKey,
  parseMetaAddress,
  getPublicKey,
  Point,
  bytesToHex,
} from './stealth';
import { utils } from '@noble/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3.js';

describe('Stealth Addresses', () => {
  it('generates valid stealth keys and meta-address', () => {
    const keys = generateStealthKeys();

    // Keys should be 32 bytes
    expect(keys.spendingKey.length).toBe(32);
    expect(keys.viewingKey.length).toBe(32);

    // Compressed pub keys should be 33 bytes
    expect(keys.spendingPubKey.length).toBe(33);
    expect(keys.viewingPubKey.length).toBe(33);

    // Meta-address = two compressed pub keys concatenated = 66 * 2 = 132 hex chars
    expect(keys.metaAddress.length).toBe(132);

    // Parse should round-trip
    const parsed = parseMetaAddress(keys.metaAddress);
    expect(bytesToHex(parsed.spendingPubKey)).toBe(bytesToHex(keys.spendingPubKey));
    expect(bytesToHex(parsed.viewingPubKey)).toBe(bytesToHex(keys.viewingPubKey));
  });

  it('generates stealth address and coordinator can scan/detect it', () => {
    const coordinator = generateStealthKeys();
    const ephemeralPrivKey = utils.randomSecretKey();

    // Voter generates stealth address
    const { stealthAddress, ephemeralPubKey } = generateStealthAddressFromKeys(
      coordinator.metaAddress,
      ephemeralPrivKey
    );

    // Stealth address should be a valid Ethereum address
    expect(stealthAddress).toMatch(/^0x[0-9a-f]{40}$/);

    // Coordinator scans and detects the transaction
    const found = scanForStealthTx(
      coordinator.viewingKey,
      coordinator.spendingPubKey,
      ephemeralPubKey,
      stealthAddress
    );
    expect(found).toBe(true);
  });

  it('rejects non-matching transaction recipient', () => {
    const coordinator = generateStealthKeys();
    const ephemeralPrivKey = utils.randomSecretKey();

    const { ephemeralPubKey } = generateStealthAddressFromKeys(
      coordinator.metaAddress,
      ephemeralPrivKey
    );

    // Random address that is NOT a stealth address for this coordinator
    const randomAddress = '0x' + 'ab'.repeat(20);

    const found = scanForStealthTx(
      coordinator.viewingKey,
      coordinator.spendingPubKey,
      ephemeralPubKey,
      randomAddress
    );
    expect(found).toBe(false);
  });

  it('computes stealth private key that matches stealth address', () => {
    const coordinator = generateStealthKeys();
    const ephemeralPrivKey = utils.randomSecretKey();

    const { stealthAddress, ephemeralPubKey } = generateStealthAddressFromKeys(
      coordinator.metaAddress,
      ephemeralPrivKey
    );

    // Coordinator derives the stealth private key
    const stealthPrivKey = computeStealthPrivateKey(
      coordinator.spendingKey,
      coordinator.viewingKey,
      ephemeralPubKey
    );

    // The derived public key should produce the same stealth address
    const stealthPubKey = getPublicKey(stealthPrivKey, false); // uncompressed 65 bytes
    const hash = keccak_256(stealthPubKey.slice(1)); // keccak256 of x,y (64 bytes)
    const derivedAddress = '0x' + bytesToHex(hash.slice(12));

    expect(derivedAddress.toLowerCase()).toBe(stealthAddress.toLowerCase());
  });

  it('ECDH shared secret is the same on both sides', () => {
    // Simulate: voter (ephemeral key) and coordinator (viewing key) derive same secret
    const viewingPrivKey = utils.randomSecretKey();
    const viewingPubKey = getPublicKey(viewingPrivKey, true);

    const ephemeralPrivKey = utils.randomSecretKey();
    const ephemeralPubKey = getPublicKey(ephemeralPrivKey, true);

    // Sender side: ephemeralPrivKey * viewingPubKey
    const viewingPoint = Point.fromHex(bytesToHex(viewingPubKey));
    const senderShared = viewingPoint.multiply(
      BigInt('0x' + bytesToHex(ephemeralPrivKey))
    );

    // Receiver side: viewingPrivKey * ephemeralPubKey
    const ephemeralPoint = Point.fromHex(bytesToHex(ephemeralPubKey));
    const receiverShared = ephemeralPoint.multiply(
      BigInt('0x' + bytesToHex(viewingPrivKey))
    );

    // Both should arrive at the same point
    const senderHex = bytesToHex(senderShared.toBytes(true));
    const receiverHex = bytesToHex(receiverShared.toBytes(true));
    expect(senderHex).toBe(receiverHex);
  });
});
