import { describe, it, expect } from 'vitest';
import { utils, Point, getPublicKey } from '@noble/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, concatBytes } from '@noble/hashes/utils.js';
import { deriveViewTag, buildAnnouncementMetadata, extractViewTag } from './announcer.js';

/**
 * Only the pure functions are unit-tested here (view-tag derivation, metadata
 * encode/decode). announceVote()/scanAnnouncements() need a live provider and are
 * covered instead by test/Announcer.test.cjs (Hardhat-level, tests the contract
 * these functions call into) — same split as contract.ts, which is also untested
 * at the vitest level for the same reason. Not a gap unique to this module.
 */
describe('announcer view-tag derivation', () => {
  function bytesToBigint(bytes: Uint8Array): bigint {
    return BigInt('0x' + bytesToHex(bytes));
  }

  it('view tag (domain 0x03) differs from the stealth-address secret (0x01) and nonce key (0x02) for the same point', () => {
    const viewingPrivKey = utils.randomSecretKey();
    const viewingPubKey = getPublicKey(viewingPrivKey, true);
    const ephemeralPrivKey = utils.randomSecretKey();

    const viewingPoint = Point.fromHex(bytesToHex(viewingPubKey));
    const rawPoint = viewingPoint.multiply(bytesToBigint(ephemeralPrivKey));
    const rawPointBytes = rawPoint.toBytes(true);

    const viewTag = deriveViewTag(rawPointBytes);

    // Independently compute what tags 0x01 and 0x02 would produce for the same point
    // (mirrors stealth.ts / vote.ts) and confirm the view tag isn't accidentally
    // reusing either of them.
    const addrSecret = keccak_256(concatBytes(new Uint8Array([0x01]), rawPointBytes));
    const nonceKey = keccak_256(concatBytes(new Uint8Array([0x02]), rawPointBytes));

    expect(viewTag).not.toBe(addrSecret[0]);
    expect(viewTag).not.toBe(nonceKey[0]);
    expect(typeof viewTag).toBe('number');
    expect(viewTag).toBeGreaterThanOrEqual(0);
    expect(viewTag).toBeLessThanOrEqual(255);
  });

  it('view tag is deterministic for the same point', () => {
    const viewingPrivKey = utils.randomSecretKey();
    const viewingPubKey = getPublicKey(viewingPrivKey, true);
    const ephemeralPrivKey = utils.randomSecretKey();

    const viewingPoint = Point.fromHex(bytesToHex(viewingPubKey));
    const rawPoint = viewingPoint.multiply(bytesToBigint(ephemeralPrivKey));
    const rawPointBytes = rawPoint.toBytes(true);

    expect(deriveViewTag(rawPointBytes)).toBe(deriveViewTag(rawPointBytes));
  });
});

describe('announcement metadata encode/decode', () => {
  it('round-trips a view tag through metadata bytes', () => {
    for (const tag of [0, 1, 127, 200, 255]) {
      const metadata = buildAnnouncementMetadata(tag);
      expect(metadata.length).toBe(1);
      expect(extractViewTag(metadata)).toBe(tag);
    }
  });

  it('rejects out-of-range view tags', () => {
    expect(() => buildAnnouncementMetadata(-1)).toThrow();
    expect(() => buildAnnouncementMetadata(256)).toThrow();
  });

  it('rejects empty metadata on extraction', () => {
    expect(() => extractViewTag(new Uint8Array([]))).toThrow();
  });
});
