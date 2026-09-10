// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {TestBaseWorkflow} from "@bananapus/core-v6/test/helpers/TestBaseWorkflow.sol";
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
import {JBSplits} from "@bananapus/core-v6/src/JBSplits.sol";
import {IJBTerminal} from "@bananapus/core-v6/src/interfaces/IJBTerminal.sol";
import {IJBToken} from "@bananapus/core-v6/src/interfaces/IJBToken.sol";
import {JBERC20} from "@bananapus/core-v6/src/JBERC20.sol";
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
import {JB721CheckpointsDeployer} from "@bananapus/721-hook-v6/src/JB721CheckpointsDeployer.sol";
import {JBAddressRegistry} from "@bananapus/address-registry-v6/src/JBAddressRegistry.sol";
import {JBBuybackHookRegistry} from "@bananapus/buyback-hook-v6/src/JBBuybackHookRegistry.sol";
import {CTPublisher} from "@croptop/core-v6/src/CTPublisher.sol";
import {REVDeployer} from "@rev-net/core-v6/src/REVDeployer.sol";
import {REVOwner} from "@rev-net/core-v6/src/REVOwner.sol";
import {IREVLoans} from "@rev-net/core-v6/src/interfaces/IREVLoans.sol";
import {IREVOwner} from "@rev-net/core-v6/src/interfaces/IREVOwner.sol";
import {REVLoans} from "@rev-net/core-v6/src/REVLoans.sol";
import {REVConfig} from "@rev-net/core-v6/src/structs/REVConfig.sol";
import {REVStageConfig} from "@rev-net/core-v6/src/structs/REVStageConfig.sol";
import {REVAutoIssuance} from "@rev-net/core-v6/src/structs/REVAutoIssuance.sol";
import {REVDeploy721TiersHookConfig} from "@rev-net/core-v6/src/structs/REVDeploy721TiersHookConfig.sol";
import {REVCroptopAllowedPost} from "@rev-net/core-v6/src/structs/REVCroptopAllowedPost.sol";
import {REVDescription} from "@rev-net/core-v6/src/structs/REVDescription.sol";
import {JBTokenDistributor} from "@bananapus/distributor-v6/src/JBTokenDistributor.sol";
import {JBStickyDeployer} from "@bananapus/sticky-v6/src/JBStickyDeployer.sol";
import {JBStickyToken} from "@bananapus/sticky-v6/src/JBStickyToken.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {
    HomerunIncomeDeployer,
    HomerunIncomeChainConfig,
    HomerunInitialIncomeAllocation,
    HomerunInitialIncomeSnapshot
} from "../src/HomerunIncomeDeployer.sol";
import {HomerunInitialIncomeVault} from "../src/HomerunInitialIncomeVault.sol";

/// @notice Actual local Juicebox/Revnet deployment and reserved-token routing, with no mocked protocol calls.
/// @dev Uses the canonical registry's supported no-AMM fallback and a real fixed USD/USDC matching price feed.
contract HomerunIncomeDeployerIntegrationTest is TestBaseWorkflow {
    address private constant OPERATOR = address(0x100);
    address private constant ALICE = address(0x200);
    address private constant BOB = address(0x300);
    address private constant CUSTOMER = address(0x400);
    address private constant FORWARDER = address(0x500);
    bytes32 private constant LAUNCH_SALT = bytes32(uint256(2));
    uint48 private constant STARTS_AT = 1_000_001;
    uint256 private _fundId;
    uint256 private _feeProjectId;
    uint256 private _beforeCcipSnapshot;
    bool private _useOmnichainFund;
    uint256 private _stickyId;
    REVDeployer private _revDeployer;
    REVOwner private _revOwner;
    REVLoans private _loans;
    JBSuckerRegistry private _suckers;
    JBOmnichainDeployer private _omnichain;
    JBCCIPSuckerDeployer private _ccipToEthereum;
    JBCCIPSuckerDeployer private _ccipToOptimism;
    JBTokenDistributor private _distributor;
    HomerunIncomeDeployer private _helper;
    JBERC20 private _fundToken;
    JBStickyDeployer private _sticky;
    JBStickyToken private _share;
    HomerunInitialIncomeVault private _vault;

    struct SnapshotFixture {
        HomerunInitialIncomeSnapshot snapshot;
        address[] holders;
        uint256[] balances;
        uint256[] allocations;
        bytes32[] tree;
        uint256[] treeIndices;
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
        _revDeployer = new REVDeployer(
            jbController(),
            jbMultiTerminal(),
            IJBTerminal(address(0)),
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
        _distributor = new JBTokenDistributor(
            jbDirectory(), jbController(), IREVLoans(address(0)), IREVOwner(address(0)), 7 days, 4, uint48(3 * 365 days)
        );
        _sticky = new JBStickyDeployer(jbController(), jbMultiTerminal());
        _omnichain = JBOmnichainDeployer(
            deployCode(
                "JBOmnichainDeployer.sol:JBOmnichainDeployer",
                abi.encode(_suckers, _hookDeployer(), jbPermissions(), jbController(), FORWARDER)
            )
        );
        _helper = new HomerunIncomeDeployer(_chainConfigs());
        JBMatchingPriceFeed matchingFeed = new JBMatchingPriceFeed();
        vm.prank(multisig());
        jbPrices().addPriceFeedFor(0, 2, uint32(uint160(address(usdcToken()))), matchingFeed);
        _createAndCloseFund();
        _createSticky();
        _beforeCcipSnapshot = vm.snapshotState();
        _ccipToOptimism = _ccipDeployer(10, feeProjectId);
    }

    function _createSticky() private {
        _stickyId = _sticky.deployStickyFor(
            IERC20Metadata(address(_fundToken)),
            "House reward share",
            "SHARE",
            "ipfs://share",
            0,
            new address[](0),
            false
        );
        _share = JBStickyToken(address(jbTokens().tokenOf(_stickyId)));
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

    function _chainConfigs() private view returns (HomerunIncomeChainConfig[] memory chains) {
        chains = new HomerunIncomeChainConfig[](2);
        for (uint256 i; i < chains.length; ++i) {
            chains[i] = HomerunIncomeChainConfig({
                chainId: i == 0 ? 1 : 10,
                controller: address(jbController()),
                revDeployer: address(_revDeployer),
                tokenDistributor: address(_distributor),
                usdc: address(usdcToken()),
                stickyDeployer: address(_sticky),
                omnichainDeployer: address(_omnichain)
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
        JBRulesetConfig[] memory rulesets = new JBRulesetConfig[](1);
        rulesets[0].weight = 1 ether;
        rulesets[0].metadata.baseCurrency = 2;
        rulesets[0].metadata.allowOwnerMinting = true;
        rulesets[0].metadata.pausePay = true;
        rulesets[0].metadata.cashOutTaxRate = 10_000;
        JBTerminalConfig[] memory terminals = new JBTerminalConfig[](1);
        terminals[0].terminal = jbMultiTerminal();
        terminals[0].accountingContextsToAccept = new JBAccountingContext[](1);
        terminals[0].accountingContextsToAccept[0] = JBAccountingContext({
            token: address(usdcToken()), decimals: 6, currency: uint32(uint160(address(usdcToken())))
        });
        if (_useOmnichainFund) {
            JBSuckerDeploymentConfig memory noSuckers;
            (_fundId,,) = _omnichain.launchProjectFor(OPERATOR, "ipfs://fund", rulesets, terminals, "", noSuckers);
        } else {
            _fundId = jbController().launchProjectFor(OPERATOR, "ipfs://fund", rulesets, terminals, "");
        }
        vm.startPrank(OPERATOR);
        jbController().mintTokensOf(_fundId, 100 ether, OPERATOR, "operator share after purchase", false);
        jbController().mintTokensOf(_fundId, 300 ether, ALICE, "offchain contribution after purchase", false);
        jbController().mintTokensOf(_fundId, 100 ether, BOB, "offchain contribution after purchase", false);
        _fundToken = JBERC20(address(jbController().deployERC20For(_fundId, "Fund", "FUND", bytes32(_fundId))));
        rulesets[0].metadata.allowOwnerMinting = false;
        if (_useOmnichainFund) {
            uint8[] memory permissionIds = new uint8[](1);
            permissionIds[0] = JBPermissionIds.QUEUE_RULESETS;
            jbPermissions()
                .setPermissionsFor(
                    OPERATOR,
                    JBPermissionsData({
                    operator: address(_omnichain), projectId: uint64(_fundId), permissionIds: permissionIds
                })
                );
            vm.warp(vm.getBlockTimestamp() + 1);
            _omnichain.queueRulesetsOf(_fundId, rulesets, "success allocations complete");
        } else {
            jbController().queueRulesetsOf(_fundId, rulesets, "success allocations complete");
        }
        vm.stopPrank();
        vm.prank(ALICE);
        jbController().claimTokensFor(ALICE, _fundId, 50 ether, ALICE);
        vm.warp(block.timestamp + 1);
        vm.roll(block.number + 1);
    }

    function _holders() private pure returns (address[] memory holders) {
        holders = new address[](3);
        holders[0] = OPERATOR;
        holders[1] = ALICE;
        holders[2] = BOB;
    }

    function _deploy(uint16 operatorBps) private returns (uint256 incomeId) {
        return _deploySnapshot(operatorBps, _snapshot(_holders()));
    }

    function _deploySnapshot(uint16 operatorBps, SnapshotFixture memory fixture) private returns (uint256 incomeId) {
        REVDescription memory description =
            REVDescription({name: "House income", ticker: "INCOME", uri: "ipfs://income", salt: LAUNCH_SALT});
        REVSuckerDeploymentConfig memory suckers = _suckerConfig(fixture.snapshot);
        vm.prank(OPERATOR);
        incomeId = _helper.deployIncome(
            _fundId, fixture.snapshot, description, operatorBps, 1000, _stickyId, STARTS_AT, suckers
        );
        _vault = HomerunInitialIncomeVault(_helper.initialAllocationVaultOf(_fundId));
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

    /// @dev Matches OpenZeppelin StandardMerkleTree: double-hashed ABI leaves, sorted leaves, complete binary heap,
    /// reverse leaf placement, and sorted-pair internal hashes. Balances are captured before any Sticky deposits.
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
            merkleRoot: bytes32(0),
            leafCount: holders.length,
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
        fixture = _buildTree(fixture, uint32(block.chainid));
        fixture.snapshot.allocations[0].merkleRoot = fixture.tree[0];
    }

    function _buildTree(SnapshotFixture memory fixture, uint32 chainId) private view returns (SnapshotFixture memory) {
        bytes32 domain = keccak256(
            abi.encode(
                _helper.DISTRIBUTION_TYPEHASH(),
                chainId,
                address(_helper),
                _fundId,
                fixture.snapshot.sourceSetHash,
                fixture.snapshot.totalFundSupply,
                LAUNCH_SALT
            )
        );
        bytes32[] memory leaves = new bytes32[](fixture.holders.length);
        uint256[] memory originalIndices = new uint256[](fixture.holders.length);
        for (uint256 i; i < fixture.holders.length; ++i) {
            leaves[i] = keccak256(
                bytes.concat(
                    keccak256(abi.encode(domain, i, fixture.holders[i], fixture.balances[i], fixture.allocations[i]))
                )
            );
            originalIndices[i] = i;
        }
        for (uint256 i = 1; i < leaves.length; ++i) {
            uint256 j = i;
            while (j != 0 && leaves[j - 1] > leaves[j]) {
                (leaves[j - 1], leaves[j]) = (leaves[j], leaves[j - 1]);
                (originalIndices[j - 1], originalIndices[j]) = (originalIndices[j], originalIndices[j - 1]);
                --j;
            }
        }
        fixture.tree = new bytes32[](2 * leaves.length - 1);
        fixture.treeIndices = new uint256[](leaves.length);
        for (uint256 i; i < leaves.length; ++i) {
            uint256 treeIndex = fixture.tree.length - 1 - i;
            fixture.tree[treeIndex] = leaves[i];
            fixture.treeIndices[originalIndices[i]] = treeIndex;
        }
        for (uint256 i = leaves.length - 1; i != 0;) {
            --i;
            bytes32 a = fixture.tree[2 * i + 1];
            bytes32 b = fixture.tree[2 * i + 2];
            fixture.tree[i] = a < b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
        }
        return fixture;
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
                merkleRoot: bytes32(0),
                leafCount: emptyOrigin && i == 0 ? 0 : 3,
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
            fixtures[i] = _buildTree(fixtures[i], rows[i].chainId);
            snapshot.allocations[i].merkleRoot = fixtures[i].tree[0];
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

    function _proof(SnapshotFixture memory fixture, uint256 index) private pure returns (bytes32[] memory proof) {
        uint256 treeIndex = fixture.treeIndices[index];
        uint256 length;
        for (uint256 i = treeIndex; i != 0; i = (i - 1) / 2) {
            ++length;
        }
        proof = new bytes32[](length);
        for (uint256 i; treeIndex != 0; ++i) {
            proof[i] = fixture.tree[treeIndex % 2 == 0 ? treeIndex - 1 : treeIndex + 1];
            treeIndex = (treeIndex - 1) / 2;
        }
    }

    function _claim(SnapshotFixture memory fixture, uint256 index) private {
        _vault.claim(
            index, fixture.holders[index], fixture.balances[index], fixture.allocations[index], _proof(fixture, index)
        );
    }

    function _activateFundRewards() private {
        address[] memory holders = _holders();
        for (uint256 i; i < holders.length; ++i) {
            address holder = holders[i];
            uint256 credit = jbTokens().creditBalanceOf(holder, _fundId);
            vm.startPrank(holder);
            if (credit != 0) jbController().claimTokensFor(holder, _fundId, credit, holder);
            uint256 balance = _fundToken.balanceOf(holder);
            _fundToken.approve(address(jbMultiTerminal()), balance);
            assertEq(
                jbMultiTerminal().pay(_stickyId, address(_fundToken), balance, holder, balance, "activate", ""), balance
            );
            vm.stopPrank();
            assertEq(_share.balanceOf(holder), balance);
            assertEq(_share.delegates(holder), holder);
            assertEq(_fundToken.balanceOf(holder), 0);
        }
        vm.roll(block.number + 1);
        assertEq(_share.getPastTotalActiveVotes(block.number - 1), 500 ether);
    }

    function _payAndDistribute(uint256 incomeId) private returns (uint256 customerTokens) {
        usdcToken().mint(CUSTOMER, 100e6);
        vm.startPrank(CUSTOMER);
        usdcToken().approve(address(jbMultiTerminal()), 100e6);
        customerTokens = jbMultiTerminal().pay(incomeId, address(usdcToken()), 100e6, CUSTOMER, 0, "revenue", "");
        vm.stopPrank();
        jbController().sendReservedTokensToSplitsOf(incomeId);
    }

    function testRealDeploymentAtomicallyMintsAllInitialIncome() public {
        SnapshotFixture memory fixture = _snapshot(_holders());
        uint256 incomeId = _deploySnapshot(7000, fixture);
        address vaultAddress = _helper.initialAllocationVaultOf(_fundId);
        HomerunInitialIncomeVault vault = HomerunInitialIncomeVault(vaultAddress);
        assertEq(_helper.incomeProjectIdOf(_fundId), incomeId);
        assertEq(jbProjects().ownerOf(_fundId), OPERATOR);
        assertEq(jbProjects().ownerOf(incomeId), address(_revOwner));
        assertTrue(_revOwner.isOperatorOf(incomeId, OPERATOR));
        assertFalse(_revOwner.isOperatorOf(incomeId, address(_helper)));
        assertEq(jbTokens().totalSupplyOf(incomeId), 500_000 ether);
        assertEq(jbTokens().tokenOf(incomeId).balanceOf(vaultAddress), 500_000 ether);
        assertEq(jbTokens().totalCreditSupplyOf(incomeId), 0);
        assertEq(vault.DISTRIBUTION_ID(), _helper.distributionIdFor(_fundId, fixture.snapshot, LAUNCH_SALT));
        assertEq(vault.MERKLE_ROOT(), fixture.snapshot.allocations[0].merkleRoot);
        assertEq(jbTokens().totalSupplyOf(_fundId), 500 ether);
        assertEq(jbTokens().creditBalanceOf(ALICE, _fundId), 250 ether);
        assertEq(_fundToken.balanceOf(ALICE), 50 ether);
        (JBRuleset memory ruleset, JBRulesetMetadata memory metadata) = jbController().currentRulesetOf(incomeId);
        assertEq(metadata.dataHook, address(_revOwner));
        assertEq(metadata.reservedPercent, 8000);
        assertEq(_revOwner.amountToAutoIssue(incomeId, ruleset.id, address(_helper)), 0);
        assertEq(jbController().pendingReservedTokenBalanceOf(incomeId), 0);
        assertEq(jbTokens().totalBalanceOf(address(_helper), incomeId), 0);
        for (uint256 i; i < fixture.holders.length; ++i) {
            _claim(fixture, i);
        }
        assertEq(jbTokens().totalBalanceOf(OPERATOR, incomeId), 100_000 ether);
        assertEq(jbTokens().totalBalanceOf(ALICE, incomeId), 300_000 ether);
        assertEq(jbTokens().totalBalanceOf(BOB, incomeId), 100_000 ether);
        assertEq(vault.totalClaimed(), 500_000 ether);
        assertEq(jbTokens().tokenOf(incomeId).balanceOf(vaultAddress), 0);
        assertEq(jbTokens().totalSupplyOf(incomeId), 500_000 ether);
    }

    function testRealInitialClaimsStayWithSnapshotHoldersAfterFundMovesAndCreditsAreClaimed() public {
        SnapshotFixture memory fixture = _snapshot(_holders());
        uint256 incomeId = _deploySnapshot(7000, fixture);
        vm.startPrank(ALICE);
        jbController().claimTokensFor(ALICE, _fundId, 250 ether, ALICE);
        _fundToken.transfer(CUSTOMER, 300 ether);
        vm.stopPrank();
        assertEq(jbTokens().totalBalanceOf(ALICE, _fundId), 0);
        vm.prank(CUSTOMER);
        _claim(fixture, 1);
        assertEq(jbTokens().totalBalanceOf(ALICE, incomeId), 300_000 ether);
        assertEq(jbTokens().totalBalanceOf(CUSTOMER, incomeId), 0);
        assertEq(_fundToken.getTotalActiveVotes(), 0);
        vm.expectRevert(HomerunInitialIncomeVault.AlreadyClaimed.selector);
        _claim(fixture, 1);
        assertEq(jbTokens().totalSupplyOf(incomeId), 500_000 ether);
    }

    function testRealPaymentRoutesSeventyTenTwentyToOperatorDistributorAndCustomer() public {
        uint256 incomeId = _deploy(7000);
        _activateFundRewards();
        assertEq(_payAndDistribute(incomeId), 200 ether);
        IJBToken income = jbTokens().tokenOf(incomeId);
        assertEq(income.balanceOf(CUSTOMER), 200 ether);
        assertEq(income.balanceOf(OPERATOR), 700 ether);
        assertEq(income.balanceOf(address(_distributor)), 100 ether);
        assertEq(_distributor.balanceOf(address(_share), IERC20(address(income))), 100 ether);
        assertEq(_distributor.balanceOf(address(_fundToken), IERC20(address(income))), 0);
        assertEq(jbTokens().totalSupplyOf(incomeId), 501_000 ether);
        assertEq(jbController().pendingReservedTokenBalanceOf(incomeId), 0);
        assertEq(jbTerminalStore().balanceOf(address(jbMultiTerminal()), incomeId, address(usdcToken())), 100e6);
    }

    function testRealOneHundredPercentReservedIssuanceAcceptsZeroCustomerTokens() public {
        uint256 incomeId = _deploy(9000);
        _activateFundRewards();
        assertEq(_payAndDistribute(incomeId), 0);
        IJBToken income = jbTokens().tokenOf(incomeId);
        assertEq(income.balanceOf(CUSTOMER), 0);
        assertEq(income.balanceOf(OPERATOR), 900 ether);
        assertEq(income.balanceOf(address(_distributor)), 100 ether);
        assertEq(_distributor.balanceOf(address(_share), IERC20(address(income))), 100 ether);
        assertEq(jbTokens().totalSupplyOf(incomeId), 501_000 ether);
    }

    function testRealActivatedShareHolderCollectsOngoingRewardsWithoutTouchingInitialAllocation() public {
        SnapshotFixture memory fixture = _snapshot(_holders());
        uint256 incomeId = _deploySnapshot(7000, fixture);
        _activateFundRewards();
        _payAndDistribute(incomeId);
        IERC20 income = IERC20(address(jbTokens().tokenOf(incomeId)));
        uint256[] memory tokenIds = new uint256[](1);
        tokenIds[0] = uint256(uint160(ALICE));
        IERC20[] memory rewards = new IERC20[](1);
        rewards[0] = income;
        vm.warp(_distributor.roundStartTimestamp(_distributor.currentRound() + 1));
        vm.prank(ALICE);
        _distributor.beginVesting(address(_share), tokenIds, rewards);
        uint256 vestingStart = vm.getBlockTimestamp();
        vm.warp(vestingStart + _distributor.ROUND_DURATION());
        vm.prank(ALICE);
        _distributor.collectVestedRewards(address(_share), tokenIds, rewards, ALICE);
        assertEq(income.balanceOf(ALICE), 15 ether, "one of four weekly vesting rounds");
        vm.warp(vestingStart + _distributor.ROUND_DURATION() * _distributor.VESTING_ROUNDS());
        vm.prank(ALICE);
        _distributor.collectVestedRewards(address(_share), tokenIds, rewards, ALICE);
        assertEq(income.balanceOf(ALICE), 60 ether);
        assertEq(income.balanceOf(address(_distributor)), 40 ether);
        assertEq(income.balanceOf(address(_vault)), 500_000 ether);
        _claim(fixture, 1);
        assertEq(income.balanceOf(ALICE), 300_060 ether);
        assertEq(jbTokens().totalBalanceOf(ALICE, _fundId), 0);
        assertEq(_share.balanceOf(ALICE), 300 ether);
        assertEq(jbTokens().totalSupplyOf(incomeId), 501_000 ether);
    }

    /// @notice Holder count does not enter launch calldata or the launch's onchain work.
    function testRealTinyFundFragmentationAllowsBoundedLaunchAndEveryClaim() public {
        address attacker = address(0x600);
        vm.prank(ALICE);
        _fundToken.transfer(attacker, 201);
        address[] memory fragmentedHolders = new address[](204);
        fragmentedHolders[0] = OPERATOR;
        fragmentedHolders[1] = ALICE;
        fragmentedHolders[2] = BOB;
        vm.startPrank(attacker);
        for (uint256 i; i < 201; ++i) {
            address recipient = address(uint160(0x1000 + i));
            _fundToken.transfer(recipient, 1);
            fragmentedHolders[i + 3] = recipient;
        }
        vm.stopPrank();
        assertEq(_fundToken.balanceOf(attacker), 0);
        assertEq(jbTokens().totalSupplyOf(_fundId), 500 ether);
        assertEq(_fundToken.balanceOf(fragmentedHolders[203]), 1);
        SnapshotFixture memory fixture = _snapshot(fragmentedHolders);
        uint256 launchGasBefore = gasleft();
        uint256 incomeId = _deploySnapshot(7000, fixture);
        uint256 launchGasUsed = launchGasBefore - gasleft();
        emit log_named_uint("Atomic launch gas with 204 snapshot holders", launchGasUsed);
        assertLt(launchGasUsed, 4_000_000, "launch excludes holder enumeration and claim execution");
        HomerunInitialIncomeVault vault = HomerunInitialIncomeVault(_helper.initialAllocationVaultOf(_fundId));
        assertEq(vault.LEAF_COUNT(), 204);
        assertEq(jbTokens().tokenOf(incomeId).balanceOf(address(vault)), 500_000 ether);
        assertEq(jbTokens().totalSupplyOf(incomeId), 500_000 ether);
        for (uint256 i; i < fixture.holders.length; ++i) {
            _claim(fixture, i);
            assertEq(jbTokens().totalBalanceOf(fixture.holders[i], incomeId), fixture.allocations[i]);
        }
        assertEq(jbTokens().totalBalanceOf(fragmentedHolders[203], incomeId), 1000);
        assertEq(vault.totalClaimed(), 500_000 ether);
        assertEq(jbTokens().tokenOf(incomeId).balanceOf(address(vault)), 0);
        assertEq(jbTokens().totalSupplyOf(_fundId), 500 ether);
    }

    function testRealOperatorCannotRedirectEitherReservedAllocationInAnyStage() public {
        uint256 incomeId = _deploy(7000);
        (JBRuleset memory current,) = jbController().currentRulesetOf(incomeId);
        (JBRuleset memory last,,) = jbController().latestQueuedRulesetOf(incomeId);
        uint256[2] memory stageIds = [uint256(current.id), uint256(last.id)];
        assertTrue(stageIds[0] != stageIds[1]);
        for (uint256 i; i < 2; ++i) {
            JBSplit[] memory splits = jbSplits().splitsOf(incomeId, stageIds[i], JBSplitGroupIds.RESERVED_TOKENS);
            assertEq(splits.length, 2);
            assertEq(splits[0].lockedUntil, type(uint48).max);
            assertEq(splits[1].lockedUntil, type(uint48).max);
            assertEq(splits[1].beneficiary, address(_share));
            assertEq(address(splits[1].hook), address(_distributor));
            JBSplitGroup[] memory groups = new JBSplitGroup[](1);
            groups[0] = JBSplitGroup({groupId: JBSplitGroupIds.RESERVED_TOKENS, splits: splits});
            groups[0].splits[1].beneficiary = payable(CUSTOMER);
            vm.expectRevert(
                abi.encodeWithSelector(
                    JBSplits.JBSplits_PreviousLockedSplitsNotIncluded.selector, incomeId, stageIds[i]
                )
            );
            vm.prank(OPERATOR);
            jbController().setSplitGroupsOf(incomeId, stageIds[i], groups);
            groups[0].splits[1].beneficiary = payable(address(_share));
            groups[0].splits[0].beneficiary = payable(CUSTOMER);
            vm.expectRevert(
                abi.encodeWithSelector(
                    JBSplits.JBSplits_PreviousLockedSplitsNotIncluded.selector, incomeId, stageIds[i]
                )
            );
            vm.prank(OPERATOR);
            jbController().setSplitGroupsOf(incomeId, stageIds[i], groups);
        }
    }

    function _assertLocalAllocation(uint256 incomeId, uint256 expected) private view {
        assertEq(jbTokens().totalSupplyOf(incomeId), expected);
        assertEq(_vault.LOCAL_INITIAL_INCOME_SUPPLY(), expected);
        assertEq(jbTokens().tokenOf(incomeId).balanceOf(address(_vault)), expected);
        assertEq(jbTokens().totalBalanceOf(address(_helper), incomeId), 0);
        assertEq(jbController().pendingReservedTokenBalanceOf(incomeId), 0);
        assertEq(_revOwner.amountToAutoIssue(incomeId, block.timestamp, address(_helper)), 0);
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
        uint256 originIncomeId = _deploySnapshot(7000, fixtures[0]);
        _assertLocalAllocation(originIncomeId, 250_000 ether);
        bytes32 originHash = _revDeployer.hashedEncodedConfigurationOf(originIncomeId);
        address originIncomeToken = address(jbTokens().tokenOf(originIncomeId));
        address originSucker = _assertCcipRoute(originIncomeId, 10);
        uint256 originSupply = jbTokens().totalSupplyOf(originIncomeId);
        for (uint256 i; i < 3; ++i) {
            _claim(fixtures[0], i);
        }
        assertEq(jbTokens().totalBalanceOf(ALICE, originIncomeId), 150_000 ether);

        _switchToIsolatedOptimism(fixtures[1].snapshot, STARTS_AT + 3 days);
        uint256 remoteIncomeId = _deploySnapshot(7000, fixtures[1]);
        _assertLocalAllocation(remoteIncomeId, 250_000 ether);
        assertEq(_revDeployer.hashedEncodedConfigurationOf(remoteIncomeId), originHash);
        assertEq(address(jbTokens().tokenOf(remoteIncomeId)), originIncomeToken);
        assertEq(_assertCcipRoute(remoteIncomeId, 1), originSucker);
        assertEq(originSupply + jbTokens().totalSupplyOf(remoteIncomeId), 500_000 ether);
        for (uint256 i; i < 3; ++i) {
            _claim(fixtures[1], i);
        }
        assertEq(jbTokens().totalBalanceOf(ALICE, remoteIncomeId), 150_000 ether);
        assertEq(_vault.totalClaimed(), 250_000 ether);
    }

    function testRealZeroLocalAllocationLeavesAllFiveHundredThousandForRemoteChain() public {
        SnapshotFixture[2] memory fixtures = _globalSnapshots(true);
        uint256 originIncomeId = _deploySnapshot(7000, fixtures[0]);
        _assertLocalAllocation(originIncomeId, 0);
        assertEq(_vault.LEAF_COUNT(), 0);
        assertEq(_vault.MERKLE_ROOT(), bytes32(0));
        assertEq(jbTokens().totalSupplyOf(_fundId), 0);
        bytes32 originHash = _revDeployer.hashedEncodedConfigurationOf(originIncomeId);
        address originSucker = _assertCcipRoute(originIncomeId, 10);

        _switchToIsolatedOptimism(fixtures[1].snapshot, STARTS_AT + 1 days);
        uint256 remoteIncomeId = _deploySnapshot(7000, fixtures[1]);
        _assertLocalAllocation(remoteIncomeId, 500_000 ether);
        assertEq(_revDeployer.hashedEncodedConfigurationOf(remoteIncomeId), originHash);
        assertEq(_assertCcipRoute(remoteIncomeId, 1), originSucker);
        for (uint256 i; i < 3; ++i) {
            _claim(fixtures[1], i);
        }
        assertEq(_vault.totalClaimed(), 500_000 ether);
        assertEq(jbTokens().totalBalanceOf(ALICE, remoteIncomeId), 300_000 ether);
    }

    function testRealLaunchAfterEightQuartersConsumesFirstStagePremintAndPreservesIdentity() public {
        SnapshotFixture[2] memory fixtures = _globalSnapshots(false);
        uint256 originIncomeId = _deploySnapshot(7000, fixtures[0]);
        bytes32 originHash = _revDeployer.hashedEncodedConfigurationOf(originIncomeId);
        address originSucker = _assertCcipRoute(originIncomeId, 10);
        uint256 lateTimestamp = uint256(STARTS_AT) + uint256(_helper.QUARTER()) * 8 + 1 days;
        _switchToIsolatedOptimism(fixtures[1].snapshot, lateTimestamp);
        uint256 remoteIncomeId = _deploySnapshot(7000, fixtures[1]);
        _assertLocalAllocation(remoteIncomeId, 250_000 ether);
        assertEq(_revDeployer.hashedEncodedConfigurationOf(remoteIncomeId), originHash);
        assertEq(_assertCcipRoute(remoteIncomeId, 1), originSucker);
        (JBRuleset memory current,) = jbController().currentRulesetOf(remoteIncomeId);
        (JBRuleset memory first,) = jbController().getRulesetOf(remoteIncomeId, lateTimestamp);
        assertEq(first.id, lateTimestamp);
        assertEq(current.id, lateTimestamp + 1, "the live ruleset is already the fixed-issuance second stage");
        assertEq(current.weightCutPercent, 0);
        assertEq(_revOwner.amountToAutoIssue(remoteIncomeId, first.id, address(_helper)), 0);
        _claim(fixtures[1], 1);
        assertEq(jbTokens().totalBalanceOf(ALICE, remoteIncomeId), 150_000 ether);
    }

    function testRealCanonicalOmnichainFundHookCanLaunchIncomeAfterClosing() public {
        _useOmnichainFund = true;
        _createAndCloseFund();
        _createSticky();
        (JBRuleset memory current, JBRulesetMetadata memory metadata) = jbController().currentRulesetOf(_fundId);
        assertEq(metadata.dataHook, address(_omnichain));
        assertTrue(metadata.pausePay);
        assertFalse(metadata.allowOwnerMinting);
        JBDeployerHookConfig memory extra = _omnichain.extraDataHookOf(_fundId, current.id);
        assertEq(address(extra.dataHook), address(0));
        assertFalse(extra.useDataHookForPay);
        assertFalse(extra.useDataHookForCashOut);
        uint256 incomeId = _deploy(7000);
        _assertLocalAllocation(incomeId, 500_000 ether);
        assertEq(_helper.incomeProjectIdOf(_fundId), incomeId);
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
        snapshot.allocations[0] = HomerunInitialIncomeAllocation(1, 7, 99, bytes32(uint256(11)), bytes32(0), 0, 0);
        snapshot.allocations[1] = HomerunInitialIncomeAllocation(
            10, 8, 100, bytes32(uint256(12)), bytes32(uint256(21)), 2, uint104(200_000 ether)
        );
        snapshot.allocations[2] = HomerunInitialIncomeAllocation(
            8453, 9, 101, bytes32(uint256(13)), bytes32(uint256(22)), 3, uint104(300_000 ether)
        );
        bytes32 configurationSalt = _helper.configurationSaltFor(snapshot, bytes32(uint256(3)));
        assertEq(configurationSalt, 0x5eb066edce4131b5cc292e75da46a3303f7915f03506cc9a543b160f27ffcd9a);

        REVConfig memory config;
        config.description = REVDescription("Global INCOME vector", "INCOME", "ipfs://vector", configurationSalt);
        config.baseCurrency = 2;
        config.operator = OPERATOR;
        config.scopeCashOutsToLocalBalances = false;
        config.stageConfigurations = new REVStageConfig[](2);
        JBSplit[] memory splits = new JBSplit[](1);
        splits[0].percent = 1_000_000_000;
        splits[0].beneficiary = payable(OPERATOR);
        splits[0].lockedUntil = type(uint48).max;
        REVAutoIssuance[] memory issuances = new REVAutoIssuance[](3);
        for (uint256 i; i < 3; ++i) {
            issuances[i] = REVAutoIssuance(
                snapshot.allocations[i].chainId,
                snapshot.allocations[i].incomeAmount,
                address(0x1111111111111111111111111111111111111111)
            );
        }
        config.stageConfigurations[0] =
            REVStageConfig(1_000_001, issuances, 8000, splits, 10 ether, 7_884_000, 50_000_000, 0, 4);
        config.stageConfigurations[1] =
            REVStageConfig(1_000_001 + 7_884_000 * 8, new REVAutoIssuance[](0), 8000, splits, 1, 0, 0, 0, 4);
        JBAccountingContext[] memory contexts = new JBAccountingContext[](1);
        contexts[0] = JBAccountingContext(address(usdcToken()), 6, uint32(uint160(address(usdcToken()))));
        REVSuckerDeploymentConfig memory suckers;
        REVDeploy721TiersHookConfig memory nft;
        nft.baseline721HookConfiguration.name = config.description.name;
        nft.baseline721HookConfiguration.symbol = "INCOME";
        nft.baseline721HookConfiguration.tiersConfig.currency = 2;
        nft.baseline721HookConfiguration.tiersConfig.decimals = 6;
        (uint256 incomeId,) = _revDeployer.deployFor(0, config, contexts, suckers, nft, new REVCroptopAllowedPost[](0));
        assertEq(
            _revDeployer.hashedEncodedConfigurationOf(incomeId),
            0xeb3e51db9fd832db60a8a71e1ea05270bb8ca57185a7cce3fa8ebfd8888828e6
        );
    }
}
