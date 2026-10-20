// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Governor} from "@openzeppelin/contracts/governance/Governor.sol";
import {IGovernor} from "@openzeppelin/contracts/governance/IGovernor.sol";

/**
 * @title GovernorAnamorphicCounting
 * @notice The dissertation's target integration ("integrating with OpenZeppelin
 *         Governor, the most widely deployed DAO voting framework") — a real
 *         counting extension, not a standalone contract next to Governor.
 *
 * The architectural mismatch this resolves: standard Governor.castVote() always
 * uses msg.sender as the voter and looks up their weight via getVotes(). This
 * protocol's whole point is that votes do NOT come from the voter's known
 * address — they arrive as disguised transfers to stealth addresses, decoded
 * off-chain by the coordinator. There is no way to make msg.sender-based voting
 * work here without breaking participation non-observability, so this extension
 * does not try to preserve castVote() as the voting entry point. Instead:
 *
 *   - Individual castVote()/castVoteWithReason()/etc. are all disabled
 *     (_countVote always reverts) — nobody should be able to cast a Governor
 *     vote the normal way in this scheme, and a revert makes that explicit
 *     rather than silently accepting and misrecording votes.
 *   - The coordinator submits ONE aggregated tally per proposal, after decoding
 *     all anamorphic votes off-chain (vote.ts's decodeVote, scaled up).
 *   - Eligibility is not proved on-chain and needs no proof: the voter signs
 *     from the address that holds the tokens, so getPastVotes settles it by
 *     inspection (Ch3 §3.4.4). There is no circuit, no verifier and no
 *     nullifier. Double voting is handled off-chain: each voter's stealth
 *     addresses are deterministic per proposal, so the coordinator counts the
 *     highest index it finds and discards the rest (Ch3 §3.4.3a).
 *   - Alongside the tally the coordinator publishes a commitment to the set of
 *     votes it counted (Ch3 §3.4.4a). Every voter can reconstruct their own
 *     leaf and check it is included, so a dropped vote is provable by its
 *     owner. The commitment is hiding, so it reveals nothing to anyone else.
 *
 * A real correctness issue this design creates, and the fix, stated explicitly:
 * Governor.state() transitions Active -> Defeated/Succeeded purely based on
 * whether the voting deadline has passed, using _quorumReached/_voteSucceeded.
 * Before the coordinator submits, those both read zero votes, so a naive
 * implementation would show every proposal as Defeated the instant the voting
 * window closes, even though the real votes just haven't been tallied on-chain
 * yet. Fixed by overriding state() (see below) to hold at Active past the
 * deadline until the tally is actually submitted.
 */
abstract contract GovernorAnamorphicCounting is Governor {
    struct ProposalTally {
        uint256 againstVotes;
        uint256 forVotes;
        uint256 abstainVotes;
        bool tallySubmitted;
    }

    mapping(uint256 proposalId => ProposalTally) private _proposalTallies;
    /// Root of the hiding sparse Merkle tree over the counted votes (Ch3 §3.4.4a).
    /// Published with the tally so each voter can verify their own inclusion.
    mapping(uint256 proposalId => bytes32) private _voteCommitmentRoot;

    address public immutable coordinator;

    event AnamorphicTallySubmitted(
        uint256 indexed proposalId,
        uint256 forVotes,
        uint256 againstVotes,
        uint256 abstainVotes,
        bytes32 voteCommitmentRoot
    );

    error NotCoordinator(address caller);
    error TallyAlreadySubmitted(uint256 proposalId);
    error VotingNotYetClosed(uint256 proposalId);
    error DirectVotingDisabled();
    error EmptyCommitmentRoot();

    constructor(address _coordinator) {
        coordinator = _coordinator;
    }

    modifier onlyCoordinator() {
        if (msg.sender != coordinator) revert NotCoordinator(msg.sender);
        _;
    }

    /// @inheritdoc IGovernor
    // solhint-disable-next-line func-name-mixedcase
    function COUNTING_MODE() public pure virtual override returns (string memory) {
        return "support=bravo&quorum=for,abstain&params=anamorphic-coordinator-tally";
    }

    /**
     * @inheritdoc IGovernor
     * @dev Per-account hasVoted has no meaning here. A vote is an ordinary
     *      transfer, not a Governor call, so nothing on-chain records that an
     *      account voted; that is the point. Always false.
     */
    function hasVoted(uint256, address) public pure override returns (bool) {
        return false;
    }

    function proposalVotes(
        uint256 proposalId
    ) public view virtual returns (uint256 againstVotes, uint256 forVotes, uint256 abstainVotes) {
        ProposalTally storage t = _proposalTallies[proposalId];
        return (t.againstVotes, t.forVotes, t.abstainVotes);
    }

    /// @notice Commitment to the set of votes counted for a proposal (Ch3 §3.4.4a).
    ///         Zero until the tally is submitted.
    function voteCommitmentRoot(uint256 proposalId) external view returns (bytes32) {
        return _voteCommitmentRoot[proposalId];
    }

    /**
     * @notice Coordinator submits the aggregated, off-chain-decoded vote
     *         breakdown for a proposal exactly once, after the voting deadline,
     *         together with a commitment to the set of votes it counted.
     *
     * @dev Nothing here constrains the numbers: only the coordinator can derive
     *      the stealth addresses, so only it can enumerate the votes, and no
     *      observer can audit the total. That is Property 4's open half
     *      (Ch3 §3.3, Ch6 §6.4). What the commitment does buy is individual
     *      verifiability: every voter can reconstruct their own leaf from the
     *      shared secret and check it is in the tree, so a dropped vote is
     *      provable by its owner. The root is hiding, so it discloses nothing
     *      to anyone who is not already able to compute a leaf.
     */
    function submitAnamorphicTally(
        uint256 proposalId,
        uint256 forVotes,
        uint256 againstVotes,
        uint256 abstainVotes,
        bytes32 commitmentRoot
    ) external onlyCoordinator {
        if (proposalDeadline(proposalId) >= clock()) revert VotingNotYetClosed(proposalId);

        ProposalTally storage t = _proposalTallies[proposalId];
        if (t.tallySubmitted) revert TallyAlreadySubmitted(proposalId);

        if (commitmentRoot == bytes32(0)) revert EmptyCommitmentRoot();

        t.forVotes = forVotes;
        t.againstVotes = againstVotes;
        t.abstainVotes = abstainVotes;
        t.tallySubmitted = true;
        _voteCommitmentRoot[proposalId] = commitmentRoot;

        emit AnamorphicTallySubmitted(proposalId, forVotes, againstVotes, abstainVotes, commitmentRoot);
        _tallyUpdated(proposalId);
    }

    /// @inheritdoc Governor
    function _quorumReached(uint256 proposalId) internal view virtual override returns (bool) {
        ProposalTally storage t = _proposalTallies[proposalId];
        return quorum(proposalSnapshot(proposalId)) <= t.forVotes + t.abstainVotes;
    }

    /// @inheritdoc Governor
    function _voteSucceeded(uint256 proposalId) internal view virtual override returns (bool) {
        ProposalTally storage t = _proposalTallies[proposalId];
        return t.forVotes > t.againstVotes;
    }

    /**
     * @inheritdoc Governor
     * @dev Always reverts — see contract-level doc comment. This is deliberate,
     *      not a stub: nobody should be able to cast a Governor vote the normal way.
     */
    function _countVote(
        uint256,
        address,
        uint8,
        uint256,
        bytes memory
    ) internal pure override returns (uint256) {
        revert DirectVotingDisabled();
    }

    /**
     * @inheritdoc Governor
     * @notice Overridden to hold a proposal at Active past its voting deadline
     *         until the coordinator submits the tally — otherwise base Governor
     *         would report every proposal Defeated the instant voting closes,
     *         since _quorumReached/_voteSucceeded both read zero votes pre-submission.
     */
    function state(uint256 proposalId) public view virtual override returns (ProposalState) {
        ProposalState baseState = super.state(proposalId);
        if (baseState == ProposalState.Defeated && !_proposalTallies[proposalId].tallySubmitted) {
            return ProposalState.Active;
        }
        return baseState;
    }
}
