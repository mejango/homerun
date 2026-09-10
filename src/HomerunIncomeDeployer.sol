// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {HomerunInitialIncomeVault} from "./HomerunInitialIncomeVault.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IJBController} from "@bananapus/core-v6/src/interfaces/IJBController.sol";
import {IJBDirectory} from "@bananapus/core-v6/src/interfaces/IJBDirectory.sol";
import {IJBProjects} from "@bananapus/core-v6/src/interfaces/IJBProjects.sol";
import {IJBTokens} from "@bananapus/core-v6/src/interfaces/IJBTokens.sol";
import {IJBSplitHook} from "@bananapus/core-v6/src/interfaces/IJBSplitHook.sol";
import {JBAccountingContext} from "@bananapus/core-v6/src/structs/JBAccountingContext.sol";
import {JBRuleset} from "@bananapus/core-v6/src/structs/JBRuleset.sol";
import {JBRulesetMetadata} from "@bananapus/core-v6/src/structs/JBRulesetMetadata.sol";
import {JBSplit} from "@bananapus/core-v6/src/structs/JBSplit.sol";
import {REVConfig} from "@rev-net/core-v6/src/structs/REVConfig.sol";
import {REVDescription} from "@rev-net/core-v6/src/structs/REVDescription.sol";
import {REVStageConfig} from "@rev-net/core-v6/src/structs/REVStageConfig.sol";
import {REVAutoIssuance} from "@rev-net/core-v6/src/structs/REVAutoIssuance.sol";
import {REVSuckerDeploymentConfig} from "@rev-net/core-v6/src/structs/REVSuckerDeploymentConfig.sol";
import {REVDeploy721TiersHookConfig} from "@rev-net/core-v6/src/structs/REVDeploy721TiersHookConfig.sol";
import {REVCroptopAllowedPost} from "@rev-net/core-v6/src/structs/REVCroptopAllowedPost.sol";

/// @dev Exact ABI slices avoid pulling contract implementations into this orchestration contract.
interface IHomerunRevDeployer {
    function CONTROLLER() external view returns (address);
    function DIRECTORY() external view returns (address);
    function PROJECTS() external view returns (address);
    function OWNER() external view returns (address);
    function LOANS() external view returns (address);
    function MULTI_TERMINAL() external view returns (address);
    function SUCKER_REGISTRY() external view returns (address);
    function deployFor(
        uint256 revnetId,
        REVConfig calldata configuration,
        JBAccountingContext[] calldata accountingContexts,
        REVSuckerDeploymentConfig calldata suckerConfiguration,
        REVDeploy721TiersHookConfig calldata tiered721Configuration,
        REVCroptopAllowedPost[] calldata allowedPosts
    )
        external
        payable
        returns (uint256, address);
}

interface IHomerunRevOwner {
    function deployer() external view returns (address);
    function CONTROLLER() external view returns (address);
    function DIRECTORY() external view returns (address);
    function PROJECTS() external view returns (address);
    function LOANS() external view returns (address);
    function SUCKER_REGISTRY() external view returns (address);
    function autoIssueFor(uint256 revnetId, uint256 stageId, address beneficiary) external;
    function amountToAutoIssue(uint256 revnetId, uint256 stageId, address beneficiary) external view returns (uint256);
    function isOperatorOf(uint256 revnetId, address operator) external view returns (bool);
}

interface IHomerunRevLoans {
    function CONTROLLER() external view returns (address);
    function TERMINAL() external view returns (address);
}

interface IHomerunTokenDistributor {
    function DIRECTORY() external view returns (address);
    function CONTROLLER() external view returns (address);
    function REV_OWNER() external view returns (address);
    function REV_LOANS() external view returns (address);
    function ROUND_DURATION() external view returns (uint256);
    function STARTING_TIMESTAMP() external view returns (uint256);
    function VESTING_ROUNDS() external view returns (uint256);
    function CLAIM_DURATION() external view returns (uint48);
}

interface IHomerunSuckerRegistry {
    function DIRECTORY() external view returns (address);
    function PROJECTS() external view returns (address);
    function allSuckersOf(uint256 projectId) external view returns (address[] memory);
}

interface IHomerunTokenImplementation {
    function TOKEN() external view returns (address);
}

interface IHomerunStickyDeployer {
    function CONTROLLER() external view returns (address);
    function TOKENS() external view returns (address);
    function TERMINAL() external view returns (address);
    function HOOK() external view returns (address);
    function stakedTokenOf(uint256 projectId) external view returns (address);
    function cashOutTaxRateOf(uint256 projectId) external view returns (uint256);
}

interface IHomerunStickyHook {
    function DEPLOYER() external view returns (address);
    function DIRECTORY() external view returns (address);
    function tokenOf(uint256 projectId) external view returns (address);
}

interface IHomerunStickyToken {
    function HOOK() external view returns (address);
    function TOKENS() external view returns (address);
    function PROJECT_ID() external view returns (uint256);
}

interface IHomerunOmnichainDeployer {
    function CONTROLLER() external view returns (address);
    function DIRECTORY() external view returns (address);
    function PROJECTS() external view returns (address);
    function SUCKER_REGISTRY() external view returns (address);
    function HOOK_DEPLOYER() external view returns (address);
    function extraDataHookOf(uint256 projectId, uint256 rulesetId) external view returns (address, bool, bool);
    function tiered721HookOf(uint256 projectId, uint256 rulesetId) external view returns (address, bool);
}

interface IHomerun721Hook {
    function STORE() external view returns (address);
    function projectId() external view returns (uint256);
    function owner() external view returns (address);
    function jbOwner() external view returns (address, uint88, uint8);
}

interface IHomerun721Store {
    function maxTierIdOf(address hook) external view returns (uint256);
}

interface IHomerun721Deployer {
    function STORE() external view returns (address);
}

interface IHomerunCcipDeployer {
    function ccipRemoteChainId() external view returns (uint256);
}

interface IHomerunArbSys {
    function arbBlockNumber() external view returns (uint256);
    function arbBlockHash(uint256 blockNumber) external view returns (bytes32);
}

struct HomerunIncomeChainConfig {
    uint32 chainId;
    address controller;
    address revDeployer;
    address tokenDistributor;
    address usdc;
    address stickyDeployer;
    address omnichainDeployer;
}

struct HomerunInitialIncomeAllocation {
    uint32 chainId;
    uint256 fundProjectId;
    uint256 snapshotBlockNumber;
    bytes32 snapshotBlockHash;
    bytes32 merkleRoot;
    uint256 leafCount;
    uint104 incomeAmount;
}

struct HomerunInitialIncomeSnapshot {
    bytes32 sourceSetHash;
    uint256 totalFundSupply;
    bytes32 manifestHash;
    string manifestUri;
    HomerunInitialIncomeAllocation[] allocations;
}

/// @notice UNAUDITED orchestration for an atomic, bounded initial INCOME allocation. Not a verified deployment.
/// @dev The FUND owner attests to a fixed, published snapshot root that includes credits and inactive holders.
/// Root completeness, historical balances, and allocation sums are NOT cryptographically verified onchain.
/// Independently reproduce and reconcile the manifest before signing. The entire local allocation is minted before
/// returning; all chains commit the same global 500,000 allocation and deploy asynchronously.
/// Perpetual vault claims transfer existing tokens and never change FUND balances. The helper retains
/// no project ownership, tokens, or operator permissions. Ongoing stock Sticky rewards use SHARE snapshots and
/// four weekly vesting rounds, with no minimum stake-age requirement.
contract HomerunIncomeDeployer is ReentrancyGuard {
    using SafeERC20 for IERC20;
    error InvalidProtocolWiring();
    error Unauthorized();
    error UnsupportedFund();
    error FundNotClosed();
    error InvalidConfiguration();
    error WrongCreationFee();
    error IncompleteIssuance();
    error AlreadyDeployed();
    error InvalidSnapshot();
    error UnsupportedRewardSource();

    event IncomeDeployed(
        uint256 indexed fundProjectId,
        uint256 indexed incomeProjectId,
        address indexed operator,
        address fundToken,
        address initialAllocationVault,
        address rewardToken,
        bytes32 merkleRoot
    );

    uint256 public constant INITIAL_INCOME_SUPPLY = 500_000 ether;
    uint32 public constant QUARTER = 7_884_000;
    bytes32 public constant DISTRIBUTION_TYPEHASH = keccak256(
        "HomerunInitialIncome(uint256 chainId,address deployer,uint256 fundProjectId,bytes32 sourceSetHash,uint256 totalFundSupply,bytes32 salt)"
    );
    IJBController public immutable CONTROLLER;
    IJBDirectory public immutable DIRECTORY;
    IJBProjects public immutable PROJECTS;
    IJBTokens public immutable TOKENS;
    IHomerunRevDeployer public immutable REV_DEPLOYER;
    IHomerunRevOwner public immutable REV_OWNER;
    IHomerunSuckerRegistry public immutable SUCKER_REGISTRY;
    address public immutable TOKEN_DISTRIBUTOR;
    address public immutable USDC;
    IHomerunStickyDeployer public immutable STICKY_DEPLOYER;
    IHomerunOmnichainDeployer public immutable OMNICHAIN_DEPLOYER;
    bytes32 public immutable PROTOCOL_CONFIG_HASH;
    bytes32 public immutable FUND_TOKEN_CODE_HASH;
    mapping(uint32 chainId => address usdc) public usdcOf;

    /// @notice Preserves project-creation fee attribution while forwarding the owner's payment.
    address public originalPayer;
    mapping(uint256 fundProjectId => uint256 incomeProjectId) public incomeProjectIdOf;
    mapping(uint256 fundProjectId => address vault) public initialAllocationVaultOf;

    /// @dev Identical constructor calldata on every chain preserves the same CREATE2 helper address despite
    /// chain-specific dependencies. The canonical registry must verify this complete, immutable deployment profile.
    constructor(HomerunIncomeChainConfig[] memory chains) {
        HomerunIncomeChainConfig memory local;
        uint32 previousChain;
        for (uint256 i; i < chains.length; i++) {
            HomerunIncomeChainConfig memory entry = chains[i];
            if (entry.chainId <= previousChain || entry.usdc == address(0)) revert InvalidProtocolWiring();
            previousChain = entry.chainId;
            usdcOf[entry.chainId] = entry.usdc;
            if (entry.chainId == block.chainid) local = entry;
        }
        PROTOCOL_CONFIG_HASH = keccak256(abi.encode(chains));
        address controller = local.controller;
        address revDeployer = local.revDeployer;
        address tokenDistributor = local.tokenDistributor;
        address usdc = local.usdc;
        address stickyDeployer = local.stickyDeployer;
        if (
            controller.code.length == 0 || revDeployer.code.length == 0 || tokenDistributor.code.length == 0
                || usdc.code.length == 0 || stickyDeployer.code.length == 0 || local.omnichainDeployer.code.length == 0
        ) revert InvalidProtocolWiring();
        CONTROLLER = IJBController(controller);
        DIRECTORY = CONTROLLER.DIRECTORY();
        PROJECTS = CONTROLLER.PROJECTS();
        TOKENS = CONTROLLER.TOKENS();
        REV_DEPLOYER = IHomerunRevDeployer(revDeployer);
        REV_OWNER = IHomerunRevOwner(REV_DEPLOYER.OWNER());
        SUCKER_REGISTRY = IHomerunSuckerRegistry(REV_DEPLOYER.SUCKER_REGISTRY());
        TOKEN_DISTRIBUTOR = tokenDistributor;
        USDC = usdc;
        STICKY_DEPLOYER = IHomerunStickyDeployer(stickyDeployer);
        OMNICHAIN_DEPLOYER = IHomerunOmnichainDeployer(local.omnichainDeployer);
        IHomerunTokenDistributor distributor = IHomerunTokenDistributor(tokenDistributor);
        if (
            REV_DEPLOYER.CONTROLLER() != controller || REV_DEPLOYER.DIRECTORY() != address(DIRECTORY)
                || REV_DEPLOYER.PROJECTS() != address(PROJECTS) || REV_DEPLOYER.MULTI_TERMINAL().code.length == 0
                || REV_OWNER.deployer() != revDeployer || REV_OWNER.CONTROLLER() != controller
                || REV_OWNER.DIRECTORY() != address(DIRECTORY) || REV_OWNER.PROJECTS() != address(PROJECTS)
                || REV_OWNER.LOANS() != REV_DEPLOYER.LOANS() || REV_OWNER.SUCKER_REGISTRY() != address(SUCKER_REGISTRY)
                || IHomerunRevLoans(REV_DEPLOYER.LOANS()).CONTROLLER() != controller
                || IHomerunRevLoans(REV_DEPLOYER.LOANS()).TERMINAL() != REV_DEPLOYER.MULTI_TERMINAL()
                || SUCKER_REGISTRY.DIRECTORY() != address(DIRECTORY) || SUCKER_REGISTRY.PROJECTS() != address(PROJECTS)
                || distributor.CONTROLLER() != controller || distributor.DIRECTORY() != address(DIRECTORY)
                || !_validDistributorLoans(distributor) || distributor.ROUND_DURATION() != 7 days
                || distributor.VESTING_ROUNDS() != 4 || distributor.CLAIM_DURATION() != 3 * 365 days
                || distributor.STARTING_TIMESTAMP() == 0 || distributor.STARTING_TIMESTAMP() > block.timestamp
                || STICKY_DEPLOYER.CONTROLLER() != controller || STICKY_DEPLOYER.TOKENS() != address(TOKENS)
                || STICKY_DEPLOYER.TERMINAL() != REV_DEPLOYER.MULTI_TERMINAL()
                || STICKY_DEPLOYER.HOOK().code.length == 0
                || IHomerunStickyHook(STICKY_DEPLOYER.HOOK()).DEPLOYER() != stickyDeployer
                || IHomerunStickyHook(STICKY_DEPLOYER.HOOK()).DIRECTORY() != address(DIRECTORY)
                || OMNICHAIN_DEPLOYER.CONTROLLER() != controller || OMNICHAIN_DEPLOYER.DIRECTORY() != address(DIRECTORY)
                || OMNICHAIN_DEPLOYER.PROJECTS() != address(PROJECTS)
                || OMNICHAIN_DEPLOYER.SUCKER_REGISTRY() != address(SUCKER_REGISTRY)
                || IERC20Metadata(usdc).decimals() != 6
        ) revert InvalidProtocolWiring();
        address implementation = IHomerunTokenImplementation(address(TOKENS)).TOKEN();
        if (implementation.code.length == 0) revert InvalidProtocolWiring();
        // Only standard core JBERC20 clones can be used as the ongoing reward stake source.
        FUND_TOKEN_CODE_HASH =
            keccak256(abi.encodePacked(hex"363d3d373d3d3d363d73", implementation, hex"5af43d82803e903d91602b57fd5bf3"));
    }

    /// @notice Domain committed in every leaf; the one-per-FUND binding associates it with the resulting INCOME.
    function distributionIdFor(
        uint256 fundProjectId,
        HomerunInitialIncomeSnapshot calldata snapshot,
        bytes32 salt
    )
        external
        view
        returns (bytes32)
    {
        return keccak256(
            abi.encode(
                DISTRIBUTION_TYPEHASH,
                block.chainid,
                address(this),
                fundProjectId,
                snapshot.sourceSetHash,
                snapshot.totalFundSupply,
                salt
            )
        );
    }

    /// @notice Commits the published global allocation into the stock revnet's cross-chain identity.
    /// @dev The leaf domain uses the original launch salt, avoiding a root/manifest hash self-reference.
    function configurationSaltFor(
        HomerunInitialIncomeSnapshot calldata snapshot,
        bytes32 launchSalt
    )
        public
        pure
        returns (bytes32)
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

    /// @notice Launch, materialize the complete local allocation, and fund its immutable vault in one transaction.
    /// @dev The supplied root is an owner attestation. It does not prove complete or truthful historical balances.
    /// The snapshot must precede managed Sticky deposits; the publication verifier enforces that history policy.
    /// @param stickyProjectId Canonical Sticky project accepting this FUND; ongoing rewards route to its SHARE token.
    function deployIncome(
        uint256 fundProjectId,
        HomerunInitialIncomeSnapshot calldata snapshot,
        REVDescription calldata description,
        uint16 operatorBps,
        uint16 fundHoldersBps,
        uint256 stickyProjectId,
        uint48 startsAtOrAfter,
        REVSuckerDeploymentConfig calldata suckerConfiguration
    )
        external
        payable
        nonReentrant
        returns (uint256 incomeProjectId)
    {
        if (PROJECTS.ownerOf(fundProjectId) != msg.sender) revert Unauthorized();
        if (incomeProjectIdOf[fundProjectId] != 0) revert AlreadyDeployed();
        if (msg.value != PROJECTS.creationFee()) revert WrongCreationFee();
        if (
            bytes(description.name).length == 0 || keccak256(bytes(description.ticker)) != keccak256("INCOME")
                || bytes(description.uri).length == 0 || description.salt == bytes32(0)
                || uint256(operatorBps) + fundHoldersBps > 10_000 || fundHoldersBps == 0
                || block.chainid > type(uint32).max || startsAtOrAfter == 0 || startsAtOrAfter > block.timestamp
                || uint256(startsAtOrAfter) + uint256(QUARTER) * 8 > type(uint48).max
        ) revert InvalidConfiguration();
        HomerunInitialIncomeAllocation memory allocation = _requireSnapshot(fundProjectId, snapshot);
        _requireSuckers(snapshot, suckerConfiguration, description.salt);
        address fundToken = _requireClosedFund(fundProjectId);
        address rewardToken = _requireSticky(stickyProjectId, fundToken);
        REVConfig memory config =
            _configuration(description, snapshot, rewardToken, operatorBps, fundHoldersBps, startsAtOrAfter);
        incomeProjectIdOf[fundProjectId] = type(uint256).max;
        incomeProjectId = _launch(config, suckerConfiguration);
        address vault = _issueAndFundVault(incomeProjectId, allocation, snapshot, description.salt);
        if (
            PROJECTS.ownerOf(incomeProjectId) != address(REV_OWNER)
                || !REV_OWNER.isOperatorOf(incomeProjectId, msg.sender)
        ) revert IncompleteIssuance();
        incomeProjectIdOf[fundProjectId] = incomeProjectId;
        initialAllocationVaultOf[fundProjectId] = vault;
        emit IncomeDeployed(
            fundProjectId, incomeProjectId, msg.sender, fundToken, vault, rewardToken, allocation.merkleRoot
        );
    }

    function _validDistributorLoans(IHomerunTokenDistributor distributor) private view returns (bool) {
        return distributor.REV_OWNER() == address(0) && distributor.REV_LOANS() == address(0);
    }

    function _requireSnapshot(
        uint256 fundProjectId,
        HomerunInitialIncomeSnapshot calldata snapshot
    )
        private
        view
        returns (HomerunInitialIncomeAllocation memory local)
    {
        if (
            snapshot.sourceSetHash == bytes32(0) || snapshot.totalFundSupply == 0 || snapshot.manifestHash == bytes32(0)
                || bytes(snapshot.manifestUri).length == 0
        ) revert InvalidSnapshot();
        uint32 previousChain;
        uint256 totalIncome;
        for (uint256 i; i < snapshot.allocations.length; i++) {
            HomerunInitialIncomeAllocation calldata entry = snapshot.allocations[i];
            if (
                entry.chainId <= previousChain || usdcOf[entry.chainId] == address(0) || entry.fundProjectId == 0
                    || entry.snapshotBlockHash == bytes32(0) || entry.leafCount > uint256(1) << 160
                    || (entry.leafCount == 0) != (entry.merkleRoot == bytes32(0))
                    || (entry.leafCount == 0 && entry.incomeAmount != 0)
            ) revert InvalidSnapshot();
            previousChain = entry.chainId;
            totalIncome += entry.incomeAmount;
            if (entry.chainId == block.chainid) local = entry;
        }
        // Arbitrum RPC snapshots use L2 heights, while its NUMBER/BLOCKHASH opcodes refer to L1 ancestry.
        bool isArbitrum = block.chainid == 42_161 || block.chainid == 421_614;
        uint256 currentBlock = isArbitrum ? IHomerunArbSys(address(100)).arbBlockNumber() : block.number;
        if (
            totalIncome != INITIAL_INCOME_SUPPLY || local.fundProjectId != fundProjectId
                || local.snapshotBlockNumber >= currentBlock
        ) revert InvalidSnapshot();
        // Recent hashes can be checked directly. Older finalized snapshots remain explicitly owner-attested,
        // allowing a Safe proposal to execute after EVM blockhash history expires without changing entitlements.
        if (currentBlock - local.snapshotBlockNumber <= 256) {
            bytes32 canonicalHash = isArbitrum
                ? IHomerunArbSys(address(100)).arbBlockHash(local.snapshotBlockNumber)
                : blockhash(local.snapshotBlockNumber);
            if (canonicalHash != local.snapshotBlockHash) revert InvalidSnapshot();
        }
    }

    /// @dev Mirrors the app's stock SDK USDC/CCIP topology. Explicit nonstandard peers are not accepted.
    function _requireSuckers(
        HomerunInitialIncomeSnapshot calldata snapshot,
        REVSuckerDeploymentConfig calldata configuration,
        bytes32 launchSalt
    )
        private
        view
    {
        if (
            configuration.salt != launchSalt
                || configuration.deployerConfigurations.length + 1 != snapshot.allocations.length
        ) revert InvalidConfiguration();
        uint256 configIndex;
        for (uint256 i; i < snapshot.allocations.length; i++) {
            uint32 remoteChain = snapshot.allocations[i].chainId;
            if (remoteChain == block.chainid) continue;
            // Both lists follow increasing remote chain ID, matching the reviewed SDK request.
            if (
                configuration.deployerConfigurations[configIndex].peer != bytes32(0)
                    || IHomerunCcipDeployer(address(configuration.deployerConfigurations[configIndex].deployer))
                            .ccipRemoteChainId() != remoteChain
                    || configuration.deployerConfigurations[configIndex].mappings.length != 1
                    || configuration.deployerConfigurations[configIndex].mappings[0].localToken != USDC
                    || configuration.deployerConfigurations[configIndex].mappings[0].remoteToken
                        != bytes32(uint256(uint160(usdcOf[remoteChain])))
            ) revert InvalidConfiguration();
            configIndex++;
        }
    }

    function _requireSticky(uint256 stickyProjectId, address fundToken) private view returns (address rewardToken) {
        address hook = STICKY_DEPLOYER.HOOK();
        rewardToken = address(TOKENS.tokenOf(stickyProjectId));
        if (
            stickyProjectId == 0 || rewardToken.code.length == 0
                || STICKY_DEPLOYER.stakedTokenOf(stickyProjectId) != fundToken
                || STICKY_DEPLOYER.cashOutTaxRateOf(stickyProjectId) != 0
                || PROJECTS.ownerOf(stickyProjectId) != address(STICKY_DEPLOYER)
                || address(DIRECTORY.controllerOf(stickyProjectId)) != address(CONTROLLER)
                || address(DIRECTORY.primaryTerminalOf(stickyProjectId, fundToken)) != STICKY_DEPLOYER.TERMINAL()
                || IHomerunStickyHook(hook).tokenOf(stickyProjectId) != rewardToken
                || IHomerunStickyToken(rewardToken).HOOK() != hook
                || IHomerunStickyToken(rewardToken).PROJECT_ID() != stickyProjectId
                || IHomerunStickyToken(rewardToken).TOKENS() != address(TOKENS)
        ) revert UnsupportedRewardSource();
    }

    function _launch(
        REVConfig memory config,
        REVSuckerDeploymentConfig calldata suckers
    )
        internal
        returns (uint256 incomeProjectId)
    {
        JBAccountingContext[] memory contexts = new JBAccountingContext[](1);
        // Match the canonical terminal's token-keyed accounting currency; issuance remains USD-denominated.
        contexts[0] = JBAccountingContext({token: USDC, decimals: 6, currency: uint32(uint160(USDC))});
        REVDeploy721TiersHookConfig memory nft;
        nft.baseline721HookConfiguration.name = config.description.name;
        nft.baseline721HookConfiguration.symbol = config.description.ticker;
        nft.baseline721HookConfiguration.tiersConfig.currency = 2;
        nft.baseline721HookConfiguration.tiersConfig.decimals = 6;
        nft.preventOperatorAdjustingTiers = true;
        nft.preventOperatorUpdatingMetadata = true;
        nft.preventOperatorMinting = true;
        nft.preventOperatorIncreasingDiscountPercent = true;
        originalPayer = msg.sender;
        (incomeProjectId,) =
            REV_DEPLOYER.deployFor{value: msg.value}(0, config, contexts, suckers, nft, new REVCroptopAllowedPost[](0));
        originalPayer = address(0);
    }

    function _requireClosedFund(uint256 projectId) internal view returns (address token) {
        if (address(DIRECTORY.controllerOf(projectId)) != address(CONTROLLER)) revert UnsupportedFund();
        (JBRuleset memory ruleset, JBRulesetMetadata memory metadata) = CONTROLLER.currentRulesetOf(projectId);
        (JBRuleset memory latest,,) = CONTROLLER.latestQueuedRulesetOf(projectId);
        (JBRuleset memory upcoming,) = CONTROLLER.upcomingRulesetOf(projectId);
        if ((latest.id != 0 && latest.id != ruleset.id) || (upcoming.id != 0 && upcoming.id != ruleset.id)) {
            revert FundNotClosed();
        }
        if (
            ruleset.id == 0 || !metadata.pausePay || metadata.cashOutTaxRate != 10_000 || metadata.allowOwnerMinting
                || CONTROLLER.pendingReservedTokenBalanceOf(projectId) != 0
        ) revert FundNotClosed();
        if (metadata.dataHook == address(OMNICHAIN_DEPLOYER)) {
            (address extraHook, bool extraPay, bool extraCashOut) =
                OMNICHAIN_DEPLOYER.extraDataHookOf(projectId, ruleset.id);
            (address tieredHook, bool tieredCashOut) = OMNICHAIN_DEPLOYER.tiered721HookOf(projectId, ruleset.id);
            if (extraHook != address(0) || extraPay || extraCashOut || tieredCashOut) revert UnsupportedFund();
            if (tieredHook != address(0)) {
                IHomerun721Hook hook = IHomerun721Hook(tieredHook);
                (, uint88 ownerProject,) = hook.jbOwner();
                address store = IHomerun721Deployer(OMNICHAIN_DEPLOYER.HOOK_DEPLOYER()).STORE();
                if (
                    hook.STORE() != store || hook.projectId() != projectId || ownerProject != projectId
                        || hook.owner() != PROJECTS.ownerOf(projectId)
                        || IHomerun721Store(store).maxTierIdOf(tieredHook) != 0
                ) revert UnsupportedFund();
            }
        } else if (metadata.dataHook != address(0) || metadata.useDataHookForPay || metadata.useDataHookForCashOut) {
            revert UnsupportedFund();
        }
        token = address(TOKENS.tokenOf(projectId));
        if (token.codehash != FUND_TOKEN_CODE_HASH) revert UnsupportedFund();
    }

    function _configuration(
        REVDescription calldata description,
        HomerunInitialIncomeSnapshot calldata snapshot,
        address rewardToken,
        uint16 operatorBps,
        uint16 fundHoldersBps,
        uint48 startsAtOrAfter
    )
        internal
        view
        returns (REVConfig memory config)
    {
        config.description = description;
        config.description.salt = configurationSaltFor(snapshot, description.salt);
        config.baseCurrency = 2;
        config.operator = msg.sender;
        config.scopeCashOutsToLocalBalances = false;
        config.stageConfigurations = new REVStageConfig[](2);
        uint16 reservedBps = operatorBps + fundHoldersBps;
        JBSplit[] memory splits = new JBSplit[](operatorBps == 0 ? 1 : 2);
        uint32 operatorSplit = uint32(uint256(operatorBps) * 1_000_000_000 / reservedBps);
        if (operatorBps != 0) {
            splits[0] = JBSplit({
                percent: operatorSplit,
                projectId: 0,
                beneficiary: payable(msg.sender),
                preferAddToBalance: false,
                lockedUntil: type(uint48).max,
                hook: IJBSplitHook(address(0))
            });
        }
        splits[splits.length - 1] = JBSplit({
            percent: 1_000_000_000 - operatorSplit,
            projectId: 0,
            beneficiary: payable(rewardToken),
            preferAddToBalance: false,
            lockedUntil: type(uint48).max,
            hook: IJBSplitHook(TOKEN_DISTRIBUTOR)
        });
        REVAutoIssuance[] memory autoIssuances = new REVAutoIssuance[](snapshot.allocations.length);
        for (uint256 i; i < autoIssuances.length; i++) {
            autoIssuances[i] = REVAutoIssuance({
                chainId: snapshot.allocations[i].chainId,
                count: snapshot.allocations[i].incomeAmount,
                beneficiary: address(this)
            });
        }
        config.stageConfigurations[0] = REVStageConfig({
            startsAtOrAfter: startsAtOrAfter,
            autoIssuances: autoIssuances,
            splitPercent: reservedBps,
            splits: splits,
            initialIssuance: 10 ether,
            issuanceCutFrequency: QUARTER,
            issuanceCutPercent: 50_000_000,
            cashOutTaxRate: 0,
            extraMetadata: 4
        });
        // Core's weight=1 sentinel inherits all eight completed cuts, then stops further decay.
        config.stageConfigurations[1] = REVStageConfig({
            startsAtOrAfter: uint48(uint256(startsAtOrAfter) + uint256(QUARTER) * 8),
            autoIssuances: new REVAutoIssuance[](0),
            splitPercent: reservedBps,
            splits: splits,
            initialIssuance: 1,
            issuanceCutFrequency: 0,
            issuanceCutPercent: 0,
            cashOutTaxRate: 0,
            extraMetadata: 4
        });
    }

    function _issueAndFundVault(
        uint256 incomeProjectId,
        HomerunInitialIncomeAllocation memory allocation,
        HomerunInitialIncomeSnapshot calldata snapshot,
        bytes32 salt
    )
        private
        returns (address vault)
    {
        // REVDeployer keys its first stage's auto-issuance by this deployment's block timestamp. The current
        // stage may already be stage 2 on a late chain; the original stage's entitlement remains claimable.
        uint256 stageId = block.timestamp;
        (JBRuleset memory ruleset,) = CONTROLLER.getRulesetOf(incomeProjectId, stageId);
        address token = address(TOKENS.tokenOf(incomeProjectId));
        if (
            ruleset.id != stageId || token.codehash != FUND_TOKEN_CODE_HASH
                || REV_OWNER.amountToAutoIssue(incomeProjectId, stageId, address(this)) != allocation.incomeAmount
        ) {
            revert IncompleteIssuance();
        }
        if (allocation.incomeAmount != 0) REV_OWNER.autoIssueFor(incomeProjectId, stageId, address(this));
        if (
            REV_OWNER.amountToAutoIssue(incomeProjectId, stageId, address(this)) != 0
                || IERC20(token).balanceOf(address(this)) != allocation.incomeAmount
                || TOKENS.totalSupplyOf(incomeProjectId) != allocation.incomeAmount
                || CONTROLLER.pendingReservedTokenBalanceOf(incomeProjectId) != 0
        ) revert IncompleteIssuance();
        vault = address(
            new HomerunInitialIncomeVault(
                token,
                incomeProjectId,
                allocation.fundProjectId,
                allocation.snapshotBlockNumber,
                allocation.snapshotBlockHash,
                snapshot.totalFundSupply,
                salt,
                allocation.merkleRoot,
                allocation.leafCount,
                snapshot.manifestHash,
                snapshot.manifestUri,
                snapshot.sourceSetHash,
                allocation.incomeAmount
            )
        );
        if (allocation.incomeAmount != 0) IERC20(token).safeTransfer(vault, allocation.incomeAmount);
        if (IERC20(token).balanceOf(vault) != allocation.incomeAmount || IERC20(token).balanceOf(address(this)) != 0) {
            revert IncompleteIssuance();
        }
    }
}
