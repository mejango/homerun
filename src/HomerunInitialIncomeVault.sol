// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IHomerunInitialIncomeVault} from "./interfaces/IHomerunInitialIncomeVault.sol";

/// @notice Holds one chain's share of a FUND's initial INCOME allocation for perpetual, permissionless claims by the
/// beneficiaries committed in the snapshot.
/// @dev The factory funds this chain's allocation atomically with the INCOME launch. The global allocation is shared
/// across chain-local vaults; this contract enforces only its immutable local cap. The root is an owner-attested
/// snapshot, not an onchain proof of FUND balances, completeness, or allocation sums: a malformed or oversubscribed
/// root can strand allocations or exhaust the cap before other holders claim. There is no administrator, sweep, or
/// root update.
contract HomerunInitialIncomeVault is ReentrancyGuard, IHomerunInitialIncomeVault {
    // A library that adds default safety checks to ERC20 transfers.
    using SafeERC20 for IERC20;

    //*********************************************************************//
    // --------------------------- custom errors ------------------------- //
    //*********************************************************************//

    error HomerunInitialIncomeVault_AllocationExceeded(uint256 incomeAmount, uint256 remaining);
    error HomerunInitialIncomeVault_AlreadyClaimed(uint256 index);
    error HomerunInitialIncomeVault_InvalidClaim();
    error HomerunInitialIncomeVault_InvalidConfiguration();
    error HomerunInitialIncomeVault_InvalidProof();

    //*********************************************************************//
    // ------------------------- public constants ------------------------ //
    //*********************************************************************//

    /// @notice The EIP-712-style type hash committed in every leaf's distribution ID.
    bytes32 public constant override DISTRIBUTION_TYPEHASH = keccak256(
        "HomerunInitialIncome(uint256 chainId,address deployer,uint256 fundProjectId,bytes32 sourceSetHash,uint256 totalFundSupply,bytes32 salt)"
    );

    /// @notice The global initial INCOME supply shared across every chain's vault.
    uint256 public constant override INITIAL_INCOME_SUPPLY = 500_000 ether;

    /// @notice The longest proof `claim` accepts.
    uint256 public constant override MAX_PROOF_LENGTH = 160;

    //*********************************************************************//
    // --------------- public immutable stored properties ---------------- //
    //*********************************************************************//

    /// @notice The domain every leaf is committed under: chain, factory, FUND, source set, supply and salt.
    bytes32 public immutable override DISTRIBUTION_ID;

    /// @notice The contract that deployed and funded this vault.
    address public immutable override FACTORY;

    /// @notice The ID of the FUND project whose holders this vault pays.
    uint256 public immutable override FUND_PROJECT_ID;

    /// @notice The ID of the INCOME project whose token this vault holds.
    uint256 public immutable override INCOME_PROJECT_ID;

    /// @notice The INCOME token this vault pays out.
    IERC20 public immutable override INCOME_TOKEN;

    /// @notice The salt the FUND owner launched INCOME with.
    bytes32 public immutable override LAUNCH_SALT;

    /// @notice The number of leaves under the root.
    uint256 public immutable override LEAF_COUNT;

    /// @notice The most INCOME this vault will ever pay out.
    uint256 public immutable override LOCAL_INITIAL_INCOME_SUPPLY;

    /// @notice The hash of the published manifest listing every holder and proof.
    bytes32 public immutable override MANIFEST_HASH;

    /// @notice The root of the leaves this vault pays.
    bytes32 public immutable override MERKLE_ROOT;

    /// @notice The hash of the block the FUND balances were read at.
    bytes32 public immutable override SNAPSHOT_BLOCK_HASH;

    /// @notice The block the FUND balances were read at, in this chain's own height.
    uint256 public immutable override SNAPSHOT_BLOCK_NUMBER;

    /// @notice The hash of the canonical global FUND ownership report the allocations derive from.
    bytes32 public immutable override SOURCE_SET_HASH;

    /// @notice The global FUND supply the allocations divide.
    uint256 public immutable override TOTAL_FUND_SUPPLY;

    //*********************************************************************//
    // --------------------- public stored properties -------------------- //
    //*********************************************************************//

    /// @notice The content-addressed URI of the published manifest.
    /// @dev Written only in the constructor.
    string public override manifestUri;

    /// @notice The INCOME paid out so far, as a fixed point number with 18 decimals.
    uint256 public override totalClaimed;

    //*********************************************************************//
    // -------------------- internal stored properties ------------------- //
    //*********************************************************************//

    /// @notice A bitmap of the leaves that have been claimed.
    /// @custom:param wordIndex The index of the 256-leaf word.
    mapping(uint256 wordIndex => uint256 claimedWord) internal _claimedBitMap;

    //*********************************************************************//
    // -------------------------- constructor ---------------------------- //
    //*********************************************************************//

    /// @param incomeToken The INCOME token this vault pays out.
    /// @param incomeProjectId The ID of the INCOME project whose token this vault holds.
    /// @param fundProjectId The ID of the FUND project whose holders this vault pays.
    /// @param snapshotBlockNumber The block the FUND balances were read at, in this chain's own height.
    /// @param snapshotBlockHash The hash of that block.
    /// @param totalFundSupply The global FUND supply the allocations divide.
    /// @param launchSalt The salt the FUND owner launched INCOME with.
    /// @param merkleRoot The root of the leaves this vault pays. Zero when there are no leaves.
    /// @param leafCount The number of leaves under the root.
    /// @param manifestHash The hash of the published manifest.
    /// @param manifestUri_ The content-addressed URI of the published manifest.
    /// @param sourceSetHash The hash of the canonical global FUND ownership report.
    /// @param localInitialIncomeSupply The most INCOME this vault will ever pay out.
    constructor(
        address incomeToken,
        uint256 incomeProjectId,
        uint256 fundProjectId,
        uint256 snapshotBlockNumber,
        bytes32 snapshotBlockHash,
        uint256 totalFundSupply,
        bytes32 launchSalt,
        bytes32 merkleRoot,
        uint256 leafCount,
        bytes32 manifestHash,
        string memory manifestUri_,
        bytes32 sourceSetHash,
        uint256 localInitialIncomeSupply
    ) {
        if (
            incomeToken.code.length == 0 || incomeProjectId == 0 || fundProjectId == 0
                || incomeProjectId == fundProjectId || snapshotBlockHash == bytes32(0) || totalFundSupply == 0
                || launchSalt == bytes32(0) || (merkleRoot == bytes32(0)) != (leafCount == 0)
                || (leafCount == 0 && localInitialIncomeSupply != 0) || leafCount > uint256(1) << 160
                || localInitialIncomeSupply > INITIAL_INCOME_SUPPLY || sourceSetHash == bytes32(0)
                || manifestHash == bytes32(0) || bytes(manifestUri_).length == 0
        ) revert HomerunInitialIncomeVault_InvalidConfiguration();

        INCOME_TOKEN = IERC20(incomeToken);
        INCOME_PROJECT_ID = incomeProjectId;
        FUND_PROJECT_ID = fundProjectId;
        FACTORY = msg.sender;
        SNAPSHOT_BLOCK_NUMBER = snapshotBlockNumber;
        SNAPSHOT_BLOCK_HASH = snapshotBlockHash;
        TOTAL_FUND_SUPPLY = totalFundSupply;
        SOURCE_SET_HASH = sourceSetHash;
        LOCAL_INITIAL_INCOME_SUPPLY = localInitialIncomeSupply;
        LAUNCH_SALT = launchSalt;
        MERKLE_ROOT = merkleRoot;
        LEAF_COUNT = leafCount;
        MANIFEST_HASH = manifestHash;
        manifestUri = manifestUri_;
        DISTRIBUTION_ID = keccak256(
            abi.encode(
                DISTRIBUTION_TYPEHASH,
                block.chainid,
                msg.sender,
                fundProjectId,
                sourceSetHash,
                totalFundSupply,
                launchSalt
            )
        );
    }

    //*********************************************************************//
    // ---------------------- external transactions ---------------------- //
    //*********************************************************************//

    /// @notice Pays an allocation to the beneficiary committed in its leaf.
    /// @dev Anyone may pay the gas, but tokens always go to the committed beneficiary. Current FUND balances and
    /// delegation are irrelevant. Zero-address and zero-amount leaves can remain in the published snapshot for
    /// reconciliation but cannot be claimed. Claims never expire and never vest.
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
        external
        override
        nonReentrant
    {
        if (
            index >= LEAF_COUNT || proof.length > MAX_PROOF_LENGTH || beneficiary == address(0)
                || beneficiary == address(this) || fundBalance > TOTAL_FUND_SUPPLY || incomeAmount == 0
        ) revert HomerunInitialIncomeVault_InvalidClaim();
        if (isClaimed(index)) revert HomerunInitialIncomeVault_AlreadyClaimed(index);
        if (!MerkleProof.verifyCalldata({
                proof: proof,
                root: MERKLE_ROOT,
                leaf: leafHash({
                    index: index, beneficiary: beneficiary, fundBalance: fundBalance, incomeAmount: incomeAmount
                })
            })) revert HomerunInitialIncomeVault_InvalidProof();

        // Subtracting first bounds the addition below without letting a malicious amount overflow.
        uint256 remaining = LOCAL_INITIAL_INCOME_SUPPLY - totalClaimed;
        if (incomeAmount > remaining) revert HomerunInitialIncomeVault_AllocationExceeded(incomeAmount, remaining);

        _claimedBitMap[index >> 8] |= uint256(1) << (index & 255);
        totalClaimed += incomeAmount;
        INCOME_TOKEN.safeTransfer({to: beneficiary, value: incomeAmount});

        emit Claimed({
            index: index,
            beneficiary: beneficiary,
            fundBalance: fundBalance,
            incomeAmount: incomeAmount,
            caller: msg.sender
        });
    }

    //*********************************************************************//
    // -------------------------- public views --------------------------- //
    //*********************************************************************//

    /// @notice Whether a leaf has already been paid.
    /// @param index The index of the leaf.
    /// @return flag Whether the leaf has been claimed.
    function isClaimed(uint256 index) public view override returns (bool flag) {
        uint256 mask = uint256(1) << (index & 255);
        return _claimedBitMap[index >> 8] & mask != 0;
    }

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
        public
        view
        override
        returns (bytes32 leaf)
    {
        return
            keccak256(
                bytes.concat(keccak256(abi.encode(DISTRIBUTION_ID, index, beneficiary, fundBalance, incomeAmount)))
            );
    }
}
