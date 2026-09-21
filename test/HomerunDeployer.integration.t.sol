// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {TestBaseWorkflow} from "@bananapus/core-v6/test/helpers/TestBaseWorkflow.sol";
import {JBPermissioned} from "@bananapus/core-v6/src/abstract/JBPermissioned.sol";
import {JBPermissionsData} from "@bananapus/core-v6/src/structs/JBPermissionsData.sol";
import {JBPermissionIds} from "@bananapus/permission-ids-v6/src/JBPermissionIds.sol";
import {JBRulesetConfig} from "@bananapus/core-v6/src/structs/JBRulesetConfig.sol";
import {JBRuleset} from "@bananapus/core-v6/src/structs/JBRuleset.sol";
import {JBRulesetMetadata} from "@bananapus/core-v6/src/structs/JBRulesetMetadata.sol";
import {JBTerminalConfig} from "@bananapus/core-v6/src/structs/JBTerminalConfig.sol";
import {JBAccountingContext} from "@bananapus/core-v6/src/structs/JBAccountingContext.sol";
import {JBSplit} from "@bananapus/core-v6/src/structs/JBSplit.sol";
import {JBSplitGroup} from "@bananapus/core-v6/src/structs/JBSplitGroup.sol";
import {JBSplitGroupIds} from "@bananapus/core-v6/src/libraries/JBSplitGroupIds.sol";
import {JBMetadataResolver} from "@bananapus/core-v6/src/libraries/JBMetadataResolver.sol";
import {IJBTerminal} from "@bananapus/core-v6/src/interfaces/IJBTerminal.sol";
import {IJBToken} from "@bananapus/core-v6/src/interfaces/IJBToken.sol";
import {JBERC20} from "@bananapus/core-v6/src/JBERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {JBMatchingPriceFeed} from "@bananapus/core-v6/src/periphery/JBMatchingPriceFeed.sol";
import {JBOmnichainDeployer} from "@bananapus/omnichain-deployers-v6/src/JBOmnichainDeployer.sol";
import {JBDeployerHookConfig} from "@bananapus/omnichain-deployers-v6/src/structs/JBDeployerHookConfig.sol";
import {JBSuckerDeploymentConfig} from "@bananapus/omnichain-deployers-v6/src/structs/JBSuckerDeploymentConfig.sol";
import {REVSuckerDeploymentConfig} from "@rev-net/core-v6/src/structs/REVSuckerDeploymentConfig.sol";
import {JBCCIPSuckerDeployer} from "@bananapus/suckers-v6/src/deployers/JBCCIPSuckerDeployer.sol";
import {JBCCIPSucker} from "@bananapus/suckers-v6/src/JBCCIPSucker.sol";
import {ICCIPRouter} from "@bananapus/suckers-v6/src/interfaces/ICCIPRouter.sol";
import {IJBSuckerDeployer} from "@bananapus/suckers-v6/src/interfaces/IJBSuckerDeployer.sol";
import {JBSuckerDeployerConfig} from "@bananapus/suckers-v6/src/structs/JBSuckerDeployerConfig.sol";
import {JBRemoteToken} from "@bananapus/suckers-v6/src/structs/JBRemoteToken.sol";
import {JBTokenMapping} from "@bananapus/suckers-v6/src/structs/JBTokenMapping.sol";
import {JBSuckerRegistry} from "@bananapus/suckers-v6/src/JBSuckerRegistry.sol";
import {JB721TiersHookStore} from "@bananapus/721-hook-v6/src/JB721TiersHookStore.sol";
import {JB721TiersHook} from "@bananapus/721-hook-v6/src/JB721TiersHook.sol";
import {JB721TiersHookDeployer} from "@bananapus/721-hook-v6/src/JB721TiersHookDeployer.sol";
import {JB721TiersHookProjectDeployer} from "@bananapus/721-hook-v6/src/JB721TiersHookProjectDeployer.sol";
import {JB721CheckpointsDeployer} from "@bananapus/721-hook-v6/src/JB721CheckpointsDeployer.sol";
import {JB721TierConfig} from "@bananapus/721-hook-v6/src/structs/JB721TierConfig.sol";
import {JB721TiersHookFlags} from "@bananapus/721-hook-v6/src/structs/JB721TiersHookFlags.sol";
import {JBDeploy721TiersHookConfig} from "@bananapus/721-hook-v6/src/structs/JBDeploy721TiersHookConfig.sol";
import {IJB721TiersHook} from "@bananapus/721-hook-v6/src/interfaces/IJB721TiersHook.sol";
import {JBQueueRulesetsConfig} from "@bananapus/721-hook-v6/src/structs/JBQueueRulesetsConfig.sol";
import {JBPayDataHookRulesetConfig} from "@bananapus/721-hook-v6/src/structs/JBPayDataHookRulesetConfig.sol";
import {JBPayDataHookRulesetMetadata} from "@bananapus/721-hook-v6/src/structs/JBPayDataHookRulesetMetadata.sol";
import {JBAddressRegistry} from "@bananapus/address-registry-v6/src/JBAddressRegistry.sol";
import {JBBuybackHookRegistry} from "@bananapus/buyback-hook-v6/src/JBBuybackHookRegistry.sol";
import {CTPublisher} from "@croptop/core-v6/src/CTPublisher.sol";
import {REVDeployer} from "@rev-net/core-v6/src/REVDeployer.sol";
import {REVOwner} from "@rev-net/core-v6/src/REVOwner.sol";
import {REVLoans} from "@rev-net/core-v6/src/REVLoans.sol";
import {REVConfig} from "@rev-net/core-v6/src/structs/REVConfig.sol";
import {REVStageConfig} from "@rev-net/core-v6/src/structs/REVStageConfig.sol";
import {REVAutoIssuance} from "@rev-net/core-v6/src/structs/REVAutoIssuance.sol";
import {REVDeploy721TiersHookConfig} from "@rev-net/core-v6/src/structs/REVDeploy721TiersHookConfig.sol";
import {REVCroptopAllowedPost} from "@rev-net/core-v6/src/structs/REVCroptopAllowedPost.sol";
import {REVDescription} from "@rev-net/core-v6/src/structs/REVDescription.sol";
import {JBRouterTerminalRegistry} from "@bananapus/router-terminal-v6/src/JBRouterTerminalRegistry.sol";
import {HomerunAllowlistHook} from "../src/HomerunAllowlistHook.sol";
import {HomerunDeployer} from "../src/HomerunDeployer.sol";
import {HomerunChainConfig} from "../src/structs/HomerunChainConfig.sol";
import {HomerunInitialIncomeAllocation} from "../src/structs/HomerunInitialIncomeAllocation.sol";
import {HomerunInitialIncomeSnapshot} from "../src/structs/HomerunInitialIncomeSnapshot.sol";

/// @notice Actual local Juicebox/Revnet deployment and reserved-token routing, with no mocked protocol calls.
/// @dev Uses the canonical registry's supported no-AMM fallback and a real fixed USD/USDC matching price feed.
contract HomerunDeployerIntegrationTest is TestBaseWorkflow {
    address private constant OPERATOR = address(0x100);
    address private constant ALICE = address(0x200);
    address private constant BOB = address(0x300);
    address private constant CUSTOMER = address(0x400);
    address private constant FORWARDER = address(0x500);
    address private constant OWNER = address(0x700);
    address private constant NEXT_OPERATOR = address(0x800);
    bytes32 private constant LAUNCH_SALT = bytes32(uint256(2));
    uint48 private constant STARTS_AT = 1_000_001;
    uint256 private _fundId;
    uint256 private _feeProjectId;
    uint256 private _beforeCcipSnapshot;
    REVDeployer private _revDeployer;
    REVOwner private _revOwner;
    REVLoans private _loans;
    JBSuckerRegistry private _suckers;
    JBOmnichainDeployer private _omnichain;
    JBCCIPSuckerDeployer private _ccipToEthereum;
    JBCCIPSuckerDeployer private _ccipToOptimism;
    JBRouterTerminalRegistry private _router;
    HomerunAllowlistHook private _allowlist;
    HomerunDeployer private _helper;
    JBERC20 private _fundToken;

    struct SnapshotFixture {
        HomerunInitialIncomeSnapshot snapshot;
        address[] holders;
        uint256[] balances;
        uint256[] allocations;
    }

    function setUp() public override {
        super.setUp();
        vm.warp(1_000_000);
        vm.roll(100);
        vm.chainId(1);
        uint256 feeProjectId = jbProjects().createFor(multisig());
        _feeProjectId = feeProjectId;
        _suckers = new JBSuckerRegistry(jbDirectory(), jbPermissions(), jbPrices(), multisig(), FORWARDER);
        JBBuybackHookRegistry buyback = new JBBuybackHookRegistry(jbPermissions(), jbProjects(), multisig(), FORWARDER);
        _loans = new REVLoans({
            controller: jbController(),
            terminal: jbMultiTerminal(),
            suckerRegistry: _suckers,
            revId: feeProjectId,
            owner: multisig(),
            permit2: permit2(),
            trustedForwarder: FORWARDER
        });
        _revOwner = new REVOwner(buyback, jbDirectory(), feeProjectId, _suckers, _loans, FORWARDER, address(this));
        _router = new JBRouterTerminalRegistry(jbPermissions(), jbProjects(), permit2(), multisig(), FORWARDER);
        _allowlist = new HomerunAllowlistHook(jbProjects(), FORWARDER);
        _revDeployer = new REVDeployer(
            jbController(),
            jbMultiTerminal(),
            IJBTerminal(address(_router)),
            _suckers,
            feeProjectId,
            _hookDeployer(),
            new CTPublisher(jbDirectory(), jbPermissions(), feeProjectId, permit2(), FORWARDER),
            buyback,
            _loans,
            FORWARDER,
            address(_revOwner)
        );
        _revOwner.setDeployer(_revDeployer);
        _omnichain = JBOmnichainDeployer(
            deployCode(
                "JBOmnichainDeployer.sol:JBOmnichainDeployer",
                abi.encode(_suckers, _hookDeployer(), jbPermissions(), jbController(), FORWARDER)
            )
        );
        _helper = new HomerunDeployer(_chainConfigs());
        JBMatchingPriceFeed matchingFeed = new JBMatchingPriceFeed();
        vm.prank(multisig());
        jbPrices().addPriceFeedFor(0, 2, uint32(uint160(address(usdcToken()))), matchingFeed);
        _createAndCloseFund();
        _beforeCcipSnapshot = vm.snapshotState();
        _ccipToOptimism = _ccipDeployer(10, feeProjectId);
    }

    function _ccipDeployer(uint32 remoteChainId, uint256 feeProjectId) private returns (JBCCIPSuckerDeployer deployer) {
        deployer = new JBCCIPSuckerDeployer(jbDirectory(), jbPermissions(), jbTokens(), address(this), FORWARDER);
        // Launch and token mapping do not send transport messages. This test contract is only a nonzero router
        // endpoint.
        deployer.setChainSpecificConstants(remoteChainId, uint64(remoteChainId), ICCIPRouter(address(this)));
        deployer.configureSingleton(
            new JBCCIPSucker(deployer, jbDirectory(), jbPermissions(), jbTokens(), feeProjectId, _suckers, FORWARDER)
        );
        vm.prank(multisig());
        _suckers.allowSuckerDeployer(address(deployer));
    }

    function _chainConfigs() private view returns (HomerunChainConfig[] memory chains) {
        chains = new HomerunChainConfig[](2);
        for (uint256 i; i < chains.length; ++i) {
            chains[i] = HomerunChainConfig({
                chainId: i == 0 ? 1 : 10,
                controller: address(jbController()),
                revDeployer: address(_revDeployer),
                usdc: address(usdcToken()),
                omnichainDeployer: address(_omnichain),
                routerTerminalRegistry: address(_router),
                allowlistHook: address(_allowlist)
            });
        }
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

    function _createAndCloseFund() private {
        uint256 fee = jbProjects().creationFee();
        vm.deal(OPERATOR, OPERATOR.balance + fee);
        vm.startPrank(OPERATOR);
        address fundToken;
        (_fundId, fundToken) = _helper.launchFundFor{value: fee}(
            OPERATOR, "ipfs://fund", "House FUND", "HOUSE", 0, bytes32(0), new address[](0)
        );
        _fundToken = JBERC20(fundToken);
        assertEq(address(jbTokens().tokenOf(_fundId)), fundToken);
        assertEq(_fundToken.name(), "House FUND");
        assertEq(_fundToken.symbol(), "HOUSE");
        assertEq(jbProjects().ownerOf(_fundId), OPERATOR);
        IJBTerminal[] memory terminals = jbDirectory().terminalsOf(_fundId);
        assertEq(terminals.length, 2);
        assertEq(address(terminals[1]), address(_router));
        // The owner closes the campaign the way Homerun's rule changes do: through the omnichain deployer.
        uint8[] memory permissionIds = new uint8[](1);
        permissionIds[0] = JBPermissionIds.QUEUE_RULESETS;
        jbPermissions()
            .setPermissionsFor(
                OPERATOR,
                JBPermissionsData({
                operator: address(_omnichain), projectId: uint64(_fundId), permissionIds: permissionIds
            })
            );
        (, JBRulesetMetadata memory metadata) = jbController().currentRulesetOf(_fundId);
        JBRulesetConfig[] memory rulesets = new JBRulesetConfig[](1);
        rulesets[0].weight = _helper.FUND_WEIGHT();
        rulesets[0].metadata = metadata;
        // Rule changes re-carry the allowlist as the extra hook; the omnichain deployer reinjects itself.
        rulesets[0].metadata.dataHook = address(_allowlist);
        rulesets[0].metadata.useDataHookForPay = true;
        rulesets[0].metadata.useDataHookForCashOut = false;
        rulesets[0].metadata.pausePay = true;
        rulesets[0].metadata.cashOutTaxRate = 10_000;
        rulesets[0].metadata.allowOwnerMinting = true;
        vm.warp(vm.getBlockTimestamp() + 1);
        _omnichain.queueRulesetsOf(_fundId, rulesets, "campaign closed");
        vm.warp(vm.getBlockTimestamp() + 1);
        jbController().mintTokensOf(_fundId, 100 ether, OPERATOR, "operator share after purchase", false);
        jbController().mintTokensOf(_fundId, 300 ether, ALICE, "offchain contribution after purchase", false);
        jbController().mintTokensOf(_fundId, 100 ether, BOB, "offchain contribution after purchase", false);
        rulesets[0].metadata.allowOwnerMinting = false;
        _omnichain.queueRulesetsOf(_fundId, rulesets, "success allocations complete");
        vm.stopPrank();
        vm.warp(block.timestamp + 1);
        vm.roll(block.number + 1);
    }

    function _holders() private pure returns (address[] memory holders) {
        holders = new address[](3);
        holders[0] = OPERATOR;
        holders[1] = ALICE;
        holders[2] = BOB;
    }

    function _deploy(uint16 reservedBps) private returns (uint256 incomeId) {
        return _deploySnapshot(reservedBps, _snapshot(_holders()));
    }

    function _deploySnapshot(uint16 reservedBps, SnapshotFixture memory fixture) private returns (uint256 incomeId) {
        return _deploySnapshotStarting(reservedBps, fixture, STARTS_AT);
    }

    function _deploySnapshotStarting(
        uint16 reservedBps,
        SnapshotFixture memory fixture,
        uint48 startsAtOrAfter
    )
        private
        returns (uint256 incomeId)
    {
        REVDescription memory description =
            REVDescription({name: "House income", ticker: "RENT", uri: "ipfs://income", salt: LAUNCH_SALT});
        REVSuckerDeploymentConfig memory suckers = _suckerConfig(fixture.snapshot);
        vm.prank(OPERATOR);
        incomeId = _helper.deployIncome(_fundId, fixture.snapshot, description, reservedBps, startsAtOrAfter, suckers);
    }

    function _suckerConfig(HomerunInitialIncomeSnapshot memory snapshot)
        private
        view
        returns (REVSuckerDeploymentConfig memory config)
    {
        config.salt = LAUNCH_SALT;
        config.deployerConfigurations = new JBSuckerDeployerConfig[](snapshot.allocations.length - 1);
        uint256 index;
        for (uint256 i; i < snapshot.allocations.length; ++i) {
            uint32 remote = snapshot.allocations[i].chainId;
            if (remote == block.chainid) continue;
            JBTokenMapping[] memory mappings = new JBTokenMapping[](1);
            mappings[0] = JBTokenMapping({
                localToken: address(usdcToken()),
                minGas: 200_000,
                remoteToken: bytes32(uint256(uint160(address(usdcToken()))))
            });
            config.deployerConfigurations[index++] = JBSuckerDeployerConfig({
                deployer: IJBSuckerDeployer(address(remote == 1 ? _ccipToEthereum : _ccipToOptimism)),
                peer: bytes32(0),
                mappings: mappings
            });
        }
    }

    /// @dev The published allocation the owner settles: every holder's balance and pro-rata share at the snapshot.
    function _snapshot(address[] memory holders) private returns (SnapshotFixture memory fixture) {
        fixture.holders = holders;
        fixture.balances = new uint256[](holders.length);
        fixture.allocations = new uint256[](holders.length);
        uint256 totalFundSupply = jbTokens().totalSupplyOf(_fundId);
        uint256 sum;
        for (uint256 i; i < holders.length; ++i) {
            fixture.balances[i] = jbTokens().totalBalanceOf(holders[i], _fundId);
            fixture.allocations[i] = fixture.balances[i] * 500_000 ether / totalFundSupply;
            sum += fixture.balances[i];
        }
        assertEq(sum, totalFundSupply, "fixture includes every FUND balance and credit");
        vm.roll(block.number + 1);
        bytes32 snapshotHash = keccak256(abi.encode(block.number - 1, holders, fixture.balances));
        vm.setBlockhash(block.number - 1, snapshotHash);
        HomerunInitialIncomeAllocation[] memory allocations = new HomerunInitialIncomeAllocation[](1);
        allocations[0] = HomerunInitialIncomeAllocation({
            chainId: uint32(block.chainid),
            fundProjectId: _fundId,
            snapshotBlockNumber: block.number - 1,
            snapshotBlockHash: snapshotHash,
            incomeAmount: 500_000 ether
        });
        fixture.snapshot = HomerunInitialIncomeSnapshot({
            sourceSetHash: keccak256(
                abi.encode(block.chainid, _fundId, block.number - 1, snapshotHash, totalFundSupply)
            ),
            totalFundSupply: totalFundSupply,
            manifestHash: keccak256(abi.encode(holders, fixture.balances, fixture.allocations)),
            manifestUri: "ipfs://independently-reconciled-snapshot",
            allocations: allocations
        });
    }

    /// @dev Two isolated chains start with the same actual 500 FUND ledger. Each receives half the global mint.
    /// The zero-local fixture burns the origin balance before the snapshot and leaves all entitlement on chain 10.
    function _globalSnapshots(bool emptyOrigin) private returns (SnapshotFixture[2] memory fixtures) {
        SnapshotFixture memory base = _snapshot(_holders());
        uint256 originBlock = base.snapshot.allocations[0].snapshotBlockNumber;
        bytes32 originHash = base.snapshot.allocations[0].snapshotBlockHash;
        if (emptyOrigin) {
            for (uint256 i; i < base.holders.length; ++i) {
                vm.prank(base.holders[i]);
                jbController().burnTokensOf(base.holders[i], _fundId, base.balances[i], "no origin allocation");
            }
            vm.roll(block.number + 1);
            originBlock = block.number - 1;
            originHash = keccak256(abi.encode("empty origin FUND", originBlock));
            vm.setBlockhash(originBlock, originHash);
            assertEq(jbTokens().totalSupplyOf(_fundId), 0);
        }
        HomerunInitialIncomeAllocation[] memory rows = new HomerunInitialIncomeAllocation[](2);
        for (uint256 i; i < 2; ++i) {
            rows[i] = HomerunInitialIncomeAllocation({
                chainId: i == 0 ? 1 : 10,
                fundProjectId: _fundId,
                snapshotBlockNumber: i == 0 ? originBlock : base.snapshot.allocations[0].snapshotBlockNumber,
                snapshotBlockHash: i == 0 ? originHash : base.snapshot.allocations[0].snapshotBlockHash,
                incomeAmount: emptyOrigin ? (i == 0 ? 0 : uint104(500_000 ether)) : uint104(250_000 ether)
            });
        }
        HomerunInitialIncomeSnapshot memory snapshot = HomerunInitialIncomeSnapshot({
            sourceSetHash: keccak256(
                abi.encode("two independently reconciled FUND ledgers", rows[0].snapshotBlockHash, emptyOrigin)
            ),
            totalFundSupply: emptyOrigin ? 500 ether : 1000 ether,
            manifestHash: keccak256(abi.encode(base.holders, base.balances, emptyOrigin)),
            manifestUri: "ipfs://global-reconciled-snapshot",
            allocations: rows
        });
        for (uint256 i; i < 2; ++i) {
            fixtures[i].snapshot = snapshot;
            fixtures[i].holders = base.holders;
            fixtures[i].balances = base.balances;
            fixtures[i].allocations = new uint256[](3);
            if (rows[i].incomeAmount == 0) continue;
            for (uint256 j; j < 3; ++j) {
                fixtures[i].allocations[j] = base.balances[j] * rows[i].incomeAmount / (500 ether);
            }
        }
    }

    function _switchToIsolatedOptimism(HomerunInitialIncomeSnapshot memory snapshot, uint256 launchTime) private {
        assertTrue(vm.revertToState(_beforeCcipSnapshot));
        vm.chainId(10);
        vm.warp(launchTime);
        vm.roll(snapshot.allocations[1].snapshotBlockNumber + 1);
        vm.setBlockhash(snapshot.allocations[1].snapshotBlockNumber, snapshot.allocations[1].snapshotBlockHash);
        _ccipToEthereum = _ccipDeployer(1, _feeProjectId);
        assertEq(_helper.PROTOCOL_CONFIG_HASH(), keccak256(abi.encode(_chainConfigs())));
    }

    function _payAndDistribute(uint256 incomeId) private returns (uint256 customerTokens) {
        usdcToken().mint(CUSTOMER, 100e6);
        vm.startPrank(CUSTOMER);
        usdcToken().approve(address(jbMultiTerminal()), 100e6);
        customerTokens = jbMultiTerminal().pay(incomeId, address(usdcToken()), 100e6, CUSTOMER, 0, "revenue", "");
        vm.stopPrank();
        jbController().sendReservedTokensToSplitsOf(incomeId);
    }

    function testRealDeploymentRecordsTheWholeInitialIncomeForTheOwner() public {
        SnapshotFixture memory fixture = _snapshot(_holders());
        uint256 incomeId = _deploySnapshot(8000, fixture);
        assertEq(_helper.incomeProjectIdOf(_fundId), incomeId);
        assertEq(jbProjects().ownerOf(_fundId), OPERATOR);
        assertEq(jbProjects().ownerOf(incomeId), address(_revOwner));
        assertTrue(_revOwner.isOperatorOf(incomeId, OPERATOR));
        assertFalse(_revOwner.isOperatorOf(incomeId, address(_helper)));
        // The launch records the allocation; nothing is minted until the stage has started and someone asks.
        assertEq(jbTokens().totalSupplyOf(incomeId), 0);
        assertEq(jbTokens().totalCreditSupplyOf(incomeId), 0);
        (JBRuleset memory ruleset, JBRulesetMetadata memory metadata) = jbController().currentRulesetOf(incomeId);
        assertEq(metadata.dataHook, address(_revOwner));
        assertEq(metadata.reservedPercent, 8000);
        assertEq(_revOwner.amountToAutoIssue(incomeId, ruleset.id, address(_helper)), 500_000 ether);
        assertEq(_revOwner.amountToAutoIssue(incomeId, ruleset.id, OPERATOR), 0);
        assertEq(jbTokens().totalSupplyOf(_fundId), 500 ether);
        // The FUND token exists from launch, so success mints are ERC-20 balances, never credits.
        assertEq(jbTokens().creditBalanceOf(ALICE, _fundId), 0);
        assertEq(_fundToken.balanceOf(ALICE), 300 ether);
        _mintInitialIncome(incomeId, 500_000 ether);
        // The owner settles the published allocation from their own balance.
        IERC20 income = IERC20(address(jbTokens().tokenOf(incomeId)));
        for (uint256 i = 1; i < fixture.holders.length; ++i) {
            vm.prank(OPERATOR);
            income.transfer(fixture.holders[i], fixture.allocations[i]);
        }
        assertEq(jbTokens().totalBalanceOf(OPERATOR, incomeId), 100_000 ether);
        assertEq(jbTokens().totalBalanceOf(ALICE, incomeId), 300_000 ether);
        assertEq(jbTokens().totalBalanceOf(BOB, incomeId), 100_000 ether);
        assertEq(jbTokens().totalSupplyOf(incomeId), 500_000 ether);
    }

    /// @dev Mints the recorded allocation for INCOME's single stage to the FUND's current owner, as anyone may once
    /// the stage has started.
    function _mintInitialIncome(uint256 incomeId, uint256 expected) private {
        (JBRuleset memory stage,,) = jbController().latestQueuedRulesetOf(incomeId);
        assertEq(_revOwner.amountToAutoIssue(incomeId, stage.id, address(_helper)), expected);
        address owner = jbProjects().ownerOf(_fundId);
        if (expected == 0) {
            vm.expectRevert(abi.encodeWithSelector(HomerunDeployer.HomerunDeployer_NothingToMint.selector, _fundId));
            _helper.mintInitialAllocation(_fundId);
            return;
        }
        uint256 before = jbTokens().totalBalanceOf(owner, incomeId);
        vm.prank(CUSTOMER);
        _helper.mintInitialAllocation(_fundId);
        assertEq(jbTokens().totalBalanceOf(owner, incomeId) - before, expected);
        assertEq(jbTokens().totalBalanceOf(address(_helper), incomeId), 0);
        assertEq(_revOwner.amountToAutoIssue(incomeId, stage.id, address(_helper)), 0);
        assertEq(jbController().pendingReservedTokenBalanceOf(incomeId), 0);
        vm.expectRevert(abi.encodeWithSelector(HomerunDeployer.HomerunDeployer_NothingToMint.selector, _fundId));
        _helper.mintInitialAllocation(_fundId);
    }

    function testRealDistinctOwnerControlsIncomeAndHoldsTheReservedSplit() public {
        vm.prank(OPERATOR);
        jbProjects().transferFrom(OPERATOR, OWNER, _fundId);
        SnapshotFixture memory fixture = _snapshot(_holders());
        REVDescription memory description =
            REVDescription({name: "House income", ticker: "RENT", uri: "ipfs://income", salt: LAUNCH_SALT});
        REVSuckerDeploymentConfig memory suckers = _suckerConfig(fixture.snapshot);

        vm.expectPartialRevert(HomerunDeployer.HomerunDeployer_Unauthorized.selector);
        vm.prank(OPERATOR);
        _helper.deployIncome(_fundId, fixture.snapshot, description, 8000, STARTS_AT, suckers);

        vm.prank(OWNER);
        uint256 incomeId = _helper.deployIncome(_fundId, fixture.snapshot, description, 8000, STARTS_AT, suckers);
        assertEq(jbProjects().ownerOf(_fundId), OWNER);
        assertEq(jbProjects().ownerOf(incomeId), address(_revOwner));
        assertTrue(_revOwner.isOperatorOf(incomeId, OWNER));
        assertFalse(_revOwner.isOperatorOf(incomeId, OPERATOR));
        assertFalse(_revOwner.isOperatorOf(incomeId, address(_helper)));
        assertEq(JBERC20(address(jbTokens().tokenOf(incomeId))).symbol(), "RENT");
        IJBTerminal[] memory terminals = jbDirectory().terminalsOf(incomeId);
        assertEq(terminals.length, 2);
        assertEq(address(terminals[1]), address(_router));

        vm.expectRevert(
            abi.encodeWithSelector(
                JBPermissioned.JBPermissioned_Unauthorized.selector,
                address(_revOwner),
                OPERATOR,
                incomeId,
                JBPermissionIds.SET_PROJECT_URI
            )
        );
        vm.prank(OPERATOR);
        jbController().setUriOf(incomeId, "ipfs://unauthorized-update");
        vm.prank(OWNER);
        jbController().setUriOf(incomeId, "ipfs://owner-update");
        assertEq(jbController().uriOf(incomeId), "ipfs://owner-update");

        (JBRuleset memory current, JBRulesetMetadata memory metadata) = jbController().currentRulesetOf(incomeId);
        (JBRuleset memory last,,) = jbController().latestQueuedRulesetOf(incomeId);
        assertEq(current.id, last.id, "one stage, no frozen second stage");
        assertEq(current.weightCutPercent, _helper.INCOME_CUT_PERCENT());
        assertEq(current.duration, _helper.QUARTER());
        assertEq(metadata.cashOutTaxRate, _helper.INCOME_CASH_OUT_TAX_RATE());
        assertEq(metadata.reservedPercent, 8000);
        JBSplit[] memory splits = jbSplits().splitsOf(incomeId, current.id, JBSplitGroupIds.RESERVED_TOKENS);
        assertEq(splits.length, 1);
        assertEq(splits[0].beneficiary, OWNER);
        assertEq(splits[0].percent, 1_000_000_000);
        assertEq(splits[0].lockedUntil, 0);
        assertEq(address(splits[0].hook), address(0));

        assertEq(_payAndDistribute(incomeId), 200 ether);
        IJBToken income = jbTokens().tokenOf(incomeId);
        assertEq(income.balanceOf(OWNER), 800 ether);
        assertEq(income.balanceOf(OPERATOR), 0);
        assertEq(income.balanceOf(CUSTOMER), 200 ether);
        assertEq(jbController().pendingReservedTokenBalanceOf(incomeId), 0);
    }

    function _shopItems() private pure returns (JB721TierConfig[] memory tiers) {
        tiers = new JB721TierConfig[](1);
        tiers[0].price = 25e6;
        tiers[0].initialSupply = 100;
        tiers[0].encodedIpfsUri = bytes32(uint256(123));
        tiers[0].flags.useVotingUnits = true;
    }

    function testRealIncomeOwnerCanAddSellAndRemoveItemsWithoutChangingRulesets() public {
        uint256 incomeId = _deployWithDistinctOwner();
        JB721TiersHook hook = JB721TiersHook(address(_revOwner.tiered721HookOf(incomeId)));
        (JBRuleset memory before,) = jbController().currentRulesetOf(incomeId);
        assertEq(hook.owner(), address(_revOwner));
        assertEq(hook.baseURI(), "ipfs://");
        assertEq(hook.contractURI(), "ipfs://income");
        for (uint256 i; i < 2; ++i) {
            address unauthorized = i == 0 ? OPERATOR : address(_helper);
            vm.expectRevert(
                abi.encodeWithSelector(
                    JBPermissioned.JBPermissioned_Unauthorized.selector,
                    address(_revOwner),
                    unauthorized,
                    incomeId,
                    JBPermissionIds.ADJUST_721_TIERS
                )
            );
            vm.prank(unauthorized);
            hook.adjustTiers(_shopItems(), new uint256[](0));
        }
        vm.prank(OWNER);
        hook.adjustTiers(_shopItems(), new uint256[](0));
        assertEq(hook.STORE().maxTierIdOf(address(hook)), 1);
        uint16[] memory tierIds = new uint16[](1);
        tierIds[0] = 1;
        bytes4[] memory ids = new bytes4[](1);
        ids[0] = JBMetadataResolver.getId("pay", hook.METADATA_ID_TARGET());
        bytes[] memory entries = new bytes[](1);
        entries[0] = abi.encode(false, tierIds);
        bytes memory metadata = JBMetadataResolver.createMetadata(ids, entries);
        usdcToken().mint(CUSTOMER, 25e6);
        vm.startPrank(CUSTOMER);
        usdcToken().approve(address(jbMultiTerminal()), 25e6);
        uint256 customerTokens =
            jbMultiTerminal().pay(incomeId, address(usdcToken()), 25e6, CUSTOMER, 0, "weekend stay", metadata);
        vm.stopPrank();
        assertEq(hook.balanceOf(CUSTOMER), 1);
        assertEq(customerTokens, 50 ether);
        uint256[] memory removed = new uint256[](1);
        removed[0] = 1;
        vm.prank(OWNER);
        hook.adjustTiers(new JB721TierConfig[](0), removed);
        assertEq(hook.balanceOf(CUSTOMER), 1);
        (JBRuleset memory afterRuleset,) = jbController().currentRulesetOf(incomeId);
        assertEq(afterRuleset.id, before.id);
    }

    function testRealShopAuthorityRotatesWithOwnerWithoutAddingMintMetadataOrDiscountPowers() public {
        uint256 incomeId = _deployWithDistinctOwner();
        JB721TiersHook hook = JB721TiersHook(address(_revOwner.tiered721HookOf(incomeId)));
        assertTrue(
            jbPermissions()
                .hasPermission(OWNER, address(_revOwner), incomeId, JBPermissionIds.ADJUST_721_TIERS, false, false)
        );
        assertFalse(
            jbPermissions().hasPermission(OWNER, address(_revOwner), incomeId, JBPermissionIds.MINT_721, false, false)
        );
        assertFalse(
            jbPermissions()
                .hasPermission(OWNER, address(_revOwner), incomeId, JBPermissionIds.SET_721_METADATA, false, false)
        );
        assertFalse(
            jbPermissions()
                .hasPermission(
                    OWNER, address(_revOwner), incomeId, JBPermissionIds.SET_721_DISCOUNT_PERCENT, false, false
                )
        );
        JB721TiersHookFlags memory flags = hook.STORE().flagsOf(address(hook));
        assertTrue(flags.noNewTiersWithReserves);
        assertTrue(flags.noNewTiersWithVotes);
        assertTrue(flags.noNewTiersWithOwnerMinting);
        vm.prank(OWNER);
        _revOwner.setOperatorOf(incomeId, NEXT_OPERATOR);
        assertFalse(
            jbPermissions()
                .hasPermission(OWNER, address(_revOwner), incomeId, JBPermissionIds.ADJUST_721_TIERS, false, false)
        );
        assertTrue(
            jbPermissions()
                .hasPermission(
                    NEXT_OPERATOR, address(_revOwner), incomeId, JBPermissionIds.ADJUST_721_TIERS, false, false
                )
        );
        vm.prank(NEXT_OPERATOR);
        hook.adjustTiers(_shopItems(), new uint256[](0));
        assertEq(hook.STORE().maxTierIdOf(address(hook)), 1);
    }

    function testRealPaymentRoutesTheReservedShareToTheOwnerAndTheRestToTheCustomer() public {
        uint256 incomeId = _deploy(8000);
        assertEq(_payAndDistribute(incomeId), 200 ether);
        IJBToken income = jbTokens().tokenOf(incomeId);
        assertEq(income.balanceOf(CUSTOMER), 200 ether);
        assertEq(income.balanceOf(OPERATOR), 800 ether);
        assertEq(jbTokens().totalSupplyOf(incomeId), 1000 ether);
        assertEq(jbController().pendingReservedTokenBalanceOf(incomeId), 0);
        assertEq(jbTerminalStore().balanceOf(address(jbMultiTerminal()), incomeId, address(usdcToken())), 100e6);
    }

    function testRealOneHundredPercentReservedIssuanceAcceptsZeroCustomerTokens() public {
        uint256 incomeId = _deploy(10_000);
        assertEq(_payAndDistribute(incomeId), 0);
        IJBToken income = jbTokens().tokenOf(incomeId);
        assertEq(income.balanceOf(CUSTOMER), 0);
        assertEq(income.balanceOf(OPERATOR), 1000 ether);
        assertEq(jbTokens().totalSupplyOf(incomeId), 1000 ether);
    }

    function testRealZeroReservedIssuanceGivesEverythingToTheCustomer() public {
        uint256 incomeId = _deploy(0);
        usdcToken().mint(CUSTOMER, 100e6);
        vm.startPrank(CUSTOMER);
        usdcToken().approve(address(jbMultiTerminal()), 100e6);
        assertEq(jbMultiTerminal().pay(incomeId, address(usdcToken()), 100e6, CUSTOMER, 0, "revenue", ""), 1000 ether);
        vm.stopPrank();
        assertEq(jbController().pendingReservedTokenBalanceOf(incomeId), 0);
        assertEq(jbTokens().tokenOf(incomeId).balanceOf(OPERATOR), 0);
    }

    function _deployWithDistinctOwner() private returns (uint256 incomeId) {
        vm.prank(OPERATOR);
        jbProjects().transferFrom(OPERATOR, OWNER, _fundId);
        SnapshotFixture memory fixture = _snapshot(_holders());
        REVDescription memory description =
            REVDescription({name: "House income", ticker: "RENT", uri: "ipfs://income", salt: LAUNCH_SALT});
        REVSuckerDeploymentConfig memory suckers = _suckerConfig(fixture.snapshot);
        vm.prank(OWNER);
        incomeId = _helper.deployIncome(_fundId, fixture.snapshot, description, 8000, STARTS_AT, suckers);
    }

    function _reservedSplitGroups(
        uint256 incomeId,
        uint256 stageId
    )
        private
        view
        returns (JBSplitGroup[] memory groups)
    {
        groups = new JBSplitGroup[](1);
        groups[0] = JBSplitGroup({
            groupId: JBSplitGroupIds.RESERVED_TOKENS,
            splits: jbSplits().splitsOf(incomeId, stageId, JBSplitGroupIds.RESERVED_TOKENS)
        });
    }

    function testRealOwnerCanRedirectTheReservedSplitWithoutMovingExistingTokens() public {
        uint256 incomeId = _deployWithDistinctOwner();
        (JBRuleset memory current,) = jbController().currentRulesetOf(incomeId);
        _payAndDistribute(incomeId);
        IJBToken income = jbTokens().tokenOf(incomeId);
        assertEq(income.balanceOf(OWNER), 800 ether);

        JBSplitGroup[] memory groups = _reservedSplitGroups(incomeId, current.id);
        groups[0].splits[0].beneficiary = payable(NEXT_OPERATOR);
        vm.expectRevert(
            abi.encodeWithSelector(
                JBPermissioned.JBPermissioned_Unauthorized.selector,
                address(_revOwner),
                OPERATOR,
                incomeId,
                JBPermissionIds.SET_SPLIT_GROUPS
            )
        );
        vm.prank(OPERATOR);
        jbController().setSplitGroupsOf(incomeId, current.id, groups);
        vm.prank(OWNER);
        jbController().setSplitGroupsOf(incomeId, current.id, groups);
        groups = _reservedSplitGroups(incomeId, current.id);
        assertEq(groups[0].splits[0].beneficiary, NEXT_OPERATOR);
        assertEq(groups[0].splits[0].percent, 1_000_000_000);

        _payAndDistribute(incomeId);
        assertEq(income.balanceOf(OWNER), 800 ether, "the owner keeps earned tokens without new incentives");
        assertEq(income.balanceOf(NEXT_OPERATOR), 800 ether);
        assertTrue(_revOwner.isOperatorOf(incomeId, OWNER));
        assertFalse(_revOwner.isOperatorOf(incomeId, NEXT_OPERATOR));
    }

    function _assertLocalAllocation(uint256 incomeId, uint256 expected) private {
        _mintInitialIncome(incomeId, expected);
        assertEq(jbTokens().totalSupplyOf(incomeId), expected);
        assertEq(jbTokens().totalBalanceOf(address(_helper), incomeId), 0);
        (, JBRulesetMetadata memory metadata) = jbController().currentRulesetOf(incomeId);
        assertFalse(metadata.scopeCashOutsToLocalBalances);
        assertEq(metadata.metadata, 4);
        assertTrue(_revOwner.isOperatorOf(incomeId, OPERATOR));
    }

    function _assertCcipRoute(uint256 incomeId, uint256 remoteChain) private view returns (address suckerAddress) {
        address[] memory suckers = _suckers.allSuckersOf(incomeId);
        assertEq(suckers.length, 1);
        suckerAddress = suckers[0];
        JBCCIPSucker sucker = JBCCIPSucker(payable(suckerAddress));
        assertEq(sucker.projectId(), incomeId);
        assertEq(sucker.peerChainId(), remoteChain);
        assertEq(sucker.REMOTE_CHAIN_ID(), remoteChain);
        assertEq(sucker.peer(), bytes32(uint256(uint160(suckerAddress))));
        JBRemoteToken memory remote = sucker.remoteTokenFor(address(usdcToken()));
        assertTrue(remote.enabled);
        assertEq(remote.addr, bytes32(uint256(uint160(address(usdcToken())))));
        assertEq(remote.minGas, 200_000);
    }

    function testRealGlobalAllocationMintsHalfPerChainWithMatchingDelayedRevnetAndCcipIdentity() public {
        SnapshotFixture[2] memory fixtures = _globalSnapshots(false);
        uint256 originIncomeId = _deploySnapshot(8000, fixtures[0]);
        _assertLocalAllocation(originIncomeId, 250_000 ether);
        bytes32 originHash = _revDeployer.hashedEncodedConfigurationOf(originIncomeId);
        address originIncomeToken = address(jbTokens().tokenOf(originIncomeId));
        address originSucker = _assertCcipRoute(originIncomeId, 10);
        uint256 originSupply = jbTokens().totalSupplyOf(originIncomeId);
        assertEq(jbTokens().totalBalanceOf(OPERATOR, originIncomeId), 250_000 ether);

        _switchToIsolatedOptimism(fixtures[1].snapshot, STARTS_AT + 3 days);
        uint256 remoteIncomeId = _deploySnapshot(8000, fixtures[1]);
        _assertLocalAllocation(remoteIncomeId, 250_000 ether);
        assertEq(_revDeployer.hashedEncodedConfigurationOf(remoteIncomeId), originHash);
        assertEq(address(jbTokens().tokenOf(remoteIncomeId)), originIncomeToken);
        assertEq(_assertCcipRoute(remoteIncomeId, 1), originSucker);
        assertEq(originSupply + jbTokens().totalSupplyOf(remoteIncomeId), 500_000 ether);
        assertEq(jbTokens().totalBalanceOf(OPERATOR, remoteIncomeId), 250_000 ether);
    }

    function testRealZeroLocalAllocationLeavesAllFiveHundredThousandForRemoteChain() public {
        SnapshotFixture[2] memory fixtures = _globalSnapshots(true);
        uint256 originIncomeId = _deploySnapshot(8000, fixtures[0]);
        _assertLocalAllocation(originIncomeId, 0);
        assertEq(jbTokens().totalSupplyOf(_fundId), 0);
        bytes32 originHash = _revDeployer.hashedEncodedConfigurationOf(originIncomeId);
        address originSucker = _assertCcipRoute(originIncomeId, 10);

        _switchToIsolatedOptimism(fixtures[1].snapshot, STARTS_AT + 1 days);
        uint256 remoteIncomeId = _deploySnapshot(8000, fixtures[1]);
        _assertLocalAllocation(remoteIncomeId, 500_000 ether);
        assertEq(_revDeployer.hashedEncodedConfigurationOf(remoteIncomeId), originHash);
        assertEq(_assertCcipRoute(remoteIncomeId, 1), originSucker);
        assertEq(jbTokens().totalBalanceOf(OPERATOR, remoteIncomeId), 500_000 ether);
    }

    function testRealLaunchAfterEightQuartersKeepsDecayingAndPreservesIdentity() public {
        SnapshotFixture[2] memory fixtures = _globalSnapshots(false);
        uint256 originIncomeId = _deploySnapshot(8000, fixtures[0]);
        bytes32 originHash = _revDeployer.hashedEncodedConfigurationOf(originIncomeId);
        address originSucker = _assertCcipRoute(originIncomeId, 10);
        uint256 lateTimestamp = uint256(STARTS_AT) + uint256(_helper.QUARTER()) * 8 + 1 days;
        _switchToIsolatedOptimism(fixtures[1].snapshot, lateTimestamp);
        uint256 remoteIncomeId = _deploySnapshot(8000, fixtures[1]);
        _assertLocalAllocation(remoteIncomeId, 250_000 ether);
        assertEq(_revDeployer.hashedEncodedConfigurationOf(remoteIncomeId), originHash);
        assertEq(_assertCcipRoute(remoteIncomeId, 1), originSucker);
        (JBRuleset memory current,) = jbController().currentRulesetOf(remoteIncomeId);
        assertEq(current.id, lateTimestamp, "the single stage is live and still cutting");
        assertEq(current.weightCutPercent, _helper.INCOME_CUT_PERCENT());
        assertEq(current.cycleNumber, 9, "eight quarters have elapsed since the shared start");
        uint256 expectedWeight = 10 ether;
        for (uint256 i; i < 8; ++i) {
            expectedWeight = expectedWeight * 98 / 100;
        }
        assertEq(current.weight, expectedWeight, "issuance keeps cutting 2% per quarter, never freezes");
        assertEq(_revOwner.amountToAutoIssue(remoteIncomeId, current.id, address(_helper)), 0);
        assertEq(jbTokens().totalBalanceOf(OPERATOR, remoteIncomeId), 250_000 ether);
    }

    function testRealFutureStartDefersTheOwnerMintWithoutCashOutDelay() public {
        SnapshotFixture memory fixture = _snapshot(_holders());
        uint48 startsAt = uint48(block.timestamp + 10 minutes);
        uint256 incomeId = _deploySnapshotStarting(8000, fixture, startsAt);
        (JBRuleset memory stage,,) = jbController().latestQueuedRulesetOf(incomeId);
        assertEq(jbTokens().totalSupplyOf(incomeId), 0);
        assertEq(_revOwner.amountToAutoIssue(incomeId, stage.id, address(_helper)), 500_000 ether);
        // A stage that has not started carries no revnet cash out delay.
        assertEq(_revOwner.cashOutDelayOf(incomeId), 0);
        vm.expectPartialRevert(REVOwner.REVOwner_StageNotStarted.selector);
        _helper.mintInitialAllocation(_fundId);

        // The FUND changes hands before the stage starts: the allocation follows the FUND.
        vm.prank(OPERATOR);
        jbProjects().transferFrom(OPERATOR, OWNER, _fundId);
        vm.warp(startsAt);
        _mintInitialIncome(incomeId, 500_000 ether);
        assertEq(jbTokens().totalBalanceOf(OWNER, incomeId), 500_000 ether);
        assertEq(jbTokens().totalBalanceOf(OPERATOR, incomeId), 0);
    }

    function testRealStrangerMintingThroughRevOwnerFirstStillPaysTheOwner() public {
        SnapshotFixture memory fixture = _snapshot(_holders());
        uint256 incomeId = _deploySnapshot(8000, fixture);
        (JBRuleset memory stage,,) = jbController().latestQueuedRulesetOf(incomeId);
        vm.prank(CUSTOMER);
        _revOwner.autoIssueFor(incomeId, stage.id, address(_helper));
        assertEq(jbTokens().totalBalanceOf(address(_helper), incomeId), 500_000 ether);
        assertEq(_revOwner.amountToAutoIssue(incomeId, stage.id, address(_helper)), 0);
        vm.prank(BOB);
        _helper.mintInitialAllocation(_fundId);
        assertEq(jbTokens().totalBalanceOf(OPERATOR, incomeId), 500_000 ether);
        assertEq(jbTokens().totalBalanceOf(address(_helper), incomeId), 0);
        vm.expectRevert(abi.encodeWithSelector(HomerunDeployer.HomerunDeployer_NothingToMint.selector, _fundId));
        _helper.mintInitialAllocation(_fundId);
    }

    function testRealPastStartMintsImmediatelyAndInheritsCashOutDelay() public {
        uint256 incomeId = _deploy(8000);
        _assertLocalAllocation(incomeId, 500_000 ether);
        assertEq(_revOwner.cashOutDelayOf(incomeId), block.timestamp + _revDeployer.CASH_OUT_DELAY());
    }

    function testRealCanonicalOmnichainFundHookCanLaunchIncomeAfterClosing() public {
        (JBRuleset memory current, JBRulesetMetadata memory metadata) = jbController().currentRulesetOf(_fundId);
        assertEq(metadata.dataHook, address(_omnichain));
        assertTrue(metadata.pausePay);
        assertFalse(metadata.allowOwnerMinting);
        JBDeployerHookConfig memory extra = _omnichain.extraDataHookOf(_fundId, current.id);
        assertEq(address(extra.dataHook), address(_allowlist), "a closed FUND keeps its allowlist hook");
        assertTrue(extra.useDataHookForPay);
        assertFalse(extra.useDataHookForCashOut);
        uint256 incomeId = _deploy(8000);
        _assertLocalAllocation(incomeId, 500_000 ether);
        assertEq(_helper.incomeProjectIdOf(_fundId), incomeId);
    }

    function testRealFundPaymentsAreGatedByTheOwnerManagedAllowlist() public {
        uint256 fee = jbProjects().creationFee();
        vm.deal(OWNER, fee);
        vm.prank(OWNER);
        (uint256 fundId,) = _helper.launchFundFor{value: fee}(
            OWNER, "ipfs://open-fund", "Open FUND", "OPEN", 0, bytes32(0), new address[](0)
        );
        (JBRuleset memory current,) = jbController().currentRulesetOf(fundId);
        JBDeployerHookConfig memory extra = _omnichain.extraDataHookOf(fundId, current.id);
        assertEq(address(extra.dataHook), address(_allowlist));
        assertTrue(extra.useDataHookForPay);
        assertFalse(extra.useDataHookForCashOut);

        usdcToken().mint(CUSTOMER, 300e6);
        vm.startPrank(CUSTOMER);
        usdcToken().approve(address(jbMultiTerminal()), 300e6);
        // A new FUND is closed to everyone, including its owner, until the owner allows or opens it.
        vm.expectRevert(
            abi.encodeWithSelector(HomerunAllowlistHook.HomerunAllowlistHook_NotAllowed.selector, fundId, CUSTOMER)
        );
        jbMultiTerminal().pay(fundId, address(usdcToken()), 100e6, CUSTOMER, 0, "", "");
        vm.stopPrank();

        address[] memory accounts = new address[](1);
        accounts[0] = CUSTOMER;
        vm.expectPartialRevert(HomerunAllowlistHook.HomerunAllowlistHook_Unauthorized.selector);
        vm.prank(OPERATOR);
        _allowlist.setAllowed(fundId, accounts, true);
        vm.prank(OWNER);
        _allowlist.setAllowed(fundId, accounts, true);
        vm.prank(CUSTOMER);
        assertEq(jbMultiTerminal().pay(fundId, address(usdcToken()), 100e6, CUSTOMER, 0, "", ""), 1_000_000 ether);
        // The beneficiary is what is gated, not the payer.
        vm.prank(CUSTOMER);
        vm.expectRevert(
            abi.encodeWithSelector(HomerunAllowlistHook.HomerunAllowlistHook_NotAllowed.selector, fundId, BOB)
        );
        jbMultiTerminal().pay(fundId, address(usdcToken()), 100e6, BOB, 0, "", "");
        vm.prank(OWNER);
        _allowlist.setOpen(fundId, true);
        vm.prank(CUSTOMER);
        assertEq(jbMultiTerminal().pay(fundId, address(usdcToken()), 100e6, BOB, 0, "", ""), 1_000_000 ether);
        assertEq(jbTokens().totalBalanceOf(BOB, fundId), 1_000_000 ether);
        // Cash outs are never gated.
        vm.prank(OWNER);
        _allowlist.setOpen(fundId, false);
        vm.prank(BOB);
        assertGt(
            jbMultiTerminal().cashOutTokensOf(BOB, fundId, 1000 ether, address(usdcToken()), 0, payable(BOB), ""), 0
        );
    }

    function testRealLinkedLaunchTokenSaltIsScopedToTheCaller() public {
        uint256 fee = jbProjects().creationFee();
        address[] memory peers = new address[](1);
        peers[0] = address(_ccipToOptimism);
        bytes32 salt = keccak256("shared salt");
        vm.deal(OWNER, fee);
        vm.deal(ALICE, fee);
        vm.prank(OWNER);
        (, address ownerToken) =
            _helper.launchFundFor{value: fee}(OWNER, "ipfs://a", "A FUND", "AAA", uint48(block.timestamp), salt, peers);
        // A launch salt is public (it is emitted). Another launcher reusing it must neither collide with nor block
        // the first launcher's remaining chains.
        vm.prank(ALICE);
        (, address aliceToken) =
            _helper.launchFundFor{value: fee}(ALICE, "ipfs://b", "B FUND", "BBB", uint48(block.timestamp), salt, peers);
        assertTrue(ownerToken != aliceToken);
    }

    function testRealStockedOmnichainFundShopCanLaunchSeparateIncomeShop() public {
        (JBRuleset memory current,) = jbController().currentRulesetOf(_fundId);
        (IJB721TiersHook fundHook,) = _omnichain.tiered721HookOf(_fundId, current.id);
        vm.prank(OPERATOR);
        fundHook.adjustTiers(_shopItems(), new uint256[](0));
        uint256 incomeId = _deploy(8000);
        IJB721TiersHook incomeHook = _revOwner.tiered721HookOf(incomeId);
        assertTrue(address(incomeHook) != address(fundHook));
        assertEq(fundHook.STORE().maxTierIdOf(address(fundHook)), 1);
        assertEq(incomeHook.STORE().maxTierIdOf(address(incomeHook)), 0);
        _assertLocalAllocation(incomeId, 500_000 ether);
    }

    function _attachFundShop(JB721TiersHookDeployer deployer, bool cashOut) private returns (IJB721TiersHook hook) {
        JBDeploy721TiersHookConfig memory config;
        config.name = "FUND shop";
        config.symbol = "FUNDSTORE";
        config.baseUri = "ipfs://";
        config.tiersConfig.currency = 2;
        config.tiersConfig.decimals = 6;
        config.tiersConfig.tiers = _shopItems();
        vm.startPrank(OPERATOR);
        hook = deployer.deployHookFor(_fundId, config, bytes32(0));
        JB721TiersHook(address(hook)).transferOwnershipToProject(_fundId);
        (, JBRulesetMetadata memory metadata) = jbController().currentRulesetOf(_fundId);
        JBRulesetConfig[] memory rulesets = new JBRulesetConfig[](1);
        rulesets[0].weight = 1 ether;
        rulesets[0].metadata = metadata;
        rulesets[0].metadata.dataHook = address(hook);
        rulesets[0].metadata.useDataHookForPay = true;
        rulesets[0].metadata.useDataHookForCashOut = cashOut;
        jbController().queueRulesetsOf(_fundId, rulesets, "closed FUND with shop");
        vm.stopPrank();
        vm.warp(block.timestamp + 1);
        vm.roll(block.number + 1);
    }

    function testRealDirectlyQueuedFundShopCanLaunchSeparateIncomeShop() public {
        IJB721TiersHook fundHook = _attachFundShop(JB721TiersHookDeployer(address(_omnichain.HOOK_DEPLOYER())), false);
        uint256 incomeId = _deploy(8000);
        IJB721TiersHook incomeHook = _revOwner.tiered721HookOf(incomeId);
        assertTrue(address(incomeHook) != address(fundHook));
        assertEq(fundHook.STORE().maxTierIdOf(address(fundHook)), 1);
        assertEq(incomeHook.STORE().maxTierIdOf(address(incomeHook)), 0);
        _assertLocalAllocation(incomeId, 500_000 ether);
    }

    function _firstShopMetadata(JBRulesetMetadata memory previous)
        private
        pure
        returns (JBPayDataHookRulesetMetadata memory metadata)
    {
        metadata.reservedPercent = previous.reservedPercent;
        metadata.cashOutTaxRate = previous.cashOutTaxRate;
        metadata.baseCurrency = previous.baseCurrency;
        metadata.pausePay = previous.pausePay;
        metadata.pauseCreditTransfers = previous.pauseCreditTransfers;
        metadata.allowOwnerMinting = previous.allowOwnerMinting;
        metadata.allowSetCustomToken = previous.allowSetCustomToken;
        metadata.allowTerminalMigration = previous.allowTerminalMigration;
        metadata.allowSetTerminals = previous.allowSetTerminals;
        metadata.allowSetController = previous.allowSetController;
        metadata.allowAddAccountingContext = previous.allowAddAccountingContext;
        metadata.allowAddPriceFeed = previous.allowAddPriceFeed;
        metadata.ownerMustSendPayouts = previous.ownerMustSendPayouts;
        metadata.holdFees = previous.holdFees;
        metadata.scopeCashOutsToLocalBalances = previous.scopeCashOutsToLocalBalances;
        // The omnichain data hook's cash-out flag belongs to that hook, not to a directly attached shop.
        metadata.useDataHookForCashOut = false;
        metadata.metadata = previous.metadata;
    }

    function testRealFirstShopAtomicProjectDeployerPreservesTermsAndRestoresScopedPermission() public {
        JB721TiersHookProjectDeployer projectDeployer =
            new JB721TiersHookProjectDeployer(jbDirectory(), jbPermissions(), _omnichain.HOOK_DEPLOYER(), FORWARDER);
        (JBRuleset memory previous, JBRulesetMetadata memory previousMetadata) =
            jbController().currentRulesetOf(_fundId);
        JBSplitGroup[] memory splitGroups = new JBSplitGroup[](1);
        splitGroups[0].groupId = JBSplitGroupIds.RESERVED_TOKENS;
        splitGroups[0].splits = new JBSplit[](1);
        splitGroups[0].splits[0].percent = 1_000_000_000;
        splitGroups[0].splits[0].beneficiary = payable(BOB);
        vm.prank(OPERATOR);
        jbController().setSplitGroupsOf(_fundId, previous.id, splitGroups);

        JBDeploy721TiersHookConfig memory shop;
        shop.name = "House FUND shop";
        shop.symbol = "SHOP";
        shop.baseUri = "ipfs://";
        shop.contractUri = jbController().uriOf(_fundId);
        shop.tiersConfig.currency = 2;
        shop.tiersConfig.decimals = 6;
        shop.tiersConfig.tiers = _shopItems();
        shop.flags.issueTokensForSplits = true;
        JBQueueRulesetsConfig memory queue;
        queue.projectId = uint64(_fundId);
        queue.memo = "Create project shop";
        queue.rulesetConfigurations = new JBPayDataHookRulesetConfig[](1);
        queue.rulesetConfigurations[0].duration = previous.duration;
        queue.rulesetConfigurations[0].weight = previous.weight;
        queue.rulesetConfigurations[0].weightCutPercent = previous.weightCutPercent;
        queue.rulesetConfigurations[0].approvalHook = previous.approvalHook;
        queue.rulesetConfigurations[0].splitGroups = splitGroups;
        queue.rulesetConfigurations[0].metadata = _firstShopMetadata(previousMetadata);
        bytes32 salt = bytes32(uint256(731));
        uint64 deployerNonce = vm.getNonce(address(_omnichain.HOOK_DEPLOYER()));
        vm.expectRevert(
            abi.encodeWithSelector(
                JBPermissioned.JBPermissioned_Unauthorized.selector,
                OPERATOR,
                address(projectDeployer),
                _fundId,
                JBPermissionIds.QUEUE_RULESETS
            )
        );
        vm.prank(OPERATOR);
        projectDeployer.queueRulesetsOf(_fundId, shop, queue, jbController(), salt);
        // The failed controller call also rolls back the first item's hook deployment.
        assertEq(vm.getNonce(address(_omnichain.HOOK_DEPLOYER())), deployerNonce);
        (JBRuleset memory stillCurrent,) = jbController().currentRulesetOf(_fundId);
        assertEq(stillCurrent.id, previous.id);

        uint8[] memory priorPermissions = new uint8[](1);
        priorPermissions[0] = JBPermissionIds.SET_PROJECT_URI;
        vm.prank(OPERATOR);
        jbPermissions()
            .setPermissionsFor(OPERATOR, JBPermissionsData(address(projectDeployer), uint64(_fundId), priorPermissions));
        uint256 priorBitmap = jbPermissions().permissionsOf(address(projectDeployer), OPERATOR, _fundId);
        uint8[] memory creationPermissions = new uint8[](2);
        creationPermissions[0] = priorPermissions[0];
        creationPermissions[1] = JBPermissionIds.QUEUE_RULESETS;
        vm.prank(OPERATOR);
        jbPermissions()
            .setPermissionsFor(
                OPERATOR, JBPermissionsData(address(projectDeployer), uint64(_fundId), creationPermissions)
            );
        assertEq(jbPermissions().permissionsOf(address(projectDeployer), OPERATOR, 0), 0);
        assertEq(jbPermissions().permissionsOf(address(projectDeployer), OPERATOR, _feeProjectId), 0);
        vm.prank(OPERATOR);
        (uint256 rulesetId, IJB721TiersHook hook) =
            projectDeployer.queueRulesetsOf(_fundId, shop, queue, jbController(), salt);
        vm.prank(OPERATOR);
        jbPermissions()
            .setPermissionsFor(OPERATOR, JBPermissionsData(address(projectDeployer), uint64(_fundId), priorPermissions));
        assertEq(jbPermissions().permissionsOf(address(projectDeployer), OPERATOR, _fundId), priorBitmap);

        (JBRuleset memory configured, JBRulesetMetadata memory configuredMetadata) =
            jbController().getRulesetOf(_fundId, rulesetId);
        assertTrue(rulesetId != previous.id);
        assertEq(configured.duration, previous.duration);
        assertEq(configured.weight, previous.weight);
        assertEq(configured.weightCutPercent, previous.weightCutPercent);
        assertEq(address(configured.approvalHook), address(previous.approvalHook));
        previousMetadata.dataHook = address(hook);
        previousMetadata.useDataHookForPay = true;
        previousMetadata.useDataHookForCashOut = false;
        assertEq(abi.encode(configuredMetadata), abi.encode(previousMetadata));
        assertEq(
            abi.encode(jbSplits().splitsOf(_fundId, rulesetId, JBSplitGroupIds.RESERVED_TOKENS)),
            abi.encode(splitGroups[0].splits)
        );
        assertEq(JB721TiersHook(address(hook)).owner(), OPERATOR);
        assertEq(hook.projectId(), _fundId);
        assertEq(hook.STORE().maxTierIdOf(address(hook)), 1);
        assertEq(hook.STORE().tierOf(address(hook), 1, false).price, 25e6);
        assertEq(jbController().uriOf(_fundId), shop.contractUri);
        assertEq(jbTokens().totalSupplyOf(_fundId), 500 ether);

        vm.warp(block.timestamp + 1);
        vm.roll(block.number + 1);
        uint256 incomeId = _deploy(8000);
        IJB721TiersHook incomeHook = _revOwner.tiered721HookOf(incomeId);
        assertTrue(address(incomeHook) != address(hook));
        assertEq(incomeHook.STORE().maxTierIdOf(address(incomeHook)), 0);
    }

    /// @notice Golden vector independently encoded with Viem, including a zero-valued global issuance row.
    /// @dev Uses fixed beneficiary data and the real REVDeployer so this hash does not depend on fixture nonces.
    function testRealRevnetConfigurationMatchesFixedViemVector() public {
        HomerunInitialIncomeSnapshot memory snapshot;
        snapshot.sourceSetHash = bytes32(uint256(1));
        snapshot.totalFundSupply = 1000 ether;
        snapshot.manifestHash = bytes32(uint256(2));
        snapshot.manifestUri = "ipfs://global-vector";
        snapshot.allocations = new HomerunInitialIncomeAllocation[](3);
        snapshot.allocations[0] = HomerunInitialIncomeAllocation(1, 7, 99, bytes32(uint256(11)), 0);
        snapshot.allocations[1] =
            HomerunInitialIncomeAllocation(10, 8, 100, bytes32(uint256(12)), uint104(200_000 ether));
        snapshot.allocations[2] =
            HomerunInitialIncomeAllocation(8453, 9, 101, bytes32(uint256(13)), uint104(300_000 ether));
        bytes32 configurationSalt = _helper.configurationSaltFor(snapshot, bytes32(uint256(3)));
        assertEq(configurationSalt, 0xba844f8a9fd17eec81c3c0e8d0acfc8470d079e6c646bc0e4a099166f4148a11);

        REVConfig memory config;
        config.description = REVDescription("Global INCOME vector", "RENT", "ipfs://vector", configurationSalt);
        config.baseCurrency = 2;
        config.operator = OPERATOR;
        config.scopeCashOutsToLocalBalances = false;
        config.stageConfigurations = new REVStageConfig[](1);
        JBSplit[] memory splits = new JBSplit[](1);
        splits[0].percent = 1_000_000_000;
        splits[0].beneficiary = payable(OPERATOR);
        splits[0].lockedUntil = 0;
        REVAutoIssuance[] memory issuances = new REVAutoIssuance[](3);
        for (uint256 i; i < 3; ++i) {
            issuances[i] = REVAutoIssuance(
                snapshot.allocations[i].chainId,
                snapshot.allocations[i].incomeAmount,
                address(0x1111111111111111111111111111111111111111)
            );
        }
        config.stageConfigurations[0] =
            REVStageConfig(1_000_001, issuances, 8000, splits, 10 ether, 7_884_000, 20_000_000, 1000, 4);
        JBAccountingContext[] memory contexts = new JBAccountingContext[](1);
        contexts[0] = JBAccountingContext(address(usdcToken()), 6, uint32(uint160(address(usdcToken()))));
        REVSuckerDeploymentConfig memory suckers;
        REVDeploy721TiersHookConfig memory nft;
        nft.baseline721HookConfiguration.name = config.description.name;
        nft.baseline721HookConfiguration.symbol = "RENT";
        nft.baseline721HookConfiguration.tiersConfig.currency = 2;
        nft.baseline721HookConfiguration.tiersConfig.decimals = 6;
        (uint256 incomeId,) = _revDeployer.deployFor(0, config, contexts, suckers, nft, new REVCroptopAllowedPost[](0));
        assertEq(
            _revDeployer.hashedEncodedConfigurationOf(incomeId),
            0x78e512e3b06ea190817cd931528acef3b45664a1a18726b16e41da9c9100f541
        );
    }
}
