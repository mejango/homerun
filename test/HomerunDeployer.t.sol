// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, stdStorage, StdStorage} from "forge-std/Test.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {JBRulesets} from "@bananapus/core-v6/src/JBRulesets.sol";
import {IJBDirectory} from "@bananapus/core-v6/src/interfaces/IJBDirectory.sol";
import {IJBRulesetApprovalHook} from "@bananapus/core-v6/src/interfaces/IJBRulesetApprovalHook.sol";
import {HomerunDeployer} from "../src/HomerunDeployer.sol";
import {IHomerunDeployer} from "../src/interfaces/IHomerunDeployer.sol";
import {IHomerunAllowlistHook} from "../src/interfaces/IHomerunAllowlistHook.sol";
import {HomerunChainConfig} from "../src/structs/HomerunChainConfig.sol";
import {HomerunInitialIncomeAllocation} from "../src/structs/HomerunInitialIncomeAllocation.sol";
import {HomerunInitialIncomeSnapshot} from "../src/structs/HomerunInitialIncomeSnapshot.sol";
import {HomerunAllowlistHook} from "../src/HomerunAllowlistHook.sol";
import {IJBOmnichainDeployer} from "@bananapus/omnichain-deployers-v6/src/interfaces/IJBOmnichainDeployer.sol";
import {IREVDeployer} from "@rev-net/core-v6/src/interfaces/IREVDeployer.sol";
import {IJBProjects} from "@bananapus/core-v6/src/interfaces/IJBProjects.sol";
import {JBPermissioned} from "@bananapus/core-v6/src/abstract/JBPermissioned.sol";
import {JBPermissions} from "@bananapus/core-v6/src/JBPermissions.sol";
import {IJBPermissions} from "@bananapus/core-v6/src/interfaces/IJBPermissions.sol";
import {JBPermissionsData} from "@bananapus/core-v6/src/structs/JBPermissionsData.sol";
import {JBPermissionIds} from "@bananapus/permission-ids-v6/src/JBPermissionIds.sol";
import {JBBeforePayRecordedContext} from "@bananapus/core-v6/src/structs/JBBeforePayRecordedContext.sol";
import {JBTokenAmount} from "@bananapus/core-v6/src/structs/JBTokenAmount.sol";
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
import {IJBPayerTracker} from "@bananapus/core-v6/src/interfaces/IJBPayerTracker.sol";
import {IJBTerminal} from "@bananapus/core-v6/src/interfaces/IJBTerminal.sol";
import {JBRulesetConfig} from "@bananapus/core-v6/src/structs/JBRulesetConfig.sol";
import {JBTerminalConfig} from "@bananapus/core-v6/src/structs/JBTerminalConfig.sol";
import {JBSuckerDeploymentConfig} from "@bananapus/omnichain-deployers-v6/src/structs/JBSuckerDeploymentConfig.sol";
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
    uint256 public count;
    mapping(uint256 => address) public ownerOf;

    function setOwner(uint256 id, address owner) external {
        ownerOf[id] = owner;
    }

    function createFor(address owner) external payable returns (uint256 id) {
        require(msg.value == creationFee, "fee");
        id = ++count;
        ownerOf[id] = owner;
    }

    function safeTransferFrom(address from, address to, uint256 id) external {
        require(ownerOf[id] == from && msg.sender == from, "owner");
        ownerOf[id] = to;
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
    address public immutable PERMISSIONS;
    mapping(uint256 => JBRuleset) private _rulesets;
    mapping(uint256 => JBRulesetMetadata) private _metadata;
    mapping(uint256 => uint256) public pendingReservedTokenBalanceOf;
    uint48 public latestRulesetOverride;
    uint48 public upcomingRulesetOverride;

    constructor(address directory, address projects, address tokens, address permissions) {
        DIRECTORY = directory;
        PROJECTS = projects;
        TOKENS = tokens;
        PERMISSIONS = permissions;
    }

    function setRuleset(uint256 id, JBRuleset memory ruleset, JBRulesetMetadata memory metadata) external {
        _rulesets[id] = ruleset;
        _metadata[id] = metadata;
    }

    function setPending(uint256 id, uint256 amount) external {
        pendingReservedTokenBalanceOf[id] = amount;
    }

    string public lastTokenName;
    string public lastTokenSymbol;
    bytes32 public lastTokenSalt;

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
    address public immutable ROUTER_TERMINAL_REGISTRY;
    address public immutable SUCKER_REGISTRY;
    bytes public lastConfig;
    bytes public lastNft;
    bytes public lastSuckers;
    address public feePayer;
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
        ROUTER_TERMINAL_REGISTRY = address(new IncomeTestToken());
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
        feePayer = HomerunDeployer(msg.sender).originalPayer();
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
    HomerunDeployer private immutable _helper;
    HomerunInitialIncomeSnapshot private _snapshot;
    bytes4 public reentryError;

    constructor(HomerunDeployer helper, HomerunInitialIncomeSnapshot memory snapshot) {
        _helper = helper;
        _snapshot = snapshot;
    }

    function start() external payable returns (uint256) {
        return _helper.deployIncome{value: 0.01 ether}(1, _snapshot, _description(), 8000, 1_000_000, _noSuckers());
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

    function _noSuckers() private pure returns (REVSuckerDeploymentConfig memory configuration) {
        configuration.salt = bytes32(uint256(5));
    }

    function _description() private pure returns (REVDescription memory) {
        return
            REVDescription({
                name: "House income", ticker: "HOUSE-INCOME", uri: "ipfs://income", salt: bytes32(uint256(5))
            });
    }
}

contract IncomeTestOmnichainDeployer {
    address public constant trustedForwarder = address(0x2771);
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

    address public lastOwner;
    string public lastUri;
    bytes32 public lastRulesetsHash;
    bytes32 public lastTerminalsHash;
    bytes32 public lastSuckersHash;
    uint256 public lastValue;
    address public lastPayer;

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
}

contract IncomeTestCcipDeployer {
    uint256 public immutable ccipRemoteChainId;

    constructor(uint256 remoteChain) {
        ccipRemoteChainId = remoteChain;
    }
}

contract HomerunDeployerTest is Test {
    using stdStorage for StdStorage;

    address private constant OPERATOR = address(0x100);
    address private constant ALICE = address(0x200);
    address private constant BOB = address(0x300);
    address private constant OWNER = address(0x400);
    IncomeTestTokens private tokens;
    IncomeTestProjects private projects;
    JBPermissions private permissions;
    IncomeTestController private controller;
    IncomeTestDirectory private directory;
    IncomeTestSuckerRegistry private suckers;
    IncomeTestRevOwner private revOwner;
    IncomeTestRevDeployer private revDeployer;
    IncomeTestOmnichainDeployer private omnichain;
    IncomeTestToken private usdc;
    IncomeTestToken private remoteUsdc;
    HomerunAllowlistHook private allowlist;
    HomerunDeployer private helper;
    HomerunInitialIncomeSnapshot private _snapshot;

    function setUp() public {
        vm.warp(1_000_000);
        vm.roll(100);
        vm.chainId(1);
        vm.deal(OPERATOR, 10 ether);
        tokens = new IncomeTestTokens();
        projects = new IncomeTestProjects();
        directory = new IncomeTestDirectory();
        permissions = new JBPermissions(address(0x2771));
        controller =
            new IncomeTestController(address(directory), address(projects), address(tokens), address(permissions));
        directory.setController(address(controller));
        suckers = new IncomeTestSuckerRegistry(address(directory), address(projects));
        revOwner = new IncomeTestRevOwner(controller);
        revDeployer = new IncomeTestRevDeployer(controller, address(revOwner), address(suckers));
        revOwner.setDeployer(address(revDeployer));
        usdc = new IncomeTestToken();
        remoteUsdc = new IncomeTestToken();
        directory.setTerminal(revDeployer.MULTI_TERMINAL());
        omnichain = new IncomeTestOmnichainDeployer(controller, address(suckers));
        allowlist = new HomerunAllowlistHook(IJBProjects(address(projects)), permissions, address(0x2771));
        helper = _newHelper(address(allowlist));
        helper.setChainSpecificConstants(_chains());
        vm.prank(OPERATOR);
        (uint256 fundId, address fundToken) = helper.launchFundFor{value: 0.01 ether}(
            OPERATOR, "ipfs://fund", "House FUND", "HOUSE", 0, bytes32(0), new address[](0)
        );
        assertEq(fundId, 1);
        assertEq(fundToken, tokens.tokenOf(1));
        tokens.credit(1, OPERATOR, 100 ether);
        tokens.credit(1, ALICE, 250 ether);
        tokens.mint(1, ALICE, 50 ether);
        tokens.mint(1, BOB, 100 ether);
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

    /// @notice A deployer bound to the test protocol and `hook`, which this test contract configures.
    function _newHelper(address hook) private returns (HomerunDeployer) {
        return new HomerunDeployer(
            IREVDeployer(address(revDeployer)),
            IJBOmnichainDeployer(address(omnichain)),
            IHomerunAllowlistHook(hook),
            address(this)
        );
    }

    function _chains() private view returns (HomerunChainConfig[] memory chains) {
        chains = new HomerunChainConfig[](3);
        uint32[3] memory ids = [uint32(1), 10, 8453];
        for (uint256 i; i < chains.length; i++) {
            chains[i] = HomerunChainConfig({
                chainId: ids[i],
                revDeployer: address(revDeployer),
                usdc: i == 0 ? address(usdc) : address(remoteUsdc),
                omnichainDeployer: address(omnichain),
                allowlistHook: address(allowlist)
            });
        }
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
        return
            REVDescription({
                name: "House income", ticker: "HOUSE-INCOME", uri: "ipfs://income", salt: bytes32(uint256(5))
            });
    }

    function _deploy() private returns (uint256) {
        return _deployFor(OPERATOR);
    }

    function _deployFor(address owner) private returns (uint256) {
        vm.prank(owner);
        return helper.deployIncome{value: 0.01 ether}(1, _snapshot, _description(), 8000, 1_000_000, _noSuckers());
    }

    function testLaunchRecordsTheInitialAllocationForTheOwnerAndPreservesOwnership() public {
        uint256 id = _deploy();
        assertEq(id, 2);
        assertEq(helper.incomeProjectIdOf(1), id);
        // Nothing is minted at launch: the allocation is a stock revnet auto-issuance to the helper.
        assertEq(tokens.totalSupplyOf(id), 0);
        assertEq(revOwner.amountToAutoIssue(id, block.timestamp, address(helper)), 500_000 ether);
        assertEq(revOwner.amountToAutoIssue(id, block.timestamp, OPERATOR), 0);
        assertEq(tokens.totalSupplyOf(1), 500 ether);
        assertEq(projects.ownerOf(id), address(revOwner));
        assertEq(revOwner.operatorOf(id), OPERATOR);
        assertEq(revDeployer.feePayer(), OPERATOR);
        assertEq(helper.originalPayer(), address(0));
        assertEq(controller.pendingReservedTokenBalanceOf(id), 0);
        // Anyone mints it to whoever owns the FUND at that moment; the owner settles the published allocation.
        projects.setOwner(1, OWNER);
        vm.prank(BOB);
        helper.mintInitialAllocation(1);
        assertEq(tokens.totalBalanceOf(OWNER, id), 500_000 ether);
        assertEq(tokens.totalBalanceOf(OPERATOR, id), 0);
        assertEq(tokens.totalBalanceOf(address(helper), id), 0);
        assertEq(tokens.totalSupplyOf(id), 500_000 ether);
        assertEq(revOwner.amountToAutoIssue(id, block.timestamp, address(helper)), 0);
        vm.expectRevert(abi.encodeWithSelector(HomerunDeployer.HomerunDeployer_NothingToMint.selector, 1));
        helper.mintInitialAllocation(1);
        vm.expectRevert(abi.encodeWithSelector(HomerunDeployer.HomerunDeployer_UnsupportedFund.selector, 7));
        helper.mintInitialAllocation(7);
    }

    function testIncomeSentAfterThePayoutCannotReplayTheAllocationEvent() public {
        uint256 id = _deploy();
        helper.mintInitialAllocation(1);
        assertEq(tokens.totalBalanceOf(OPERATOR, id), 500_000 ether);

        // Anyone can send INCOME here after the payout; it must not read as another initial allocation.
        IncomeTestToken income = IncomeTestToken(tokens.tokenOf(id));
        vm.prank(OPERATOR);
        assertTrue(income.transfer(address(helper), 1));
        vm.recordLogs();
        vm.prank(BOB);
        vm.expectRevert(abi.encodeWithSelector(HomerunDeployer.HomerunDeployer_NothingToMint.selector, 1));
        helper.mintInitialAllocation(1);
        assertEq(vm.getRecordedLogs().length, 0);
        assertEq(tokens.totalBalanceOf(address(helper), id), 1);
        assertEq(tokens.totalBalanceOf(OPERATOR, id), 500_000 ether - 1);
    }

    function testStrangerMintingThroughTheRevnetOwnerFirstCannotStrandTheAllocation() public {
        uint256 id = _deploy();
        // The revnet's own auto-issuance is permissionless; a stranger sends the allocation here early.
        vm.prank(BOB);
        revOwner.autoIssueFor(id, block.timestamp, address(helper));
        assertEq(tokens.totalBalanceOf(address(helper), id), 500_000 ether);
        assertEq(revOwner.amountToAutoIssue(id, block.timestamp, address(helper)), 0);
        helper.mintInitialAllocation(1);
        assertEq(tokens.totalBalanceOf(OPERATOR, id), 500_000 ether);
        assertEq(tokens.totalBalanceOf(address(helper), id), 0);
    }

    function testCorrectIncomeConfigurationRoutesTheWholeReservedSplitToTheOwner() public {
        _deploy();
        REVConfig memory config = abi.decode(revDeployer.lastConfig(), (REVConfig));
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
        REVDeploy721TiersHookConfig memory nft = abi.decode(revDeployer.lastNft(), (REVDeploy721TiersHookConfig));
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
        REVConfig memory config = abi.decode(revDeployer.lastConfig(), (REVConfig));
        directory.setController(address(this));
        JBRulesets rulesets = new JBRulesets(IJBDirectory(address(directory)));
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

    function _expectedFundRulesets(uint48 start) private view returns (JBRulesetConfig[] memory rulesets) {
        rulesets = new JBRulesetConfig[](1);
        rulesets[0].mustStartAtOrAfter = start;
        rulesets[0].weight = 10_000e18;
        rulesets[0].metadata.cashOutTaxRate = 1000;
        rulesets[0].metadata.baseCurrency = 2;
        rulesets[0].metadata.dataHook = address(allowlist);
        rulesets[0].metadata.useDataHookForPay = true;
    }

    function _expectedFundTerminals() private view returns (JBTerminalConfig[] memory terminals) {
        terminals = new JBTerminalConfig[](2);
        terminals[0].terminal = IJBTerminal(revDeployer.MULTI_TERMINAL());
        terminals[0].accountingContextsToAccept = new JBAccountingContext[](1);
        terminals[0].accountingContextsToAccept[0] =
            JBAccountingContext({token: address(usdc), decimals: 6, currency: uint32(uint160(address(usdc)))});
        terminals[1].terminal = IJBTerminal(revDeployer.ROUTER_TERMINAL_REGISTRY());
    }

    function testLaunchFundForUsesFixedRulesDeploysTheTokenAndAttributesTheFee() public view {
        assertTrue(helper.isFund(1));
        assertEq(omnichain.lastOwner(), address(helper));
        assertEq(controller.lastTokenName(), "House FUND");
        assertEq(controller.lastTokenSymbol(), "HOUSE");
        assertEq(controller.lastTokenSalt(), bytes32(0));
        assertEq(omnichain.lastUri(), "ipfs://fund");
        assertEq(omnichain.lastValue(), 0.01 ether);
        assertEq(omnichain.lastPayer(), OPERATOR);
        assertEq(helper.originalPayer(), address(0));
        assertEq(omnichain.lastRulesetsHash(), keccak256(abi.encode(_expectedFundRulesets(0))));
        assertEq(omnichain.lastTerminalsHash(), keccak256(abi.encode(_expectedFundTerminals())));
        JBSuckerDeploymentConfig memory noSuckers;
        assertEq(omnichain.lastSuckersHash(), keccak256(abi.encode(noSuckers)));
        assertEq(projects.ownerOf(1), OPERATOR);
    }

    function testLinkedLaunchBuildsUsdcSuckersUnderCallerScopedSalt() public {
        address[] memory peers = new address[](1);
        peers[0] = address(new IncomeTestCcipDeployer(10));
        vm.deal(ALICE, 1 ether);
        vm.expectEmit(true, true, true, true, address(helper));
        emit IHomerunDeployer.FundLaunched(2, OWNER, ALICE);
        vm.prank(ALICE);
        (uint256 id,) = helper.launchFundFor{value: 0.01 ether}(
            OWNER, "ipfs://linked", "Linked FUND", "LINK", 1_000_000, bytes32(uint256(7)), peers
        );
        assertEq(id, 2);
        assertTrue(helper.isFund(2));
        assertEq(projects.ownerOf(2), OWNER);
        // The token salt is scoped to the caller, the owner and the launch terms, like the sucker salt: a linked FUND
        // still shares one token address on every chain, and another launch reusing the public salt cannot block it.
        bytes32 scopedSalt =
            keccak256(abi.encode(ALICE, OWNER, bytes32(uint256(7)), "ipfs://linked", "Linked FUND", "LINK", 1_000_000));
        assertEq(controller.lastTokenSalt(), scopedSalt);
        assertEq(omnichain.lastRulesetsHash(), keccak256(abi.encode(_expectedFundRulesets(1_000_000))));
        JBSuckerDeploymentConfig memory expected;
        expected.salt = scopedSalt;
        expected.deployerConfigurations = new JBSuckerDeployerConfig[](1);
        JBTokenMapping[] memory mappings = new JBTokenMapping[](1);
        mappings[0] = JBTokenMapping({
            localToken: address(usdc), minGas: 200_000, remoteToken: bytes32(uint256(uint160(address(remoteUsdc))))
        });
        expected.deployerConfigurations[0] =
            JBSuckerDeployerConfig({deployer: IJBSuckerDeployer(peers[0]), peer: bytes32(0), mappings: mappings});
        assertEq(omnichain.lastSuckersHash(), keccak256(abi.encode(expected)));
    }

    function testLinkedLaunchSaltCommitsToEveryLaunchTerm() public {
        address[] memory peers = new address[](1);
        peers[0] = address(new IncomeTestCcipDeployer(10));
        bytes32 salt = bytes32(uint256(7));
        vm.deal(ALICE, 1 ether);

        // One sender launches for the same owner and salt, changing one term at a time.
        vm.startPrank(ALICE);
        helper.launchFundFor{value: 0.01 ether}(OWNER, "ipfs://a", "A FUND", "AAA", 1_000_000, salt, peers);
        bytes32 original = controller.lastTokenSalt();
        helper.launchFundFor{value: 0.01 ether}(OWNER, "ipfs://b", "A FUND", "AAA", 1_000_000, salt, peers);
        bytes32 otherUri = controller.lastTokenSalt();
        helper.launchFundFor{value: 0.01 ether}(OWNER, "ipfs://a", "B FUND", "AAA", 1_000_000, salt, peers);
        bytes32 otherName = controller.lastTokenSalt();
        helper.launchFundFor{value: 0.01 ether}(OWNER, "ipfs://a", "A FUND", "BBB", 1_000_000, salt, peers);
        bytes32 otherTicker = controller.lastTokenSalt();
        helper.launchFundFor{value: 0.01 ether}(OWNER, "ipfs://a", "A FUND", "AAA", 1_000_001, salt, peers);
        bytes32 otherStart = controller.lastTokenSalt();
        // The same terms again reproduce the original salt, as a linked launch on another chain does.
        helper.launchFundFor{value: 0.01 ether}(OWNER, "ipfs://a", "A FUND", "AAA", 1_000_000, salt, peers);
        vm.stopPrank();

        assertEq(original, keccak256(abi.encode(ALICE, OWNER, salt, "ipfs://a", "A FUND", "AAA", 1_000_000)));
        assertTrue(otherUri != original);
        assertTrue(otherName != original);
        assertTrue(otherTicker != original);
        assertTrue(otherStart != original);
        assertEq(controller.lastTokenSalt(), original);
    }

    function testForwardedLaunchResolvesTheSignerNotTheForwarder() public {
        address[] memory none = new address[](0);
        vm.deal(address(0x2771), 1 ether);
        vm.expectEmit(true, true, true, true, address(helper));
        emit IHomerunDeployer.FundLaunched(2, OWNER, ALICE);
        vm.prank(address(0x2771));
        (bool ok,) = address(helper).call{value: 0.01 ether}(
            abi.encodePacked(
                abi.encodeCall(helper.launchFundFor, (OWNER, "ipfs://relayed", "Relayed", "RLY", 0, bytes32(0), none)),
                ALICE
            )
        );
        assertTrue(ok);
        assertEq(omnichain.lastPayer(), ALICE);
    }

    function testAllowlistHookMustShareTheProjectRegistry() public {
        address wrongProjects =
            address(new HomerunAllowlistHook(IJBProjects(address(usdc)), permissions, address(0x2771)));
        vm.expectRevert(HomerunDeployer.HomerunDeployer_InvalidProtocolWiring.selector);
        _newHelper(wrongProjects);
        // A hook trusting another forwarder would let relayed allowlist changes resolve to a forged owner.
        address wrongForwarder =
            address(new HomerunAllowlistHook(IJBProjects(address(projects)), permissions, address(0xBEEF)));
        vm.expectRevert(HomerunDeployer.HomerunDeployer_InvalidProtocolWiring.selector);
        _newHelper(wrongForwarder);
        // A hook reading another permissions contract would let grants the owner never made manage the list.
        address wrongPermissions = address(
            new HomerunAllowlistHook(
                IJBProjects(address(projects)),
                IJBPermissions(address(new JBPermissions(address(0x2771)))),
                address(0x2771)
            )
        );
        vm.expectRevert(HomerunDeployer.HomerunDeployer_InvalidProtocolWiring.selector);
        _newHelper(wrongPermissions);
    }

    function testOnlyTheBindingDeployerSetsChainSpecificConstantsOnce() public {
        HomerunDeployer fresh = _newHelper(address(allowlist));
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
        assertEq(fresh.USDC(), address(usdc));
        assertEq(fresh.usdcOf(1), address(usdc));
        assertEq(fresh.usdcOf(10), address(remoteUsdc));
        assertEq(fresh.usdcOf(8453), address(remoteUsdc));
        vm.expectRevert(HomerunDeployer.HomerunDeployer_AlreadyConfigured.selector);
        fresh.setChainSpecificConstants(_chains());
    }

    function testEntryPointsRevertUntilConfigured() public {
        HomerunDeployer fresh = _newHelper(address(allowlist));
        vm.startPrank(OPERATOR);
        vm.expectRevert(HomerunDeployer.HomerunDeployer_NotConfigured.selector);
        fresh.launchFundFor{value: 0.01 ether}(OPERATOR, "ipfs://fund", "FUND", "FUND", 0, bytes32(0), new address[](0));
        vm.expectRevert(HomerunDeployer.HomerunDeployer_NotConfigured.selector);
        fresh.deployIncome{value: 0.01 ether}(1, _snapshot, _description(), 8000, 1_000_000, _noSuckers());
        vm.expectRevert(HomerunDeployer.HomerunDeployer_NotConfigured.selector);
        fresh.mintInitialAllocation(1);
        vm.stopPrank();
    }

    function testChainSpecificConstantsRejectInconsistentEntries() public {
        HomerunDeployer fresh = _newHelper(address(allowlist));
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
        vm.mockCall(address(usdc), abi.encodeWithSignature("decimals()"), abi.encode(uint8(18)));
        vm.expectRevert(HomerunDeployer.HomerunDeployer_InvalidProtocolWiring.selector);
        fresh.setChainSpecificConstants(_chains());
        vm.clearMockedCalls();
        fresh.setChainSpecificConstants(_chains());
        assertEq(fresh.USDC(), address(usdc));
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

    function testAllowlistGatesBeneficiariesUntilTheOwnerAllowsOrOpens() public {
        vm.expectRevert(abi.encodeWithSelector(HomerunAllowlistHook.HomerunAllowlistHook_NotAllowed.selector, 1, ALICE));
        allowlist.beforePayRecordedWith(_payContext(1, ALICE));
        address[] memory accounts = new address[](1);
        accounts[0] = ALICE;
        vm.expectPartialRevert(JBPermissioned.JBPermissioned_Unauthorized.selector);
        vm.prank(ALICE);
        allowlist.setAllowed(1, accounts, true);
        vm.expectEmit(true, true, true, true, address(allowlist));
        emit IHomerunAllowlistHook.AllowedSet(1, ALICE, true, OPERATOR);
        vm.prank(OPERATOR);
        allowlist.setAllowed(1, accounts, true);
        (uint256 weight,) = allowlist.beforePayRecordedWith(_payContext(1, ALICE));
        assertEq(weight, 10_000e18, "an allowed beneficiary keeps the ruleset weight");
        // The payer is irrelevant; routed payments arrive from the router.
        vm.expectRevert(abi.encodeWithSelector(HomerunAllowlistHook.HomerunAllowlistHook_NotAllowed.selector, 1, BOB));
        allowlist.beforePayRecordedWith(_payContext(1, BOB));
        vm.prank(OPERATOR);
        allowlist.setAllowed(1, accounts, false);
        vm.expectRevert(abi.encodeWithSelector(HomerunAllowlistHook.HomerunAllowlistHook_NotAllowed.selector, 1, ALICE));
        allowlist.beforePayRecordedWith(_payContext(1, ALICE));
        vm.expectPartialRevert(JBPermissioned.JBPermissioned_Unauthorized.selector);
        allowlist.setOpen(1, true);
        vm.prank(OPERATOR);
        allowlist.setOpen(1, true);
        allowlist.beforePayRecordedWith(_payContext(1, BOB));
        assertTrue(allowlist.canPay(1, BOB));
        // Lists are per project.
        vm.expectRevert(abi.encodeWithSelector(HomerunAllowlistHook.HomerunAllowlistHook_NotAllowed.selector, 2, BOB));
        allowlist.beforePayRecordedWith(_payContext(2, BOB));
        assertFalse(allowlist.hasMintPermissionFor(1, _closedRuleset(), OPERATOR));
    }

    function testForwardedAllowlistManagementResolvesTheSigner() public {
        address[] memory accounts = new address[](1);
        accounts[0] = BOB;
        vm.prank(address(0x2771));
        (bool ok,) = address(allowlist)
            .call(abi.encodePacked(abi.encodeCall(allowlist.setAllowed, (1, accounts, true)), OPERATOR));
        assertTrue(ok);
        assertTrue(allowlist.isAllowed(1, BOB));
        vm.prank(address(0x2771));
        (ok,) = address(allowlist)
            .call(abi.encodePacked(abi.encodeCall(allowlist.setAllowed, (1, accounts, false)), ALICE));
        assertFalse(ok);
        assertTrue(allowlist.isAllowed(1, BOB));
    }

    /// @notice Grants `ids` to `operator` from the FUND owner for `projectId`.
    function _grant(address operator, uint64 projectId, uint8 id) private {
        uint8[] memory ids = new uint8[](1);
        ids[0] = id;
        vm.prank(OPERATOR);
        permissions.setPermissionsFor(
            OPERATOR, JBPermissionsData({operator: operator, projectId: projectId, permissionIds: ids})
        );
    }

    function _one(address account) private pure returns (address[] memory accounts) {
        accounts = new address[](1);
        accounts[0] = account;
    }

    function testAllowlistPermissionIdSitsOutsideTheEcosystemRegistry() public view {
        assertEq(allowlist.SET_ALLOWLIST_PERMISSION_ID(), 128);
        assertGt(allowlist.SET_ALLOWLIST_PERMISSION_ID(), JBPermissionIds.REPAY_LOAN);
        assertEq(address(allowlist.PERMISSIONS()), address(permissions));
    }

    function testGrantedOperatorManagesTheAllowlist() public {
        _grant(ALICE, 1, allowlist.SET_ALLOWLIST_PERMISSION_ID());
        vm.expectEmit(true, true, true, true, address(allowlist));
        emit IHomerunAllowlistHook.AllowedSet(1, BOB, true, ALICE);
        vm.prank(ALICE);
        allowlist.setAllowed(1, _one(BOB), true);
        assertTrue(allowlist.isAllowed(1, BOB));
        vm.expectEmit(true, true, true, true, address(allowlist));
        emit IHomerunAllowlistHook.OpenSet(1, true, ALICE);
        vm.prank(ALICE);
        allowlist.setOpen(1, true);
        assertTrue(allowlist.isOpen(1));
        // The owner keeps full power alongside the operator.
        vm.prank(OPERATOR);
        allowlist.setOpen(1, false);
        vm.prank(OPERATOR);
        allowlist.setAllowed(1, _one(BOB), false);
        assertFalse(allowlist.canPay(1, BOB));
    }

    function testWildcardGrantManagesTheAllowlist() public {
        _grant(ALICE, 0, allowlist.SET_ALLOWLIST_PERMISSION_ID());
        vm.prank(ALICE);
        allowlist.setOpen(1, true);
        assertTrue(allowlist.isOpen(1));
    }

    function testRootOperatorManagesTheAllowlist() public {
        _grant(ALICE, 1, JBPermissionIds.ROOT);
        vm.prank(ALICE);
        allowlist.setAllowed(1, _one(BOB), true);
        vm.prank(ALICE);
        allowlist.setOpen(1, true);
        assertTrue(allowlist.isAllowed(1, BOB));
        assertTrue(allowlist.isOpen(1));
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
                allowlist.SET_ALLOWLIST_PERMISSION_ID()
            )
        );
        vm.prank(ALICE);
        allowlist.setAllowed(1, _one(BOB), true);
        vm.expectPartialRevert(JBPermissioned.JBPermissioned_Unauthorized.selector);
        vm.prank(ALICE);
        allowlist.setOpen(1, true);
    }

    function testAllowlistGrantForAnotherProjectIsRejected() public {
        _grant(ALICE, 2, allowlist.SET_ALLOWLIST_PERMISSION_ID());
        vm.expectPartialRevert(JBPermissioned.JBPermissioned_Unauthorized.selector);
        vm.prank(ALICE);
        allowlist.setAllowed(1, _one(BOB), true);
        vm.expectPartialRevert(JBPermissioned.JBPermissioned_Unauthorized.selector);
        vm.prank(ALICE);
        allowlist.setOpen(1, true);
    }

    function testAllowlistGrantFromAPreviousOwnerLapsesOnTransfer() public {
        _grant(ALICE, 1, allowlist.SET_ALLOWLIST_PERMISSION_ID());
        projects.setOwner(1, OWNER);
        vm.expectPartialRevert(JBPermissioned.JBPermissioned_Unauthorized.selector);
        vm.prank(ALICE);
        allowlist.setOpen(1, true);
    }

    function testForwardedOperatorManagementResolvesTheSigner() public {
        _grant(ALICE, 1, allowlist.SET_ALLOWLIST_PERMISSION_ID());
        vm.prank(address(0x2771));
        (bool ok,) =
            address(allowlist).call(abi.encodePacked(abi.encodeCall(allowlist.setAllowed, (1, _one(BOB), true)), ALICE));
        assertTrue(ok);
        assertTrue(allowlist.isAllowed(1, BOB));
        vm.prank(address(0x2771));
        (ok,) = address(allowlist).call(abi.encodePacked(abi.encodeCall(allowlist.setOpen, (1, true)), ALICE));
        assertTrue(ok);
        assertTrue(allowlist.isOpen(1));
        // A signer without the grant is refused even through the forwarder.
        vm.prank(address(0x2771));
        (ok,) = address(allowlist).call(abi.encodePacked(abi.encodeCall(allowlist.setOpen, (1, false)), BOB));
        assertFalse(ok);
        assertTrue(allowlist.isOpen(1));
        // The forwarder itself holds no grant, so without a suffix it is refused.
        vm.prank(address(0x2771));
        vm.expectPartialRevert(JBPermissioned.JBPermissioned_Unauthorized.selector);
        allowlist.setOpen(1, false);
    }

    function _closedRuleset() private view returns (JBRuleset memory ruleset) {
        (ruleset,) = controller.currentRulesetOf(1);
    }

    function testClosedFundMayKeepItsAllowlistHook() public {
        (JBRuleset memory ruleset, JBRulesetMetadata memory metadata) = controller.currentRulesetOf(1);
        metadata.dataHook = address(omnichain);
        metadata.useDataHookForPay = true;
        metadata.useDataHookForCashOut = true;
        controller.setRuleset(1, ruleset, metadata);
        omnichain.setExtraHook(address(allowlist), true, false);
        assertEq(_deploy(), 2);
    }

    function testLaunchFundForRejectsMalformedInputs() public {
        address[] memory none = new address[](0);
        address[] memory peers = new address[](1);
        peers[0] = address(new IncomeTestCcipDeployer(10));
        vm.startPrank(OPERATOR);
        // Salt without peers, peers without salt, and linked launches without a shared start.
        vm.expectRevert(HomerunDeployer.HomerunDeployer_InvalidConfiguration.selector);
        helper.launchFundFor{value: 0.01 ether}(OPERATOR, "ipfs://fund", "F", "F", 0, bytes32(uint256(1)), none);
        vm.expectRevert(HomerunDeployer.HomerunDeployer_InvalidConfiguration.selector);
        helper.launchFundFor{value: 0.01 ether}(OPERATOR, "ipfs://fund", "F", "F", 1_000_000, bytes32(0), peers);
        vm.expectRevert(HomerunDeployer.HomerunDeployer_InvalidConfiguration.selector);
        helper.launchFundFor{value: 0.01 ether}(OPERATOR, "ipfs://fund", "F", "F", 0, bytes32(uint256(1)), peers);
        // Unknown remote chain, the local chain, duplicate peers, and descending peers.
        peers[0] = address(new IncomeTestCcipDeployer(42_161));
        vm.expectRevert(HomerunDeployer.HomerunDeployer_InvalidConfiguration.selector);
        helper.launchFundFor{value: 0.01 ether}(
            OPERATOR, "ipfs://fund", "F", "F", 1_000_000, bytes32(uint256(1)), peers
        );
        peers[0] = address(new IncomeTestCcipDeployer(1));
        vm.expectRevert(HomerunDeployer.HomerunDeployer_InvalidConfiguration.selector);
        helper.launchFundFor{value: 0.01 ether}(
            OPERATOR, "ipfs://fund", "F", "F", 1_000_000, bytes32(uint256(1)), peers
        );
        address[] memory unsorted = new address[](2);
        unsorted[0] = address(new IncomeTestCcipDeployer(10));
        unsorted[1] = address(new IncomeTestCcipDeployer(10));
        vm.expectRevert(HomerunDeployer.HomerunDeployer_InvalidConfiguration.selector);
        helper.launchFundFor{value: 0.01 ether}(
            OPERATOR, "ipfs://fund", "F", "F", 1_000_000, bytes32(uint256(1)), unsorted
        );
        unsorted[0] = address(new IncomeTestCcipDeployer(8453));
        vm.expectRevert(HomerunDeployer.HomerunDeployer_InvalidConfiguration.selector);
        helper.launchFundFor{value: 0.01 ether}(
            OPERATOR, "ipfs://fund", "F", "F", 1_000_000, bytes32(uint256(1)), unsorted
        );
        (unsorted[0], unsorted[1]) = (unsorted[1], unsorted[0]);
        helper.launchFundFor{value: 0.01 ether}(
            OPERATOR, "ipfs://fund", "F", "F", 1_000_000, bytes32(uint256(1)), unsorted
        );
        vm.stopPrank();
    }

    function testIncomeOnlyAttachesToFundsLaunchedHere() public {
        projects.setOwner(50, OPERATOR);
        _snapshot.allocations[0].fundProjectId = 50;
        vm.prank(OPERATOR);
        vm.expectPartialRevert(HomerunDeployer.HomerunDeployer_UnsupportedFund.selector);
        helper.deployIncome{value: 0.01 ether}(50, _snapshot, _description(), 8000, 1_000_000, _noSuckers());
    }

    function testUnauthorizedOwnerCannotLaunch() public {
        vm.expectPartialRevert(HomerunDeployer.HomerunDeployer_Unauthorized.selector);
        helper.deployIncome(1, _snapshot, _description(), 8000, 1_000_000, _noSuckers());
    }

    function testOwnerKeepsAuthorityAndTheReservedSplitAfterTransfer() public {
        projects.setOwner(1, OWNER);
        vm.deal(OWNER, 1 ether);
        vm.expectPartialRevert(HomerunDeployer.HomerunDeployer_Unauthorized.selector);
        _deployFor(OPERATOR);
        _assertRollback();

        vm.expectEmit(true, true, true, false, address(helper));
        emit IHomerunDeployer.IncomeDeployed(1, 2, OWNER);
        uint256 id = _deployFor(OWNER);
        REVConfig memory config = abi.decode(revDeployer.lastConfig(), (REVConfig));
        assertEq(projects.ownerOf(1), OWNER);
        assertEq(projects.ownerOf(id), address(revOwner));
        assertEq(config.operator, OWNER);
        assertTrue(revOwner.isOperatorOf(id, OWNER));
        assertFalse(revOwner.isOperatorOf(id, OPERATOR));
        assertEq(revDeployer.feePayer(), OWNER);
        assertEq(config.stageConfigurations[0].splits[0].beneficiary, OWNER);
    }

    function testReservedPercentAndTickerAreCallerChoices() public {
        REVDescription memory description = _description();
        vm.startPrank(OPERATOR);
        description.ticker = "RENT";
        helper.deployIncome{value: 0.01 ether}(1, _snapshot, description, 0, 1_000_000, _noSuckers());
        vm.stopPrank();
        REVConfig memory config = abi.decode(revDeployer.lastConfig(), (REVConfig));
        assertEq(config.description.ticker, "RENT");
        assertEq(config.stageConfigurations[0].splitPercent, 0);
        assertEq(config.stageConfigurations[0].splits.length, 1);
    }

    function testLinkedFundIsCoveredByAttestedGlobalSnapshot() public {
        suckers.setLinked(true);
        assertEq(_deploy(), 2);
    }

    function _assertRollback() private view {
        assertEq(projects.count(), 1);
        assertEq(helper.incomeProjectIdOf(1), 0);
        assertEq(tokens.tokenOf(2), address(0));
        assertEq(address(helper).balance, 0);
        assertEq(helper.originalPayer(), address(0));
    }

    function testOnlyOneIncomeCanBeLaunchedForFund() public {
        _deploy();
        vm.expectPartialRevert(HomerunDeployer.HomerunDeployer_AlreadyDeployed.selector);
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

    function testHistoricalSnapshotDoesNotChangeAfterTransfer() public {
        IncomeTestToken fundToken = IncomeTestToken(tokens.tokenOf(1));
        vm.prank(ALICE);
        assertTrue(fundToken.transfer(BOB, 50 ether));
        uint256 id = _deploy();
        // The FUND transfer after the snapshot block does not change the attested allocation.
        assertEq(revOwner.amountToAutoIssue(id, block.timestamp, address(helper)), 500_000 ether);
        assertEq(tokens.totalBalanceOf(ALICE, 1), 250 ether);
    }

    function _globalSnapshot(uint104 localAmount) private view returns (HomerunInitialIncomeSnapshot memory snapshot) {
        snapshot.sourceSetHash = _snapshot.sourceSetHash;
        snapshot.totalFundSupply = _snapshot.totalFundSupply;
        snapshot.manifestHash = _snapshot.manifestHash;
        snapshot.manifestUri = _snapshot.manifestUri;
        snapshot.allocations = new HomerunInitialIncomeAllocation[](2);
        snapshot.allocations[0] = _snapshot.allocations[0];
        snapshot.allocations[0].incomeAmount = localAmount;
        if (localAmount == 0) {}
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
            localToken: address(usdc), minGas: 200_000, remoteToken: bytes32(uint256(uint160(address(remoteUsdc))))
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
        return helper.deployIncome{value: 0.01 ether}(1, snapshot, _description(), 8000, 1_000_000, configuration);
    }

    function testPartialGlobalAllocationMintsOnlyLocalShare() public {
        HomerunInitialIncomeSnapshot memory snapshot = _globalSnapshot(uint104(120_000 ether));
        REVSuckerDeploymentConfig memory configuration = _globalSuckers();
        uint256 incomeId = _deployGlobal(snapshot, configuration);
        assertEq(revOwner.amountToAutoIssue(incomeId, block.timestamp, address(helper)), 120_000 ether);
        assertEq(tokens.totalSupplyOf(incomeId), 0);
        REVConfig memory config = abi.decode(revDeployer.lastConfig(), (REVConfig));
        assertEq(config.stageConfigurations[0].autoIssuances.length, 2);
        assertEq(config.stageConfigurations[0].autoIssuances[0].count, 120_000 ether);
        assertEq(config.stageConfigurations[0].autoIssuances[0].beneficiary, address(helper));
        assertEq(config.stageConfigurations[0].autoIssuances[1].count, 380_000 ether);
        assertEq(config.stageConfigurations[0].autoIssuances[1].chainId, 10);
        assertEq(config.stageConfigurations[0].autoIssuances[1].beneficiary, address(helper));
        assertEq(config.description.salt, helper.configurationSaltFor(snapshot, _description().salt));
        helper.mintInitialAllocation(1);
        assertEq(tokens.totalBalanceOf(OPERATOR, incomeId), 120_000 ether);
        assertEq(revOwner.amountToAutoIssue(incomeId, block.timestamp, address(helper)), 0);
    }

    function testZeroLocalAllocationRecordsNothingToMint() public {
        HomerunInitialIncomeSnapshot memory snapshot = _globalSnapshot(0);
        REVSuckerDeploymentConfig memory configuration = _globalSuckers();
        uint256 incomeId = _deployGlobal(snapshot, configuration);
        assertEq(revOwner.amountToAutoIssue(incomeId, block.timestamp, address(helper)), 0);
        assertEq(tokens.totalSupplyOf(incomeId), 0);
        vm.expectRevert(abi.encodeWithSelector(HomerunDeployer.HomerunDeployer_NothingToMint.selector, 1));
        helper.mintInitialAllocation(1);
        REVConfig memory config = abi.decode(revDeployer.lastConfig(), (REVConfig));
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
        assertEq(helper.incomeProjectIdOf(1), 0);
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
        bytes32 beforeChange = helper.configurationSaltFor(snapshot, _description().salt);
        snapshot.allocations[1].snapshotBlockHash = keccak256("changed remote source block");
        bytes32 changedBlock = helper.configurationSaltFor(snapshot, _description().salt);
        assertNotEq(beforeChange, changedBlock);
        snapshot.manifestHash = keccak256("changed public manifest");
        assertNotEq(changedBlock, helper.configurationSaltFor(snapshot, _description().salt));
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
        configuration.deployerConfigurations[0].mappings[0].remoteToken = bytes32(uint256(uint160(address(usdc))));
        configuration.deployerConfigurations[0].deployer =
            IJBSuckerDeployer(address(new IncomeTestCcipDeployer(42_161)));
        vm.expectRevert(HomerunDeployer.HomerunDeployer_InvalidConfiguration.selector);
        _deployGlobal(snapshot, configuration);
    }

    function testSharedProtocolProfileRequiresUniqueSortedChains() public {
        HomerunDeployer fresh = _newHelper(address(allowlist));
        HomerunChainConfig[] memory chains = _chains();
        chains[1].chainId = 1;
        vm.expectRevert(HomerunDeployer.HomerunDeployer_InvalidProtocolWiring.selector);
        fresh.setChainSpecificConstants(chains);
        chains[0].chainId = 10;
        vm.expectRevert(HomerunDeployer.HomerunDeployer_InvalidProtocolWiring.selector);
        fresh.setChainSpecificConstants(chains);
    }
}
