// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/// @notice The slice of Arbitrum's `ArbSys` precompile that exposes L2 block identity.
/// @dev On Arbitrum, `block.number` and `blockhash` refer to L1 ancestry; snapshots taken through an L2 RPC use
/// these instead.
interface IArbSys {
    /// @notice The hash of an L2 block.
    /// @param blockNumber The L2 block number to get the hash of. Must be within the last 256 L2 blocks.
    /// @return hash The hash of the block.
    function arbBlockHash(uint256 blockNumber) external view returns (bytes32 hash);

    /// @notice The current L2 block number.
    /// @return blockNumber The current L2 block number.
    function arbBlockNumber() external view returns (uint256 blockNumber);
}
