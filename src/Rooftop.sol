// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice UNAUDITED reference escrow and cash-out vault for one property financing series.
/// @dev This is an economic prototype, not a deployed Juicebox integration or a property title registry.
/// Receipts are whole, nontransferable units (zero decimals). Prices are settlement-token base units per receipt.
/// At closing, one fixed supply is minted to this vault for subscribers to claim. Only cash outs burn receipts.
/// A burn permanently extinguishes every future right of that unit, including any unrecovered principal/return.
/// The settlement asset MUST be a standard, non-rebasing ERC20. Exact transfer checks reject transfer fees;
/// they cannot protect against a malicious issuer, asset freezes, depegging, or later token implementation changes.
/// Rent is deposited AFTER expenses/reserves in a separate operating account. There is no backing-withdrawal role.
/// Legal/title release requires independent enforcement of documents; on-chain eligibility is only evidence.
contract Rooftop is ERC20, ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum Phase {
        Fundraising,
        Active,
        Cancelled
    }

    error InvalidConfiguration();
    error Unauthorized();
    error WrongPhase();
    error DeadlinePassed();
    error RefundUnavailable();
    error InvalidAmount();
    error RaiseIncomplete();
    error RaiseExceeded();
    error NoSubscription();
    error UnsupportedAssetTransfer();
    error ZeroCashOut();
    error Slippage(uint256 received, uint256 minimum);
    error Nontransferable();

    event Subscribed(address indexed investor, uint256 units, uint256 assets);
    event Closed(bytes32 indexed evidenceHash, uint256 units, uint256 assetsReleased);
    event Cancelled();
    event Refunded(address indexed investor, uint256 units, uint256 assets);
    event TokensClaimed(address indexed investor, uint256 units);
    event BackingFunded(address indexed contributor, uint256 retained, uint256 returned);
    event CashedOut(address indexed investor, uint256 units, uint256 assets, uint256 targetForgone);
    event TargetFullyFunded(uint256 remainingUnits, uint256 backingAssets);
    event AllClaimsExtinguished();

    IERC20 public immutable ASSET;
    address public immutable CLOSING_ATTESTOR;
    address public immutable PROCEEDS_RECIPIENT;
    bytes32 public immutable AGREEMENT_HASH;
    uint256 public immutable ISSUE_PRICE;
    uint256 public immutable TARGET_PRICE;
    uint256 public immutable RAISE_UNITS;
    uint256 public immutable FUNDING_DEADLINE;

    Phase public phase;
    uint256 public subscribedUnits;
    mapping(address investor => uint256 units) public subscriptionOf;
    bytes32 public closingEvidenceHash;

    /// @notice Historical signal that all then-outstanding units had their full target reserved.
    /// @dev Never use this alone as proof that an investor who exited early received their target.
    bool public targetWasFullyFunded;
    bool public allClaimsExtinguished;

    constructor(
        IERC20 asset,
        address closingAttestor,
        address proceedsRecipient,
        bytes32 agreementHash,
        uint256 issuePrice,
        uint256 targetPrice,
        uint256 raiseUnits,
        uint256 fundingDeadline,
        string memory name,
        string memory symbol
    )
        ERC20(name, symbol)
    {
        if (
            address(asset).code.length == 0 || closingAttestor == address(0) || proceedsRecipient == address(0)
                || proceedsRecipient == address(this) || agreementHash == bytes32(0) || issuePrice == 0
                || targetPrice < issuePrice || raiseUnits == 0 || raiseUnits > type(uint256).max / targetPrice
                || fundingDeadline <= block.timestamp
        ) revert InvalidConfiguration();

        ASSET = asset;
        CLOSING_ATTESTOR = closingAttestor;
        PROCEEDS_RECIPIENT = proceedsRecipient;
        AGREEMENT_HASH = agreementHash;
        ISSUE_PRICE = issuePrice;
        TARGET_PRICE = targetPrice;
        RAISE_UNITS = raiseUnits;
        FUNDING_DEADLINE = fundingDeadline;
    }

    function decimals() public pure override returns (uint8) {
        return 0;
    }

    /// @notice Receipts deliberately cannot be transferred in this first reference implementation.
    function transfer(address, uint256) public pure override returns (bool) {
        revert Nontransferable();
    }

    function transferFrom(address, address, uint256) public pure override returns (bool) {
        revert Nontransferable();
    }

    function approve(address, uint256) public pure override returns (bool) {
        revert Nontransferable();
    }

    /// @notice Escrow funds for whole receipt units. No tokens exist until verified closing.
    function subscribe(uint256 units) external nonReentrant {
        if (phase != Phase.Fundraising) revert WrongPhase();
        if (block.timestamp >= FUNDING_DEADLINE) revert DeadlinePassed();
        if (units == 0) revert InvalidAmount();
        if (units > RAISE_UNITS - subscribedUnits) revert RaiseExceeded();

        uint256 amount = units * ISSUE_PRICE;
        subscriptionOf[msg.sender] += units;
        subscribedUnits += units;
        _receiveExact(msg.sender, amount);
        emit Subscribed(msg.sender, units, amount);
    }

    /// @notice The immutable attestor confirms the off-chain closing and releases the fixed raise.
    /// @dev The evidence hash records an assertion, not cryptographic verification of property title or lien priority.
    /// PROCEEDS_RECIPIENT should be a contracted closing escrow, which handles payoff and initial reserves.
    function close(bytes32 evidenceHash) external nonReentrant {
        if (msg.sender != CLOSING_ATTESTOR) revert Unauthorized();
        if (phase != Phase.Fundraising) revert WrongPhase();
        if (block.timestamp >= FUNDING_DEADLINE) revert DeadlinePassed();
        if (subscribedUnits != RAISE_UNITS) revert RaiseIncomplete();
        if (evidenceHash == bytes32(0)) revert InvalidConfiguration();

        phase = Phase.Active;
        closingEvidenceHash = evidenceHash;
        _mint(address(this), RAISE_UNITS);
        uint256 amount = RAISE_UNITS * ISSUE_PRICE;
        _sendExact(PROCEEDS_RECIPIENT, amount);
        emit Closed(evidenceHash, RAISE_UNITS, amount);
        _syncFundingStatus();
    }

    function cancel() external nonReentrant {
        if (msg.sender != CLOSING_ATTESTOR) revert Unauthorized();
        if (phase != Phase.Fundraising) revert WrongPhase();
        phase = Phase.Cancelled;
        emit Cancelled();
    }

    /// @notice Each subscriber can recover their entire subscription if closing fails or expires.
    function refund() external nonReentrant returns (uint256 amount) {
        if (phase == Phase.Active) revert RefundUnavailable();
        if (phase == Phase.Fundraising) {
            if (block.timestamp < FUNDING_DEADLINE) revert RefundUnavailable();
            phase = Phase.Cancelled;
            emit Cancelled();
        }

        uint256 units = subscriptionOf[msg.sender];
        if (units == 0) revert NoSubscription();
        subscriptionOf[msg.sender] = 0;
        subscribedUnits -= units;
        amount = units * ISSUE_PRICE;
        _sendExact(msg.sender, amount);
        emit Refunded(msg.sender, units, amount);
    }

    /// @notice Take possession of pre-minted receipts. Passive subscribers remain in the pricing denominator.
    function claimTokens() external nonReentrant returns (uint256 units) {
        if (phase != Phase.Active) revert WrongPhase();
        units = subscriptionOf[msg.sender];
        if (units == 0) revert NoSubscription();
        subscriptionOf[msg.sender] = 0;
        _transfer(address(this), msg.sender, units);
        emit TokensClaimed(msg.sender, units);
    }

    function backingAssets() public view returns (uint256) {
        return ASSET.balanceOf(address(this));
    }

    function targetLiability() public view returns (uint256) {
        return totalSupply() * TARGET_PRICE;
    }

    function backingGap() public view returns (uint256) {
        uint256 liability = targetLiability();
        uint256 assets = backingAssets();
        return liability > assets ? liability - assets : 0;
    }

    /// @notice True when remaining claims have full cash backing, or every claim has been voluntarily extinguished.
    /// @dev The second case can include discounted exits. Neither case transfers title or proves historical returns.
    function releaseEligible() public view returns (bool) {
        return phase == Phase.Active && backingAssets() >= targetLiability();
    }

    /// @notice Add net operating cash or owner payoff funds without minting tokens.
    /// @dev Only the excess from THIS deposit is returned to its sender. Existing backing is never swept.
    /// Direct ERC20 transfers are recognized as backing but cannot be refunded, including accidental excess.
    function fundBacking(uint256 amount) external nonReentrant returns (uint256 retained, uint256 returned) {
        if (phase != Phase.Active) revert WrongPhase();
        if (amount == 0) revert InvalidAmount();
        retained = Math.min(amount, backingGap());
        returned = amount - retained;
        _receiveExact(msg.sender, amount);
        if (returned != 0) _sendExact(msg.sender, returned);
        emit BackingFunded(msg.sender, retained, returned);
        _syncFundingStatus();
    }

    /// @notice Settlement-token base units claimable for a burn of `units` whole receipts, before execution.
    /// @dev min(floor(actual liquid balance * units / outstanding supply), target price * units).
    /// There is no cash-out tax, redemption fee, property valuation credit, or claim on burned receipts.
    function cashOutValue(uint256 units) public view returns (uint256) {
        uint256 supply = totalSupply();
        if (units > supply) revert InvalidAmount();
        if (units == 0) return 0;
        return Math.min(Math.mulDiv(backingAssets(), units, supply), units * TARGET_PRICE);
    }

    function cashOut(uint256 units, uint256 minAssets) external nonReentrant returns (uint256 amount) {
        if (phase != Phase.Active) revert WrongPhase();
        amount = cashOutValue(units);
        if (amount == 0) revert ZeroCashOut();
        if (amount < minAssets) revert Slippage(amount, minAssets);
        _syncFundingStatus();
        _burn(msg.sender, units);
        _sendExact(msg.sender, amount);
        emit CashedOut(msg.sender, units, amount, units * TARGET_PRICE - amount);
        _syncFundingStatus();
    }

    /// @notice Record status after a direct token transfer. Anyone may publish this evidence.
    function syncFundingStatus() external nonReentrant {
        if (phase != Phase.Active) revert WrongPhase();
        _syncFundingStatus();
    }

    function _syncFundingStatus() internal {
        uint256 supply = totalSupply();
        if (supply == 0) {
            if (!allClaimsExtinguished) {
                allClaimsExtinguished = true;
                emit AllClaimsExtinguished();
            }
        } else if (!targetWasFullyFunded && backingAssets() >= supply * TARGET_PRICE) {
            targetWasFullyFunded = true;
            emit TargetFullyFunded(supply, backingAssets());
        }
    }

    function _receiveExact(address from, uint256 amount) internal {
        uint256 beforeBalance = backingAssets();
        ASSET.safeTransferFrom(from, address(this), amount);
        if (backingAssets() != beforeBalance + amount) revert UnsupportedAssetTransfer();
    }

    function _sendExact(address to, uint256 amount) internal {
        uint256 beforeBalance = backingAssets();
        uint256 beforeRecipientBalance = ASSET.balanceOf(to);
        ASSET.safeTransfer(to, amount);
        if (backingAssets() != beforeBalance - amount || ASSET.balanceOf(to) != beforeRecipientBalance + amount) {
            revert UnsupportedAssetTransfer();
        }
    }
}
