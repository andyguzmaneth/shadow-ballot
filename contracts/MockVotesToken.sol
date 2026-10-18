// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./VoterRegistry.sol";

/**
 * @title MockVotesToken
 * @notice Test-only stand-in for a real ERC20Votes governance token. Implements
 *         just enough of getPastVotes to test VoterRegistry against a
 *         snapshot-shaped interface without pulling in OpenZeppelin's full
 *         ERC20Votes (checkpoints, delegation, etc.) — not for production use.
 */
contract MockVotesToken is IVotesSnapshot {
    mapping(address => mapping(uint256 => uint256)) private votesAtBlock;
    mapping(address => uint256) private currentVotes;

    /// Test helper: set an account's recorded voting power as of `blockNumber`.
    function setPastVotes(address account, uint256 blockNumber, uint256 amount) external {
        votesAtBlock[account][blockNumber] = amount;
    }

    /// Test helper: set an account's CURRENT voting power, which is what
    /// VoterRegistry's spam gate reads.
    function setVotes(address account, uint256 amount) external {
        currentVotes[account] = amount;
    }

    function getPastVotes(address account, uint256 blockNumber) external view returns (uint256) {
        return votesAtBlock[account][blockNumber];
    }

    function getVotes(address account) external view returns (uint256) {
        return currentVotes[account];
    }
}
