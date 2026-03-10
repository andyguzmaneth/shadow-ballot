import { describe, it, expect } from 'vitest';
import { utils } from '@noble/secp256k1';
import { sha256 } from '@noble/hashes/sha2.js';
import { hmac } from '@noble/hashes/hmac.js';
import { hashes, etc } from '@noble/secp256k1';

// Initialize noble hashes (required for noble/secp256k1 v3)
hashes.hmacSha256 = (k: Uint8Array, ...m: Uint8Array[]) => hmac(sha256, k, etc.concatBytes(...m));
hashes.sha256 = (...msgs: Uint8Array[]) => sha256(etc.concatBytes(...msgs));

import { generateStealthKeys, scanForStealthTx } from './stealth.js';
import {
  encodeVote,
  decodeVoteBytes,
  choiceLabel,
  buildCandidateSet,
  castVoteOffline,
  decodeVote,
  VOTE_YES,
  VOTE_NO,
  VOTE_ABSTAIN,
} from './vote.js';

describe('encodeVote / decodeVoteBytes', () => {
  it('should encode and decode a YES vote', () => {
    const encoded = encodeVote(1, VOTE_YES);
    expect(encoded).toEqual(new Uint8Array([1, 0x01]));
    const decoded = decodeVoteBytes(encoded);
    expect(decoded.proposalId).toBe(1);
    expect(decoded.choice).toBe(VOTE_YES);
  });

  it('should encode and decode a NO vote', () => {
    const encoded = encodeVote(42, VOTE_NO);
    expect(encoded).toEqual(new Uint8Array([42, 0x02]));
    const decoded = decodeVoteBytes(encoded);
    expect(decoded.proposalId).toBe(42);
    expect(decoded.choice).toBe(VOTE_NO);
  });

  it('should reject invalid proposalId', () => {
    expect(() => encodeVote(256, VOTE_YES)).toThrow('proposalId must be 0-255');
    expect(() => encodeVote(-1, VOTE_YES)).toThrow('proposalId must be 0-255');
  });

  it('should reject invalid choice', () => {
    expect(() => encodeVote(1, 0x04 as any)).toThrow('Invalid vote choice');
  });
});

describe('choiceLabel', () => {
  it('should return correct labels', () => {
    expect(choiceLabel(VOTE_YES)).toBe('YES');
    expect(choiceLabel(VOTE_NO)).toBe('NO');
    expect(choiceLabel(VOTE_ABSTAIN)).toBe('ABSTAIN');
  });
});

describe('buildCandidateSet', () => {
  it('should generate 3N candidates for N proposals', () => {
    const candidates = buildCandidateSet([0, 1, 2]);
    expect(candidates.length).toBe(9);
    // First proposal: YES, NO, ABSTAIN
    expect(candidates[0]).toEqual(new Uint8Array([0, 0x01]));
    expect(candidates[1]).toEqual(new Uint8Array([0, 0x02]));
    expect(candidates[2]).toEqual(new Uint8Array([0, 0x03]));
  });
});

describe('end-to-end: castVoteOffline + decodeVote', () => {
  it('should cast and decode a YES vote correctly', () => {
    const voterPrivKey = utils.randomSecretKey();
    const coordinator = generateStealthKeys();
    const ephemeralPrivKey = utils.randomSecretKey();

    const result = castVoteOffline(
      voterPrivKey,
      coordinator.metaAddress,
      1, // proposalId
      VOTE_YES,
      ephemeralPrivKey
    );

    expect(result.signedTxHex).toBeTruthy();
    expect(result.r).toBeTruthy();
    expect(result.stealthAddress).toMatch(/^0x[a-f0-9]{40}$/);

    // Now decode from coordinator side
    const decoded = decodeVote(
      coordinator.viewingKey,
      coordinator.spendingPubKey,
      result.ephemeralPubKey,
      result.r,
      result.unsignedTxHash,
      [0, 1, 2]
    );

    expect(decoded).not.toBeNull();
    expect(decoded!.proposalId).toBe(1);
    expect(decoded!.choice).toBe(VOTE_YES);
    expect(decoded!.choiceLabel).toBe('YES');
  });

  it('should cast and decode a NO vote correctly', () => {
    const voterPrivKey = utils.randomSecretKey();
    const coordinator = generateStealthKeys();
    const ephemeralPrivKey = utils.randomSecretKey();

    const result = castVoteOffline(
      voterPrivKey,
      coordinator.metaAddress,
      2,
      VOTE_NO,
      ephemeralPrivKey
    );

    const decoded = decodeVote(
      coordinator.viewingKey,
      coordinator.spendingPubKey,
      result.ephemeralPubKey,
      result.r,
      result.unsignedTxHash,
      [0, 1, 2, 3]
    );

    expect(decoded).not.toBeNull();
    expect(decoded!.proposalId).toBe(2);
    expect(decoded!.choice).toBe(VOTE_NO);
    expect(decoded!.choiceLabel).toBe('NO');
  });

  it('should cast and decode an ABSTAIN vote correctly', () => {
    const voterPrivKey = utils.randomSecretKey();
    const coordinator = generateStealthKeys();
    const ephemeralPrivKey = utils.randomSecretKey();

    const result = castVoteOffline(
      voterPrivKey,
      coordinator.metaAddress,
      0,
      VOTE_ABSTAIN,
      ephemeralPrivKey
    );

    const decoded = decodeVote(
      coordinator.viewingKey,
      coordinator.spendingPubKey,
      result.ephemeralPubKey,
      result.r,
      result.unsignedTxHash,
      [0, 1]
    );

    expect(decoded).not.toBeNull();
    expect(decoded!.proposalId).toBe(0);
    expect(decoded!.choice).toBe(VOTE_ABSTAIN);
  });

  it('should return null when proposalId not in candidate set', () => {
    const voterPrivKey = utils.randomSecretKey();
    const coordinator = generateStealthKeys();
    const ephemeralPrivKey = utils.randomSecretKey();

    const result = castVoteOffline(
      voterPrivKey,
      coordinator.metaAddress,
      5, // proposalId 5
      VOTE_YES,
      ephemeralPrivKey
    );

    // Only search proposals 0-2 (not 5)
    const decoded = decodeVote(
      coordinator.viewingKey,
      coordinator.spendingPubKey,
      result.ephemeralPubKey,
      result.r,
      result.unsignedTxHash,
      [0, 1, 2]
    );

    expect(decoded).toBeNull();
  });

  it('should fail to decode with wrong coordinator keys', () => {
    const voterPrivKey = utils.randomSecretKey();
    const coordinator = generateStealthKeys();
    const wrongCoordinator = generateStealthKeys();
    const ephemeralPrivKey = utils.randomSecretKey();

    const result = castVoteOffline(
      voterPrivKey,
      coordinator.metaAddress,
      1,
      VOTE_YES,
      ephemeralPrivKey
    );

    // Try decoding with wrong coordinator keys
    const decoded = decodeVote(
      wrongCoordinator.viewingKey,
      wrongCoordinator.spendingPubKey,
      result.ephemeralPubKey,
      result.r,
      result.unsignedTxHash,
      [0, 1, 2]
    );

    expect(decoded).toBeNull();
  });

  it('stealth address should match coordinator scan', () => {
    const voterPrivKey = utils.randomSecretKey();
    const coordinator = generateStealthKeys();
    const ephemeralPrivKey = utils.randomSecretKey();

    const result = castVoteOffline(
      voterPrivKey,
      coordinator.metaAddress,
      1,
      VOTE_YES,
      ephemeralPrivKey
    );

    // Verify stealth address scan works
    const isMatch = scanForStealthTx(
      coordinator.viewingKey,
      coordinator.spendingPubKey,
      result.ephemeralPubKey,
      result.stealthAddress
    );
    expect(isMatch).toBe(true);

    // Verify non-matching address rejected
    const isNotMatch = scanForStealthTx(
      coordinator.viewingKey,
      coordinator.spendingPubKey,
      result.ephemeralPubKey,
      '0x0000000000000000000000000000000000000000'
    );
    expect(isNotMatch).toBe(false);
  });
});
