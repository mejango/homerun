// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/// @notice Deterministic addresses for the Homerun singleton deployment.
/// @custom:member allowlistHook The pay hook installed on every FUND.
/// @custom:member deployer The FUND and INCOME factory.
struct HomerunDeploymentAddresses {
    address allowlistHook;
    address deployer;
}
