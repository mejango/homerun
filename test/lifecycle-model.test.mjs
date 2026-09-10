import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SCENARIO, LOAN_FEE_ASSUMPTIONS, projectScenario } from '../web/lifecycle-model.mjs';

const close = (actual, expected, tolerance = 1e-9) => {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} differs from ${expected}`);
};

test('raising keeps actual subscriptions in escrow with no property-token cash-out', () => {
  const state = projectScenario({}, 'raising');
  assert.equal(state.goal, 2_000_000);
  assert.equal(state.raised, 1_200_000);
  assert.equal(state.escrowCash, 1_200_000);
  assert.equal(state.capitalDeployed, 0);
  assert.equal(state.backingCash, 0);
  assert.equal(state.hasTokenClaims, false);
  assert.equal(state.personalCashout, 0);
  assert.equal(state.personalRefund, 0);
  assert.equal(state.monthsApplied, 0);
  assert.equal(state.raiseProgressPercent, 60);
});

test('a successful raise stays in escrow until closing, even if the edited raise percentage is smaller', () => {
  const state = projectScenario({ raisedPercent: 1 }, 'funded');
  assert.equal(state.raised, 2_000_000);
  assert.equal(state.escrowCash, 2_000_000);
  assert.equal(state.capitalDeployed, 0);
  assert.equal(state.backingCash, 0);
  assert.equal(state.hasTokenClaims, false);
  assert.equal(state.personalCashout, 0);
  assert.equal(state.personalRefund, 0);
  assert.equal(state.goalReached, false);
  assert.equal(state.raiseProgressPercent, 100);
});

test('failed subscriptions remain refundable principal, with no concurrent property claims', () => {
  const refunding = projectScenario({}, 'refunding');
  assert.equal(refunding.escrowCash, 1_200_000);
  assert.equal(refunding.refundableCash, 1_200_000);
  assert.equal(refunding.refundedCash, 0);
  assert.equal(refunding.personalRefund, 10_000);
  assert.equal(refunding.personalRefundableCash, 10_000);
  assert.equal(refunding.personalRefundedCash, 0);
  const refunded = projectScenario({}, 'refunded');
  assert.equal(refunded.escrowCash, 0);
  assert.equal(refunded.refundableCash, 0);
  assert.equal(refunded.refundedCash, 1_200_000);
  assert.equal(refunded.personalRefund, 10_000);
  assert.equal(refunded.personalRefundableCash, 0);
  assert.equal(refunded.personalRefundedCash, 10_000);
  for (const state of [refunding, refunded]) {
    assert.equal(state.capitalDeployed, 0);
    assert.equal(state.backingCash, 0);
    assert.equal(state.hasTokenClaims, false);
    assert.equal(state.personalCashout, 0);
    assert.equal(state.goalReached, false);
    assert.equal(state.releaseEligible, false);
    assert.equal(state.monthsApplied, 0);
  }
});

test('the revenue phase deploys the raise and adds only operating surplus to backing', () => {
  const state = projectScenario({}, 'earning');
  assert.equal(state.raised, 2_000_000);
  assert.equal(state.escrowCash, 0);
  assert.equal(state.capitalDeployed, 2_000_000);
  assert.equal(state.monthlyAvailable, 8_000);
  assert.equal(state.monthlySweep, 6_400);
  assert.equal(state.monthlyOwnerShare, 1_600);
  assert.equal(state.operatingShortfall, 0);
  assert.equal(state.backingCash, 185_600);
  assert.equal(state.ownershipFraction, 0.005);
  assert.equal(state.personalCashout, 928);
  assert.equal(state.totalTarget, 2_600_000);
  assert.equal(state.personalTarget, 13_000);
  assert.equal(state.fundingGap, 2_414_400);
  assert.equal(state.payoffMonths, 407);
  assert.equal(state.monthsApplied, 29);
  assert.equal(state.hasTokenClaims, true);
  assert.equal(state.personalRefund, 0);
  assert.equal(state.goalReached, false);
  assert.equal(state.legalReleaseCompleted, false);
  close(state.progressPercent, 185_600 / 2_600_000 * 100);
});

test('the release view advances revenue to the floor without requiring investors to cash out', () => {
  const state = projectScenario({}, 'paid_off');
  assert.equal(state.monthsApplied, 407);
  assert.equal(state.backingCash, 2_600_000);
  assert.equal(state.personalCashout, 13_000);
  assert.equal(state.capitalDeployed, 2_000_000);
  assert.equal(state.refundedCash, 0);
  assert.equal(state.hasTokenClaims, true);
  assert.equal(state.goalReached, true);
  assert.equal(state.releaseEligible, true);
  assert.equal(state.legalReleaseCompleted, true);
  assert.equal(state.progressPercent, 100);
  assert.equal(state.fundingGap, 0);
  assert.equal(state.settlementFundingNeeded, 0);
});

test('revenue stops at the release floor but funding alone does not assert legal release', () => {
  const before = projectScenario({ revenueMonths: 406 }, 'earning');
  assert.equal(before.backingCash, 2_598_400);
  assert.equal(before.goalReached, false);
  const reached = projectScenario({ revenueMonths: 407 }, 'earning');
  assert.equal(reached.backingCash, 2_600_000);
  assert.equal(reached.goalReached, true);
  assert.equal(reached.releaseEligible, true);
  assert.equal(reached.legalReleaseCompleted, false);
  const after = projectScenario({ revenueMonths: 1_200 }, 'earning');
  assert.equal(after.backingCash, reached.backingCash);
  assert.equal(after.monthsApplied, 407);
  assert.equal(after.phase, 'earning');
  assert.equal(after.personalCashout, 13_000);
});

test('editing each economic input changes the projection without mutating defaults or inputs', () => {
  const inputs = {
    goal: 100_000, investment: 5_000, raisedPercent: 20,
    monthlyRent: 10_000, monthlyCosts: 2_000,
    investorPercent: 50, returnPercent: 20, revenueMonths: 10,
  };
  const copy = { ...inputs };
  const state = projectScenario(inputs, 'earning');
  assert.equal(state.monthlySweep, 4_000);
  assert.equal(state.monthlyOwnerShare, 4_000);
  assert.equal(state.backingCash, 40_000);
  assert.equal(state.personalCashout, 2_000);
  assert.equal(state.personalTarget, 6_000);
  assert.equal(state.totalTarget, 120_000);
  assert.equal(state.ownershipFraction, 0.05);
  assert.equal(state.payoffMonths, 30);
  assert.equal(projectScenario(inputs, 'refunding').refundableCash, 20_000);
  assert.deepEqual(inputs, copy);
  assert.equal(DEFAULT_SCENARIO.goal, 2_000_000);
});

test('zero surplus, losses, and a zero investor allocation cannot imply self-funded payoff', () => {
  for (const inputs of [
    { monthlyRent: 6_000 },
    { monthlyRent: 0 },
    { investorPercent: 0 },
  ]) {
    const earning = projectScenario(inputs, 'earning');
    assert.equal(earning.monthlySweep, 0);
    assert.equal(earning.backingCash, 0);
    assert.equal(earning.payoffMonths, null);
    assert.equal(earning.goalReached, false);
    assert.equal(earning.settlementFundingNeeded, 0);
    const released = projectScenario(inputs, 'paid_off');
    assert.equal(released.backingCash, 2_600_000);
    assert.equal(released.settlementFundingNeeded, 2_600_000);
    assert.equal(released.monthsApplied, 0);
    assert.equal(released.payoffMonths, null);
  }
  const losses = projectScenario({ monthlyRent: 0 }, 'earning');
  assert.equal(losses.operatingShortfall, 6_000);
  assert.equal(losses.monthlyOwnerShare, 0);
});

test('small sweeps use whole cents and distinguish zero-rounded from slow repayment', () => {
  const inputs = { goal: 1, investment: 0.1, monthlyRent: 0.01, monthlyCosts: 0, returnPercent: 30 };
  const tiny = projectScenario({ ...inputs, investorPercent: 1 }, 'earning');
  assert.equal(tiny.monthlySweep, 0);
  assert.equal(tiny.monthlyOwnerShare, 0.01);
  assert.equal(tiny.payoffMonths, null);
  const slow = projectScenario({ ...inputs, investorPercent: 100, revenueMonths: 129 }, 'earning');
  assert.equal(slow.monthlySweep, 0.01);
  assert.equal(slow.backingCash, 1.29);
  assert.equal(slow.personalCashout, 0.12);
  assert.equal(slow.payoffMonths, 130);
  assert.equal(slow.goalReached, false);
  const released = projectScenario({ ...inputs, investorPercent: 100 }, 'paid_off');
  assert.equal(released.backingCash, 1.3);
  assert.equal(released.personalCashout, 0.13);
  assert.equal(released.monthsApplied, 130);
});

test('the personal release-floor target matches the payable proportional quote at cent boundaries', () => {
  const inputs = { goal: 0.02, investment: 0.01, returnPercent: 50 };
  const earning = projectScenario({ ...inputs, revenueMonths: 0 }, 'earning');
  assert.equal(earning.totalTarget, 0.03);
  assert.equal(earning.personalTarget, 0.01);
  const released = projectScenario(inputs, 'paid_off');
  assert.equal(released.personalCashout, 0.01);
  assert.equal(released.personalTarget, released.personalCashout);
  assert.equal(released.goalReached, true);
  assert.equal(released.fundingGap, 0);
});

test('subscription cash and monthly operating cash are conserved in every phase', () => {
  for (const phase of ['raising', 'funded', 'refunding', 'refunded', 'earning', 'paid_off']) {
    const state = projectScenario({ monthlyRent: 123.45, monthlyCosts: 67.89, investorPercent: 71.3 }, phase);
    close(state.raised, state.escrowCash + state.capitalDeployed + state.refundedCash);
    close(state.monthlyRent + state.operatingShortfall, state.monthlyCosts + state.monthlySweep + state.monthlyOwnerShare);
    assert.ok(state.personalCashout <= state.backingCash);
    assert.ok(state.refundableCash <= state.escrowCash);
    if (!state.hasTokenClaims) assert.equal(state.personalCashout, 0);
  }
});

test('zero investment and zero receipts work without inventing refunds or ownership', () => {
  for (const phase of ['raising', 'refunding', 'refunded']) {
    const state = projectScenario({ investment: 0, raisedPercent: 0 }, phase);
    assert.equal(state.raised, 0);
    assert.equal(state.personalRefund, 0);
    assert.equal(state.personalTarget, 0);
    assert.equal(state.ownershipFraction, 0);
  }
  const lone = projectScenario({ investment: 2_000_000 }, 'paid_off');
  assert.equal(lone.personalCashout, lone.backingCash);
  assert.equal(lone.ownershipFraction, 1);
});

test('large inputs stop at the floor before multiplying beyond exact cent precision', () => {
  const state = projectScenario({ monthlyRent: 1_000_000_000_000, monthlyCosts: 0, revenueMonths: 1_200 }, 'earning');
  assert.equal(state.backingCash, 2_600_000);
  assert.equal(state.monthsApplied, 1);
  assert.equal(state.personalCashout, 13_000);
});

test('invalid inputs produce explicit errors rather than a NaN or impossible investor position', () => {
  for (const bad of [NaN, Infinity, -1, '100']) {
    assert.throws(() => projectScenario({ monthlyRent: bad }, 'earning'));
  }
  assert.throws(() => projectScenario({ goal: 0 }));
  assert.throws(() => projectScenario({ goal: 10, investment: 11 }));
  assert.throws(() => projectScenario({ raisedPercent: 0 }), /increase raisedPercent or reduce investment/);
  assert.throws(() => projectScenario({ goal: 100, investment: 50, raisedPercent: 40 }, 'refunding'));
  assert.throws(() => projectScenario({ goal: 100, investment: 50, raisedPercent: 40 }, 'refunded'));
  assert.throws(() => projectScenario({ monthlyRent: 10.001 }));
  assert.throws(() => projectScenario({ investorPercent: 100.01 }));
  assert.throws(() => projectScenario({ raisedPercent: 100.01 }));
  assert.throws(() => projectScenario({ returnPercent: 500.01 }));
  assert.throws(() => projectScenario({ revenueMonths: 1_201 }));
  assert.throws(() => projectScenario({ revenueMonths: 0.5 }));
  assert.throws(() => projectScenario({}, 'unknown'));
  assert.throws(() => projectScenario(null));
  assert.throws(() => projectScenario([]));
});

test('a first-loan estimate uses the current position and explicit upfront fee assumptions', () => {
  assert.deepEqual(LOAN_FEE_ASSUMPTIONS, {
    terminalPercent: 2.5, sourcePercent: 2.5, revPercent: 1, totalPercent: 6,
  });
  assert.equal(Object.isFrozen(LOAN_FEE_ASSUMPTIONS), true);
  const state = projectScenario({}, 'earning');
  assert.equal(state.personalLoanPrincipal, 928);
  assert.equal(state.personalLoanCash, 872.32);
  assert.equal(state.personalLoanFees, 55.68);
  assert.equal(state.loanAvailable, true);
  assert.equal(state.nextMonthLoanPrincipal, 960);
  assert.equal(state.nextMonthLoanCash, 902.4);
  assert.equal(state.nextMonthLoanCashIncrease, 30.08);
  assert.equal(state.backingCash, 185_600, 'a quote does not withdraw loan principal from backing');
  assert.equal(state.personalCashout, 928, 'an alternative quote does not cash out any tokens');
});

test('escrow and refund receipts never provide current or next-month REV loan quotes', () => {
  for (const phase of ['raising', 'funded', 'refunding', 'refunded']) {
    const state = projectScenario({}, phase);
    assert.equal(state.loanAvailable, false);
    for (const field of [
      'personalLoanPrincipal', 'personalLoanCash', 'personalLoanFees',
      'nextMonthLoanPrincipal', 'nextMonthLoanCash', 'nextMonthLoanCashIncrease',
    ]) assert.equal(state[field], 0, `${phase}: ${field}`);
  }
});

test('rental receipts and elapsed months increase a first-loan quote only after cash reaches backing', () => {
  const closing = projectScenario({ revenueMonths: 0 }, 'earning');
  assert.equal(closing.personalLoanPrincipal, 0);
  assert.equal(closing.personalLoanCash, 0);
  assert.equal(closing.personalLoanFees, 0);
  assert.equal(closing.loanAvailable, false);
  assert.equal(closing.nextMonthLoanPrincipal, 32);
  assert.equal(closing.nextMonthLoanCash, 30.08);
  const firstRent = projectScenario({ revenueMonths: 1 }, 'earning');
  assert.equal(firstRent.personalLoanCash, closing.nextMonthLoanCash);
  assert.equal(firstRent.loanAvailable, true);
  const moreRent = projectScenario({ monthlyRent: 22_000, revenueMonths: 1 }, 'earning');
  assert.equal(moreRent.personalLoanPrincipal, 64);
  assert.equal(moreRent.personalLoanCash, 60.16);
  assert.equal(moreRent.nextMonthLoanCash, 120.32);
});

test('the final partial property sweep stops quote growth at the modeled release floor', () => {
  const lastFullMonth = projectScenario({ revenueMonths: 406 }, 'earning');
  assert.equal(lastFullMonth.personalLoanPrincipal, 12_992);
  assert.equal(lastFullMonth.personalLoanCash, 12_212.48);
  assert.equal(lastFullMonth.nextMonthLoanPrincipal, 13_000);
  assert.equal(lastFullMonth.nextMonthLoanCash, 12_220);
  assert.equal(lastFullMonth.nextMonthLoanCashIncrease, 7.52);
  for (const state of [
    projectScenario({ revenueMonths: 407 }, 'earning'),
    projectScenario({ revenueMonths: 1_200 }, 'earning'),
    projectScenario({}, 'paid_off'),
  ]) {
    assert.equal(state.personalLoanPrincipal, 13_000);
    assert.equal(state.personalLoanCash, 12_220);
    assert.equal(state.personalLoanFees, 780);
    assert.equal(state.nextMonthLoanCash, 12_220);
    assert.equal(state.nextMonthLoanCashIncrease, 0);
    assert.equal(state.loanAvailable, true);
  }
});

test('operating shortfalls, zero allocation, and tiny net amounts cannot provide spendable loan cash', () => {
  for (const inputs of [
    { monthlyRent: 0 }, { monthlyRent: 6_000 }, { investorPercent: 0 }, { investment: 0 },
  ]) {
    const state = projectScenario(inputs, 'earning');
    assert.equal(state.personalLoanPrincipal, 0);
    assert.equal(state.personalLoanCash, 0);
    assert.equal(state.nextMonthLoanCash, 0);
    assert.equal(state.loanAvailable, false);
  }
  const tiny = projectScenario({ goal: 0.01, investment: 0.01, returnPercent: 0 }, 'paid_off');
  assert.equal(tiny.personalLoanPrincipal, 0.01);
  assert.equal(tiny.personalLoanCash, 0);
  assert.equal(tiny.personalLoanFees, 0.01);
  assert.equal(tiny.loanAvailable, false, 'availability requires positive cent-rounded net cash');
  const cents = projectScenario({ goal: 0.17, investment: 0.17, returnPercent: 0 }, 'paid_off');
  assert.equal(cents.personalLoanCash, 0.15, 'net cash rounds down, never to the nearest cent');
  assert.equal(cents.personalLoanFees, 0.02);
});

test('loan quotes conserve their principal and never promise more than modeled liquid backing', () => {
  for (const investment of [0, 0.01, 123.45, 10_000, 2_000_000]) {
    for (const revenueMonths of [0, 1, 29, 406, 407, 1_200]) {
      const inputs = { investment, revenueMonths };
      const original = { ...inputs };
      const state = projectScenario(inputs, 'earning');
      close(state.personalLoanCash + state.personalLoanFees, state.personalLoanPrincipal);
      assert.equal(state.personalLoanPrincipal, state.personalCashout);
      assert.ok(state.personalLoanPrincipal <= state.backingCash);
      assert.ok(state.personalLoanCash <= state.personalLoanPrincipal);
      assert.ok(state.nextMonthLoanCashIncrease >= 0);
      assert.deepEqual(inputs, original);
      assert.deepEqual(projectScenario(inputs, 'earning'), state, 'quoting again has no lending side effects');
    }
  }
});
