// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import {IJBController} from "@bananapus/core-v6/src/interfaces/IJBController.sol";
import {IJBDirectory} from "@bananapus/core-v6/src/interfaces/IJBDirectory.sol";
import {IJBPayerTracker} from "@bananapus/core-v6/src/interfaces/IJBPayerTracker.sol";
import {IJBProjects} from "@bananapus/core-v6/src/interfaces/IJBProjects.sol";
import {IJBTerminal} from "@bananapus/core-v6/src/interfaces/IJBTerminal.sol";
import {IJBTokens} from "@bananapus/core-v6/src/interfaces/IJBTokens.sol";
import {IJBOmnichainDeployer} from "@bananapus/omnichain-deployers-v6/src/interfaces/IJBOmnichainDeployer.sol";
import {IJBSuckerRegistry} from "@bananapus/suckers-v6/src/interfaces/IJBSuckerRegistry.sol";
import {IREVDeployer} from "@rev-net/core-v6/src/interfaces/IREVDeployer.sol";
import {IREVOwner} from "@rev-net/core-v6/src/interfaces/IREVOwner.sol";
import {REVDescription} from "@rev-net/core-v6/src/structs/REVDescription.sol";
import {REVSuckerDeploymentConfig} from "@rev-net/core-v6/src/structs/REVSuckerDeploymentConfig.sol";
import {IHomerunAllowlistHook} from "./IHomerunAllowlistHook.sol";
import {HomerunInitialIncomeSnapshot} from "../structs/HomerunInitialIncomeSnapshot.sol";

/// @notice Launches Homerun FUNDs with fixed campaign rules and, once a FUND closes, its INCOME revnet together with
/// the atomic, bounded initial INCOME allocation.
interface IHomerunDeployer is IJBPayerTracker {
    /// @notice Emitted when a FUND is launched.
    /// @param projectId The ID of the new FUND project.
    /// @param owner The address that owns the FUND.
    /// @param caller The address that launched it.
    event FundLaunched(uint256 indexed projectId, address indexed owner, address caller);

    /// @notice Emitted when a FUND's INCOME is deployed and its local initial allocation is funded.
    /// @param fundProjectId The ID of the FUND project.
    /// @param incomeProjectId The ID of the new INCOME project.
    /// @param owner The FUND owner, who becomes the INCOME revnet's operator and holds its reserved split.
    /// @param fundToken The FUND ERC-20 the snapshot was taken over.
    /// @param initialAllocationVault The vault funded with this chain's initial allocation.
    /// @param merkleRoot The root of this chain's allocation leaves.
    event IncomeDeployed(
        uint256 indexed fundProjectId,
        uint256 indexed incomeProjectId,
        address indexed owner,
        address fundToken,
        address initialAllocationVault,
        bytes32 merkleRoot
    );

    /// @notice The pay hook installed on every FUND. Its owner-managed allowlist gates payment beneficiaries.
    /// @return hook The allowlist hook.
    function ALLOWLIST_HOOK() external view returns (IHomerunAllowlistHook hook);

    /// @notice The controller every FUND and INCOME is launched with.
    /// @return controller The controller.
    function CONTROLLER() external view returns (IJBController controller);

    /// @notice The directory of terminals and controllers.
    /// @return directory The directory.
    function DIRECTORY() external view returns (IJBDirectory directory);

    /// @notice The EIP-712-style type hash committed in every initial allocation leaf.
    /// @return typehash The type hash.
    function DISTRIBUTION_TYPEHASH() external view returns (bytes32 typehash);

    /// @notice The cash out tax rate a FUND launches with, out of `JBConstants.MAX_CASH_OUT_TAX_RATE`.
    /// @return rate The tax rate.
    function FUND_CASH_OUT_TAX_RATE() external view returns (uint16 rate);

    /// @notice The CCIP gas allowance every FUND sucker mapping uses.
    /// @return minGas The gas allowance.
    function FUND_SUCKER_MIN_GAS() external view returns (uint32 minGas);

    /// @notice The code hash of a canonical `JBERC20` clone. Only FUNDs still using one can launch INCOME.
    /// @return hash The code hash.
    function FUND_TOKEN_CODE_HASH() external view returns (bytes32 hash);

    /// @notice The FUND issued per unit of USD paid, as a fixed point number with 18 decimals.
    /// @return weight The issuance weight.
    function FUND_WEIGHT() external view returns (uint112 weight);

    /// @notice The cash out tax rate INCOME launches with, out of `JBConstants.MAX_CASH_OUT_TAX_RATE`.
    /// @return rate The tax rate.
    function INCOME_CASH_OUT_TAX_RATE() external view returns (uint16 rate);

    /// @notice The percent INCOME issuance falls by every quarter, out of `JBConstants.MAX_WEIGHT_CUT_PERCENT`.
    /// @return percent The cut percent.
    function INCOME_CUT_PERCENT() external view returns (uint32 percent);

    /// @notice The INCOME issued per unit of USD paid at launch, as a fixed point number with 18 decimals.
    /// @return weight The initial issuance.
    function INCOME_INITIAL_ISSUANCE() external view returns (uint112 weight);

    /// @notice The INCOME every FUND's holders share at launch, across every chain, as a fixed point number with 18
    /// decimals.
    /// @return supply The global initial supply.
    function INITIAL_INCOME_SUPPLY() external view returns (uint256 supply);

    /// @notice The version of the launch semantics this deployer implements.
    /// @return version The launch version.
    function LAUNCH_VERSION() external view returns (uint256 version);

    /// @notice The omnichain deployer every FUND is launched through.
    /// @return deployer The omnichain deployer.
    function OMNICHAIN_DEPLOYER() external view returns (IJBOmnichainDeployer deployer);

    /// @notice The project registry.
    /// @return projects The project registry.
    function PROJECTS() external view returns (IJBProjects projects);

    /// @notice The hash of the complete per-chain configuration this deployer was constructed with.
    /// @dev Identical on every chain, since the same array is passed everywhere.
    /// @return hash The configuration hash.
    function PROTOCOL_CONFIG_HASH() external view returns (bytes32 hash);

    /// @notice The number of seconds in one INCOME issuance cycle.
    /// @return seconds_ The cycle length.
    function QUARTER() external view returns (uint32 seconds_);

    /// @notice The revnet deployer INCOME is launched through.
    /// @return deployer The revnet deployer.
    function REV_DEPLOYER() external view returns (IREVDeployer deployer);

    /// @notice The contract that owns every INCOME revnet.
    /// @return owner The revnet owner.
    function REV_OWNER() external view returns (IREVOwner owner);

    /// @notice The router terminal registry every FUND and INCOME registers so any token can pay through swap
    /// routing.
    /// @return registry The router terminal registry.
    function ROUTER_TERMINAL_REGISTRY() external view returns (IJBTerminal registry);

    /// @notice The sucker registry linked FUNDs and INCOMEs deploy suckers through.
    /// @return registry The sucker registry.
    function SUCKER_REGISTRY() external view returns (IJBSuckerRegistry registry);

    /// @notice The terminal every FUND and INCOME treasury lives in.
    /// @return terminal The terminal.
    function TERMINAL() external view returns (IJBTerminal terminal);

    /// @notice The token registry.
    /// @return tokens The token registry.
    function TOKENS() external view returns (IJBTokens tokens);

    /// @notice The USDC token every FUND and INCOME treasury accounts in on this chain.
    /// @return usdc The USDC token.
    function USDC() external view returns (address usdc);

    /// @notice The revnet description salt that commits a snapshot into INCOME's cross-chain identity.
    /// @param snapshot The global initial allocation snapshot.
    /// @param launchSalt The salt the FUND owner launches INCOME with.
    /// @return salt The configuration salt.
    function configurationSaltFor(
        HomerunInitialIncomeSnapshot calldata snapshot,
        bytes32 launchSalt
    )
        external
        pure
        returns (bytes32 salt);

    /// @notice The domain every initial allocation leaf for a FUND is committed under on this chain.
    /// @param fundProjectId The ID of the FUND project.
    /// @param snapshot The global initial allocation snapshot.
    /// @param salt The salt the FUND owner launches INCOME with.
    /// @return distributionId The distribution ID.
    function distributionIdFor(
        uint256 fundProjectId,
        HomerunInitialIncomeSnapshot calldata snapshot,
        bytes32 salt
    )
        external
        view
        returns (bytes32 distributionId);

    /// @notice The INCOME project a FUND launched, if any.
    /// @custom:param fundProjectId The ID of the FUND project.
    function incomeProjectIdOf(uint256 fundProjectId) external view returns (uint256);

    /// @notice The vault holding this chain's initial INCOME allocation for a FUND, if any.
    /// @custom:param fundProjectId The ID of the FUND project.
    function initialAllocationVaultOf(uint256 fundProjectId) external view returns (address);

    /// @notice Whether a project was launched as a FUND through this deployer. INCOME only attaches to these.
    /// @custom:param projectId The ID of the project.
    function isFund(uint256 projectId) external view returns (bool);

    /// @notice The USDC token on a linked chain.
    /// @custom:param chainId The ID of the chain.
    function usdcOf(uint32 chainId) external view returns (address);

    /// @notice Launches a closed FUND's INCOME revnet, mints this chain's share of the initial allocation and funds
    /// its claim vault, all in one transaction.
    /// @dev Only the FUND's owner can call this, and only once per FUND. The snapshot root is the owner's attestation;
    /// its completeness is not proven onchain.
    /// @param fundProjectId The ID of the FUND project.
    /// @param snapshot The global initial allocation snapshot, identical on every chain.
    /// @param description The INCOME name, ticker, metadata URI and launch salt.
    /// @param reservedBps The share of new INCOME reserved for the owner's split, out of
    /// `JBConstants.MAX_RESERVED_PERCENT`.
    /// @param startsAtOrAfter The shared start of the INCOME issuance schedule. Must not be in the future.
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
        returns (uint256 incomeProjectId);

    /// @notice Launches a FUND with Homerun's fixed campaign rules and deploys its ERC-20.
    /// @dev Linked launches must use the same `salt` and the same caller on every chain.
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
        string calldata name,
        string calldata ticker,
        uint48 mustStartAtOrAfter,
        bytes32 salt,
        address[] calldata peerSuckerDeployers
    )
        external
        payable
        returns (uint256 projectId, address token);
}
