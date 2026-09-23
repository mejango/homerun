// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import {IJBPermissioned} from "@bananapus/core-v6/src/interfaces/IJBPermissioned.sol";
import {IJBProjects} from "@bananapus/core-v6/src/interfaces/IJBProjects.sol";
import {IJBRulesetDataHook} from "@bananapus/core-v6/src/interfaces/IJBRulesetDataHook.sol";

/// @notice A pay hook that accepts FUND payments only for beneficiaries a project's owner has allowed, or for anyone
/// once the owner opens the project.
/// @dev The owner can delegate list management by granting `SET_ALLOWLIST_PERMISSION_ID` (or ROOT) in `PERMISSIONS`.
interface IHomerunAllowlistHook is IJBPermissioned, IJBRulesetDataHook {
    /// @notice Emitted when an owner or their operator allows or disallows a beneficiary.
    /// @param projectId The ID of the project the change applies to.
    /// @param account The beneficiary whose status changed.
    /// @param allowed Whether the beneficiary may now receive tokens from payments.
    /// @param caller The address that made the change.
    event AllowedSet(uint256 indexed projectId, address indexed account, bool allowed, address caller);

    /// @notice Emitted when an owner or their operator opens or closes a project to every beneficiary.
    /// @param projectId The ID of the project the change applies to.
    /// @param open Whether any beneficiary may now receive tokens from payments.
    /// @param caller The address that made the change.
    event OpenSet(uint256 indexed projectId, bool open, address caller);

    /// @notice The `JBPermissions` ID a project's owner grants to let an operator call `setAllowed` and `setOpen`.
    /// @dev 128 sits well above the ecosystem registry in `JBPermissionIds`, and no other Juicebox V6 contract checks
    /// it.
    /// @return permissionId The permission ID.
    function SET_ALLOWLIST_PERMISSION_ID() external view returns (uint8 permissionId);

    /// @notice The project registry whose owners manage each project's list.
    /// @return projects The project registry.
    function PROJECTS() external view returns (IJBProjects projects);

    /// @notice Whether the project's allowlist admits a beneficiary: the project is open, or the beneficiary is
    /// allowed.
    /// @dev Reports the allowlist only, not whether the project's current ruleset still routes payments through this
    /// hook.
    /// @param projectId The ID of the project being paid.
    /// @param account The beneficiary of the payment.
    /// @return flag Whether the allowlist admits the beneficiary.
    function canPay(uint256 projectId, address account) external view returns (bool flag);

    /// @notice Whether a beneficiary may receive tokens from payments to a project while it is not open.
    /// @custom:param projectId The ID of the project.
    /// @custom:param account The beneficiary.
    function isAllowed(uint256 projectId, address account) external view returns (bool);

    /// @notice Whether a project accepts payments for any beneficiary.
    /// @custom:param projectId The ID of the project.
    function isOpen(uint256 projectId) external view returns (bool);

    /// @notice Allows or disallows beneficiaries for a project.
    /// @dev Only the project's owner, or an operator holding `SET_ALLOWLIST_PERMISSION_ID` or ROOT from the owner,
    /// can call this.
    /// @param projectId The ID of the project.
    /// @param accounts The beneficiaries to change.
    /// @param allowed Whether the beneficiaries may receive tokens from payments.
    function setAllowed(uint256 projectId, address[] calldata accounts, bool allowed) external;

    /// @notice Opens or closes a project to every beneficiary.
    /// @dev Only the project's owner, or an operator holding `SET_ALLOWLIST_PERMISSION_ID` or ROOT from the owner,
    /// can call this.
    /// @param projectId The ID of the project.
    /// @param open Whether any beneficiary may receive tokens from payments.
    function setOpen(uint256 projectId, bool open) external;
}
