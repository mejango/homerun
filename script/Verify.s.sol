// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {HomerunChainConfig} from "../src/structs/HomerunChainConfig.sol";
import {HomerunDeployment} from "./helpers/HomerunDeployment.sol";

/// @notice Verifies a deployed Homerun suite without sending transactions, and writes its live manifest.
contract Verify is HomerunDeployment {
    /// @notice Checks current artifacts, predictions, bytecode and immutable bindings against the connected RPC.
    function run() public {
        HomerunChainConfig[] memory chains = _loadChains();
        _writeManifest({chains: chains, deployed: _predict(chains), kind: "verified"});
    }
}
