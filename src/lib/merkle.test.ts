import { describe, it, expect, beforeAll } from 'vitest';
import {
  buildPoseidonHasher,
  EligibilityMerkleTree,
  verifyMerkleProof,
  computeNullifier,
  selectEligibleForProposal,
  type PoseidonHasher,
  type Registration,
} from './merkle.js';

/**
 * Tests the off-circuit half of the ZK eligibility proof (Enhanced variant,
 * circuits/eligibility.circom — not compiled yet, see that file's status note).
 * These tests don't touch the circuit; they verify the JS-side tree construction
 * and witness format independently, using an off-circuit reimplementation of the
 * same Merkle-verification logic the circuit performs.
 */
describe('EligibilityMerkleTree', () => {
  let hasher: PoseidonHasher;

  beforeAll(async () => {
    hasher = await buildPoseidonHasher();
  });

  it('produces a valid membership proof for every real leaf in a small tree', async () => {
    const levels = 4; // capacity 16
    const secrets = [111n, 222n, 333n, 444n, 555n].map((s) => s);
    const tree = await EligibilityMerkleTree.build(secrets, levels, hasher);

    for (let i = 0; i < secrets.length; i++) {
      const leaf = hasher.hash1(secrets[i]);
      const proof = tree.getProof(i);
      expect(proof.pathElements.length).toBe(levels);
      expect(proof.pathIndices.length).toBe(levels);
      expect(verifyMerkleProof(leaf, proof, tree.root, hasher)).toBe(true);
    }
  });

  it('rejects a proof against the wrong leaf', async () => {
    const levels = 4;
    const secrets = [111n, 222n, 333n];
    const tree = await EligibilityMerkleTree.build(secrets, levels, hasher);

    const wrongLeaf = hasher.hash1(999n); // not in the tree
    const proof = tree.getProof(0);
    expect(verifyMerkleProof(wrongLeaf, proof, tree.root, hasher)).toBe(false);
  });

  it('rejects a proof against the wrong root', async () => {
    const levels = 4;
    const treeA = await EligibilityMerkleTree.build([111n, 222n], levels, hasher);
    const treeB = await EligibilityMerkleTree.build([333n, 444n], levels, hasher);

    const leaf = hasher.hash1(111n);
    const proof = treeA.getProof(0);
    expect(verifyMerkleProof(leaf, proof, treeB.root, hasher)).toBe(false);
  });

  it('unfilled leaves hash to the standard zero-hash convention, not raw 0', async () => {
    const levels = 3;
    const tree = await EligibilityMerkleTree.build([111n], levels, hasher);

    // Leaf index 1 was never assigned a real secret — should verify against the
    // zero-hash leaf (hasher.hash1(0n)), not literal 0n, and should NOT equal the
    // real leaf at index 0.
    const zeroLeaf = hasher.hash1(0n);
    const proof = tree.getProof(1);
    expect(verifyMerkleProof(zeroLeaf, proof, tree.root, hasher)).toBe(true);
    expect(verifyMerkleProof(0n, proof, tree.root, hasher)).toBe(false);
  });

  it('rejects building a tree with more leaves than the depth supports', async () => {
    const levels = 2; // capacity 4
    await expect(EligibilityMerkleTree.build([1n, 2n, 3n, 4n, 5n], levels, hasher)).rejects.toThrow();
  });
});

describe('nullifier (double-vote guard)', () => {
  let hasher: PoseidonHasher;

  beforeAll(async () => {
    hasher = await buildPoseidonHasher();
  });

  it('is deterministic for the same (secret, proposalId)', () => {
    const n1 = computeNullifier(42n, 7n, hasher);
    const n2 = computeNullifier(42n, 7n, hasher);
    expect(n1).toBe(n2);
  });

  it('differs across proposals for the same voter — voting on multiple proposals is fine', () => {
    const nProposal7 = computeNullifier(42n, 7n, hasher);
    const nProposal8 = computeNullifier(42n, 8n, hasher);
    expect(nProposal7).not.toBe(nProposal8);
  });

  it('differs across voters for the same proposal', () => {
    const nVoterA = computeNullifier(42n, 7n, hasher);
    const nVoterB = computeNullifier(99n, 7n, hasher);
    expect(nVoterA).not.toBe(nVoterB);
  });
});

/**
 * Per-proposal eligibility selection. Registration is permanent and decides
 * nothing; a proposal's tree is built from the registrants holding voting
 * power at THAT proposal's snapshot (VoterRegistry.sol, changed 2026-10-18).
 */
describe('selectEligibleForProposal', () => {
  const reg = (address: string, commitment: bigint): Registration => ({ address, commitment });
  const ALL: Registration[] = [
    reg('0xaaa', 1n), // holds at both snapshots
    reg('0xbbb', 2n), // sold between the two
    reg('0xccc', 3n), // bought in between the two
  ];

  const powerAt = (balances: Record<string, bigint>) => async (a: string) => balances[a] ?? 0n;

  it('keeps only the registrants with voting power at that proposal snapshot', async () => {
    const kept = await selectEligibleForProposal(ALL, powerAt({ '0xaaa': 100n, '0xbbb': 50n }));
    expect(kept.map((r) => r.address)).toEqual(['0xaaa', '0xbbb']);
  });

  it('drops a registrant who sold every token after registering', async () => {
    // The first half of the bug found 2026-10-18: before this, a holder could
    // register, sell out, and still prove eligibility on every later proposal.
    const kept = await selectEligibleForProposal(ALL, powerAt({ '0xaaa': 100n, '0xccc': 10n }));
    expect(kept.map((r) => r.address)).toEqual(['0xaaa', '0xccc']);
    expect(kept.map((r) => r.address)).not.toContain('0xbbb');
  });

  it('includes a registrant who acquired tokens after registering', async () => {
    // The second half: a single immutable snapshot block locked these out for good.
    const kept = await selectEligibleForProposal(ALL, powerAt({ '0xccc': 10n }));
    expect(kept.map((r) => r.address)).toEqual(['0xccc']);
  });

  it('gives two proposals different trees when the holder set moves between them', async () => {
    const hasher = await buildPoseidonHasher();
    const keptA = await selectEligibleForProposal(ALL, powerAt({ '0xaaa': 1n, '0xbbb': 1n }));
    const keptB = await selectEligibleForProposal(ALL, powerAt({ '0xaaa': 1n, '0xccc': 1n }));
    const treeA = await EligibilityMerkleTree.build(keptA.map((r) => r.commitment), 4, hasher);
    const treeB = await EligibilityMerkleTree.build(keptB.map((r) => r.commitment), 4, hasher);
    expect(treeA.root).not.toBe(treeB.root);
  });
});
