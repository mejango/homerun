// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IJBController} from "@bananapus/core-v6/src/interfaces/IJBController.sol";
import {IJBDirectory} from "@bananapus/core-v6/src/interfaces/IJBDirectory.sol";
import {IJBProjects} from "@bananapus/core-v6/src/interfaces/IJBProjects.sol";
import {IJBSplitHook} from "@bananapus/core-v6/src/interfaces/IJBSplitHook.sol";
import {IJBTerminal} from "@bananapus/core-v6/src/interfaces/IJBTerminal.sol";
import {IJBTokens} from "@bananapus/core-v6/src/interfaces/IJBTokens.sol";
import {JBConstants} from "@bananapus/core-v6/src/libraries/JBConstants.sol";
import {JBCurrencyIds} from "@bananapus/core-v6/src/libraries/JBCurrencyIds.sol";
import {JBPayerTrackerLib} from "@bananapus/core-v6/src/libraries/JBPayerTrackerLib.sol";
import {JBAccountingContext} from "@bananapus/core-v6/src/structs/JBAccountingContext.sol";
import {JBRuleset} from "@bananapus/core-v6/src/structs/JBRuleset.sol";
import {JBRulesetConfig} from "@bananapus/core-v6/src/structs/JBRulesetConfig.sol";
import {JBSplit} from "@bananapus/core-v6/src/structs/JBSplit.sol";
import {JBTerminalConfig} from "@bananapus/core-v6/src/structs/JBTerminalConfig.sol";
import {IJBOmnichainDeployer} from "@bananapus/omnichain-deployers-v6/src/interfaces/IJBOmnichainDeployer.sol";
import {JBOmnichainDeployer} from "@bananapus/omnichain-deployers-v6/src/JBOmnichainDeployer.sol";
import {JBSuckerDeploymentConfig} from "@bananapus/omnichain-deployers-v6/src/structs/JBSuckerDeploymentConfig.sol";
import {IJBCCIPSuckerDeployer} from "@bananapus/suckers-v6/src/interfaces/IJBCCIPSuckerDeployer.sol";
import {IJBSuckerDeployer} from "@bananapus/suckers-v6/src/interfaces/IJBSuckerDeployer.sol";
import {IJBSuckerRegistry} from "@bananapus/suckers-v6/src/interfaces/IJBSuckerRegistry.sol";
import {JBSuckerDeployerConfig} from "@bananapus/suckers-v6/src/structs/JBSuckerDeployerConfig.sol";
import {JBTokenMapping} from "@bananapus/suckers-v6/src/structs/JBTokenMapping.sol";
import {ERC2771Context} from "@openzeppelin/contracts/metatx/ERC2771Context.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IREVDeployer} from "@rev-net/core-v6/src/interfaces/IREVDeployer.sol";
import {IREVOwner} from "@rev-net/core-v6/src/interfaces/IREVOwner.sol";
import {REVAutoIssuance} from "@rev-net/core-v6/src/structs/REVAutoIssuance.sol";
import {REVConfig} from "@rev-net/core-v6/src/structs/REVConfig.sol";
import {REVCroptopAllowedPost} from "@rev-net/core-v6/src/structs/REVCroptopAllowedPost.sol";
import {REVDeploy721TiersHookConfig} from "@rev-net/core-v6/src/structs/REVDeploy721TiersHookConfig.sol";
import {REVDescription} from "@rev-net/core-v6/src/structs/REVDescription.sol";
import {REVStageConfig} from "@rev-net/core-v6/src/structs/REVStageConfig.sol";
import {REVSuckerDeploymentConfig} from "@rev-net/core-v6/src/structs/REVSuckerDeploymentConfig.sol";

import {IArbSys} from "./interfaces/IArbSys.sol";
import {IHomerunAllowlistHook} from "./interfaces/IHomerunAllowlistHook.sol";
import {IHomerunDeployer} from "./interfaces/IHomerunDeployer.sol";
import {HomerunChainConfig} from "./structs/HomerunChainConfig.sol";
import {HomerunInitialIncomeAllocation} from "./structs/HomerunInitialIncomeAllocation.sol";
import {HomerunInitialIncomeSnapshot} from "./structs/HomerunInitialIncomeSnapshot.sol";

/// @notice Launches Homerun FUNDs with fixed campaign rules and, for a FUND, its INCOME revnet with the bounded
/// initial INCOME allocation recorded for the FUND's owner.
/// @dev FUND rules and INCOME economics are fixed here; callers choose names, tickers, timing, chains and the INCOME
/// reserved percent. The FUND owner attests to a fixed, published snapshot of who holds what. Its completeness,
/// historical balances, allocation sums, and the FUND's state are NOT verified onchain; close the campaign, then
/// reproduce and reconcile the manifest before signing. Each chain's share of the allocation is a stock revnet
/// auto-issuance to this contract that anyone can mint to the FUND's current owner once INCOME's stage has started;
/// the owner settles it to the snapshot's holders. Every chain commits the same global allocation and deploys
/// asynchronously. This contract retains no project ownership, tokens, or operator permissions. INCOME's reserved split
/// is unlocked and routed to the owner, who redirects it later through the stock controller. UNAUDITED.
contract HomerunDeployer is ERC2771Context, ReentrancyGuard, IERC721Receiver, IHomerunDeployer {
    // A library that adds default safety checks to ERC20 transfers.
    using SafeERC20 for IERC20;

    //*********************************************************************//
    // --------------------------- custom errors ------------------------- //
    //*********************************************************************//

    error HomerunDeployer_AlreadyDeployed(uint256 fundProjectId, uint256 incomeProjectId);
    error HomerunDeployer_IncompleteIssuance(uint256 incomeProjectId);
    error HomerunDeployer_InvalidConfiguration();
    error HomerunDeployer_InvalidProtocolWiring();
    error HomerunDeployer_InvalidSnapshot();
    error HomerunDeployer_NothingToMint(uint256 fundProjectId);
    error HomerunDeployer_Unauthorized(address caller);
    error HomerunDeployer_UnsupportedFund(uint256 fundProjectId);
    error HomerunDeployer_WrongCreationFee(uint256 sent, uint256 required);

    //*********************************************************************//
    // ------------------------- public constants ------------------------ //
    //*********************************************************************//

    /// @notice The cash out tax rate a FUND launches with, out of `JBConstants.MAX_CASH_OUT_TAX_RATE`.
    /// @dev 10% while the campaign is open. The owner closes the campaign by raising it to the maximum.
    uint16 public constant override FUND_CASH_OUT_TAX_RATE = 1000;

    /// @notice The CCIP gas allowance every FUND sucker mapping uses.
    /// @dev Matches the Nana SDK default.
    uint32 public constant override FUND_SUCKER_MIN_GAS = 200_000;

    /// @notice The FUND issued per unit of USD paid, as a fixed point number with 18 decimals.
    uint112 public constant override FUND_WEIGHT = 10_000e18;

    /// @notice The cash out tax rate INCOME launches with, out of `JBConstants.MAX_CASH_OUT_TAX_RATE`.
    uint16 public constant override INCOME_CASH_OUT_TAX_RATE = 1000;

    /// @notice The percent INCOME issuance falls by every quarter, out of `JBConstants.MAX_WEIGHT_CUT_PERCENT`.
    /// @dev 2%, indefinitely.
    uint32 public constant override INCOME_CUT_PERCENT = 20_000_000;

    /// @notice The INCOME issued per unit of USD paid at launch, as a fixed point number with 18 decimals.
    uint112 public constant override INCOME_INITIAL_ISSUANCE = 10 ether;

    /// @notice The INCOME every FUND's holders share at launch, across every chain, as a fixed point number with 18
    /// decimals.
    uint256 public constant override INITIAL_INCOME_SUPPLY = 500_000 ether;

    /// @notice The version of the launch semantics this deployer implements.
    uint256 public constant override LAUNCH_VERSION = 4;

    /// @notice The number of seconds in one INCOME issuance cycle.
    /// @dev One fourth of a 365-day year.
    uint32 public constant override QUARTER = 7_884_000;

    //*********************************************************************//
    // ----------------------- internal constants ------------------------ //
    //*********************************************************************//

    /// @notice The chain ID of Arbitrum One.
    uint256 internal constant _ARBITRUM_CHAIN_ID = 42_161;

    /// @notice The chain ID of Arbitrum Sepolia.
    uint256 internal constant _ARBITRUM_SEPOLIA_CHAIN_ID = 421_614;

    /// @notice The `ArbSys` precompile that exposes L2 block identity on Arbitrum chains.
    IArbSys internal constant _ARB_SYS = IArbSys(address(100));

    /// @notice The number of recent blocks whose hashes the EVM still serves.
    uint256 internal constant _BLOCKHASH_WINDOW = 256;

    /// @notice The `extraMetadata` every INCOME stage carries: the stock sucker deployment/retry bit.
    uint16 internal constant _INCOME_STAGE_EXTRA_METADATA = 4;

    /// @notice The number of decimals in USDC.
    uint8 internal constant _USDC_DECIMALS = 6;

    //*********************************************************************//
    // --------------- public immutable stored properties ---------------- //
    //*********************************************************************//

    /// @notice The pay hook installed on every FUND. Its owner-managed allowlist gates payment beneficiaries.
    IHomerunAllowlistHook public immutable override ALLOWLIST_HOOK;

    /// @notice The controller every FUND and INCOME is launched with.
    IJBController public immutable override CONTROLLER;

    /// @notice The directory of terminals and controllers.
    IJBDirectory public immutable override DIRECTORY;

    /// @notice The omnichain deployer every FUND is launched through.
    IJBOmnichainDeployer public immutable override OMNICHAIN_DEPLOYER;

    /// @notice The project registry.
    IJBProjects public immutable override PROJECTS;

    /// @notice The hash of the complete per-chain configuration this deployer was constructed with.
    /// @dev Identical on every chain, since the same array is passed everywhere.
    bytes32 public immutable override PROTOCOL_CONFIG_HASH;

    /// @notice The revnet deployer INCOME is launched through.
    IREVDeployer public immutable override REV_DEPLOYER;

    /// @notice The contract that owns every INCOME revnet.
    IREVOwner public immutable override REV_OWNER;

    /// @notice The router terminal registry every FUND and INCOME registers so any token can pay through swap
    /// routing.
    IJBTerminal public immutable override ROUTER_TERMINAL_REGISTRY;

    /// @notice The sucker registry linked FUNDs and INCOMEs deploy suckers through.
    IJBSuckerRegistry public immutable override SUCKER_REGISTRY;

    /// @notice The terminal every FUND and INCOME treasury lives in.
    IJBTerminal public immutable override TERMINAL;

    /// @notice The token registry.
    IJBTokens public immutable override TOKENS;

    /// @notice The USDC token every FUND and INCOME treasury accounts in on this chain.
    address public immutable override USDC;

    //*********************************************************************//
    // --------------------- public stored properties -------------------- //
    //*********************************************************************//

    /// @notice The INCOME project a FUND launched, if any.
    /// @dev Holds `type(uint256).max` while a launch is in progress so external calls cannot reenter.
    /// @custom:param fundProjectId The ID of the FUND project.
    mapping(uint256 fundProjectId => uint256 incomeProjectId) public override incomeProjectIdOf;

    /// @notice Whether a project was launched as a FUND through this deployer. INCOME only attaches to these.
    /// @custom:param projectId The ID of the project.
    mapping(uint256 projectId => bool) public override isFund;

    /// @notice The USDC token on a linked chain.
    /// @custom:param chainId The ID of the chain.
    mapping(uint32 chainId => address usdc) public override usdcOf;

    //*********************************************************************//
    // ------------------- transient stored properties ------------------- //
    //*********************************************************************//

    /// @notice The account that paid the creation fee for the project currently being launched.
    /// @dev Resolved from the caller through `JBPayerTrackerLib` and exposed while the launch runs, so `JBProjects`
    /// credits the fee to the signer instead of this contract. Cleared once the launch returns.
    address public transient override originalPayer;

    //*********************************************************************//
    // -------------------------- constructor ---------------------------- //
    //*********************************************************************//

    /// @dev Identical constructor calldata on every chain keeps the same CREATE2 address despite chain-specific
    /// dependencies. The trusted forwarder is the one the local omnichain deployer trusts, so relayed launches
    /// resolve the signer instead of the forwarder.
    /// @param chains One entry per supported chain, in ascending chain ID. The entry for `block.chainid` is bound
    /// into the immutables; the others only provide `usdcOf`.
    constructor(HomerunChainConfig[] memory chains) ERC2771Context(_forwarderOf(chains)) {
        HomerunChainConfig memory local;
        uint32 previousChain;
        for (uint256 i; i < chains.length; i++) {
            HomerunChainConfig memory entry = chains[i];
            if (entry.chainId <= previousChain || entry.usdc == address(0)) {
                revert HomerunDeployer_InvalidProtocolWiring();
            }
            previousChain = entry.chainId;
            usdcOf[entry.chainId] = entry.usdc;
            if (entry.chainId == block.chainid) local = entry;
        }
        PROTOCOL_CONFIG_HASH = keccak256(abi.encode(chains));

        if (
            local.controller.code.length == 0 || local.revDeployer.code.length == 0 || local.usdc.code.length == 0
                || local.omnichainDeployer.code.length == 0 || local.routerTerminalRegistry.code.length == 0
                || local.allowlistHook.code.length == 0
        ) revert HomerunDeployer_InvalidProtocolWiring();

        CONTROLLER = IJBController(local.controller);
        DIRECTORY = CONTROLLER.DIRECTORY();
        PROJECTS = CONTROLLER.PROJECTS();
        TOKENS = CONTROLLER.TOKENS();
        REV_DEPLOYER = IREVDeployer(local.revDeployer);
        REV_OWNER = IREVOwner(REV_DEPLOYER.OWNER());
        SUCKER_REGISTRY = REV_DEPLOYER.SUCKER_REGISTRY();
        TERMINAL = REV_DEPLOYER.MULTI_TERMINAL();
        USDC = local.usdc;
        OMNICHAIN_DEPLOYER = IJBOmnichainDeployer(local.omnichainDeployer);
        ROUTER_TERMINAL_REGISTRY = IJBTerminal(local.routerTerminalRegistry);
        ALLOWLIST_HOOK = IHomerunAllowlistHook(local.allowlistHook);

        // Every dependency must point at the same core, and INCOME's terminals (chosen by the revnet deployer) must
        // route swaps through the same registry FUND does.
        if (
            address(REV_DEPLOYER.CONTROLLER()) != address(CONTROLLER)
                || address(REV_DEPLOYER.DIRECTORY()) != address(DIRECTORY)
                || address(REV_DEPLOYER.PROJECTS()) != address(PROJECTS) || address(TERMINAL).code.length == 0
                || address(REV_DEPLOYER.ROUTER_TERMINAL_REGISTRY()) != address(ROUTER_TERMINAL_REGISTRY)
                || address(REV_OWNER.deployer()) != address(REV_DEPLOYER)
                || address(REV_OWNER.CONTROLLER()) != address(CONTROLLER)
                || address(REV_OWNER.DIRECTORY()) != address(DIRECTORY)
                || address(REV_OWNER.PROJECTS()) != address(PROJECTS)
                || address(REV_OWNER.LOANS()) != address(REV_DEPLOYER.LOANS())
                || address(REV_OWNER.SUCKER_REGISTRY()) != address(SUCKER_REGISTRY)
                || address(REV_DEPLOYER.LOANS().CONTROLLER()) != address(CONTROLLER)
                || address(REV_DEPLOYER.LOANS().TERMINAL()) != address(TERMINAL)
                || address(SUCKER_REGISTRY.DIRECTORY()) != address(DIRECTORY)
                || address(SUCKER_REGISTRY.PROJECTS()) != address(PROJECTS)
                || address(ALLOWLIST_HOOK.PROJECTS()) != address(PROJECTS)
                || address(OMNICHAIN_DEPLOYER.CONTROLLER()) != address(CONTROLLER)
                || address(_omnichainDeployer().DIRECTORY()) != address(DIRECTORY)
                || address(_omnichainDeployer().PROJECTS()) != address(PROJECTS)
                || address(_omnichainDeployer().SUCKER_REGISTRY()) != address(SUCKER_REGISTRY)
                || IERC20Metadata(USDC).decimals() != _USDC_DECIMALS
        ) revert HomerunDeployer_InvalidProtocolWiring();

        // Relayed allowlist changes must resolve the same signer this contract does.
        if (!ERC2771Context(address(ALLOWLIST_HOOK)).isTrustedForwarder(trustedForwarder())) {
            revert HomerunDeployer_InvalidProtocolWiring();
        }
    }

    //*********************************************************************//
    // ---------------------- external transactions ---------------------- //
    //*********************************************************************//

    /// @notice Launches a FUND's INCOME revnet with this chain's initial allocation recorded as an auto-issuance to
    /// this contract, for `mintInitialAllocation` to pay to the FUND's owner.
    /// @dev Only the FUND's owner can call this, and only once per FUND. The snapshot is the owner's attestation; its
    /// completeness is not proven onchain, and neither is the FUND's state: close the FUND on every linked chain and
    /// let bridged FUND settle before taking any chain's snapshot. The caller becomes the INCOME revnet's operator and
    /// holds its whole reserved split. Launch the first chain with `startsAtOrAfter` a few minutes ahead so the revnet
    /// deployer applies no cash out delay there; a chain launched after the shared start inherits the revnet deployer's
    /// standard cash out delay.
    /// @param fundProjectId The ID of the FUND project.
    /// @param snapshot The global initial allocation snapshot, identical on every chain.
    /// @param description The INCOME name, ticker, metadata URI and launch salt.
    /// @param reservedBps The share of new INCOME reserved for the owner's split, out of
    /// `JBConstants.MAX_RESERVED_PERCENT`.
    /// @param startsAtOrAfter The shared start of the INCOME issuance schedule on every chain; the issuance cut
    /// schedule counts from it.
    /// @param suckerDeploymentConfiguration The suckers linking INCOME across the snapshot's chains.
    /// @return incomeProjectId The ID of the new INCOME project.
    function deployIncome(
        uint256 fundProjectId,
        HomerunInitialIncomeSnapshot calldata snapshot,
        REVDescription calldata description,
        uint16 reservedBps,
        uint48 startsAtOrAfter,
        REVSuckerDeploymentConfig calldata suckerDeploymentConfiguration
    )
        external
        payable
        override
        nonReentrant
        returns (uint256 incomeProjectId)
    {
        if (!isFund[fundProjectId]) revert HomerunDeployer_UnsupportedFund(fundProjectId);
        if (PROJECTS.ownerOf(fundProjectId) != _msgSender()) revert HomerunDeployer_Unauthorized(_msgSender());
        if (incomeProjectIdOf[fundProjectId] != 0) {
            revert HomerunDeployer_AlreadyDeployed(fundProjectId, incomeProjectIdOf[fundProjectId]);
        }
        uint256 creationFee = PROJECTS.creationFee();
        if (msg.value != creationFee) revert HomerunDeployer_WrongCreationFee(msg.value, creationFee);
        if (
            bytes(description.name).length == 0 || bytes(description.ticker).length == 0
                || bytes(description.uri).length == 0 || description.salt == bytes32(0)
                || reservedBps > JBConstants.MAX_RESERVED_PERCENT || block.chainid > type(uint32).max
                || startsAtOrAfter == 0
        ) revert HomerunDeployer_InvalidConfiguration();

        HomerunInitialIncomeAllocation memory allocation =
            _requireSnapshot({fundProjectId: fundProjectId, snapshot: snapshot});
        _requireSuckers({
            snapshot: snapshot, configuration: suckerDeploymentConfiguration, launchSalt: description.salt
        });
        address fundToken = address(TOKENS.tokenOf(fundProjectId));
        REVConfig memory configuration = _configurationFor({
            description: description, snapshot: snapshot, reservedBps: reservedBps, startsAtOrAfter: startsAtOrAfter
        });

        // Reserve the binding so nothing called below can launch a second INCOME for this FUND.
        incomeProjectIdOf[fundProjectId] = type(uint256).max;

        incomeProjectId =
            _launchIncome({configuration: configuration, suckerDeploymentConfiguration: suckerDeploymentConfiguration});
        // The revnet deployer keys its stage's auto-issuance by this block's timestamp, which is also the ID the
        // rulesets registry gives a new project's first ruleset.
        (JBRuleset memory ruleset,) = CONTROLLER.getRulesetOf({projectId: incomeProjectId, rulesetId: block.timestamp});
        if (
            ruleset.id != block.timestamp || PROJECTS.ownerOf(incomeProjectId) != address(REV_OWNER)
                || !REV_OWNER.isOperatorOf({revnetId: incomeProjectId, addr: _msgSender()})
                || REV_OWNER.amountToAutoIssue({
                        revnetId: incomeProjectId, stageId: block.timestamp, beneficiary: address(this)
                    }) != allocation.incomeAmount
        ) revert HomerunDeployer_IncompleteIssuance(incomeProjectId);

        incomeProjectIdOf[fundProjectId] = incomeProjectId;

        emit IncomeDeployed({
            fundProjectId: fundProjectId, incomeProjectId: incomeProjectId, owner: _msgSender(), fundToken: fundToken
        });
    }

    /// @notice Mints a FUND's initial INCOME allocation to whoever owns the FUND right now.
    /// @dev Anyone can call this once INCOME's stage has started, and it pays out once. The owner settles the published
    /// allocation to the snapshot's holders from their balance.
    /// @param fundProjectId The ID of the FUND project.
    function mintInitialAllocation(uint256 fundProjectId) external override nonReentrant {
        uint256 incomeProjectId = incomeProjectIdOf[fundProjectId];
        if (incomeProjectId == 0 || incomeProjectId == type(uint256).max) {
            revert HomerunDeployer_UnsupportedFund(fundProjectId);
        }
        // INCOME has exactly one stage; the revnet deployer keyed its auto-issuance by that stage's ID.
        (JBRuleset memory stage,,) = CONTROLLER.latestQueuedRulesetOf(incomeProjectId);
        uint256 amount =
            REV_OWNER.amountToAutoIssue({revnetId: incomeProjectId, stageId: stage.id, beneficiary: address(this)});
        if (amount == 0) revert HomerunDeployer_NothingToMint(fundProjectId);
        address owner = PROJECTS.ownerOf(fundProjectId);
        IERC20 token = IERC20(address(TOKENS.tokenOf(incomeProjectId)));
        // Balance deltas, not absolute balances, prove the mint, so tokens sent here by anyone else cannot block it.
        uint256 heldBefore = token.balanceOf(address(this));
        REV_OWNER.autoIssueFor({revnetId: incomeProjectId, stageId: stage.id, beneficiary: address(this)});
        if (token.balanceOf(address(this)) - heldBefore != amount) {
            revert HomerunDeployer_IncompleteIssuance(incomeProjectId);
        }
        token.safeTransfer({to: owner, value: amount});
        emit InitialAllocationMinted({
            fundProjectId: fundProjectId,
            incomeProjectId: incomeProjectId,
            owner: owner,
            incomeAmount: amount,
            caller: _msgSender()
        });
    }

    /// @notice Launches a FUND with Homerun's fixed campaign rules and deploys its ERC-20.
    /// @dev The rules: a USDC treasury that accepts any token through swap routing, `FUND_WEIGHT` per USD,
    /// `FUND_CASH_OUT_TAX_RATE`, no reserved issuance, no owner minting, no payouts, the allowlist hook on payments,
    /// and no duration so the owner can change them at any time. Every FUND goes through the stock omnichain deployer,
    /// so it carries that deployer's data hook and a default 721 hook whether or not it links chains. Linked launches
    /// must use the same `salt`, the same caller and the same owner on every chain: the sucker and token salts are
    /// scoped to the caller and the owner, so unrelated launches reusing a public salt cannot collide with, block, or
    /// pair with each other, and a linked FUND's token still shares one address on every chain.
    /// @param owner The address that will own the FUND.
    /// @param projectUri The FUND's metadata URI.
    /// @param name The FUND token's name.
    /// @param ticker The FUND token's symbol.
    /// @param mustStartAtOrAfter The earliest the FUND's rules take effect. Linked launches share one nonzero value.
    /// @param salt The sucker and token salt. Zero for a single-chain FUND.
    /// @param peerSuckerDeployers One CCIP sucker deployer per linked remote chain, in ascending remote chain ID.
    /// @return projectId The ID of the new FUND project.
    /// @return token The FUND ERC-20.
    function launchFundFor(
        address owner,
        string calldata projectUri,
        string memory name,
        string memory ticker,
        uint48 mustStartAtOrAfter,
        bytes32 salt,
        address[] calldata peerSuckerDeployers
    )
        external
        payable
        override
        nonReentrant
        returns (uint256 projectId, address token)
    {
        if (
            owner == address(0) || bytes(projectUri).length == 0 || bytes(name).length == 0 || bytes(ticker).length == 0
        ) revert HomerunDeployer_InvalidConfiguration();
        uint256 creationFee = PROJECTS.creationFee();
        if (msg.value != creationFee) revert HomerunDeployer_WrongCreationFee(msg.value, creationFee);
        // One salt for the suckers and the token, scoped so only the same caller launching for the same owner can
        // reproduce it on another chain. Zero for a single-chain FUND.
        bytes32 scopedSalt;
        if (peerSuckerDeployers.length != 0) {
            if (salt == bytes32(0) || mustStartAtOrAfter == 0) revert HomerunDeployer_InvalidConfiguration();
            scopedSalt = _linkedSalt({owner: owner, salt: salt});
        } else if (salt != bytes32(0)) {
            revert HomerunDeployer_InvalidConfiguration();
        }

        (JBRulesetConfig[] memory rulesetConfigurations, JBTerminalConfig[] memory terminalConfigurations) =
            _fundConfigurations(mustStartAtOrAfter);

        JBSuckerDeploymentConfig memory suckerDeploymentConfiguration;
        if (scopedSalt != bytes32(0)) {
            suckerDeploymentConfiguration.salt = scopedSalt;
            suckerDeploymentConfiguration.deployerConfigurations = _suckerDeployerConfigurationsFor(peerSuckerDeployers);
        }

        // Own the project just long enough to deploy its token, then hand it to the owner.
        originalPayer = JBPayerTrackerLib.resolve(_msgSender());
        (projectId,,) = OMNICHAIN_DEPLOYER.launchProjectFor{value: msg.value}({
            owner: address(this),
            projectUri: projectUri,
            rulesetConfigurations: rulesetConfigurations,
            terminalConfigurations: terminalConfigurations,
            memo: "Homerun: launch FUND",
            suckerDeploymentConfiguration: suckerDeploymentConfiguration
        });
        originalPayer = address(0);

        token = address(CONTROLLER.deployERC20For({projectId: projectId, name: name, symbol: ticker, salt: scopedSalt}));
        PROJECTS.safeTransferFrom({from: address(this), to: owner, tokenId: projectId});
        isFund[projectId] = true;

        emit FundLaunched({projectId: projectId, owner: owner, caller: _msgSender()});
    }

    //*********************************************************************//
    // ------------------------- external views -------------------------- //
    //*********************************************************************//

    /// @notice Accepts the project NFTs this contract launches, on their way to the owner.
    /// @dev Only `PROJECTS` may deliver one.
    /// @return selector The `onERC721Received` selector.
    function onERC721Received(
        address,
        address,
        uint256,
        bytes calldata
    )
        external
        view
        override
        returns (bytes4 selector)
    {
        if (msg.sender != address(PROJECTS)) revert HomerunDeployer_Unauthorized(msg.sender);
        return this.onERC721Received.selector;
    }

    //*********************************************************************//
    // -------------------------- public views --------------------------- //
    //*********************************************************************//

    /// @notice The revnet description salt that commits a snapshot into INCOME's cross-chain identity.
    /// @dev Every chain of a linked INCOME must launch with the same snapshot and launch salt to pair.
    /// @param snapshot The global initial allocation snapshot.
    /// @param launchSalt The salt the FUND owner launches INCOME with.
    /// @return salt The configuration salt.
    function configurationSaltFor(
        HomerunInitialIncomeSnapshot calldata snapshot,
        bytes32 launchSalt
    )
        public
        pure
        override
        returns (bytes32 salt)
    {
        return keccak256(
            abi.encode(
                launchSalt,
                snapshot.sourceSetHash,
                snapshot.totalFundSupply,
                snapshot.manifestHash,
                keccak256(abi.encode(snapshot.allocations))
            )
        );
    }

    //*********************************************************************//
    // ---------------------- internal transactions ---------------------- //
    //*********************************************************************//

    /// @notice Launches the INCOME revnet through the stock revnet deployer with an empty, owner-managed shop.
    /// @param configuration The revnet configuration.
    /// @param suckerDeploymentConfiguration The suckers linking INCOME across chains.
    /// @return incomeProjectId The ID of the new INCOME project.
    function _launchIncome(
        REVConfig memory configuration,
        REVSuckerDeploymentConfig calldata suckerDeploymentConfiguration
    )
        internal
        returns (uint256 incomeProjectId)
    {
        JBAccountingContext[] memory accountingContexts = new JBAccountingContext[](1);
        accountingContexts[0] = _usdcAccountingContext();

        // The revnet's operator is the FUND owner. Let that owner manage inventory while keeping reserve issuance,
        // voting, owner minting, and collection metadata/discount privileges disabled.
        REVDeploy721TiersHookConfig memory tiered721HookConfiguration;
        tiered721HookConfiguration.baseline721HookConfiguration.name = configuration.description.name;
        tiered721HookConfiguration.baseline721HookConfiguration.symbol = configuration.description.ticker;
        tiered721HookConfiguration.baseline721HookConfiguration.baseUri = "ipfs://";
        tiered721HookConfiguration.baseline721HookConfiguration.contractUri = configuration.description.uri;
        tiered721HookConfiguration.baseline721HookConfiguration.tiersConfig.currency = JBCurrencyIds.USD;
        tiered721HookConfiguration.baseline721HookConfiguration.tiersConfig.decimals = _USDC_DECIMALS;
        tiered721HookConfiguration.baseline721HookConfiguration.flags.noNewTiersWithReserves = true;
        tiered721HookConfiguration.baseline721HookConfiguration.flags.noNewTiersWithVotes = true;
        tiered721HookConfiguration.baseline721HookConfiguration.flags.noNewTiersWithOwnerMinting = true;
        tiered721HookConfiguration.preventOperatorAdjustingTiers = false;
        tiered721HookConfiguration.preventOperatorUpdatingMetadata = true;
        tiered721HookConfiguration.preventOperatorMinting = true;
        tiered721HookConfiguration.preventOperatorIncreasingDiscountPercent = true;

        originalPayer = JBPayerTrackerLib.resolve(_msgSender());
        (incomeProjectId,) = REV_DEPLOYER.deployFor{value: msg.value}({
            revnetId: 0,
            configuration: configuration,
            accountingContextsToAccept: accountingContexts,
            suckerDeploymentConfiguration: suckerDeploymentConfiguration,
            tiered721HookConfiguration: tiered721HookConfiguration,
            allowedPosts: new REVCroptopAllowedPost[](0)
        });
        originalPayer = address(0);
    }

    //*********************************************************************//
    // ------------------------ internal views --------------------------- //
    //*********************************************************************//

    /// @notice The INCOME revnet configuration for a launch.
    /// @dev One stage: `INCOME_INITIAL_ISSUANCE` per USD, cut `INCOME_CUT_PERCENT` every `QUARTER` indefinitely,
    /// `INCOME_CASH_OUT_TAX_RATE`, one unlocked reserved split held by the caller until other recipients exist, and
    /// every chain's initial allocation as an auto-issuance to this contract, paid to the FUND's owner on request.
    /// @param description The INCOME name, ticker, metadata URI and launch salt.
    /// @param snapshot The global initial allocation snapshot.
    /// @param reservedBps The share of new INCOME reserved for the owner's split.
    /// @param startsAtOrAfter The shared start of the issuance schedule.
    /// @return configuration The revnet configuration.
    function _configurationFor(
        REVDescription calldata description,
        HomerunInitialIncomeSnapshot calldata snapshot,
        uint16 reservedBps,
        uint48 startsAtOrAfter
    )
        internal
        view
        returns (REVConfig memory configuration)
    {
        configuration.description = description;
        configuration.description.salt = configurationSaltFor({snapshot: snapshot, launchSalt: description.salt});
        configuration.baseCurrency = JBCurrencyIds.USD;
        // Stock revnets call their authority wallet the operator; here that is the FUND owner.
        configuration.operator = _msgSender();
        configuration.scopeCashOutsToLocalBalances = false;

        JBSplit[] memory splits = new JBSplit[](1);
        splits[0] = JBSplit({
            percent: JBConstants.SPLITS_TOTAL_PERCENT,
            projectId: 0,
            beneficiary: payable(_msgSender()),
            preferAddToBalance: false,
            lockedUntil: 0,
            hook: IJBSplitHook(address(0))
        });

        REVAutoIssuance[] memory autoIssuances = new REVAutoIssuance[](snapshot.allocations.length);
        for (uint256 i; i < autoIssuances.length; i++) {
            autoIssuances[i] = REVAutoIssuance({
                chainId: snapshot.allocations[i].chainId,
                count: snapshot.allocations[i].incomeAmount,
                beneficiary: address(this)
            });
        }

        configuration.stageConfigurations = new REVStageConfig[](1);
        configuration.stageConfigurations[0] = REVStageConfig({
            startsAtOrAfter: startsAtOrAfter,
            autoIssuances: autoIssuances,
            splitPercent: reservedBps,
            splits: splits,
            initialIssuance: INCOME_INITIAL_ISSUANCE,
            issuanceCutFrequency: QUARTER,
            issuanceCutPercent: INCOME_CUT_PERCENT,
            cashOutTaxRate: INCOME_CASH_OUT_TAX_RATE,
            extraMetadata: _INCOME_STAGE_EXTRA_METADATA
        });
    }

    /// @notice The fixed FUND rules and terminals.
    /// @param mustStartAtOrAfter The earliest the FUND's rules take effect.
    /// @return rulesetConfigurations The FUND's single ruleset.
    /// @return terminalConfigurations The USDC terminal and the router terminal registry.
    function _fundConfigurations(uint48 mustStartAtOrAfter)
        internal
        view
        returns (JBRulesetConfig[] memory rulesetConfigurations, JBTerminalConfig[] memory terminalConfigurations)
    {
        rulesetConfigurations = new JBRulesetConfig[](1);
        rulesetConfigurations[0].mustStartAtOrAfter = mustStartAtOrAfter;
        rulesetConfigurations[0].weight = FUND_WEIGHT;
        rulesetConfigurations[0].metadata.cashOutTaxRate = FUND_CASH_OUT_TAX_RATE;
        rulesetConfigurations[0].metadata.baseCurrency = JBCurrencyIds.USD;
        // The omnichain deployer keeps this as the FUND's extra hook and consults it on every payment.
        rulesetConfigurations[0].metadata.dataHook = address(ALLOWLIST_HOOK);
        rulesetConfigurations[0].metadata.useDataHookForPay = true;

        terminalConfigurations = new JBTerminalConfig[](2);
        terminalConfigurations[0].terminal = TERMINAL;
        terminalConfigurations[0].accountingContextsToAccept = new JBAccountingContext[](1);
        terminalConfigurations[0].accountingContextsToAccept[0] = _usdcAccountingContext();
        terminalConfigurations[1].terminal = ROUTER_TERMINAL_REGISTRY;
    }

    /// @notice The salt a linked launch's suckers and token share, scoped so only the same caller launching for the
    /// same owner reproduces it on another chain.
    /// @param owner The address that will own the FUND.
    /// @param salt The caller's salt.
    /// @return scopedSalt The scoped salt.
    function _linkedSalt(address owner, bytes32 salt) internal view returns (bytes32 scopedSalt) {
        return keccak256(abi.encode(_msgSender(), owner, salt));
    }

    /// @notice The trusted forwarder of the omnichain deployer configured for this chain.
    /// @dev Called from the constructor's inheritance list, before any immutable is set.
    /// @param chains The per-chain configuration passed to the constructor.
    /// @return forwarder The trusted forwarder.
    function _forwarderOf(HomerunChainConfig[] memory chains) internal view returns (address forwarder) {
        for (uint256 i; i < chains.length; i++) {
            if (chains[i].chainId == block.chainid && chains[i].omnichainDeployer.code.length != 0) {
                return JBOmnichainDeployer(chains[i].omnichainDeployer).trustedForwarder();
            }
        }
        revert HomerunDeployer_InvalidProtocolWiring();
    }

    /// @notice The omnichain deployer as its concrete type, for the getters its interface leaves out.
    /// @return deployer The omnichain deployer.
    function _omnichainDeployer() internal view returns (JBOmnichainDeployer deployer) {
        return JBOmnichainDeployer(address(OMNICHAIN_DEPLOYER));
    }

    /// @notice Validates a snapshot against this chain and returns this chain's allocation.
    /// @dev Allocations must be ascending by chain, cover only configured chains, sum to `INITIAL_INCOME_SUPPLY`,
    /// and name this FUND on this chain at a block before the current one. A recent snapshot's block hash is checked
    /// directly; older, finalized snapshots stay owner-attested so a Safe proposal can execute after the EVM's
    /// blockhash history expires without changing entitlements.
    /// @param fundProjectId The ID of the FUND project.
    /// @param snapshot The global initial allocation snapshot.
    /// @return local This chain's allocation.
    function _requireSnapshot(
        uint256 fundProjectId,
        HomerunInitialIncomeSnapshot calldata snapshot
    )
        internal
        view
        returns (HomerunInitialIncomeAllocation memory local)
    {
        if (
            snapshot.sourceSetHash == bytes32(0) || snapshot.totalFundSupply == 0 || snapshot.manifestHash == bytes32(0)
                || bytes(snapshot.manifestUri).length == 0
        ) revert HomerunDeployer_InvalidSnapshot();

        uint32 previousChain;
        uint256 totalIncome;
        for (uint256 i; i < snapshot.allocations.length; i++) {
            HomerunInitialIncomeAllocation calldata entry = snapshot.allocations[i];
            if (
                entry.chainId <= previousChain || usdcOf[entry.chainId] == address(0) || entry.fundProjectId == 0
                    || entry.snapshotBlockHash == bytes32(0)
            ) revert HomerunDeployer_InvalidSnapshot();
            previousChain = entry.chainId;
            totalIncome += entry.incomeAmount;
            if (entry.chainId == block.chainid) local = entry;
        }

        // Arbitrum snapshots use L2 heights, while its NUMBER/BLOCKHASH opcodes refer to L1 ancestry.
        bool isArbitrum = block.chainid == _ARBITRUM_CHAIN_ID || block.chainid == _ARBITRUM_SEPOLIA_CHAIN_ID;
        uint256 currentBlock = isArbitrum ? _ARB_SYS.arbBlockNumber() : block.number;
        if (
            totalIncome != INITIAL_INCOME_SUPPLY || local.fundProjectId != fundProjectId
                || local.snapshotBlockNumber >= currentBlock
        ) revert HomerunDeployer_InvalidSnapshot();

        if (currentBlock - local.snapshotBlockNumber <= _BLOCKHASH_WINDOW) {
            bytes32 canonicalHash =
                isArbitrum ? _ARB_SYS.arbBlockHash(local.snapshotBlockNumber) : blockhash(local.snapshotBlockNumber);
            if (canonicalHash != local.snapshotBlockHash) revert HomerunDeployer_InvalidSnapshot();
        }
    }

    /// @notice Reverts unless a sucker configuration mirrors the snapshot's chains with the stock USDC/CCIP topology.
    /// @dev Both lists follow ascending remote chain ID. Explicit nonstandard peers and gas allowances are not
    /// accepted. @param snapshot The global initial allocation snapshot.
    /// @param configuration The sucker configuration to check.
    /// @param launchSalt The salt the FUND owner launches INCOME with.
    function _requireSuckers(
        HomerunInitialIncomeSnapshot calldata snapshot,
        REVSuckerDeploymentConfig calldata configuration,
        bytes32 launchSalt
    )
        internal
        view
    {
        if (
            configuration.salt != launchSalt
                || configuration.deployerConfigurations.length + 1 != snapshot.allocations.length
        ) revert HomerunDeployer_InvalidConfiguration();

        uint256 configIndex;
        for (uint256 i; i < snapshot.allocations.length; i++) {
            uint32 remoteChain = snapshot.allocations[i].chainId;
            if (remoteChain == block.chainid) continue;
            JBSuckerDeployerConfig calldata deployerConfiguration = configuration.deployerConfigurations[configIndex];
            if (
                deployerConfiguration.peer != bytes32(0)
                    || IJBCCIPSuckerDeployer(address(deployerConfiguration.deployer)).ccipRemoteChainId() != remoteChain
                    || deployerConfiguration.mappings.length != 1
                    || deployerConfiguration.mappings[0].localToken != USDC
                    || deployerConfiguration.mappings[0].minGas != FUND_SUCKER_MIN_GAS
                    || deployerConfiguration.mappings[0].remoteToken != bytes32(uint256(uint160(usdcOf[remoteChain])))
            ) revert HomerunDeployer_InvalidConfiguration();
            configIndex++;
        }
    }

    /// @notice The stock USDC/CCIP sucker configuration for a FUND's linked chains.
    /// @dev Each deployer must serve a configured remote chain other than this one, in ascending remote chain ID.
    /// @param peerSuckerDeployers One CCIP sucker deployer per linked remote chain.
    /// @return deployerConfigurations The sucker configurations.
    function _suckerDeployerConfigurationsFor(address[] calldata peerSuckerDeployers)
        internal
        view
        returns (JBSuckerDeployerConfig[] memory deployerConfigurations)
    {
        deployerConfigurations = new JBSuckerDeployerConfig[](peerSuckerDeployers.length);
        uint256 previousChain;
        for (uint256 i; i < peerSuckerDeployers.length; i++) {
            uint256 remoteChain = IJBCCIPSuckerDeployer(peerSuckerDeployers[i]).ccipRemoteChainId();
            address remoteUsdc = remoteChain <= type(uint32).max ? usdcOf[uint32(remoteChain)] : address(0);
            if (remoteChain <= previousChain || remoteChain == block.chainid || remoteUsdc == address(0)) {
                revert HomerunDeployer_InvalidConfiguration();
            }
            previousChain = remoteChain;

            JBTokenMapping[] memory mappings = new JBTokenMapping[](1);
            mappings[0] = JBTokenMapping({
                localToken: USDC, minGas: FUND_SUCKER_MIN_GAS, remoteToken: bytes32(uint256(uint160(remoteUsdc)))
            });
            deployerConfigurations[i] = JBSuckerDeployerConfig({
                deployer: IJBSuckerDeployer(peerSuckerDeployers[i]), peer: bytes32(0), mappings: mappings
            });
        }
    }

    /// @notice The accounting context every FUND and INCOME treasury uses on this chain.
    /// @dev Token-keyed currency, matching the canonical terminal; issuance stays USD-denominated through the price
    /// feed.
    /// @return context The USDC accounting context.
    function _usdcAccountingContext() internal view returns (JBAccountingContext memory context) {
        return JBAccountingContext({token: USDC, decimals: _USDC_DECIMALS, currency: uint32(uint160(USDC))});
    }
}
