// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import {IJBController} from "@bananapus/core-v6/src/interfaces/IJBController.sol";
import {IJBPayerTracker} from "@bananapus/core-v6/src/interfaces/IJBPayerTracker.sol";
import {IJBProjects} from "@bananapus/core-v6/src/interfaces/IJBProjects.sol";
import {IJBTerminal} from "@bananapus/core-v6/src/interfaces/IJBTerminal.sol";
import {IJBTokens} from "@bananapus/core-v6/src/interfaces/IJBTokens.sol";
import {IJBOmnichainDeployer} from "@bananapus/omnichain-deployers-v6/src/interfaces/IJBOmnichainDeployer.sol";
import {IREVDeployer} from "@rev-net/core-v6/src/interfaces/IREVDeployer.sol";
import {IREVOwner} from "@rev-net/core-v6/src/interfaces/IREVOwner.sol";
import {REVDescription} from "@rev-net/core-v6/src/structs/REVDescription.sol";
import {REVSuckerDeploymentConfig} from "@rev-net/core-v6/src/structs/REVSuckerDeploymentConfig.sol";

import {IHomerunAllowlistHook} from "./IHomerunAllowlistHook.sol";
import {HomerunChainConfig} from "../structs/HomerunChainConfig.sol";
import {HomerunInitialIncomeSnapshot} from "../structs/HomerunInitialIncomeSnapshot.sol";

/// @notice Launches Homerun FUNDs with fixed campaign rules, and launches each FUND's INCOME revnet with the initial
/// INCOME allocation recorded for the FUND's owner.
interface IHomerunDeployer is IJBPayerTracker {
    /// @notice Emitted when a FUND is launched.
    /// @param projectId The ID of the new FUND project.
    /// @param owner The address that owns the FUND.
    /// @param caller The address that launched it.
    event FundLaunched(uint256 indexed projectId, address indexed owner, address caller);

    /// @notice Emitted when a FUND's INCOME is deployed with its initial allocation recorded for the owner.
    /// @param fundProjectId The ID of the FUND project.
    /// @param incomeProjectId The ID of the new INCOME project.
    /// @param owner The FUND owner, who becomes the INCOME revnet's operator and holds its reserved split.
    event IncomeDeployed(uint256 indexed fundProjectId, uint256 indexed incomeProjectId, address indexed owner);

    /// @notice Emitted when a FUND's initial INCOME allocation is minted to the FUND's owner.
    /// @param fundProjectId The ID of the FUND project.
    /// @param incomeProjectId The ID of the INCOME project.
    /// @param owner The FUND owner that received the allocation.
    /// @param incomeAmount The INCOME minted.
    /// @param caller The address that triggered the mint.
    event InitialAllocationMinted(
        uint256 indexed fundProjectId,
        uint256 indexed incomeProjectId,
        address indexed owner,
        uint256 incomeAmount,
        address caller
    );

    /// @notice The pay hook installed on every FUND. Its owner-managed allowlist gates payment beneficiaries.
    /// @return hook The allowlist hook.
    function ALLOWLIST_HOOK() external view returns (IHomerunAllowlistHook hook);

    /// @notice The controller every FUND and INCOME is launched with.
    /// @return controller The controller.
    function CONTROLLER() external view returns (IJBController controller);

    /// @notice The cash out tax rate a FUND launches with, out of `JBConstants.MAX_CASH_OUT_TAX_RATE`.
    /// @return rate The tax rate.
    function FUND_CASH_OUT_TAX_RATE() external view returns (uint16 rate);

    /// @notice The CCIP gas allowance every FUND sucker mapping uses.
    /// @return minGas The gas allowance.
    function FUND_SUCKER_MIN_GAS() external view returns (uint32 minGas);

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

    /// @notice The omnichain deployer every FUND is launched through.
    /// @return deployer The omnichain deployer.
    function OMNICHAIN_DEPLOYER() external view returns (IJBOmnichainDeployer deployer);

    /// @notice The project registry.
    /// @return projects The project registry.
    function PROJECTS() external view returns (IJBProjects projects);

    /// @notice The number of seconds in one INCOME issuance cycle.
    /// @return cycleLength The cycle length, in seconds.
    function QUARTER() external view returns (uint32 cycleLength);

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

    /// @notice The terminal every FUND and INCOME treasury lives in.
    /// @return terminal The terminal.
    function TERMINAL() external view returns (IJBTerminal terminal);

    /// @notice The token registry.
    /// @return tokens The token registry.
    function TOKENS() external view returns (IJBTokens tokens);

    /// @notice The USDC token every FUND and INCOME treasury accounts in on this chain.
    /// @dev Zero until the chain-specific constants are set.
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

    /// @notice The INCOME project a FUND launched, if any.
    /// @param fundProjectId The ID of the FUND project.
    /// @return incomeProjectId The ID of the INCOME project, or zero if none.
    function incomeProjectIdOf(uint256 fundProjectId) external view returns (uint256 incomeProjectId);

    /// @notice Whether a project was launched as a FUND through the deployer. INCOME only attaches to these.
    /// @param projectId The ID of the project.
    /// @return flag Whether the project is a FUND.
    function isFund(uint256 projectId) external view returns (bool flag);

    /// @notice The USDC token on a linked chain, including this one.
    /// @param chainId The ID of the chain.
    /// @return usdc The chain's USDC token.
    function usdcOf(uint32 chainId) external view returns (address usdc);

    /// @notice Launches a FUND's INCOME revnet, with this chain's share of the initial allocation recorded as an
    /// auto-issuance to the deployer for `mintInitialAllocation` to pay to the FUND's owner.
    /// @dev Only the FUND's owner can call this, and only once per FUND. The snapshot is the owner's attestation; its
    /// completeness is not proven onchain.
    /// @param fundProjectId The ID of the FUND project.
    /// @param snapshot The global initial allocation snapshot, identical on every chain.
    /// @param description The INCOME name, ticker, metadata URI and launch salt.
    /// @param reservedBps The share of new INCOME reserved for the owner's split, out of
    /// `JBConstants.MAX_RESERVED_PERCENT`.
    /// @param startsAtOrAfter The shared start of the INCOME issuance schedule on every chain.
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
    /// @dev Linked launches must use the same caller, owner, `salt`, `projectUri`, `name`, `ticker` and
    /// `mustStartAtOrAfter` on every chain. The sucker and token salts commit to all of them.
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

    /// @notice Mints a FUND's initial INCOME allocation to whoever owns the FUND right now.
    /// @dev Anyone can call this once INCOME's stage has started, and it pays out once per FUND.
    /// @param fundProjectId The ID of the FUND project.
    function mintInitialAllocation(uint256 fundProjectId) external;

    /// @notice One-shot setter for the USDC token on every linked chain, this one included.
    /// @dev Only the binding deployer can call this, once.
    /// @param chains One entry per linked chain, in ascending chain ID, including this chain.
    function setChainSpecificConstants(HomerunChainConfig[] calldata chains) external;
}
