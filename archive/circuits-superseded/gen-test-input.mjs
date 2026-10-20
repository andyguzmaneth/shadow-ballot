// One-off script to generate a real sample witness input for eligibility.circom's
// first end-to-end proof test (2026-08-19, dev VM). For a single real leaf at index 0
// in a depth-20 tree, every sibling at every level is a "default/zero subtree" hash —
// computing those 20 zero-hashes directly is equivalent to (but far cheaper than)
// building the full EligibilityMerkleTree with 2^20 leaves via merkle.ts, which would
// call the Poseidon hasher ~2^20 times just to fill padding. Same conventions as
// merkle.ts: pathIndices[i] = 0 means the current hash is the left child.
import { buildPoseidon } from 'circomlibjs';
import { writeFileSync } from 'fs';

const poseidon = await buildPoseidon();
const F = poseidon.F;
const toBigint = (x) => BigInt(F.toString(x));

const secret = 12345n;
// 2026-08-19: parameterized to accept a real (BN254-reduced) Governor proposalId
// via argv, for the ShadowBallotGovernor + EligibilityVerifier integration test —
// previously hardcoded to 7, an arbitrary placeholder with no connection to any
// real on-chain proposal ID.
const proposalId = process.argv[2] ? BigInt(process.argv[2]) : 7n;
const levels = 20;

const leaf = toBigint(poseidon([secret]));

const zeroHashes = [toBigint(poseidon([0n]))];
for (let i = 0; i < levels; i++) {
  zeroHashes.push(toBigint(poseidon([zeroHashes[i], zeroHashes[i]])));
}

const pathElements = zeroHashes.slice(0, levels); // siblings at each level, all "zero subtree" values
const pathIndices = new Array(levels).fill(0); // leaf at index 0 is the left child at every level

// Recompute root the same way the circuit does, to put in a companion file for
// the verify step (public.json is generated separately by the witness calculator,
// this is just for our own sanity check before trusting that output).
let expectedRoot = leaf;
for (let i = 0; i < levels; i++) {
  expectedRoot = toBigint(poseidon([expectedRoot, pathElements[i]]));
}

const nullifier = toBigint(poseidon([secret, proposalId]));

const input = {
  secret: secret.toString(),
  pathElements: pathElements.map((x) => x.toString()),
  pathIndices: pathIndices.map((x) => x.toString()),
  proposalId: proposalId.toString(),
};

writeFileSync('input.json', JSON.stringify(input, null, 2));
console.log('leaf:', leaf.toString());
console.log('expectedRoot:', expectedRoot.toString());
console.log('expectedNullifier:', nullifier.toString());
