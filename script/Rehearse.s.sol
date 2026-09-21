// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {HomerunChainConfig} from "../src/structs/HomerunChainConfig.sol";
import {HomerunDeployment} from "./helpers/HomerunDeployment.sol";

/// @notice Runs the production deployment helper twice in a fork simulation, without broadcasting.
contract Rehearse is HomerunDeployment {
    /// @notice Exercises fresh/partial deployment or verified reuse, then repeats against the resulting state.
    function run() public {
        HomerunChainConfig[] memory chains = _loadChains();
        _deploy(chains);
        _writeManifest({chains: chains, deployed: _deploy(chains), kind: "simulation"});
    }
}
