/**
 * Merkle-tree eligibility set construction — the off-circuit half of the ZK
 * eligibility proof (dissertation Ch3, Enhanced variant, `circuits/eligibility.circom`).
 *
 * Builds the DAO's token-holder snapshot as a Poseidon Merkle tree and produces
 * membership witnesses (pathElements/pathIndices) in exactly the format the circuit
 * expects. Uses circomlibjs's Poseidon (pure JS/WASM, no native compiler needed) —
 * this is testable today even though the circuit itself isn't compiled yet (see
 * circuits/eligibility.circom status note).
 */

import { buildPoseidon } from 'circomlibjs';

export interface PoseidonHasher {
  hash1: (a: bigint) => bigint;
  hash2: (a: bigint, b: bigint) => bigint;
}

/**
 * Build the Poseidon hasher. Async because circomlibjs loads a WASM module.
 */
export async function buildPoseidonHasher(): Promise<PoseidonHasher> {
  const poseidon = await buildPoseidon();
  const toBigint = (x: unknown): bigint => BigInt(poseidon.F.toString(x));

  return {
    hash1: (a: bigint) => toBigint(poseidon([a])),
    hash2: (a: bigint, b: bigint) => toBigint(poseidon([a, b])),
  };
}

export interface MerkleProof {
  pathElements: bigint[];
  pathIndices: number[]; // 0 = current node is the left child, 1 = right — matches eligibility.circom
}

export class EligibilityMerkleTree {
  readonly levels: number;
  readonly root: bigint;
  private readonly layers: bigint[][];
  private readonly zeroHashes: bigint[];

  private constructor(levels: number, layers: bigint[][], zeroHashes: bigint[]) {
    this.levels = levels;
    this.layers = layers;
    this.zeroHashes = zeroHashes;
    this.root = layers[levels][0];
  }

  /**
   * Build a tree of the given depth from voter eligibility secrets (leaves are
   * Poseidon(secret), matching the circuit's leaf computation). Leaves beyond the
   * provided set are filled with a precomputed zero-hash per level — the standard
   * approach (used by e.g. Tornado Cash's Merkle tree), not naive zero-padding at
   * every level, which would make all-zero subtrees at different depths collide.
   */
  static async build(secrets: bigint[], levels: number, hasher: PoseidonHasher): Promise<EligibilityMerkleTree> {
    const capacity = 1 << levels;
    if (secrets.length > capacity) {
      throw new Error(`too many leaves (${secrets.length}) for a tree of depth ${levels} (capacity ${capacity})`);
    }

    // zeroHashes[0] = hash of an empty leaf; zeroHashes[i+1] = hash2(zeroHashes[i], zeroHashes[i])
    const zeroHashes: bigint[] = [hasher.hash1(0n)];
    for (let i = 0; i < levels; i++) {
      zeroHashes.push(hasher.hash2(zeroHashes[i], zeroHashes[i]));
    }

    const leaves = secrets.map((s) => hasher.hash1(s));
    while (leaves.length < capacity) {
      leaves.push(zeroHashes[0]);
    }

    const layers: bigint[][] = [leaves];
    for (let level = 0; level < levels; level++) {
      const prev = layers[level];
      const next: bigint[] = [];
      for (let i = 0; i < prev.length; i += 2) {
        next.push(hasher.hash2(prev[i], prev[i + 1]));
      }
      layers.push(next);
    }

    return new EligibilityMerkleTree(levels, layers, zeroHashes);
  }

  /**
   * Produce a membership witness for the leaf at `index` — pathElements/pathIndices
   * in exactly the layout `eligibility.circom` consumes.
   */
  getProof(index: number): MerkleProof {
    const capacity = 1 << this.levels;
    if (index < 0 || index >= capacity) {
      throw new Error(`index ${index} out of range for tree of depth ${this.levels}`);
    }

    const pathElements: bigint[] = [];
    const pathIndices: number[] = [];
    let idx = index;

    for (let level = 0; level < this.levels; level++) {
      const isRightChild = idx % 2 === 1;
      const siblingIdx = isRightChild ? idx - 1 : idx + 1;
      pathElements.push(this.layers[level][siblingIdx]);
      // Matches eligibility.circom: pathIndices[i] = 1 means the CURRENT hash is
      // the right child (sibling goes on the left) — isRightChild is exactly that.
      pathIndices.push(isRightChild ? 1 : 0);
      idx = Math.floor(idx / 2);
    }

    return { pathElements, pathIndices };
  }
}

/**
 * Off-circuit reimplementation of eligibility.circom's Merkle verification —
 * used to sanity-check that a (leaf, proof, root) triple is well-formed before
 * ever generating a real proof, and to unit-test the witness format independent
 * of having the circuit compiled.
 */
export function verifyMerkleProof(leaf: bigint, proof: MerkleProof, root: bigint, hasher: PoseidonHasher): boolean {
  let current = leaf;
  for (let i = 0; i < proof.pathElements.length; i++) {
    const sibling = proof.pathElements[i];
    current = proof.pathIndices[i] === 1 ? hasher.hash2(sibling, current) : hasher.hash2(current, sibling);
  }
  return current === root;
}

/**
 * Nullifier computation matching eligibility.circom's public output —
 * Poseidon(secret, proposalId). Same secret + different proposalId = different
 * nullifier (voting on multiple proposals is fine); same secret + same proposalId
 * = same nullifier (a second proof for the same proposal is detectable/rejectable).
 */
export function computeNullifier(secret: bigint, proposalId: bigint, hasher: PoseidonHasher): bigint {
  return hasher.hash2(secret, proposalId);
}
