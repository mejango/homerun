// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/// @custom:member chainId The ID of the chain this entry configures.
/// @custom:member revDeployer The canonical `REVDeployer` on that chain. The core, terminal and router terminal
/// registry are read from it.
/// @custom:member usdc The USDC token on that chain. Every FUND treasury and sucker mapping uses it.
/// @custom:member omnichainDeployer The canonical `JBOmnichainDeployer` on that chain.
/// @custom:member allowlistHook The `HomerunAllowlistHook` on that chain. Installed as every FUND's extra pay hook.
struct HomerunChainConfig {
    uint32 chainId;
    address revDeployer;
    address usdc;
    address omnichainDeployer;
    address allowlistHook;
}
