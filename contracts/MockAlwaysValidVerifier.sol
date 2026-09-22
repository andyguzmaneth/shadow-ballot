// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title MockAlwaysValidVerifier
 * @notice TEST ONLY. Always returns true regardless of proof content — used for
 *         Governor state-machine/tally-submission tests that exercise
 *         registerEligibleNullifier's bookkeeping (root checks, proposalId
 *         matching, nullifier uniqueness) without needing a fresh real Groth16
 *         proof generated for every test scenario. Real proof verification is
 *         separately and specifically tested against the actual compiled
 *         circuit's exported verifier in GovernorZkIntegration.test.cjs — this
 *         mock exists so THOSE mechanics don't have to be re-tested here too.
 *         Never use this for anything but tests.
 */
contract MockAlwaysValidVerifier {
    function verifyProof(
        uint256[2] calldata,
        uint256[2][2] calldata,
        uint256[2] calldata,
        uint256[3] calldata
    ) external pure returns (bool) {
        return true;
    }
}
