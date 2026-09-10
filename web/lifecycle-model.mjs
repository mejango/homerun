/**
 * One-property lifecycle illustration with editable, unverified assumptions.
 * Currency inputs are dollars in whole cents; cash is modeled in integer cents.
 * First-loan estimates do not execute loans, deduct treasury cash, lock tokens,
 * or apply fees to the lifecycle balances. There are no valuation marks or
 * other treasury movements. The return target is a release floor, not a cap on REV
 * cash-outs. This illustration stops the property sweep when that floor is met.
 * Reaching the floor makes release eligible; only `paid_off` depicts release.
 */

export const DEFAULT_SCENARIO = Object.freeze({
  goal: 2_000_000,
  investment: 10_000,
  raisedPercent: 60,
  monthlyRent: 14_000,
  monthlyCosts: 6_000,
  investorPercent: 80,
  returnPercent: 30,
  revenueMonths: 29,
});

/**
 * Illustrative upfront fee assumptions, not an APR or a live loan quote.
 * The source fee uses its assumed minimum. Estimates round net cash downward
 * to cents; actual contracts calculate their fees in the asset's base units.
 */
export const LOAN_FEE_ASSUMPTIONS = Object.freeze({
  terminalPercent: 2.5,
  sourcePercent: 2.5,
  revPercent: 1,
  totalPercent: 6,
});

const PHASES = new Set(['raising', 'funded', 'refunding', 'refunded', 'earning', 'paid_off']);
const FAILED_PHASES = new Set(['refunding', 'refunded']);
const ESCROW_PHASES = new Set(['raising', 'funded', 'refunding']);
const PROPERTY_PHASES = new Set(['earning', 'paid_off']);
const MAX_DOLLARS = 1_000_000_000_000;

function finiteNumber(field, value, min, max, integer = false) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`${field} must be a finite number.`);
  }
  if (value < min || value > max || (integer && !Number.isInteger(value))) {
    throw new RangeError(`${field} must be ${integer ? 'an integer ' : ''}between ${min} and ${max}.`);
  }
  return value;
}

function toCents(field, value, min = 0) {
  finiteNumber(field, value, min, MAX_DOLLARS);
  const scaled = value * 100;
  if (Math.abs(scaled - Math.round(scaled)) > 1e-6) {
    throw new RangeError(`${field} must be denominated in whole cents.`);
  }
  return Math.round(scaled);
}

const dollars = (amount) => amount / 100;

// Integer division keeps a hypothetical holder quote from rounding above their
// proportional backing, including when a tiny position is worth under a cent.
function proportionalCents(amount, numerator, denominator) {
  return Number(BigInt(amount) * BigInt(numerator) / BigInt(denominator));
}

function firstLoanQuote(backing, investment, goal) {
  // One asset, local treasury, zero cash-out tax, no prior loans or redemptions;
  // the holder still owns and pledges their entire unencumbered position. This
  // is an alternative to cashing out those same tokens, not additional cash.
  const principal = Math.min(backing, proportionalCents(backing, investment, goal));
  const cash = proportionalCents(principal, 100 - LOAN_FEE_ASSUMPTIONS.totalPercent, 100);
  return { principal, cash, fees: principal - cash };
}

/**
 * Each call derives a complete scenario from inputs, not a transaction history.
 * Passing only changed fields is supported. Failed raises refund subscriptions
 * and never issue property-token claims. `funded` means the raise succeeded but
 * property closing is pending: all proceeds are still in subscription escrow.
 * Monthly allocations are the nominal operating split before release. A
 * zero-sweep `paid_off` view assumes outside settlement cash has arrived; its
 * required amount is explicitly returned as `settlementFundingNeeded`.
 */
export function projectScenario(inputs = {}, phase = 'raising') {
  if (!inputs || typeof inputs !== 'object' || Array.isArray(inputs)) {
    throw new TypeError('Scenario inputs must be an object.');
  }
  if (!PHASES.has(phase)) throw new RangeError(`Unknown lifecycle phase: ${String(phase)}.`);
  const scenario = { ...DEFAULT_SCENARIO, ...inputs };
  const goal = toCents('goal', scenario.goal, 0.01);
  const investment = toCents('investment', scenario.investment);
  const monthlyRent = toCents('monthlyRent', scenario.monthlyRent);
  const monthlyCosts = toCents('monthlyCosts', scenario.monthlyCosts);
  finiteNumber('raisedPercent', scenario.raisedPercent, 0, 100);
  finiteNumber('investorPercent', scenario.investorPercent, 0, 100);
  finiteNumber('returnPercent', scenario.returnPercent, 0, 500);
  finiteNumber('revenueMonths', scenario.revenueMonths, 0, 1_200, true);
  if (investment > goal) throw new RangeError('investment cannot exceed the property funding goal.');

  const partialRaise = phase === 'raising' || FAILED_PHASES.has(phase);
  const raised = partialRaise ? Math.round(goal * (scenario.raisedPercent / 100)) : goal;
  if (partialRaise && investment > raised) {
    throw new RangeError('investment cannot exceed the amount raised; increase raisedPercent or reduce investment.');
  }

  const monthlyAvailable = Math.max(0, monthlyRent - monthlyCosts);
  const operatingShortfall = Math.max(0, monthlyCosts - monthlyRent);
  const monthlySweep = Math.round(monthlyAvailable * (scenario.investorPercent / 100));
  const monthlyOwnerShare = monthlyAvailable - monthlySweep;
  const totalTarget = Math.round(goal * (1 + scenario.returnPercent / 100));
  // The holder's floor quote uses the same downward proportional rounding as
  // their cash-out, so a fully funded project cannot leave a phantom cent due.
  const personalTarget = proportionalCents(totalTarget, investment, goal);
  const payoffMonths = monthlySweep > 0 ? Math.ceil(totalTarget / monthlySweep) : null;
  const hasTokenClaims = PROPERTY_PHASES.has(phase);
  const monthsApplied = phase === 'paid_off'
    ? (payoffMonths ?? 0)
    : phase === 'earning'
      ? Math.min(scenario.revenueMonths, payoffMonths ?? scenario.revenueMonths)
      : 0;

  let backing = 0;
  let settlementFundingNeeded = 0;
  if (phase === 'paid_off') {
    backing = totalTarget;
    if (payoffMonths === null) settlementFundingNeeded = totalTarget;
  } else if (phase === 'earning') {
    // Compare months before multiplying: a large income and long horizon must
    // not overflow cent precision before the release-floor stop is applied.
    backing = payoffMonths !== null && monthsApplied >= payoffMonths
      ? totalTarget
      : monthsApplied * monthlySweep;
  }

  const escrowCash = ESCROW_PHASES.has(phase) ? raised : 0;
  const refundableCash = phase === 'refunding' ? raised : 0;
  const refundedCash = phase === 'refunded' ? raised : 0;
  const capitalDeployed = hasTokenClaims ? goal : 0;
  const personalCashout = hasTokenClaims ? proportionalCents(backing, investment, goal) : 0;
  const personalRefundableCash = phase === 'refunding' ? investment : 0;
  const personalRefundedCash = phase === 'refunded' ? investment : 0;
  const goalReached = backing >= totalTarget;
  let nextMonthBacking = backing;
  if (phase === 'earning' && !goalReached) {
    const nextMonth = monthsApplied + 1;
    nextMonthBacking = payoffMonths !== null && nextMonth >= payoffMonths
      ? totalTarget
      : nextMonth * monthlySweep;
  }
  const loan = hasTokenClaims
    ? firstLoanQuote(backing, investment, goal)
    : { principal: 0, cash: 0, fees: 0 };
  // Next month is an alternative first loan assuming no loan is taken today;
  // it is not unused capacity or a top-up following today's hypothetical loan.
  const nextMonthLoan = hasTokenClaims
    ? firstLoanQuote(nextMonthBacking, investment, goal)
    : { principal: 0, cash: 0, fees: 0 };

  return {
    ...scenario,
    phase,
    goal: dollars(goal),
    investment: dollars(investment),
    raised: dollars(raised),
    escrowCash: dollars(escrowCash),
    capitalDeployed: dollars(capitalDeployed),
    backingCash: dollars(backing),
    refundableCash: dollars(refundableCash),
    refundedCash: dollars(refundedCash),
    monthlyRent: dollars(monthlyRent),
    monthlyCosts: dollars(monthlyCosts),
    monthlyAvailable: dollars(monthlyAvailable),
    monthlySweep: dollars(monthlySweep),
    monthlyOwnerShare: dollars(monthlyOwnerShare),
    operatingShortfall: dollars(operatingShortfall),
    totalTarget: dollars(totalTarget),
    personalTarget: dollars(personalTarget),
    personalCashout: dollars(personalCashout),
    personalLoanPrincipal: dollars(loan.principal),
    personalLoanCash: dollars(loan.cash),
    personalLoanFees: dollars(loan.fees),
    loanAvailable: hasTokenClaims && loan.cash > 0,
    nextMonthLoanPrincipal: dollars(nextMonthLoan.principal),
    nextMonthLoanCash: dollars(nextMonthLoan.cash),
    nextMonthLoanCashIncrease: dollars(nextMonthLoan.cash - loan.cash),
    personalRefund: dollars(personalRefundableCash + personalRefundedCash),
    personalRefundableCash: dollars(personalRefundableCash),
    personalRefundedCash: dollars(personalRefundedCash),
    ownershipFraction: investment / goal,
    payoffMonths,
    fundingGap: dollars(Math.max(0, totalTarget - backing)),
    progressPercent: backing / totalTarget * 100,
    raiseProgressPercent: raised / goal * 100,
    goalReached,
    releaseEligible: goalReached,
    legalReleaseCompleted: phase === 'paid_off',
    hasTokenClaims,
    settlementFundingNeeded: dollars(settlementFundingNeeded),
    monthsApplied,
  };
}
