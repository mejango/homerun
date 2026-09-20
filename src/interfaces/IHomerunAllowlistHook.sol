// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import {IJBProjects} from "@bananapus/core-v6/src/interfaces/IJBProjects.sol";
import {IJBRulesetDataHook} from "@bananapus/core-v6/src/interfaces/IJBRulesetDataHook.sol";

/// @notice A pay hook that accepts FUND payments only for beneficiaries a project's owner has allowed, or for anyone
/// once the owner opens the project.
interface IHomerunAllowlistHook is IJBRulesetDataHook {
    /// @notice Emitted when an owner allows or disallows a beneficiary.
    /// @param projectId The ID of the project the change applies to.
    /// @param account The beneficiary whose status changed.
    /// @param allowed Whether the beneficiary may now receive tokens from payments.
    /// @param caller The address that made the change.
    event AllowedSet(uint256 indexed projectId, address indexed account, bool allowed, address caller);

    /// @notice Emitted when an owner opens or closes a project to every beneficiary.
    /// @param projectId The ID of the project the change applies to.
    /// @param open Whether any beneficiary may now receive tokens from payments.
    /// @param caller The address that made the change.
    event OpenSet(uint256 indexed projectId, bool open, address caller);

    /// @notice The project registry whose owners manage each project's list.
    /// @return projects The project registry.
    function PROJECTS() external view returns (IJBProjects projects);

    /// @notice Whether a payment for a beneficiary would be accepted right now.
    /// @param projectId The ID of the project being paid.
    /// @param account The beneficiary of the payment.
    /// @return flag Whether the payment would be accepted.
    function canPay(uint256 projectId, address account) external view returns (bool flag);

    /// @notice Whether a beneficiary may receive tokens from payments to a project while it is not open.
    /// @custom:param projectId The ID of the project.
    /// @custom:param account The beneficiary.
    function isAllowed(uint256 projectId, address account) external view returns (bool);

    /// @notice Whether a project accepts payments for any beneficiary.
    /// @custom:param projectId The ID of the project.
    function isOpen(uint256 projectId) external view returns (bool);

    /// @notice Allows or disallows beneficiaries for a project.
    /// @dev Only the project's owner can call this.
    /// @param projectId The ID of the project.
    /// @param accounts The beneficiaries to change.
    /// @param allowed Whether the beneficiaries may receive tokens from payments.
    function setAllowed(uint256 projectId, address[] calldata accounts, bool allowed) external;

    /// @notice Opens or closes a project to every beneficiary.
    /// @dev Only the project's owner can call this.
    /// @param projectId The ID of the project.
    /// @param open Whether any beneficiary may receive tokens from payments.
    function setOpen(uint256 projectId, bool open) external;
}
