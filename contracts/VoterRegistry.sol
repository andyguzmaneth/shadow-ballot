// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title IVotesSnapshot
 * @notice Minimal interface matching OpenZeppelin's ERC20Votes.getPastVotes —
 *         the dissertation targets integration with OpenZeppelin Governor
 *         (Ch3 Spec v0.3 §2.1), so eligibility is checked against the DAO's
 *         real governance token snapshot, not a project-specific mechanism.
 */
interface IVotesSnapshot {
    function getPastVotes(address account, uint256 blockNumber) external view returns (uint256);
    function getVotes(address account) external view returns (uint256);
}

/**
 * @title VoterRegistry
 * @notice Resolves the eligibility-soundness gap found 2026-08-18 while writing
 *         `circuits/eligibility.circom`: that circuit proves membership of a
 *         voter-chosen `secret` in a Merkle tree, but says nothing about how a
 *         real token-holder's on-chain balance becomes a leaf only THAT holder
 *         can prove membership for. Naively hashing public addresses into leaves
 *         would let anyone forge eligibility for anyone.
 *
 * This is the fix: each eligible address (per the DAO's real token snapshot,
 * checked via getPastVotes) registers a commitment — Poseidon(secret) — in ONE
 * on-chain transaction, signed by that address. Because it's `msg.sender`, only
 * the actual private-key holder for an eligible address can register that
 * address's commitment. The coordinator later builds the ZK eligibility tree
 * from `VoterRegistered` events, not from raw addresses.
 *
 * Cost of this fix, stated honestly: the registration transaction is itself
 * public and linked to the voter's real address — "address X registered to
 * vote privately" is visible on-chain. It does not reveal HOW X later votes or
 * WHETHER X votes on any specific proposal (that's still hidden by the
 * anamorphic-nonce + stealth-address layer, Ch3 §3.4) — registration and
 * participation are separate facts. One registration covers all future
 * proposals; the per-proposal nullifier (in the circuit) is what prevents
 * double-voting, not re-registration.
 *
 * WHAT THIS CONTRACT DOES NOT DECIDE (changed 2026-10-18). Registration binds
 * an address to a commitment. It does NOT decide eligibility for any given
 * proposal. The original version gated registration on
 * getPastVotes(msg.sender, snapshotBlock) for one immutable snapshotBlock
 * fixed at deployment, which broke OpenZeppelin Governor's semantics in two
 * directions: a holder who registered and then sold every token could still
 * prove eligibility on every future proposal, and anyone who acquired tokens
 * after that block could never register at all. (The 2026-09-03 Sepolia
 * deployment hit the second one in its crudest form: its snapshot block
 * predated the token mint, so nobody could ever register against it.)
 *
 * Eligibility is now decided per proposal, where Governor decides it: the
 * coordinator builds that proposal's Merkle tree from the registered
 * commitments of addresses holding voting power at proposalSnapshot(id), and
 * publishes the root via setEligibilityRoot. commitmentOf is public and
 * VoterRegistered is emitted, so anyone can rebuild the tree and check the
 * root. The gate below is a spam check only, not an eligibility decision.
 */
contract VoterRegistry {
    IVotesSnapshot public immutable token;

    mapping(address => bytes32) public commitmentOf;

    event VoterRegistered(address indexed voter, bytes32 commitment);

    constructor(address _token) {
        token = IVotesSnapshot(_token);
    }

    /**
     * @param commitment Poseidon(secret) — secret never touches the chain.
     */
    function register(bytes32 commitment) external {
        require(commitmentOf[msg.sender] == bytes32(0), "already registered");
        require(commitment != bytes32(0), "commitment cannot be zero");
        // Spam gate, NOT an eligibility decision: the caller must hold voting
        // power at the time it registers, so the registry cannot be filled by
        // addresses that have never held the token. Whether a registrant is
        // eligible for a PARTICULAR proposal is settled off-chain, against
        // that proposal's own snapshot, when its Merkle tree is built. See the
        // contract notice above.
        require(token.getVotes(msg.sender) > 0, "no voting power at registration");

        commitmentOf[msg.sender] = commitment;
        emit VoterRegistered(msg.sender, commitment);
    }

    function isRegistered(address voter) external view returns (bool) {
        return commitmentOf[voter] != bytes32(0);
    }
}
