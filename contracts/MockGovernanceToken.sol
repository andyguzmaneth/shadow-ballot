// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {ERC20Votes} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Votes.sol";
import {Nonces} from "@openzeppelin/contracts/utils/Nonces.sol";

/**
 * @title MockGovernanceToken
 * @notice Test-only real OpenZeppelin ERC20Votes token — used so
 *         ShadowBallotGovernor is tested against the actual voting-weight and
 *         clock machinery Governor integrates with, not a hand-rolled stand-in.
 *         VoterRegistry.sol also targets this interface via IVotesSnapshot
 *         (getPastVotes), so this one token backs both the ZK-eligibility
 *         registration flow and the Governor integration in tests.
 */
contract MockGovernanceToken is ERC20, ERC20Permit, ERC20Votes {
    constructor() ERC20("Shadow Ballot Governance Token", "SBGOV") ERC20Permit("Shadow Ballot Governance Token") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    // Required overrides — ERC20Votes needs to hook into transfers to checkpoint
    // voting power, and clock/CLOCK_MODE resolve which timepoint (block number,
    // by default) getPastVotes/getVotes operate on.
    function _update(address from, address to, uint256 value) internal override(ERC20, ERC20Votes) {
        super._update(from, to, value);
    }

    // override() must name Nonces (where nonces() is actually declared), not
    // ERC20Permit (which just inherits it) — Solidity requires the declaring
    // contract, not an intermediate one in the inheritance chain.
    function nonces(address owner) public view override(ERC20Permit, Nonces) returns (uint256) {
        return super.nonces(owner);
    }
}
