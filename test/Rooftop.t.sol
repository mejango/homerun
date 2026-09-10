// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Rooftop} from "../src/Rooftop.sol";

contract SettlementToken is ERC20 {
    uint256 public feeBps;
    address public callbackTarget;
    bytes public callbackData;
    bool public callbackSucceeded;
    bytes public callbackResult;

    constructor() ERC20("Test settlement", "USD") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setFee(uint256 bps) external {
        feeBps = bps;
    }

    function setCallback(address target, bytes calldata data) external {
        callbackTarget = target;
        callbackData = data;
    }

    function transfer(address to, uint256 amount) public override returns (bool) {
        bool result = super.transfer(to, amount);
        _callback();
        return result;
    }

    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        bool result = super.transferFrom(from, to, amount);
        _callback();
        return result;
    }

    function _update(address from, address to, uint256 amount) internal override {
        uint256 fee = from != address(0) && to != address(0) ? amount * feeBps / 10_000 : 0;
        super._update(from, to, amount - fee);
        if (fee != 0) super._update(from, address(0), fee);
    }

    function _callback() internal {
        if (callbackTarget != address(0)) {
            (callbackSucceeded, callbackResult) = callbackTarget.call(callbackData);
        }
    }
}

contract RooftopTest is Test {
    uint256 internal constant ISSUE_PRICE = 1_000_000;
    uint256 internal constant TARGET_PRICE = 1_300_000;
    uint256 internal constant RAISE_UNITS = 1000;
    address internal constant ATTESTOR = address(0xA77);
    address internal constant CLOSING_ESCROW = address(0xC105E);
    address internal constant ALICE = address(0xA11CE);
    address internal constant BOB = address(0xB0B);
    bytes32 internal constant AGREEMENT = keccak256("signed property financing terms");
    bytes32 internal constant EVIDENCE = keccak256("verified closing evidence");

    SettlementToken internal asset;
    Rooftop internal vault;

    function setUp() public {
        asset = new SettlementToken();
        vault = _newVault();
        asset.mint(ALICE, 1_000_000_000_000);
        asset.mint(BOB, 1_000_000_000_000);
        asset.mint(address(this), 1_000_000_000_000);
        vm.prank(ALICE);
        asset.approve(address(vault), type(uint256).max);
        vm.prank(BOB);
        asset.approve(address(vault), type(uint256).max);
        asset.approve(address(vault), type(uint256).max);
    }

    function _newVault() internal returns (Rooftop) {
        return new Rooftop(
            asset,
            ATTESTOR,
            CLOSING_ESCROW,
            AGREEMENT,
            ISSUE_PRICE,
            TARGET_PRICE,
            RAISE_UNITS,
            block.timestamp + 30 days,
            "Property 001 financing",
            "PROP001"
        );
    }

    function _subscribe() internal {
        vm.prank(ALICE);
        vault.subscribe(600);
        vm.prank(BOB);
        vault.subscribe(400);
    }

    function _close() internal {
        _subscribe();
        vm.prank(ATTESTOR);
        vault.close(EVIDENCE);
    }

    function _claim() internal {
        vm.prank(ALICE);
        vault.claimTokens();
        vm.prank(BOB);
        vault.claimTokens();
    }

    function testEscrowClosesOnceWithFixedSupplyAndExactProceeds() public {
        _subscribe();
        assertEq(vault.totalSupply(), 0);
        assertEq(asset.balanceOf(CLOSING_ESCROW), 0);
        assertEq(vault.backingAssets(), 1000 * ISSUE_PRICE);

        vm.prank(ATTESTOR);
        vault.close(EVIDENCE);
        assertEq(vault.totalSupply(), RAISE_UNITS);
        assertEq(vault.balanceOf(address(vault)), RAISE_UNITS);
        assertEq(asset.balanceOf(CLOSING_ESCROW), 1000 * ISSUE_PRICE);
        assertEq(vault.backingAssets(), 0);
        assertEq(vault.closingEvidenceHash(), EVIDENCE);
        assertEq(vault.decimals(), 0);
        assertFalse(vault.releaseEligible());

        vm.prank(ATTESTOR);
        vm.expectRevert(Rooftop.WrongPhase.selector);
        vault.close(EVIDENCE);
        vm.prank(ALICE);
        vm.expectRevert(Rooftop.WrongPhase.selector);
        vault.subscribe(1);
    }

    function testClosingRequiresAttestorFullRaiseEvidenceAndLiveDeadline() public {
        vm.expectRevert(Rooftop.Unauthorized.selector);
        vault.close(EVIDENCE);
        vm.prank(ATTESTOR);
        vm.expectRevert(Rooftop.RaiseIncomplete.selector);
        vault.close(EVIDENCE);
        _subscribe();
        vm.prank(ATTESTOR);
        vm.expectRevert(Rooftop.InvalidConfiguration.selector);
        vault.close(bytes32(0));
        vm.warp(vault.FUNDING_DEADLINE());
        vm.prank(ATTESTOR);
        vm.expectRevert(Rooftop.DeadlinePassed.selector);
        vault.close(EVIDENCE);
    }

    function testRaiseCannotExceedImmutableCeiling() public {
        _subscribe();
        vm.prank(ALICE);
        vm.expectRevert(Rooftop.RaiseExceeded.selector);
        vault.subscribe(1);
    }

    function testExpiredSubscriptionsRefundExactlyAndCannotClose() public {
        uint256 aliceBefore = asset.balanceOf(ALICE);
        uint256 bobBefore = asset.balanceOf(BOB);
        _subscribe();
        vm.prank(ALICE);
        vm.expectRevert(Rooftop.RefundUnavailable.selector);
        vault.refund();

        vm.warp(vault.FUNDING_DEADLINE());
        vm.prank(ALICE);
        vault.refund();
        vm.prank(BOB);
        vault.refund();
        assertEq(asset.balanceOf(ALICE), aliceBefore);
        assertEq(asset.balanceOf(BOB), bobBefore);
        assertEq(vault.backingAssets(), 0);
        assertEq(vault.totalSupply(), 0);
        assertEq(vault.subscribedUnits(), 0);
        vm.prank(ALICE);
        vm.expectRevert(Rooftop.NoSubscription.selector);
        vault.refund();
        vm.prank(ATTESTOR);
        vm.expectRevert(Rooftop.WrongPhase.selector);
        vault.close(EVIDENCE);
    }

    function testAttestorMayCancelForRefundButCannotTakeEscrow() public {
        _subscribe();
        vm.expectRevert(Rooftop.Unauthorized.selector);
        vault.cancel();
        vm.prank(ATTESTOR);
        vault.cancel();
        vm.prank(ALICE);
        assertEq(vault.refund(), 600 * ISSUE_PRICE);
        assertEq(asset.balanceOf(CLOSING_ESCROW), 0);
        assertEq(vault.backingAssets(), 400 * ISSUE_PRICE);
    }

    function testReceiptsClaimOnceWithoutChangingSupplyAndAreNontransferable() public {
        _close();
        vm.prank(ALICE);
        assertEq(vault.claimTokens(), 600);
        assertEq(vault.totalSupply(), RAISE_UNITS);
        assertEq(vault.balanceOf(ALICE), 600);
        assertEq(vault.balanceOf(address(vault)), 400);
        vm.prank(ALICE);
        vm.expectRevert(Rooftop.NoSubscription.selector);
        vault.claimTokens();
        vm.prank(ALICE);
        vm.expectRevert(Rooftop.Nontransferable.selector);
        vault.transfer(BOB, 1);
        vm.prank(ALICE);
        vm.expectRevert(Rooftop.Nontransferable.selector);
        vault.approve(BOB, 1);
        vm.prank(BOB);
        vm.expectRevert(Rooftop.Nontransferable.selector);
        vault.transferFrom(ALICE, BOB, 1);
    }

    function testPassiveHoldersRemainInDenominatorAndCanClaimAfterFullFunding() public {
        _close();
        vm.prank(ALICE);
        vault.claimTokens();
        vault.fundBacking(RAISE_UNITS * TARGET_PRICE);
        assertTrue(vault.releaseEligible());
        assertTrue(vault.targetWasFullyFunded());
        assertEq(vault.cashOutValue(600), 600 * TARGET_PRICE);
        vm.prank(ALICE);
        vault.cashOut(600, 600 * TARGET_PRICE);
        assertEq(vault.totalSupply(), 400);
        assertEq(vault.backingAssets(), 400 * TARGET_PRICE);
        vm.prank(BOB);
        vault.claimTokens();
        vm.prank(BOB);
        vault.cashOut(400, 400 * TARGET_PRICE);
        assertEq(vault.backingAssets(), 0);
        assertTrue(vault.allClaimsExtinguished());
    }

    function testCashOutImmediatelyAfterCloseCannotBurnForZero() public {
        _close();
        _claim();
        vm.prank(ALICE);
        vm.expectRevert(Rooftop.ZeroCashOut.selector);
        vault.cashOut(600, 0);
        assertEq(vault.balanceOf(ALICE), 600);
        assertEq(vault.totalSupply(), RAISE_UNITS);
    }

    function testPositiveBackingRoundedToZeroCannotDestroyReceipts() public {
        _close();
        _claim();
        vault.fundBacking(1);
        assertEq(vault.cashOutValue(600), 0);
        vm.prank(ALICE);
        vm.expectRevert(Rooftop.ZeroCashOut.selector);
        vault.cashOut(600, 0);
        assertEq(vault.balanceOf(ALICE), 600);
        assertEq(vault.totalSupply(), RAISE_UNITS);
        assertEq(vault.backingAssets(), 1);
    }

    function testDiscountedExitPreservesRemainingPriceAndExtinguishesExitedRights() public {
        _close();
        _claim();
        vault.fundBacking(200 * ISSUE_PRICE);
        uint256 oneUnitBefore = vault.cashOutValue(1);
        uint256 aliceBefore = asset.balanceOf(ALICE);
        vm.prank(ALICE);
        assertEq(vault.cashOut(600, 120 * ISSUE_PRICE), 120 * ISSUE_PRICE);
        assertEq(asset.balanceOf(ALICE) - aliceBefore, 120 * ISSUE_PRICE);
        assertEq(vault.balanceOf(ALICE), 0);
        assertEq(vault.totalSupply(), 400);
        assertEq(vault.backingAssets(), 80 * ISSUE_PRICE);
        assertEq(vault.cashOutValue(1), oneUnitBefore);
        assertEq(vault.backingGap(), 440 * ISSUE_PRICE);
        assertFalse(vault.releaseEligible());

        vault.fundBacking(440 * ISSUE_PRICE);
        assertEq(vault.cashOutValue(400), 520 * ISSUE_PRICE);
        vm.prank(ALICE);
        vm.expectRevert();
        vault.cashOut(1, 0);
        assertEq(vault.totalSupply(), 400);
    }

    function testEveryDiscountedExitCanExtinguishClaimsWithoutFullTargetFunding() public {
        _close();
        _claim();
        vault.fundBacking(100 * ISSUE_PRICE);
        vm.prank(ALICE);
        vault.cashOut(600, 0);
        vm.prank(BOB);
        vault.cashOut(400, 0);
        assertEq(vault.totalSupply(), 0);
        assertEq(vault.backingAssets(), 0);
        assertTrue(vault.releaseEligible());
        assertTrue(vault.allClaimsExtinguished());
        assertFalse(vault.targetWasFullyFunded());
    }

    function testDepositReturnsOnlyNewExcessAndCannotWithdrawExistingBacking() public {
        _close();
        uint256 callerBefore = asset.balanceOf(address(this));
        (uint256 retained, uint256 returned) = vault.fundBacking(2000 * ISSUE_PRICE);
        assertEq(retained, 1300 * ISSUE_PRICE);
        assertEq(returned, 700 * ISSUE_PRICE);
        assertEq(callerBefore - asset.balanceOf(address(this)), retained);
        assertEq(vault.backingAssets(), retained);

        vm.prank(ATTESTOR);
        vm.expectRevert(Rooftop.WrongPhase.selector);
        vault.cancel();
        vm.prank(ALICE);
        vm.expectRevert(Rooftop.RefundUnavailable.selector);
        vault.refund();
        (retained, returned) = vault.fundBacking(100 * ISSUE_PRICE);
        assertEq(retained, 0);
        assertEq(returned, 100 * ISSUE_PRICE);
        assertEq(vault.backingAssets(), 1300 * ISSUE_PRICE);
    }

    function testDirectDonationAboveTargetNeverRaisesCashOutCapOrBecomesWithdrawable() public {
        _close();
        _claim();
        asset.transfer(address(vault), 2000 * ISSUE_PRICE);
        assertTrue(vault.releaseEligible());
        assertFalse(vault.targetWasFullyFunded());
        vault.syncFundingStatus();
        assertTrue(vault.targetWasFullyFunded());
        assertEq(vault.cashOutValue(600), 600 * TARGET_PRICE);
        vm.prank(ALICE);
        vault.cashOut(600, 0);
        vm.prank(BOB);
        vault.cashOut(400, 0);
        assertEq(vault.backingAssets(), 700 * ISSUE_PRICE);
        vault.fundBacking(1);
        assertEq(vault.backingAssets(), 700 * ISSUE_PRICE);
    }

    function testSlippageProtectsBurnAndBalance() public {
        _close();
        _claim();
        vault.fundBacking(100 * ISSUE_PRICE);
        uint256 quote = vault.cashOutValue(600);
        vm.prank(ALICE);
        vm.expectRevert(abi.encodeWithSelector(Rooftop.Slippage.selector, quote, quote + 1));
        vault.cashOut(600, quote + 1);
        assertEq(vault.balanceOf(ALICE), 600);
        assertEq(vault.backingAssets(), 100 * ISSUE_PRICE);
    }

    function testIncomingFeeAssetRevertsWithoutRecordingSubscription() public {
        asset.setFee(100);
        vm.prank(ALICE);
        vm.expectRevert(Rooftop.UnsupportedAssetTransfer.selector);
        vault.subscribe(600);
        assertEq(vault.subscriptionOf(ALICE), 0);
        assertEq(vault.subscribedUnits(), 0);
        assertEq(vault.backingAssets(), 0);
    }

    function testClosingTransferFailureRollsBackPhaseMintAndEvidence() public {
        _subscribe();
        asset.setFee(100);
        vm.prank(ATTESTOR);
        vm.expectRevert(Rooftop.UnsupportedAssetTransfer.selector);
        vault.close(EVIDENCE);
        assertEq(uint256(vault.phase()), uint256(Rooftop.Phase.Fundraising));
        assertEq(vault.totalSupply(), 0);
        assertEq(vault.closingEvidenceHash(), bytes32(0));
        assertEq(vault.backingAssets(), RAISE_UNITS * ISSUE_PRICE);
        assertEq(asset.balanceOf(CLOSING_ESCROW), 0);
        assertEq(vault.subscriptionOf(ALICE), 600);
    }

    function testRefundTransferFailurePreservesSubscriptionForRetry() public {
        _subscribe();
        vm.warp(vault.FUNDING_DEADLINE());
        asset.setFee(100);
        vm.prank(ALICE);
        vm.expectRevert(Rooftop.UnsupportedAssetTransfer.selector);
        vault.refund();
        assertEq(uint256(vault.phase()), uint256(Rooftop.Phase.Fundraising));
        assertEq(vault.subscriptionOf(ALICE), 600);
        assertEq(vault.subscribedUnits(), RAISE_UNITS);
        assertEq(vault.backingAssets(), RAISE_UNITS * ISSUE_PRICE);
        asset.setFee(0);
        vm.prank(ALICE);
        assertEq(vault.refund(), 600 * ISSUE_PRICE);
    }

    function testOutgoingFeeAssetRevertsWithoutBurningClaim() public {
        _close();
        _claim();
        vault.fundBacking(100 * ISSUE_PRICE);
        asset.setFee(100);
        vm.prank(ALICE);
        vm.expectRevert(Rooftop.UnsupportedAssetTransfer.selector);
        vault.cashOut(600, 0);
        assertEq(vault.balanceOf(ALICE), 600);
        assertEq(vault.backingAssets(), 100 * ISSUE_PRICE);
    }

    function testTokenCallbacksCannotReenterFundingOrRedemption() public {
        _close();
        _claim();
        asset.setCallback(address(vault), abi.encodeCall(vault.fundBacking, (1)));
        vault.fundBacking(100 * ISSUE_PRICE);
        assertFalse(asset.callbackSucceeded());
        assertEq(asset.callbackResult(), abi.encodeWithSelector(ReentrancyGuard.ReentrancyGuardReentrantCall.selector));
        asset.setCallback(address(vault), abi.encodeCall(vault.cashOut, (1, 0)));
        vm.prank(ALICE);
        vault.cashOut(600, 0);
        assertFalse(asset.callbackSucceeded());
        assertEq(asset.callbackResult(), abi.encodeWithSelector(ReentrancyGuard.ReentrancyGuardReentrantCall.selector));
        assertEq(vault.totalSupply(), 400);
        assertEq(vault.backingAssets(), 40 * ISSUE_PRICE);
    }

    function testFuzzCashOutIsProRataCappedAndConservesBacking(uint256 backing, uint256 units) public {
        _close();
        _claim();
        backing = bound(backing, RAISE_UNITS, RAISE_UNITS * TARGET_PRICE * 2);
        units = bound(units, 1, 600);
        asset.transfer(address(vault), backing);
        uint256 expected = Math.min(Math.mulDiv(backing, units, RAISE_UNITS), units * TARGET_PRICE);
        uint256 investorBefore = asset.balanceOf(ALICE);
        uint256 remainingUnitBefore = vault.cashOutValue(1);
        vm.prank(ALICE);
        uint256 paid = vault.cashOut(units, expected);
        assertEq(paid, expected);
        assertLe(paid, units * TARGET_PRICE);
        assertEq(vault.backingAssets() + paid, backing);
        assertEq(asset.balanceOf(ALICE) - investorBefore, paid);
        assertEq(vault.totalSupply(), RAISE_UNITS - units);
        assertGe(vault.cashOutValue(1), remainingUnitBefore);
    }

    function testFuzzSequentialCashOutsNeverSpendMoreThanBacking(uint256 backing) public {
        _close();
        _claim();
        backing = bound(backing, RAISE_UNITS, RAISE_UNITS * TARGET_PRICE);
        vault.fundBacking(backing);
        vm.prank(ALICE);
        uint256 first = vault.cashOut(600, 0);
        vm.prank(BOB);
        uint256 last = vault.cashOut(400, 0);
        assertEq(first + last, backing);
        assertEq(vault.backingAssets(), 0);
        assertEq(vault.totalSupply(), 0);
    }

    function testFuzzAddedBackingCannotReduceCashOutValue(uint256 first, uint256 second) public {
        _close();
        first = bound(first, 1, RAISE_UNITS * TARGET_PRICE);
        second = bound(second, 1, RAISE_UNITS * TARGET_PRICE);
        vault.fundBacking(first);
        uint256 beforeValue = vault.cashOutValue(600);
        vault.fundBacking(second);
        assertGe(vault.cashOutValue(600), beforeValue);
        assertLe(vault.cashOutValue(600), 600 * TARGET_PRICE);
        assertLe(vault.backingAssets(), RAISE_UNITS * TARGET_PRICE);
    }

    function testSeparatePropertiesCannotUseEachOthersBacking() public {
        _close();
        vault.fundBacking(100 * ISSUE_PRICE);
        Rooftop other = _newVault();
        asset.approve(address(other), type(uint256).max);
        other.subscribe(RAISE_UNITS);
        vm.prank(ATTESTOR);
        other.close(EVIDENCE);
        assertEq(other.backingAssets(), 0);
        assertEq(other.cashOutValue(1), 0);
        assertEq(vault.backingAssets(), 100 * ISSUE_PRICE);
        other.fundBacking(500 * ISSUE_PRICE);
        assertEq(vault.backingAssets(), 100 * ISSUE_PRICE);
        assertEq(other.backingAssets(), 500 * ISSUE_PRICE);
    }
}
