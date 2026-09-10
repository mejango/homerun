import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_NETWORK, projectNetwork } from '../web/network-model.mjs';

const close = (actual, expected, tolerance = 1e-7) => {
  assert.ok(Number.isFinite(actual), `expected a finite number, received ${actual}`);
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} differs from ${expected}`);
};

const floorCents = value => Math.floor((value + 1e-9) * 100) / 100;
const flat = { rentGrowthPercent: 0, costGrowthPercent: 0 };
const oldScenario = {
  fundRewardMode: 'staking', issuanceCutMonths: 12, issuanceCutYears: 5,
  operatorFundPercent: 10,
  revenuePremint: 1_500_000, operatorSplitPercent: 80, ongoingOperatorSplitPercent: 70, stickySplitPercent: 0,
};
const stakingScenario = {
  fundRewardMode: 'staking',
  ...flat, purchaseBudget: 1_000, opsReserve: 0, payoutFeePercent: 0,
  investment: 250, operatorFundPercent: 20, revenuePremint: 1_000,
  monthlyRent: 1_000, monthlyCosts: 0, issuanceCutPercent: 0,
  operatorSplitPercent: 85, ongoingOperatorSplitPercent: 85, stickySplitPercent: 10,
  personalStakePercent: 100, otherStakePercent: 100, stickyVestingMonths: 1,
};
const pendingOnlyScenario = {
  ...stakingScenario, revenuePremint: 0,
  operatorSplitPercent: 0, ongoingOperatorSplitPercent: 0, stickySplitPercent: 100,
};
const preclosing = ['raising', 'funded', 'refunding', 'refunded'];

test('the raise covers closing, the operating reserve, terminal fees, and money already spent', () => {
  const inputs = { closingCosts: 12_345.67, precloseSpent: 3_210.45 };
  const state = projectNetwork(inputs, 'funded');
  const netRequired = state.purchaseBudget + state.opsReserve + inputs.closingCosts;
  const grossRequired = Math.ceil(netRequired / 0.975 * 100) / 100;
  close(state.closingGrossRequired, grossRequired);
  close(state.raiseGoal, grossRequired + inputs.precloseSpent);
  close(state.raised, state.raiseGoal);
  close(state.escrowCash, grossRequired);
  close(state.closingFeeEstimate, grossRequired - netRequired);
  assert.ok(state.escrowCash * 0.975 >= netRequired - 0.001);
});

test('raising issues investor FUND immediately and shows the operator mint as a future allocation', () => {
  const state = projectNetwork();
  close(state.raised, state.raiseGoal * 0.6, 0.005);
  close(state.fundInvestorSupply, state.raised * 10_000);
  close(state.fundSupply, state.fundInvestorSupply);
  close(state.fundOperatorMint / state.fundTotalSupply * 100, 20);
  close(state.fundTotalSupply, state.fundInvestorSupply + state.fundOperatorMint);
  assert.equal(state.personalFundTokens, 100_000_000);
  close(state.personalFundPercent, 100 * state.investment / state.raised);
  assert.equal(state.operatorFundMinted, false);
  assert.equal(state.revenuePreminted, false);
  assert.equal(state.purchaseCompleted, false);
});

test('closing mints the operator share and distributes REV across the resulting FUND supply', () => {
  const before = projectNetwork({}, 'funded');
  const closed = projectNetwork({ revenueMonths: 0 }, 'earning');
  assert.equal(before.operatorFundMinted, false);
  assert.equal(before.revenuePreminted, false);
  assert.equal(before.purchaseCompleted, false);
  assert.equal(before.personalRevTokens, 0);
  assert.equal(closed.operatorFundMinted, true);
  assert.equal(closed.revenuePreminted, true);
  assert.equal(closed.purchaseCompleted, true);
  close(closed.fundSupply, closed.fundTotalSupply);
  close(closed.personalFundPercent, before.personalFundPercent * 0.8);
  close(closed.personalRevTokens, closed.revenuePremint * closed.personalFundTokens / closed.fundSupply);
  close(closed.revInvestorTokens, 400_000);
  close(closed.revOperatorTokens, 100_000);
  close(closed.revSupply, 500_000);
  close(closed.personalPremintTokens, closed.personalRevTokens);
  assert.equal(closed.personalStickyTokens, 0);
  assert.equal(closed.personalPendingStickyTokens, 0);
  assert.equal(closed.revRenterTokens, 0);
  assert.equal(closed.revCash, 0);
  assert.equal(closed.escrowCash, 0);
  assert.equal(closed.opsReserveCash, 100_000);
});

test('preclosing FUND cash-outs use the tax curve and refunds use the cash remaining after spending', () => {
  const inputs = {
    purchaseBudget: 1_000, opsReserve: 0, payoutFeePercent: 0,
    investment: 100, raisedPercent: 100, precloseSpent: 100,
  };
  const raising = projectNetwork(inputs, 'raising');
  const share = raising.personalFundTokens / raising.fundSupply;
  close(raising.personalFundCashout, floorCents(raising.escrowCash * share * (0.9 + 0.1 * share)));
  const refunding = projectNetwork(inputs, 'refunding');
  const refundable = refunding.raised - inputs.precloseSpent;
  close(refunding.refundableCash, refundable);
  close(refunding.personalRefund, floorCents(refundable * share));
  close(refunding.personalFundCashout, refunding.personalRefund);
  assert.ok(refunding.personalRefund < inputs.investment);
  assert.ok(refunding.personalFundCashout > raising.personalFundCashout);
  const refunded = projectNetwork(inputs, 'refunded');
  assert.equal(refunded.escrowCash, 0);
  assert.equal(refunded.refundableCash, 0);
  close(refunded.refundedCash, refundable);
  close(refunded.personalRefund, refunding.personalRefund);
  assert.equal(refunded.fundSupply, 0);
  assert.equal(refunded.personalFundTokens, 0);
  assert.equal(refunded.personalFundPercent, 0);
  assert.equal(refunded.personalFundCashout, 0);
  close(refunded.historicalPersonalFundTokens, refunding.personalFundTokens);
});

test('a holder of the whole preclosing FUND supply can claim the full escrow under the tax curve', () => {
  const state = projectNetwork({
    purchaseBudget: 1_000, opsReserve: 0, payoutFeePercent: 0,
    investment: 1_000, raisedPercent: 100,
  }, 'raising');
  assert.equal(state.personalFundCashout, 1_000);
  assert.equal(state.personalFundPercent, 100);
});

test('escrow and refund phases have no current REV cash, token claims, or loan proceeds', () => {
  for (const phase of preclosing) {
    const state = projectNetwork({}, phase);
    for (const field of [
      'monthsApplied', 'revCash', 'revSupply', 'revInvestorTokens', 'revOperatorTokens',
      'revRenterTokens', 'personalRevTokens', 'personalCashout', 'personalLoanPrincipal',
      'personalLoanCash', 'personalLoanFees', 'nextMonthLoanCash', 'nextMonthLoanCashIncrease',
      'personalPremintTokens', 'personalStickyTokens', 'personalPendingStickyTokens',
      'personalStakedFundTokens', 'eligibleStakedFundTokens', 'personalStickySharePercent',
      'revStickyPendingTokens', 'revStickyUnallocatedTokens', 'stickyPendingTokens', 'stickyUnallocatedTokens',
      'cumulativeStickyMinted', 'currentStickySplitPercent', 'currentRenterSplitPercent',
    ]) assert.equal(state[field], 0, `${phase}: ${field}`);
    assert.equal(state.loanAvailable, false, phase);
  }
  for (const phase of ['funded', 'earning']) {
    assert.equal(projectNetwork({}, phase).personalFundCashout, 0, phase);
  }
});

test('the operating reserve pays expenses before any operator REV is redeemed', () => {
  const state = projectNetwork({ ...oldScenario, ...flat, revenueMonths: 1 }, 'earning');
  // $10,000 mints 100,000 REV: ops owns 150,000 + 80,000 of 1,600,000 REV.
  assert.equal(state.cumulativeRent, 10_000);
  assert.equal(state.cumulativeCosts, 6_000);
  close(state.lastOpsCashFromRevnet, 0);
  close(state.lastOpsFromReserve, 6_000);
  close(state.revCash, 10_000);
  close(state.opsReserveCash, 94_000);
  close(state.revSupply, 1_600_000);
  close(state.revInvestorTokens, 1_350_000);
  close(state.revRenterTokens, 20_000);
  close(state.revOperatorTokens, 230_000);
  assert.equal(state.unpaidOps, 0);
});

test('explicit annual issuance changes at elapsed annual boundaries while the old split changes after year one', () => {
  const at = month => projectNetwork({ ...oldScenario, ...flat, revenueMonths: month }, 'earning');
  close(at(11).currentIssuanceRate, 10, 1e-10);
  close(at(12).currentIssuanceRate, 9.5, 1e-10);
  close(at(13).currentIssuanceRate, 9.5, 1e-10);
  close(at(24).currentIssuanceRate, 10 * 0.95 ** 2, 1e-10);
  close(at(25).currentIssuanceRate, 10 * 0.95 ** 2, 1e-10);
  close(at(60).currentIssuanceRate, 10 * 0.95 ** 5, 1e-10);
  close(at(61).currentIssuanceRate, 10 * 0.95 ** 5, 1e-10);
  close(at(120).currentIssuanceRate, at(61).currentIssuanceRate, 1e-10);
  assert.equal(at(12).currentOperatorSplitPercent, 80);
  assert.equal(at(13).currentOperatorSplitPercent, 70);
  assert.equal(at(120).currentOperatorSplitPercent, 70);
});

test('annual rent and cost growth begin with the thirteenth monthly payment', () => {
  const yearOne = projectNetwork({ revenueMonths: 12 }, 'earning');
  const yearTwo = projectNetwork({ revenueMonths: 13 }, 'earning');
  assert.equal(yearOne.lastMonthRent, 10_000);
  assert.equal(yearOne.lastMonthCosts, 6_000);
  assert.equal(yearTwo.lastMonthRent, 10_300);
  assert.equal(yearTwo.lastMonthCosts, 6_180);
  close(yearTwo.cumulativeRent - yearOne.cumulativeRent, 10_300);
  close(yearTwo.cumulativeCosts - yearOne.cumulativeCosts, 6_180);
});

test('quarterly issuance applies eight compounded cuts at months 3 through 24, then remains fixed', () => {
  const state = projectNetwork({ ...flat, revenueMonths: 120, monthlyCosts: 0, revenuePremint: 0 }, 'earning');
  for (const [month, cuts] of [[0, 0], [2, 0], [3, 1], [6, 2], [23, 7], [24, 8], [25, 8], [120, 8]]) {
    const row = state.history[month];
    close(row.currentIssuanceRate, 10 * 0.95 ** cuts, 1e-12);
    close(row.currentIssuancePrice, 0.1 / 0.95 ** cuts, 1e-12);
    close(row.currentIssuanceRate * row.currentIssuancePrice, 1, 1e-12);
    assert.equal(row.issuanceCutsApplied, cuts);
  }
  for (let month = 1; month <= 25; month++) {
    const row = state.history[month];
    const expected = 100_000 * 0.95 ** Math.min(Math.floor(month / 3), 8);
    close(row.cumulativeRevMinted - state.history[month - 1].cumulativeRevMinted, expected, 1e-8);
    close(row.revSupply, row.cumulativeRevMinted, 1e-7);
  }
});

test('all FUND holders automatically receive their reward share without staking or vesting', () => {
  const inputs = { ...stakingScenario, fundRewardMode: 'holders', revenueMonths: 1 };
  const state = projectNetwork({ ...inputs, personalStakePercent: 0, otherStakePercent: 0, stickyVestingMonths: 36 }, 'earning');
  const ordinary = projectNetwork(inputs, 'earning');
  close(state.personalFundRewardTokens, 200);
  close(state.personalRevTokens, 400);
  close(state.cumulativeOperatorFundRewards, 200);
  close(state.cumulativeOtherInvestorFundRewards, 600);
  close(state.cumulativeFundRewardsAllocated, 1_000);
  close(state.revInvestorTokens, 1_600);
  close(state.revOperatorTokens, 8_900);
  close(state.revRenterTokens, 500);
  close(state.revSupply, 11_000);
  close(state.personalFundRewardSharePercent, 20);
  close(state.eligibleFundRewardTokens, state.fundSupply);
  for (const key of ['personalPendingFundRewardTokens', 'revStickyPendingTokens', 'stickyUnallocatedTokens', 'personalStakedFundTokens', 'eligibleStakedFundTokens']) assert.equal(state[key], 0, key);
  for (const key of ['personalRevTokens', 'personalCashout', 'personalLoanCash', 'revSupply', 'revInvestorTokens', 'revOperatorTokens']) close(state[key], ordinary[key]);
  close(state.personalFundTokens, 2_500_000);
  close(state.personalPremintTokens, 200);
});

test('automatic operator holder rewards may fund expenses while other holders keep their full allocation', () => {
  const state = projectNetwork({ ...pendingOnlyScenario, fundRewardMode: 'holders', monthlyCosts: 1_000, revenueMonths: 1 }, 'earning');
  close(state.lastOpsCashFromRevnet, 200);
  close(state.revCash, 800);
  close(state.revOperatorTokens, 0);
  close(state.revInvestorTokens, 8_000);
  close(state.personalFundRewardTokens, 2_000);
  close(state.personalCashout, 200);
  close(state.personalLoanCash, 188);
  assert.equal(state.personalPendingFundRewardTokens, 0);
});

test('the baseline consumes the reserve before operations fund subsequent costs', () => {
  const state = projectNetwork({ revenueMonths: 120 }, 'earning');
  close(state.reserveNeeded, 100_000);
  close(state.opsReserveCash, 100_000 - state.reserveNeeded);
  assert.equal(state.unpaidOps, 0);
  assert.equal(state.firstUnfundedMonth, null);
  assert.ok(state.revOperatorTokens > 0);
  close(state.lastOpsCashFromRevnet, state.lastMonthCosts);
  assert.equal(state.lastOpsFromReserve, 0);
});

test('the old $150,000 scenario covers later costs after spending its reserve, including REV fees', () => {
  const state = projectNetwork({ ...oldScenario, ...flat, revCashoutFeePercent: 2.5, revenueMonths: 120 }, 'earning');
  close(state.reserveNeeded, 100_000);
  close(state.opsReserveCash, 0);
  close(state.minimumOpsReserveCash, state.opsReserveCash);
  assert.equal(state.unpaidOps, 0);
  assert.equal(state.firstUnfundedMonth, null);
  assert.equal(state.lastOpsCashFromRevnet, 6_000);
  assert.equal(state.lastOpsFromReserve, 0);
  assert.ok(state.cumulativeFees > 0);
});

test('spending the reserve first supports the old $200,000 scenario with and without fees', () => {
  const inputs = { ...oldScenario, ...flat, revenuePremint: 2_000_000, revenueMonths: 120 };
  const free = projectNetwork(inputs, 'earning');
  close(free.reserveNeeded, 100_000);
  assert.equal(free.opsReserveCash, 0);
  assert.equal(free.unpaidOps, 0);
  const charged = projectNetwork({ ...inputs, revCashoutFeePercent: 2.5 }, 'earning');
  close(charged.reserveNeeded, 100_000);
  assert.equal(charged.opsReserveCash, 0);
  assert.equal(charged.unpaidOps, 0);
  assert.ok(charged.cumulativeFees > 0);
  assert.ok(charged.revOperatorTokens < free.revOperatorTokens);
  assert.equal(charged.firstUnfundedMonth, null);
});

test('zero operator FUND allocation removes the initial ops REV without removing future reserved issuance', () => {
  const inputs = { ...oldScenario, ...flat, operatorFundPercent: 0 };
  const closing = projectNetwork({ ...inputs, revenueMonths: 0 }, 'earning');
  assert.equal(closing.fundOperatorMint, 0);
  close(closing.fundSupply, closing.fundInvestorSupply);
  assert.equal(closing.revOperatorTokens, 0);
  assert.equal(closing.revInvestorTokens, 1_500_000);
  const firstRent = projectNetwork({ ...inputs, revenueMonths: 1 }, 'earning');
  close(firstRent.lastOpsCashFromRevnet, 0);
  close(firstRent.lastOpsFromReserve, 6_000);
  close(firstRent.revOperatorTokens, 80_000);
  assert.equal(firstRent.unpaidOps, 0);
});

test('REV ownership cannot pay costs without cash and reserve exhaustion records unpaid operations', () => {
  const state = projectNetwork({ ...flat, monthlyRent: 0, revenueMonths: 18 }, 'earning');
  assert.equal(state.revCash, 0);
  assert.equal(state.cumulativeOpsFromRevnet, 0);
  assert.equal(state.cumulativeOpsFromReserve, 100_000);
  assert.equal(state.opsReserveCash, 0);
  assert.equal(state.unpaidOps, 8_000);
  assert.equal(state.history[18].reserveNeeded, 108_000);
  assert.equal(state.reserveNeeded, 720_000, 'reserve diagnostics include the full 120-month projection');
  assert.equal(state.minimumOpsReserveCash, 0);
  assert.equal(state.firstUnfundedMonth, 17);
  assert.equal(state.personalCashout, 0);
  assert.equal(state.loanAvailable, false);
});

test('renter cash-outs happen after operations and burn only the newly received renter tokens', () => {
  const held = projectNetwork({ ...oldScenario, ...flat, revenueMonths: 1 }, 'earning');
  const redeemed = projectNetwork({ ...oldScenario, ...flat, revenueMonths: 1, renterCashoutPercent: 100 }, 'earning');
  close(redeemed.lastOpsCashFromRevnet, held.lastOpsCashFromRevnet);
  close(redeemed.lastOpsFromReserve, held.lastOpsFromReserve);
  close(redeemed.cumulativeRenterCashouts, 125);
  assert.equal(redeemed.revRenterTokens, 0);
  close(redeemed.revCash, held.revCash - 125);
  close(redeemed.revSupply, held.revSupply - 20_000);
  close(redeemed.revInvestorTokens, held.revInvestorTokens);
});

test('cash, operating costs, and outstanding REV reconcile across renter and fee scenarios', () => {
  for (const renterCashoutPercent of [0, 35, 100]) {
    for (const revCashoutFeePercent of [0, 2.5]) {
      const state = projectNetwork({ renterCashoutPercent, revCashoutFeePercent, revenueMonths: 120 }, 'earning');
      for (const row of [state, ...state.history]) {
        close(row.cumulativeRent, row.revCash + row.cumulativeOpsFromRevnet
          + row.cumulativeRenterCashouts + row.cumulativeFees);
        close(row.cumulativeCosts, row.cumulativeOpsFromRevnet + row.cumulativeOpsFromReserve + row.unpaidOps);
        close(row.revSupply, row.revInvestorTokens + row.revOperatorTokens + row.revRenterTokens
          + row.revStickyPendingTokens + row.revStickyUnallocatedTokens, 1e-5);
        close(row.revSupply, state.revenuePremint + row.cumulativeRevMinted - row.cumulativeRevBurned, 1e-5);
        assert.ok(row.revCash >= 0);
        assert.ok(row.opsReserveCash >= 0);
        assert.ok(row.unpaidOps >= 0);
      }
    }
  }
});

test('loan quotes use only the personal REV claim and deduct six percent with cent flooring', () => {
  const inputs = { revenueMonths: 12, investment: 1_234.56 };
  const snapshot = { ...inputs };
  const state = projectNetwork(inputs, 'earning');
  close(state.personalLoanPrincipal, floorCents(state.revCash * state.personalRevTokens / state.revSupply));
  close(state.personalLoanCash, floorCents(state.personalLoanPrincipal * 0.94));
  close(state.personalLoanFees + state.personalLoanCash, state.personalLoanPrincipal);
  assert.equal(state.loanAvailable, state.personalLoanCash > 0);
  assert.ok(state.personalLoanPrincipal <= state.revCash);
  const next = projectNetwork({ ...inputs, revenueMonths: 13 }, 'earning');
  close(state.nextMonthLoanCash, next.personalLoanCash);
  close(state.nextMonthLoanCashIncrease, next.personalLoanCash - state.personalLoanCash);
  assert.deepEqual(inputs, snapshot);
  assert.deepEqual(projectNetwork(inputs, 'earning'), state);
});

test('zero investment receives neither FUND nor REV cash claims or loan cash', () => {
  for (const phase of ['raising', 'refunding', 'refunded', 'earning', 'liquidated']) {
    const state = projectNetwork({ investment: 0 }, phase);
    for (const field of [
      'personalFundTokens', 'personalFundPercent', 'personalRevTokens', 'personalFundCashout',
      'personalCashout', 'personalRefund', 'personalLoanCash', 'personalFundSaleClaim',
    ]) assert.equal(state[field], 0, `${phase}: ${field}`);
    assert.equal(state.loanAvailable, false);
  }
});

test('liquidation returns the unused reserve once and allocates sale cash through FUND', () => {
  const inputs = {
    ...flat, revenueMonths: 120, revCashoutFeePercent: 2.5,
    salePrice: 700_000, saleCostPercent: 5, saleDebt: 125_000,
  };
  const earning = projectNetwork(inputs, 'earning');
  const sale = projectNetwork(inputs, 'liquidated');
  const expected = 700_000 * 0.95 - 125_000 - earning.unpaidOps + earning.opsReserveCash;
  assert.equal(earning.fundSaleCash, 0);
  assert.equal(earning.reserveReturnedToFund, 0);
  close(sale.netSaleProceeds, expected);
  close(sale.fundSaleCash, expected);
  close(sale.reserveReturnedToFund, earning.opsReserveCash);
  assert.equal(sale.opsReserveCash, 0);
  close(sale.personalFundSaleClaim, floorCents(expected * sale.personalFundTokens / sale.fundSupply));
  close(sale.personalFundCashout, sale.personalFundSaleClaim);
  close(sale.revCash, earning.revCash);
  close(sale.revSupply, earning.revSupply);
  assert.equal(sale.escrowCash, 0);
});

test('unpaid operating costs reduce sale proceeds and underwater sales cannot create negative claims', () => {
  const inputs = { ...flat, monthlyRent: 0, revenueMonths: 18, salePrice: 100_000, saleCostPercent: 0 };
  const solvent = projectNetwork(inputs, 'liquidated');
  assert.equal(solvent.unpaidOps, 8_000);
  assert.equal(solvent.netSaleProceeds, 92_000);
  const underwater = projectNetwork({ ...inputs, saleDebt: 100_000 }, 'liquidated');
  assert.equal(underwater.netSaleProceeds, 0);
  assert.equal(underwater.fundSaleCash, 0);
  assert.equal(underwater.personalFundSaleClaim, 0);
});

test('history and milestones project future outcomes without advancing the selected month', () => {
  const state = projectNetwork({ revenueMonths: 0 }, 'earning');
  assert.equal(state.monthsApplied, 0);
  assert.equal(state.cumulativeRent, 0);
  assert.equal(state.opsReserveCash, 100_000);
  assert.equal(state.history[0].month, 0);
  assert.ok(state.history.at(-1).month >= 120);
  assert.deepEqual(state.milestones.map(row => row.month), [6, 12, 24, 60, 120]);
  for (const milestone of state.milestones) {
    const selected = projectNetwork({ revenueMonths: milestone.month }, 'earning');
    close(milestone.revCash, selected.revCash);
    close(milestone.opsReserveCash, selected.opsReserveCash);
    close(milestone.unpaidOps, selected.unpaidOps);
  }
  assert.equal(DEFAULT_NETWORK.revenuePremint, 500_000);
  assert.equal(DEFAULT_NETWORK.operatorFundPercent, 20);
  assert.equal(DEFAULT_NETWORK.operatorSplitPercent, 75);
  assert.equal(DEFAULT_NETWORK.ongoingOperatorSplitPercent, 75);
  assert.equal(DEFAULT_NETWORK.stickySplitPercent, 15);
  assert.equal(DEFAULT_NETWORK.personalStakePercent, 100);
  assert.equal(DEFAULT_NETWORK.otherStakePercent, 100);
  assert.equal(DEFAULT_NETWORK.stickyVestingMonths, 0);
  assert.equal(DEFAULT_NETWORK.fundRewardMode, 'holders');
  assert.equal(DEFAULT_NETWORK.issuanceCutYears, 2);
  assert.equal(DEFAULT_NETWORK.issuanceCutMonths, 3);
});

test('the default pays costs through 30 years of stress after exhausting the reserve', () => {
  const scenarios = [
    { inputs: {}, bridge: 100_000, reserve: 0 },
    { inputs: flat, bridge: 100_000, reserve: 0 },
  ];
  for (const { inputs, bridge, reserve } of scenarios) {
    const state = projectNetwork({
      ...inputs, monthlyRent: 9_000, monthlyCosts: 6_600,
      revCashoutFeePercent: 2.5, revenueMonths: 360,
    }, 'earning');
    assert.equal(state.monthsApplied, 360);
    assert.equal(state.diagnosticHorizonMonths, 361);
    assert.equal(state.history.at(-1).month, 361);
    close(state.reserveNeeded, bridge, 1);
    close(state.minimumOpsReserveCash, reserve, 1);
    close(state.opsReserveCash, state.minimumOpsReserveCash);
    assert.equal(state.cumulativeOpsFromReserve, 100_000);
    assert.equal(state.firstUnfundedMonth, null);
    assert.equal(state.lastOpsFromReserve, 0);
    close(state.lastOpsCashFromRevnet, state.lastMonthCosts);
    assert.ok(state.revOperatorTokens > 0);
    for (const row of state.history) {
      assert.equal(row.unpaidOps, 0, `unpaid costs at month ${row.month}`);
      assert.equal(row.currentOperatorSplitPercent, 75);
      assert.equal(row.currentStickySplitPercent, 15);
      assert.equal(row.currentRenterSplitPercent, 10);
      close(row.cumulativeCosts, row.cumulativeOpsFromRevnet + row.cumulativeOpsFromReserve);
      close(row.cumulativeRent, row.revCash + row.cumulativeOpsFromRevnet
        + row.cumulativeRenterCashouts + row.cumulativeFees);
    }
  }
});

test('a partial raise previews the eventual full-raise REV allocation without overstating the personal share', () => {
  const raising = projectNetwork({ raisedPercent: 20 }, 'raising');
  const funded = projectNetwork({}, 'funded');
  const earning = projectNetwork({}, 'earning');
  close(raising.plannedPersonalRevTokens, earning.personalPremintTokens);
  close(funded.plannedPersonalRevTokens, earning.personalPremintTokens);
  for (const month of [0, 1, 12, 60, 120]) {
    close(raising.history[month].personalCashout, funded.history[month].personalCashout);
    close(raising.history[month].personalLoanCash, funded.history[month].personalLoanCash);
  }
});

test('invalid amounts and schedules fail explicitly instead of creating impossible projections', () => {
  for (const inputs of [
    { purchaseBudget: 0 }, { monthlyRent: -1 }, { monthlyCosts: NaN },
    { investment: Infinity }, { monthlyRent: '10000' }, { monthlyCosts: 0.001 },
    { operatorFundPercent: 100 }, { issuanceCutPercent: 100 },
    { issuanceCutPercent: 99.99999999999999, issuanceCutYears: 30, revenueMonths: 360 },
    { payoutFeePercent: 100 }, { revCashoutFeePercent: 100 },
    { issuanceCutMonths: 0 }, { issuanceCutMonths: 1.5 }, { issuanceCutMonths: 361 }, { fundRewardMode: 'unknown' },
    { issuanceCutYears: 1.5 }, { revenueMonths: 0.5 }, { revenueMonths: 361 },
    { raisedPercent: 0 }, { precloseSpent: 1_000_000, raisedPercent: 1 },
  ]) assert.throws(() => projectNetwork(inputs), undefined, JSON.stringify(inputs));
  assert.throws(() => projectNetwork(null));
  assert.throws(() => projectNetwork([]));
  assert.throws(() => projectNetwork({}, 'unknown'));
});

test('a sub-cent operator entitlement cannot round up and burn more REV than the operator owns', () => {
  const state = projectNetwork({
    monthlyRent: 0.01,
    monthlyCosts: 0.01,
    operatorFundPercent: 0,
    operatorSplitPercent: 100,
    stickySplitPercent: 0,
    investment: 0,
    opsReserve: 0,
    revenuePremint: 0.000001,
    revPrice: 0.000001,
    revenueMonths: 1,
  }, 'earning');
  assert.equal(state.lastOpsCashFromRevnet, 0);
  assert.equal(state.revCash, 0.01);
  assert.equal(state.unpaidOps, 0.01);
  assert.equal(state.revOperatorTokens, 10_000);
  assert.equal(state.cumulativeRevBurned, 0);
  close(state.revSupply, state.revenuePremint + state.cumulativeRevMinted);
});

test('valid large cent-denominated budgets survive floating-point multiplication error', () => {
  const state = projectNetwork({ purchaseBudget: 134_572_149.48, investment: 0 }, 'earning');
  assert.equal(state.purchaseBudget, 134_572_149.48);
  assert.ok(Number.isFinite(state.raiseGoal));
  assert.equal(state.personalCashout, 0);
});

test('the optional staking comparison reserves fifteen percent and keeps pending tokens in supply', () => {
  const state = projectNetwork({ ...flat, fundRewardMode: 'staking', stickyVestingMonths: 1, revenueMonths: 1 }, 'earning');
  // Reserve pays costs; all 500,000 premint + 100,000 new REV remain outstanding.
  close(state.lastOpsCashFromRevnet, 0);
  close(state.lastOpsFromReserve, 6_000);
  close(state.revCash, 10_000);
  close(state.opsReserveCash, 94_000);
  close(state.revSupply, 600_000);
  close(state.revInvestorTokens, 400_000);
  close(state.revOperatorTokens, 175_000);
  close(state.revRenterTokens, 10_000);
  close(state.revStickyPendingTokens, 15_000);
  close(state.cumulativeStickyMinted, 15_000);
  assert.equal(state.personalStickyTokens, 0);
  assert.ok(state.personalPendingStickyTokens > 0);
  close(state.personalRevTokens, state.personalPremintTokens);
});

test('staking changes earned REV without burning FUND or changing the personal premint', () => {
  const unstaked = projectNetwork({ ...stakingScenario, personalStakePercent: 0, revenueMonths: 2 }, 'earning');
  const staked = projectNetwork({ ...stakingScenario, personalStakePercent: 100, revenueMonths: 2 }, 'earning');
  for (const field of ['fundSupply', 'personalFundTokens', 'personalFundPercent', 'personalPremintTokens']) {
    close(staked[field], unstaked[field]);
  }
  close(staked.personalPremintTokens, 200);
  close(staked.personalFundTokens, 2_500_000);
  close(staked.personalStakedFundTokens, staked.personalFundTokens);
  assert.equal(unstaked.personalStakedFundTokens, 0);
  assert.equal(unstaked.personalStickyTokens, 0);
  assert.equal(unstaked.personalPendingStickyTokens, 0);
  close(unstaked.personalRevTokens, 200);
  close(staked.personalStickyTokens, 200);
  close(staked.personalRevTokens, 400);
  assert.ok(staked.personalLoanCash > unstaked.personalLoanCash);
});

test('each staking cohort vests in its due month while newer cohorts remain pending', () => {
  const at = month => projectNetwork({ ...stakingScenario, stickyVestingMonths: 2, revenueMonths: month }, 'earning');
  for (const [month, vested, pending] of [[1, 0, 200], [2, 0, 400], [3, 200, 400], [4, 400, 400]]) {
    const state = at(month);
    close(state.personalStickyTokens, vested);
    close(state.personalPendingStickyTokens, pending);
    close(state.personalRevTokens, 200 + vested);
    close(state.cumulativeStickyMinted, month * 1_000);
    close(state.revStickyPendingTokens, Math.min(month, 2) * 1_000);
    close(state.cumulativeStickyVested, Math.max(0, month - 2) * 1_000);
    close(state.revStickyPendingTokens, state.stickyPendingTokens);
  }
  const immediate = projectNetwork({ ...stakingScenario, stickyVestingMonths: 0, revenueMonths: 1 }, 'earning');
  close(immediate.personalStickyTokens, 200);
  close(immediate.personalRevTokens, 400);
  assert.equal(immediate.personalPendingStickyTokens, 0);
  assert.equal(immediate.revStickyPendingTokens, 0);
  close(immediate.cumulativeStickyVested, 1_000);
});

test('pending-only REV has full supply and cash backing but offers no personal loan before vesting', () => {
  const pending = projectNetwork({ ...pendingOnlyScenario, stickyVestingMonths: 2, revenueMonths: 2 }, 'earning');
  assert.equal(pending.personalPremintTokens, 0);
  assert.equal(pending.personalRevTokens, 0);
  assert.equal(pending.personalStickyTokens, 0);
  close(pending.personalPendingStickyTokens, 4_000);
  close(pending.revStickyPendingTokens, 20_000);
  close(pending.revSupply, 20_000);
  close(pending.revCash, 2_000);
  assert.equal(pending.personalCashout, 0);
  assert.equal(pending.personalLoanPrincipal, 0);
  assert.equal(pending.personalLoanCash, 0);
  assert.equal(pending.loanAvailable, false);
  const vested = projectNetwork({ ...pendingOnlyScenario, stickyVestingMonths: 2, revenueMonths: 3 }, 'earning');
  close(vested.personalRevTokens, 2_000);
  close(vested.personalLoanPrincipal, 200);
  close(vested.personalLoanCash, 188);
  close(pending.nextMonthLoanCash, vested.personalLoanCash);
  assert.equal(vested.loanAvailable, true);
});

test('partial stakes divide rewards by eligible FUND weights including the operator stake', () => {
  const state = projectNetwork({
    ...stakingScenario, personalStakePercent: 50, otherStakePercent: 25,
    stickyVestingMonths: 0, revenueMonths: 1,
  }, 'earning');
  close(state.personalStakedFundTokens, 1_250_000);
  close(state.operatorStakedFundTokens, 625_000);
  close(state.eligibleStakedFundTokens, 3_750_000);
  close(state.personalStickySharePercent, 100 / 3);
  close(state.personalPremintTokens, 200);
  close(state.personalStickyTokens, 1_000 / 3);
  close(state.cumulativeOperatorStickyVested, 1_000 / 6);
  close(state.revOperatorTokens, 200 + 8_500 + 1_000 / 6);
  close(state.revInvestorTokens, 800 + 1_000 * 5 / 6);
  close(state.revSupply, 11_000);
  close(state.personalFundTokens, 2_500_000);
});

test('operators can redeem their vested rewards but cannot use pending or another holder’s rewards', () => {
  const inputs = { ...stakingScenario, monthlyCosts: 1_000,
    operatorSplitPercent: 0, ongoingOperatorSplitPercent: 0, stickySplitPercent: 100, revenueMonths: 1 };
  const delayed = projectNetwork({ ...inputs, stickyVestingMonths: 1 }, 'earning');
  const immediate = projectNetwork({ ...inputs, stickyVestingMonths: 0 }, 'earning');
  close(delayed.lastOpsCashFromRevnet, 18.18);
  close(delayed.revStickyPendingTokens, 10_000);
  close(immediate.lastOpsCashFromRevnet, 200);
  close(immediate.cumulativeOperatorStickyVested, 2_000);
  const operatorUnstaked = projectNetwork({ ...inputs, stickyVestingMonths: 0, otherStakePercent: 0 }, 'earning');
  assert.equal(operatorUnstaked.operatorStakedFundTokens, 0);
  assert.equal(operatorUnstaked.cumulativeOperatorStickyVested, 0);
  close(operatorUnstaked.lastOpsCashFromRevnet, 18.18);
  close(operatorUnstaked.personalStickySharePercent, 100);
  close(operatorUnstaked.personalStickyTokens, 10_000);
});

test('without eligible stakers, rewards remain unallocated supply and never become a holder claim', () => {
  const state = projectNetwork({
    ...pendingOnlyScenario, personalStakePercent: 0, otherStakePercent: 0,
    stickyVestingMonths: 0, revenueMonths: 12,
  }, 'earning');
  assert.equal(state.eligibleStakedFundTokens, 0);
  assert.equal(state.personalStickySharePercent, 0);
  assert.equal(state.personalStickyTokens, 0);
  assert.equal(state.personalPendingStickyTokens, 0);
  assert.equal(state.revStickyPendingTokens, 0);
  assert.equal(state.revInvestorTokens, 0);
  assert.equal(state.revOperatorTokens, 0);
  assert.equal(state.revRenterTokens, 0);
  close(state.revStickyUnallocatedTokens, 120_000);
  close(state.stickyUnallocatedTokens, state.revStickyUnallocatedTokens);
  close(state.revSupply, state.revStickyUnallocatedTokens);
  close(state.cumulativeStickyMinted, state.revStickyUnallocatedTokens);
  assert.equal(state.cumulativeStickyVested, 0);
  assert.equal(state.personalCashout, 0);
  assert.equal(state.personalLoanCash, 0);
  for (const row of state.history) {
    close(row.revSupply, row.revStickyUnallocatedTokens);
    assert.equal(row.cumulativeStickyVested, 0);
    assert.equal(row.personalRevTokens, 0);
  }
});

test('past rewards vest even when the due month has no new rental income', () => {
  const inputs = { ...stakingScenario, rentGrowthPercent: -100 };
  const before = projectNetwork({ ...inputs, revenueMonths: 12 }, 'earning');
  const due = projectNetwork({ ...inputs, revenueMonths: 13 }, 'earning');
  close(before.personalStickyTokens, 2_200);
  close(before.personalPendingStickyTokens, 200);
  assert.equal(due.lastMonthRent, 0);
  close(due.personalStickyTokens, 2_400);
  assert.equal(due.personalPendingStickyTokens, 0);
  close(due.revSupply, before.revSupply);
  close(due.revCash, before.revCash);
  close(due.cumulativeStickyMinted, before.cumulativeStickyMinted);
});

test('staking distributions and vesting do not charge cash-out fees a second time', () => {
  const state = projectNetwork({
    ...stakingScenario, monthlyCosts: 100, revCashoutFeePercent: 2.5,
    stickyVestingMonths: 0, revenueMonths: 3,
  }, 'earning');
  close(state.cumulativeStickyMinted, 3_000);
  close(state.cumulativeStickyVested, 3_000);
  close(state.cumulativeOpsFromRevnet, 300);
  close(state.cumulativeFees, 7.71);
  close(state.revCash, 2_692.29);
  close(state.cumulativeRent, state.revCash + state.cumulativeOpsFromRevnet + state.cumulativeFees);
  const held = projectNetwork({ ...stakingScenario, revCashoutFeePercent: 2.5,
    stickyVestingMonths: 0, revenueMonths: 3 }, 'earning');
  assert.equal(held.cumulativeFees, 0);
  close(held.revCash, held.cumulativeRent);
});

test('liquidation freezes current staking claims and its next loan quote while history stays hypothetical', () => {
  const inputs = { ...pendingOnlyScenario, revenueMonths: 1 };
  const earning = projectNetwork(inputs, 'earning');
  const sold = projectNetwork(inputs, 'liquidated');
  close(sold.personalPendingStickyTokens, 2_000);
  close(sold.personalPendingStickyTokens, earning.personalPendingStickyTokens);
  close(sold.revStickyPendingTokens, earning.revStickyPendingTokens);
  close(sold.revCash, earning.revCash);
  close(sold.revSupply, earning.revSupply);
  assert.equal(sold.personalStickyTokens, 0);
  assert.equal(sold.personalLoanCash, 0);
  assert.equal(sold.nextMonthLoanCash, 0);
  assert.equal(sold.nextMonthLoanCashIncrease, 0);
  assert.ok(earning.nextMonthLoanCash > 0);
  assert.ok(sold.history[2].personalLoanCash > 0, 'future history assumes the property continues earning');
});

test('staking bounds prevent over-allocation and accept a zero premint with the maximum vesting delay', () => {
  for (const inputs of [
    { personalStakePercent: -1 }, { personalStakePercent: 100.01 }, { otherStakePercent: NaN },
    { stickySplitPercent: -1 }, { stickySplitPercent: 101 },
    { operatorSplitPercent: 91, ongoingOperatorSplitPercent: 80, stickySplitPercent: 10 },
    { operatorSplitPercent: 80, ongoingOperatorSplitPercent: 91, stickySplitPercent: 10 },
    { stickyVestingMonths: -1 }, { stickyVestingMonths: 0.5 }, { stickyVestingMonths: 37 },
  ]) assert.throws(() => projectNetwork(inputs));
  assert.doesNotThrow(() => projectNetwork({ ...pendingOnlyScenario, stickyVestingMonths: 36 }, 'earning'));
});


test('a partly depleted reserve leaves only the shortfall for operator cash-outs and fees', () => {
  const state = projectNetwork({ ...flat, opsReserve: 250, revenuePremint: 0,
    monthlyRent: 1000, monthlyCosts: 600, operatorSplitPercent: 100,
    ongoingOperatorSplitPercent: 100, stickySplitPercent: 0,
    revCashoutFeePercent: 2.5, revenueMonths: 1 }, 'earning');
  assert.equal(state.lastOpsFromReserve, 250);
  assert.equal(state.opsReserveCash, 0);
  assert.equal(state.lastOpsCashFromRevnet, 350);
  assert.equal(state.lastMonthFees, 8.98);
  assert.equal(state.revCash, 641.02);
  assert.equal(state.unpaidOps, 0);
  assert.ok(state.revOperatorTokens > 0);
});

test('operator cash-outs begin in the month that the reserve runs out', () => {
  const state = projectNetwork({ ...flat, revenueMonths: 17 }, 'earning');
  assert.equal(state.history[16].opsReserveCash, 4000);
  assert.equal(state.history[16].cumulativeRevBurned, 0);
  assert.equal(state.lastOpsFromReserve, 4000);
  assert.equal(state.lastOpsCashFromRevnet, 2000);
  assert.equal(state.opsReserveCash, 0);
  assert.equal(state.unpaidOps, 0);
  assert.ok(state.cumulativeRevBurned > 0);
});
