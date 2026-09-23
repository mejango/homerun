// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IJBProjects} from "@bananapus/core-v6/src/interfaces/IJBProjects.sol";
import {IJBRulesetDataHook} from "@bananapus/core-v6/src/interfaces/IJBRulesetDataHook.sol";
import {JBBeforeCashOutRecordedContext} from "@bananapus/core-v6/src/structs/JBBeforeCashOutRecordedContext.sol";
import {JBBeforePayRecordedContext} from "@bananapus/core-v6/src/structs/JBBeforePayRecordedContext.sol";
import {JBCashOutHookSpecification} from "@bananapus/core-v6/src/structs/JBCashOutHookSpecification.sol";
import {JBPayHookSpecification} from "@bananapus/core-v6/src/structs/JBPayHookSpecification.sol";
import {JBRuleset} from "@bananapus/core-v6/src/structs/JBRuleset.sol";
import {ERC2771Context} from "@openzeppelin/contracts/metatx/ERC2771Context.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";

import {IHomerunAllowlistHook} from "./interfaces/IHomerunAllowlistHook.sol";

/// @notice A pay hook that accepts FUND payments only for beneficiaries a project's owner has allowed, or for anyone
/// once the owner opens the project.
/// @dev One deployment serves every FUND; `HomerunDeployer` installs it as each FUND's extra pay hook. It gates the
/// beneficiary rather than the payer, since swap-routed payments arrive from the router. It gates payments only: FUND
/// is a transferable ERC-20, and a linked FUND's suckers mint bridged FUND to whoever the sender named. A new FUND
/// starts closed with an empty list. Cash outs are never gated.
contract HomerunAllowlistHook is ERC2771Context, IHomerunAllowlistHook {
    //*********************************************************************//
    // --------------------------- custom errors ------------------------- //
    //*********************************************************************//

    /// @notice Thrown when a payment names a beneficiary the project's owner has not allowed while the project is
    /// closed, so the payment is refused rather than minting FUND to them.
    error HomerunAllowlistHook_NotAllowed(uint256 projectId, address beneficiary);

    /// @notice Thrown when someone other than the project's owner tries to change its list.
    error HomerunAllowlistHook_Unauthorized(uint256 projectId, address caller);

    //*********************************************************************//
    // --------------- public immutable stored properties ---------------- //
    //*********************************************************************//

    /// @notice The project registry whose owners manage each project's list.
    IJBProjects public immutable override PROJECTS;

    //*********************************************************************//
    // --------------------- public stored properties -------------------- //
    //*********************************************************************//

    /// @notice Whether a beneficiary may receive tokens from payments to a project while it is not open.
    /// @custom:param projectId The ID of the project.
    /// @custom:param account The beneficiary.
    mapping(uint256 projectId => mapping(address account => bool)) public override isAllowed;

    /// @notice Whether a project accepts payments for any beneficiary.
    /// @custom:param projectId The ID of the project.
    mapping(uint256 projectId => bool) public override isOpen;

    //*********************************************************************//
    // -------------------------- constructor ---------------------------- //
    //*********************************************************************//

    /// @param projects The project registry whose owners manage each project's list.
    /// @param trustedForwarder The trusted forwarder for the ERC2771Context.
    constructor(IJBProjects projects, address trustedForwarder) ERC2771Context(trustedForwarder) {
        PROJECTS = projects;
    }

    //*********************************************************************//
    // ---------------------- external transactions ---------------------- //
    //*********************************************************************//

    /// @notice Allows or disallows beneficiaries for a project.
    /// @dev Only the project's owner can call this.
    /// @param projectId The ID of the project.
    /// @param accounts The beneficiaries to change.
    /// @param allowed Whether the beneficiaries may receive tokens from payments.
    function setAllowed(uint256 projectId, address[] calldata accounts, bool allowed) external override {
        // Enforce permissions.
        _requireOwner(projectId);

        for (uint256 i; i < accounts.length; i++) {
            // Set the beneficiary's status.
            isAllowed[projectId][accounts[i]] = allowed;

            emit AllowedSet({projectId: projectId, account: accounts[i], allowed: allowed, caller: _msgSender()});
        }
    }

    /// @notice Opens or closes a project to every beneficiary.
    /// @dev Only the project's owner can call this. Closing keeps the list, so allowed beneficiaries stay allowed.
    /// @param projectId The ID of the project.
    /// @param open Whether any beneficiary may receive tokens from payments.
    function setOpen(uint256 projectId, bool open) external override {
        // Enforce permissions.
        _requireOwner(projectId);

        // Set the project's status.
        isOpen[projectId] = open;

        emit OpenSet({projectId: projectId, open: open, caller: _msgSender()});
    }

    //*********************************************************************//
    // ------------------------- external views -------------------------- //
    //*********************************************************************//

    /// @notice Passes cash outs through untouched. Cash outs are never gated.
    /// @param context The cash out context passed to this hook by the terminal.
    /// @return cashOutTaxRate The ruleset's cash out tax rate, unchanged.
    /// @return cashOutCount The number of tokens being cashed out, unchanged.
    /// @return totalSupply The total supply the cash out is measured against, unchanged.
    /// @return surplusValue The surplus the cash out is measured against, unchanged.
    /// @return hookSpecifications No cash out hooks.
    function beforeCashOutRecordedWith(JBBeforeCashOutRecordedContext calldata context)
        external
        pure
        override
        returns (
            uint256 cashOutTaxRate,
            uint256 cashOutCount,
            uint256 totalSupply,
            uint256 surplusValue,
            JBCashOutHookSpecification[] memory hookSpecifications
        )
    {
        return (
            context.cashOutTaxRate, context.cashOutCount, context.totalSupply, context.surplus.value, hookSpecifications
        );
    }

    /// @notice Accepts a payment only if its beneficiary may receive the project's tokens.
    /// @dev Reverts for any beneficiary that is not allowed while the project is closed, so the terminal records
    /// nothing for it.
    /// @param context The payment context passed to this hook by the terminal.
    /// @return weight The ruleset's weight, unchanged.
    /// @return hookSpecifications No pay hooks.
    function beforePayRecordedWith(JBBeforePayRecordedContext calldata context)
        external
        view
        override
        returns (uint256 weight, JBPayHookSpecification[] memory hookSpecifications)
    {
        // Make sure the beneficiary may receive the project's tokens.
        if (!canPay({projectId: context.projectId, account: context.beneficiary})) {
            revert HomerunAllowlistHook_NotAllowed({projectId: context.projectId, beneficiary: context.beneficiary});
        }

        return (context.weight, hookSpecifications);
    }

    /// @notice This hook never grants mint permission.
    /// @return flag Always false.
    function hasMintPermissionFor(uint256, JBRuleset memory, address) external pure override returns (bool flag) {
        return false;
    }

    //*********************************************************************//
    // -------------------------- public views --------------------------- //
    //*********************************************************************//

    /// @notice Whether the project's allowlist admits a beneficiary: the project is open, or the beneficiary is
    /// allowed.
    /// @dev This reports the allowlist only. It does not check whether the project's current ruleset still routes
    /// payments through this hook, so a project that has moved off the hook may accept payments this returns false
    /// for.
    /// @param projectId The ID of the project being paid.
    /// @param account The beneficiary of the payment.
    /// @return flag Whether the allowlist admits the beneficiary.
    function canPay(uint256 projectId, address account) public view override returns (bool flag) {
        return isOpen[projectId] || isAllowed[projectId][account];
    }

    /// @notice Indicates whether this contract adheres to the specified interface.
    /// @dev See {IERC165-supportsInterface}.
    /// @param interfaceId The ID of the interface to check for adherence to.
    /// @return flag A flag indicating if the provided interface ID is supported.
    function supportsInterface(bytes4 interfaceId) public pure override returns (bool flag) {
        return interfaceId == type(IHomerunAllowlistHook).interfaceId
            || interfaceId == type(IJBRulesetDataHook).interfaceId || interfaceId == type(IERC165).interfaceId;
    }

    //*********************************************************************//
    // ------------------------ internal views --------------------------- //
    //*********************************************************************//

    /// @notice Reverts unless the caller owns the project.
    /// @param projectId The ID of the project.
    function _requireOwner(uint256 projectId) internal view {
        if (PROJECTS.ownerOf(projectId) != _msgSender()) {
            revert HomerunAllowlistHook_Unauthorized({projectId: projectId, caller: _msgSender()});
        }
    }
}
