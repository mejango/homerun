// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Holds one chain's share of a FUND's initial INCOME allocation for perpetual, permissionless claims by the
/// beneficiaries committed in the snapshot.
interface IHomerunInitialIncomeVault {
    /// @notice Emitted when an allocation is paid out.
    /// @param index The index of the leaf that was claimed.
    /// @param beneficiary The address that received the INCOME.
    /// @param fundBalance The FUND balance the leaf was allocated for.
    /// @param incomeAmount The INCOME paid, as a fixed point number with 18 decimals.
    /// @param caller The address that submitted the claim.
    event Claimed(
        uint256 indexed index, address indexed beneficiary, uint256 fundBalance, uint256 incomeAmount, address caller
    );

    /// @notice The domain every leaf is committed under: chain, factory, FUND, source set, supply and salt.
    /// @return distributionId The distribution ID.
    function DISTRIBUTION_ID() external view returns (bytes32 distributionId);

    /// @notice The EIP-712-style type hash committed in every leaf's distribution ID.
    /// @return typehash The type hash.
    function DISTRIBUTION_TYPEHASH() external view returns (bytes32 typehash);

    /// @notice The contract that deployed and funded this vault.
    /// @return factory The factory.
    function FACTORY() external view returns (address factory);

    /// @notice The ID of the FUND project whose holders this vault pays.
    /// @return projectId The FUND project ID.
    function FUND_PROJECT_ID() external view returns (uint256 projectId);

    /// @notice The ID of the INCOME project whose token this vault holds.
    /// @return projectId The INCOME project ID.
    function INCOME_PROJECT_ID() external view returns (uint256 projectId);

    /// @notice The INCOME token this vault pays out.
    /// @return token The INCOME token.
    function INCOME_TOKEN() external view returns (IERC20 token);

    /// @notice The global initial INCOME supply shared across every chain's vault.
    /// @return supply The global supply, as a fixed point number with 18 decimals.
    function INITIAL_INCOME_SUPPLY() external view returns (uint256 supply);

    /// @notice The salt the FUND owner launched INCOME with.
    /// @return salt The launch salt.
    function LAUNCH_SALT() external view returns (bytes32 salt);

    /// @notice The number of leaves under the root.
    /// @return count The leaf count.
    function LEAF_COUNT() external view returns (uint256 count);

    /// @notice The most INCOME this vault will ever pay out.
    /// @return supply The local cap, as a fixed point number with 18 decimals.
    function LOCAL_INITIAL_INCOME_SUPPLY() external view returns (uint256 supply);

    /// @notice The hash of the published manifest listing every holder and proof.
    /// @return hash The manifest hash.
    function MANIFEST_HASH() external view returns (bytes32 hash);

    /// @notice The longest proof `claim` accepts.
    /// @return length The maximum number of proof elements.
    function MAX_PROOF_LENGTH() external view returns (uint256 length);

    /// @notice The root of the leaves this vault pays.
    /// @return root The Merkle root.
    function MERKLE_ROOT() external view returns (bytes32 root);

    /// @notice The hash of the block the FUND balances were read at.
    /// @return hash The snapshot block hash.
    function SNAPSHOT_BLOCK_HASH() external view returns (bytes32 hash);

    /// @notice The block the FUND balances were read at, in this chain's own height.
    /// @return blockNumber The snapshot block number.
    function SNAPSHOT_BLOCK_NUMBER() external view returns (uint256 blockNumber);

    /// @notice The hash of the canonical global FUND ownership report the allocations derive from.
    /// @return hash The source set hash.
    function SOURCE_SET_HASH() external view returns (bytes32 hash);

    /// @notice The global FUND supply the allocations divide.
    /// @return supply The FUND supply, as a fixed point number with 18 decimals.
    function TOTAL_FUND_SUPPLY() external view returns (uint256 supply);

    /// @notice Whether a leaf has already been paid.
    /// @param index The index of the leaf.
    /// @return flag Whether the leaf has been claimed.
    function isClaimed(uint256 index) external view returns (bool flag);

    /// @notice The leaf hash for an allocation, double hashed for OpenZeppelin's sorted-pair `MerkleProof`.
    /// @param index The index of the leaf.
    /// @param beneficiary The address the allocation pays.
    /// @param fundBalance The FUND balance the allocation is for.
    /// @param incomeAmount The INCOME the allocation pays, as a fixed point number with 18 decimals.
    /// @return leaf The leaf hash.
    function leafHash(
        uint256 index,
        address beneficiary,
        uint256 fundBalance,
        uint256 incomeAmount
    )
        external
        view
        returns (bytes32 leaf);

    /// @notice The content-addressed URI of the published manifest.
    /// @return uri The manifest URI.
    function manifestUri() external view returns (string memory uri);

    /// @notice The INCOME paid out so far, as a fixed point number with 18 decimals.
    /// @return claimed The total claimed.
    function totalClaimed() external view returns (uint256 claimed);

    /// @notice Pays an allocation to the beneficiary committed in its leaf.
    /// @dev Anyone may pay the gas. Claims never expire and never vest.
    /// @param index The index of the leaf.
    /// @param beneficiary The address the allocation pays.
    /// @param fundBalance The FUND balance the allocation is for.
    /// @param incomeAmount The INCOME the allocation pays, as a fixed point number with 18 decimals.
    /// @param proof The Merkle proof for the leaf.
    function claim(
        uint256 index,
        address beneficiary,
        uint256 fundBalance,
        uint256 incomeAmount,
        bytes32[] calldata proof
    )
        external;
}
