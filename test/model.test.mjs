import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_PROPERTY,
  quote,
  depositBacking,
  redeem,
  simulateProperty,
  liquidationRecovery,
  annualizedSingleExit,
  annualizedIRR,
} from '../web/model.mjs';

const base = (overrides = {}) => ({ ...DEFAULT_PROPERTY, ...overrides });
const close = (actual, expected, tolerance = 1e-9) => {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} is not within ${tolerance} of ${expected}`);
};

test('only segregated liquid backing determines the current cash-out quote', () => {
  const state = base();
  const current = quote(state, 10_000);
  close(current.currentPerToken, 0.0928);
  assert.equal(current.cashOutValue, 928);
  assert.equal(current.principalHaircutAmount, 9_072);
  assert.equal(current.targetHaircutAmount, 12_072);
  assert.equal(current.fundingGap, 2_414_400);
  assert.deepEqual(quote(base({ propertyValue: 999_999_999, reserveBalance: 500_000 }), 10_000), current);
});

test('an early proportional burn accepts the loss and leaves the remaining price unchanged', () => {
  const state = base();
  const result = redeem(state, 100_000);
  assert.equal(result.payout, 9_280);
  assert.equal(result.state.tokens, 1_900_000);
  assert.equal(result.state.backing, 176_320);
  assert.equal(result.principalHaircutAmount, 90_720);
  assert.equal(result.remainingClaimForBurnedTokens, 0);
  close(result.beforePrice, result.afterPrice);
  assert.equal(result.state.backing + result.payout, state.backing);
  assert.equal(state.tokens, 2_000_000, 'input is not mutated');
});

test('deposits benefit only remaining tokens and stop at their target', () => {
  const burned = redeem(base(), 100_000).state;
  const funded = depositBacking(burned, 3_000_000);
  assert.equal(funded.investorDeposit, 2_293_680);
  assert.equal(funded.state.backing, 2_470_000);
  assert.equal(funded.sponsorResidual, 706_320);
  assert.equal(quote(funded.state).currentPerToken, 1.3);
  assert.equal(quote(funded.state).targetFunded, true);
  assert.equal(funded.state.tokens, 1_900_000);
});

test('fully funding the target is independent of investor claims', () => {
  const state = depositBacking(base(), 2_414_400).state;
  assert.equal(state.tokens, 2_000_000);
  assert.equal(quote(state).targetFunded, true);
  const first = redeem(state, 123_456);
  assert.equal(quote(first.state).targetFunded, true);
  const final = redeem(first.state, first.state.tokens);
  assert.equal(first.payout + final.payout, 2_600_000);
  assert.equal(final.state.tokens, 0);
  assert.equal(final.state.backing, 0);
  assert.equal(quote(final.state).targetFunded, true);
  assert.equal(quote(final.state).cashOutValue, 0);
  assert.equal(depositBacking(final.state, 200).sponsorResidual, 200);
});

test('cash-outs round down to cents and never use more than available backing', () => {
  const state = base({ tokens: 3, backing: 1 });
  const exit = redeem(state, 1);
  assert.equal(exit.payout, 0.33);
  assert.equal(exit.state.backing, 0.67);
  assert.ok(exit.afterPrice >= exit.beforePrice);
  assert.equal(redeem(exit.state, 2).payout, 0.67);
});

test('a zero-token cash-out is rejected without changing supply or backing', () => {
  const state = base();
  const before = { ...state };
  assert.throws(() => redeem(state, 0), /tokenAmount/);
  assert.deepEqual(state, before);
});

test('tokens cannot burn for a zero payout when there is no backing', () => {
  const state = base({ tokens: 1_000, backing: 0 });
  const before = { ...state };
  assert.equal(quote(state, 1_000).cashOutValue, 0);
  assert.throws(() => redeem(state, 1_000), /Cash-out must pay at least one cent/);
  assert.deepEqual(state, before);
});

test('cash-outs rounded below one cent reject while a payable aggregate exit succeeds', () => {
  const state = base({ tokens: 1_000, backing: 0.01 });
  const before = { ...state };
  assert.ok(quote(state).currentPerToken > 0);
  assert.equal(quote(state, 999).cashOutValue, 0);
  assert.throws(() => redeem(state, 999), /Cash-out must pay at least one cent/);
  assert.deepEqual(state, before);
  const exit = redeem(state, 1_000);
  assert.equal(exit.payout, 0.01);
  assert.equal(exit.state.tokens, 0);
  assert.equal(exit.state.backing, 0);
});

test('the $2 million default does not pretend unchanged illustrative rent funds the target within ten years', () => {
  const result = simulateProperty(base());
  assert.equal(result.months.length, 121);
  assert.equal(result.months[0].backing, 185_600);
  assert.equal(result.months[1].investorDeposit, 6_400);
  assert.equal(result.months[1].sponsorResidual, 1_600);
  assert.equal(result.months[1].reserveBalance, 30_000);
  assert.equal(result.principalFundedMonth, null);
  assert.equal(result.targetFundedMonth, null);
  assert.equal(result.totalTargetMonths, null);
  assert.equal(result.totalInvestorDeposits, 768_000);
  assert.equal(result.totalSponsorResidual, 192_000);
  assert.equal(result.finalState.backing, 953_600);
  assert.equal(result.singleExitAnnualReturn, null);
  assert.equal(quote(result.finalState).currentPerToken, 0.4768);
  close(result.horizonSingleExitAnnualReturn, 0.4768 ** (12 / 149) - 1);
});

test('an extended scenario caps backing, returns excess to sponsor, and includes elapsed holding time', () => {
  const result = simulateProperty(base(), { months: 400 });
  assert.equal(result.principalFundedMonth, 284);
  assert.equal(result.targetFundedMonth, 378);
  assert.equal(result.totalTargetMonths, 407);
  assert.equal(result.months[378].investorDeposit, 1_600);
  assert.equal(result.months[378].sponsorResidual, 6_400);
  assert.equal(result.months[379].investorDeposit, 0);
  assert.equal(result.months[379].sponsorResidual, 8_000);
  assert.equal(result.totalInvestorDeposits, 2_414_400);
  assert.equal(result.finalState.backing, 2_600_000);
  close(result.singleExitAnnualReturn, 1.3 ** (12 / 407) - 1);
  assert.ok(result.singleExitAnnualReturn < annualizedSingleExit(1, 1.3, 378));
});

test('positive cash restores the reserve target before any investor or sponsor allocation', () => {
  const result = simulateProperty(base({ reserveBalance: 20_000 }), { months: 3 });
  assert.equal(result.months[1].reserveTopUp, 8_000);
  assert.equal(result.months[1].investorDeposit, 0);
  assert.equal(result.months[1].sponsorResidual, 0);
  assert.equal(result.months[2].reserveTopUp, 2_000);
  assert.equal(result.months[2].availableCash, 6_000);
  assert.equal(result.months[2].investorDeposit, 4_800);
  assert.equal(result.months[2].sponsorResidual, 1_200);
  assert.equal(result.months[3].reserveTopUp, 0);
  assert.equal(result.months[3].investorDeposit, 6_400);
});

test('vacancy draws operating reserves, reports deficits, and leaves backing inaccessible', () => {
  const result = simulateProperty(base(), { vacancyRate: 1, months: 7 });
  assert.equal(result.months[1].reserveDraw, 6_000);
  assert.equal(result.months[5].reserveBalance, 0);
  assert.equal(result.months[6].operatingShortfall, 6_000);
  assert.equal(result.totalOperatingShortfall, 12_000);
  assert.equal(result.totalInvestorDeposits, 0);
  assert.equal(result.totalSponsorResidual, 0);
  assert.equal(result.finalState.backing, 185_600);
  assert.equal(result.targetFundedMonth, null);
  assert.equal(result.singleExitAnnualReturn, null);
});

test('vacancy and cost stress slow target funding without inventing receipts', () => {
  const normal = simulateProperty(base());
  const stressed = simulateProperty(base(), { vacancyRate: 0.2, expenseIncrease: 0.2 });
  assert.equal(stressed.months[1].grossRent, 11_200);
  assert.equal(stressed.months[1].operatingCosts, 6_000);
  assert.equal(stressed.months[1].capitalCosts, 1_200);
  assert.equal(stressed.months[1].investorDeposit, 3_200);
  assert.equal(stressed.targetFundedMonth, null);
  assert.ok(stressed.finalState.backing < normal.finalState.backing);
  assert.ok(stressed.horizonSingleExitAnnualReturn < normal.horizonSingleExitAnnualReturn);
});

test('every simulated month conserves property cash and never exceeds the investor target', () => {
  for (const scenario of [
    {},
    { vacancyRate: 0.37, expenseIncrease: 0.23 },
    { vacancyRate: 0.9, expenseIncrease: 0.4 },
  ]) {
    const input = base({ reserveBalance: 10_000, investorSweep: 0.713 });
    const result = simulateProperty(input, scenario);
    let previous = result.months[0];
    for (const month of result.months.slice(1)) {
      close(
        month.grossRent + month.reserveDraw + month.operatingShortfall,
        month.operatingCosts + month.capitalCosts + month.reserveTopUp + month.investorDeposit + month.sponsorResidual,
        1e-6,
      );
      close(month.backing - previous.backing, month.investorDeposit, 1e-6);
      close(month.reserveBalance - previous.reserveBalance, month.reserveTopUp - month.reserveDraw, 1e-6);
      assert.ok(month.backing <= input.tokens * input.targetPerToken);
      assert.equal(month.tokens, input.tokens);
      previous = month;
    }
    assert.deepEqual(input, base({ reserveBalance: 10_000, investorSweep: 0.713 }));
  }
});

test('sale recovery deducts costs and senior claims and never adds appraisal to a current quote', () => {
  const input = base({ propertyValue: 400_000, seniorClaims: 100_000 });
  const sale = liquidationRecovery(input);
  assert.equal(sale.saleCosts, 32_000);
  assert.equal(sale.netSaleProceeds, 268_000);
  assert.equal(sale.totalInvestorRecovery, 453_600);
  close(sale.recoveryPerToken, 0.2268);
  assert.equal(sale.principalShortfall, 1_546_400);
  assert.equal(sale.targetShortfall, 2_146_400);
  assert.equal(sale.excludedOperatingReserves, 30_000);
  assert.equal(sale.targetFunded, false);
  assert.equal(quote(input).currentPerToken, 0.0928);
});

test('sale upside is capped, and underwater property cannot subtract segregated backing', () => {
  const upside = liquidationRecovery(base({ tokens: 500_000 }));
  assert.equal(upside.totalInvestorRecovery, 650_000);
  assert.equal(upside.sponsorResidual, 409_600);
  assert.equal(upside.targetFunded, true);
  const underwater = liquidationRecovery(base({ seniorClaims: 1_000_000 }));
  assert.equal(underwater.netSaleProceeds, 0);
  assert.equal(underwater.unpaidSeniorClaims, 126_000);
  assert.equal(underwater.totalInvestorRecovery, 185_600);
  assert.equal(underwater.sponsorResidual, 0);
});

test('the unchanged illustrative property value does not cover the $2 million principal', () => {
  const sale = liquidationRecovery(base());
  assert.equal(sale.grossSaleProceeds, 950_000);
  assert.equal(sale.totalInvestorRecovery, 1_059_600);
  assert.equal(sale.recoveryPerToken, 0.5298);
  assert.equal(sale.principalShortfall, 940_400);
  assert.equal(sale.targetShortfall, 1_540_400);
  assert.equal(sale.sponsorResidual, 0);
  assert.equal(sale.targetFunded, false);
});

test('single redemption annualized return differs from receiving the same money monthly', () => {
  const single = annualizedSingleExit(500_000, 650_000, 120);
  const balloonFlows = [-500_000, ...Array(119).fill(0), 650_000];
  const amortizingFlows = [-500_000, ...Array(120).fill(650_000 / 120)];
  close(annualizedIRR(balloonFlows), single);
  assert.ok(annualizedIRR(amortizingFlows) > single);
  close(single, 0.026583631304232025);
  assert.equal(annualizedSingleExit(500_000, 0, 120), -1);
  assert.equal(annualizedIRR([-500_000, 0, 0]), -1);
  close(annualizedIRR([-100, 0, 100]), 0);
});

test('zero horizon and zero remaining supply have explicit, finite behavior', () => {
  const immediate = simulateProperty(base(), { months: 0 });
  assert.equal(immediate.months.length, 1);
  assert.equal(immediate.targetFundedMonth, null);
  assert.equal(immediate.totalInvestorDeposits, 0);
  const closed = simulateProperty(base({ tokens: 0, backing: 0 }));
  assert.equal(closed.targetFundedMonth, 0);
  assert.equal(closed.singleExitAnnualReturn, null);
  assert.equal(closed.horizonSingleExitAnnualReturn, null);
  assert.equal(closed.totalInvestorDeposits, 0);
  assert.equal(closed.months[1].sponsorResidual, 8_000);
});

test('invalid, non-finite, and economically impossible inputs fail explicitly', () => {
  for (const bad of [NaN, Infinity, -1, '1']) {
    assert.throws(() => quote(base({ backing: bad })));
    assert.throws(() => depositBacking(base(), bad));
  }
  assert.throws(() => quote(base({ issuePrice: 0 })));
  assert.throws(() => quote(base({ targetPerToken: 0.5 })));
  assert.throws(() => redeem(base(), 2_000_001));
  assert.throws(() => redeem(base(), -1));
  assert.throws(() => redeem(base(), 0.25));
  assert.throws(() => quote(base({ targetPerToken: 1.333 })));
  assert.throws(() => depositBacking(base(), 0.001));
  assert.throws(() => simulateProperty(base({ investorSweep: 1.01 })));
  assert.throws(() => simulateProperty(base(), { vacancyRate: 1.01 }));
  assert.throws(() => simulateProperty(base(), { months: 1.5 }));
  assert.throws(() => simulateProperty(base({ monthlyCapitalCosts: undefined })));
  assert.throws(() => annualizedSingleExit(100, 130, 0));
  assert.throws(() => annualizedIRR([-100, 120, -20]));
  assert.throws(() => liquidationRecovery(base({ saleCostRate: 1.1 })));
});
