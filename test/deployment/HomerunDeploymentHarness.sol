// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {HomerunDeployment} from "../../script/helpers/HomerunDeployment.sol";
import {HomerunDeploymentAddresses} from "../../script/structs/HomerunDeploymentAddresses.sol";
import {HomerunChainConfig} from "../../src/structs/HomerunChainConfig.sol";

/// @notice Exposes the production deployment helpers to local regression tests.
contract HomerunDeploymentHarness is HomerunDeployment {
    /// @notice Configures from this harness rather than `HOMERUN_CONFIGURATOR`.
    /// @param chains The per-chain protocol configuration, without hooks.
    /// @param deployed The deployed Homerun addresses.
    function configureAsSelf(HomerunChainConfig[] memory chains, HomerunDeploymentAddresses memory deployed) external {
        _configure({chains: chains, deployed: deployed});
    }

    /// @notice Deploys, then configures as `HOMERUN_CONFIGURATOR`, as the Sphinx proposal does.
    /// @param chains The per-chain protocol configuration, without hooks.
    /// @return deployed The deployed Homerun addresses.
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
    /// @param chains The per-chain protocol configuration, without hooks.
    function deployHookOnly(HomerunChainConfig[] memory chains) external {
        _verifyProtocol(chains);
        _deployIfNeeded({name: "HomerunAllowlistHook", salt: HOMERUN_SALT, args: _hookArgs(chains)});
    }

    /// @notice Deploys without configuring, as a broadcast from a funded key does.
    /// @param chains The per-chain protocol configuration, without hooks.
    /// @return deployed The deployed Homerun addresses.
    function deployUnconfigured(HomerunChainConfig[] memory chains)
        external
        returns (HomerunDeploymentAddresses memory deployed)
    {
        return _deploy(chains);
    }

    /// @notice Deploys a deployer with the given hook under another salt.
    /// @param chains The per-chain protocol configuration, without hooks.
    /// @param hook The allowlist hook to bind.
    /// @param salt The deployment salt.
    /// @return deployer The deployed deployer.
    function deployVariant(
        HomerunChainConfig[] memory chains,
        address hook,
        bytes32 salt
    )
        external
        returns (address deployer)
    {
        return _deployIfNeeded({name: "HomerunDeployer", salt: salt, args: _deployerArgs({chains: chains, hook: hook})});
    }

    /// @notice Exposes `_group`.
    /// @param chainId The chain ID to resolve.
    /// @return chainIds The chain IDs of the group.
    function group(uint256 chainId) external pure returns (uint32[] memory chainIds) {
        return _group(chainId);
    }

    /// @notice Loads the group's chains from a workspace.
    /// @param workspace The directory containing the sibling protocol checkouts and their `deployments/` trees.
    /// @return chains The validated per-chain protocol configuration, without hooks.
    function loadChains(string memory workspace) external view returns (HomerunChainConfig[] memory chains) {
        return _loadChainsFrom(workspace);
    }

    /// @notice Exposes `_network`.
    /// @param chainId The chain ID to resolve.
    /// @return name The artifact folder name.
    function network(uint256 chainId) external pure returns (string memory name) {
        return _network(chainId);
    }

    /// @notice Exposes `_predict`.
    /// @param chains The per-chain protocol configuration, without hooks.
    /// @return deployed The predicted deployment addresses.
    function predict(HomerunChainConfig[] memory chains)
        external
        view
        returns (HomerunDeploymentAddresses memory deployed)
    {
        return _predict(chains);
    }

    /// @notice Exposes `_verify`.
    /// @param chains The per-chain protocol configuration, without hooks.
    /// @param deployed The expected Homerun addresses.
    function verify(HomerunChainConfig[] memory chains, HomerunDeploymentAddresses memory deployed) external view {
        _verify({chains: chains, deployed: deployed});
    }

    /// @notice Exposes `_verifyRuntime`.
    /// @param name The compiled artifact name.
    /// @param target The deployed contract to inspect.
    function verifyRuntime(string memory name, address target) external view {
        _verifyRuntime({name: name, target: target});
    }

    /// @notice Writes a test manifest.
    /// @param chains The per-chain protocol configuration, without hooks.
    /// @param deployed The deployed Homerun addresses.
    function writeManifest(HomerunChainConfig[] memory chains, HomerunDeploymentAddresses memory deployed) external {
        _writeManifest({chains: chains, deployed: deployed, kind: "test"});
    }
}
