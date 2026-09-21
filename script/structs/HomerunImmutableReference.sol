// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/// @notice One compiler-reported immutable or library link location, ordered to match Foundry JSON decoding.
/// @custom:member length The number of bytes occupied by the value.
/// @custom:member start The byte offset within the bytecode.
struct HomerunImmutableReference {
    uint256 length;
    uint256 start;
}
