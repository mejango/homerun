import test from 'node:test';
import assert from 'node:assert/strict';
import { ownerActionDraft, plannedOwnerActionDraft } from '../web/owner-actions.mjs';
import { projectNetwork } from '../web/network-model.mjs';

const base = () => {
  const fundInvestorSupply = 615_384.62 * 10_000;
  const fundOperatorMint = fundInvestorSupply / 4;
  return {
    phase: 'raising', fundRewardMode: 'staking',
    raiseGoal: 615_384.62,
    purchaseBudget: 500_000,
    opsReserve: 100_000,
    escrowCash: 615_384.62,
    precloseSpent: 0,
    fundInvestorSupply,
    fundOperatorMint,
    fundTotalSupply: fundInvestorSupply + fundOperatorMint,
    operatorFundPercent: 20,
  };
};

test('all owner actions remain non-executable JSON drafts even when addresses are supplied', () => {
  for (const [action, phase] of [['close_raise', 'raising'], ['enable_refunds', 'raising'], ['complete_purchase', 'funded'], ['enable_sale_redemptions', 'earning']]) {
    const draft = ownerActionDraft(action, { ...base(), phase, chainId: 1, fundProjectId: 42, owner: '0x123' });
    assert.equal(draft.executable, false);
    assert.equal(draft.patchOnly, true);
    assert.equal(draft.eligible, true);
    assert.deepEqual(JSON.parse(JSON.stringify(draft)), draft);
    assert.equal('calldata' in draft, false);
    assert.equal('transaction' in draft, false);
    assert(draft.requiresVerification.some(item => item.includes('pending rulesets')));
  }
});

test('missing and invalid economics are rejected instead of replaced with defaults', () => {
  for (const field of ['phase', 'raiseGoal', 'purchaseBudget', 'opsReserve', 'escrowCash', 'precloseSpent', 'fundInvestorSupply', 'fundOperatorMint', 'fundTotalSupply']) {
    const state = base();
    delete state[field];
    assert.throws(() => ownerActionDraft('close_raise', state));
  }
  for (const invalid of [NaN, Infinity, -1, '500000']) {
    assert.throws(() => ownerActionDraft('close_raise', { ...base(), purchaseBudget: invalid }));
  }
  assert.throws(() => ownerActionDraft('send_everything', base()), /Unknown owner action/);
});

test('the net $600k budget is grossed up and existing spending is never deducted twice', () => {
  const draft = ownerActionDraft('close_raise', { ...base(), precloseSpent: 2500, raiseGoal: 617_884.62, raised: 617_884.62 });
  assert.equal(draft.budget.netClosingBudget, 600_000);
  assert.equal(draft.budget.grossClosingBudget, 615_384.62);
  assert.equal(draft.budget.escrowCash, 615_384.62);
  assert.equal(draft.eligible, true);
  const underfunded = ownerActionDraft('close_raise', { ...base(), escrowCash: 600_000 });
  assert.equal(underfunded.eligible, false);
  assert(underfunded.blockedReasons.some(item => item.includes('Current escrow cash')));
});

test('a historical fundraising goal cannot replace current closing cash', () => {
  const draft = ownerActionDraft('close_raise', { ...base(), escrowCash: 200_000, raised: 900_000 });
  assert.equal(draft.eligible, false);
  assert.equal(draft.changes.releasesPurchaseCash, false);
  assert.equal(draft.changes.operatorFundMint, 0);
  assert.equal(draft.changes.revenuePremint, 0);
});

test('a stated raise goal above the closing budget remains a success condition', () => {
  const draft = ownerActionDraft('close_raise', { ...base(), raiseGoal: 700_000, raised: 615_384.62 });
  assert.equal(draft.eligible, false);
  assert(draft.blockedReasons.some(item => item.includes('below the stated raise goal')));
});

test('editable payout fees and closing costs feed the gross budget, including fee exemptions', () => {
  const noFee = ownerActionDraft('close_raise', { ...base(), payoutFeePercent: 0, closingCosts: 20_000, raiseGoal: 620_000, raised: 620_000, escrowCash: 620_000 });
  assert.equal(noFee.eligible, true);
  assert.equal(noFee.budget.grossClosingBudget, 620_000);
  assert.equal(noFee.budget.assumedProtocolFeePercent, 0);
  const higherFee = ownerActionDraft('close_raise', { ...base(), payoutFeePercent: 5, closingCosts: 20_000, raiseGoal: 652_631.58, escrowCash: 652_631.58 });
  assert.equal(higherFee.eligible, true);
  assert.equal(higherFee.budget.grossClosingBudget, 652_631.58);
  for (const invalid of [NaN, Infinity, -1, 100]) assert.throws(() => ownerActionDraft('close_raise', { ...base(), payoutFeePercent: invalid }));
});

test('an empty raise produces an ineligible review draft without fabricating FUND supply', () => {
  const draft = ownerActionDraft('close_raise', { ...base(), escrowCash: 0, fundInvestorSupply: 0, fundOperatorMint: 0, fundTotalSupply: 0 });
  assert.equal(draft.executable, false);
  assert.equal(draft.eligible, false);
  assert(draft.blockedReasons.some(item => item.includes('No investor FUND')));
});

test('commitment patch stops payment and cash recovery without claiming to revert zero-value burns', () => {
  const draft = ownerActionDraft('close_raise', base());
  assert.deepEqual(draft.changes.fundRulesetMetadata, { pausePay: true, cashOutTaxRate: 10_000, allowOwnerMinting: false, reservedPercent: 0 });
  assert(draft.warnings.some(item => item.includes('still burn tokens')));
  assert.equal(draft.changes.fundAccess.purchaseReservation.grossDisplayUSDC, 615_384.62);
});

test('repeat actions and invalid phase transitions cannot be presented as eligible', () => {
  for (const [action, phase] of [['close_raise', 'funded'], ['enable_refunds', 'refunding'], ['complete_purchase', 'earning'], ['enable_sale_redemptions', 'liquidated']]) {
    assert.equal(ownerActionDraft(action, { ...base(), phase }).eligible, false);
  }
  assert.equal(ownerActionDraft('close_raise', { ...base(), completedOwnerActions: ['close_raise'] }).eligible, false);
  assert.equal(ownerActionDraft('enable_refunds', { ...base(), phase: 'earning' }).eligible, false);
});

test('known completed later actions override stale phases and omitted booleans', () => {
  for (const [action, phase, history] of [
    ['enable_refunds', 'funded', ['complete_purchase']],
    ['complete_purchase', 'funded', ['enable_sale_redemptions']],
    ['complete_purchase', 'funded', ['enable_refunds']],
    ['close_raise', 'raising', ['complete_purchase']],
  ]) {
    const draft = ownerActionDraft(action, { ...base(), phase, completedOwnerActions: history });
    assert.equal(draft.eligible, false);
    assert(draft.blockedReasons.some(item => item.includes('history conflicts')));
  }
});

test('refund drafts remove all withdrawal reservations and never mint either token', () => {
  const state = { ...base(), phase: 'funded', escrowCash: 150_000, precloseSpent: 7500 };
  const draft = ownerActionDraft('enable_refunds', state);
  assert.equal(draft.eligible, true);
  assert.equal(draft.changes.availableRefundCash, 150_000);
  assert.equal(draft.changes.operatorFundMint, 0);
  assert.equal(draft.changes.revenuePremint, 0);
  assert.equal(draft.changes.fundRulesetMetadata.cashOutTaxRate, 0);
  assert.deepEqual(draft.changes.fundAccess.payoutLimits.entries, []);
  assert.deepEqual(draft.changes.fundAccess.surplusAllowances.entries, []);
  assert(draft.warnings.some(item => item.includes('does not restore each original subscription')));
});

test('success evidence cannot be sent through a failed-raise refund', () => {
  for (const field of ['purchaseCompleted', 'operatorFundMinted', 'revenuePreminted']) {
    assert.equal(ownerActionDraft('enable_refunds', { ...base(), [field]: true }).eligible, false);
  }
});

test('success mint is postmint 20%, then freeze, then a single snapshot and premint', () => {
  const state = { ...base(), phase: 'funded' };
  const draft = ownerActionDraft('complete_purchase', state);
  assert.equal(draft.eligible, true);
  assert(Math.abs(draft.changes.operatorFundMint / draft.changes.finalFundSupply - 0.2) < 1e-14);
  const ids = draft.steps.map(item => item.id);
  for (const [before, after] of [['purchase_and_reserve', 'enable_operator_mint'], ['enable_operator_mint', 'mint_operator_fund'], ['mint_operator_fund', 'freeze_fund_issuance'], ['freeze_fund_issuance', 'snapshot_all_fund'], ['snapshot_all_fund', 'premint_revenue_once']]) {
    assert(ids.indexOf(before) < ids.indexOf(after));
  }
  assert.equal(draft.steps.find(item => item.id === 'enable_operator_mint').patch.rulesetMetadata.allowOwnerMinting, true);
  assert.equal(draft.steps.find(item => item.id === 'freeze_fund_issuance').patch.rulesetMetadata.allowOwnerMinting, false);
  assert.equal(draft.steps.find(item => item.id === 'mint_operator_fund').patch.mintIntent.useReservedPercent, false);
});

test('revenue snapshot includes operator and unclaimed FUND, preserves FUND, and invents no REV amount', () => {
  const allocation = ownerActionDraft('complete_purchase', { ...base(), phase: 'funded' }).changes.revenueAllocation;
  assert.equal(allocation.includesOperatorFund, true);
  assert.equal(allocation.includesUnclaimedFundCredits, true);
  assert.equal(allocation.fundTokensBurned, 0);
  assert.equal(allocation.repeatAllocationAllowed, false);
  assert.equal(allocation.totalRevenuePremint, null);
  assert.equal(allocation.snapshot, null);
});

test('known RENT premint and hybrid stages appear without adding an operator premint', () => {
  const draft = ownerActionDraft('complete_purchase', {
    ...base(), phase: 'funded', revenuePremint: 500_000, revPrice: 0.1,
    issuanceCutPercent: 5, issuanceCutMonths: 3, issuanceCutYears: 2, operatorSplitPercent: 75, ongoingOperatorSplitPercent: 75, stickySplitPercent: 15,
  });
  assert.equal(draft.changes.revenueAllocation.totalRevenuePremint, 500_000);
  assert.equal(draft.changes.revenueAllocation.additionalOperatorRevPremint, 0);
  assert.equal(draft.changes.revenueAllocation.operatorShareOfPremintPercent, 20);
  const policy = draft.changes.revenuePolicy;
  assert.equal(policy.initialIssuancePriceUSDC, 0.1);
  assert.equal(policy.initialIssuanceRevPerUSDC, 10);
  assert.equal(policy.materializeAllAutoIssuancesBeforeFundingOrLoans, true);
  assert.equal(policy.claimsTransferAlreadyMintedTokens, true);
  assert.equal(policy.stages.length, 9);
  assert.equal(policy.stages[0].operatorReservedTokenPercent, 75);
  assert.equal(policy.stages[0].fundStickyTokenPercent, 15);
  assert.equal(policy.stages[0].renterIssuedTokenPercent, 10);
  assert.equal(policy.stages[1].operatorReservedTokenPercent, 75);
  assert.equal(policy.premintIsSeniorWaterfall, false);
  for (const stage of policy.stages) {
    assert.equal(stage.nativeSplitPercent, 9000);
    assert.equal(stage.reservedSplitGroup.operator, 833_333_333);
    assert.equal(stage.reservedSplitGroup.fundSticky, 166_666_667);
    assert.equal(stage.reservedSplitGroup.operator + stage.reservedSplitGroup.fundSticky, 1_000_000_000);
    assert.equal(stage.reservedSplitGroup.lockBothSplitsInEveryStage, false);
    assert.equal(stage.reservedSplitGroup.lockedUntil, 0);
    assert.equal(stage.reservedSplitGroup.roundingReviewRequired, true);
  }
  assert.equal(policy.stages[1].issuanceRevPerUSDC, 9.5);
  assert.equal(policy.stages.at(-1).durationMonths, null);
  assert.equal(policy.stages.at(-1).startsAfterMonths, 24);
  assert.equal(policy.stages.at(-1).issuanceRevPerUSDC, 10 * 0.95 ** 8);
  assert.equal(draft.steps.find(item => item.id === 'premint_revenue_once').patch.revenuePolicy.atomicRevnetLaunchAndPremintRequired, true);
});

test('Sticky reward routing uses the SHARE token beneficiary and invents no deployment addresses', () => {
  const draft = ownerActionDraft('complete_purchase', { ...base(), phase: 'funded', stickySplitPercent: 15 });
  const sticky = draft.changes.fundSticky;
  assert.equal(sticky.acceptedToken, 'FH-FUND');
  assert.equal(sticky.stickyCashOutTaxRate, 0);
  assert.equal(sticky.rewardRoute.hook, 'JBTokenDistributor');
  assert.equal(sticky.rewardRoute.beneficiary, 'FUND Sticky SHARE ERC20');
  assert.equal(sticky.rewardRoute.hookAddress, null);
  assert.equal(sticky.rewardRoute.beneficiaryAddress, null);
  assert.deepEqual(sticky.rewardRoute.notBeneficiary, ['raw FH-FUND token', 'JBStickyHook']);
  assert.equal(sticky.projectId, null);
  const ids = draft.steps.map(item => item.id);
  assert(ids.indexOf('snapshot_all_fund') < ids.indexOf('prepare_fund_sticky'));
  assert(ids.indexOf('configure_sticky_reward_route') < ids.indexOf('premint_revenue_once'));
});

test('vesting and participation assumptions preserve pending claims without advertising borrowable rewards', () => {
  const draft = ownerActionDraft('complete_purchase', {
    ...base(), phase: 'funded', personalStakePercent: 50, otherStakePercent: 0, stickyVestingMonths: 2,
  });
  const sticky = draft.changes.fundSticky;
  assert.equal(sticky.modeledPersonalStakePercent, 50);
  assert.equal(sticky.modeledOtherStakePercent, 0);
  assert.equal(sticky.modeledVestingMonths, 2);
  assert.equal(sticky.productionVesting.interval, 'weekly');
  assert.equal(sticky.productionVesting.rounds, 4);
  assert.equal(sticky.productionVesting.startsAfterMaterialization, true);
  assert.equal(sticky.unvestedRewardsBorrowable, false);
  assert.equal(sticky.shortStakeCaptureResolved, false);
  assert.equal(sticky.operatorFundEarnsSameProRataRewards, true);
  assert.equal(sticky.pendingRewardsSurviveUnstaking, true);
  assert.equal(sticky.modelAutoClaimsMaturedRewards, true);
  assert.match(sticky.noStakerRewards, /model holds unallocated/);
});

test('hybrid split over-allocation and invalid participation cannot pass owner validation', () => {
  for (const settings of [
    { operatorSplitPercent: 90, stickySplitPercent: 15 },
    { ongoingOperatorSplitPercent: 86, stickySplitPercent: 15 },
    { stickySplitPercent: -1 }, { stickySplitPercent: 101 },
    { personalStakePercent: 101 }, { otherStakePercent: -1 }, { stickyVestingMonths: 1.5 }, { stickyVestingMonths: 37 },
  ]) assert.throws(() => ownerActionDraft('complete_purchase', { ...base(), phase: 'funded', ...settings }));
});

test('sale drafts preserve pending RENT claims and explain unstick then FUND redemption', () => {
  const draft = ownerActionDraft('enable_sale_redemptions', { ...base(), phase: 'earning' });
  assert.equal(draft.changes.fundSticky.saleRequiresUnstakingBeforeFundRedemption, true);
  assert.equal(draft.changes.fundSticky.saleModelAdvancesPendingVesting, false);
  assert.equal(draft.changes.fundSticky.pendingRewardsSurviveUnstaking, true);
  assert(draft.steps.some(item => item.id === 'prepare_holder_unstaking'));
  assert(draft.warnings.some(item => item.includes('sale view does not advance time')));
});

test('no cuts still preserves the first-year split transition and missing stages stay unknown', () => {
  const draft = ownerActionDraft('complete_purchase', {
    ...base(), phase: 'funded', revenuePremint: 1, revPrice: 0.1,
    issuanceCutPercent: 0, issuanceCutMonths: 3, issuanceCutYears: 0, operatorSplitPercent: 80, ongoingOperatorSplitPercent: 70, stickySplitPercent: 10,
  });
  assert.equal(draft.changes.revenuePolicy.stages.length, 2);
  assert.equal(draft.changes.revenuePolicy.stages[1].issuanceRevPerUSDC, 10);
  const partial = ownerActionDraft('complete_purchase', { ...base(), phase: 'funded', revenuePremint: 10, revPrice: 0.5 });
  assert.deepEqual(partial.changes.revenuePolicy.stages, []);
  assert.equal(partial.changes.revenuePolicy.issuanceCutPercent, null);
  assert.equal(partial.changes.revenueAllocation.snapshot, null);
  for (const invalid of [NaN, -1]) assert.throws(() => ownerActionDraft('complete_purchase', { ...base(), phase: 'funded', revenuePremint: invalid }));
});

test('zero-premint comparisons remain reviewable and skip initial allocation actions', () => {
  const draft = ownerActionDraft('complete_purchase', { ...base(), phase: 'funded', revenuePremint: 0 });
  assert.equal(draft.eligible, true);
  assert.equal(draft.changes.revenueAllocation.totalRevenuePremint, 0);
  assert.equal(draft.changes.revenueAllocation.skipInitialPremint, true);
  assert.equal(draft.changes.revenuePolicy.atomicRevnetLaunchAndPremintRequired, false);
  assert.match(draft.steps.find(item => item.id === 'premint_revenue_once').description, /Skip autoIssueFor/);
  assert.equal(ownerActionDraft('enable_refunds', { ...base(), revenuePremint: 0 }).eligible, true);
});

test('missing Sticky economics stay unknown instead of becoming default facts', () => {
  const draft = ownerActionDraft('complete_purchase', {
    ...base(), phase: 'funded', revPrice: 0.1, issuanceCutPercent: 5, issuanceCutMonths: 3, issuanceCutYears: 2,
    operatorSplitPercent: 75, ongoingOperatorSplitPercent: 75,
  });
  assert.deepEqual(draft.changes.revenuePolicy.stages, []);
  assert.equal(draft.changes.revenuePolicy.fundStickyPercentOfTotalIssuance, null);
  assert.equal(draft.changes.fundSticky.modeledVestingMonths, null);
  assert.equal(draft.changes.fundSticky.modeledPersonalStakePercent, null);
  assert.equal(draft.changes.fundSticky.modeledOtherStakePercent, null);
  assert.match(draft.steps.find(item => item.id === 'snapshot_all_fund').description, /before enabling revenue payments/);
  assert.match(draft.steps.find(item => item.id === 'snapshot_all_fund').description, /without counting both/);
});

test('a known prior purchase or premint blocks replay of the complete success sequence', () => {
  for (const field of ['purchaseCompleted', 'operatorFundMinted', 'revenuePreminted']) {
    const draft = ownerActionDraft('complete_purchase', { ...base(), phase: 'funded', [field]: true });
    assert.equal(draft.eligible, false);
    assert(draft.blockedReasons.some(item => item.includes('Reconcile')));
  }
});

test('operator allocation can be changed or omitted without inventing a second mint', () => {
  const state = base();
  const customMint = state.fundInvestorSupply * 25 / 75;
  const custom = ownerActionDraft('complete_purchase', { ...state, phase: 'funded', operatorFundPercent: 25, fundOperatorMint: customMint, fundTotalSupply: state.fundInvestorSupply + customMint });
  assert.equal(custom.changes.operatorPostMintPercent, 25);
  const noOperator = ownerActionDraft('complete_purchase', { ...state, phase: 'funded', operatorFundPercent: 0, fundOperatorMint: 0, fundTotalSupply: state.fundInvestorSupply });
  assert.equal(noOperator.steps.some(item => item.id === 'enable_operator_mint'), false);
  assert.equal(noOperator.steps.some(item => item.id === 'mint_operator_fund'), false);
  assert.equal(noOperator.changes.revenueAllocation.fundTokensBurned, 0);
});

test('inconsistent premint economics cannot pass review validation', () => {
  assert.throws(() => ownerActionDraft('complete_purchase', { ...base(), phase: 'funded', operatorFundPercent: 100 }));
  assert.throws(() => ownerActionDraft('complete_purchase', { ...base(), phase: 'funded', fundOperatorMint: 100 }));
  assert.throws(() => ownerActionDraft('complete_purchase', { ...base(), phase: 'funded', fundTotalSupply: 500 }));
});

test('sale drafts require actual proceeds and add them without new issuance', () => {
  const draft = ownerActionDraft('enable_sale_redemptions', { ...base(), phase: 'earning', saleProceedsReceived: true, netSaleProceeds: 475_000 });
  assert.equal(draft.changes.saleDeposit.method, 'addToBalanceOf');
  assert.equal(draft.changes.saleDeposit.netDisplayUSDC, 475_000);
  assert.equal(draft.changes.saleDeposit.mintsFund, false);
  assert.equal(draft.changes.operatorFundMint, 0);
  assert.equal(draft.changes.revenuePremint, 0);
  assert.equal(draft.changes.fundRulesetMetadata.cashOutTaxRate, 0);
  assert.equal(ownerActionDraft('enable_sale_redemptions', { ...base(), phase: 'earning', saleProceedsReceived: false }).eligible, false);
  const unknown = ownerActionDraft('enable_sale_redemptions', { ...base(), phase: 'earning' });
  assert.equal(unknown.changes.saleDeposit.netDisplayUSDC, null);
  assert(unknown.requiresVerification.some(item => item.includes('actual netSaleProceeds')));
});

test('draft creation is deterministic and leaves source state unchanged', () => {
  const state = Object.freeze({ ...base(), phase: 'funded', completedOwnerActions: Object.freeze(['close_raise']) });
  const first = ownerActionDraft('complete_purchase', state);
  const second = ownerActionDraft('complete_purchase', state);
  assert.deepEqual(first, second);
  assert.equal(state.phase, 'funded');
  assert.deepEqual(state.completedOwnerActions, ['close_raise']);
});

test('default owner stages match quarterly model rates and leave every destination unlocked through the flat final stage', () => {
  const projection = projectNetwork({}, 'funded');
  const policy = ownerActionDraft('complete_purchase', projection).changes.revenuePolicy;
  assert.equal(policy.issuanceCutPercent, 5);
  assert.equal(policy.issuanceCutMonths, 3);
  assert.equal(policy.issuanceCutYears, 2);
  assert.equal(policy.numberOfIssuanceCuts, 8);
  assert.equal(policy.fundHolderPercentOfTotalIssuance, 15);
  assert.equal('fundStickyPercentOfTotalIssuance' in policy, false);
  assert.equal('annualIssuanceCutPercent' in policy, false);
  assert.deepEqual(policy.stages.map(stage => stage.startsAfterMonths), [0, 3, 6, 9, 12, 15, 18, 21, 24]);
  policy.stages.forEach((stage, index) => {
    assert.equal(stage.durationMonths, index === 8 ? null : 3);
    assert.equal(stage.issuanceRevPerUSDC, projection.history[index * 3].currentIssuanceRate);
    assert.equal(stage.issuancePriceUSDC, projection.history[index * 3].currentIssuancePrice);
    assert.equal(stage.fundHolderTokenPercent, 15);
    assert.equal(stage.reservedSplitGroup.operator, 833_333_333);
    assert.equal(stage.reservedSplitGroup.fundHolders, 166_666_667);
    assert.equal(stage.reservedSplitGroup.lockBothSplitsInEveryStage, false);
    assert.equal(stage.reservedSplitGroup.lockedUntil, 0);
  });
});

test('automatic holder owner drafts specify the missing integration without creating a Sticky custody project', () => {
  const draft = ownerActionDraft('complete_purchase', projectNetwork({}, 'funded'));
  assert.equal(draft.executable, false);
  assert.equal('fundSticky' in draft.changes, false);
  assert.equal(draft.steps.some(step => /sticky|unstaking/.test(step.id)), false);
  const rewards = draft.changes.fundHolderRewards;
  assert.equal(rewards.implementationStatus, 'unimplemented_specification');
  assert.equal(rewards.requiresStaking, false);
  assert.equal(rewards.createsCustodyProject, false);
  assert.equal(rewards.modeledVestingMonths, 0);
  assert.equal(rewards.includesOperatorFund, true);
  assert.equal(rewards.includesUnclaimedFundCredits, true);
  assert.equal(rewards.transfersAffectFutureRewardsOnly, true);
  assert.equal(rewards.priorRewardsStayWithEarnedHolder, true);
  assert.equal(rewards.integration.distributor, null);
  assert.equal(rewards.integration.existingStickyRouteSupportsThis, false);
  assert.ok(draft.requiresVerification.some(text => text.includes('Implement and verify a distributor')));
  const sale = ownerActionDraft('enable_sale_redemptions', projectNetwork({}, 'earning'));
  assert.equal(sale.steps.some(step => step.id === 'prepare_holder_unstaking'), false);
  assert.equal(sale.changes.fundHolderRewards.requiresStaking, false);
});

test('owner schedules reject invalid cut periods and non-finite compounded rates', () => {
  for (const inputs of [{ issuanceCutMonths: 0 }, { issuanceCutMonths: 1.5 }, { issuanceCutMonths: 361 }, { issuanceCutPercent: 100 }, { fundRewardMode: 'unknown' }]) {
    assert.throws(() => ownerActionDraft('complete_purchase', { ...projectNetwork({}, 'funded'), ...inputs }));
  }
  assert.throws(() => ownerActionDraft('complete_purchase', { ...projectNetwork({}, 'funded'), issuanceCutPercent: 99.99999999999999, issuanceCutYears: 30, issuanceCutMonths: 1 }));
});


test('current UI policy separates unrestricted initial claims from stock Sticky snapshot rewards', () => {
  const projection = projectNetwork({ raisedPercent: 100 }, 'funded');
  const before = JSON.stringify(projection);
  const legacy = ownerActionDraft('complete_purchase', projection);
  const draft = plannedOwnerActionDraft('complete_purchase', projection);
  assert.equal(JSON.stringify(projection), before);
  assert.equal(draft.executable, false);
  assert.equal(draft.changes.operatorFundMint, legacy.changes.operatorFundMint);
  assert.equal(draft.changes.revenueAllocation.totalRevenuePremint, 500_000);
  assert.equal(draft.changes.revenueAllocation.includesOperatorFund, true);
  assert.equal(draft.changes.revenueAllocation.includesUnclaimedFundCredits, true);
  assert.equal(draft.changes.revenueAllocation.requiresActivation, false);
  assert.equal(draft.changes.revenueAllocation.requiresStaking, false);
  assert.equal(draft.changes.revenueAllocation.vestingMonths, 0);
  assert.equal(draft.changes.fundSticky.requiresStaking, true);
  assert.equal(draft.changes.fundSticky.eligibilityPolicy, 'snapshot-share-balance');
  assert.equal(draft.changes.fundSticky.minimumStakeAgeSeconds, 0);
  assert.equal(draft.changes.fundSticky.vestingRounds, 4);
  assert.equal(draft.changes.fundSticky.roundSeconds, 604_800);
  assert.equal(Object.hasOwn(draft.changes.fundSticky, 'vestingSeconds'), false);
  assert.equal(draft.changes.fundSticky.vestingStartsAt, 'reward-claim-round');
  assert.equal(draft.changes.fundSticky.enabled, false);
  assert.equal(draft.changes.fundSticky.runtimeAvailability, 'requires-verified-deployment');
  assert.equal(draft.changes.fundSticky.projectId, null);
  assert.equal('fundHolderRewards' in draft.changes, false);
  assert.equal('productionVesting' in draft.changes.fundSticky, false);
  assert.equal('modeledVestingMonths' in draft.changes.fundSticky, false);
  assert.deepEqual(draft.changes.revenuePolicy.stages.map(stage => stage.issuanceRevPerUSDC), legacy.changes.revenuePolicy.stages.map(stage => stage.issuanceRevPerUSDC));
  assert(draft.steps.some(item => item.id === 'prepare_fund_sticky'));
  assert(draft.steps.some(item => item.id === 'configure_sticky_reward_route'));
  assert.doesNotMatch(JSON.stringify(draft), /automatic_fund_holders|No FUND staking|four-round|weekly reward snapshots/);
  const snapshot = draft.steps.find(item => item.id === 'snapshot_all_fund');
  assert.match(snapshot.description, /inactive ERC20 balances and unclaimed token credits/);
  assert.match(snapshot.description, /no activation, staking or vesting/);
});

test('current sale review explains Sticky recovery without changing initial claims or minting tokens', () => {
  const projection = projectNetwork({}, 'earning');
  const draft = plannedOwnerActionDraft('enable_sale_redemptions', projection);
  assert.equal(draft.executable, false);
  assert.equal(draft.changes.revenuePremint, 0);
  assert.equal(draft.changes.operatorFundMint, 0);
  assert.equal(draft.changes.saleDeposit.mintsFund, false);
  assert.equal(draft.changes.fundSticky.eligibilityPolicy, 'snapshot-share-balance');
  assert.equal(draft.changes.fundSticky.minimumStakeAgeSeconds, 0);
  assert.equal(draft.changes.fundSticky.vestingRounds, 4);
  assert.equal(draft.changes.fundSticky.roundSeconds, 604_800);
  assert.equal(Object.hasOwn(draft.changes.fundSticky, 'vestingSeconds'), false);
  assert.equal(draft.changes.fundSticky.vestingStartsAt, 'reward-claim-round');
  assert.equal(draft.changes.fundSticky.enabled, false);
  assert.equal(draft.changes.fundSticky.runtimeAvailability, 'requires-verified-deployment');
  assert(draft.steps.some(item => item.id === 'prepare_holder_unstaking'));
  assert.doesNotMatch(JSON.stringify(draft), /no unstaking is required|four-round|weekly reward snapshots/);
});
