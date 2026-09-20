// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {HomerunInitialIncomeVault} from "../HomerunInitialIncomeVault.sol";

/// @notice External library for `HomerunDeployer` operations extracted to stay within the EIP-170 contract size
/// limit.
/// @dev Deploys the initial INCOME vault. External library calls are delegate calls, so the vault still sees the
/// deployer as its creator.
library HomerunDeployerLib {
    //*********************************************************************//
    // ---------------------- external transactions ---------------------- //
    //*********************************************************************//

    /// @notice Deploys a vault holding one chain's share of a FUND's initial INCOME allocation.
    /// @param incomeToken The INCOME token the vault pays out.
    /// @param incomeProjectId The ID of the INCOME project whose token the vault holds.
    /// @param fundProjectId The ID of the FUND project whose holders the vault pays.
    /// @param snapshotBlockNumber The block the FUND balances were read at, in this chain's own height.
    /// @param snapshotBlockHash The hash of that block.
    /// @param totalFundSupply The global FUND supply the allocations divide.
    /// @param launchSalt The salt the FUND owner launched INCOME with.
    /// @param merkleRoot The root of the leaves the vault pays. Zero when there are no leaves.
    /// @param leafCount The number of leaves under the root.
    /// @param manifestHash The hash of the published manifest.
    /// @param manifestUri The content-addressed URI of the published manifest.
    /// @param sourceSetHash The hash of the canonical global FUND ownership report.
    /// @param localInitialIncomeSupply The most INCOME the vault will ever pay out.
    /// @return vault The vault.
    function deployVault(
        address incomeToken,
        uint256 incomeProjectId,
        uint256 fundProjectId,
        uint256 snapshotBlockNumber,
        bytes32 snapshotBlockHash,
        uint256 totalFundSupply,
        bytes32 launchSalt,
        bytes32 merkleRoot,
        uint256 leafCount,
        bytes32 manifestHash,
        string calldata manifestUri,
        bytes32 sourceSetHash,
        uint256 localInitialIncomeSupply
    )
        external
        returns (address vault)
    {
        return address(
            new HomerunInitialIncomeVault({
                incomeToken: incomeToken,
                incomeProjectId: incomeProjectId,
                fundProjectId: fundProjectId,
                snapshotBlockNumber: snapshotBlockNumber,
                snapshotBlockHash: snapshotBlockHash,
                totalFundSupply: totalFundSupply,
                launchSalt: launchSalt,
                merkleRoot: merkleRoot,
                leafCount: leafCount,
                manifestHash: manifestHash,
                manifestUri_: manifestUri,
                sourceSetHash: sourceSetHash,
                localInitialIncomeSupply: localInitialIncomeSupply
            })
        );
    }
}
