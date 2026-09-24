// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {HomerunDeployment} from "../../script/helpers/HomerunDeployment.sol";
import {HomerunDeploymentAddresses} from "../../script/structs/HomerunDeploymentAddresses.sol";
import {HomerunChainConfig} from "../../src/structs/HomerunChainConfig.sol";

/// @notice Exposes the production deployment helpers to local regression tests.
contract HomerunDeploymentHarness is HomerunDeployment {
    /// @notice Configures from this harness rather than `HOMERUN_CONFIGURATOR`.
    function configureAsSelf(HomerunChainConfig[] memory chains, HomerunDeploymentAddresses memory deployed) external {
        _configure({chains: chains, deployed: deployed});
    }

    /// @notice Deploys, then configures as `HOMERUN_CONFIGURATOR`, as the Sphinx proposal does.
    function deployFor(HomerunChainConfig[] memory chains)
        external
        returns (HomerunDeploymentAddresses memory deployed)
    {
        deployed = _deploy(chains);
        vm.startPrank(HOMERUN_CONFIGURATOR);
        _configure({chains: chains, deployed: deployed});
        vm.stopPrank();
    }

    /// @notice Deploys only the allowlist hook.
    function deployHookOnly(HomerunChainConfig[] memory chains) external {
        _verifyProtocol(chains);
        _deployIfNeeded({name: "HomerunAllowlistHook", salt: HOMERUN_SALT, args: _hookArgs(chains)});
    }

    /// @notice Deploys without configuring, as a broadcast from a funded key does.
    function deployUnconfigured(HomerunChainConfig[] memory chains)
        external
        returns (HomerunDeploymentAddresses memory)
    {
        return _deploy(chains);
    }

    /// @notice Deploys a deployer with the given hook under another salt.
    function deployVariant(HomerunChainConfig[] memory chains, address hook, bytes32 salt) external returns (address) {
        return _deployIfNeeded({name: "HomerunDeployer", salt: salt, args: _deployerArgs({chains: chains, hook: hook})});
    }

    /// @notice Exposes `_group`.
    function group(uint256 chainId) external pure returns (uint32[] memory) {
        return _group(chainId);
    }

    /// @notice Loads the group's chains from a workspace.
    function loadChains(string memory workspace) external view returns (HomerunChainConfig[] memory) {
        return _loadChainsFrom(workspace);
    }

    /// @notice Exposes `_network`.
    function network(uint256 chainId) external pure returns (string memory) {
        return _network(chainId);
    }

    /// @notice Exposes `_predict`.
    function predict(HomerunChainConfig[] memory chains) external view returns (HomerunDeploymentAddresses memory) {
        return _predict(chains);
    }

    /// @notice Exposes `_verify`.
    function verify(HomerunChainConfig[] memory chains, HomerunDeploymentAddresses memory deployed) external view {
        _verify({chains: chains, deployed: deployed});
    }

    /// @notice Exposes `_verifyRuntime`.
    function verifyRuntime(string memory name, address target) external view {
        _verifyRuntime({name: name, target: target});
    }

    /// @notice Writes a test manifest.
    function writeManifest(HomerunChainConfig[] memory chains, HomerunDeploymentAddresses memory deployed) external {
        _writeManifest({chains: chains, deployed: deployed, kind: "test"});
    }
}
