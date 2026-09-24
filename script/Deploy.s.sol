// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Sphinx} from "@sphinx-labs/contracts/contracts/foundry/SphinxPlugin.sol";

import {HomerunChainConfig} from "../src/structs/HomerunChainConfig.sol";
import {HomerunDeployment} from "./helpers/HomerunDeployment.sol";
import {HomerunDeploymentAddresses} from "./structs/HomerunDeploymentAddresses.sol";

/// @notice Proposes the deterministic Homerun singleton suite through the Juicebox V6 Sphinx workflow.
contract Deploy is HomerunDeployment, Sphinx {
    //*********************************************************************//
    // --------------------------- custom errors ------------------------- //
    //*********************************************************************//

    /// @notice Sphinx resolved a Safe other than the reviewed Homerun Safe.
    error Deploy_UnexpectedSafe(address expected, address actual);

    //*********************************************************************//
    // -------------------- internal stored properties ------------------- //
    //*********************************************************************//

    /// @notice Verified protocol dependencies for the connected chain's group.
    HomerunChainConfig[] internal _chains;

    //*********************************************************************//
    // ----------------------- public transactions ----------------------- //
    //*********************************************************************//

    /// @notice Configures the Sphinx project and supported RPC aliases.
    function configureSphinx() public override {
        sphinxConfig.projectName = "homerun";
        sphinxConfig.mainnets = ["ethereum", "optimism", "base", "arbitrum"];
        sphinxConfig.testnets = ["ethereum_sepolia", "optimism_sepolia", "base_sepolia", "arbitrum_sepolia"];
    }

    /// @notice Collects only missing deployment and configuration transactions and validates every new or reused
    /// contract.
    /// @dev The Safe is `HOMERUN_CONFIGURATOR`, so it sets the deployer's chain-specific constants in the same
    /// proposal.
    function deploy() public sphinx {
        HomerunDeploymentAddresses memory deployed = _deploy(_chains);
        _configure({chains: _chains, deployed: deployed});
        _writeManifest({chains: _chains, deployed: deployed, kind: "simulation"});
    }

    /// @notice Validates connected-chain dependencies before collecting the Sphinx proposal.
    function run() public {
        address actualSafe = safeAddress();
        // The `homerun` Sphinx project's 1-of-3 `V6 Jango` Safe is the deployer's configurator.
        if (actualSafe != HOMERUN_CONFIGURATOR) {
            revert Deploy_UnexpectedSafe({expected: HOMERUN_CONFIGURATOR, actual: actualSafe});
        }
        HomerunChainConfig[] memory chains = _loadChains();
        delete _chains;
        for (uint256 i; i < chains.length; i++) {
            _chains.push(chains[i]);
        }
        deploy();
    }
}
