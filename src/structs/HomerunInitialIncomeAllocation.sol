// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/// @custom:member chainId The ID of the chain whose FUND holders this allocation belongs to.
/// @custom:member fundProjectId The ID of the FUND project on that chain.
/// @custom:member snapshotBlockNumber The finalized block the FUND balances were read at, in that chain's own
/// height (L2 height on Arbitrum).
/// @custom:member snapshotBlockHash The hash of that block.
/// @custom:member incomeAmount The INCOME minted on that chain for the FUND's owner, as a fixed point number with 18
/// decimals.
struct HomerunInitialIncomeAllocation {
    uint32 chainId;
    uint256 fundProjectId;
    uint256 snapshotBlockNumber;
    bytes32 snapshotBlockHash;
    uint104 incomeAmount;
}
