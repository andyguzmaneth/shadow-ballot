pragma circom 2.0.0;

include "circomlib/circuits/poseidon.circom";
include "circomlib/circuits/mux1.circom";

/**
 * Eligibility proof for the Enhanced variant (dissertation Ch3 §3.1, §3.4.3).
 *
 * Proves knowledge of `secret` such that Poseidon(secret) is a leaf in the Merkle
 * tree of eligible voters (the DAO's token-holder snapshot, committed as `root`),
 * without revealing which leaf — this is Property 3 (eligibility soundness) made
 * cryptographic instead of trusted-coordinator, per §3.3.
 *
 * Also emits `nullifier = Poseidon(secret, proposalId)`, a public output the
 * coordinator/contract can check for prior use — the standard way a ZK membership
 * circuit prevents the same eligible voter from voting twice on the same proposal
 * without revealing which voter it was. Same mechanism as Semaphore's nullifier
 * scheme (Barry Whitehat et al.) — cite as prior art, not a novel contribution of
 * this dissertation; the novelty here is combining this with the anamorphic-nonce
 * + stealth-address layer (Ch3 §3.4), not the eligibility proof mechanism itself.
 *
 * STATUS 2026-08-19: compiled, proven, and verified end-to-end on the homelab dev VM
 * (ubuntu-dev, 16GB/8-core — not the 8GB Air this repo normally lives on; Andy's call
 * to move heavier toolchain work off the weak machine). Real numbers, not estimates:
 *   - Circom 2.2.3 (installed via `cargo install --git https://github.com/iden3/circom.git`,
 *     ~a few minutes one-time build)
 *   - Compile: 5,379 non-linear + 5,953 linear constraints (~11.3k total) — 0.55s
 *   - Groth16 setup (pot14_final.ptau, 2^14, 19MB download): 4.2s
 *   - Witness generation: 36ms · Proof generation: 0.58s · Verification: 0.35s
 *   - Full pipeline well under 10 seconds combined, trivial RAM — confirms the
 *     original size estimate (would very likely have run fine on the 8GB Air too,
 *     but moving to dev VM was the right precaution given "very likely fine" isn't
 *     "confirmed" until you've actually run it)
 *   - Sample proof's public outputs (root, nullifier) matched merkle.ts's independent
 *     off-circuit computation exactly — the TS integration and the compiled circuit
 *     agree, not just "should agree in theory"
 *   - Verifier correctly REJECTS a tampered public input (sanity-checked, not assumed)
 * Test-only setup (single-contribution phase-2 zkey, no additional entropy
 * contribution beyond the public ceremony file) — fine for this PoC, not for a real
 * deployment, which needs a proper multi-party trusted setup or a transparent
 * (non-Groth16) proving system.
 *
 * RESOLVED 2026-08-18 (was an unresolved design gap; confirmed with Andy which fix
 * to take): `secret` here corresponds to a REGISTERED commitment, not an arbitrary
 * self-chosen value. `VoterRegistry.sol` adds the registration phase this circuit
 * always needed — each eligible address (checked against a real on-chain token
 * snapshot via `getPastVotes`) registers `Poseidon(secret)` in one transaction
 * signed by that address; only the real private-key holder can do this, since
 * `msg.sender` isn't a parameter an attacker can spoof. The DAO's eligibility tree
 * (this circuit's `root`) is built from `VoterRegistered` events, not from raw
 * addresses — closing the "anyone can forge eligibility for anyone" hole. No change
 * needed to this circuit's arithmetic; the gap was in how leaves get populated, not
 * in the membership proof itself.
 */
template EligibilityProof(levels) {
    signal input secret;               // private: voter's eligibility secret
    signal input pathElements[levels]; // private: Merkle siblings, leaf to root
    signal input pathIndices[levels];  // private: 0 = current hash is left child, 1 = right
    signal input proposalId;           // public: binds the nullifier to one proposal

    signal output root;                // public: recomputed Merkle root
    signal output nullifier;           // public: Poseidon(secret, proposalId)

    // leaf = Poseidon(secret) — the committed eligibility leaf published in the
    // DAO's token-holder snapshot tree.
    component leafHasher = Poseidon(1);
    leafHasher.inputs[0] <== secret;

    signal hashes[levels + 1];
    hashes[0] <== leafHasher.out;

    component hashers[levels];
    component muxLeft[levels];
    component muxRight[levels];

    for (var i = 0; i < levels; i++) {
        // pathIndices[i] must be boolean — constrained here, not just assumed by
        // the caller. Without this constraint a malicious prover could pick a
        // non-binary "index" and potentially satisfy the circuit without a real
        // Merkle path — a real soundness bug class in hand-rolled Merkle circuits.
        pathIndices[i] * (1 - pathIndices[i]) === 0;

        muxLeft[i] = Mux1();
        muxLeft[i].c[0] <== hashes[i];
        muxLeft[i].c[1] <== pathElements[i];
        muxLeft[i].s <== pathIndices[i];

        muxRight[i] = Mux1();
        muxRight[i].c[0] <== pathElements[i];
        muxRight[i].c[1] <== hashes[i];
        muxRight[i].s <== pathIndices[i];

        hashers[i] = Poseidon(2);
        hashers[i].inputs[0] <== muxLeft[i].out;
        hashers[i].inputs[1] <== muxRight[i].out;
        hashes[i + 1] <== hashers[i].out;
    }

    root <== hashes[levels];

    component nullifierHasher = Poseidon(2);
    nullifierHasher.inputs[0] <== secret;
    nullifierHasher.inputs[1] <== proposalId;
    nullifier <== nullifierHasher.out;
}

// levels=20 supports up to 2^20 (~1M) eligible addresses — generous headroom over
// any real DAO's token-holder count; revisit if proving time at this depth is
// prohibitive once benchmarked (not yet — see status note above).
component main {public [proposalId]} = EligibilityProof(20);
