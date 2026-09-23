// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {HomerunChainConfig} from "../src/structs/HomerunChainConfig.sol";
import {HomerunDeployment} from "./helpers/HomerunDeployment.sol";
import {HomerunDeploymentAddresses} from "./structs/HomerunDeploymentAddresses.sol";

/// @notice Runs the production deployment helper twice in a fork simulation, without broadcasting.
/// @dev Acts as `HOMERUN_CONFIGURATOR`, as the Sphinx proposal does.
contract Rehearse is HomerunDeployment {
    /// @notice Exercises fresh/partial deployment and configuration or verified reuse, then repeats against the
    /// resulting state.
    function run() public {
        HomerunChainConfig[] memory chains = _loadChains();
        vm.startPrank(HOMERUN_CONFIGURATOR);
        _configure({chains: chains, deployed: _deploy(chains)});
        HomerunDeploymentAddresses memory deployed = _deploy(chains);
        _configure({chains: chains, deployed: deployed});
        vm.stopPrank();
        _writeManifest({chains: chains, deployed: deployed, kind: "simulation"});
    }
}
