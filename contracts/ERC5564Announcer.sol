// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title ERC5564Announcer
 * @notice Minimal, spec-compliant implementation of the ERC-5564 stealth-address
 *         Announcer contract (event signature verified against eips.ethereum.org/EIPS/eip-5564
 *         and the ERC5564Announcer reference at stealthaddress.dev, 2026-08-18).
 *
 * Replaces the browser-localStorage demo shim previously used to move the ephemeral
 * public key R from voter to coordinator (dissertation Ch3, §3.4.3 step 2a). The real
 * canonical singleton is deployed at 0x55649E01B5Df198D18D95b5cc5051630cfD45564 on
 * mainnet and several L2s/testnets — this is a project-local instance for testing;
 * a production deployment would call the canonical address instead so votes share
 * the real cross-application anonymity set (the whole point of using a public,
 * generic announcer rather than a vote-specific one).
 *
 * No access control by design — matches the real ERC-5564 Announcer, which is
 * permissionless (anyone can announce anything). Vote-specific filtering happens
 * off-chain by the coordinator (schemeId + caller filtering), not on-chain.
 */
contract ERC5564Announcer {
    event Announcement(
        uint256 indexed schemeId,
        address indexed stealthAddress,
        address indexed caller,
        bytes ephemeralPubKey,
        bytes metadata
    );

    function announce(
        uint256 schemeId,
        address stealthAddress,
        bytes memory ephemeralPubKey,
        bytes memory metadata
    ) external {
        emit Announcement(schemeId, stealthAddress, msg.sender, ephemeralPubKey, metadata);
    }
}
