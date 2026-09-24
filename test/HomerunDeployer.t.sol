// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {JBPermissioned} from "@bananapus/core-v6/src/abstract/JBPermissioned.sol";
import {IJBDirectory} from "@bananapus/core-v6/src/interfaces/IJBDirectory.sol";
import {IJBPayerTracker} from "@bananapus/core-v6/src/interfaces/IJBPayerTracker.sol";
import {IJBPermissions} from "@bananapus/core-v6/src/interfaces/IJBPermissions.sol";
import {IJBProjects} from "@bananapus/core-v6/src/interfaces/IJBProjects.sol";
import {IJBRulesetApprovalHook} from "@bananapus/core-v6/src/interfaces/IJBRulesetApprovalHook.sol";
import {IJBTerminal} from "@bananapus/core-v6/src/interfaces/IJBTerminal.sol";
import {JBPermissions} from "@bananapus/core-v6/src/JBPermissions.sol";
import {JBRulesets} from "@bananapus/core-v6/src/JBRulesets.sol";
import {JBAccountingContext} from "@bananapus/core-v6/src/structs/JBAccountingContext.sol";
import {JBBeforePayRecordedContext} from "@bananapus/core-v6/src/structs/JBBeforePayRecordedContext.sol";
import {JBPermissionsData} from "@bananapus/core-v6/src/structs/JBPermissionsData.sol";
import {JBRuleset} from "@bananapus/core-v6/src/structs/JBRuleset.sol";
import {JBRulesetConfig} from "@bananapus/core-v6/src/structs/JBRulesetConfig.sol";
import {JBRulesetMetadata} from "@bananapus/core-v6/src/structs/JBRulesetMetadata.sol";
import {JBTerminalConfig} from "@bananapus/core-v6/src/structs/JBTerminalConfig.sol";
import {JBTokenAmount} from "@bananapus/core-v6/src/structs/JBTokenAmount.sol";
import {IJBOmnichainDeployer} from "@bananapus/omnichain-deployers-v6/src/interfaces/IJBOmnichainDeployer.sol";
import {JBSuckerDeploymentConfig} from "@bananapus/omnichain-deployers-v6/src/structs/JBSuckerDeploymentConfig.sol";
import {JBPermissionIds} from "@bananapus/permission-ids-v6/src/JBPermissionIds.sol";
import {IJBSuckerDeployer} from "@bananapus/suckers-v6/src/interfaces/IJBSuckerDeployer.sol";
import {JBSuckerDeployerConfig} from "@bananapus/suckers-v6/src/structs/JBSuckerDeployerConfig.sol";
import {JBTokenMapping} from "@bananapus/suckers-v6/src/structs/JBTokenMapping.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {IREVDeployer} from "@rev-net/core-v6/src/interfaces/IREVDeployer.sol";
import {REVAutoIssuance} from "@rev-net/core-v6/src/structs/REVAutoIssuance.sol";
import {REVConfig} from "@rev-net/core-v6/src/structs/REVConfig.sol";
import {REVCroptopAllowedPost} from "@rev-net/core-v6/src/structs/REVCroptopAllowedPost.sol";
import {REVDeploy721TiersHookConfig} from "@rev-net/core-v6/src/structs/REVDeploy721TiersHookConfig.sol";
import {REVDescription} from "@rev-net/core-v6/src/structs/REVDescription.sol";
import {REVSuckerDeploymentConfig} from "@rev-net/core-v6/src/structs/REVSuckerDeploymentConfig.sol";
import {Test} from "forge-std/Test.sol";

import {HomerunAllowlistHook} from "../src/HomerunAllowlistHook.sol";
import {HomerunDeployer} from "../src/HomerunDeployer.sol";
import {IHomerunAllowlistHook} from "../src/interfaces/IHomerunAllowlistHook.sol";
import {IHomerunDeployer} from "../src/interfaces/IHomerunDeployer.sol";
import {HomerunChainConfig} from "../src/structs/HomerunChainConfig.sol";
import {HomerunInitialIncomeAllocation} from "../src/structs/HomerunInitialIncomeAllocation.sol";
import {HomerunInitialIncomeSnapshot} from "../src/structs/HomerunInitialIncomeSnapshot.sol";

/// @notice A minimal ERC-20 stand-in whose transfers can be made to fail.
contract IncomeTestToken {
    mapping(address => uint256) public balanceOf;
    bool public failTransfer;
    uint256 public totalSupply;

    function decimals() external pure returns (uint8) {
        return 6;
    }

    function mint(address account, uint256 amount) external {
        balanceOf[account] += amount;
        totalSupply += amount;
    }

    function setFailTransfer(bool value) external {
        failTransfer = value;
    }

    function transfer(address beneficiary, uint256 amount) external returns (bool) {
        require(!failTransfer, "transfer failed");
        balanceOf[msg.sender] -= amount;
        balanceOf[beneficiary] += amount;
        return true;
    }
}

/// @notice A `JBTokens` stand-in that clones one test token per project and tracks credits.
contract IncomeTestTokens {
    address public immutable TOKEN = address(new IncomeTestToken());

    mapping(address => mapping(uint256 => uint256)) public creditBalanceOf;
    mapping(uint256 => address) public tokenOf;
    mapping(uint256 => uint256) public totalCreditSupplyOf;

    function create(uint256 id) external {
        tokenOf[id] = Clones.clone(TOKEN);
    }

    function credit(uint256 id, address holder, uint256 amount) external {
        creditBalanceOf[holder][id] += amount;
        totalCreditSupplyOf[id] += amount;
    }

    function mint(uint256 id, address holder, uint256 amount) external {
        IncomeTestToken(tokenOf[id]).mint(holder, amount);
    }

    function setToken(uint256 id, address token) external {
        tokenOf[id] = token;
    }

    function totalBalanceOf(address holder, uint256 id) external view returns (uint256) {
        return creditBalanceOf[holder][id] + IncomeTestToken(tokenOf[id]).balanceOf(holder);
    }

    function totalSupplyOf(uint256 id) public view returns (uint256) {
        return totalCreditSupplyOf[id] + IncomeTestToken(tokenOf[id]).totalSupply();
    }
}

/// @notice A `JBProjects` stand-in that records owners and charges the creation fee.
contract IncomeTestProjects {
    uint256 public count;
    uint256 public creationFee = 0.01 ether;
    mapping(uint256 => address) public ownerOf;

    function createFor(address owner) external payable returns (uint256 id) {
        require(msg.value == creationFee, "fee");
        id = ++count;
        ownerOf[id] = owner;
    }

    function safeTransferFrom(address from, address to, uint256 id) external {
        require(ownerOf[id] == from && msg.sender == from, "owner");
        ownerOf[id] = to;
    }

    function setOwner(uint256 id, address owner) external {
        ownerOf[id] = owner;
    }
}

/// @notice A `JBDirectory` stand-in that answers with one controller and one terminal.
contract IncomeTestDirectory {
    address public controller;
    address public terminal;

    function controllerOf(uint256) external view returns (address) {
        return controller;
    }

    function primaryTerminalOf(uint256, address) external view returns (address) {
        return terminal;
    }

    function setController(address value) external {
        controller = value;
    }

    function setTerminal(address value) external {
        terminal = value;
    }
}

/// @notice A `JBController` stand-in that records rulesets, token deployments and reserved balances.
contract IncomeTestController {
    address public immutable DIRECTORY;
    address public immutable PERMISSIONS;
    address public immutable PROJECTS;
    address public immutable TOKENS;

    string public lastTokenName;
    bytes32 public lastTokenSalt;
    string public lastTokenSymbol;
    uint48 public latestRulesetOverride;
    mapping(uint256 => uint256) public pendingReservedTokenBalanceOf;
    uint48 public upcomingRulesetOverride;
    mapping(uint256 => JBRulesetMetadata) private _metadata;
    mapping(uint256 => JBRuleset) private _rulesets;

    constructor(address directory, address projects, address tokens, address permissions) {
        DIRECTORY = directory;
        PROJECTS = projects;
        TOKENS = tokens;
        PERMISSIONS = permissions;
    }

    function currentRulesetOf(uint256 id) external view returns (JBRuleset memory, JBRulesetMetadata memory) {
        return (_rulesets[id], _metadata[id]);
    }

    function deployERC20For(
        uint256 id,
        string calldata name,
        string calldata symbol,
        bytes32 salt
    )
        external
        returns (address)
    {
        require(IncomeTestProjects(PROJECTS).ownerOf(id) == msg.sender, "owner");
        lastTokenName = name;
        lastTokenSymbol = symbol;
        lastTokenSalt = salt;
        IncomeTestTokens(TOKENS).create(id);
        return IncomeTestTokens(TOKENS).tokenOf(id);
    }

    function getRulesetOf(uint256 id, uint256) external view returns (JBRuleset memory, JBRulesetMetadata memory) {
        return (_rulesets[id], _metadata[id]);
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

    function setFutureRulesetIds(uint48 latest, uint48 upcoming) external {
        latestRulesetOverride = latest;
        upcomingRulesetOverride = upcoming;
    }

    function setPending(uint256 id, uint256 amount) external {
        pendingReservedTokenBalanceOf[id] = amount;
    }

    function setRuleset(uint256 id, JBRuleset memory ruleset, JBRulesetMetadata memory metadata) external {
        _rulesets[id] = ruleset;
        _metadata[id] = metadata;
    }

    function upcomingRulesetOf(uint256 id) external view returns (JBRuleset memory ruleset, JBRulesetMetadata memory) {
        ruleset.id = upcomingRulesetOverride;
        return (ruleset, _metadata[id]);
    }
}

/// @notice A `JBSuckerRegistry` stand-in that reports whether a project is linked.
contract IncomeTestSuckerRegistry {
    address public immutable DIRECTORY;
    address public immutable PROJECTS;

    bool public linked;

    constructor(address directory, address projects) {
        DIRECTORY = directory;
        PROJECTS = projects;
    }

    function allSuckersOf(uint256) external view returns (address[] memory) {
        return new address[](linked ? 1 : 0);
    }

    function setLinked(bool value) external {
        linked = value;
    }
}

/// @notice A `REVOwner` stand-in that records operators and auto-issuances, and mints them on request.
contract IncomeTestRevOwner {
    address public immutable CONTROLLER;
    address public immutable DIRECTORY;
    address public immutable PROJECTS;
    IncomeTestTokens public immutable TOKENS;

    mapping(uint256 => mapping(uint256 => mapping(address => uint256))) public amountToAutoIssue;
    address public deployer;
    address public failBeneficiary;
    mapping(uint256 => address) public operatorOf;

    constructor(IncomeTestController controller) {
        CONTROLLER = address(controller);
        DIRECTORY = controller.DIRECTORY();
        PROJECTS = controller.PROJECTS();
        TOKENS = IncomeTestTokens(controller.TOKENS());
    }

    function LOANS() external view returns (address) {
        return IncomeTestRevDeployer(deployer).LOANS();
    }

    function SUCKER_REGISTRY() external view returns (address) {
        return IncomeTestRevDeployer(deployer).SUCKER_REGISTRY();
    }

    function autoIssueFor(uint256 id, uint256 stageId, address beneficiary) external {
        require(beneficiary != failBeneficiary, "issuance failed");
        uint256 amount = amountToAutoIssue[id][stageId][beneficiary];
        require(amount != 0, "zero auto issuance");
        amountToAutoIssue[id][stageId][beneficiary] = 0;
        TOKENS.mint(id, beneficiary, amount);
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

    function setDeployer(address value) external {
        deployer = value;
    }

    function setFail(address value) external {
        failBeneficiary = value;
    }
}

/// @notice A `REVLoans` stand-in that only exposes its bindings.
contract IncomeTestLoans {
    address public immutable CONTROLLER;
    address public immutable TERMINAL;

    constructor(address controller, address terminal) {
        CONTROLLER = controller;
        TERMINAL = terminal;
    }
}

/// @notice A `REVDeployer` stand-in that records the launch inputs and can try to reenter the caller.
contract IncomeTestRevDeployer {
    address public immutable CONTROLLER;
    address public immutable DIRECTORY;
    address public immutable LOANS;
    address public immutable MULTI_TERMINAL;
    address public immutable OWNER;
    address public immutable PROJECTS;
    address public immutable ROUTER_TERMINAL_REGISTRY;
    address public immutable SUCKER_REGISTRY;

    bool public attemptReentry;
    bool public failTransfer;
    address public feePayer;
    bytes public lastConfig;
    bytes public lastNft;
    bytes public lastSuckers;
    bool public reentrySucceeded;

    constructor(IncomeTestController controller, address owner, address registry) {
        CONTROLLER = address(controller);
        DIRECTORY = controller.DIRECTORY();
        PROJECTS = controller.PROJECTS();
        OWNER = owner;
        SUCKER_REGISTRY = registry;
        MULTI_TERMINAL = address(new IncomeTestToken());
        ROUTER_TERMINAL_REGISTRY = address(new IncomeTestToken());
        LOANS = address(new IncomeTestLoans(CONTROLLER, MULTI_TERMINAL));
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
        feePayer = HomerunDeployer(msg.sender).originalPayer();
        if (attemptReentry) {
            reentrySucceeded = IncomeTestOwner(config.operator).reenter();
        }
        return (_launch(config), address(0));
    }

    function setAttemptReentry(bool value) external {
        attemptReentry = value;
    }

    function setFailTransfer(bool value) external {
        failTransfer = value;
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

/// @notice A FUND owner contract that launches INCOME and reports whether a reentrant launch succeeded.
contract IncomeTestOwner {
    HomerunDeployer private immutable _helper;

    bytes4 public reentryError;
    HomerunInitialIncomeSnapshot private _snapshot;

    constructor(HomerunDeployer helper, HomerunInitialIncomeSnapshot memory snapshot) {
        _helper = helper;
        _snapshot = snapshot;
    }

    function reenter() external returns (bool success) {
        bytes memory result;
        (success, result) = address(_helper).call{value: 0.01 ether}(
            abi.encodeCall(
                HomerunDeployer.deployIncome,
                (1, _snapshot, _description(), uint16(8000), uint48(1_000_000), _noSuckers())
            )
        );
        // The first four bytes of revert data are the selector.
        // forge-lint: disable-next-line(unsafe-typecast)
        if (result.length >= 4) reentryError = bytes4(result);
    }

    function start() external payable returns (uint256) {
        return _helper.deployIncome{value: 0.01 ether}(1, _snapshot, _description(), 8000, 1_000_000, _noSuckers());
    }

    function _description() private pure returns (REVDescription memory) {
        return
            REVDescription({
                name: "House income", ticker: "HOUSE-INCOME", uri: "ipfs://income", salt: bytes32(uint256(5))
            });
    }

    function _noSuckers() private pure returns (REVSuckerDeploymentConfig memory configuration) {
        configuration.salt = bytes32(uint256(5));
    }
}

/// @notice A `JBOmnichainDeployer` stand-in that records the launch inputs and the resolved fee payer.
contract IncomeTestOmnichainDeployer {
    address public constant trustedForwarder = address(0x2771);

    address public immutable CONTROLLER;
    address public immutable DIRECTORY;
    address public immutable PROJECTS;
    address public immutable SUCKER_REGISTRY;

    address public HOOK_DEPLOYER;
    bool public extraCashOut;
    address public extraHook;
    bool public extraPay;
    address public lastOwner;
    address public lastPayer;
    bytes32 public lastRulesetsHash;
    bytes32 public lastSuckersHash;
    bytes32 public lastTerminalsHash;
    string public lastUri;
    uint256 public lastValue;

    constructor(IncomeTestController controller, address suckers) {
        CONTROLLER = address(controller);
        DIRECTORY = controller.DIRECTORY();
        PROJECTS = controller.PROJECTS();
        SUCKER_REGISTRY = suckers;
    }

    function extraDataHookOf(uint256, uint256) external view returns (address, bool, bool) {
        return (extraHook, extraPay, extraCashOut);
    }

    function launchProjectFor(
        address owner,
        string calldata projectUri,
        JBRulesetConfig[] memory rulesetConfigurations,
        JBTerminalConfig[] memory terminalConfigurations,
        string calldata,
        JBSuckerDeploymentConfig memory suckerDeploymentConfiguration
    )
        external
        payable
        returns (uint256 projectId, address, address[] memory)
    {
        lastOwner = owner;
        lastUri = projectUri;
        lastRulesetsHash = keccak256(abi.encode(rulesetConfigurations));
        lastTerminalsHash = keccak256(abi.encode(terminalConfigurations));
        lastSuckersHash = keccak256(abi.encode(suckerDeploymentConfiguration));
        lastValue = msg.value;
        lastPayer = IJBPayerTracker(msg.sender).originalPayer();
        projectId = IncomeTestProjects(PROJECTS).createFor{value: msg.value}(owner);
        return (projectId, address(0), new address[](0));
    }

    function setExtraHook(address hook, bool pay, bool cashOut) external {
        extraHook = hook;
        extraPay = pay;
        extraCashOut = cashOut;
    }

    function tiered721HookOf(uint256, uint256) external pure returns (address, bool) {
        return (address(0), false);
    }
}

/// @notice A CCIP sucker deployer stand-in that only reports its remote chain.
contract IncomeTestCcipDeployer {
    uint256 public immutable ccipRemoteChainId;

    constructor(uint256 remoteChain) {
        ccipRemoteChainId = remoteChain;
    }
}

/// @notice Unit tests for `HomerunDeployer` and `HomerunAllowlistHook` against protocol stand-ins.
contract HomerunDeployerTest is Test {
    address private constant ALICE = address(0x200);
    address private constant BOB = address(0x300);
    address private constant OPERATOR = address(0x100);
    address private constant OWNER = address(0x400);

    HomerunAllowlistHook private _allowlist;
    IncomeTestController private _controller;
    IncomeTestDirectory private _directory;
    HomerunDeployer private _helper;
    IncomeTestOmnichainDeployer private _omnichain;
    JBPermissions private _permissions;
    IncomeTestProjects private _projects;
    IncomeTestToken private _remoteUsdc;
    IncomeTestRevDeployer private _revDeployer;
    IncomeTestRevOwner private _revOwner;
    HomerunInitialIncomeSnapshot private _snapshot;
    IncomeTestSuckerRegistry private _suckers;
    IncomeTestTokens private _tokens;
    IncomeTestToken private _usdc;

    function setUp() public {
        vm.warp(1_000_000);
        vm.roll(100);
        vm.chainId(1);
        vm.deal(OPERATOR, 10 ether);
        _tokens = new IncomeTestTokens();
        _projects = new IncomeTestProjects();
        _directory = new IncomeTestDirectory();
        _permissions = new JBPermissions(address(0x2771));
        _controller =
            new IncomeTestController(address(_directory), address(_projects), address(_tokens), address(_permissions));
        _directory.setController(address(_controller));
        _suckers = new IncomeTestSuckerRegistry(address(_directory), address(_projects));
        _revOwner = new IncomeTestRevOwner(_controller);
        _revDeployer = new IncomeTestRevDeployer(_controller, address(_revOwner), address(_suckers));
        _revOwner.setDeployer(address(_revDeployer));
        _usdc = new IncomeTestToken();
        _remoteUsdc = new IncomeTestToken();
        _directory.setTerminal(_revDeployer.MULTI_TERMINAL());
        _omnichain = new IncomeTestOmnichainDeployer(_controller, address(_suckers));
        _allowlist = new HomerunAllowlistHook(IJBProjects(address(_projects)), _permissions, address(0x2771));
        _helper = _newHelper(address(_allowlist));
        _helper.setChainSpecificConstants(_chains());
        vm.prank(OPERATOR);
        (uint256 fundId, address fundToken) = _helper.launchFundFor{value: 0.01 ether}(
            OPERATOR, "ipfs://fund", "House FUND", "HOUSE", 0, bytes32(0), new address[](0)
        );
        assertEq(fundId, 1);
        assertEq(fundToken, _tokens.tokenOf(1));
        _tokens.credit(1, OPERATOR, 100 ether);
        _tokens.credit(1, ALICE, 250 ether);
        _tokens.mint(1, ALICE, 50 ether);
        _tokens.mint(1, BOB, 100 ether);
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
        _snapshot.manifestHash = keccak256("independently reconciled manifest");
        _snapshot.manifestUri = "ipfs://snapshot";
    }

    function testLaunchRecordsTheInitialAllocationForTheOwnerAndPreservesOwnership() public {
        uint256 id = _deploy();
        assertEq(id, 2);
        assertEq(_helper.incomeProjectIdOf(1), id);
        // Nothing is minted at launch: the allocation is a stock revnet auto-issuance to the helper.
        assertEq(_tokens.totalSupplyOf(id), 0);
        assertEq(_revOwner.amountToAutoIssue(id, block.timestamp, address(_helper)), 500_000 ether);
        assertEq(_revOwner.amountToAutoIssue(id, block.timestamp, OPERATOR), 0);
        assertEq(_tokens.totalSupplyOf(1), 500 ether);
        assertEq(_projects.ownerOf(id), address(_revOwner));
        assertEq(_revOwner.operatorOf(id), OPERATOR);
        assertEq(_revDeployer.feePayer(), OPERATOR);
        assertEq(_helper.originalPayer(), address(0));
        assertEq(_controller.pendingReservedTokenBalanceOf(id), 0);
        // Anyone mints it to whoever owns the FUND at that moment; the owner settles the published allocation.
        _projects.setOwner(1, OWNER);
        vm.prank(BOB);
        _helper.mintInitialAllocation(1);
        assertEq(_tokens.totalBalanceOf(OWNER, id), 500_000 ether);
        assertEq(_tokens.totalBalanceOf(OPERATOR, id), 0);
        assertEq(_tokens.totalBalanceOf(address(_helper), id), 0);
        assertEq(_tokens.totalSupplyOf(id), 500_000 ether);
        assertEq(_revOwner.amountToAutoIssue(id, block.timestamp, address(_helper)), 0);
        vm.expectRevert(abi.encodeWithSelector(HomerunDeployer.HomerunDeployer_NothingToMint.selector, 1));
        _helper.mintInitialAllocation(1);
        vm.expectRevert(abi.encodeWithSelector(HomerunDeployer.HomerunDeployer_UnsupportedFund.selector, 7));
        _helper.mintInitialAllocation(7);
    }

    function testIncomeSentAfterThePayoutCannotReplayTheAllocationEvent() public {
        uint256 id = _deploy();
        _helper.mintInitialAllocation(1);
        assertEq(_tokens.totalBalanceOf(OPERATOR, id), 500_000 ether);

        // Anyone can send INCOME here after the payout; it must not read as another initial allocation.
        IncomeTestToken income = IncomeTestToken(_tokens.tokenOf(id));
        vm.prank(OPERATOR);
        assertTrue(income.transfer(address(_helper), 1));
        vm.recordLogs();
        vm.prank(BOB);
        vm.expectRevert(abi.encodeWithSelector(HomerunDeployer.HomerunDeployer_NothingToMint.selector, 1));
        _helper.mintInitialAllocation(1);
        assertEq(vm.getRecordedLogs().length, 0);
        assertEq(_tokens.totalBalanceOf(address(_helper), id), 1);
        assertEq(_tokens.totalBalanceOf(OPERATOR, id), 500_000 ether - 1);
    }

    function testStrangerMintingThroughTheRevnetOwnerFirstCannotStrandTheAllocation() public {
        uint256 id = _deploy();
        // The revnet's own auto-issuance is permissionless; a stranger sends the allocation here early.
        vm.prank(BOB);
        _revOwner.autoIssueFor(id, block.timestamp, address(_helper));
        assertEq(_tokens.totalBalanceOf(address(_helper), id), 500_000 ether);
        assertEq(_revOwner.amountToAutoIssue(id, block.timestamp, address(_helper)), 0);
        _helper.mintInitialAllocation(1);
        assertEq(_tokens.totalBalanceOf(OPERATOR, id), 500_000 ether);
        assertEq(_tokens.totalBalanceOf(address(_helper), id), 0);
    }

    function testCorrectIncomeConfigurationRoutesTheWholeReservedSplitToTheOwner() public {
        _deploy();
        REVConfig memory config = abi.decode(_revDeployer.lastConfig(), (REVConfig));
        assertEq(config.description.name, "House income");
        assertEq(config.description.ticker, "HOUSE-INCOME");
        assertEq(config.operator, OPERATOR);
        assertEq(config.baseCurrency, 2);
        assertFalse(config.scopeCashOutsToLocalBalances);
        assertEq(config.stageConfigurations.length, 1);
        assertEq(config.stageConfigurations[0].startsAtOrAfter, 1_000_000);
        assertEq(config.stageConfigurations[0].initialIssuance, 10 ether);
        assertEq(config.stageConfigurations[0].cashOutTaxRate, 1000);
        assertEq(config.stageConfigurations[0].splitPercent, 8000);
        assertEq(config.stageConfigurations[0].issuanceCutFrequency, 7_884_000);
        assertEq(config.stageConfigurations[0].issuanceCutPercent, 20_000_000);
        assertEq(config.stageConfigurations[0].splits.length, 1);
        assertEq(config.stageConfigurations[0].splits[0].percent, 1_000_000_000);
        assertEq(config.stageConfigurations[0].splits[0].beneficiary, OPERATOR);
        assertEq(address(config.stageConfigurations[0].splits[0].hook), address(0));
        assertEq(config.stageConfigurations[0].splits[0].lockedUntil, 0);
        assertEq(config.stageConfigurations[0].extraMetadata, 4);
        REVDeploy721TiersHookConfig memory nft = abi.decode(_revDeployer.lastNft(), (REVDeploy721TiersHookConfig));
        assertEq(nft.baseline721HookConfiguration.name, "House income");
        assertEq(nft.baseline721HookConfiguration.symbol, "HOUSE-INCOME");
        assertEq(nft.baseline721HookConfiguration.tiersConfig.currency, 2);
        assertEq(nft.baseline721HookConfiguration.tiersConfig.decimals, 6);
        assertEq(nft.baseline721HookConfiguration.tiersConfig.tiers.length, 0);
        assertEq(nft.baseline721HookConfiguration.baseUri, "ipfs://");
        assertEq(nft.baseline721HookConfiguration.contractUri, config.description.uri);
        assertTrue(nft.baseline721HookConfiguration.flags.noNewTiersWithReserves);
        assertTrue(nft.baseline721HookConfiguration.flags.noNewTiersWithVotes);
        assertTrue(nft.baseline721HookConfiguration.flags.noNewTiersWithOwnerMinting);
        assertFalse(nft.preventOperatorAdjustingTiers);
        assertTrue(
            nft.preventOperatorUpdatingMetadata && nft.preventOperatorMinting
                && nft.preventOperatorIncreasingDiscountPercent
        );
    }

    function testRealCoreCutsIssuanceTwoPercentEveryQuarterForever() public {
        _deploy();
        REVConfig memory config = abi.decode(_revDeployer.lastConfig(), (REVConfig));
        _directory.setController(address(this));
        JBRulesets rulesets = new JBRulesets(IJBDirectory(address(_directory)));
        // Via-IR may assume block.timestamp stays constant within one transaction; use the cheatcode read
        // so repeated vm.warp calls cannot cause this captured starting timestamp to be re-evaluated.
        uint256 start = vm.getBlockTimestamp();
        rulesets.queueFor(
            2,
            config.stageConfigurations[0].issuanceCutFrequency,
            config.stageConfigurations[0].initialIssuance,
            config.stageConfigurations[0].issuanceCutPercent,
            IJBRulesetApprovalHook(address(0)),
            0,
            config.stageConfigurations[0].startsAtOrAfter
        );
        uint256 expected = 10 ether;
        for (uint256 quarter; quarter <= 40; ++quarter) {
            vm.warp(start + 7_884_000 * quarter);
            assertEq(rulesets.currentOf(2).weight, expected, "actual core weight at quarter");
            expected = expected * 98 / 100;
        }
    }

    function testLaunchFundForUsesFixedRulesDeploysTheTokenAndAttributesTheFee() public view {
        assertTrue(_helper.isFund(1));
        assertEq(_omnichain.lastOwner(), address(_helper));
        assertEq(_controller.lastTokenName(), "House FUND");
        assertEq(_controller.lastTokenSymbol(), "HOUSE");
        assertEq(_controller.lastTokenSalt(), bytes32(0));
        assertEq(_omnichain.lastUri(), "ipfs://fund");
        assertEq(_omnichain.lastValue(), 0.01 ether);
        assertEq(_omnichain.lastPayer(), OPERATOR);
        assertEq(_helper.originalPayer(), address(0));
        assertEq(_omnichain.lastRulesetsHash(), keccak256(abi.encode(_expectedFundRulesets(0))));
        assertEq(_omnichain.lastTerminalsHash(), keccak256(abi.encode(_expectedFundTerminals())));
        JBSuckerDeploymentConfig memory noSuckers;
        assertEq(_omnichain.lastSuckersHash(), keccak256(abi.encode(noSuckers)));
        assertEq(_projects.ownerOf(1), OPERATOR);
    }

    function testLinkedLaunchBuildsUsdcSuckersUnderCallerScopedSalt() public {
        address[] memory peers = new address[](1);
        peers[0] = address(new IncomeTestCcipDeployer(10));
        vm.deal(ALICE, 1 ether);
        vm.expectEmit(true, true, true, true, address(_helper));
        emit IHomerunDeployer.FundLaunched(2, OWNER, ALICE);
        vm.prank(ALICE);
        (uint256 id,) = _helper.launchFundFor{value: 0.01 ether}(
            OWNER, "ipfs://linked", "Linked FUND", "LINK", 1_000_000, bytes32(uint256(7)), peers
        );
        assertEq(id, 2);
        assertTrue(_helper.isFund(2));
        assertEq(_projects.ownerOf(2), OWNER);
        // The token salt is scoped to the caller, the owner and the launch terms, like the sucker salt: a linked FUND
        // still shares one token address on every chain, and another launch reusing the public salt cannot block it.
        bytes32 scopedSalt =
            keccak256(abi.encode(ALICE, OWNER, bytes32(uint256(7)), "ipfs://linked", "Linked FUND", "LINK", 1_000_000));
        assertEq(_controller.lastTokenSalt(), scopedSalt);
        assertEq(_omnichain.lastRulesetsHash(), keccak256(abi.encode(_expectedFundRulesets(1_000_000))));
        JBSuckerDeploymentConfig memory expected;
        expected.salt = scopedSalt;
        expected.deployerConfigurations = new JBSuckerDeployerConfig[](1);
        JBTokenMapping[] memory mappings = new JBTokenMapping[](1);
        mappings[0] = JBTokenMapping({
            localToken: address(_usdc), minGas: 200_000, remoteToken: bytes32(uint256(uint160(address(_remoteUsdc))))
        });
        expected.deployerConfigurations[0] =
            JBSuckerDeployerConfig({deployer: IJBSuckerDeployer(peers[0]), peer: bytes32(0), mappings: mappings});
        assertEq(_omnichain.lastSuckersHash(), keccak256(abi.encode(expected)));
    }

    function testLinkedLaunchSaltCommitsToEveryLaunchTerm() public {
        address[] memory peers = new address[](1);
        peers[0] = address(new IncomeTestCcipDeployer(10));
        bytes32 salt = bytes32(uint256(7));
        vm.deal(ALICE, 1 ether);

        // One sender launches for the same owner and salt, changing one term at a time.
        vm.startPrank(ALICE);
        _helper.launchFundFor{value: 0.01 ether}(OWNER, "ipfs://a", "A FUND", "AAA", 1_000_000, salt, peers);
        bytes32 original = _controller.lastTokenSalt();
        _helper.launchFundFor{value: 0.01 ether}(OWNER, "ipfs://b", "A FUND", "AAA", 1_000_000, salt, peers);
        bytes32 otherUri = _controller.lastTokenSalt();
        _helper.launchFundFor{value: 0.01 ether}(OWNER, "ipfs://a", "B FUND", "AAA", 1_000_000, salt, peers);
        bytes32 otherName = _controller.lastTokenSalt();
        _helper.launchFundFor{value: 0.01 ether}(OWNER, "ipfs://a", "A FUND", "BBB", 1_000_000, salt, peers);
        bytes32 otherTicker = _controller.lastTokenSalt();
        _helper.launchFundFor{value: 0.01 ether}(OWNER, "ipfs://a", "A FUND", "AAA", 1_000_001, salt, peers);
        bytes32 otherStart = _controller.lastTokenSalt();
        // The same terms again reproduce the original salt, as a linked launch on another chain does.
        _helper.launchFundFor{value: 0.01 ether}(OWNER, "ipfs://a", "A FUND", "AAA", 1_000_000, salt, peers);
        vm.stopPrank();
        assertEq(original, keccak256(abi.encode(ALICE, OWNER, salt, "ipfs://a", "A FUND", "AAA", 1_000_000)));
        assertTrue(otherUri != original);
        assertTrue(otherName != original);
        assertTrue(otherTicker != original);
        assertTrue(otherStart != original);
        assertEq(_controller.lastTokenSalt(), original);
    }

    function testForwardedLaunchResolvesTheSignerNotTheForwarder() public {
        address[] memory none = new address[](0);
        vm.deal(address(0x2771), 1 ether);
        vm.expectEmit(true, true, true, true, address(_helper));
        emit IHomerunDeployer.FundLaunched(2, OWNER, ALICE);
        vm.prank(address(0x2771));
        (bool ok,) = address(_helper).call{value: 0.01 ether}(
            abi.encodePacked(
                abi.encodeCall(_helper.launchFundFor, (OWNER, "ipfs://relayed", "Relayed", "RLY", 0, bytes32(0), none)),
                ALICE
            )
        );
        assertTrue(ok);
        assertEq(_omnichain.lastPayer(), ALICE);
    }

    function testAllowlistHookMustShareTheProjectRegistry() public {
        address wrongProjects =
            address(new HomerunAllowlistHook(IJBProjects(address(_usdc)), _permissions, address(0x2771)));
        vm.expectRevert(HomerunDeployer.HomerunDeployer_InvalidProtocolWiring.selector);
        _newHelper(wrongProjects);
        // A hook trusting another forwarder would let relayed allowlist changes resolve to a forged owner.
        address wrongForwarder =
            address(new HomerunAllowlistHook(IJBProjects(address(_projects)), _permissions, address(0xBEEF)));
        vm.expectRevert(HomerunDeployer.HomerunDeployer_InvalidProtocolWiring.selector);
        _newHelper(wrongForwarder);
        // A hook reading another permissions contract would let grants the owner never made manage the list.
        address wrongPermissions = address(
            new HomerunAllowlistHook(
                IJBProjects(address(_projects)),
                IJBPermissions(address(new JBPermissions(address(0x2771)))),
                address(0x2771)
            )
        );
        vm.expectRevert(HomerunDeployer.HomerunDeployer_InvalidProtocolWiring.selector);
        _newHelper(wrongPermissions);
    }

    function testOnlyTheBindingDeployerSetsChainSpecificConstantsOnce() public {
        HomerunDeployer fresh = _newHelper(address(_allowlist));
        vm.expectRevert(abi.encodeWithSelector(HomerunDeployer.HomerunDeployer_Unauthorized.selector, ALICE));
        vm.prank(ALICE);
        fresh.setChainSpecificConstants(_chains());
        // The check reads `msg.sender`, so the trusted forwarder cannot relay a configuration for the deployer.
        vm.prank(address(0x2771));
        vm.expectRevert(abi.encodeWithSelector(HomerunDeployer.HomerunDeployer_Unauthorized.selector, address(0x2771)));
        (bool ok,) = address(fresh)
            .call(abi.encodePacked(abi.encodeCall(fresh.setChainSpecificConstants, (_chains())), address(this)));
        ok;
        assertEq(fresh.USDC(), address(0));
        fresh.setChainSpecificConstants(_chains());
        assertEq(fresh.USDC(), address(_usdc));
        assertEq(fresh.usdcOf(1), address(_usdc));
        assertEq(fresh.usdcOf(10), address(_remoteUsdc));
        assertEq(fresh.usdcOf(8453), address(_remoteUsdc));
        vm.expectRevert(HomerunDeployer.HomerunDeployer_AlreadyConfigured.selector);
        fresh.setChainSpecificConstants(_chains());
    }

    function testChainSpecificConstantsRejectInconsistentEntries() public {
        HomerunDeployer fresh = _newHelper(address(_allowlist));
        HomerunChainConfig[] memory chains = _chains();
        chains[1].usdc = address(0);
        vm.expectRevert(HomerunDeployer.HomerunDeployer_InvalidProtocolWiring.selector);
        fresh.setChainSpecificConstants(chains);
        chains = _chains();
        chains[2].revDeployer = address(0xdead);
        vm.expectRevert(HomerunDeployer.HomerunDeployer_InvalidProtocolWiring.selector);
        fresh.setChainSpecificConstants(chains);
        chains = _chains();
        chains[1].omnichainDeployer = address(0xdead);
        vm.expectRevert(HomerunDeployer.HomerunDeployer_InvalidProtocolWiring.selector);
        fresh.setChainSpecificConstants(chains);
        chains = _chains();
        chains[0].allowlistHook = address(0xdead);
        vm.expectRevert(HomerunDeployer.HomerunDeployer_InvalidProtocolWiring.selector);
        fresh.setChainSpecificConstants(chains);
        // This chain must be configured.
        chains = _chains();
        chains[0].chainId = 5;
        vm.expectRevert(HomerunDeployer.HomerunDeployer_InvalidProtocolWiring.selector);
        fresh.setChainSpecificConstants(chains);
        // This chain's USDC must have 6 decimals.
        vm.mockCall(address(_usdc), abi.encodeWithSignature("decimals()"), abi.encode(uint8(18)));
        vm.expectRevert(HomerunDeployer.HomerunDeployer_InvalidProtocolWiring.selector);
        fresh.setChainSpecificConstants(_chains());
        vm.clearMockedCalls();
        fresh.setChainSpecificConstants(_chains());
        assertEq(fresh.USDC(), address(_usdc));
    }

    function testAllowlistGatesBeneficiariesUntilTheOwnerAllowsOrOpens() public {
        vm.expectRevert(abi.encodeWithSelector(HomerunAllowlistHook.HomerunAllowlistHook_NotAllowed.selector, 1, ALICE));
        _allowlist.beforePayRecordedWith(_payContext(1, ALICE));
        address[] memory accounts = new address[](1);
        accounts[0] = ALICE;
        vm.expectPartialRevert(JBPermissioned.JBPermissioned_Unauthorized.selector);
        vm.prank(ALICE);
        _allowlist.setAllowed(1, accounts, true);
        vm.expectEmit(true, true, true, true, address(_allowlist));
        emit IHomerunAllowlistHook.AllowedSet(1, ALICE, true, OPERATOR);
        vm.prank(OPERATOR);
        _allowlist.setAllowed(1, accounts, true);
        (uint256 weight,) = _allowlist.beforePayRecordedWith(_payContext(1, ALICE));
        assertEq(weight, 10_000e18, "an allowed beneficiary keeps the ruleset weight");
        // The payer is irrelevant; routed payments arrive from the router.
        vm.expectRevert(abi.encodeWithSelector(HomerunAllowlistHook.HomerunAllowlistHook_NotAllowed.selector, 1, BOB));
        _allowlist.beforePayRecordedWith(_payContext(1, BOB));
        vm.prank(OPERATOR);
        _allowlist.setAllowed(1, accounts, false);
        vm.expectRevert(abi.encodeWithSelector(HomerunAllowlistHook.HomerunAllowlistHook_NotAllowed.selector, 1, ALICE));
        _allowlist.beforePayRecordedWith(_payContext(1, ALICE));
        vm.expectPartialRevert(JBPermissioned.JBPermissioned_Unauthorized.selector);
        _allowlist.setOpen(1, true);
        vm.prank(OPERATOR);
        _allowlist.setOpen(1, true);
        _allowlist.beforePayRecordedWith(_payContext(1, BOB));
        assertTrue(_allowlist.canPay(1, BOB));
        // Lists are per project.
        vm.expectRevert(abi.encodeWithSelector(HomerunAllowlistHook.HomerunAllowlistHook_NotAllowed.selector, 2, BOB));
        _allowlist.beforePayRecordedWith(_payContext(2, BOB));
        assertFalse(_allowlist.hasMintPermissionFor(1, _closedRuleset(), OPERATOR));
    }

    function testForwardedAllowlistManagementResolvesTheSigner() public {
        address[] memory accounts = new address[](1);
        accounts[0] = BOB;
        vm.prank(address(0x2771));
        (bool ok,) = address(_allowlist)
            .call(abi.encodePacked(abi.encodeCall(_allowlist.setAllowed, (1, accounts, true)), OPERATOR));
        assertTrue(ok);
        assertTrue(_allowlist.isAllowed(1, BOB));
        vm.prank(address(0x2771));
        (ok,) = address(_allowlist)
            .call(abi.encodePacked(abi.encodeCall(_allowlist.setAllowed, (1, accounts, false)), ALICE));
        assertFalse(ok);
        assertTrue(_allowlist.isAllowed(1, BOB));
    }

    function testAllowlistPermissionIdSitsOutsideTheEcosystemRegistry() public view {
        assertEq(_allowlist.SET_ALLOWLIST_PERMISSION_ID(), 128);
        assertGt(_allowlist.SET_ALLOWLIST_PERMISSION_ID(), JBPermissionIds.REPAY_LOAN);
        assertEq(address(_allowlist.PERMISSIONS()), address(_permissions));
    }

    function testGrantedOperatorManagesTheAllowlist() public {
        _grant(ALICE, 1, _allowlist.SET_ALLOWLIST_PERMISSION_ID());
        vm.expectEmit(true, true, true, true, address(_allowlist));
        emit IHomerunAllowlistHook.AllowedSet(1, BOB, true, ALICE);
        vm.prank(ALICE);
        _allowlist.setAllowed(1, _one(BOB), true);
        assertTrue(_allowlist.isAllowed(1, BOB));
        vm.expectEmit(true, true, true, true, address(_allowlist));
        emit IHomerunAllowlistHook.OpenSet(1, true, ALICE);
        vm.prank(ALICE);
        _allowlist.setOpen(1, true);
        assertTrue(_allowlist.isOpen(1));
        // The owner keeps full power alongside the operator.
        vm.prank(OPERATOR);
        _allowlist.setOpen(1, false);
        vm.prank(OPERATOR);
        _allowlist.setAllowed(1, _one(BOB), false);
        assertFalse(_allowlist.canPay(1, BOB));
    }

    function testWildcardGrantManagesTheAllowlist() public {
        _grant(ALICE, 0, _allowlist.SET_ALLOWLIST_PERMISSION_ID());
        vm.prank(ALICE);
        _allowlist.setOpen(1, true);
        assertTrue(_allowlist.isOpen(1));
    }

    function testRootOperatorManagesTheAllowlist() public {
        _grant(ALICE, 1, JBPermissionIds.ROOT);
        vm.prank(ALICE);
        _allowlist.setAllowed(1, _one(BOB), true);
        vm.prank(ALICE);
        _allowlist.setOpen(1, true);
        assertTrue(_allowlist.isAllowed(1, BOB));
        assertTrue(_allowlist.isOpen(1));
    }

    function testOperatorWithoutTheAllowlistPermissionIsRejected() public {
        // Another permission from the owner does not reach the list.
        _grant(ALICE, 1, JBPermissionIds.QUEUE_RULESETS);
        vm.expectRevert(
            abi.encodeWithSelector(
                JBPermissioned.JBPermissioned_Unauthorized.selector,
                OPERATOR,
                ALICE,
                1,
                _allowlist.SET_ALLOWLIST_PERMISSION_ID()
            )
        );
        vm.prank(ALICE);
        _allowlist.setAllowed(1, _one(BOB), true);
        vm.expectPartialRevert(JBPermissioned.JBPermissioned_Unauthorized.selector);
        vm.prank(ALICE);
        _allowlist.setOpen(1, true);
    }

    function testAllowlistGrantForAnotherProjectIsRejected() public {
        _grant(ALICE, 2, _allowlist.SET_ALLOWLIST_PERMISSION_ID());
        vm.expectPartialRevert(JBPermissioned.JBPermissioned_Unauthorized.selector);
        vm.prank(ALICE);
        _allowlist.setAllowed(1, _one(BOB), true);
        vm.expectPartialRevert(JBPermissioned.JBPermissioned_Unauthorized.selector);
        vm.prank(ALICE);
        _allowlist.setOpen(1, true);
    }

    function testAllowlistGrantFromAPreviousOwnerLapsesOnTransfer() public {
        _grant(ALICE, 1, _allowlist.SET_ALLOWLIST_PERMISSION_ID());
        _projects.setOwner(1, OWNER);
        vm.expectPartialRevert(JBPermissioned.JBPermissioned_Unauthorized.selector);
        vm.prank(ALICE);
        _allowlist.setOpen(1, true);
    }

    function testForwardedOperatorManagementResolvesTheSigner() public {
        _grant(ALICE, 1, _allowlist.SET_ALLOWLIST_PERMISSION_ID());
        vm.prank(address(0x2771));
        (bool ok,) = address(_allowlist)
            .call(abi.encodePacked(abi.encodeCall(_allowlist.setAllowed, (1, _one(BOB), true)), ALICE));
        assertTrue(ok);
        assertTrue(_allowlist.isAllowed(1, BOB));
        vm.prank(address(0x2771));
        (ok,) = address(_allowlist).call(abi.encodePacked(abi.encodeCall(_allowlist.setOpen, (1, true)), ALICE));
        assertTrue(ok);
        assertTrue(_allowlist.isOpen(1));
        // A signer without the grant is refused even through the forwarder.
        vm.prank(address(0x2771));
        (ok,) = address(_allowlist).call(abi.encodePacked(abi.encodeCall(_allowlist.setOpen, (1, false)), BOB));
        assertFalse(ok);
        assertTrue(_allowlist.isOpen(1));
        // The forwarder itself holds no grant, so without a suffix it is refused.
        vm.prank(address(0x2771));
        vm.expectPartialRevert(JBPermissioned.JBPermissioned_Unauthorized.selector);
        _allowlist.setOpen(1, false);
    }

    function testClosedFundMayKeepItsAllowlistHook() public {
        (JBRuleset memory ruleset, JBRulesetMetadata memory metadata) = _controller.currentRulesetOf(1);
        metadata.dataHook = address(_omnichain);
        metadata.useDataHookForPay = true;
        metadata.useDataHookForCashOut = true;
        _controller.setRuleset(1, ruleset, metadata);
        _omnichain.setExtraHook(address(_allowlist), true, false);
        assertEq(_deploy(), 2);
    }

    function testLaunchFundForRejectsMalformedInputs() public {
        address[] memory none = new address[](0);
        address[] memory peers = new address[](1);
        peers[0] = address(new IncomeTestCcipDeployer(10));
        vm.startPrank(OPERATOR);
        // Salt without peers, peers without salt, and linked launches without a shared start.
        vm.expectRevert(HomerunDeployer.HomerunDeployer_InvalidConfiguration.selector);
        _helper.launchFundFor{value: 0.01 ether}(OPERATOR, "ipfs://fund", "F", "F", 0, bytes32(uint256(1)), none);
        vm.expectRevert(HomerunDeployer.HomerunDeployer_InvalidConfiguration.selector);
        _helper.launchFundFor{value: 0.01 ether}(OPERATOR, "ipfs://fund", "F", "F", 1_000_000, bytes32(0), peers);
        vm.expectRevert(HomerunDeployer.HomerunDeployer_InvalidConfiguration.selector);
        _helper.launchFundFor{value: 0.01 ether}(OPERATOR, "ipfs://fund", "F", "F", 0, bytes32(uint256(1)), peers);
        // Unknown remote chain, the local chain, duplicate peers, and descending peers.
        peers[0] = address(new IncomeTestCcipDeployer(42_161));
        vm.expectRevert(HomerunDeployer.HomerunDeployer_InvalidConfiguration.selector);
        _helper.launchFundFor{value: 0.01 ether}(
            OPERATOR, "ipfs://fund", "F", "F", 1_000_000, bytes32(uint256(1)), peers
        );
        peers[0] = address(new IncomeTestCcipDeployer(1));
        vm.expectRevert(HomerunDeployer.HomerunDeployer_InvalidConfiguration.selector);
        _helper.launchFundFor{value: 0.01 ether}(
            OPERATOR, "ipfs://fund", "F", "F", 1_000_000, bytes32(uint256(1)), peers
        );
        address[] memory unsorted = new address[](2);
        unsorted[0] = address(new IncomeTestCcipDeployer(10));
        unsorted[1] = address(new IncomeTestCcipDeployer(10));
        vm.expectRevert(HomerunDeployer.HomerunDeployer_InvalidConfiguration.selector);
        _helper.launchFundFor{value: 0.01 ether}(
            OPERATOR, "ipfs://fund", "F", "F", 1_000_000, bytes32(uint256(1)), unsorted
        );
        unsorted[0] = address(new IncomeTestCcipDeployer(8453));
        vm.expectRevert(HomerunDeployer.HomerunDeployer_InvalidConfiguration.selector);
        _helper.launchFundFor{value: 0.01 ether}(
            OPERATOR, "ipfs://fund", "F", "F", 1_000_000, bytes32(uint256(1)), unsorted
        );
        (unsorted[0], unsorted[1]) = (unsorted[1], unsorted[0]);
        _helper.launchFundFor{value: 0.01 ether}(
            OPERATOR, "ipfs://fund", "F", "F", 1_000_000, bytes32(uint256(1)), unsorted
        );
        vm.stopPrank();
    }

    function testIncomeOnlyAttachesToFundsLaunchedHere() public {
        _projects.setOwner(50, OPERATOR);
        _snapshot.allocations[0].fundProjectId = 50;
        vm.prank(OPERATOR);
        vm.expectPartialRevert(HomerunDeployer.HomerunDeployer_UnsupportedFund.selector);
        _helper.deployIncome{value: 0.01 ether}(50, _snapshot, _description(), 8000, 1_000_000, _noSuckers());
    }

    function testUnauthorizedOwnerCannotLaunch() public {
        vm.expectPartialRevert(HomerunDeployer.HomerunDeployer_Unauthorized.selector);
        _helper.deployIncome(1, _snapshot, _description(), 8000, 1_000_000, _noSuckers());
    }

    function testOwnerKeepsAuthorityAndTheReservedSplitAfterTransfer() public {
        _projects.setOwner(1, OWNER);
        vm.deal(OWNER, 1 ether);
        vm.expectPartialRevert(HomerunDeployer.HomerunDeployer_Unauthorized.selector);
        _deployFor(OPERATOR);
        _assertRollback();
        vm.expectEmit(true, true, true, false, address(_helper));
        emit IHomerunDeployer.IncomeDeployed(1, 2, OWNER);
        uint256 id = _deployFor(OWNER);
        REVConfig memory config = abi.decode(_revDeployer.lastConfig(), (REVConfig));
        assertEq(_projects.ownerOf(1), OWNER);
        assertEq(_projects.ownerOf(id), address(_revOwner));
        assertEq(config.operator, OWNER);
        assertTrue(_revOwner.isOperatorOf(id, OWNER));
        assertFalse(_revOwner.isOperatorOf(id, OPERATOR));
        assertEq(_revDeployer.feePayer(), OWNER);
        assertEq(config.stageConfigurations[0].splits[0].beneficiary, OWNER);
    }

    function testReservedPercentAndTickerAreCallerChoices() public {
        REVDescription memory description = _description();
        vm.startPrank(OPERATOR);
        description.ticker = "RENT";
        _helper.deployIncome{value: 0.01 ether}(1, _snapshot, description, 0, 1_000_000, _noSuckers());
        vm.stopPrank();
        REVConfig memory config = abi.decode(_revDeployer.lastConfig(), (REVConfig));
        assertEq(config.description.ticker, "RENT");
        assertEq(config.stageConfigurations[0].splitPercent, 0);
        assertEq(config.stageConfigurations[0].splits.length, 1);
    }

    function testLinkedFundIsCoveredByAttestedGlobalSnapshot() public {
        _suckers.setLinked(true);
        assertEq(_deploy(), 2);
    }

    function testOnlyOneIncomeCanBeLaunchedForFund() public {
        _deploy();
        vm.expectPartialRevert(HomerunDeployer.HomerunDeployer_AlreadyDeployed.selector);
        _deploy();
        assertEq(_projects.count(), 2);
    }

    function testExternalDeploymentCallbackCannotReenter() public {
        IncomeTestOwner operator = new IncomeTestOwner(_helper, _snapshot);
        _projects.setOwner(1, address(operator));
        vm.deal(address(operator), 0.02 ether);
        _revDeployer.setAttemptReentry(true);
        operator.start();
        assertFalse(_revDeployer.reentrySucceeded());
        assertEq(_projects.count(), 2);
        assertEq(operator.reentryError(), bytes4(keccak256("ReentrancyGuardReentrantCall()")));
    }

    function testHistoricalSnapshotDoesNotChangeAfterTransfer() public {
        IncomeTestToken fundToken = IncomeTestToken(_tokens.tokenOf(1));
        vm.prank(ALICE);
        assertTrue(fundToken.transfer(BOB, 50 ether));
        uint256 id = _deploy();
        // The FUND transfer after the snapshot block does not change the attested allocation.
        assertEq(_revOwner.amountToAutoIssue(id, block.timestamp, address(_helper)), 500_000 ether);
        assertEq(_tokens.totalBalanceOf(ALICE, 1), 250 ether);
    }

    function testPartialGlobalAllocationMintsOnlyLocalShare() public {
        HomerunInitialIncomeSnapshot memory snapshot = _globalSnapshot(uint104(120_000 ether));
        REVSuckerDeploymentConfig memory configuration = _globalSuckers();
        uint256 incomeId = _deployGlobal(snapshot, configuration);
        assertEq(_revOwner.amountToAutoIssue(incomeId, block.timestamp, address(_helper)), 120_000 ether);
        assertEq(_tokens.totalSupplyOf(incomeId), 0);
        REVConfig memory config = abi.decode(_revDeployer.lastConfig(), (REVConfig));
        assertEq(config.stageConfigurations[0].autoIssuances.length, 2);
        assertEq(config.stageConfigurations[0].autoIssuances[0].count, 120_000 ether);
        assertEq(config.stageConfigurations[0].autoIssuances[0].beneficiary, address(_helper));
        assertEq(config.stageConfigurations[0].autoIssuances[1].count, 380_000 ether);
        assertEq(config.stageConfigurations[0].autoIssuances[1].chainId, 10);
        assertEq(config.stageConfigurations[0].autoIssuances[1].beneficiary, address(_helper));
        assertEq(config.description.salt, _helper.configurationSaltFor(snapshot, _description().salt));
        _helper.mintInitialAllocation(1);
        assertEq(_tokens.totalBalanceOf(OPERATOR, incomeId), 120_000 ether);
        assertEq(_revOwner.amountToAutoIssue(incomeId, block.timestamp, address(_helper)), 0);
    }

    function testZeroLocalAllocationRecordsNothingToMint() public {
        HomerunInitialIncomeSnapshot memory snapshot = _globalSnapshot(0);
        REVSuckerDeploymentConfig memory configuration = _globalSuckers();
        uint256 incomeId = _deployGlobal(snapshot, configuration);
        assertEq(_revOwner.amountToAutoIssue(incomeId, block.timestamp, address(_helper)), 0);
        assertEq(_tokens.totalSupplyOf(incomeId), 0);
        vm.expectRevert(abi.encodeWithSelector(HomerunDeployer.HomerunDeployer_NothingToMint.selector, 1));
        _helper.mintInitialAllocation(1);
        REVConfig memory config = abi.decode(_revDeployer.lastConfig(), (REVConfig));
        assertEq(config.stageConfigurations[0].autoIssuances[0].count, 0);
        assertEq(config.stageConfigurations[0].autoIssuances[1].count, 500_000 ether);
    }

    function testGlobalAllocationCannotMultiplyOrUnderfundInitialSupply() public {
        HomerunInitialIncomeSnapshot memory snapshot = _globalSnapshot(uint104(120_000 ether));
        REVSuckerDeploymentConfig memory configuration = _globalSuckers();
        snapshot.allocations[1].incomeAmount = uint104(500_000 ether);
        vm.expectRevert(HomerunDeployer.HomerunDeployer_InvalidSnapshot.selector);
        _deployGlobal(snapshot, configuration);
        snapshot.allocations[1].incomeAmount = uint104(379_999 ether);
        vm.expectRevert(HomerunDeployer.HomerunDeployer_InvalidSnapshot.selector);
        _deployGlobal(snapshot, configuration);
        assertEq(_helper.incomeProjectIdOf(1), 0);
    }

    function testGlobalSnapshotRejectsDuplicateOrUnregisteredChains() public {
        HomerunInitialIncomeSnapshot memory snapshot = _globalSnapshot(uint104(120_000 ether));
        REVSuckerDeploymentConfig memory configuration = _globalSuckers();
        snapshot.allocations[1].chainId = 1;
        vm.expectRevert(HomerunDeployer.HomerunDeployer_InvalidSnapshot.selector);
        _deployGlobal(snapshot, configuration);
        snapshot.allocations[1].chainId = 11;
        vm.expectRevert(HomerunDeployer.HomerunDeployer_InvalidSnapshot.selector);
        _deployGlobal(snapshot, configuration);
    }

    function testGlobalSnapshotCannotOmitOrSubstituteLocalFund() public {
        HomerunInitialIncomeSnapshot memory snapshot = _globalSnapshot(uint104(120_000 ether));
        REVSuckerDeploymentConfig memory configuration = _globalSuckers();
        snapshot.allocations[0].fundProjectId = 55;
        vm.expectRevert(HomerunDeployer.HomerunDeployer_InvalidSnapshot.selector);
        _deployGlobal(snapshot, configuration);
        snapshot.allocations[0].chainId = 2;
        vm.expectRevert(HomerunDeployer.HomerunDeployer_InvalidSnapshot.selector);
        _deployGlobal(snapshot, configuration);
    }

    function testGlobalSnapshotAndManifestAreCommittedIntoRevnetIdentity() public view {
        HomerunInitialIncomeSnapshot memory snapshot = _globalSnapshot(uint104(120_000 ether));
        bytes32 beforeChange = _helper.configurationSaltFor(snapshot, _description().salt);
        snapshot.allocations[1].snapshotBlockHash = keccak256("changed remote source block");
        bytes32 changedBlock = _helper.configurationSaltFor(snapshot, _description().salt);
        assertNotEq(beforeChange, changedBlock);
        snapshot.manifestHash = keccak256("changed public manifest");
        assertNotEq(changedBlock, _helper.configurationSaltFor(snapshot, _description().salt));
    }

    function testGlobalLaunchRequiresEveryRemoteSucker() public {
        HomerunInitialIncomeSnapshot memory snapshot = _globalSnapshot(uint104(120_000 ether));
        REVSuckerDeploymentConfig memory empty = _noSuckers();
        vm.expectRevert(HomerunDeployer.HomerunDeployer_InvalidConfiguration.selector);
        _deployGlobal(snapshot, empty);
    }

    function testGlobalSuckerRejectsWrongPeerChainOrCurrency() public {
        HomerunInitialIncomeSnapshot memory snapshot = _globalSnapshot(uint104(120_000 ether));
        REVSuckerDeploymentConfig memory configuration = _globalSuckers();
        configuration.deployerConfigurations[0].peer = bytes32(uint256(1));
        vm.expectRevert(HomerunDeployer.HomerunDeployer_InvalidConfiguration.selector);
        _deployGlobal(snapshot, configuration);
        configuration.deployerConfigurations[0].peer = bytes32(0);
        configuration.deployerConfigurations[0].mappings[0].remoteToken = bytes32(uint256(1));
        vm.expectRevert(HomerunDeployer.HomerunDeployer_InvalidConfiguration.selector);
        _deployGlobal(snapshot, configuration);
        configuration.deployerConfigurations[0].mappings[0].remoteToken = bytes32(uint256(uint160(address(_usdc))));
        configuration.deployerConfigurations[0].deployer =
            IJBSuckerDeployer(address(new IncomeTestCcipDeployer(42_161)));
        vm.expectRevert(HomerunDeployer.HomerunDeployer_InvalidConfiguration.selector);
        _deployGlobal(snapshot, configuration);
    }

    function testSharedProtocolProfileRequiresUniqueSortedChains() public {
        HomerunDeployer fresh = _newHelper(address(_allowlist));
        HomerunChainConfig[] memory chains = _chains();
        chains[1].chainId = 1;
        vm.expectRevert(HomerunDeployer.HomerunDeployer_InvalidProtocolWiring.selector);
        fresh.setChainSpecificConstants(chains);
        chains[0].chainId = 10;
        vm.expectRevert(HomerunDeployer.HomerunDeployer_InvalidProtocolWiring.selector);
        fresh.setChainSpecificConstants(chains);
    }

    function _assertRollback() private view {
        assertEq(_projects.count(), 1);
        assertEq(_helper.incomeProjectIdOf(1), 0);
        assertEq(_tokens.tokenOf(2), address(0));
        assertEq(address(_helper).balance, 0);
        assertEq(_helper.originalPayer(), address(0));
    }

    function _chains() private view returns (HomerunChainConfig[] memory chains) {
        chains = new HomerunChainConfig[](3);
        uint32[3] memory ids = [uint32(1), 10, 8453];
        for (uint256 i; i < chains.length; i++) {
            chains[i] = HomerunChainConfig({
                chainId: ids[i],
                revDeployer: address(_revDeployer),
                usdc: i == 0 ? address(_usdc) : address(_remoteUsdc),
                omnichainDeployer: address(_omnichain),
                allowlistHook: address(_allowlist)
            });
        }
    }

    function _closed() private {
        JBRuleset memory ruleset;
        ruleset.id = 10;
        ruleset.start = 10;
        JBRulesetMetadata memory metadata;
        metadata.pausePay = true;
        metadata.cashOutTaxRate = 10_000;
        _controller.setRuleset(1, ruleset, metadata);
    }

    function _closedRuleset() private view returns (JBRuleset memory ruleset) {
        (ruleset,) = _controller.currentRulesetOf(1);
    }

    function _deploy() private returns (uint256) {
        return _deployFor(OPERATOR);
    }

    function _deployFor(address owner) private returns (uint256) {
        vm.prank(owner);
        return _helper.deployIncome{value: 0.01 ether}(1, _snapshot, _description(), 8000, 1_000_000, _noSuckers());
    }

    function _deployGlobal(
        HomerunInitialIncomeSnapshot memory snapshot,
        REVSuckerDeploymentConfig memory configuration
    )
        private
        returns (uint256)
    {
        vm.prank(OPERATOR);
        return _helper.deployIncome{value: 0.01 ether}(1, snapshot, _description(), 8000, 1_000_000, configuration);
    }

    function _description() private pure returns (REVDescription memory) {
        return
            REVDescription({
                name: "House income", ticker: "HOUSE-INCOME", uri: "ipfs://income", salt: bytes32(uint256(5))
            });
    }

    function _expectedFundRulesets(uint48 start) private view returns (JBRulesetConfig[] memory rulesets) {
        rulesets = new JBRulesetConfig[](1);
        rulesets[0].mustStartAtOrAfter = start;
        rulesets[0].weight = 10_000e18;
        rulesets[0].metadata.cashOutTaxRate = 1000;
        rulesets[0].metadata.baseCurrency = 2;
        rulesets[0].metadata.dataHook = address(_allowlist);
        rulesets[0].metadata.useDataHookForPay = true;
    }

    function _expectedFundTerminals() private view returns (JBTerminalConfig[] memory terminals) {
        terminals = new JBTerminalConfig[](2);
        terminals[0].terminal = IJBTerminal(_revDeployer.MULTI_TERMINAL());
        terminals[0].accountingContextsToAccept = new JBAccountingContext[](1);
        terminals[0].accountingContextsToAccept[0] =
            JBAccountingContext({token: address(_usdc), decimals: 6, currency: uint32(uint160(address(_usdc)))});
        terminals[1].terminal = IJBTerminal(_revDeployer.ROUTER_TERMINAL_REGISTRY());
    }

    function _globalSnapshot(uint104 localAmount) private view returns (HomerunInitialIncomeSnapshot memory snapshot) {
        snapshot.sourceSetHash = _snapshot.sourceSetHash;
        snapshot.totalFundSupply = _snapshot.totalFundSupply;
        snapshot.manifestHash = _snapshot.manifestHash;
        snapshot.manifestUri = _snapshot.manifestUri;
        snapshot.allocations = new HomerunInitialIncomeAllocation[](2);
        snapshot.allocations[0] = _snapshot.allocations[0];
        snapshot.allocations[0].incomeAmount = localAmount;
        uint104 remoteAmount = uint104(500_000 ether) - localAmount;
        snapshot.allocations[1] = HomerunInitialIncomeAllocation({
            chainId: 10,
            fundProjectId: 7,
            snapshotBlockNumber: 89,
            snapshotBlockHash: keccak256("remote finalized block"),
            incomeAmount: remoteAmount
        });
    }

    function _globalSuckers() private returns (REVSuckerDeploymentConfig memory configuration) {
        configuration.salt = _description().salt;
        configuration.deployerConfigurations = new JBSuckerDeployerConfig[](1);
        configuration.deployerConfigurations[0].deployer = IJBSuckerDeployer(address(new IncomeTestCcipDeployer(10)));
        configuration.deployerConfigurations[0].mappings = new JBTokenMapping[](1);
        configuration.deployerConfigurations[0].mappings[0] = JBTokenMapping({
            localToken: address(_usdc), minGas: 200_000, remoteToken: bytes32(uint256(uint160(address(_remoteUsdc))))
        });
    }

    /// @notice Grants `ids` to `operator` from the FUND owner for `projectId`.
    function _grant(address operator, uint64 projectId, uint8 id) private {
        uint8[] memory ids = new uint8[](1);
        ids[0] = id;
        vm.prank(OPERATOR);
        _permissions.setPermissionsFor(
            OPERATOR, JBPermissionsData({operator: operator, projectId: projectId, permissionIds: ids})
        );
    }

    /// @notice A deployer bound to the test protocol and `hook`, which this test contract configures.
    function _newHelper(address hook) private returns (HomerunDeployer) {
        return new HomerunDeployer(
            IREVDeployer(address(_revDeployer)),
            IJBOmnichainDeployer(address(_omnichain)),
            IHomerunAllowlistHook(hook),
            address(this)
        );
    }

    function _noSuckers() private pure returns (REVSuckerDeploymentConfig memory configuration) {
        configuration.salt = bytes32(uint256(5));
    }

    function _one(address account) private pure returns (address[] memory accounts) {
        accounts = new address[](1);
        accounts[0] = account;
    }

    function _payContext(
        uint256 projectId,
        address beneficiary
    )
        private
        pure
        returns (JBBeforePayRecordedContext memory context)
    {
        context.projectId = projectId;
        context.beneficiary = beneficiary;
        context.payer = address(0xBEEF);
        context.weight = 10_000e18;
        context.amount = JBTokenAmount(address(0), 6, 0, 100e6);
    }
}
