// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/// @custom:member chainId The ID of the chain this entry configures.
/// @custom:member controller The canonical `JBController` on that chain.
/// @custom:member revDeployer The canonical `REVDeployer` on that chain.
/// @custom:member usdc The USDC token on that chain. Every FUND treasury and sucker mapping uses it.
/// @custom:member omnichainDeployer The canonical `JBOmnichainDeployer` on that chain.
/// @custom:member routerTerminalRegistry The canonical `JBRouterTerminalRegistry` on that chain. Registered with no
/// accounting contexts so FUND and INCOME accept any token through swap routing.
/// @custom:member allowlistHook The `HomerunAllowlistHook` on that chain. Installed as every FUND's extra pay hook.
struct HomerunChainConfig {
    uint32 chainId;
    address controller;
    address revDeployer;
    address usdc;
    address omnichainDeployer;
    address routerTerminalRegistry;
    address allowlistHook;
}
