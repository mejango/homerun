// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IJBController} from "@bananapus/core-v6/src/interfaces/IJBController.sol";
import {IJBPermissioned} from "@bananapus/core-v6/src/interfaces/IJBPermissioned.sol";
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
import {JBSuckerDeployerConfig} from "@bananapus/suckers-v6/src/structs/JBSuckerDeployerConfig.sol";
import {JBTokenMapping} from "@bananapus/suckers-v6/src/structs/JBTokenMapping.sol";
import {ERC2771Context} from "@openzeppelin/contracts/metatx/ERC2771Context.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
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

import {IHomerunAllowlistHook} from "./interfaces/IHomerunAllowlistHook.sol";
import {IHomerunDeployer} from "./interfaces/IHomerunDeployer.sol";
import {HomerunChainConfig} from "./structs/HomerunChainConfig.sol";
import {HomerunInitialIncomeAllocation} from "./structs/HomerunInitialIncomeAllocation.sol";
import {HomerunInitialIncomeSnapshot} from "./structs/HomerunInitialIncomeSnapshot.sol";

/// @notice Launches Homerun FUNDs with fixed campaign rules, and launches each FUND's INCOME revnet with the initial
/// INCOME allocation recorded for the FUND's owner.
/// @dev FUND rules and INCOME economics are fixed here; callers choose names, tickers, timing, chains and the INCOME
/// reserved percent. The FUND owner attests to a published snapshot of who holds what. Its completeness, historical
/// balances, allocation sums, and the FUND's state are not verified onchain: close the campaign, then reproduce and
/// reconcile the manifest before signing. Each chain's share of the allocation is a stock revnet auto-issuance to this
/// contract, which anyone can mint to the FUND's current owner once INCOME's stage has started; the owner settles it to
/// the snapshot's holders. Every chain commits to the same global allocation and deploys asynchronously. This contract
/// retains no project ownership, tokens, or operator permissions. INCOME's reserved split is unlocked and routed to the
/// owner, who redirects it later through the stock controller.
contract HomerunDeployer is ERC2771Context, ReentrancyGuard, IERC721Receiver, IHomerunDeployer {
    // A library that adds default safety checks to ERC20 transfers.
    using SafeERC20 for IERC20;

    //*********************************************************************//
    // --------------------------- custom errors ------------------------- //
    //*********************************************************************//

    /// @notice Thrown when the chain-specific constants are set a second time, since the one-shot binding is final.
    error HomerunDeployer_AlreadyConfigured();

    /// @notice Thrown when a FUND already has an INCOME, so a second launch cannot mint a second initial allocation.
    error HomerunDeployer_AlreadyDeployed(uint256 fundProjectId, uint256 incomeProjectId);

    /// @notice Thrown when a launch input is empty, out of range, or inconsistent with its linked chains.
    error HomerunDeployer_InvalidConfiguration();

    /// @notice Thrown when the protocol dependencies or the per-chain configuration do not describe one consistent
    /// protocol deployment, so the contract refuses to bind mismatched dependencies.
    error HomerunDeployer_InvalidProtocolWiring();

    /// @notice Thrown when a snapshot names an unconfigured or repeated chain, another FUND, or does not sum to the
    /// initial INCOME supply.
    error HomerunDeployer_InvalidSnapshot();

    /// @notice Thrown when nothing is left to mint for a FUND: its allocation was already paid out or is zero.
    error HomerunDeployer_NothingToMint(uint256 fundProjectId);

    /// @notice Thrown when the caller is not the FUND's owner, a project NFT arrives from anywhere but `PROJECTS`, or
    /// someone other than the binding deployer sets the chain-specific constants.
    error HomerunDeployer_Unauthorized(address caller);

    /// @notice Thrown when a project was not launched as a FUND through this contract, so it cannot have an INCOME.
    error HomerunDeployer_UnsupportedFund(uint256 fundProjectId);

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
    uint112 public constant override INCOME_INITIAL_ISSUANCE = 10e18;

    /// @notice The INCOME every FUND's holders share at launch, across every chain, as a fixed point number with 18
    /// decimals.
    uint256 public constant override INITIAL_INCOME_SUPPLY = 500_000e18;

    /// @notice The number of seconds in one INCOME issuance cycle.
    /// @dev One fourth of a 365-day year.
    uint32 public constant override QUARTER = 7_884_000;

    //*********************************************************************//
    // ----------------------- internal constants ------------------------ //
    //*********************************************************************//

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

    /// @notice The omnichain deployer every FUND is launched through.
    IJBOmnichainDeployer public immutable override OMNICHAIN_DEPLOYER;

    /// @notice The project registry.
    IJBProjects public immutable override PROJECTS;

    /// @notice The revnet deployer INCOME is launched through.
    IREVDeployer public immutable override REV_DEPLOYER;

    /// @notice The contract that owns every INCOME revnet.
    IREVOwner public immutable override REV_OWNER;

    /// @notice The router terminal registry every FUND and INCOME registers, so any token can pay through swap
    /// routing.
    IJBTerminal public immutable override ROUTER_TERMINAL_REGISTRY;

    /// @notice The terminal every FUND and INCOME treasury lives in.
    IJBTerminal public immutable override TERMINAL;

    /// @notice The token registry.
    IJBTokens public immutable override TOKENS;

    //*********************************************************************//
    // --------------- internal immutable stored properties -------------- //
    //*********************************************************************//

    /// @notice The address allowed to set the chain-specific constants, once.
    /// @dev Held as an immutable so the constructor inputs are byte-identical on every chain. The chain-specific USDC
    /// tokens are set by this deployer in a one-shot call to `setChainSpecificConstants`, which mirrors
    /// `JBBuybackHook.setChainSpecificConstants` and makes this contract's CREATE2 address identical across chains.
    address internal immutable _DEPLOYER;

    //*********************************************************************//
    // --------------------- public stored properties -------------------- //
    //*********************************************************************//

    /// @notice The USDC token every FUND and INCOME treasury accounts in on this chain.
    /// @dev Set once by `_DEPLOYER` through `setChainSpecificConstants`. Zero until then.
    address public override USDC;

    /// @notice The INCOME project a FUND launched, if any.
    /// @custom:param fundProjectId The ID of the FUND project.
    mapping(uint256 fundProjectId => uint256 incomeProjectId) public override incomeProjectIdOf;

    /// @notice Whether a project was launched as a FUND through this contract. INCOME only attaches to these.
    /// @custom:param projectId The ID of the project.
    mapping(uint256 projectId => bool) public override isFund;

    /// @notice The USDC token on a linked chain, including this one.
    /// @dev Set once by `_DEPLOYER` through `setChainSpecificConstants`.
    /// @custom:param chainId The ID of the chain.
    mapping(uint32 chainId => address usdc) public override usdcOf;

    //*********************************************************************//
    // -------------------- internal stored properties ------------------- //
    //*********************************************************************//

    /// @notice Whether a FUND's initial INCOME allocation has been paid to its owner.
    /// @custom:param fundProjectId The ID of the FUND project.
    mapping(uint256 fundProjectId => bool) internal _initialAllocationMintedOf;

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

    /// @dev Every argument is the same address on every supported chain, so the constructor calldata, and with it
    /// the CREATE2 address, is identical everywhere. The chain-specific USDC tokens are set afterwards by `deployer`
    /// through `setChainSpecificConstants`. The core is read from the revnet deployer, so INCOME and FUND cannot bind
    /// different cores. The trusted forwarder is the one the omnichain deployer trusts, so relayed launches resolve
    /// the signer instead of the forwarder.
    /// @param revDeployer The revnet deployer INCOME is launched through.
    /// @param omnichainDeployer The omnichain deployer every FUND is launched through.
    /// @param allowlistHook The pay hook installed on every FUND.
    /// @param deployer The address allowed to set the chain-specific constants, once.
    constructor(
        IREVDeployer revDeployer,
        IJBOmnichainDeployer omnichainDeployer,
        IHomerunAllowlistHook allowlistHook,
        address deployer
    )
        ERC2771Context(JBOmnichainDeployer(address(omnichainDeployer)).trustedForwarder())
    {
        REV_DEPLOYER = revDeployer;
        CONTROLLER = REV_DEPLOYER.CONTROLLER();
        PROJECTS = CONTROLLER.PROJECTS();
        TOKENS = CONTROLLER.TOKENS();
        REV_OWNER = IREVOwner(REV_DEPLOYER.OWNER());
        TERMINAL = REV_DEPLOYER.MULTI_TERMINAL();
        ROUTER_TERMINAL_REGISTRY = REV_DEPLOYER.ROUTER_TERMINAL_REGISTRY();
        OMNICHAIN_DEPLOYER = omnichainDeployer;
        ALLOWLIST_HOOK = allowlistHook;
        _DEPLOYER = deployer;

        // Make sure the omnichain deployer and the hook serve the same core the revnet deployer does, including the
        // permissions the hook's list management is delegated through, and that relayed allowlist changes resolve the
        // same signer this contract does.
        if (
            address(OMNICHAIN_DEPLOYER.CONTROLLER()) != address(CONTROLLER)
                || address(ALLOWLIST_HOOK.PROJECTS()) != address(PROJECTS)
                || address(ALLOWLIST_HOOK.PERMISSIONS()) != address(IJBPermissioned(address(CONTROLLER)).PERMISSIONS())
                || !ERC2771Context(address(ALLOWLIST_HOOK)).isTrustedForwarder(trustedForwarder())
        ) revert HomerunDeployer_InvalidProtocolWiring();
    }

    //*********************************************************************//
    // ---------------------- external transactions ---------------------- //
    //*********************************************************************//

    /// @notice Launches a FUND's INCOME revnet, with this chain's share of the initial allocation recorded as an
    /// auto-issuance to this contract for `mintInitialAllocation` to pay to the FUND's owner.
    /// @dev Only the FUND's owner can call this, and only once per FUND. The snapshot is the owner's attestation: its
    /// completeness is not proven onchain, and neither is the FUND's state, so close the FUND on every linked chain
    /// and let bridged FUND settle before taking any chain's snapshot. The caller becomes the INCOME revnet's operator
    /// and holds its whole reserved split. Launch the first chain with `startsAtOrAfter` a few minutes ahead so the
    /// revnet deployer applies no cash out delay there; a chain launched after the shared start inherits the revnet
    /// deployer's standard cash out delay.
    /// @param fundProjectId The ID of the FUND project.
    /// @param snapshot The global initial allocation snapshot, identical on every chain.
    /// @param description The INCOME name, ticker, metadata URI and launch salt.
    /// @param reservedBps The share of new INCOME reserved for the owner's split, out of
    /// `JBConstants.MAX_RESERVED_PERCENT`.
    /// @param startsAtOrAfter The shared start of the INCOME issuance schedule on every chain. The issuance cut
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
        // Make sure the project is a FUND launched here, and that the caller owns it.
        if (!isFund[fundProjectId]) revert HomerunDeployer_UnsupportedFund(fundProjectId);
        if (PROJECTS.ownerOf(fundProjectId) != _msgSender()) revert HomerunDeployer_Unauthorized(_msgSender());

        // Make sure the FUND has no INCOME yet.
        if (incomeProjectIdOf[fundProjectId] != 0) {
            revert HomerunDeployer_AlreadyDeployed({
                fundProjectId: fundProjectId, incomeProjectId: incomeProjectIdOf[fundProjectId]
            });
        }

        // Make sure the launch has a salt to pair on and a shared start to count from.
        if (description.salt == bytes32(0) || startsAtOrAfter == 0) revert HomerunDeployer_InvalidConfiguration();

        // Make sure the snapshot names this FUND on this chain and divides exactly the initial supply.
        _requireSnapshot({fundProjectId: fundProjectId, snapshot: snapshot});

        // Make sure the suckers mirror the snapshot's chains with the stock topology.
        _requireSuckers({
            snapshot: snapshot, configuration: suckerDeploymentConfiguration, launchSalt: description.salt
        });

        // Launch the revnet with the fixed INCOME configuration built around the caller's choices.
        incomeProjectId = _launchIncome({
            configuration: _configurationFor({
                description: description, snapshot: snapshot, reservedBps: reservedBps, startsAtOrAfter: startsAtOrAfter
            }),
            suckerDeploymentConfiguration: suckerDeploymentConfiguration
        });

        // Bind the FUND to its INCOME.
        incomeProjectIdOf[fundProjectId] = incomeProjectId;

        emit IncomeDeployed({fundProjectId: fundProjectId, incomeProjectId: incomeProjectId, owner: _msgSender()});
    }

    /// @notice Launches a FUND with Homerun's fixed campaign rules and deploys its ERC-20.
    /// @dev The rules: a USDC treasury that accepts any token through swap routing, `FUND_WEIGHT` per USD,
    /// `FUND_CASH_OUT_TAX_RATE`, no reserved issuance, no owner minting, no payouts, the allowlist hook on payments,
    /// and no duration so the owner can change them at any time. Every FUND goes through the stock omnichain deployer,
    /// so it carries that deployer's data hook and a default 721 hook whether or not it links chains. Linked launches
    /// must use the same caller, owner, `salt`, `projectUri`, `name`, `ticker` and `mustStartAtOrAfter` on every
    /// chain: the sucker and token salts commit to all of them, so a launch that reuses a public owner and salt with
    /// different terms lands at different addresses and cannot block, pair with, or replace the original on a chain it
    /// has not reached yet, while a linked FUND's token still shares one address on every chain. The peer sucker
    /// deployers differ per chain, so they are not part of the salt.
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
        // One salt for the suckers and the token, scoped to the caller, the owner and the launch terms so only the same
        // launch can reproduce it on another chain. Zero for a single-chain FUND.
        bytes32 scopedSalt;
        if (peerSuckerDeployers.length != 0) {
            // A linked launch needs a salt to pair on, and a shared start so every chain's rules begin together.
            if (salt == bytes32(0) || mustStartAtOrAfter == 0) revert HomerunDeployer_InvalidConfiguration();
            scopedSalt = keccak256(abi.encode(_msgSender(), owner, salt, projectUri, name, ticker, mustStartAtOrAfter));
        } else if (salt != bytes32(0)) {
            // A single-chain launch has nothing to pair, so a salt would only be a mistake.
            revert HomerunDeployer_InvalidConfiguration();
        }

        // Get references to the fixed rules and terminals.
        (JBRulesetConfig[] memory rulesetConfigurations, JBTerminalConfig[] memory terminalConfigurations) =
            _fundConfigurations(mustStartAtOrAfter);

        // Build the sucker configuration for a linked launch.
        JBSuckerDeploymentConfig memory suckerDeploymentConfiguration;
        if (scopedSalt != bytes32(0)) {
            suckerDeploymentConfiguration.salt = scopedSalt;
            suckerDeploymentConfiguration.deployerConfigurations = _suckerDeployerConfigurationsFor(peerSuckerDeployers);
        }

        // Expose the resolved fee payer so `JBProjects` attributes the creation fee to the true payer, not this
        // contract. Cleared immediately after.
        originalPayer = JBPayerTrackerLib.resolve(_msgSender());

        // Own the project just long enough to deploy its token, then hand it to the owner.
        (projectId,,) = OMNICHAIN_DEPLOYER.launchProjectFor{value: msg.value}({
            owner: address(this),
            projectUri: projectUri,
            rulesetConfigurations: rulesetConfigurations,
            terminalConfigurations: terminalConfigurations,
            memo: "Homerun: launch FUND",
            suckerDeploymentConfiguration: suckerDeploymentConfiguration
        });

        originalPayer = address(0);

        // Deploy the FUND's ERC-20 while this contract still owns the project.
        token = address(CONTROLLER.deployERC20For({projectId: projectId, name: name, symbol: ticker, salt: scopedSalt}));

        // Hand the project to its owner.
        PROJECTS.safeTransferFrom({from: address(this), to: owner, tokenId: projectId});

        // Record the project as a FUND so it can launch an INCOME.
        isFund[projectId] = true;

        emit FundLaunched({projectId: projectId, owner: owner, caller: _msgSender()});
    }

    /// @notice Mints a FUND's initial INCOME allocation to whoever owns the FUND right now.
    /// @dev Anyone can call this once INCOME's stage has started, and it pays out once per FUND.
    /// `REVOwner.autoIssueFor` is itself permissionless, so the allocation may already sit here when this runs:
    /// whatever this contract holds of the INCOME token goes to the owner, who settles the published allocation to the
    /// snapshot's holders from their balance. INCOME sent here after that is not paid out, so `InitialAllocationMinted`
    /// fires only for the allocation.
    /// @param fundProjectId The ID of the FUND project.
    function mintInitialAllocation(uint256 fundProjectId) external override nonReentrant {
        // Make sure the FUND has an INCOME.
        uint256 incomeProjectId = incomeProjectIdOf[fundProjectId];
        if (incomeProjectId == 0) revert HomerunDeployer_UnsupportedFund(fundProjectId);

        // Make sure the allocation has not been paid out already.
        if (_initialAllocationMintedOf[fundProjectId]) revert HomerunDeployer_NothingToMint(fundProjectId);

        // INCOME has exactly one stage; the revnet deployer keyed its auto-issuance by that stage's ID.
        (JBRuleset memory stage,,) = CONTROLLER.latestQueuedRulesetOf(incomeProjectId);

        // Mint whatever the revnet still has to mint for this contract.
        if (
            REV_OWNER.amountToAutoIssue({revnetId: incomeProjectId, stageId: stage.id, beneficiary: address(this)}) != 0
        ) {
            REV_OWNER.autoIssueFor({revnetId: incomeProjectId, stageId: stage.id, beneficiary: address(this)});
        }

        // Everything this contract holds of the INCOME token belongs to the FUND's owner.
        IERC20 token = IERC20(address(TOKENS.tokenOf(incomeProjectId)));
        uint256 amount = token.balanceOf(address(this));
        if (amount == 0) revert HomerunDeployer_NothingToMint(fundProjectId);

        // Record the payout before sending it.
        _initialAllocationMintedOf[fundProjectId] = true;

        // Pay whoever owns the FUND at this moment.
        address owner = PROJECTS.ownerOf(fundProjectId);
        token.safeTransfer({to: owner, value: amount});

        emit InitialAllocationMinted({
            fundProjectId: fundProjectId,
            incomeProjectId: incomeProjectId,
            owner: owner,
            incomeAmount: amount,
            caller: _msgSender()
        });
    }

    /// @notice One-shot setter for the USDC token on every linked chain, this one included.
    /// @dev Callable only by `_DEPLOYER` and only once (while `USDC` is still zero). After this call the values are
    /// effectively immutable for the contract's lifetime. Keeping them out of the constructor keeps this contract's
    /// CREATE2 inputs byte-identical across chains, so its address is unified. Every entry names the revnet deployer,
    /// omnichain deployer and allowlist hook this contract was built with, since the unified address assumes they are
    /// the same on every chain.
    /// @param chains One entry per linked chain, in ascending chain ID, including this chain.
    function setChainSpecificConstants(HomerunChainConfig[] calldata chains) external override {
        if (msg.sender != _DEPLOYER) revert HomerunDeployer_Unauthorized(msg.sender);
        if (USDC != address(0)) revert HomerunDeployer_AlreadyConfigured();

        // Keep a reference to this chain's USDC, found while walking the configuration.
        address localUsdc;

        // Keep a reference to the last chain ID seen, so the configuration must be strictly ascending.
        uint32 previousChain;

        for (uint256 i; i < chains.length; i++) {
            // Get a reference to the entry being iterated on.
            HomerunChainConfig calldata entry = chains[i];

            // Make sure the chains are unique and ascending, every chain has USDC, and every chain runs the protocol
            // this contract was built with.
            if (
                entry.chainId <= previousChain || entry.usdc == address(0) || entry.revDeployer != address(REV_DEPLOYER)
                    || entry.omnichainDeployer != address(OMNICHAIN_DEPLOYER)
                    || entry.allowlistHook != address(ALLOWLIST_HOOK)
            ) revert HomerunDeployer_InvalidProtocolWiring();
            previousChain = entry.chainId;

            // Store the chain's USDC token so sucker mappings can name it.
            usdcOf[entry.chainId] = entry.usdc;

            // If this is the connected chain's entry, bind it below.
            if (entry.chainId == block.chainid) localUsdc = entry.usdc;
        }

        // Make sure this chain is configured and its USDC has the decimals every treasury accounts in.
        if (localUsdc == address(0) || IERC20Metadata(localUsdc).decimals() != _USDC_DECIMALS) {
            revert HomerunDeployer_InvalidProtocolWiring();
        }

        USDC = localUsdc;
    }

    //*********************************************************************//
    // ----------------------- external views ---------------------------- //
    //*********************************************************************//

    /// @notice Accepts the project NFTs this contract launches, on their way to the owner.
    /// @dev Only `PROJECTS` may deliver one, so no other NFT can be stranded here.
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
        // INCOME accounts in USDC, like FUND.
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

        // Expose the resolved fee payer so `JBProjects` attributes the creation fee to the true payer, not this
        // contract. Cleared immediately after.
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
    // ----------------------- internal views ---------------------------- //
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

        // Commit the snapshot into the revnet's cross-chain identity, so only matching launches pair.
        configuration.description.salt = configurationSaltFor({snapshot: snapshot, launchSalt: description.salt});
        configuration.baseCurrency = JBCurrencyIds.USD;

        // Stock revnets call their authority wallet the operator; here that is the FUND owner.
        configuration.operator = _msgSender();
        configuration.scopeCashOutsToLocalBalances = false;

        // The owner holds the whole reserved split, unlocked, until they redirect it.
        JBSplit[] memory splits = new JBSplit[](1);
        splits[0] = JBSplit({
            percent: JBConstants.SPLITS_TOTAL_PERCENT,
            projectId: 0,
            beneficiary: payable(_msgSender()),
            preferAddToBalance: false,
            lockedUntil: 0,
            hook: IJBSplitHook(address(0))
        });

        // Record every chain's share of the initial allocation for this contract, so the list is identical everywhere
        // and each chain mints only its own share.
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
        // One ruleset with no duration, so the owner can change the rules at any time.
        rulesetConfigurations = new JBRulesetConfig[](1);
        rulesetConfigurations[0].mustStartAtOrAfter = mustStartAtOrAfter;
        rulesetConfigurations[0].weight = FUND_WEIGHT;
        rulesetConfigurations[0].metadata.cashOutTaxRate = FUND_CASH_OUT_TAX_RATE;
        rulesetConfigurations[0].metadata.baseCurrency = JBCurrencyIds.USD;

        // The omnichain deployer keeps this as the FUND's extra hook and consults it on every payment.
        rulesetConfigurations[0].metadata.dataHook = address(ALLOWLIST_HOOK);
        rulesetConfigurations[0].metadata.useDataHookForPay = true;

        // The treasury lives in the terminal as USDC; the registry accepts any other token through swap routing.
        terminalConfigurations = new JBTerminalConfig[](2);
        terminalConfigurations[0].terminal = TERMINAL;
        terminalConfigurations[0].accountingContextsToAccept = new JBAccountingContext[](1);
        terminalConfigurations[0].accountingContextsToAccept[0] = _usdcAccountingContext();
        terminalConfigurations[1].terminal = ROUTER_TERMINAL_REGISTRY;
    }

    /// @notice Reverts unless a snapshot names this FUND on this chain and divides exactly the initial supply across
    /// configured chains.
    /// @dev Allocations must be ascending by chain. The snapshot's hashes, source blocks and balances are the owner's
    /// attestation and are not checked here.
    /// @param fundProjectId The ID of the FUND project.
    /// @param snapshot The global initial allocation snapshot.
    function _requireSnapshot(uint256 fundProjectId, HomerunInitialIncomeSnapshot calldata snapshot) internal view {
        // Keep a reference to the last chain ID seen, so the allocations must be strictly ascending.
        uint32 previousChain;

        // Keep a running total of the allocations, which must reach the initial supply exactly.
        uint256 totalIncome;

        // Keep a reference to the FUND the snapshot names on this chain.
        uint256 localFundProjectId;

        for (uint256 i; i < snapshot.allocations.length; i++) {
            // Get a reference to the allocation being iterated on.
            HomerunInitialIncomeAllocation calldata entry = snapshot.allocations[i];

            // Make sure the allocation names a configured chain, once.
            if (entry.chainId <= previousChain || usdcOf[entry.chainId] == address(0)) {
                revert HomerunDeployer_InvalidSnapshot();
            }
            previousChain = entry.chainId;
            totalIncome += entry.incomeAmount;

            // If this is the connected chain's allocation, note which FUND it names.
            if (entry.chainId == block.chainid) localFundProjectId = entry.fundProjectId;
        }

        // Make sure the allocations divide exactly the initial supply, and that this chain's names this FUND.
        if (totalIncome != INITIAL_INCOME_SUPPLY || localFundProjectId != fundProjectId) {
            revert HomerunDeployer_InvalidSnapshot();
        }
    }

    /// @notice Reverts unless a sucker configuration mirrors the snapshot's chains with the stock USDC/CCIP topology.
    /// @dev Both lists follow ascending remote chain ID. Explicit nonstandard peers are not accepted.
    /// @param snapshot The global initial allocation snapshot.
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
        // Make sure the suckers pair on the launch salt, and that there is one per remote chain in the snapshot.
        if (
            configuration.salt != launchSalt
                || configuration.deployerConfigurations.length + 1 != snapshot.allocations.length
        ) revert HomerunDeployer_InvalidConfiguration();

        // Keep a reference to the sucker configuration being matched, since the snapshot also lists this chain.
        uint256 configIndex;

        for (uint256 i; i < snapshot.allocations.length; i++) {
            // Get a reference to the chain being iterated on, skipping this one.
            uint32 remoteChain = snapshot.allocations[i].chainId;
            if (remoteChain == block.chainid) continue;

            // Get a reference to the sucker configuration for that chain.
            JBSuckerDeployerConfig calldata deployerConfiguration = configuration.deployerConfigurations[configIndex];

            // Make sure it bridges USDC to that chain's USDC through a same-address peer.
            if (
                deployerConfiguration.peer != bytes32(0)
                    || IJBCCIPSuckerDeployer(address(deployerConfiguration.deployer)).ccipRemoteChainId() != remoteChain
                    || deployerConfiguration.mappings.length != 1
                    || deployerConfiguration.mappings[0].localToken != USDC
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

        // Keep a reference to the last remote chain seen, so the deployers must be strictly ascending.
        uint256 previousChain;

        for (uint256 i; i < peerSuckerDeployers.length; i++) {
            // Get a reference to the chain the deployer bridges to, and that chain's USDC.
            uint256 remoteChain = IJBCCIPSuckerDeployer(peerSuckerDeployers[i]).ccipRemoteChainId();
            // A chain ID above `uint32` cannot be configured, so it has no USDC here.
            // forge-lint: disable-next-line(unsafe-typecast)
            address remoteUsdc = remoteChain <= type(uint32).max ? usdcOf[uint32(remoteChain)] : address(0);

            // Make sure the chain is configured, remote, and unique.
            if (remoteChain <= previousChain || remoteChain == block.chainid || remoteUsdc == address(0)) {
                revert HomerunDeployer_InvalidConfiguration();
            }
            previousChain = remoteChain;

            // Bridge USDC to that chain's USDC, pairing with the same-address peer the omnichain deployer derives.
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
        // The currency ID of an ERC-20 is the low 32 bits of its address, by protocol convention.
        // forge-lint: disable-next-line(unsafe-typecast)
        return JBAccountingContext({token: USDC, decimals: _USDC_DECIMALS, currency: uint32(uint160(USDC))});
    }
}
