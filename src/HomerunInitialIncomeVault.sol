// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice Holds the initial INCOME allocation for perpetual, permissionless claims to snapshot beneficiaries.
/// @dev The factory must verify the canonical INCOME token and fund this chain's allocation atomically with launch.
/// The global allocation is shared across chain-local vaults; this contract enforces only its immutable local cap.
/// The source-set commitment and public manifest must reconcile the global supply and allocations. The immutable
/// root is an operator-attested snapshot, not an onchain proof of FUND balances, completeness, or allocation sums.
/// A malformed or oversubscribed root can strand allocations or exhaust the cap before other holders claim. The
/// public manifest must be independently reconciled before launch. There is no administrator, sweep, or root update.
contract HomerunInitialIncomeVault is ReentrancyGuard {
    using SafeERC20 for IERC20;

    error InvalidConfiguration();
    error InvalidClaim();
    error InvalidProof();
    error AlreadyClaimed();
    error AllocationExceeded();

    event Claimed(
        uint256 indexed index, address indexed beneficiary, uint256 fundBalance, uint256 incomeAmount, address caller
    );

    uint256 public constant INITIAL_INCOME_SUPPLY = 500_000 ether;
    uint256 public constant MAX_PROOF_LENGTH = 160;
    bytes32 public constant DISTRIBUTION_TYPEHASH = keccak256(
        "HomerunInitialIncome(uint256 chainId,address deployer,uint256 fundProjectId,bytes32 sourceSetHash,uint256 totalFundSupply,bytes32 salt)"
    );

    IERC20 public immutable INCOME_TOKEN;
    uint256 public immutable INCOME_PROJECT_ID;
    uint256 public immutable FUND_PROJECT_ID;
    address public immutable FACTORY;
    uint256 public immutable SNAPSHOT_BLOCK_NUMBER;
    bytes32 public immutable SNAPSHOT_BLOCK_HASH;
    uint256 public immutable TOTAL_FUND_SUPPLY;
    bytes32 public immutable SOURCE_SET_HASH;
    uint256 public immutable LOCAL_INITIAL_INCOME_SUPPLY;
    bytes32 public immutable LAUNCH_SALT;
    bytes32 public immutable MERKLE_ROOT;
    uint256 public immutable LEAF_COUNT;
    bytes32 public immutable MANIFEST_HASH;
    bytes32 public immutable DISTRIBUTION_ID;

    /// @notice Content-addressed public snapshot data. Written only in the constructor.
    string public manifestUri;
    uint256 public totalClaimed;
    mapping(uint256 wordIndex => uint256 claimedWord) private _claimedBitMap;

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
        ) revert InvalidConfiguration();

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

    /// @notice Whether an allocation index has already been paid.
    function isClaimed(uint256 index) public view returns (bool) {
        uint256 mask = uint256(1) << (index & 255);
        return _claimedBitMap[index >> 8] & mask != 0;
    }

    /// @notice Standard double-hashed leaf used with OpenZeppelin's sorted-pair MerkleProof implementation.
    function leafHash(
        uint256 index,
        address beneficiary,
        uint256 fundBalance,
        uint256 incomeAmount
    )
        public
        view
        returns (bytes32)
    {
        return
            keccak256(
                bytes.concat(keccak256(abi.encode(DISTRIBUTION_ID, index, beneficiary, fundBalance, incomeAmount)))
            );
    }

    /// @notice Anyone may pay the gas, but tokens always go to the beneficiary committed in the snapshot leaf.
    /// @dev Current FUND balances and delegation are irrelevant. Zero-address and zero-amount allocations can remain
    /// in the published snapshot for reconciliation but cannot be claimed. Claims have no deadline or vesting period.
    /// Fractional beneficial FUND ownership may have a zero integer display balance and a positive INCOME allocation.
    function claim(
        uint256 index,
        address beneficiary,
        uint256 fundBalance,
        uint256 incomeAmount,
        bytes32[] calldata proof
    )
        external
        nonReentrant
    {
        if (
            index >= LEAF_COUNT || proof.length > MAX_PROOF_LENGTH || beneficiary == address(0)
                || beneficiary == address(this) || fundBalance > TOTAL_FUND_SUPPLY || incomeAmount == 0
        ) revert InvalidClaim();
        if (isClaimed(index)) revert AlreadyClaimed();
        if (!MerkleProof.verifyCalldata(proof, MERKLE_ROOT, leafHash(index, beneficiary, fundBalance, incomeAmount))) {
            revert InvalidProof();
        }
        // Subtraction bounds the addition without allowing a malicious amount to overflow.
        if (incomeAmount > LOCAL_INITIAL_INCOME_SUPPLY - totalClaimed) revert AllocationExceeded();

        _claimedBitMap[index >> 8] |= uint256(1) << (index & 255);
        totalClaimed += incomeAmount;
        INCOME_TOKEN.safeTransfer(beneficiary, incomeAmount);
        emit Claimed(index, beneficiary, fundBalance, incomeAmount, msg.sender);
    }
}
