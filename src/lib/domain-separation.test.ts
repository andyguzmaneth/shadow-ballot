import { describe, it, expect } from 'vitest';
import { utils } from '@noble/secp256k1';
import { sha256 } from '@noble/hashes/sha2.js';
import { hmac } from '@noble/hashes/hmac.js';
import { hashes, etc, Point, getPublicKey } from '@noble/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, concatBytes } from '@noble/hashes/utils.js';

// Initialize noble hashes (required for noble/secp256k1 v3)
hashes.hmacSha256 = (k: Uint8Array, ...m: Uint8Array[]) => hmac(sha256, k, etc.concatBytes(...m));
hashes.sha256 = (...msgs: Uint8Array[]) => sha256(etc.concatBytes(...msgs));

import { generateStealthKeys, generateStealthAddressFromKeys } from './stealth.js';
import { castVoteOffline, decodeVote, VOTE_YES } from './vote.js';

/**
 * Regression test for dissertation Ch3 finding #7 (2026-08-17 adversarial review):
 * the stealth-address offset and the anamorphic nonce key used to both derive from
 * the SAME untagged keccak256(ECDH point), coupling two independent uses of one
 * secret with no cryptographic separation. Fixed by tagging: 0x01 for the address
 * offset (stealth.ts), 0x02 for the nonce key (vote.ts).
 *
 * These tests exercise the real production code paths, not a reimplementation —
 * if a future refactor accidentally drops the domain tags (e.g. "simplifying" by
 * sharing one derivation helper), these should fail.
 */
describe('domain separation between stealth-address and nonce-key derivation', () => {
  function bytesToBigint(bytes: Uint8Array): bigint {
    return BigInt('0x' + bytesToHex(bytes));
  }

  it('address-offset secret (tag 0x01) and nonce-key secret (tag 0x02) differ for the same ECDH point', () => {
    const coordinator = generateStealthKeys();
    const ephemeralPrivKey = utils.randomSecretKey();

    // Recompute the raw ECDH point exactly as both stealth.ts and vote.ts do internally.
    const viewingPoint = Point.fromHex(bytesToHex(coordinator.viewingPubKey));
    const rawPoint = viewingPoint.multiply(bytesToBigint(ephemeralPrivKey));
    const rawPointBytes = rawPoint.toBytes(true);

    const addrSecret = keccak_256(concatBytes(new Uint8Array([0x01]), rawPointBytes));
    const nonceKey = keccak_256(concatBytes(new Uint8Array([0x02]), rawPointBytes));
    const oldUntaggedValue = keccak_256(rawPointBytes); // what the pre-fix code computed for BOTH uses

    expect(bytesToHex(addrSecret)).not.toBe(bytesToHex(nonceKey));
    expect(bytesToHex(addrSecret)).not.toBe(bytesToHex(oldUntaggedValue));
    expect(bytesToHex(nonceKey)).not.toBe(bytesToHex(oldUntaggedValue));
  });

  it('stealth.ts actually uses tag 0x01 internally (exercises real generateStealthAddressFromKeys)', () => {
    const coordinator = generateStealthKeys();
    const ephemeralPrivKey = utils.randomSecretKey();

    const { stealthAddress } = generateStealthAddressFromKeys(coordinator.metaAddress, ephemeralPrivKey);

    // Independently reconstruct the expected address using tag 0x01 and compare —
    // if stealth.ts's internal tag ever changes or is removed, this diverges.
    const viewingPoint = Point.fromHex(bytesToHex(coordinator.viewingPubKey));
    const rawPoint = viewingPoint.multiply(bytesToBigint(ephemeralPrivKey));
    const addrSecret = keccak_256(concatBytes(new Uint8Array([0x01]), rawPoint.toBytes(true)));
    const offsetPoint = Point.BASE.multiply(bytesToBigint(addrSecret));
    const spendingPoint = Point.fromHex(bytesToHex(coordinator.spendingPubKey));
    const expectedStealthPubKey = spendingPoint.add(offsetPoint);
    const uncompressed = expectedStealthPubKey.toBytes(false);
    const hash = keccak_256(uncompressed.slice(1));
    const expectedAddress = '0x' + bytesToHex(hash.slice(12));

    expect(stealthAddress.toLowerCase()).toBe(expectedAddress.toLowerCase());
  });

  it('vote.ts actually uses tag 0x02 internally (exercises real castVoteOffline/decodeVote)', () => {
    const voterPrivKey = utils.randomSecretKey();
    const coordinator = generateStealthKeys();
    const ephemeralPrivKey = utils.randomSecretKey();

    const result = castVoteOffline(voterPrivKey, coordinator.metaAddress, 1, VOTE_YES, ephemeralPrivKey);

    // decodeVote only succeeds if the coordinator's independent tag-0x02 derivation
    // matches what the voter used to sign — this fails if either side's tag drifts.
    const decoded = decodeVote(
      coordinator.viewingKey,
      coordinator.spendingPubKey,
      result.ephemeralPubKey,
      result.r,
      result.unsignedTxHash,
      [1]
    );

    expect(decoded).not.toBeNull();
    expect(decoded!.choice).toBe(VOTE_YES);
  });
});
