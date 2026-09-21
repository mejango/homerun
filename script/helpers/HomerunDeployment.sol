// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IJBController} from "@bananapus/core-v6/src/interfaces/IJBController.sol";
import {IJBDirectory} from "@bananapus/core-v6/src/interfaces/IJBDirectory.sol";
import {IJBProjects} from "@bananapus/core-v6/src/interfaces/IJBProjects.sol";
import {JBCurrencyIds} from "@bananapus/core-v6/src/libraries/JBCurrencyIds.sol";
import {JBOmnichainDeployer} from "@bananapus/omnichain-deployers-v6/src/JBOmnichainDeployer.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IREVDeployer} from "@rev-net/core-v6/src/interfaces/IREVDeployer.sol";
import {IREVOwner} from "@rev-net/core-v6/src/interfaces/IREVOwner.sol";
import {Script} from "forge-std/Script.sol";

import {HomerunAllowlistHook} from "../../src/HomerunAllowlistHook.sol";
import {HomerunDeployer} from "../../src/HomerunDeployer.sol";
import {HomerunChainConfig} from "../../src/structs/HomerunChainConfig.sol";

import {HomerunDeploymentAddresses} from "../structs/HomerunDeploymentAddresses.sol";
import {HomerunImmutableReference} from "../structs/HomerunImmutableReference.sol";

/// @notice Shared, restartable Homerun deployment and verification logic.
/// @dev Only the canonical CREATE2 factory receives transactions. Runtime comparison masks only compiler-reported
/// immutable words, followed by explicit checks of every immutable binding.
abstract contract HomerunDeployment is Script {
    //*********************************************************************//
    // --------------------------- custom errors ------------------------- //
    //*********************************************************************//

    /// @notice A deployed contract has unexpected immutable dependencies or configuration.
    error HomerunDeployment_BindingMismatch(address target, string binding);

    /// @notice A protocol artifact belongs to a different chain than requested.
    error HomerunDeployment_ChainMismatch(string path, uint256 expected, uint256 actual);

    /// @notice The deterministic factory did not deploy code at the predicted address.
    error HomerunDeployment_DeploymentFailed(address predicted);

    /// @notice The compiler artifact has unsupported or inconsistent immutable or link data.
    error HomerunDeployment_InvalidArtifact(string name);

    /// @notice A required deployed contract has no runtime code.
    error HomerunDeployment_MissingCode(address target);

    /// @notice Deployed executable bytecode differs from the expected compiled artifact.
    error HomerunDeployment_RuntimeMismatch(address target, string name);

    /// @notice The connected chain is not part of a supported deployment group.
    error HomerunDeployment_UnsupportedChain(uint256 chainId);

    //*********************************************************************//
    // ------------------------- public constants ------------------------ //
    //*********************************************************************//

    /// @notice The canonical deterministic deployment proxy used throughout Juicebox V6.
    address public constant DETERMINISTIC_FACTORY = 0x4e59b44847b379578588920cA78FbF26c0B4956C;

    /// @notice The CREATE2 salt shared by the allowlist hook and the deployer.
    bytes32 public constant HOMERUN_SALT = "HomerunV6";

    //*********************************************************************//
    // ------------------------ private constants ------------------------ //
    //*********************************************************************//

    /// @notice The expected runtime hash of the canonical CREATE2 deployment proxy.
    /// @dev Checked before deployment and reuse so a matching address cannot substitute different factory behavior.
    bytes32 private constant _FACTORY_CODEHASH = keccak256(
        hex"7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3"
    );

    //*********************************************************************//
    // ---------------------- internal transactions ---------------------- //
    //*********************************************************************//

    /// @notice Deploys missing singletons, preserving and checking already deployed contracts.
    /// @param chains The verified per-chain protocol configuration for the connected chain's group, without hooks.
    /// @return deployed The complete deployment addresses.
    function _deploy(HomerunChainConfig[] memory chains) internal returns (HomerunDeploymentAddresses memory deployed) {
        // Refuse mismatched dependencies before predicting or sending any singleton deployment.
        _verifyProtocol(chains);
        _verifyFactory();
        deployed = _predict(chains);
        // Verify the hook before binding its address into the deployer's constructor arguments.
        _deployIfNeeded({name: "HomerunAllowlistHook", salt: HOMERUN_SALT, args: _hookArgs(chains)});
        _verifyHook({chains: chains, deployed: deployed});
        _deployIfNeeded({
            name: "HomerunDeployer", salt: HOMERUN_SALT, args: abi.encode(_configured(chains, deployed.allowlistHook))
        });
        _verify({chains: chains, deployed: deployed});
    }

    /// @notice Deploys a contract through the canonical factory if its predicted address has no code.
    /// @param name The compiled artifact name.
    /// @param salt The deployment salt.
    /// @param args The ABI-encoded constructor arguments.
    /// @return predicted The expected deployment address.
    function _deployIfNeeded(string memory name, bytes32 salt, bytes memory args) internal returns (address predicted) {
        // Include constructor arguments in the address prediction so every dependency binds the deployment.
        bytes memory initCode = abi.encodePacked(vm.getCode(string.concat(name, ".sol:", name)), args);
        predicted =
            vm.computeCreate2Address({salt: salt, initCodeHash: keccak256(initCode), deployer: DETERMINISTIC_FACTORY});
        if (predicted.code.length == 0) {
            // The canonical proxy accepts the salt followed directly by the complete creation code.
            (bool success,) = DETERMINISTIC_FACTORY.call(abi.encodePacked(salt, initCode));
            if (!success || predicted.code.length == 0) revert HomerunDeployment_DeploymentFailed(predicted);
        }
        // Existing code must match the artifact before a repeated run can reuse it.
        _verifyRuntime({name: name, target: predicted});
    }

    /// @notice Writes a manifest only after validating all deployed code and bindings.
    /// @dev A deployment simulation is deliberately a separate file from a read-only live verification.
    /// @param chains The per-chain protocol configuration, without hooks.
    /// @param deployed The deployed Homerun addresses.
    /// @param kind Either `simulation` or `verified`; callers define which state they inspected.
    function _writeManifest(
        HomerunChainConfig[] memory chains,
        HomerunDeploymentAddresses memory deployed,
        string memory kind
    )
        internal
    {
        // A manifest certifies the inspected state only after runtime and dependency checks succeed.
        _verify({chains: chains, deployed: deployed});
        HomerunChainConfig memory local = _local(chains);
        string memory key = string.concat("homerun-", vm.toString(block.chainid), "-", kind);
        vm.serializeString({objectKey: key, valueKey: "kind", value: kind});
        vm.serializeUint({objectKey: key, valueKey: "chainId", value: block.chainid});
        vm.serializeUint({objectKey: key, valueKey: "evmBlockNumber", value: block.number});
        vm.serializeUint({objectKey: key, valueKey: "timestamp", value: block.timestamp});
        // The grouped runner pins the fork to this RPC block, which can differ from the EVM height on Arbitrum.
        uint256 rpcBlockNumber = vm.envOr({name: "HOMERUN_RPC_BLOCK_NUMBER", defaultValue: uint256(0)});
        if (rpcBlockNumber != 0) {
            vm.serializeUint({objectKey: key, valueKey: "rpcBlockNumber", value: rpcBlockNumber});
            vm.serializeBytes32({
                objectKey: key, valueKey: "rpcBlockHash", value: vm.envBytes32("HOMERUN_RPC_BLOCK_HASH")
            });
        }
        vm.serializeBytes32({
            objectKey: key,
            valueKey: "evmParentBlockHash",
            value: block.number == 0 ? bytes32(0) : blockhash(block.number - 1)
        });
        vm.serializeString({
            objectKey: key,
            valueKey: "revision",
            value: vm.envOr({name: "HOMERUN_REVISION", defaultValue: string("unrecorded")})
        });
        _serializeContract({key: key, name: "create2Factory", target: DETERMINISTIC_FACTORY});
        _serializeContract({key: key, name: "revDeployer", target: local.revDeployer});
        _serializeContract({key: key, name: "omnichainDeployer", target: local.omnichainDeployer});
        _serializeContract({key: key, name: "usdc", target: local.usdc});
        _serializeContract({key: key, name: "allowlistHook", target: deployed.allowlistHook});
        _serializeContract({key: key, name: "deployer", target: deployed.deployer});
        string memory json = vm.serializeBytes32({objectKey: key, valueKey: "salt", value: HOMERUN_SALT});
        string memory directory = string.concat("deployments/", _network(block.chainid));
        vm.createDir({path: directory, recursive: true});
        vm.writeJson({json: json, path: string.concat(directory, "/", kind, ".json")});
    }

    //*********************************************************************//
    // ----------------------- internal views ---------------------------- //
    //*********************************************************************//

    /// @notice Loads the protocol artifacts of every chain in the connected chain's group from the workspace.
    /// @return chains The validated per-chain protocol configuration, without hooks.
    function _loadChains() internal view returns (HomerunChainConfig[] memory chains) {
        return _loadChainsFrom(vm.envOr({name: "HOMERUN_WORKSPACE_PATH", defaultValue: string("../..")}));
    }

    /// @notice Loads the protocol artifacts of every chain in the connected chain's group from a workspace.
    /// @dev The deployer's constructor calldata must be identical on every chain of a group, so every chain's
    /// artifacts are read on every chain. Only the connected chain's dependencies are checked live.
    /// @param workspace The directory containing the sibling protocol checkouts and their `deployments/` trees.
    /// @return chains The validated per-chain protocol configuration, without hooks.
    function _loadChainsFrom(string memory workspace) internal view returns (HomerunChainConfig[] memory chains) {
        // Bind grouped rehearsals and verification to the requested destination before selecting its artifacts.
        uint256 expectedChainId = vm.envOr({name: "HOMERUN_EXPECTED_CHAIN_ID", defaultValue: uint256(0)});
        if (expectedChainId != 0 && expectedChainId != block.chainid) {
            revert HomerunDeployment_ChainMismatch({path: "RPC", expected: expectedChainId, actual: block.chainid});
        }
        uint32[] memory group = _group(block.chainid);
        chains = new HomerunChainConfig[](group.length);
        for (uint256 i; i < group.length; i++) {
            string memory network = _network(group[i]);
            chains[i] = HomerunChainConfig({
                chainId: group[i],
                revDeployer: _readAddress({
                    path: string.concat(workspace, "/revnet-core-v6/deployments/", network, "/REVDeployer.json"),
                    chainId: group[i]
                }),
                usdc: _usdcOf(group[i]),
                omnichainDeployer: _readAddress({
                    path: string.concat(
                        workspace, "/nana-omnichain-deployers-v6/deployments/", network, "/JBOmnichainDeployer.json"
                    ),
                    chainId: group[i]
                }),
                allowlistHook: address(0)
            });
        }
        _verifyProtocol(chains);
    }

    /// @notice Maps supported chain IDs to the committed protocol artifact folder names.
    /// @param chainId The chain ID to resolve.
    /// @return network The artifact folder name.
    function _network(uint256 chainId) internal pure returns (string memory network) {
        if (chainId == 1) return "ethereum";
        if (chainId == 10) return "optimism";
        if (chainId == 8453) return "base";
        if (chainId == 42_161) return "arbitrum";
        if (chainId == 11_155_111) return "sepolia";
        if (chainId == 11_155_420) return "optimism_sepolia";
        if (chainId == 84_532) return "base_sepolia";
        if (chainId == 421_614) return "arbitrum_sepolia";
        revert HomerunDeployment_UnsupportedChain(chainId);
    }

    /// @notice The chains a deployment links, in ascending chain ID, for the group a chain belongs to.
    /// @param chainId The chain ID to resolve.
    /// @return group The chain IDs of the group.
    function _group(uint256 chainId) internal pure returns (uint32[] memory group) {
        group = new uint32[](4);
        if (chainId == 1 || chainId == 10 || chainId == 8453 || chainId == 42_161) {
            (group[0], group[1], group[2], group[3]) = (1, 10, 8453, 42_161);
        } else if (chainId == 11_155_111 || chainId == 11_155_420 || chainId == 84_532 || chainId == 421_614) {
            (group[0], group[1], group[2], group[3]) = (84_532, 421_614, 11_155_111, 11_155_420);
        } else {
            revert HomerunDeployment_UnsupportedChain(chainId);
        }
    }

    /// @notice Predicts every singleton.
    /// @param chains The per-chain protocol configuration, without hooks.
    /// @return deployed The predicted deployment addresses.
    function _predict(HomerunChainConfig[] memory chains)
        internal
        view
        returns (HomerunDeploymentAddresses memory deployed)
    {
        deployed.allowlistHook =
            _predictContract({name: "HomerunAllowlistHook", salt: HOMERUN_SALT, args: _hookArgs(chains)});
        deployed.deployer = _predictContract({
            name: "HomerunDeployer", salt: HOMERUN_SALT, args: abi.encode(_configured(chains, deployed.allowlistHook))
        });
    }

    /// @notice Checks a complete deployment against current compilation and all intended immutable settings.
    /// @param chains The per-chain protocol configuration, without hooks.
    /// @param deployed The expected Homerun addresses.
    function _verify(HomerunChainConfig[] memory chains, HomerunDeploymentAddresses memory deployed) internal view {
        _verifyProtocol(chains);
        _verifyFactory();
        if (keccak256(abi.encode(deployed)) != keccak256(abi.encode(_predict(chains)))) {
            revert HomerunDeployment_BindingMismatch({target: deployed.deployer, binding: "CREATE2 predictions"});
        }
        _verifyHook({chains: chains, deployed: deployed});
        _verifyRuntime({name: "HomerunDeployer", target: deployed.deployer});
        HomerunChainConfig memory local = _local(chains);
        HomerunDeployer deployer = HomerunDeployer(deployed.deployer);
        IREVDeployer revDeployer = IREVDeployer(local.revDeployer);
        IJBController controller = revDeployer.CONTROLLER();
        if (
            address(deployer.CONTROLLER()) != address(controller)
                || address(deployer.PROJECTS()) != address(controller.PROJECTS())
                || address(deployer.TOKENS()) != address(controller.TOKENS())
                || address(deployer.REV_DEPLOYER()) != local.revDeployer
                || address(deployer.REV_OWNER()) != revDeployer.OWNER()
                || address(deployer.TERMINAL()) != address(revDeployer.MULTI_TERMINAL())
                || deployer.USDC() != local.usdc || address(deployer.OMNICHAIN_DEPLOYER()) != local.omnichainDeployer
                || address(deployer.ROUTER_TERMINAL_REGISTRY()) != address(revDeployer.ROUTER_TERMINAL_REGISTRY())
                || address(deployer.ALLOWLIST_HOOK()) != deployed.allowlistHook
                || deployer.trustedForwarder() != _forwarderOf(chains)
        ) revert HomerunDeployment_BindingMismatch({target: deployed.deployer, binding: "deployer dependencies"});
        for (uint256 i; i < chains.length; i++) {
            if (deployer.usdcOf(chains[i].chainId) != chains[i].usdc) {
                revert HomerunDeployment_BindingMismatch({target: deployed.deployer, binding: "usdcOf"});
            }
        }
    }

    /// @notice Validates the connected chain's protocol dependencies and their shared core bindings.
    /// @param chains The per-chain protocol configuration.
    function _verifyProtocol(HomerunChainConfig[] memory chains) internal view {
        uint32[] memory group = _group(block.chainid);
        if (chains.length != group.length) revert HomerunDeployment_UnsupportedChain(block.chainid);
        for (uint256 i; i < chains.length; i++) {
            if (chains[i].chainId != group[i] || chains[i].usdc == address(0)) {
                revert HomerunDeployment_BindingMismatch({target: chains[i].usdc, binding: "group order and USDC"});
            }
        }
        HomerunChainConfig memory local = _local(chains);
        _requireCode(local.revDeployer);
        _requireCode(local.omnichainDeployer);
        _requireCode(local.usdc);
        IREVDeployer revDeployer = IREVDeployer(local.revDeployer);
        IJBController controller = revDeployer.CONTROLLER();
        IJBDirectory directory = controller.DIRECTORY();
        JBOmnichainDeployer omnichainDeployer = JBOmnichainDeployer(local.omnichainDeployer);
        _requireCode(address(controller));
        _requireCode(address(directory));
        _requireCode(address(controller.PROJECTS()));
        _requireCode(address(controller.TOKENS()));
        _requireCode(revDeployer.OWNER());
        _requireCode(address(revDeployer.MULTI_TERMINAL()));
        _requireCode(address(revDeployer.ROUTER_TERMINAL_REGISTRY()));
        _requireCode(address(revDeployer.SUCKER_REGISTRY()));
        _requireCode(omnichainDeployer.trustedForwarder());
        if (
            !directory.isAllowedToSetFirstController(address(controller))
                || address(IREVOwner(revDeployer.OWNER()).deployer()) != local.revDeployer
                || address(revDeployer.DIRECTORY()) != address(directory)
                || address(omnichainDeployer.CONTROLLER()) != address(controller)
                || address(omnichainDeployer.DIRECTORY()) != address(directory)
                || address(omnichainDeployer.SUCKER_REGISTRY()) != address(revDeployer.SUCKER_REGISTRY())
                || IERC20Metadata(local.usdc).decimals() != 6
        ) revert HomerunDeployment_BindingMismatch({target: local.revDeployer, binding: "protocol dependencies"});
        // Every FUND and INCOME mints against USD through this feed; without it no project launched here can be paid.
        // forge-lint: disable-next-line(unsafe-typecast)
        try controller.PRICES().pricePerUnitOf(0, uint32(uint160(local.usdc)), JBCurrencyIds.USD, 6) returns (
            uint256 price
        ) {
            if (price == 0) revert HomerunDeployment_BindingMismatch({target: local.usdc, binding: "USD price feed"});
        } catch {
            revert HomerunDeployment_BindingMismatch({target: local.usdc, binding: "USD price feed"});
        }
    }

    /// @notice Checks exact compiled runtime, masking only compiler-declared immutable words.
    /// @dev Callers separately check every immutable value; runtime equality alone is insufficient.
    /// @param name The compiled artifact name.
    /// @param target The deployed contract to inspect.
    function _verifyRuntime(string memory name, address target) internal view {
        // Compare compiled executable bytes while accounting for constructor-patched immutable values.
        _requireCode(target);
        string memory artifact = string.concat("out/", name, ".sol/", name, ".json");
        string memory json = vm.readFile(artifact);
        bytes memory expected = vm.getDeployedCode(artifact);
        bytes memory actual = target.code;
        if (expected.length != actual.length) revert HomerunDeployment_RuntimeMismatch({target: target, name: name});
        string memory root = ".deployedBytecode.immutableReferences";
        string[] memory keys = vm.parseJsonKeys({json: json, key: root});
        // Fail closed when future source changes add an immutable without adding its binding check.
        if (keys.length != _immutableCount(name)) revert HomerunDeployment_InvalidArtifact(name);
        for (uint256 i; i < keys.length; i++) {
            HomerunImmutableReference[] memory refs = abi.decode(
                vm.parseJson({json: json, key: string.concat(root, ".", keys[i])}), (HomerunImmutableReference[])
            );
            if (refs.length == 0) revert HomerunDeployment_InvalidArtifact(name);
            bytes32 immutableWord;
            for (uint256 j; j < refs.length; j++) {
                if (refs[j].length != 32 || refs[j].start + refs[j].length > actual.length) {
                    revert HomerunDeployment_InvalidArtifact(name);
                }
                // Every occurrence of one immutable must agree, including uses outside its public getter.
                bytes32 word = _word({code: actual, start: refs[j].start});
                if (j == 0) immutableWord = word;
                else if (word != immutableWord) revert HomerunDeployment_RuntimeMismatch({target: target, name: name});
                for (uint256 k; k < refs[j].length; k++) {
                    expected[refs[j].start + k] = 0;
                    actual[refs[j].start + k] = 0;
                }
            }
        }
        if (keccak256(actual) != keccak256(expected)) {
            revert HomerunDeployment_RuntimeMismatch({target: target, name: name});
        }
    }

    //*********************************************************************//
    // ----------------------- private helpers --------------------------- //
    //*********************************************************************//

    /// @notice Copies a configuration with every chain's hook set.
    /// @param chains The per-chain protocol configuration, without hooks.
    /// @param hook The allowlist hook, identical on every chain.
    /// @return configured The deployer's constructor argument.
    function _configured(
        HomerunChainConfig[] memory chains,
        address hook
    )
        private
        pure
        returns (HomerunChainConfig[] memory configured)
    {
        configured = new HomerunChainConfig[](chains.length);
        for (uint256 i; i < chains.length; i++) {
            configured[i] = chains[i];
            configured[i].allowlistHook = hook;
        }
    }

    /// @notice The trusted forwarder of the connected chain's omnichain deployer.
    /// @param chains The per-chain protocol configuration.
    /// @return forwarder The trusted forwarder.
    function _forwarderOf(HomerunChainConfig[] memory chains) private view returns (address forwarder) {
        return JBOmnichainDeployer(_local(chains).omnichainDeployer).trustedForwarder();
    }

    /// @notice The allowlist hook's constructor arguments.
    /// @param chains The per-chain protocol configuration.
    /// @return args The ABI-encoded constructor arguments.
    function _hookArgs(HomerunChainConfig[] memory chains) internal view returns (bytes memory args) {
        return abi.encode(IREVDeployer(_local(chains).revDeployer).CONTROLLER().PROJECTS(), _forwarderOf(chains));
    }

    /// @notice The number of immutable bindings explicitly checked for each deployment artifact.
    /// @param name The compiled artifact name.
    /// @return count The expected number of distinct compiler immutable groups.
    function _immutableCount(string memory name) private pure returns (uint256 count) {
        bytes32 nameHash = keccak256(bytes(name));
        if (nameHash == keccak256("HomerunAllowlistHook")) return 2;
        if (nameHash == keccak256("HomerunDeployer")) return 11;
        revert HomerunDeployment_InvalidArtifact(name);
    }

    /// @notice The connected chain's entry.
    /// @param chains The per-chain protocol configuration.
    /// @return local The connected chain's entry.
    function _local(HomerunChainConfig[] memory chains) private view returns (HomerunChainConfig memory local) {
        for (uint256 i; i < chains.length; i++) {
            if (chains[i].chainId == block.chainid) return chains[i];
        }
        revert HomerunDeployment_UnsupportedChain(block.chainid);
    }

    /// @notice Predicts a contract's canonical CREATE2 address.
    /// @param name The compiled artifact name.
    /// @param salt The salt.
    /// @param args The constructor arguments.
    /// @return predicted The resulting address.
    function _predictContract(
        string memory name,
        bytes32 salt,
        bytes memory args
    )
        private
        view
        returns (address predicted)
    {
        return vm.computeCreate2Address({
            salt: salt,
            initCodeHash: keccak256(abi.encodePacked(vm.getCode(string.concat(name, ".sol:", name)), args)),
            deployer: DETERMINISTIC_FACTORY
        });
    }

    /// @notice Reads an artifact address only if its recorded chain matches the requested chain.
    /// @param path The artifact path.
    /// @param chainId The chain the artifact must belong to.
    /// @return target The recorded deployed address.
    function _readAddress(string memory path, uint256 chainId) private view returns (address target) {
        string memory json = vm.readFile(path);
        uint256 recorded = vm.parseJsonUint({json: json, key: ".chainId"});
        if (recorded != chainId) {
            revert HomerunDeployment_ChainMismatch({path: path, expected: chainId, actual: recorded});
        }
        target = vm.parseJsonAddress({json: json, key: ".address"});
        if (target == address(0)) revert HomerunDeployment_MissingCode(target);
    }

    /// @notice Rejects absent dependencies.
    /// @param target The expected contract address.
    function _requireCode(address target) private view {
        if (target.code.length == 0) revert HomerunDeployment_MissingCode(target);
    }

    /// @notice Records an address and its complete live runtime hash in a manifest.
    /// @param key The manifest object key.
    /// @param name The manifest field prefix.
    /// @param target The contract to record.
    function _serializeContract(string memory key, string memory name, address target) private {
        vm.serializeAddress({objectKey: key, valueKey: name, value: target});
        vm.serializeBytes32({objectKey: key, valueKey: string.concat(name, "Codehash"), value: target.codehash});
    }

    /// @notice The canonical USDC token on a supported chain.
    /// @dev Matches deploy-all-v6's `JBChainTokens`.
    /// @param chainId The chain to look up.
    /// @return usdc The USDC token.
    function _usdcOf(uint256 chainId) private pure returns (address usdc) {
        if (chainId == 1) return 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
        if (chainId == 10) return 0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85;
        if (chainId == 8453) return 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
        if (chainId == 42_161) return 0xaf88d065e77c8cC2239327C5EDb3A432268e5831;
        if (chainId == 11_155_111) return 0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238;
        if (chainId == 11_155_420) return 0x5fd84259d66Cd46123540766Be93DFE6D43130D7;
        if (chainId == 84_532) return 0x036CbD53842c5426634e7929541eC2318f3dCF7e;
        if (chainId == 421_614) return 0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d;
        revert HomerunDeployment_UnsupportedChain(chainId);
    }

    /// @notice Verifies the hook's runtime and immutable bindings.
    /// @param chains The per-chain protocol configuration.
    /// @param deployed The predicted Homerun addresses.
    function _verifyHook(HomerunChainConfig[] memory chains, HomerunDeploymentAddresses memory deployed) private view {
        _verifyRuntime({name: "HomerunAllowlistHook", target: deployed.allowlistHook});
        HomerunAllowlistHook hook = HomerunAllowlistHook(deployed.allowlistHook);
        IJBProjects projects = IREVDeployer(_local(chains).revDeployer).CONTROLLER().PROJECTS();
        if (address(hook.PROJECTS()) != address(projects) || hook.trustedForwarder() != _forwarderOf(chains)) {
            revert HomerunDeployment_BindingMismatch({target: deployed.allowlistHook, binding: "hook dependencies"});
        }
    }

    /// @notice Checks the canonical factory's exact runtime before making or trusting any deployments.
    function _verifyFactory() private view {
        if (DETERMINISTIC_FACTORY.codehash != _FACTORY_CODEHASH) {
            revert HomerunDeployment_RuntimeMismatch({target: DETERMINISTIC_FACTORY, name: "canonical CREATE2 factory"});
        }
    }

    /// @notice Reads an already range-checked word.
    /// @param code The bytecode.
    /// @param start The word's offset.
    /// @return word The value.
    function _word(bytes memory code, uint256 start) private pure returns (bytes32 word) {
        assembly ("memory-safe") {
            word := mload(add(add(code, 0x20), start))
        }
    }
}
