/**
 * Illustrative property-finance model. Currency inputs are ordinary numbers in
 * dollars, rounded to cents for simulated cash movements. This illustration
 * accepts whole tokens and cent-denominated issue/target prices. Current token
 * prices retain floating-point precision. This is not settlement accounting.
 *
 * Every property is isolated: only `backing` is available for token cash-outs.
 * Property value and operating reserves never enter the current token quote.
 */

// Founder Haus's requested financing size is $2 million. The remaining values
// are unchanged illustrative inputs, not verified property economics. This
// capped cash-out model does not simulate loans or a Revnet configuration.
export const DEFAULT_PROPERTY = Object.freeze({
  tokens: 2_000_000,
  issuePrice: 1,
  targetPerToken: 1.3,
  backing: 185_600,
  reserveBalance: 30_000,
  reserveTarget: 30_000,
  monthlyGrossRent: 14_000,
  monthlyOperatingCosts: 5_000,
  monthlyCapitalCosts: 1_000,
  investorSweep: 0.8,
  elapsedMonths: 29,
  horizonMonths: 120,
  propertyValue: 950_000,
  saleCostRate: 0.08,
  saleCostFixed: 0,
  seniorClaims: 0,
});

const MAX_AMOUNT = 1_000_000_000_000;
const EPSILON = 1e-8;
const cents = (amount) => Math.round((amount + Number.EPSILON) * 100) / 100;
const floorCents = (amount) => Math.floor((amount + EPSILON) * 100) / 100;

function number(name, value, { min = 0, max = MAX_AMOUNT, integer = false } = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`${name} must be a finite number.`);
  }
  if (value < min || value > max || (integer && !Number.isInteger(value))) {
    throw new RangeError(`${name} must be ${integer ? 'an integer ' : ''}between ${min} and ${max}.`);
  }
  return value;
}

function money(name, value, { min = 0 } = {}) {
  number(name, value, { min });
  if (Math.abs(value * 100 - Math.round(value * 100)) > 1e-6) {
    throw new RangeError(`${name} must be denominated in whole cents.`);
  }
  return value;
}

function validateState(state) {
  if (!state || typeof state !== 'object') throw new TypeError('A property state is required.');
  number('tokens', state.tokens, { integer: true });
  money('issuePrice', state.issuePrice, { min: 0.01 });
  money('targetPerToken', state.targetPerToken, { min: state.issuePrice });
  money('backing', state.backing);
  number('target liability', state.tokens * state.targetPerToken);
  return state;
}

function validateConfig(config) {
  validateState(config);
  for (const field of [
    'reserveBalance', 'reserveTarget', 'monthlyGrossRent',
    'monthlyOperatingCosts', 'monthlyCapitalCosts',
  ]) money(field, config[field]);
  number('investorSweep', config.investorSweep, { max: 1 });
  number('elapsedMonths', config.elapsedMonths, { max: 1_200, integer: true });
  number('horizonMonths', config.horizonMonths, { max: 1_200, integer: true });
}

/** A token burn accepts this price and permanently ends those tokens' rights. */
export function quote(state, tokenAmount = Math.min(1, state?.tokens ?? 0)) {
  validateState(state);
  number('tokenAmount', tokenAmount, { max: state.tokens, integer: true });
  const outstandingTarget = cents(state.tokens * state.targetPerToken);
  const currentPerToken = state.tokens === 0
    ? 0
    : Math.min(state.backing / state.tokens, state.targetPerToken);
  const principalValue = cents(tokenAmount * state.issuePrice);
  const targetValue = cents(tokenAmount * state.targetPerToken);
  const cashOutValue = tokenAmount === state.tokens
    ? Math.min(state.backing, outstandingTarget)
    : floorCents(tokenAmount * currentPerToken);
  return {
    tokenAmount,
    currentPerToken,
    principalPerToken: state.issuePrice,
    targetPerToken: state.targetPerToken,
    cashOutValue,
    principalValue,
    targetValue,
    principalHaircutAmount: cents(Math.max(0, principalValue - cashOutValue)),
    principalHaircutRate: state.tokens === 0 ? 0 : Math.max(0, 1 - currentPerToken / state.issuePrice),
    targetHaircutAmount: cents(Math.max(0, targetValue - cashOutValue)),
    targetHaircutRate: state.tokens === 0 ? 0 : Math.max(0, 1 - currentPerToken / state.targetPerToken),
    principalCoverage: state.tokens === 0 ? 1 : Math.min(1, currentPerToken / state.issuePrice),
    targetCoverage: state.tokens === 0 ? 1 : currentPerToken / state.targetPerToken,
    outstandingTarget,
    fundingGap: Math.max(0, outstandingTarget - state.backing),
    excessBacking: Math.max(0, state.backing - outstandingTarget),
    principalFunded: state.backing + EPSILON >= state.tokens * state.issuePrice,
    targetFunded: state.backing + EPSILON >= outstandingTarget,
  };
}

/** Backing is capped at the entitlement of the tokens still outstanding. */
export function depositBacking(state, amount) {
  validateState(state);
  money('amount', amount);
  const available = cents(amount);
  const investorDeposit = Math.min(available, Math.max(0, cents(state.tokens * state.targetPerToken) - state.backing));
  const sponsorResidual = cents(available - investorDeposit);
  return {
    state: { ...state, backing: cents(state.backing + investorDeposit) },
    investorDeposit: cents(investorDeposit),
    sponsorResidual,
  };
}

/**
 * Cash-out burns tokens with no residual claim, dividend, or unpaid balance.
 * Proportional burns preserve the remaining quote except for downward cent
 * rounding. Any precision dust remains visible in backing. Zero-token and
 * zero-payout cash-outs are rejected before changing token supply.
 */
export function redeem(state, tokenAmount) {
  number('tokenAmount', tokenAmount, { min: 1, integer: true });
  const before = quote(state, tokenAmount);
  if (before.cashOutValue <= 0) {
    throw new RangeError('Cash-out must pay at least one cent; no tokens were burned.');
  }
  const next = {
    ...state,
    tokens: Math.max(0, state.tokens - tokenAmount),
    backing: cents(state.backing - before.cashOutValue),
  };
  const after = quote(next);
  return {
    state: next,
    burnedTokens: tokenAmount,
    payout: before.cashOutValue,
    principalHaircutAmount: before.principalHaircutAmount,
    targetHaircutAmount: before.targetHaircutAmount,
    beforePrice: before.currentPerToken,
    afterPrice: after.currentPerToken,
    remainingClaimForBurnedTokens: 0,
  };
}

/** Annual compound return when the entire investment is paid once at exit. */
export function annualizedSingleExit(initialAmount, finalAmount, months) {
  number('initialAmount', initialAmount, { min: Number.EPSILON });
  number('finalAmount', finalAmount);
  number('months', months, { min: Number.EPSILON, max: 2_400 });
  const result = (finalAmount / initialAmount) ** (12 / months) - 1;
  if (!Number.isFinite(result)) throw new RangeError('The annualized return exceeds the model range.');
  return result;
}

/**
 * Annual IRR of monthly, conventional cash flows: an initial investment below
 * zero followed only by nonnegative receipts. Other patterns can have multiple
 * IRRs and are rejected. A zero-recovery stream returns -100%.
 */
export function annualizedIRR(cashFlows) {
  if (!Array.isArray(cashFlows) || cashFlows.length < 2 || cashFlows.length > 2_401) {
    throw new RangeError('Provide an initial investment and 1–2400 monthly receipts.');
  }
  number('initial cash flow', cashFlows[0], { min: -MAX_AMOUNT, max: -Number.EPSILON });
  cashFlows.slice(1).forEach((amount, i) => number(`cashFlows[${i + 1}]`, amount));
  if (cashFlows.slice(1).every((amount) => amount === 0)) return -1;

  // Solve in log monthly discount space for stability near a -100% return.
  const npv = (logGrowth) => cashFlows.reduce(
    (total, amount, month) => total + (amount === 0 ? 0 : amount * Math.exp(-logGrowth * month)), 0,
  );
  let low = -64;
  let high = 64;
  for (let iteration = 0; iteration < 240; iteration++) {
    const middle = (low + high) / 2;
    if (npv(middle) > 0) low = middle;
    else high = middle;
  }
  const result = Math.expm1(((low + high) / 2) * 12);
  if (!Number.isFinite(result)) throw new RangeError('The annualized IRR exceeds the model range.');
  return result;
}

function snapshot(state, month, cash = {}) {
  const quoted = quote(state);
  return {
    month,
    backing: state.backing,
    tokens: state.tokens,
    reserveBalance: state.reserveBalance,
    cashoutPerToken: quoted.currentPerToken,
    principalCoverage: quoted.principalCoverage,
    targetCoverage: quoted.targetCoverage,
    fundingGap: quoted.fundingGap,
    grossRent: 0,
    operatingCosts: 0,
    capitalCosts: 0,
    operatingNet: 0,
    reserveTopUp: 0,
    reserveDraw: 0,
    operatingShortfall: 0,
    availableCash: 0,
    investorDeposit: 0,
    sponsorResidual: 0,
    ...cash,
  };
}

/**
 * A deterministic scenario, not a forecast. No issuance, exits, rent growth,
 * debt, inflation, or reinvestment is assumed. Expenses and capital costs are
 * paid first, operating reserves are restored in full, then free cash is split.
 * An uncovered operating shortfall is reported; it is not silently financed.
 */
export function simulateProperty(config, options = {}) {
  validateConfig(config);
  const { vacancyRate = 0, expenseIncrease = 0, months: count = config.horizonMonths } = options;
  number('vacancyRate', vacancyRate, { max: 1 });
  number('expenseIncrease', expenseIncrease, { max: 10 });
  number('months', count, { max: 1_200, integer: true });

  let state = { ...config };
  const months = [snapshot(state, 0)];
  let targetFundedMonth = quote(state).targetFunded ? 0 : null;
  let principalFundedMonth = quote(state).principalFunded ? 0 : null;
  let totalInvestorDeposits = 0;
  let totalSponsorResidual = 0;
  let totalOperatingShortfall = 0;

  for (let month = 1; month <= count; month++) {
    const grossRent = cents(config.monthlyGrossRent * (1 - vacancyRate));
    const operatingCosts = cents(config.monthlyOperatingCosts * (1 + expenseIncrease));
    const capitalCosts = cents(config.monthlyCapitalCosts * (1 + expenseIncrease));
    const operatingNet = cents(grossRent - operatingCosts - capitalCosts);
    const reserveDraw = cents(Math.min(state.reserveBalance, Math.max(0, -operatingNet)));
    const operatingShortfall = cents(Math.max(0, -operatingNet - reserveDraw));
    const reserveTopUp = cents(Math.min(
      Math.max(0, operatingNet),
      Math.max(0, config.reserveTarget - state.reserveBalance),
    ));
    state.reserveBalance = cents(state.reserveBalance - reserveDraw + reserveTopUp);
    const availableCash = cents(Math.max(0, operatingNet - reserveTopUp));
    const swept = cents(availableCash * config.investorSweep);
    const deposit = depositBacking(state, swept);
    state = deposit.state;
    const investorDeposit = deposit.investorDeposit;
    const sponsorResidual = cents(availableCash - swept + deposit.sponsorResidual);
    const quoted = quote(state);
    if (targetFundedMonth === null && quoted.targetFunded) targetFundedMonth = month;
    if (principalFundedMonth === null && quoted.principalFunded) principalFundedMonth = month;
    totalInvestorDeposits = cents(totalInvestorDeposits + investorDeposit);
    totalSponsorResidual = cents(totalSponsorResidual + sponsorResidual);
    totalOperatingShortfall = cents(totalOperatingShortfall + operatingShortfall);
    months.push(snapshot(state, month, {
      grossRent, operatingCosts, capitalCosts, operatingNet, reserveTopUp,
      reserveDraw, operatingShortfall, availableCash, investorDeposit, sponsorResidual,
    }));
  }

  const finalQuote = quote(state);
  const totalTargetMonths = targetFundedMonth === null ? null : config.elapsedMonths + targetFundedMonth;
  const totalHorizonMonths = config.elapsedMonths + count;
  return {
    months,
    finalState: state,
    targetFundedMonth,
    principalFundedMonth,
    totalTargetMonths,
    totalHorizonMonths,
    totalInvestorDeposits,
    totalSponsorResidual,
    totalOperatingShortfall,
    // Original holders invest at closing, so include elapsed time, not merely
    // the remaining projection. Unrealized price growth is not a distribution.
    singleExitAnnualReturn: totalTargetMonths > 0 && config.tokens > 0
      ? annualizedSingleExit(config.issuePrice, config.targetPerToken, totalTargetMonths)
      : null,
    horizonSingleExitAnnualReturn: totalHorizonMonths > 0 && config.tokens > 0
      ? annualizedSingleExit(config.issuePrice, finalQuote.currentPerToken, totalHorizonMonths)
      : null,
  };
}

/**
 * Hypothetical recovery only after a completed property sale and payment of
 * senior claims. Reserves are excluded. Appraisal is never current backing.
 */
export function liquidationRecovery(config) {
  validateState(config);
  money('propertyValue', config.propertyValue);
  number('saleCostRate', config.saleCostRate, { max: 1 });
  money('saleCostFixed', config.saleCostFixed ?? 0);
  money('seniorClaims', config.seniorClaims);
  const grossSaleProceeds = cents(config.propertyValue);
  const saleCosts = cents(config.propertyValue * config.saleCostRate + (config.saleCostFixed ?? 0));
  const proceedsAfterCosts = cents(Math.max(0, grossSaleProceeds - saleCosts));
  const seniorClaimsPaid = Math.min(proceedsAfterCosts, config.seniorClaims);
  const unpaidSeniorClaims = cents(Math.max(0, config.seniorClaims - seniorClaimsPaid));
  const netSaleProceeds = cents(proceedsAfterCosts - seniorClaimsPaid);
  const deposit = depositBacking(config, netSaleProceeds);
  const recovery = quote(deposit.state, config.tokens);
  return {
    grossSaleProceeds,
    saleCosts,
    proceedsAfterCosts,
    seniorClaimsPaid,
    unpaidSeniorClaims,
    netSaleProceeds,
    existingLiquidBacking: config.backing,
    additionalInvestorBacking: deposit.investorDeposit,
    totalInvestorRecovery: recovery.cashOutValue,
    recoveryPerToken: recovery.currentPerToken,
    principalShortfall: recovery.principalHaircutAmount,
    targetShortfall: recovery.targetHaircutAmount,
    sponsorResidual: deposit.sponsorResidual,
    targetFunded: recovery.targetFunded,
    excludedOperatingReserves: config.reserveBalance ?? 0,
  };
}
