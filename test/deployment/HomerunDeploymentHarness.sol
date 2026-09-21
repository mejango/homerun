// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {HomerunDeployment} from "../../script/helpers/HomerunDeployment.sol";
import {HomerunDeploymentAddresses} from "../../script/structs/HomerunDeploymentAddresses.sol";
import {HomerunChainConfig} from "../../src/structs/HomerunChainConfig.sol";

/// @notice Exposes the production deployment helpers to local regression tests.
contract HomerunDeploymentHarness is HomerunDeployment {
    function deployFor(HomerunChainConfig[] memory chains) external returns (HomerunDeploymentAddresses memory) {
        return _deploy(chains);
    }

    function deployHookOnly(HomerunChainConfig[] memory chains) external {
        _verifyProtocol(chains);
        _deployIfNeeded({name: "HomerunAllowlistHook", salt: HOMERUN_SALT, args: _hookArgs(chains)});
    }

    function deployVariant(HomerunChainConfig[] memory chains, bytes32 salt) external returns (address) {
        return _deployIfNeeded({name: "HomerunDeployer", salt: salt, args: abi.encode(chains)});
    }

    function loadChains(string memory workspace) external view returns (HomerunChainConfig[] memory) {
        return _loadChainsFrom(workspace);
    }

    function network(uint256 chainId) external pure returns (string memory) {
        return _network(chainId);
    }

    function group(uint256 chainId) external pure returns (uint32[] memory) {
        return _group(chainId);
    }

    function predict(HomerunChainConfig[] memory chains) external view returns (HomerunDeploymentAddresses memory) {
        return _predict(chains);
    }

    function verify(HomerunChainConfig[] memory chains, HomerunDeploymentAddresses memory deployed) external view {
        _verify({chains: chains, deployed: deployed});
    }

    function verifyRuntime(string memory name, address target) external view {
        _verifyRuntime({name: name, target: target});
    }

    function writeManifest(HomerunChainConfig[] memory chains, HomerunDeploymentAddresses memory deployed) external {
        _writeManifest({chains: chains, deployed: deployed, kind: "test"});
    }
}
