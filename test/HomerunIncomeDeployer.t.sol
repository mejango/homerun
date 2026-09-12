// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {JBRulesets} from "@bananapus/core-v6/src/JBRulesets.sol";
import {IJBDirectory} from "@bananapus/core-v6/src/interfaces/IJBDirectory.sol";
import {IJBRulesetApprovalHook} from "@bananapus/core-v6/src/interfaces/IJBRulesetApprovalHook.sol";
import {
    HomerunIncomeDeployer,
    HomerunIncomeChainConfig,
    HomerunInitialIncomeSnapshot,
    HomerunInitialIncomeAllocation
} from "../src/HomerunIncomeDeployer.sol";
import {HomerunInitialIncomeVault} from "../src/HomerunInitialIncomeVault.sol";
import {JBRuleset} from "@bananapus/core-v6/src/structs/JBRuleset.sol";
import {JBRulesetMetadata} from "@bananapus/core-v6/src/structs/JBRulesetMetadata.sol";
import {JBAccountingContext} from "@bananapus/core-v6/src/structs/JBAccountingContext.sol";
import {REVConfig} from "@rev-net/core-v6/src/structs/REVConfig.sol";
import {REVDescription} from "@rev-net/core-v6/src/structs/REVDescription.sol";
import {REVAutoIssuance} from "@rev-net/core-v6/src/structs/REVAutoIssuance.sol";
import {REVSuckerDeploymentConfig} from "@rev-net/core-v6/src/structs/REVSuckerDeploymentConfig.sol";
import {REVDeploy721TiersHookConfig} from "@rev-net/core-v6/src/structs/REVDeploy721TiersHookConfig.sol";
import {JBSuckerDeployerConfig} from "@bananapus/suckers-v6/src/structs/JBSuckerDeployerConfig.sol";
import {JBTokenMapping} from "@bananapus/suckers-v6/src/structs/JBTokenMapping.sol";
import {IJBSuckerDeployer} from "@bananapus/suckers-v6/src/interfaces/IJBSuckerDeployer.sol";
import {REVCroptopAllowedPost} from "@rev-net/core-v6/src/structs/REVCroptopAllowedPost.sol";

contract IncomeTestToken {
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;

    function mint(address account, uint256 amount) external {
        balanceOf[account] += amount;
        totalSupply += amount;
    }

    bool public failTransfer;

    function setFailTransfer(bool value) external {
        failTransfer = value;
    }

    function transfer(address beneficiary, uint256 amount) external returns (bool) {
        require(!failTransfer, "transfer failed");
        balanceOf[msg.sender] -= amount;
        balanceOf[beneficiary] += amount;
        return true;
    }

    function decimals() external pure returns (uint8) {
        return 6;
    }
}

contract IncomeTestTokens {
    address public immutable TOKEN = address(new IncomeTestToken());
    mapping(uint256 => address) public tokenOf;
    mapping(address => mapping(uint256 => uint256)) public creditBalanceOf;
    mapping(uint256 => uint256) public totalCreditSupplyOf;

    function setToken(uint256 id, address token) external {
        tokenOf[id] = token;
    }

    function create(uint256 id) external {
        tokenOf[id] = Clones.clone(TOKEN);
    }

    function mint(uint256 id, address holder, uint256 amount) external {
        IncomeTestToken(tokenOf[id]).mint(holder, amount);
    }

    function credit(uint256 id, address holder, uint256 amount) external {
        creditBalanceOf[holder][id] += amount;
        totalCreditSupplyOf[id] += amount;
    }

    function totalSupplyOf(uint256 id) public view returns (uint256) {
        return totalCreditSupplyOf[id] + IncomeTestToken(tokenOf[id]).totalSupply();
    }

    function totalBalanceOf(address holder, uint256 id) external view returns (uint256) {
        return creditBalanceOf[holder][id] + IncomeTestToken(tokenOf[id]).balanceOf(holder);
    }
}

contract IncomeTestProjects {
    uint256 public creationFee = 0.01 ether;
    uint256 public count = 1;
    mapping(uint256 => address) public ownerOf;

    function setOwner(uint256 id, address owner) external {
        ownerOf[id] = owner;
    }

    function createFor(address owner) external payable returns (uint256 id) {
        require(msg.value == creationFee, "fee");
        id = ++count;
        ownerOf[id] = owner;
    }
}

contract IncomeTestDirectory {
    address public controller;
    address public terminal;

    function setTerminal(address value) external {
        terminal = value;
    }

    function primaryTerminalOf(uint256, address) external view returns (address) {
        return terminal;
    }

    function setController(address value) external {
        controller = value;
    }

    function controllerOf(uint256) external view returns (address) {
        return controller;
    }
}

contract IncomeTestController {
    address public immutable DIRECTORY;
    address public immutable PROJECTS;
    address public immutable TOKENS;
    mapping(uint256 => JBRuleset) private _rulesets;
    mapping(uint256 => JBRulesetMetadata) private _metadata;
    mapping(uint256 => uint256) public pendingReservedTokenBalanceOf;
    uint48 public latestRulesetOverride;
    uint48 public upcomingRulesetOverride;

    constructor(address directory, address projects, address tokens) {
        DIRECTORY = directory;
        PROJECTS = projects;
        TOKENS = tokens;
    }

    function setRuleset(uint256 id, JBRuleset memory ruleset, JBRulesetMetadata memory metadata) external {
        _rulesets[id] = ruleset;
        _metadata[id] = metadata;
    }

    function setPending(uint256 id, uint256 amount) external {
        pendingReservedTokenBalanceOf[id] = amount;
    }

    function getRulesetOf(uint256 id, uint256) external view returns (JBRuleset memory, JBRulesetMetadata memory) {
        return (_rulesets[id], _metadata[id]);
    }

    function currentRulesetOf(uint256 id) external view returns (JBRuleset memory, JBRulesetMetadata memory) {
        return (_rulesets[id], _metadata[id]);
    }

    function setFutureRulesetIds(uint48 latest, uint48 upcoming) external {
        latestRulesetOverride = latest;
        upcomingRulesetOverride = upcoming;
    }

    function latestQueuedRulesetOf(uint256 id)
        external
        view
        returns (JBRuleset memory ruleset, JBRulesetMetadata memory, uint8)
    {
        ruleset = _rulesets[id];
        if (latestRulesetOverride != 0) ruleset.id = latestRulesetOverride;
        return (ruleset, _metadata[id], 0);
    }

    function upcomingRulesetOf(uint256 id) external view returns (JBRuleset memory ruleset, JBRulesetMetadata memory) {
        ruleset.id = upcomingRulesetOverride;
        return (ruleset, _metadata[id]);
    }
}

contract IncomeTestSuckerRegistry {
    address public immutable DIRECTORY;
    address public immutable PROJECTS;
    bool public linked;

    constructor(address directory, address projects) {
        DIRECTORY = directory;
        PROJECTS = projects;
    }

    function setLinked(bool value) external {
        linked = value;
    }

    function allSuckersOf(uint256) external view returns (address[] memory) {
        return new address[](linked ? 1 : 0);
    }
}

contract IncomeTestRevOwner {
    address public immutable DIRECTORY;
    address public immutable PROJECTS;
    address public immutable CONTROLLER;
    IncomeTestTokens public immutable tokens;
    address public deployer;
    address public failBeneficiary;
    mapping(uint256 => mapping(uint256 => mapping(address => uint256))) public amountToAutoIssue;
    mapping(uint256 => address) public operatorOf;

    constructor(IncomeTestController controller) {
        CONTROLLER = address(controller);
        DIRECTORY = controller.DIRECTORY();
        PROJECTS = controller.PROJECTS();
        tokens = IncomeTestTokens(controller.TOKENS());
    }

    function setDeployer(address value) external {
        deployer = value;
    }

    function LOANS() external view returns (address) {
        return IncomeTestRevDeployer(deployer).LOANS();
    }

    function SUCKER_REGISTRY() external view returns (address) {
        return IncomeTestRevDeployer(deployer).SUCKER_REGISTRY();
    }

    function setFail(address value) external {
        failBeneficiary = value;
    }

    function initialize(uint256 id, uint256 stageId, address operator, REVAutoIssuance[] calldata issuances) external {
        operatorOf[id] = operator;
        for (uint256 i; i < issuances.length; ++i) {
            if (issuances[i].chainId == block.chainid) {
                amountToAutoIssue[id][stageId][issuances[i].beneficiary] += issuances[i].count;
            }
        }
    }

    function isOperatorOf(uint256 id, address operator) external view returns (bool) {
        return operatorOf[id] == operator;
    }

    function autoIssueFor(uint256 id, uint256 stageId, address beneficiary) external {
        require(beneficiary != failBeneficiary, "issuance failed");
        uint256 amount = amountToAutoIssue[id][stageId][beneficiary];
        require(amount != 0, "zero auto issuance");
        amountToAutoIssue[id][stageId][beneficiary] = 0;
        tokens.mint(id, beneficiary, amount);
    }
}

contract IncomeTestLoans {
    address public immutable CONTROLLER;
    address public immutable TERMINAL;

    constructor(address controller, address terminal) {
        CONTROLLER = controller;
        TERMINAL = terminal;
    }
}

contract IncomeTestRevDeployer {
    address public immutable CONTROLLER;
    address public immutable DIRECTORY;
    address public immutable PROJECTS;
    address public immutable OWNER;
    address public immutable LOANS;
    address public immutable MULTI_TERMINAL;
    address public immutable SUCKER_REGISTRY;
    bytes public lastConfig;
    bytes public lastNft;
    bytes public lastSuckers;
    address public feePayer;
    uint256 public observedReservation;
    bool public attemptReentry;
    bool public reentrySucceeded;
    bool public failTransfer;

    function setFailTransfer(bool value) external {
        failTransfer = value;
    }

    constructor(IncomeTestController controller, address owner, address registry) {
        CONTROLLER = address(controller);
        DIRECTORY = controller.DIRECTORY();
        PROJECTS = controller.PROJECTS();
        OWNER = owner;
        SUCKER_REGISTRY = registry;
        MULTI_TERMINAL = address(new IncomeTestToken());
        LOANS = address(new IncomeTestLoans(CONTROLLER, MULTI_TERMINAL));
    }

    function setAttemptReentry(bool value) external {
        attemptReentry = value;
    }

    function deployFor(
        uint256 id,
        REVConfig calldata config,
        JBAccountingContext[] calldata contexts,
        REVSuckerDeploymentConfig calldata suckers,
        REVDeploy721TiersHookConfig calldata nft,
        REVCroptopAllowedPost[] calldata posts
    )
        external
        payable
        returns (uint256 newId, address hook)
    {
        require(
            id == 0 && contexts.length == 1 && contexts[0].decimals == 6
                && contexts[0].currency == uint32(uint160(contexts[0].token)),
            "config"
        );
        require(posts.length == 0, "extras");
        lastConfig = abi.encode(config);
        lastNft = abi.encode(nft);
        lastSuckers = abi.encode(suckers);
        feePayer = HomerunIncomeDeployer(msg.sender).originalPayer();
        observedReservation = HomerunIncomeDeployer(msg.sender).incomeProjectIdOf(1);
        if (attemptReentry) {
            reentrySucceeded = IncomeTestOwner(config.operator).reenter();
        }
        return (_launch(config), address(0));
    }

    function _launch(REVConfig calldata config) private returns (uint256 newId) {
        newId = IncomeTestProjects(PROJECTS).createFor{value: msg.value}(OWNER);
        IncomeTestController controller = IncomeTestController(CONTROLLER);
        IncomeTestTokens(controller.TOKENS()).create(newId);
        if (failTransfer) IncomeTestToken(IncomeTestTokens(controller.TOKENS()).tokenOf(newId)).setFailTransfer(true);
        JBRuleset memory ruleset;
        ruleset.id = uint48(block.timestamp);
        ruleset.start = uint48(block.timestamp);
        JBRulesetMetadata memory metadata;
        controller.setRuleset(newId, ruleset, metadata);
        IncomeTestRevOwner(OWNER)
            .initialize(newId, ruleset.id, config.operator, config.stageConfigurations[0].autoIssuances);
    }
}

contract IncomeTestOwner {
    HomerunIncomeDeployer private immutable _helper;
    HomerunInitialIncomeSnapshot private _snapshot;
    bytes4 public reentryError;

    constructor(HomerunIncomeDeployer helper, HomerunInitialIncomeSnapshot memory snapshot) {
        _helper = helper;
        _snapshot = snapshot;
    }

    function start() external payable returns (uint256) {
        return _helper.deployIncome{value: 0.01 ether}(
            1, _snapshot, _description(), 7000, 1000, 99, 1_000_000, _noSuckers(), address(this)
        );
    }

    function reenter() external returns (bool success) {
        bytes memory result;
        (success, result) = address(_helper).call{value: 0.01 ether}(
            abi.encodeCall(
                HomerunIncomeDeployer.deployIncome,
                (
                    1,
                    _snapshot,
                    _description(),
                    uint16(7000),
                    uint16(1000),
                    uint256(99),
                    uint48(1_000_000),
                    _noSuckers(),
                    address(this)
                )
            )
        );
        if (result.length >= 4) reentryError = bytes4(result);
    }

    function _noSuckers() private pure returns (REVSuckerDeploymentConfig memory configuration) {
        configuration.salt = bytes32(uint256(5));
    }

    function _description() private pure returns (REVDescription memory) {
        return REVDescription({name: "House income", ticker: "INCOME", uri: "ipfs://income", salt: bytes32(uint256(5))});
    }
}

contract IncomeTestStickyToken is IncomeTestToken {
    address public immutable HOOK;
    address public immutable TOKENS;
    uint256 public immutable PROJECT_ID;

    constructor(address hook, address tokens, uint256 projectId) {
        HOOK = hook;
        TOKENS = tokens;
        PROJECT_ID = projectId;
    }
}

contract IncomeTestStickyHook {
    address public immutable DEPLOYER;
    address public immutable DIRECTORY;
    mapping(uint256 => address) public tokenOf;

    constructor(address directory) {
        DEPLOYER = msg.sender;
        DIRECTORY = directory;
    }

    function setToken(uint256 id, address token) external {
        tokenOf[id] = token;
    }
}

contract IncomeTestStickyDeployer {
    address public immutable CONTROLLER;
    address public immutable TOKENS;
    address public immutable TERMINAL;
    address public immutable HOOK;
    mapping(uint256 => address) public stakedTokenOf;
    mapping(uint256 => uint256) public cashOutTaxRateOf;

    constructor(IncomeTestController controller, address terminal) {
        CONTROLLER = address(controller);
        TOKENS = controller.TOKENS();
        TERMINAL = terminal;
        HOOK = address(new IncomeTestStickyHook(controller.DIRECTORY()));
    }

    function create(uint256 id, address fundToken) external returns (address share) {
        share = address(new IncomeTestStickyToken(HOOK, TOKENS, id));
        stakedTokenOf[id] = fundToken;
        IncomeTestTokens(TOKENS).setToken(id, share);
        IncomeTestStickyHook(HOOK).setToken(id, share);
    }

    function setStake(uint256 id, address token, uint256 tax) external {
        stakedTokenOf[id] = token;
        cashOutTaxRateOf[id] = tax;
    }
}

contract IncomeTestOmnichainDeployer {
    address public immutable CONTROLLER;
    address public immutable DIRECTORY;
    address public immutable PROJECTS;
    address public immutable SUCKER_REGISTRY;
    address public HOOK_DEPLOYER;
    address public extraHook;
    bool public extraPay;
    bool public extraCashOut;

    constructor(IncomeTestController controller, address suckers) {
        CONTROLLER = address(controller);
        DIRECTORY = controller.DIRECTORY();
        PROJECTS = controller.PROJECTS();
        SUCKER_REGISTRY = suckers;
    }

    function setExtraHook(address hook, bool pay, bool cashOut) external {
        extraHook = hook;
        extraPay = pay;
        extraCashOut = cashOut;
    }

    function extraDataHookOf(uint256, uint256) external view returns (address, bool, bool) {
        return (extraHook, extraPay, extraCashOut);
    }

    function tiered721HookOf(uint256, uint256) external pure returns (address, bool) {
        return (address(0), false);
    }
}

contract IncomeTestCcipDeployer {
    uint256 public immutable ccipRemoteChainId;

    constructor(uint256 remoteChain) {
        ccipRemoteChainId = remoteChain;
    }
}

contract IncomeTestDistributor {
    uint256 public STARTING_TIMESTAMP = 1;
    uint256 public ROUND_DURATION = 7 days;
    uint256 public VESTING_ROUNDS = 4;
    uint48 public CLAIM_DURATION = uint48(3 * 365 days);

    function setTiming(uint256 roundDuration, uint256 vestingRounds, uint48 claimDuration) external {
        ROUND_DURATION = roundDuration;
        VESTING_ROUNDS = vestingRounds;
        CLAIM_DURATION = claimDuration;
    }
    address public immutable DIRECTORY;
    address public immutable CONTROLLER;
    address public immutable REV_OWNER;
    address public immutable REV_LOANS;

    constructor(IncomeTestRevDeployer deployer) {
        DIRECTORY = deployer.DIRECTORY();
        CONTROLLER = deployer.CONTROLLER();
        REV_OWNER = address(0);
        REV_LOANS = address(0);
    }
}

contract HomerunIncomeDeployerTest is Test {
    address private constant OPERATOR = address(0x100);
    address private constant ALICE = address(0x200);
    address private constant BOB = address(0x300);
    address private constant OWNER = address(0x400);
    IncomeTestTokens private tokens;
    IncomeTestProjects private projects;
    IncomeTestController private controller;
    IncomeTestDirectory private directory;
    IncomeTestSuckerRegistry private suckers;
    IncomeTestRevOwner private revOwner;
    IncomeTestRevDeployer private revDeployer;
    IncomeTestDistributor private distributor;
    IncomeTestStickyDeployer private sticky;
    IncomeTestOmnichainDeployer private omnichain;
    IncomeTestToken private usdc;
    HomerunIncomeDeployer private helper;
    HomerunInitialIncomeSnapshot private _snapshot;
    bytes32 private _distributionId;

    function setUp() public {
        vm.warp(1_000_000);
        vm.roll(100);
        vm.chainId(1);
        vm.deal(OPERATOR, 10 ether);
        tokens = new IncomeTestTokens();
        projects = new IncomeTestProjects();
        directory = new IncomeTestDirectory();
        controller = new IncomeTestController(address(directory), address(projects), address(tokens));
        directory.setController(address(controller));
        suckers = new IncomeTestSuckerRegistry(address(directory), address(projects));
        revOwner = new IncomeTestRevOwner(controller);
        revDeployer = new IncomeTestRevDeployer(controller, address(revOwner), address(suckers));
        revOwner.setDeployer(address(revDeployer));
        distributor = new IncomeTestDistributor(revDeployer);
        usdc = new IncomeTestToken();
        sticky = new IncomeTestStickyDeployer(controller, revDeployer.MULTI_TERMINAL());
        directory.setTerminal(revDeployer.MULTI_TERMINAL());
        omnichain = new IncomeTestOmnichainDeployer(controller, address(suckers));
        helper = new HomerunIncomeDeployer(_chains());
        projects.setOwner(1, OPERATOR);
        tokens.create(1);
        tokens.credit(1, OPERATOR, 100 ether);
        tokens.credit(1, ALICE, 250 ether);
        tokens.mint(1, ALICE, 50 ether);
        tokens.mint(1, BOB, 100 ether);
        sticky.create(99, tokens.tokenOf(1));
        projects.setOwner(99, address(sticky));
        _closed();
        _snapshot.sourceSetHash = keccak256("finalized source set");
        _snapshot.allocations.push();
        _snapshot.allocations[0].chainId = 1;
        _snapshot.allocations[0].fundProjectId = 1;
        _snapshot.allocations[0].incomeAmount = uint104(500_000 ether);
        _snapshot.allocations[0].snapshotBlockNumber = 99;
        _snapshot.allocations[0].snapshotBlockHash = keccak256("finalized block");
        vm.setBlockhash(99, _snapshot.allocations[0].snapshotBlockHash);
        _snapshot.totalFundSupply = 500 ether;
        _snapshot.allocations[0].leafCount = 3;
        _snapshot.manifestHash = keccak256("independently reconciled manifest");
        _snapshot.manifestUri = "ipfs://snapshot";
        _distributionId = helper.distributionIdFor(1, _snapshot, _description().salt);
        bytes32[] memory tree = _tree();
        _snapshot.allocations[0].merkleRoot = tree[0];
    }

    function _chains() private view returns (HomerunIncomeChainConfig[] memory chains) {
        chains = new HomerunIncomeChainConfig[](2);
        chains[0] = HomerunIncomeChainConfig({
            chainId: 1,
            controller: address(controller),
            revDeployer: address(revDeployer),
            tokenDistributor: address(distributor),
            usdc: address(usdc),
            stickyDeployer: address(sticky),
            omnichainDeployer: address(omnichain)
        });
        chains[1] = HomerunIncomeChainConfig({
            chainId: 10,
            controller: address(controller),
            revDeployer: address(revDeployer),
            tokenDistributor: address(distributor),
            usdc: address(usdc),
            stickyDeployer: address(sticky),
            omnichainDeployer: address(omnichain)
        });
    }

    function _noSuckers() private pure returns (REVSuckerDeploymentConfig memory configuration) {
        configuration.salt = bytes32(uint256(5));
    }

    function _closed() private {
        JBRuleset memory ruleset;
        ruleset.id = 10;
        ruleset.start = 10;
        JBRulesetMetadata memory metadata;
        metadata.pausePay = true;
        metadata.cashOutTaxRate = 10_000;
        controller.setRuleset(1, ruleset, metadata);
    }

    function _description() private pure returns (REVDescription memory) {
        return REVDescription({name: "House income", ticker: "INCOME", uri: "ipfs://income", salt: bytes32(uint256(5))});
    }

    function _deploy() private returns (uint256) {
        return _deployFor(OPERATOR, OPERATOR);
    }

    function _deployFor(address owner, address operator) private returns (uint256) {
        vm.prank(owner);
        return helper.deployIncome{value: 0.01 ether}(
            1, _snapshot, _description(), 7000, 1000, 99, 1_000_000, _noSuckers(), operator
        );
    }

    function _leaf(uint256 index) private view returns (bytes32) {
        address beneficiary = index == 0 ? OPERATOR : index == 1 ? ALICE : BOB;
        uint256 fundBalance = index == 1 ? 300 ether : 100 ether;
        uint256 incomeAmount = fundBalance * 1000;
        return
            keccak256(
                bytes.concat(keccak256(abi.encode(_distributionId, index, beneficiary, fundBalance, incomeAmount)))
            );
    }

    function _hashPair(bytes32 a, bytes32 b) private pure returns (bytes32) {
        return a < b ? keccak256(bytes.concat(a, b)) : keccak256(bytes.concat(b, a));
    }

    function _tree() private view returns (bytes32[] memory tree) {
        bytes32[3] memory sorted = [_leaf(0), _leaf(1), _leaf(2)];
        for (uint256 i; i < 3; ++i) {
            for (uint256 j = i + 1; j < 3; ++j) {
                if (sorted[j] < sorted[i]) (sorted[i], sorted[j]) = (sorted[j], sorted[i]);
            }
        }
        tree = new bytes32[](5);
        for (uint256 i; i < 3; ++i) {
            tree[4 - i] = sorted[i];
        }
        tree[1] = _hashPair(tree[3], tree[4]);
        tree[0] = _hashPair(tree[1], tree[2]);
    }

    function _proof(uint256 index) private view returns (bytes32[] memory proof) {
        bytes32[] memory tree = _tree();
        bytes32 leaf = _leaf(index);
        uint256 pos = 2;
        while (tree[pos] != leaf) ++pos;
        proof = new bytes32[](pos == 2 ? 1 : 2);
        uint256 i;
        while (pos != 0) {
            proof[i++] = tree[pos % 2 == 0 ? pos - 1 : pos + 1];
            pos = (pos - 1) / 2;
        }
    }

    function testLaunchAtomicallyFundsBoundVaultAndPreservesOwner() public {
        assertEq(helper.LAUNCH_VERSION(), 2);
        uint256 id = _deploy();
        HomerunInitialIncomeVault vault = HomerunInitialIncomeVault(helper.initialAllocationVaultOf(1));
        assertEq(id, 2);
        assertEq(helper.incomeProjectIdOf(1), id);
        assertEq(tokens.totalSupplyOf(id), 500_000 ether);
        assertEq(tokens.totalBalanceOf(address(vault), id), 500_000 ether);
        assertEq(tokens.totalBalanceOf(address(helper), id), 0);
        assertEq(tokens.totalBalanceOf(ALICE, id), 0);
        assertEq(vault.INCOME_PROJECT_ID(), id);
        assertEq(vault.FUND_PROJECT_ID(), 1);
        assertEq(address(vault.INCOME_TOKEN()), tokens.tokenOf(id));
        assertEq(vault.FACTORY(), address(helper));
        assertEq(vault.MERKLE_ROOT(), _snapshot.allocations[0].merkleRoot);
        assertEq(vault.DISTRIBUTION_ID(), _distributionId);
        assertEq(vault.TOTAL_FUND_SUPPLY(), 500 ether);
        assertEq(tokens.totalSupplyOf(1), 500 ether);
        assertEq(projects.ownerOf(id), address(revOwner));
        assertEq(revOwner.operatorOf(id), OPERATOR);
        assertEq(revDeployer.feePayer(), OPERATOR);
        assertEq(helper.originalPayer(), address(0));
        assertEq(revDeployer.observedReservation(), type(uint256).max);
        assertEq(revOwner.amountToAutoIssue(id, block.timestamp, address(helper)), 0);
        assertEq(controller.pendingReservedTokenBalanceOf(id), 0);
    }

    function testInactiveCreditsAndErc20HoldersClaimExistingIncome() public {
        uint256 id = _deploy();
        HomerunInitialIncomeVault vault = HomerunInitialIncomeVault(helper.initialAllocationVaultOf(1));
        vault.claim(0, OPERATOR, 100 ether, 100_000 ether, _proof(0));
        vault.claim(1, ALICE, 300 ether, 300_000 ether, _proof(1));
        vault.claim(2, BOB, 100 ether, 100_000 ether, _proof(2));
        assertEq(tokens.totalBalanceOf(ALICE, id), 300_000 ether);
        assertEq(tokens.totalBalanceOf(OPERATOR, id), 100_000 ether);
        assertEq(tokens.totalBalanceOf(BOB, id), 100_000 ether);
        assertEq(tokens.totalBalanceOf(address(vault), id), 0);
        assertEq(tokens.totalSupplyOf(id), 500_000 ether);
        assertEq(vault.totalClaimed(), 500_000 ether);
        assertEq(tokens.creditBalanceOf(ALICE, 1), 250 ether);
        assertEq(tokens.totalBalanceOf(ALICE, 1), 300 ether);
    }

    function testCorrectIncomeConfigurationWithEditableReservedSplits() public {
        _deploy();
        REVConfig memory config = abi.decode(revDeployer.lastConfig(), (REVConfig));
        assertEq(config.operator, OPERATOR);
        assertEq(config.baseCurrency, 2);
        assertFalse(config.scopeCashOutsToLocalBalances);
        assertEq(config.stageConfigurations.length, 2);
        assertEq(config.stageConfigurations[0].initialIssuance, 10 ether);
        assertEq(config.stageConfigurations[0].cashOutTaxRate, 0);
        assertEq(config.stageConfigurations[0].splitPercent, 8000);
        assertEq(config.stageConfigurations[0].issuanceCutFrequency, 7_884_000);
        assertEq(config.stageConfigurations[0].issuanceCutPercent, 50_000_000);
        assertEq(config.stageConfigurations[0].splits[0].percent, 875_000_000);
        assertEq(config.stageConfigurations[0].splits[0].beneficiary, OPERATOR);
        assertEq(config.stageConfigurations[0].splits[0].lockedUntil, 0);
        assertEq(config.stageConfigurations[0].splits[1].percent, 125_000_000);
        assertEq(config.stageConfigurations[0].splits[1].beneficiary, tokens.tokenOf(99));
        assertEq(address(config.stageConfigurations[0].splits[1].hook), address(distributor));
        assertEq(config.stageConfigurations[0].splits[1].lockedUntil, 0);
        assertEq(config.stageConfigurations[0].extraMetadata, 4);
        assertEq(config.stageConfigurations[1].startsAtOrAfter, block.timestamp + 7_884_000 * 8);
        assertEq(config.stageConfigurations[1].initialIssuance, 1);
        assertEq(config.stageConfigurations[1].issuanceCutFrequency, 0);
        assertEq(config.stageConfigurations[1].issuanceCutPercent, 0);
        REVDeploy721TiersHookConfig memory nft = abi.decode(revDeployer.lastNft(), (REVDeploy721TiersHookConfig));
        assertEq(nft.baseline721HookConfiguration.tiersConfig.currency, 2);
        assertEq(nft.baseline721HookConfiguration.tiersConfig.decimals, 6);
        assertEq(nft.baseline721HookConfiguration.tiersConfig.tiers.length, 0);
        assertTrue(
            nft.preventOperatorAdjustingTiers && nft.preventOperatorUpdatingMetadata && nft.preventOperatorMinting
                && nft.preventOperatorIncreasingDiscountPercent
        );
    }

    function testRealCoreAppliesExactlyEightCutsThenFreezes() public {
        _deploy();
        REVConfig memory config = abi.decode(revDeployer.lastConfig(), (REVConfig));
        directory.setController(address(this));
        JBRulesets rulesets = new JBRulesets(IJBDirectory(address(directory)));
        // Via-IR may assume block.timestamp stays constant within one transaction; use the cheatcode read
        // so repeated vm.warp calls cannot cause this captured starting timestamp to be re-evaluated.
        uint256 start = vm.getBlockTimestamp();
        for (uint256 i; i < 2; ++i) {
            rulesets.queueFor(
                2,
                config.stageConfigurations[i].issuanceCutFrequency,
                config.stageConfigurations[i].initialIssuance,
                config.stageConfigurations[i].issuanceCutPercent,
                IJBRulesetApprovalHook(address(0)),
                0,
                config.stageConfigurations[i].startsAtOrAfter
            );
        }
        uint256 expected = 10 ether;
        for (uint256 quarter; quarter <= 8; ++quarter) {
            vm.warp(start + 7_884_000 * quarter);
            assertEq(rulesets.currentOf(2).weight, expected, "actual core weight at quarter");
            if (quarter != 8) expected = expected * 95 / 100;
        }
        vm.warp(start + 7_884_000 * 100);
        assertEq(rulesets.currentOf(2).weight, expected, "issuance stays fixed after eighth cut");
    }

    function testUnauthorizedOwnerCannotLaunch() public {
        vm.expectRevert(HomerunIncomeDeployer.Unauthorized.selector);
        helper.deployIncome(1, _snapshot, _description(), 7000, 1000, 99, 1_000_000, _noSuckers(), OPERATOR);
    }

    function testOwnerRetainsAuthorityWhileSeparateOperatorReceivesBothStagesIncentives() public {
        projects.setOwner(1, OWNER);
        vm.deal(OWNER, 1 ether);
        vm.expectRevert(HomerunIncomeDeployer.Unauthorized.selector);
        _deployFor(OPERATOR, OPERATOR);
        _assertRollback();

        vm.expectEmit(true, true, true, false, address(helper));
        emit HomerunIncomeDeployer.IncomeDeployed(1, 2, OWNER, address(0), address(0), address(0), bytes32(0));
        uint256 id = _deployFor(OWNER, OPERATOR);
        REVConfig memory config = abi.decode(revDeployer.lastConfig(), (REVConfig));
        assertEq(projects.ownerOf(1), OWNER);
        assertEq(projects.ownerOf(id), address(revOwner));
        assertEq(config.operator, OWNER);
        assertTrue(revOwner.isOperatorOf(id, OWNER));
        assertFalse(revOwner.isOperatorOf(id, OPERATOR));
        assertEq(revDeployer.feePayer(), OWNER);
        assertEq(config.stageConfigurations.length, 2);
        for (uint256 i; i < config.stageConfigurations.length; ++i) {
            assertEq(config.stageConfigurations[i].splits[0].beneficiary, OPERATOR);
            assertEq(config.stageConfigurations[i].splits[0].percent, 875_000_000);
            assertEq(config.stageConfigurations[i].splits[0].lockedUntil, 0);
            assertEq(config.stageConfigurations[i].splits[1].lockedUntil, 0);
        }
    }

    function testZeroOperatorRejectedEvenWithoutOperatorIncentives() public {
        uint16[2] memory operatorPercents = [uint16(0), uint16(7000)];
        for (uint256 i; i < operatorPercents.length; ++i) {
            vm.expectRevert(HomerunIncomeDeployer.InvalidConfiguration.selector);
            vm.prank(OPERATOR);
            helper.deployIncome{value: 0.01 ether}(
                1, _snapshot, _description(), operatorPercents[i], 1000, 99, 1_000_000, _noSuckers(), address(0)
            );
            _assertRollback();
        }
    }

    function testRejectsLiveMintingAndPendingReservedTokens() public {
        (JBRuleset memory ruleset, JBRulesetMetadata memory metadata) = controller.currentRulesetOf(1);
        metadata.allowOwnerMinting = true;
        controller.setRuleset(1, ruleset, metadata);
        vm.expectRevert(HomerunIncomeDeployer.FundNotClosed.selector);
        _deploy();
        _closed();
        controller.setPending(1, 1);
        vm.expectRevert(HomerunIncomeDeployer.FundNotClosed.selector);
        _deploy();
    }

    function testLinkedFundIsCoveredByAttestedGlobalSnapshot() public {
        suckers.setLinked(true);
        assertEq(_deploy(), 2);
    }

    function testIssuanceFailureRollsBackProjectAndReservation() public {
        revOwner.setFail(address(helper));
        vm.expectRevert(bytes("issuance failed"));
        _deploy();
        _assertRollback();
        revOwner.setFail(address(0));
        assertEq(_deploy(), 2);
    }

    function testVaultFundingFailureRollsBackProjectAndReservation() public {
        revDeployer.setFailTransfer(true);
        vm.expectRevert(bytes("transfer failed"));
        _deploy();
        _assertRollback();
        revDeployer.setFailTransfer(false);
        assertEq(_deploy(), 2);
    }

    function _assertRollback() private view {
        assertEq(projects.count(), 1);
        assertEq(helper.incomeProjectIdOf(1), 0);
        assertEq(helper.initialAllocationVaultOf(1), address(0));
        assertEq(tokens.tokenOf(2), address(0));
        assertEq(address(helper).balance, 0);
        assertEq(helper.originalPayer(), address(0));
    }

    function testOnlyOneIncomeCanBeLaunchedForFund() public {
        _deploy();
        vm.expectRevert(HomerunIncomeDeployer.AlreadyDeployed.selector);
        _deploy();
        assertEq(projects.count(), 2);
    }

    function testExternalDeploymentCallbackCannotReenter() public {
        IncomeTestOwner operator = new IncomeTestOwner(helper, _snapshot);
        projects.setOwner(1, address(operator));
        vm.deal(address(operator), 0.02 ether);
        revDeployer.setAttemptReentry(true);
        operator.start();
        assertFalse(revDeployer.reentrySucceeded());
        assertEq(projects.count(), 2);
        assertEq(operator.reentryError(), bytes4(keccak256("ReentrancyGuardReentrantCall()")));
    }

    function testMismatchedDistributorRejected() public {
        vm.mockCall(address(distributor), abi.encodeWithSignature("REV_OWNER()"), abi.encode(address(0xdead)));
        vm.expectRevert(HomerunIncomeDeployer.InvalidProtocolWiring.selector);
        new HomerunIncomeDeployer(_chains());
    }

    function testDistributorWithoutRevnetLoansIsSupported() public {
        vm.mockCall(address(distributor), abi.encodeWithSignature("REV_OWNER()"), abi.encode(address(0)));
        vm.mockCall(address(distributor), abi.encodeWithSignature("REV_LOANS()"), abi.encode(address(0)));
        HomerunIncomeDeployer isolated = new HomerunIncomeDeployer(_chains());
        assertEq(isolated.TOKEN_DISTRIBUTOR(), address(distributor));
    }

    function testNewLaunchRejectsCanonicalRewardLoanDependencies() public {
        vm.mockCall(address(distributor), abi.encodeWithSignature("REV_OWNER()"), abi.encode(address(revOwner)));
        vm.mockCall(address(distributor), abi.encodeWithSignature("REV_LOANS()"), abi.encode(revDeployer.LOANS()));
        vm.expectRevert(HomerunIncomeDeployer.InvalidProtocolWiring.selector);
        new HomerunIncomeDeployer(_chains());
    }

    function testDistributorStartMustBePositiveAndNotInFuture() public {
        vm.mockCall(address(distributor), abi.encodeWithSignature("STARTING_TIMESTAMP()"), abi.encode(uint256(0)));
        vm.expectRevert(HomerunIncomeDeployer.InvalidProtocolWiring.selector);
        new HomerunIncomeDeployer(_chains());
        vm.mockCall(
            address(distributor), abi.encodeWithSignature("STARTING_TIMESTAMP()"), abi.encode(block.timestamp + 1)
        );
        vm.expectRevert(HomerunIncomeDeployer.InvalidProtocolWiring.selector);
        new HomerunIncomeDeployer(_chains());
    }

    function testDistributorMustMatchStockTiming() public {
        distributor.setTiming(1 days, 4, uint48(3 * 365 days));
        vm.expectRevert(HomerunIncomeDeployer.InvalidProtocolWiring.selector);
        new HomerunIncomeDeployer(_chains());
        distributor.setTiming(7 days, 1, uint48(3 * 365 days));
        vm.expectRevert(HomerunIncomeDeployer.InvalidProtocolWiring.selector);
        new HomerunIncomeDeployer(_chains());
        distributor.setTiming(7 days, 4, 0);
        vm.expectRevert(HomerunIncomeDeployer.InvalidProtocolWiring.selector);
        new HomerunIncomeDeployer(_chains());
    }

    function testHistoricalSnapshotDoesNotChangeAfterTransfer() public {
        IncomeTestToken fundToken = IncomeTestToken(tokens.tokenOf(1));
        vm.prank(ALICE);
        fundToken.transfer(BOB, 50 ether);
        uint256 id = _deploy();
        HomerunInitialIncomeVault vault = HomerunInitialIncomeVault(helper.initialAllocationVaultOf(1));
        vault.claim(1, ALICE, 300 ether, 300_000 ether, _proof(1));
        assertEq(tokens.totalBalanceOf(ALICE, id), 300_000 ether);
        assertEq(tokens.totalBalanceOf(ALICE, 1), 250 ether);
    }

    function testOldAttestedSnapshotCanExecuteAfterBlockhashWindow() public {
        vm.roll(1000);
        assertEq(_deploy(), 2);
    }

    function testRecentSnapshotHashMustMatchCanonicalBlock() public {
        vm.setBlockhash(99, keccak256("reorg"));
        vm.expectRevert(HomerunIncomeDeployer.InvalidSnapshot.selector);
        _deploy();
        _assertRollback();
    }

    function _useArbitrumSnapshot(uint32 chainId, uint256 snapshotHeight) private {
        vm.chainId(chainId);
        HomerunIncomeChainConfig[] memory chains = new HomerunIncomeChainConfig[](1);
        chains[0] = _chains()[0];
        chains[0].chainId = chainId;
        helper = new HomerunIncomeDeployer(chains);
        // Model a real precompile address with separate L2 height and hash, while EVM block.number remains 100.
        vm.etch(address(100), hex"00");
        vm.mockCall(address(100), abi.encodeWithSignature("arbBlockNumber()"), abi.encode(uint256(1001)));
        _snapshot.allocations[0].chainId = chainId;
        _snapshot.allocations[0].snapshotBlockNumber = snapshotHeight;
        vm.mockCall(
            address(100),
            abi.encodeWithSignature("arbBlockHash(uint256)", snapshotHeight),
            abi.encode(_snapshot.allocations[0].snapshotBlockHash)
        );
        _distributionId = helper.distributionIdFor(1, _snapshot, _description().salt);
        _snapshot.allocations[0].merkleRoot = _tree()[0];
    }

    function testArbitrumUsesL2SnapshotHeightAndHashInsteadOfL1Opcodes() public {
        _useArbitrumSnapshot(42_161, 1000);
        assertEq(_deploy(), 2);
        assertEq(HomerunInitialIncomeVault(helper.initialAllocationVaultOf(1)).SNAPSHOT_BLOCK_NUMBER(), 1000);
    }

    function testArbitrumSepoliaUsesL2SnapshotHeightAndHash() public {
        _useArbitrumSnapshot(421_614, 1000);
        assertEq(_deploy(), 2);
    }

    function testArbitrumRecentSnapshotHashMismatchRejectsLaunch() public {
        _useArbitrumSnapshot(42_161, 1000);
        vm.mockCall(
            address(100),
            abi.encodeWithSignature("arbBlockHash(uint256)", uint256(1000)),
            abi.encode(bytes32(uint256(9)))
        );
        vm.expectRevert(HomerunIncomeDeployer.InvalidSnapshot.selector);
        _deploy();
        _assertRollback();
    }

    function testArbitrumFutureL2SnapshotRejected() public {
        _useArbitrumSnapshot(42_161, 1001);
        vm.expectRevert(HomerunIncomeDeployer.InvalidSnapshot.selector);
        _deploy();
    }

    function testArbitrumOldAttestedSnapshotSkipsExpiredPrecompileHistory() public {
        _useArbitrumSnapshot(42_161, 700);
        vm.mockCallRevert(address(100), abi.encodeWithSignature("arbBlockHash(uint256)", uint256(700)), "expired");
        assertEq(_deploy(), 2);
    }

    function testRejectsIncompleteSnapshotCommitment() public {
        _snapshot.allocations[0].merkleRoot = bytes32(0);
        vm.expectRevert(HomerunIncomeDeployer.InvalidSnapshot.selector);
        _deploy();
    }

    function testFutureSnapshotRejected() public {
        _snapshot.allocations[0].snapshotBlockNumber = 100;
        vm.expectRevert(HomerunIncomeDeployer.InvalidSnapshot.selector);
        _deploy();
    }

    function testManySnapshotLeavesDoNotEnumerateOrBlockLaunch() public {
        _snapshot.allocations[0].leafCount = 1_000_000;
        assertEq(_deploy(), 2);
        assertEq(HomerunInitialIncomeVault(helper.initialAllocationVaultOf(1)).LEAF_COUNT(), 1_000_000);
    }

    function testCustomHookAndCustomFundTokenRejected() public {
        (JBRuleset memory ruleset, JBRulesetMetadata memory metadata) = controller.currentRulesetOf(1);
        metadata.dataHook = address(0x123);
        controller.setRuleset(1, ruleset, metadata);
        vm.expectRevert(HomerunIncomeDeployer.UnsupportedFund.selector);
        _deploy();
        _closed();
        vm.etch(tokens.tokenOf(1), hex"00");
        vm.expectRevert(HomerunIncomeDeployer.UnsupportedFund.selector);
        _deploy();
    }

    function testIncorrectCreationFeeDoesNotReserveFund() public {
        vm.prank(OPERATOR);
        vm.expectRevert(HomerunIncomeDeployer.WrongCreationFee.selector);
        helper.deployIncome{value: 1}(1, _snapshot, _description(), 7000, 1000, 99, 1_000_000, _noSuckers(), OPERATOR);
        assertEq(helper.incomeProjectIdOf(1), 0);
    }

    function testWrongStakeSourceOrExitTaxRejected() public {
        sticky.setStake(99, address(usdc), 0);
        vm.expectRevert(HomerunIncomeDeployer.UnsupportedRewardSource.selector);
        _deploy();
        sticky.setStake(99, tokens.tokenOf(1), 1);
        vm.expectRevert(HomerunIncomeDeployer.UnsupportedRewardSource.selector);
        _deploy();
    }

    function testStickyProjectMustRemainFactoryOwned() public {
        projects.setOwner(99, OPERATOR);
        vm.expectRevert(HomerunIncomeDeployer.UnsupportedRewardSource.selector);
        _deploy();
    }

    function testZeroCustomerAllocationIsSupported() public {
        vm.prank(OPERATOR);
        helper.deployIncome{value: 0.01 ether}(
            1, _snapshot, _description(), 9000, 1000, 99, 1_000_000, _noSuckers(), OPERATOR
        );
        REVConfig memory config = abi.decode(revDeployer.lastConfig(), (REVConfig));
        assertEq(config.stageConfigurations[0].splitPercent, 10_000);
        assertEq(config.stageConfigurations[0].splits[0].percent, 900_000_000);
        assertEq(config.stageConfigurations[0].splits[1].percent, 100_000_000);
    }

    function testZeroOperatorAllocationLeavesUnlockedHolderSplitInBothStages() public {
        vm.prank(OPERATOR);
        helper.deployIncome{value: 0.01 ether}(
            1, _snapshot, _description(), 0, 1000, 99, 1_000_000, _noSuckers(), OPERATOR
        );
        REVConfig memory config = abi.decode(revDeployer.lastConfig(), (REVConfig));
        for (uint256 i; i < config.stageConfigurations.length; ++i) {
            assertEq(config.stageConfigurations[i].splits.length, 1);
            assertEq(config.stageConfigurations[i].splits[0].percent, 1_000_000_000);
            assertEq(config.stageConfigurations[i].splits[0].beneficiary, tokens.tokenOf(99));
            assertEq(address(config.stageConfigurations[i].splits[0].hook), address(distributor));
            assertEq(config.stageConfigurations[i].splits[0].lockedUntil, 0);
        }
    }

    function _globalSnapshot(uint104 localAmount) private view returns (HomerunInitialIncomeSnapshot memory snapshot) {
        snapshot.sourceSetHash = _snapshot.sourceSetHash;
        snapshot.totalFundSupply = _snapshot.totalFundSupply;
        snapshot.manifestHash = _snapshot.manifestHash;
        snapshot.manifestUri = _snapshot.manifestUri;
        snapshot.allocations = new HomerunInitialIncomeAllocation[](2);
        snapshot.allocations[0] = _snapshot.allocations[0];
        snapshot.allocations[0].incomeAmount = localAmount;
        if (localAmount == 0) {
            snapshot.allocations[0].leafCount = 0;
            snapshot.allocations[0].merkleRoot = bytes32(0);
        }
        uint104 remoteAmount = uint104(500_000 ether) - localAmount;
        snapshot.allocations[1] = HomerunInitialIncomeAllocation({
            chainId: 10,
            fundProjectId: 7,
            snapshotBlockNumber: 89,
            snapshotBlockHash: keccak256("remote finalized block"),
            merkleRoot: remoteAmount == 0 ? bytes32(0) : keccak256("attested remote allocations"),
            leafCount: remoteAmount == 0 ? 0 : 1,
            incomeAmount: remoteAmount
        });
    }

    function _globalSuckers() private returns (REVSuckerDeploymentConfig memory configuration) {
        configuration.salt = _description().salt;
        configuration.deployerConfigurations = new JBSuckerDeployerConfig[](1);
        configuration.deployerConfigurations[0].deployer = IJBSuckerDeployer(address(new IncomeTestCcipDeployer(10)));
        configuration.deployerConfigurations[0].mappings = new JBTokenMapping[](1);
        configuration.deployerConfigurations[0].mappings[0] = JBTokenMapping({
            localToken: address(usdc), minGas: 200_000, remoteToken: bytes32(uint256(uint160(address(usdc))))
        });
    }

    function _deployGlobal(
        HomerunInitialIncomeSnapshot memory snapshot,
        REVSuckerDeploymentConfig memory configuration
    )
        private
        returns (uint256)
    {
        vm.prank(OPERATOR);
        return helper.deployIncome{value: 0.01 ether}(
            1, snapshot, _description(), 7000, 1000, 99, 1_000_000, configuration, OPERATOR
        );
    }

    function testPartialGlobalAllocationMintsOnlyLocalShare() public {
        HomerunInitialIncomeSnapshot memory snapshot = _globalSnapshot(uint104(120_000 ether));
        REVSuckerDeploymentConfig memory configuration = _globalSuckers();
        uint256 incomeId = _deployGlobal(snapshot, configuration);
        HomerunInitialIncomeVault vault = HomerunInitialIncomeVault(helper.initialAllocationVaultOf(1));
        assertEq(vault.LOCAL_INITIAL_INCOME_SUPPLY(), 120_000 ether);
        assertEq(tokens.totalSupplyOf(incomeId), 120_000 ether);
        assertEq(tokens.totalBalanceOf(address(vault), incomeId), 120_000 ether);
        assertEq(tokens.totalBalanceOf(address(helper), incomeId), 0);
        REVConfig memory config = abi.decode(revDeployer.lastConfig(), (REVConfig));
        assertEq(config.stageConfigurations[0].autoIssuances.length, 2);
        assertEq(config.stageConfigurations[0].autoIssuances[0].count, 120_000 ether);
        assertEq(config.stageConfigurations[0].autoIssuances[1].count, 380_000 ether);
        assertEq(config.stageConfigurations[0].autoIssuances[1].chainId, 10);
        assertEq(config.stageConfigurations[0].autoIssuances[1].beneficiary, address(helper));
        assertEq(config.description.salt, helper.configurationSaltFor(snapshot, _description().salt));
        assertEq(revOwner.amountToAutoIssue(incomeId, block.timestamp, address(helper)), 0);
    }

    function testZeroLocalAllocationDoesNotCallAutoIssueOrMint() public {
        HomerunInitialIncomeSnapshot memory snapshot = _globalSnapshot(0);
        REVSuckerDeploymentConfig memory configuration = _globalSuckers();
        uint256 incomeId = _deployGlobal(snapshot, configuration);
        HomerunInitialIncomeVault vault = HomerunInitialIncomeVault(helper.initialAllocationVaultOf(1));
        assertEq(vault.LOCAL_INITIAL_INCOME_SUPPLY(), 0);
        assertEq(vault.LEAF_COUNT(), 0);
        assertEq(vault.MERKLE_ROOT(), bytes32(0));
        assertEq(tokens.totalSupplyOf(incomeId), 0);
        REVConfig memory config = abi.decode(revDeployer.lastConfig(), (REVConfig));
        assertEq(config.stageConfigurations[0].autoIssuances[0].count, 0);
        assertEq(config.stageConfigurations[0].autoIssuances[1].count, 500_000 ether);
    }

    function testGlobalAllocationCannotMultiplyOrUnderfundInitialSupply() public {
        HomerunInitialIncomeSnapshot memory snapshot = _globalSnapshot(uint104(120_000 ether));
        REVSuckerDeploymentConfig memory configuration = _globalSuckers();
        snapshot.allocations[1].incomeAmount = uint104(500_000 ether);
        vm.expectRevert(HomerunIncomeDeployer.InvalidSnapshot.selector);
        _deployGlobal(snapshot, configuration);
        snapshot.allocations[1].incomeAmount = uint104(379_999 ether);
        vm.expectRevert(HomerunIncomeDeployer.InvalidSnapshot.selector);
        _deployGlobal(snapshot, configuration);
        assertEq(helper.incomeProjectIdOf(1), 0);
    }

    function testGlobalSnapshotRejectsDuplicateOrUnregisteredChains() public {
        HomerunInitialIncomeSnapshot memory snapshot = _globalSnapshot(uint104(120_000 ether));
        REVSuckerDeploymentConfig memory configuration = _globalSuckers();
        snapshot.allocations[1].chainId = 1;
        vm.expectRevert(HomerunIncomeDeployer.InvalidSnapshot.selector);
        _deployGlobal(snapshot, configuration);
        snapshot.allocations[1].chainId = 11;
        vm.expectRevert(HomerunIncomeDeployer.InvalidSnapshot.selector);
        _deployGlobal(snapshot, configuration);
    }

    function testGlobalSnapshotCannotOmitOrSubstituteLocalFund() public {
        HomerunInitialIncomeSnapshot memory snapshot = _globalSnapshot(uint104(120_000 ether));
        REVSuckerDeploymentConfig memory configuration = _globalSuckers();
        snapshot.allocations[0].fundProjectId = 55;
        vm.expectRevert(HomerunIncomeDeployer.InvalidSnapshot.selector);
        _deployGlobal(snapshot, configuration);
        snapshot.allocations[0].chainId = 2;
        vm.expectRevert(HomerunIncomeDeployer.InvalidSnapshot.selector);
        _deployGlobal(snapshot, configuration);
    }

    function testGlobalSnapshotAndManifestAreCommittedIntoRevnetIdentity() public view {
        HomerunInitialIncomeSnapshot memory snapshot = _globalSnapshot(uint104(120_000 ether));
        bytes32 beforeChange = helper.configurationSaltFor(snapshot, _description().salt);
        snapshot.allocations[1].merkleRoot = keccak256("changed remote root");
        bytes32 changedRoot = helper.configurationSaltFor(snapshot, _description().salt);
        assertNotEq(beforeChange, changedRoot);
        snapshot.manifestHash = keccak256("changed public manifest");
        assertNotEq(changedRoot, helper.configurationSaltFor(snapshot, _description().salt));
    }

    function testGlobalLaunchRequiresEveryRemoteSucker() public {
        HomerunInitialIncomeSnapshot memory snapshot = _globalSnapshot(uint104(120_000 ether));
        REVSuckerDeploymentConfig memory empty = _noSuckers();
        vm.expectRevert(HomerunIncomeDeployer.InvalidConfiguration.selector);
        _deployGlobal(snapshot, empty);
    }

    function testGlobalSuckerRejectsWrongPeerChainOrCurrency() public {
        HomerunInitialIncomeSnapshot memory snapshot = _globalSnapshot(uint104(120_000 ether));
        REVSuckerDeploymentConfig memory configuration = _globalSuckers();
        configuration.deployerConfigurations[0].peer = bytes32(uint256(1));
        vm.expectRevert(HomerunIncomeDeployer.InvalidConfiguration.selector);
        _deployGlobal(snapshot, configuration);
        configuration.deployerConfigurations[0].peer = bytes32(0);
        configuration.deployerConfigurations[0].mappings[0].remoteToken = bytes32(uint256(1));
        vm.expectRevert(HomerunIncomeDeployer.InvalidConfiguration.selector);
        _deployGlobal(snapshot, configuration);
        configuration.deployerConfigurations[0].mappings[0].remoteToken = bytes32(uint256(uint160(address(usdc))));
        configuration.deployerConfigurations[0].deployer =
            IJBSuckerDeployer(address(new IncomeTestCcipDeployer(42_161)));
        vm.expectRevert(HomerunIncomeDeployer.InvalidConfiguration.selector);
        _deployGlobal(snapshot, configuration);
    }

    function testCanonicalEmptyOmnichainHookIsAcceptedButExtraHooksAreRejected() public {
        (JBRuleset memory ruleset, JBRulesetMetadata memory metadata) = controller.currentRulesetOf(1);
        metadata.dataHook = address(omnichain);
        metadata.useDataHookForPay = true;
        metadata.useDataHookForCashOut = true;
        controller.setRuleset(1, ruleset, metadata);
        omnichain.setExtraHook(address(0x123), false, false);
        vm.expectRevert(HomerunIncomeDeployer.UnsupportedFund.selector);
        _deploy();
        omnichain.setExtraHook(address(0), true, false);
        vm.expectRevert(HomerunIncomeDeployer.UnsupportedFund.selector);
        _deploy();
        omnichain.setExtraHook(address(0), false, false);
        assertEq(_deploy(), 2);
    }

    function testSharedProtocolProfileRequiresUniqueSortedChains() public {
        HomerunIncomeChainConfig[] memory chains = _chains();
        chains[1].chainId = 1;
        vm.expectRevert(HomerunIncomeDeployer.InvalidProtocolWiring.selector);
        new HomerunIncomeDeployer(chains);
        chains[0].chainId = 10;
        vm.expectRevert(HomerunIncomeDeployer.InvalidProtocolWiring.selector);
        new HomerunIncomeDeployer(chains);
    }

    function testPendingOrUpcomingRulesetBlocksLaunch() public {
        controller.setFutureRulesetIds(11, 0);
        vm.expectRevert(HomerunIncomeDeployer.FundNotClosed.selector);
        _deploy();
        controller.setFutureRulesetIds(0, 11);
        vm.expectRevert(HomerunIncomeDeployer.FundNotClosed.selector);
        _deploy();
        controller.setFutureRulesetIds(10, 10);
        _deploy();
    }
}
