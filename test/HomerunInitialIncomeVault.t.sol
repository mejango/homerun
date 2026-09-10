// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {HomerunInitialIncomeVault} from "../src/HomerunInitialIncomeVault.sol";

contract InitialIncomeTestToken is ERC20 {
    error TransferBlocked();

    bool public blockTransfers;
    bool public returnFalse;
    address public callbackTarget;
    bytes public callbackData;
    bool public callbackSucceeded;
    bytes public callbackResult;
    bool public observedClaimed;

    constructor() ERC20("INCOME", "INCOME") {}

    function mint(address beneficiary, uint256 amount) external {
        _mint(beneficiary, amount);
    }

    function setTransferBehavior(bool blocked, bool returnsFalse) external {
        blockTransfers = blocked;
        returnFalse = returnsFalse;
    }

    function setCallback(address target, bytes calldata data) external {
        callbackTarget = target;
        callbackData = data;
    }

    function transfer(address beneficiary, uint256 amount) public override returns (bool) {
        if (blockTransfers) revert TransferBlocked();
        if (returnFalse) return false;
        if (callbackTarget != address(0)) {
            observedClaimed = HomerunInitialIncomeVault(callbackTarget).isClaimed(0);
            (callbackSucceeded, callbackResult) = callbackTarget.call(callbackData);
        }
        return super.transfer(beneficiary, amount);
    }
}

contract HomerunInitialIncomeVaultTest is Test {
    uint256 private constant ALLOCATION = 500_000 ether;
    uint256 private constant FUND_SUPPLY = 1000 ether;
    uint256 private constant SNAPSHOT_BLOCK = 123;
    bytes32 private constant SNAPSHOT_HASH = keccak256("finalized FUND snapshot");
    bytes32 private constant SOURCE_SET_HASH = keccak256("globally reconciled FUND source set");
    bytes32 private constant SALT = keccak256("one FUND launch");
    bytes32 private constant MANIFEST_HASH = keccak256("public reconciled manifest");
    bytes32 private constant TYPEHASH = keccak256(
        "HomerunInitialIncome(uint256 chainId,address deployer,uint256 fundProjectId,bytes32 sourceSetHash,uint256 totalFundSupply,bytes32 salt)"
    );
    address private constant ALICE = address(0xA11CE);
    address private constant BOB = address(0xB0B);
    address private constant RELAYER = address(0xCA11);

    InitialIncomeTestToken private _token;
    HomerunInitialIncomeVault private _vault;
    bytes32 private _aliceLeaf;
    bytes32 private _bobLeaf;

    function setUp() public {
        _token = new InitialIncomeTestToken();
        _aliceLeaf = _leaf(_domain(SALT), 0, ALICE, 600 ether, 300_000 ether);
        _bobLeaf = _leaf(_domain(SALT), 1, BOB, 400 ether, 200_000 ether);
        _vault = _deploy(_pair(_aliceLeaf, _bobLeaf), 2, SALT);
        _token.mint(address(_vault), ALLOCATION);
    }

    function testConstructorCommitsToSnapshotAndManifestWithoutRequiringFunding() public {
        HomerunInitialIncomeVault vault = _deploy(_aliceLeaf, 1, SALT);
        assertEq(address(vault.INCOME_TOKEN()), address(_token));
        assertEq(vault.INCOME_PROJECT_ID(), 2);
        assertEq(vault.FUND_PROJECT_ID(), 1);
        assertEq(vault.FACTORY(), address(this));
        assertEq(vault.SNAPSHOT_BLOCK_NUMBER(), SNAPSHOT_BLOCK);
        assertEq(vault.SNAPSHOT_BLOCK_HASH(), SNAPSHOT_HASH);
        assertEq(vault.TOTAL_FUND_SUPPLY(), FUND_SUPPLY);
        assertEq(vault.SOURCE_SET_HASH(), SOURCE_SET_HASH);
        assertEq(vault.LOCAL_INITIAL_INCOME_SUPPLY(), ALLOCATION);
        assertEq(vault.LAUNCH_SALT(), SALT);
        assertEq(vault.MERKLE_ROOT(), _aliceLeaf);
        assertEq(vault.LEAF_COUNT(), 1);
        assertEq(vault.MANIFEST_HASH(), MANIFEST_HASH);
        assertEq(vault.manifestUri(), "ipfs://snapshot");
        assertEq(vault.DISTRIBUTION_ID(), _domain(SALT));
        assertEq(vault.INITIAL_INCOME_SUPPLY(), ALLOCATION);
        assertEq(_token.balanceOf(address(vault)), 0);
        assertEq(vault.leafHash(0, ALICE, 600 ether, 300_000 ether), _aliceLeaf);
    }

    function testPermissionlessClaimsAlwaysPayTheCommittedBeneficiary() public {
        vm.prank(RELAYER);
        _claimAlice();
        assertEq(_token.balanceOf(ALICE), 300_000 ether);
        assertEq(_token.balanceOf(RELAYER), 0);
        assertTrue(_vault.isClaimed(0));
        assertFalse(_vault.isClaimed(1));
        assertEq(_vault.totalClaimed(), 300_000 ether);

        vm.prank(ALICE);
        _vault.claim(1, BOB, 400 ether, 200_000 ether, _proof(_aliceLeaf));
        assertEq(_token.balanceOf(BOB), 200_000 ether);
        assertEq(_token.balanceOf(address(_vault)), 0);
        assertEq(_vault.totalClaimed(), ALLOCATION);
    }

    function testFrontRunningCannotRedirectOrDuplicateAClaim() public {
        vm.prank(RELAYER);
        _claimAlice();
        vm.expectRevert(HomerunInitialIncomeVault.AlreadyClaimed.selector);
        vm.prank(ALICE);
        _claimAlice();
        assertEq(_token.balanceOf(ALICE), 300_000 ether);
        assertEq(_token.balanceOf(RELAYER), 0);
    }

    function testChangingBeneficiaryInvalidatesProof() public {
        vm.expectRevert(HomerunInitialIncomeVault.InvalidProof.selector);
        _vault.claim(0, RELAYER, 600 ether, 300_000 ether, _proof(_bobLeaf));
        assertFalse(_vault.isClaimed(0));
    }

    function testChangingIndexInvalidatesProof() public {
        vm.expectRevert(HomerunInitialIncomeVault.InvalidProof.selector);
        _vault.claim(1, ALICE, 600 ether, 300_000 ether, _proof(_bobLeaf));
    }

    function testChangingBalanceOrAmountInvalidatesProof() public {
        vm.expectRevert(HomerunInitialIncomeVault.InvalidProof.selector);
        _vault.claim(0, ALICE, 599 ether, 300_000 ether, _proof(_bobLeaf));
        vm.expectRevert(HomerunInitialIncomeVault.InvalidProof.selector);
        _vault.claim(0, ALICE, 600 ether, 300_001 ether, _proof(_bobLeaf));
    }

    function testWrongSiblingAndSingleHashedLeafAreRejected() public {
        vm.expectRevert(HomerunInitialIncomeVault.InvalidProof.selector);
        _vault.claim(0, ALICE, 600 ether, 300_000 ether, _proof(bytes32(uint256(1))));
        bytes32 singleHash = keccak256(abi.encode(_domain(SALT), 0, ALICE, 600 ether, 300_000 ether));
        HomerunInitialIncomeVault vault = _deploy(singleHash, 1, SALT);
        vm.expectRevert(HomerunInitialIncomeVault.InvalidProof.selector);
        vault.claim(0, ALICE, 600 ether, 300_000 ether, new bytes32[](0));
    }

    function testLaunchSaltSeparatesOtherwiseIdenticalVaultProofs() public {
        HomerunInitialIncomeVault other = _deploy(_pair(_aliceLeaf, _bobLeaf), 2, keccak256("different launch"));
        assertNotEq(other.DISTRIBUTION_ID(), _vault.DISTRIBUTION_ID());
        vm.expectRevert(HomerunInitialIncomeVault.InvalidProof.selector);
        other.claim(0, ALICE, 600 ether, 300_000 ether, _proof(_bobLeaf));
    }

    function testFactorySeparatesOtherwiseIdenticalVaultProofs() public {
        vm.prank(RELAYER);
        HomerunInitialIncomeVault other = _deploy(_pair(_aliceLeaf, _bobLeaf), 2, SALT);
        assertEq(other.FACTORY(), RELAYER);
        assertNotEq(other.DISTRIBUTION_ID(), _vault.DISTRIBUTION_ID());
        vm.expectRevert(HomerunInitialIncomeVault.InvalidProof.selector);
        other.claim(0, ALICE, 600 ether, 300_000 ether, _proof(_bobLeaf));
    }

    function testChainSeparatesOtherwiseIdenticalVaultProofs() public {
        vm.chainId(block.chainid + 1);
        HomerunInitialIncomeVault other = _deploy(_pair(_aliceLeaf, _bobLeaf), 2, SALT);
        assertNotEq(other.DISTRIBUTION_ID(), _vault.DISTRIBUTION_ID());
        vm.expectRevert(HomerunInitialIncomeVault.InvalidProof.selector);
        other.claim(0, ALICE, 600 ether, 300_000 ether, _proof(_bobLeaf));
    }

    function testIndexMustBeInsideCommittedLeafCount() public {
        HomerunInitialIncomeVault vault = _deploy(_bobLeaf, 1, SALT);
        vm.expectRevert(HomerunInitialIncomeVault.InvalidClaim.selector);
        vault.claim(1, BOB, 400 ether, 200_000 ether, new bytes32[](0));
    }

    function testZeroAddressAllocationRemainsUnclaimableWithoutBlockingOthers() public {
        bytes32 zeroLeaf = _leaf(_domain(SALT), 0, address(0), 600 ether, 300_000 ether);
        HomerunInitialIncomeVault vault = _deploy(_pair(zeroLeaf, _bobLeaf), 2, SALT);
        _token.mint(address(vault), ALLOCATION);
        vm.expectRevert(HomerunInitialIncomeVault.InvalidClaim.selector);
        vault.claim(0, address(0), 600 ether, 300_000 ether, _proof(_bobLeaf));
        vault.claim(1, BOB, 400 ether, 200_000 ether, _proof(zeroLeaf));
        assertFalse(vault.isClaimed(0));
        assertEq(vault.totalClaimed(), 200_000 ether);
        assertEq(_token.balanceOf(address(vault)), 300_000 ether);
    }

    function testZeroAmountDustAllocationIsNotMarkedClaimed() public {
        bytes32 zeroAmountLeaf = _leaf(_domain(SALT), 0, ALICE, 1, 0);
        HomerunInitialIncomeVault vault = _deploy(_pair(zeroAmountLeaf, _bobLeaf), 2, SALT);
        _token.mint(address(vault), ALLOCATION);
        vm.expectRevert(HomerunInitialIncomeVault.InvalidClaim.selector);
        vault.claim(0, ALICE, 1, 0, _proof(_bobLeaf));
        vault.claim(1, BOB, 400 ether, 200_000 ether, _proof(zeroAmountLeaf));
        assertFalse(vault.isClaimed(0));
        assertTrue(vault.isClaimed(1));
    }

    function testSelfRecipientIsRejected() public {
        vm.expectRevert(HomerunInitialIncomeVault.InvalidClaim.selector);
        _vault.claim(0, address(_vault), 600 ether, 300_000 ether, _proof(_bobLeaf));
    }

    function testImpossibleFundBalancesAreRejected() public {
        vm.expectRevert(HomerunInitialIncomeVault.InvalidProof.selector);
        _vault.claim(0, ALICE, 0, 300_000 ether, _proof(_bobLeaf));
        vm.expectRevert(HomerunInitialIncomeVault.InvalidClaim.selector);
        _vault.claim(0, ALICE, FUND_SUPPLY + 1, 300_000 ether, _proof(_bobLeaf));
    }

    function testFractionalOwnersOfOneFundAtomCanClaimWithZeroDisplayBalances() public {
        // The attested manifest retains exact 3/5 and 2/5 FUND-atom weights. Integer display projections are both zero.
        bytes32 domain = keccak256(abi.encode(TYPEHASH, block.chainid, address(this), 1, SOURCE_SET_HASH, 1, SALT));
        bytes32 aliceLeaf = _leaf(domain, 0, ALICE, 0, 300_000 ether);
        bytes32 bobLeaf = _leaf(domain, 1, BOB, 0, 200_000 ether);
        HomerunInitialIncomeVault vault = new HomerunInitialIncomeVault(
            address(_token),
            2,
            1,
            SNAPSHOT_BLOCK,
            SNAPSHOT_HASH,
            1,
            SALT,
            _pair(aliceLeaf, bobLeaf),
            2,
            MANIFEST_HASH,
            "ipfs://fractional-snapshot",
            SOURCE_SET_HASH,
            ALLOCATION
        );
        _token.mint(address(vault), ALLOCATION);

        vm.prank(RELAYER);
        vault.claim(0, ALICE, 0, 300_000 ether, _proof(bobLeaf));
        vault.claim(1, BOB, 0, 200_000 ether, _proof(aliceLeaf));

        assertEq(_token.balanceOf(ALICE), 300_000 ether);
        assertEq(_token.balanceOf(BOB), 200_000 ether);
        assertEq(_token.balanceOf(RELAYER), 0);
        assertEq(_token.balanceOf(address(vault)), 0);
        assertEq(vault.totalClaimed(), ALLOCATION);
        assertTrue(vault.isClaimed(0));
        assertTrue(vault.isClaimed(1));
        vm.expectRevert(HomerunInitialIncomeVault.AlreadyClaimed.selector);
        vault.claim(0, ALICE, 0, 300_000 ether, _proof(bobLeaf));
    }

    function testOversubscribedAttestedRootCannotExceedPayoutCap() public {
        bytes32 overallocatedBob = _leaf(_domain(SALT), 1, BOB, 400 ether, 300_000 ether);
        HomerunInitialIncomeVault vault = _deploy(_pair(_aliceLeaf, overallocatedBob), 2, SALT);
        // Even accidental extra funding never expands the distribution cap.
        _token.mint(address(vault), 600_000 ether);
        vault.claim(0, ALICE, 600 ether, 300_000 ether, _proof(overallocatedBob));
        vm.expectRevert(HomerunInitialIncomeVault.AllocationExceeded.selector);
        vault.claim(1, BOB, 400 ether, 300_000 ether, _proof(_aliceLeaf));
        assertEq(vault.totalClaimed(), 300_000 ether);
        assertFalse(vault.isClaimed(1));
        assertEq(_token.balanceOf(address(vault)), 300_000 ether);
    }

    function testMaximumMaliciousAmountCannotOverflowCapAccounting() public {
        bytes32 leaf = _leaf(_domain(SALT), 0, ALICE, 1, type(uint256).max);
        HomerunInitialIncomeVault vault = _deploy(leaf, 1, SALT);
        vm.expectRevert(HomerunInitialIncomeVault.AllocationExceeded.selector);
        vault.claim(0, ALICE, 1, type(uint256).max, new bytes32[](0));
        assertEq(vault.totalClaimed(), 0);
        assertFalse(vault.isClaimed(0));
    }

    function testLocalCapCannotBeExpandedByGlobalSupplyOrExtraFunding() public {
        HomerunInitialIncomeVault vault =
            _deployLocal(_pair(_aliceLeaf, _bobLeaf), 2, SALT, SOURCE_SET_HASH, 300_000 ether);
        _token.mint(address(vault), ALLOCATION);
        assertEq(vault.INITIAL_INCOME_SUPPLY(), ALLOCATION);
        assertEq(vault.LOCAL_INITIAL_INCOME_SUPPLY(), 300_000 ether);
        vault.claim(0, ALICE, 600 ether, 300_000 ether, _proof(_bobLeaf));
        vm.expectRevert(HomerunInitialIncomeVault.AllocationExceeded.selector);
        vault.claim(1, BOB, 400 ether, 200_000 ether, _proof(_aliceLeaf));
        assertEq(vault.totalClaimed(), 300_000 ether);
        assertFalse(vault.isClaimed(1));
        assertEq(_token.balanceOf(address(vault)), 200_000 ether);
    }

    function testSeparateChainAllocationsCanDivideTheGlobalSupply() public {
        vm.chainId(8453);
        bytes32 aliceLeaf = _leaf(_domain(SALT), 0, ALICE, 600 ether, 300_000 ether);
        HomerunInitialIncomeVault baseVault = _deployLocal(aliceLeaf, 1, SALT, SOURCE_SET_HASH, 300_000 ether);
        _token.mint(address(baseVault), 300_000 ether);
        baseVault.claim(0, ALICE, 600 ether, 300_000 ether, new bytes32[](0));

        vm.chainId(10);
        bytes32 bobLeaf = _leaf(_domain(SALT), 0, BOB, 400 ether, 200_000 ether);
        HomerunInitialIncomeVault optimismVault = _deployLocal(bobLeaf, 1, SALT, SOURCE_SET_HASH, 200_000 ether);
        _token.mint(address(optimismVault), 200_000 ether);
        optimismVault.claim(0, BOB, 400 ether, 200_000 ether, new bytes32[](0));

        assertNotEq(baseVault.DISTRIBUTION_ID(), optimismVault.DISTRIBUTION_ID());
        assertEq(baseVault.SOURCE_SET_HASH(), optimismVault.SOURCE_SET_HASH());
        assertEq(baseVault.TOTAL_FUND_SUPPLY(), FUND_SUPPLY);
        assertEq(optimismVault.TOTAL_FUND_SUPPLY(), FUND_SUPPLY);
        assertEq(baseVault.totalClaimed() + optimismVault.totalClaimed(), ALLOCATION);
        assertEq(_token.balanceOf(ALICE), 300_000 ether);
        assertEq(_token.balanceOf(BOB), 200_000 ether);
    }

    function testEmptyVaultHasZeroRootLeavesAndLocalAllocation() public {
        HomerunInitialIncomeVault vault = _deployLocal(bytes32(0), 0, SALT, SOURCE_SET_HASH, 0);
        assertEq(vault.MERKLE_ROOT(), bytes32(0));
        assertEq(vault.LEAF_COUNT(), 0);
        assertEq(vault.LOCAL_INITIAL_INCOME_SUPPLY(), 0);
        assertEq(vault.TOTAL_FUND_SUPPLY(), FUND_SUPPLY);
        assertEq(vault.SNAPSHOT_BLOCK_NUMBER(), SNAPSHOT_BLOCK);
        assertEq(vault.SNAPSHOT_BLOCK_HASH(), SNAPSHOT_HASH);
        assertEq(vault.DISTRIBUTION_ID(), _domain(SALT));
        vm.expectRevert(HomerunInitialIncomeVault.InvalidClaim.selector);
        vault.claim(0, ALICE, 1, 1, new bytes32[](0));
        assertEq(vault.totalClaimed(), 0);
    }

    function testPositiveFundDustRootCanHaveZeroLocalAllocation() public {
        bytes32 dustLeaf = _leaf(_domain(SALT), 0, ALICE, 1, 0);
        HomerunInitialIncomeVault vault = _deployLocal(dustLeaf, 1, SALT, SOURCE_SET_HASH, 0);
        assertEq(vault.MERKLE_ROOT(), dustLeaf);
        assertEq(vault.LEAF_COUNT(), 1);
        assertEq(vault.LOCAL_INITIAL_INCOME_SUPPLY(), 0);
        vm.expectRevert(HomerunInitialIncomeVault.InvalidClaim.selector);
        vault.claim(0, ALICE, 1, 0, new bytes32[](0));
        assertFalse(vault.isClaimed(0));
    }

    function testZeroLocalCapRejectsPositiveClaimEvenAfterExtraFunding() public {
        HomerunInitialIncomeVault vault = _deployLocal(_aliceLeaf, 1, SALT, SOURCE_SET_HASH, 0);
        _token.mint(address(vault), ALLOCATION);
        vm.expectRevert(HomerunInitialIncomeVault.AllocationExceeded.selector);
        vault.claim(0, ALICE, 600 ether, 300_000 ether, new bytes32[](0));
        assertFalse(vault.isClaimed(0));
        assertEq(vault.totalClaimed(), 0);
    }

    function testSourceSetSeparatesOtherwiseIdenticalVaultProofs() public {
        HomerunInitialIncomeVault other =
            _deployLocal(_pair(_aliceLeaf, _bobLeaf), 2, SALT, keccak256("another source set"), ALLOCATION);
        assertNotEq(other.DISTRIBUTION_ID(), _vault.DISTRIBUTION_ID());
        vm.expectRevert(HomerunInitialIncomeVault.InvalidProof.selector);
        other.claim(0, ALICE, 600 ether, 300_000 ether, _proof(_bobLeaf));
    }

    function testDomainAndLeafMatchFixedViemVector() public {
        vm.chainId(8453);
        address deployer = address(0x1111111111111111111111111111111111111111);
        address beneficiary = address(0x3333333333333333333333333333333333333333);
        bytes32 sourceSetHash = 0x4444444444444444444444444444444444444444444444444444444444444444;
        bytes32 salt = 0x2222222222222222222222222222222222222222222222222222222222222222;
        bytes32 expectedDomain = 0x75040b138c532ad8802ea802c965e5c2005d3ce6ffe9b587013453f4f7ea54e8;
        bytes32 expectedLeaf = 0x2cd53b97438f6331d1559a49165157dce18f1aa73cbf62120a142f3c4325dda2;
        vm.prank(deployer);
        HomerunInitialIncomeVault vault = new HomerunInitialIncomeVault(
            address(_token),
            18,
            17,
            SNAPSHOT_BLOCK,
            SNAPSHOT_HASH,
            FUND_SUPPLY,
            salt,
            expectedLeaf,
            1,
            MANIFEST_HASH,
            "ipfs://snapshot",
            sourceSetHash,
            300_000 ether
        );
        assertEq(vault.DISTRIBUTION_TYPEHASH(), 0xe44c2ff7e15f437d37b820f5ba7c7bc6ed19b756f20ddb844b8a136a7e0b7890);
        assertEq(vault.DISTRIBUTION_ID(), expectedDomain);
        assertEq(vault.leafHash(0, beneficiary, 600 ether, 300_000 ether), expectedLeaf);
    }

    function testReentrantDifferentLeafCannotBeClaimedDuringTransfer() public {
        _token.setCallback(
            address(_vault), abi.encodeCall(_vault.claim, (1, BOB, 400 ether, 200_000 ether, _proof(_aliceLeaf)))
        );
        _claimAlice();
        assertTrue(_token.observedClaimed());
        assertFalse(_token.callbackSucceeded());
        assertEq(_token.callbackResult(), abi.encodeWithSelector(ReentrancyGuard.ReentrancyGuardReentrantCall.selector));
        assertFalse(_vault.isClaimed(1));
        assertEq(_vault.totalClaimed(), 300_000 ether);
        assertEq(_token.balanceOf(BOB), 0);
    }

    function testTransferRevertRollsBackBitmapAndAccountingForRetry() public {
        _token.setTransferBehavior(true, false);
        vm.expectRevert(InitialIncomeTestToken.TransferBlocked.selector);
        _claimAlice();
        assertFalse(_vault.isClaimed(0));
        assertEq(_vault.totalClaimed(), 0);
        _token.setTransferBehavior(false, false);
        _claimAlice();
        assertEq(_token.balanceOf(ALICE), 300_000 ether);
    }

    function testFalseTokenReturnRollsBackBitmapAndAccounting() public {
        _token.setTransferBehavior(false, true);
        vm.expectRevert(abi.encodeWithSelector(SafeERC20.SafeERC20FailedOperation.selector, address(_token)));
        _claimAlice();
        assertFalse(_vault.isClaimed(0));
        assertEq(_vault.totalClaimed(), 0);
        assertEq(_token.balanceOf(ALICE), 0);
    }

    function testUnfundedClaimRollsBackAndCanBeRetriedAfterFunding() public {
        HomerunInitialIncomeVault vault = _deploy(_aliceLeaf, 1, SALT);
        vm.expectRevert();
        vault.claim(0, ALICE, 600 ether, 300_000 ether, new bytes32[](0));
        assertFalse(vault.isClaimed(0));
        assertEq(vault.totalClaimed(), 0);
        _token.mint(address(vault), ALLOCATION);
        vault.claim(0, ALICE, 600 ether, 300_000 ether, new bytes32[](0));
        assertTrue(vault.isClaimed(0));
    }

    function testClaimsDoNotExpireOrReadCurrentFundBalances() public {
        vm.warp(block.timestamp + 500 * 365 days);
        vm.roll(block.number + 100_000_000);
        // There is deliberately no FUND token or controller contract in this fixture.
        _claimAlice();
        assertEq(_token.balanceOf(ALICE), 300_000 ether);
    }

    function testBitmapBoundaryDoesNotMixDifferentIndices() public {
        bytes32 alice = _leaf(_domain(SALT), 255, ALICE, 600 ether, 300_000 ether);
        bytes32 bob = _leaf(_domain(SALT), 256, BOB, 400 ether, 200_000 ether);
        HomerunInitialIncomeVault vault = _deploy(_pair(alice, bob), 257, SALT);
        _token.mint(address(vault), ALLOCATION);
        vault.claim(255, ALICE, 600 ether, 300_000 ether, _proof(bob));
        assertTrue(vault.isClaimed(255));
        assertFalse(vault.isClaimed(254));
        assertFalse(vault.isClaimed(256));
        vault.claim(256, BOB, 400 ether, 200_000 ether, _proof(alice));
        assertTrue(vault.isClaimed(255));
        assertTrue(vault.isClaimed(256));
        assertFalse(vault.isClaimed(257));
    }

    function testProofLongerThanAddressSpaceBoundIsRejected() public {
        vm.expectRevert(HomerunInitialIncomeVault.InvalidClaim.selector);
        _vault.claim(0, ALICE, 600 ether, 300_000 ether, new bytes32[](161));
    }

    function testMaximumProofDepthAndAddressSpaceLeafCountAreSupported() public {
        uint256 leafCount = uint256(1) << 160;
        uint256 index = leafCount - 1;
        bytes32 root = _leaf(_domain(SALT), index, ALICE, 1, 1);
        bytes32[] memory proof = new bytes32[](160);
        for (uint256 i; i < proof.length; ++i) {
            proof[i] = keccak256(abi.encode(i));
            root = _pair(root, proof[i]);
        }
        HomerunInitialIncomeVault vault = _deploy(root, leafCount, SALT);
        _token.mint(address(vault), ALLOCATION);
        vault.claim(index, ALICE, 1, 1, proof);
        assertTrue(vault.isClaimed(index));
        assertEq(vault.totalClaimed(), 1);
        assertEq(_token.balanceOf(ALICE), 1);
    }

    function testRejectsEmptyAndOversizedLeafCounts() public {
        vm.expectRevert(HomerunInitialIncomeVault.InvalidConfiguration.selector);
        _deploy(_aliceLeaf, 0, SALT);
        vm.expectRevert(HomerunInitialIncomeVault.InvalidConfiguration.selector);
        _deploy(_aliceLeaf, (uint256(1) << 160) + 1, SALT);
    }

    function testRejectsEmptyRootAndLaunchSalt() public {
        vm.expectRevert(HomerunInitialIncomeVault.InvalidConfiguration.selector);
        _deploy(bytes32(0), 1, SALT);
        vm.expectRevert(HomerunInitialIncomeVault.InvalidConfiguration.selector);
        _deploy(_aliceLeaf, 1, bytes32(0));
    }

    function testRejectsPositiveLocalAllocationWithoutAnyLeaves() public {
        vm.expectRevert(HomerunInitialIncomeVault.InvalidConfiguration.selector);
        _deployLocal(bytes32(0), 0, SALT, SOURCE_SET_HASH, 1);
    }

    function testRejectsLocalAllocationAboveGlobalSupply() public {
        vm.expectRevert(HomerunInitialIncomeVault.InvalidConfiguration.selector);
        _deployLocal(_aliceLeaf, 1, SALT, SOURCE_SET_HASH, ALLOCATION + 1);
        vm.expectRevert(HomerunInitialIncomeVault.InvalidConfiguration.selector);
        _deployLocal(_aliceLeaf, 1, SALT, SOURCE_SET_HASH, type(uint256).max);
    }

    function testRejectsEmptySourceSetCommitment() public {
        vm.expectRevert(HomerunInitialIncomeVault.InvalidConfiguration.selector);
        _deployLocal(_aliceLeaf, 1, SALT, bytes32(0), ALLOCATION);
    }

    function testRejectsTokenWithoutCode() public {
        vm.expectRevert(HomerunInitialIncomeVault.InvalidConfiguration.selector);
        new HomerunInitialIncomeVault(
            ALICE,
            2,
            1,
            SNAPSHOT_BLOCK,
            SNAPSHOT_HASH,
            FUND_SUPPLY,
            SALT,
            _aliceLeaf,
            1,
            MANIFEST_HASH,
            "ipfs://snapshot",
            SOURCE_SET_HASH,
            ALLOCATION
        );
    }

    function testFuzzClaimsExactlyThePublishedAllocation(uint256 aliceAmount) public {
        aliceAmount = bound(aliceAmount, 1, ALLOCATION - 1);
        uint256 bobAmount = ALLOCATION - aliceAmount;
        bytes32 alice = _leaf(_domain(SALT), 0, ALICE, 600 ether, aliceAmount);
        bytes32 bob = _leaf(_domain(SALT), 1, BOB, 400 ether, bobAmount);
        HomerunInitialIncomeVault vault = _deploy(_pair(alice, bob), 2, SALT);
        _token.mint(address(vault), ALLOCATION);
        vault.claim(1, BOB, 400 ether, bobAmount, _proof(alice));
        vault.claim(0, ALICE, 600 ether, aliceAmount, _proof(bob));
        assertEq(_token.balanceOf(ALICE), aliceAmount);
        assertEq(_token.balanceOf(BOB), bobAmount);
        assertEq(vault.totalClaimed(), ALLOCATION);
        assertEq(_token.balanceOf(address(vault)), 0);
    }

    function testFuzzClaimsExactlyTheLocalAllocation(uint256 localAllocation, uint256 aliceAmount) public {
        localAllocation = bound(localAllocation, 2, ALLOCATION);
        aliceAmount = bound(aliceAmount, 1, localAllocation - 1);
        uint256 bobAmount = localAllocation - aliceAmount;
        bytes32 alice = _leaf(_domain(SALT), 0, ALICE, 600 ether, aliceAmount);
        bytes32 bob = _leaf(_domain(SALT), 1, BOB, 400 ether, bobAmount);
        HomerunInitialIncomeVault vault = _deployLocal(_pair(alice, bob), 2, SALT, SOURCE_SET_HASH, localAllocation);
        _token.mint(address(vault), localAllocation);
        vault.claim(0, ALICE, 600 ether, aliceAmount, _proof(bob));
        vault.claim(1, BOB, 400 ether, bobAmount, _proof(alice));
        assertEq(vault.totalClaimed(), localAllocation);
        assertLe(vault.totalClaimed(), vault.INITIAL_INCOME_SUPPLY());
        assertEq(_token.balanceOf(address(vault)), 0);
        assertEq(_token.balanceOf(ALICE), aliceAmount);
        assertEq(_token.balanceOf(BOB), bobAmount);
    }

    function _claimAlice() private {
        _vault.claim(0, ALICE, 600 ether, 300_000 ether, _proof(_bobLeaf));
    }

    function _deploy(bytes32 root, uint256 leafCount, bytes32 salt) private returns (HomerunInitialIncomeVault) {
        return _deployLocal(root, leafCount, salt, SOURCE_SET_HASH, ALLOCATION);
    }

    function _deployLocal(
        bytes32 root,
        uint256 leafCount,
        bytes32 salt,
        bytes32 sourceSetHash,
        uint256 localAllocation
    )
        private
        returns (HomerunInitialIncomeVault)
    {
        return new HomerunInitialIncomeVault(
            address(_token),
            2,
            1,
            SNAPSHOT_BLOCK,
            SNAPSHOT_HASH,
            FUND_SUPPLY,
            salt,
            root,
            leafCount,
            MANIFEST_HASH,
            "ipfs://snapshot",
            sourceSetHash,
            localAllocation
        );
    }

    function _domain(bytes32 salt) private view returns (bytes32) {
        return keccak256(abi.encode(TYPEHASH, block.chainid, address(this), 1, SOURCE_SET_HASH, FUND_SUPPLY, salt));
    }

    function _leaf(
        bytes32 domain,
        uint256 index,
        address beneficiary,
        uint256 fundBalance,
        uint256 amount
    )
        private
        pure
        returns (bytes32)
    {
        return keccak256(bytes.concat(keccak256(abi.encode(domain, index, beneficiary, fundBalance, amount))));
    }

    function _pair(bytes32 left, bytes32 right) private pure returns (bytes32) {
        return left < right ? keccak256(abi.encodePacked(left, right)) : keccak256(abi.encodePacked(right, left));
    }

    function _proof(bytes32 sibling) private pure returns (bytes32[] memory proof) {
        proof = new bytes32[](1);
        proof[0] = sibling;
    }
}
