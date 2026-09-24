// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {HomerunChainConfig} from "../src/structs/HomerunChainConfig.sol";
import {HomerunDeployment} from "./helpers/HomerunDeployment.sol";

/// @notice Sends the missing deployment transactions from a funded account through the canonical CREATE2 factory.
/// @dev The factory derives every address from the salt and creation code alone, so a broadcast lands on the same
/// addresses a rehearsal predicts and a later Sphinx proposal would produce. Only `HOMERUN_CONFIGURATOR` can set the
/// deployer's chain-specific constants, so a Sphinx proposal of `Deploy` configures what a broadcast deployed; run
/// `Verify` after that for the manifest.
contract Broadcast is HomerunDeployment {
    /// @notice Deploys or reuses every singleton on the connected chain.
    function run() public {
        HomerunChainConfig[] memory chains = _loadChains();
        vm.startBroadcast();
        _deploy(chains);
        vm.stopBroadcast();
    }
}
