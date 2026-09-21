// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {TestBaseWorkflow} from "@bananapus/core-v6/test/helpers/TestBaseWorkflow.sol";
import {IJBTerminal} from "@bananapus/core-v6/src/interfaces/IJBTerminal.sol";
import {JBRuleset} from "@bananapus/core-v6/src/structs/JBRuleset.sol";
import {JBRulesetMetadata} from "@bananapus/core-v6/src/structs/JBRulesetMetadata.sol";
import {IJBPrices} from "@bananapus/core-v6/src/interfaces/IJBPrices.sol";
import {JBCurrencyIds} from "@bananapus/core-v6/src/libraries/JBCurrencyIds.sol";
import {JBMatchingPriceFeed} from "@bananapus/core-v6/src/periphery/JBMatchingPriceFeed.sol";
import {JBOmnichainDeployer} from "@bananapus/omnichain-deployers-v6/src/JBOmnichainDeployer.sol";
import {JBSuckerRegistry} from "@bananapus/suckers-v6/src/JBSuckerRegistry.sol";
import {JB721TiersHookStore} from "@bananapus/721-hook-v6/src/JB721TiersHookStore.sol";
import {JB721TiersHook} from "@bananapus/721-hook-v6/src/JB721TiersHook.sol";
import {JB721TiersHookDeployer} from "@bananapus/721-hook-v6/src/JB721TiersHookDeployer.sol";
import {JB721CheckpointsDeployer} from "@bananapus/721-hook-v6/src/JB721CheckpointsDeployer.sol";
import {JBAddressRegistry} from "@bananapus/address-registry-v6/src/JBAddressRegistry.sol";
import {JBBuybackHookRegistry} from "@bananapus/buyback-hook-v6/src/JBBuybackHookRegistry.sol";
import {CTPublisher} from "@croptop/core-v6/src/CTPublisher.sol";
import {REVDeployer} from "@rev-net/core-v6/src/REVDeployer.sol";
import {REVOwner} from "@rev-net/core-v6/src/REVOwner.sol";
import {REVLoans} from "@rev-net/core-v6/src/REVLoans.sol";
import {JBRouterTerminalRegistry} from "@bananapus/router-terminal-v6/src/JBRouterTerminalRegistry.sol";

import {HomerunDeployment} from "../../script/helpers/HomerunDeployment.sol";
import {HomerunDeploymentAddresses} from "../../script/structs/HomerunDeploymentAddresses.sol";
import {HomerunImmutableReference} from "../../script/structs/HomerunImmutableReference.sol";
import {HomerunAllowlistHook} from "../../src/HomerunAllowlistHook.sol";
import {HomerunDeployer} from "../../src/HomerunDeployer.sol";
import {HomerunChainConfig} from "../../src/structs/HomerunChainConfig.sol";
import {HomerunDeploymentHarness} from "./HomerunDeploymentHarness.sol";

/// @notice Tests the production deployment helper against real protocol contracts, without live network writes.
contract HomerunDeploymentTest is TestBaseWorkflow {
    address private constant FORWARDER = address(0x500);
    address private constant OWNER = address(0x700);
    address private constant MAINNET_USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    string private constant FACTORY_CODE =
        "7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3";

    HomerunDeploymentHarness internal _deployment;
    HomerunChainConfig[] internal _chains;
    REVDeployer internal _revDeployer;
    JBOmnichainDeployer internal _omnichain;
    JBRouterTerminalRegistry internal _router;

    function setUp() public override {
        super.setUp();
        vm.warp(1_800_000_000);
        vm.roll(100);
        vm.chainId(1);
        _deployment = new HomerunDeploymentHarness();
        vm.etch(_deployment.DETERMINISTIC_FACTORY(), vm.parseBytes(FACTORY_CODE));
        // The deployer binds the canonical USDC of the connected chain; give that address the fixture's 6-decimal
        // token.
        vm.etch(MAINNET_USDC, address(usdcToken()).code);
        // The deployment checks that the trusted forwarder is a contract, as the live one is.
        vm.etch(FORWARDER, hex"00");
        // Every supported chain prices USDC against USD in JBPrices; the deployment refuses a chain that does not.
        JBMatchingPriceFeed feed = new JBMatchingPriceFeed();
        vm.prank(multisig());
        jbPrices().addPriceFeedFor(0, JBCurrencyIds.USD, uint32(uint160(MAINNET_USDC)), feed);

        uint256 feeProjectId = jbProjects().createFor(multisig());
        JBSuckerRegistry suckers =
            new JBSuckerRegistry(jbDirectory(), jbPermissions(), jbPrices(), multisig(), FORWARDER);
        JBBuybackHookRegistry buyback = new JBBuybackHookRegistry(jbPermissions(), jbProjects(), multisig(), FORWARDER);
        REVLoans loans = new REVLoans({
            controller: jbController(),
            terminal: jbMultiTerminal(),
            suckerRegistry: suckers,
            revId: feeProjectId,
            owner: multisig(),
            permit2: permit2(),
            trustedForwarder: FORWARDER
        });
        REVOwner revOwner = new REVOwner(buyback, jbDirectory(), feeProjectId, suckers, loans, FORWARDER, address(this));
        _router = new JBRouterTerminalRegistry(jbPermissions(), jbProjects(), permit2(), multisig(), FORWARDER);
        JB721TiersHookDeployer hookDeployer = _hookDeployer();
        _revDeployer = new REVDeployer(
            jbController(),
            jbMultiTerminal(),
            IJBTerminal(address(_router)),
            suckers,
            feeProjectId,
            hookDeployer,
            new CTPublisher(jbDirectory(), jbPermissions(), feeProjectId, permit2(), FORWARDER),
            buyback,
            loans,
            FORWARDER,
            address(revOwner)
        );
        revOwner.setDeployer(_revDeployer);
        _omnichain = JBOmnichainDeployer(
            deployCode(
                "JBOmnichainDeployer.sol:JBOmnichainDeployer",
                abi.encode(suckers, hookDeployer, jbPermissions(), jbController(), FORWARDER)
            )
        );
        uint32[] memory group = _deployment.group(1);
        for (uint256 i; i < group.length; i++) {
            _chains.push(
                HomerunChainConfig({
                    chainId: group[i],
                    controller: address(jbController()),
                    revDeployer: address(_revDeployer),
                    usdc: _usdcOf(group[i]),
                    omnichainDeployer: address(_omnichain),
                    routerTerminalRegistry: address(_router),
                    allowlistHook: address(0)
                })
            );
        }
    }

    function test_cleanDeploymentAndRepeatPreserveEveryAddress() public {
        HomerunDeploymentAddresses memory predicted = _deployment.predict(_chains);
        assertEq(predicted.deployer.code.length, 0);
        HomerunDeploymentAddresses memory first = _deployment.deployFor(_chains);
        assertEq(keccak256(abi.encode(first)), keccak256(abi.encode(predicted)));
        bytes32 firstHash = first.deployer.codehash;
        vm.recordLogs();
        HomerunDeploymentAddresses memory second = _deployment.deployFor(_chains);
        assertEq(vm.getRecordedLogs().length, 0, "repeat creates no contracts or transactions with logs");
        assertEq(keccak256(abi.encode(first)), keccak256(abi.encode(second)));
        assertEq(second.deployer.codehash, firstHash);
        _deployment.verify(_chains, second);
    }

    function test_partialDeploymentResumesWithoutReplacingHook() public {
        _deployment.deployHookOnly(_chains);
        HomerunDeploymentAddresses memory predicted = _deployment.predict(_chains);
        bytes32 hookHash = predicted.allowlistHook.codehash;
        assertGt(predicted.allowlistHook.code.length, 0);
        assertEq(predicted.deployer.code.length, 0);
        HomerunDeploymentAddresses memory resumed = _deployment.deployFor(_chains);
        assertEq(resumed.allowlistHook.codehash, hookHash);
        _deployment.verify(_chains, resumed);
    }

    function test_deployedFactoryLaunchesFundWithCanonicalHookAndRegistryBindings() public {
        HomerunDeploymentAddresses memory deployed = _deployment.deployFor(_chains);
        HomerunDeployer factory = HomerunDeployer(deployed.deployer);
        uint256 fee = jbProjects().creationFee();
        vm.deal(address(this), fee);
        (uint256 projectId, address token) = factory.launchFundFor{value: fee}({
            owner: OWNER,
            projectUri: "ipfs://deployment-rehearsal",
            name: "Deployment rehearsal",
            ticker: "FUND",
            mustStartAtOrAfter: 0,
            salt: bytes32(0),
            peerSuckerDeployers: new address[](0)
        });
        assertTrue(factory.isFund(projectId));
        assertEq(jbProjects().ownerOf(projectId), OWNER);
        assertEq(address(jbTokens().tokenOf(projectId)), token);
        (JBRuleset memory ruleset, JBRulesetMetadata memory metadata) = jbController().currentRulesetOf(projectId);
        assertEq(metadata.dataHook, address(_omnichain));
        assertEq(address(_omnichain.extraDataHookOf(projectId, ruleset.id).dataHook), deployed.allowlistHook);
        assertFalse(HomerunAllowlistHook(deployed.allowlistHook).canPay(projectId, OWNER));
        IJBTerminal[] memory terminals = jbDirectory().terminalsOf(projectId);
        assertEq(terminals.length, 2);
        assertEq(address(terminals[1]), address(_router));
        _deployment.verify(_chains, deployed);
    }

    function test_sameArtifactsAndBindingsPredictSameAddressesOnEveryChainOfTheGroup() public {
        bytes32 expected = keccak256(abi.encode(_deployment.predict(_chains)));
        uint32[] memory group = _deployment.group(1);
        for (uint256 i; i < group.length; i++) {
            vm.chainId(group[i]);
            assertEq(keccak256(abi.encode(_deployment.predict(_chains))), expected);
        }
    }

    function test_rejectsWrongCanonicalFactoryRuntime() public {
        vm.etch(_deployment.DETERMINISTIC_FACTORY(), hex"00");
        vm.expectPartialRevert(HomerunDeployment.HomerunDeployment_RuntimeMismatch.selector);
        _deployment.deployFor(_chains);
    }

    function test_rejectsMismatchedExistingOpcode() public {
        HomerunDeploymentAddresses memory deployed = _deployment.deployFor(_chains);
        bytes memory code = deployed.deployer.code;
        code[0] = bytes1(uint8(code[0]) ^ 1);
        vm.etch(deployed.deployer, code);
        vm.expectPartialRevert(HomerunDeployment.HomerunDeployment_RuntimeMismatch.selector);
        _deployment.deployFor(_chains);
    }

    function test_rejectsOneInconsistentImmutableOccurrence() public {
        HomerunDeploymentAddresses memory deployed = _deployment.deployFor(_chains);
        string memory json = vm.readFile("out/HomerunDeployer.sol/HomerunDeployer.json");
        string memory root = ".deployedBytecode.immutableReferences";
        string[] memory keys = vm.parseJsonKeys(json, root);
        bool mutated;
        for (uint256 i; i < keys.length; i++) {
            HomerunImmutableReference[] memory refs =
                abi.decode(vm.parseJson(json, string.concat(root, ".", keys[i])), (HomerunImmutableReference[]));
            if (refs.length < 2) continue;
            bytes memory code = deployed.deployer.code;
            code[refs[1].start + 31] = bytes1(uint8(code[refs[1].start + 31]) ^ 1);
            vm.etch(deployed.deployer, code);
            mutated = true;
            break;
        }
        assertTrue(mutated, "fixture must modify a repeated immutable");
        vm.expectPartialRevert(HomerunDeployment.HomerunDeployment_RuntimeMismatch.selector);
        _deployment.verifyRuntime("HomerunDeployer", deployed.deployer);
    }

    function test_rejectsConsistentlyWrongImmutableDependency() public {
        HomerunDeploymentAddresses memory deployed = _deployment.deployFor(_chains);
        // A legitimate second deployer, linked to the same library, has identical opcodes and a different protocol
        // configuration hash.
        HomerunChainConfig[] memory other = new HomerunChainConfig[](1);
        other[0] = _chains[0];
        other[0].allowlistHook = deployed.allowlistHook;
        address different = _deployment.deployVariant(other, "variant");
        vm.etch(deployed.deployer, different.code);
        _deployment.verifyRuntime("HomerunDeployer", deployed.deployer);
        vm.expectPartialRevert(HomerunDeployment.HomerunDeployment_BindingMismatch.selector);
        _deployment.deployFor(_chains);
    }

    function test_rejectsHookWithDifferentForwarder() public {
        HomerunDeploymentAddresses memory deployed = _deployment.deployFor(_chains);
        HomerunAllowlistHook different = new HomerunAllowlistHook(jbProjects(), address(0xbeef));
        vm.etch(deployed.allowlistHook, address(different).code);
        _deployment.verifyRuntime("HomerunAllowlistHook", deployed.allowlistHook);
        vm.expectPartialRevert(HomerunDeployment.HomerunDeployment_BindingMismatch.selector);
        _deployment.deployFor(_chains);
    }

    function test_rejectsMissingProtocolCodeBeforeAnyDeployment() public {
        vm.etch(address(_revDeployer), hex"");
        vm.expectPartialRevert(HomerunDeployment.HomerunDeployment_MissingCode.selector);
        _deployment.deployFor(_chains);
        assertEq(_deployment.predict(_chains).allowlistHook.code.length, 0);
    }

    function test_rejectsWrongProtocolBindingBeforeAnyDeployment() public {
        vm.mockCall(address(_revDeployer), abi.encodeWithSignature("CONTROLLER()"), abi.encode(address(0xdead)));
        vm.expectPartialRevert(HomerunDeployment.HomerunDeployment_BindingMismatch.selector);
        _deployment.deployFor(_chains);
    }

    function test_rejectsControllerWithoutProjectLaunchAuthorization() public {
        vm.mockCall(
            address(jbDirectory()),
            abi.encodeWithSignature("isAllowedToSetFirstController(address)", address(jbController())),
            abi.encode(false)
        );
        vm.expectPartialRevert(HomerunDeployment.HomerunDeployment_BindingMismatch.selector);
        _deployment.deployFor(_chains);
    }

    function test_rejectsNonUsdcAccountingToken() public {
        vm.mockCall(MAINNET_USDC, abi.encodeWithSignature("decimals()"), abi.encode(uint8(18)));
        vm.expectPartialRevert(HomerunDeployment.HomerunDeployment_BindingMismatch.selector);
        _deployment.deployFor(_chains);
    }

    function test_rejectsChainWithoutUsdPriceFeed() public {
        vm.mockCallRevert(address(jbPrices()), abi.encodeWithSelector(IJBPrices.pricePerUnitOf.selector), "");
        vm.expectPartialRevert(HomerunDeployment.HomerunDeployment_BindingMismatch.selector);
        _deployment.deployFor(_chains);
        assertEq(_deployment.predict(_chains).allowlistHook.code.length, 0);
    }

    function test_rejectsChainsOutsideTheConnectedGroup() public {
        vm.chainId(11_155_111);
        vm.expectPartialRevert(HomerunDeployment.HomerunDeployment_BindingMismatch.selector);
        _deployment.deployFor(_chains);
    }

    function test_allNetworkFoldersMatchCurrentProtocolLayout() public view {
        assertEq(_deployment.network(1), "ethereum");
        assertEq(_deployment.network(10), "optimism");
        assertEq(_deployment.network(8453), "base");
        assertEq(_deployment.network(42_161), "arbitrum");
        assertEq(_deployment.network(11_155_111), "sepolia");
        assertEq(_deployment.network(11_155_420), "optimism_sepolia");
        assertEq(_deployment.network(84_532), "base_sepolia");
        assertEq(_deployment.network(421_614), "arbitrum_sepolia");
    }

    function test_groupsAreAscendingAndDisjoint() public view {
        uint32[] memory mainnets = _deployment.group(1);
        uint32[] memory testnets = _deployment.group(84_532);
        assertEq(keccak256(abi.encode(mainnets)), keccak256(abi.encode(_deployment.group(42_161))));
        assertEq(keccak256(abi.encode(testnets)), keccak256(abi.encode(_deployment.group(11_155_420))));
        for (uint256 i = 1; i < mainnets.length; i++) {
            assertLt(mainnets[i - 1], mainnets[i]);
            assertLt(testnets[i - 1], testnets[i]);
        }
    }

    function test_rejectsUnsupportedChain() public {
        vm.expectPartialRevert(HomerunDeployment.HomerunDeployment_UnsupportedChain.selector);
        _deployment.network(31_337);
        vm.expectPartialRevert(HomerunDeployment.HomerunDeployment_UnsupportedChain.selector);
        _deployment.group(31_337);
    }

    function test_loadsEveryChainOfTheGroupFromTheWorkspace() public {
        string memory root = _writeWorkspace({group: _deployment.group(1), chainIdOffset: 0});
        HomerunChainConfig[] memory loaded = _deployment.loadChains(root);
        assertEq(loaded.length, _chains.length);
        for (uint256 i; i < loaded.length; i++) {
            assertEq(keccak256(abi.encode(loaded[i])), keccak256(abi.encode(_chains[i])));
        }
    }

    function test_rejectsWrongRpcChainBeforeReadingArtifacts() public {
        vm.chainId(10);
        vm.setEnv("HOMERUN_EXPECTED_CHAIN_ID", "1");
        vm.expectRevert(
            abi.encodeWithSelector(
                HomerunDeployment.HomerunDeployment_ChainMismatch.selector, "RPC", uint256(1), uint256(10)
            )
        );
        _deployment.loadChains("deployments/_missing");
        vm.setEnv("HOMERUN_EXPECTED_CHAIN_ID", "0");
    }

    function test_rejectsWrongArtifactChain() public {
        string memory root = _writeWorkspace({group: _deployment.group(1), chainIdOffset: 1});
        vm.expectPartialRevert(HomerunDeployment.HomerunDeployment_ChainMismatch.selector);
        _deployment.loadChains(root);
    }

    function test_manifestRecordsAllRuntimeHashesAndRpcBlock() public {
        vm.setEnv("HOMERUN_RPC_BLOCK_NUMBER", "1000");
        bytes32 rpcBlockHash = keccak256("canonical RPC block");
        vm.setEnv("HOMERUN_RPC_BLOCK_HASH", vm.toString(rpcBlockHash));
        HomerunDeploymentAddresses memory deployed = _deployment.deployFor(_chains);
        _deployment.writeManifest(_chains, deployed);
        string memory json = vm.readFile("deployments/ethereum/test.json");
        assertEq(vm.parseJsonAddress(json, ".deployer"), deployed.deployer);
        assertEq(vm.parseJsonBytes32(json, ".allowlistHookCodehash"), deployed.allowlistHook.codehash);
        assertEq(vm.parseJsonBytes32(json, ".deployerCodehash"), deployed.deployer.codehash);
        assertEq(
            vm.parseJsonBytes32(json, ".protocolConfigHash"), HomerunDeployer(deployed.deployer).PROTOCOL_CONFIG_HASH()
        );
        assertEq(vm.parseJsonUint(json, ".chainId"), 1);
        assertEq(vm.parseJsonUint(json, ".evmBlockNumber"), 100);
        assertEq(vm.parseJsonUint(json, ".rpcBlockNumber"), 1000);
        assertEq(vm.parseJsonBytes32(json, ".rpcBlockHash"), rpcBlockHash);
        assertEq(vm.parseJsonString(json, ".kind"), "test");
        vm.setEnv("HOMERUN_RPC_BLOCK_NUMBER", "0");
        vm.setEnv("HOMERUN_RPC_BLOCK_HASH", vm.toString(bytes32(0)));
    }

    function _hookDeployer() private returns (JB721TiersHookDeployer) {
        JB721TiersHookStore store = new JB721TiersHookStore();
        JB721TiersHook implementation = new JB721TiersHook(
            jbDirectory(),
            jbPermissions(),
            jbPrices(),
            jbRulesets(),
            store,
            jbSplits(),
            new JB721CheckpointsDeployer(store),
            FORWARDER
        );
        return new JB721TiersHookDeployer(implementation, store, new JBAddressRegistry(), FORWARDER);
    }

    function _usdcOf(uint32 chainId) private pure returns (address) {
        if (chainId == 1) return MAINNET_USDC;
        if (chainId == 10) return 0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85;
        if (chainId == 8453) return 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
        if (chainId == 42_161) return 0xaf88d065e77c8cC2239327C5EDb3A432268e5831;
        revert("unsupported fixture chain");
    }

    /// @dev Writes one artifact per protocol repository for every chain of the group, mirroring the workspace layout.
    function _writeWorkspace(uint32[] memory group, uint256 chainIdOffset) private returns (string memory root) {
        root = string.concat("deployments/_test/", vm.toString(block.chainid + chainIdOffset));
        for (uint256 i; i < group.length; i++) {
            string memory network = _deployment.network(group[i]);
            uint256 recorded = group[i] + chainIdOffset;
            _writeArtifact(root, "nana-core-v6", network, "JBController", address(jbController()), recorded);
            _writeArtifact(root, "revnet-core-v6", network, "REVDeployer", address(_revDeployer), recorded);
            _writeArtifact(
                root, "nana-omnichain-deployers-v6", network, "JBOmnichainDeployer", address(_omnichain), recorded
            );
            _writeArtifact(
                root, "nana-router-terminal-v6", network, "JBRouterTerminalRegistry", address(_router), recorded
            );
        }
    }

    function _writeArtifact(
        string memory root,
        string memory repo,
        string memory network,
        string memory name,
        address target,
        uint256 chainId
    )
        private
    {
        string memory directory = string.concat(root, "/", repo, "/deployments/", network);
        vm.createDir(directory, true);
        string memory key = string.concat("artifact-", repo, "-", network, "-", name);
        vm.serializeAddress(key, "address", target);
        string memory json = vm.serializeString(key, "chainId", vm.toString(bytes32(chainId)));
        vm.writeJson(json, string.concat(directory, "/", name, ".json"));
    }
}
