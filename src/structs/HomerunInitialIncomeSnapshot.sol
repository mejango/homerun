// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import {HomerunInitialIncomeAllocation} from "./HomerunInitialIncomeAllocation.sol";

/// @custom:member sourceSetHash The hash of the canonical global FUND ownership report the allocations derive from.
/// @custom:member totalFundSupply The global FUND supply the allocations divide, as a fixed point number with 18
/// decimals.
/// @custom:member manifestHash The hash of the published manifest listing every holder and their allocation.
/// @custom:member manifestUri The content-addressed URI of that manifest.
/// @custom:member allocations One entry per linked chain, in ascending chain ID. Their `incomeAmount`s sum to the
/// global initial INCOME supply.
struct HomerunInitialIncomeSnapshot {
    bytes32 sourceSetHash;
    uint256 totalFundSupply;
    bytes32 manifestHash;
    string manifestUri;
    HomerunInitialIncomeAllocation[] allocations;
}
