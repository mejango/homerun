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

    /// @notice Sphinx resolved a Safe other than the reviewed V6 deployment Safe.
    error Deploy_UnexpectedSafe(address expected, address actual);

    //*********************************************************************//
    // ------------------------ private constants ------------------------ //
    //*********************************************************************//

    /// @notice The registered `v6-deployment` 4-of-8 Safe used by deploy-all-v6.
    address private constant _EXPECTED_SAFE = 0x4dc161eF837fF1C4485b08DDFcDB182F2157bE18;

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
        sphinxConfig.projectName = "v6-deployment";
        sphinxConfig.mainnets = ["ethereum", "optimism", "base", "arbitrum"];
        sphinxConfig.testnets = ["ethereum_sepolia", "optimism_sepolia", "base_sepolia", "arbitrum_sepolia"];
    }

    /// @notice Collects only missing deployment transactions and validates every new or reused contract.
    function deploy() public sphinx {
        HomerunDeploymentAddresses memory deployed = _deploy(_chains);
        _writeManifest({chains: _chains, deployed: deployed, kind: "simulation"});
    }

    /// @notice Validates connected-chain dependencies before collecting the Sphinx proposal.
    function run() public {
        address actualSafe = safeAddress();
        if (actualSafe != _EXPECTED_SAFE) {
            revert Deploy_UnexpectedSafe({expected: _EXPECTED_SAFE, actual: actualSafe});
        }
        HomerunChainConfig[] memory chains = _loadChains();
        delete _chains;
        for (uint256 i; i < chains.length; i++) {
            _chains.push(chains[i]);
        }
        deploy();
    }
}
