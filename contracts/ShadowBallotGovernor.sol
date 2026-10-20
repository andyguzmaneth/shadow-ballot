// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Governor} from "@openzeppelin/contracts/governance/Governor.sol";
import {GovernorSettings} from "@openzeppelin/contracts/governance/extensions/GovernorSettings.sol";
import {GovernorVotes} from "@openzeppelin/contracts/governance/extensions/GovernorVotes.sol";
import {GovernorVotesQuorumFraction} from "@openzeppelin/contracts/governance/extensions/GovernorVotesQuorumFraction.sol";
import {IVotes} from "@openzeppelin/contracts/governance/utils/IVotes.sol";
import {IGovernor} from "@openzeppelin/contracts/governance/IGovernor.sol";
import {GovernorAnamorphicCounting} from "./GovernorAnamorphicCounting.sol";

/**
 * @title ShadowBallotGovernor
 * @notice Concrete OpenZeppelin Governor wiring standard voting-weight/settings
 *         extensions to GovernorAnamorphicCounting — this is the dissertation's
 *         "integrating with OpenZeppelin Governor" claim made real, composed the
 *         same way any standard OZ Governor is (GovernorSettings + GovernorVotes
 *         + GovernorVotesQuorumFraction), swapping only the counting module.
 */
contract ShadowBallotGovernor is
    Governor,
    GovernorSettings,
    GovernorVotes,
    GovernorVotesQuorumFraction,
    GovernorAnamorphicCounting
{
    constructor(
        IVotes token_,
        address coordinator_,
        uint48 votingDelay_,
        uint32 votingPeriod_,
        uint256 proposalThreshold_,
        uint256 quorumNumerator_
    )
        Governor("ShadowBallotGovernor")
        GovernorSettings(votingDelay_, votingPeriod_, proposalThreshold_)
        GovernorVotes(token_)
        GovernorVotesQuorumFraction(quorumNumerator_)
        GovernorAnamorphicCounting(coordinator_)
    {}

    // --- Required overrides where multiple parents define the same function ---

    function votingDelay() public view override(Governor, GovernorSettings) returns (uint256) {
        return super.votingDelay();
    }

    function votingPeriod() public view override(Governor, GovernorSettings) returns (uint256) {
        return super.votingPeriod();
    }

    function quorum(uint256 timepoint) public view override(Governor, GovernorVotesQuorumFraction) returns (uint256) {
        return super.quorum(timepoint);
    }

    function proposalThreshold() public view override(Governor, GovernorSettings) returns (uint256) {
        return super.proposalThreshold();
    }

    function state(uint256 proposalId) public view override(Governor, GovernorAnamorphicCounting) returns (ProposalState) {
        return super.state(proposalId);
    }

    // override() must name IGovernor (where COUNTING_MODE is actually declared),
    // not Governor — Governor itself never redeclares it.
    function COUNTING_MODE() public pure override(IGovernor, GovernorAnamorphicCounting) returns (string memory) {
        return super.COUNTING_MODE();
    }
}
