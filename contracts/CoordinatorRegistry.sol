// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title CoordinatorRegistry
 * @notice Where a coordinator publishes its stealth meta-address (Ch3 §3.4.2,
 *         step 1): the spending key S and the viewing key V, as compressed
 *         secp256k1 points.
 *
 * This replaces "publish via the DAO's governance forum" with a place a voter
 * can read programmatically. Reading is an ordinary call against contract
 * storage: no transaction, no log, nothing that identifies who looked.
 *
 * The private scalars s and v never appear here. Only the coordinator that
 * published an entry may replace it, and replacing it does not invalidate
 * votes already cast against the old keys, since each vote's stealth address
 * is derived from whichever V the voter read at the time.
 */
contract CoordinatorRegistry {
    struct MetaAddress {
        bytes spendingKey;   // compressed point S = s·G, 33 bytes
        bytes viewingKey;    // compressed point V = v·G, 33 bytes
    }

    mapping(address coordinator => MetaAddress) private _metaAddresses;

    event MetaAddressPublished(address indexed coordinator, bytes spendingKey, bytes viewingKey);

    error InvalidPointLength();
    error InvalidPointPrefix();

    /**
     * @notice Publish or replace this caller's meta-address.
     * @dev Checks the SEC1 compressed-point envelope only: 33 bytes with a
     *      0x02 or 0x03 prefix. It cannot check that the point is on the curve
     *      without an expensive in-EVM implementation, so the voter's client
     *      must still validate before use. Ch3 §3.4.3 makes that a protocol
     *      requirement rather than an implementation detail, because an
     *      off-curve point can leak the viewing key by small-subgroup
     *      confinement.
     */
    function publish(bytes calldata spendingKey, bytes calldata viewingKey) external {
        if (spendingKey.length != 33 || viewingKey.length != 33) revert InvalidPointLength();
        if ((spendingKey[0] != 0x02 && spendingKey[0] != 0x03) ||
            (viewingKey[0] != 0x02 && viewingKey[0] != 0x03)) revert InvalidPointPrefix();

        _metaAddresses[msg.sender] = MetaAddress(spendingKey, viewingKey);
        emit MetaAddressPublished(msg.sender, spendingKey, viewingKey);
    }

    function metaAddressOf(address coordinator)
        external view returns (bytes memory spendingKey, bytes memory viewingKey)
    {
        MetaAddress storage m = _metaAddresses[coordinator];
        return (m.spendingKey, m.viewingKey);
    }
}
