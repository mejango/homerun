/**
 * Illustrative acquisition FUND and separate rental-income REV network.
 * Money moves in whole cents. REV quantities use floating-point numbers, not
 * contract accounting. Quotes never execute loans or investor redemptions.
 * Annual assumptions are not forecasts, and property value is never REV cash.
 */
export const DEFAULT_NETWORK = Object.freeze({
  purchaseBudget: 500_000,
  opsReserve: 100_000,
  closingCosts: 0,
  precloseSpent: 0,
  payoutFeePercent: 2.5,
  investment: 10_000,
  raisedPercent: 60,
  operatorFundPercent: 20,
  monthlyRent: 10_000,
  monthlyCosts: 6_000,
  rentGrowthPercent: 3,
  costGrowthPercent: 3,
  revenuePremint: 500_000,
  revPrice: 0.1,
  issuanceCutPercent: 5,
  issuanceCutMonths: 3,
  issuanceCutYears: 2,
  operatorSplitPercent: 75,
  ongoingOperatorSplitPercent: 75,
  stickySplitPercent: 15,
  fundRewardMode: 'holders',
  personalStakePercent: 100,
  otherStakePercent: 100,
  stickyVestingMonths: 0,
  renterCashoutPercent: 0,
  revCashoutFeePercent: 0,
  revenueMonths: 12,
  salePrice: 500_000,
  saleCostPercent: 5,
  saleDebt: 0,
});

const PHASES = new Set(['raising', 'funded', 'refunding', 'refunded', 'earning', 'liquidated']);
const CLOSED = new Set(['earning', 'liquidated']);
const MONEY_INPUTS = [
  'purchaseBudget', 'opsReserve', 'closingCosts', 'precloseSpent', 'investment',
  'monthlyRent', 'monthlyCosts', 'salePrice', 'saleDebt',
];
const PERCENT_INPUTS = [
  'raisedPercent', 'issuanceCutPercent', 'operatorSplitPercent',
  'ongoingOperatorSplitPercent', 'renterCashoutPercent', 'saleCostPercent',
  'stickySplitPercent', 'personalStakePercent', 'otherStakePercent',
];
const MAX_DOLLARS = 1_000_000_000;
const usd = (cents) => cents / 100;
const floor = Math.floor;
const ceil = Math.ceil;

function numeric(name, value, min = 0, max = MAX_DOLLARS, integer = false) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError(`${name} must be a finite number.`);
  if (value < min || value > max || (integer && !Number.isInteger(value))) {
    throw new RangeError(`${name} must be ${integer ? 'an integer ' : ''}between ${min} and ${max}.`);
  }
  return value;
}

function money(name, value) {
  numeric(name, value);
  const cents = Math.round(value * 100);
  if (value !== cents / 100) {
    throw new RangeError(`${name} must be denominated in whole cents.`);
  }
  return cents;
}

function safeCents(name, amount) {
  if (!Number.isSafeInteger(amount) || amount < 0) {
    throw new RangeError(`${name} exceeds the model's exact cent range; reduce the amounts or growth rates.`);
  }
  return amount;
}

function quoteCents(cash, tokens, supply) {
  if (cash === 0 || tokens <= 0 || supply <= 0) return 0;
  return Math.min(cash, floor(cash * Math.min(1, tokens / supply)));
}

function loanQuote(principal) {
  // Illustrative FIRST loan: assumed 2.5% terminal + 2.5% minimum source + 1%
  // REV upfront fees. Cent-rounded net is not a live quote or a fixed APR.
  const cash = Number(BigInt(principal) * 94n / 100n);
  return { principal, cash, fees: principal - cash };
}

function allocateSticky(total, weights) {
  const allocations = [0, 0, 0];
  const eligible = weights.reduce((sum, weight) => sum + weight, 0);
  const active = weights.map((weight, index) => ({ weight, index })).filter(({ weight }) => weight > 0);
  let remaining = total;
  active.forEach(({ weight, index }, position) => {
    const amount = position === active.length - 1 ? remaining : total * weight / eligible;
    allocations[index] = amount;
    remaining -= amount;
  });
  return { total, personal: allocations[0], other: allocations[1], operator: allocations[2] };
}

function validate(inputs, phase) {
  if (!inputs || typeof inputs !== 'object' || Array.isArray(inputs)) throw new TypeError('Network inputs must be an object.');
  if (!PHASES.has(phase)) throw new RangeError(`Unknown network phase: ${String(phase)}.`);
  const config = { ...DEFAULT_NETWORK, ...inputs };
  if (!['holders', 'staking'].includes(config.fundRewardMode)) throw new RangeError('fundRewardMode must be holders or staking.');
  const cents = Object.fromEntries(MONEY_INPUTS.map((name) => [name, money(name, config[name])]));
  if (cents.purchaseBudget === 0) throw new RangeError('purchaseBudget must be at least one cent.');
  for (const name of PERCENT_INPUTS) numeric(name, config[name], 0, 100);
  for (const name of ['operatorSplitPercent', 'ongoingOperatorSplitPercent']) {
    if (config[name] + config.stickySplitPercent > 100) {
      throw new RangeError(`${name} plus stickySplitPercent cannot exceed 100 percent of total issuance.`);
    }
  }
  if (config.issuanceCutPercent === 100) throw new RangeError('issuanceCutPercent must be less than 100.');
  for (const name of ['payoutFeePercent', 'revCashoutFeePercent', 'operatorFundPercent']) {
    numeric(name, config[name], 0, 100);
    if (config[name] === 100) throw new RangeError(`${name} must be less than 100.`);
  }
  for (const name of ['rentGrowthPercent', 'costGrowthPercent']) numeric(name, config[name], -100, 100);
  numeric('revenuePremint', config.revenuePremint, 0, 1e15);
  numeric('revPrice', config.revPrice, 0.000001, MAX_DOLLARS);
  numeric('issuanceCutYears', config.issuanceCutYears, 0, 30, true);
  numeric('issuanceCutMonths', config.issuanceCutMonths, 1, 360, true);
  numeric('revenueMonths', config.revenueMonths, 0, 360, true);
  numeric('stickyVestingMonths', config.stickyVestingMonths, 0, 36, true);
  const horizon = Math.max(120, config.revenueMonths + 1);
  const maxYear = Math.floor((horizon - 1) / 12);
  const lowestIssuanceRate = (1 / config.revPrice)
    * (1 - config.issuanceCutPercent / 100) ** Math.floor(Math.min(horizon, config.issuanceCutYears * 12) / config.issuanceCutMonths);
  if (!(lowestIssuanceRate > 0) || !Number.isFinite(1 / lowestIssuanceRate)) {
    throw new RangeError('The issuance schedule exceeds the model range; reduce the cut rate or number of cuts.');
  }
  for (const [amount, growth, name] of [
    [cents.monthlyRent, config.rentGrowthPercent, 'Projected rent'],
    [cents.monthlyCosts, config.costGrowthPercent, 'Projected operating costs'],
  ]) {
    const bound = amount * Math.max(1, (1 + growth / 100) ** maxYear) * horizon;
    if (!Number.isFinite(bound) || bound > Number.MAX_SAFE_INTEGER) {
      throw new RangeError(`${name} exceeds the model's exact cent range; reduce the amounts or growth rates.`);
    }
  }
  return { config, cents, horizon };
}

/**
 * `history` contains month 0 through max(120, revenueMonths + 1). Each row uses
 * the same revenue field names as the current result, plus `month`, the month's
 * renter receipts/fees, cumulative reserve need, and cumulative REV issuance.
 * Milestones and reserve diagnostics describe that full hypothetical horizon
 * even before closing; current REV balances remain zero until `earning`.
 * Default rewards go immediately to all FUND holders, including operators,
 * without staking. Holder balances are constant in this illustration; a live
 * distributor must account for transfers and credits before each allocation.
 * The optional staking comparison uses constant participation. Its cohorts vest
 * at the start of month m + stickyVestingMonths, before rent; a zero-month delay
 * vests immediately after issuance. Vested tokens are automatically claimed.
 * This is not the real weekly round/snapshot implementation. FUND is neither
 * burned nor converted. Liquidation quotes freeze at the selected month and do
 * not include later vesting; forward diagnostics continue to assume no sale.
 */
export function projectNetwork(inputs = {}, phase = 'raising') {
  const { config, cents, horizon } = validate(inputs, phase);
  const isClosed = CLOSED.has(phase);
  const isRefund = phase === 'refunding' || phase === 'refunded';
  const netClosingBudget = cents.purchaseBudget + cents.opsReserve + cents.closingCosts;
  if (netClosingBudget <= 0) throw new RangeError('The purchase, operating reserve, and closing budget must total more than zero.');
  const closingGross = safeCents('Closing gross requirement', ceil(netClosingBudget / (1 - config.payoutFeePercent / 100)));
  const raiseGoal = safeCents('Raise goal', closingGross + cents.precloseSpent);
  const raised = phase === 'raising' || isRefund
    ? Math.round(raiseGoal * config.raisedPercent / 100)
    : raiseGoal;
  if (cents.precloseSpent > raised) throw new RangeError('precloseSpent cannot exceed the amount raised; increase raisedPercent or reduce spending.');
  if (cents.investment > raised) throw new RangeError('investment cannot exceed the amount raised; increase raisedPercent or reduce investment.');
  const availableEscrow = raised - cents.precloseSpent;

  const investorFundSupply = usd(raised) * 10_000;
  const operatorFraction = config.operatorFundPercent / 100;
  const operatorFundMint = investorFundSupply * operatorFraction / (1 - operatorFraction);
  const totalFundSupply = investorFundSupply + operatorFundMint;
  const fundSupply = phase === 'refunded' ? 0 : isClosed ? totalFundSupply : investorFundSupply;
  const personalFundTokens = config.investment * 10_000;
  const personalFundFraction = fundSupply > 0 ? personalFundTokens / fundSupply : 0;
  // Forward diagnostics assume the entire raise closes. A partly subscribed
  // escrow must not make the same investor's future REV allocation look larger.
  const successfulFundSupply = usd(raiseGoal) * 10_000 / (1 - operatorFraction);
  const plannedPersonalRevTokens = config.revenuePremint * personalFundTokens / successfulFundSupply;
  const successfulInvestorFundSupply = usd(raiseGoal) * 10_000;
  const automaticHolderRewards = config.fundRewardMode === 'holders';
  const personalStakedFund = automaticHolderRewards ? 0 : personalFundTokens * config.personalStakePercent / 100;
  const otherStakedFund = automaticHolderRewards ? 0 : Math.max(0, successfulInvestorFundSupply - personalFundTokens) * config.otherStakePercent / 100;
  const operatorStakedFund = automaticHolderRewards ? 0 : (successfulFundSupply - successfulInvestorFundSupply) * config.otherStakePercent / 100;
  const stakeWeights = automaticHolderRewards
    ? [personalFundTokens, Math.max(0, successfulInvestorFundSupply - personalFundTokens), successfulFundSupply - successfulInvestorFundSupply]
    : [personalStakedFund, otherStakedFund, operatorStakedFund];
  const eligibleStakedFund = stakeWeights.reduce((sum, weight) => sum + weight, 0);
  if (![operatorFundMint, totalFundSupply, plannedPersonalRevTokens].every(Number.isFinite)) {
    throw new RangeError('Planned token supply exceeds the model range.');
  }

  let revCash = 0;
  let investorRev = config.revenuePremint * (1 - operatorFraction);
  let operatorRev = config.revenuePremint * operatorFraction;
  let renterRev = 0;
  let stickyPending = 0;
  let stickyUnallocated = 0;
  let personalSticky = 0;
  let personalPendingSticky = 0;
  let cumulativeStickyMinted = 0;
  let cumulativeStickyVested = 0;
  let cumulativeOperatorStickyVested = 0;
  let cumulativeOtherInvestorStickyVested = 0;
  const cohorts = new Map();
  const totalRevSupply = () => investorRev + operatorRev + renterRev + stickyPending + stickyUnallocated;
  const vestSticky = (cohort) => {
    investorRev += cohort.personal + cohort.other;
    operatorRev += cohort.operator;
    personalSticky += cohort.personal;
    personalPendingSticky = Math.max(0, personalPendingSticky - cohort.personal);
    stickyPending = Math.max(0, stickyPending - cohort.total);
    cumulativeStickyVested += cohort.total;
    cumulativeOperatorStickyVested += cohort.operator;
    cumulativeOtherInvestorStickyVested += cohort.other;
  };
  let reserve = cents.opsReserve;
  let unpaidOps = 0;
  let cumulativeRent = 0;
  let cumulativeCosts = 0;
  let cumulativeOpsFromRevnet = 0;
  let cumulativeOpsFromReserve = 0;
  let cumulativeRenterCashouts = 0;
  let cumulativeFees = 0;
  let cumulativeRevMinted = 0;
  let cumulativeRevBurned = 0;
  let reserveNeeded = 0;
  let firstUnfundedMonth = null;
  const history = [];

  for (let month = 0; month <= horizon; month++) {
    const year = Math.floor(Math.max(0, month - 1) / 12);
    const issuanceCutsApplied = Math.floor(Math.min(month, config.issuanceCutYears * 12) / config.issuanceCutMonths);
    const issuanceRate = (1 / config.revPrice) * (1 - config.issuanceCutPercent / 100) ** issuanceCutsApplied;
    const split = month <= 12 ? config.operatorSplitPercent : config.ongoingOperatorSplitPercent;
    let rent = 0;
    let costs = 0;
    let opsFromRevnet = 0;
    let opsFromReserve = 0;
    let renterCashout = 0;
    let monthFees = 0;
    if (month > 0) {
      const matured = cohorts.get(month);
      if (matured) {
        vestSticky(matured);
        cohorts.delete(month);
      }
      rent = Math.round(cents.monthlyRent * (1 + config.rentGrowthPercent / 100) ** year);
      costs = Math.round(cents.monthlyCosts * (1 + config.costGrowthPercent / 100) ** year);
      revCash += rent;
      const minted = usd(rent) * issuanceRate;
      const newOperatorRev = minted * split / 100;
      const newStickyRev = minted * config.stickySplitPercent / 100;
      const newRenterRev = Math.max(0, minted - newOperatorRev - newStickyRev);
      operatorRev += newOperatorRev;
      renterRev += newRenterRev;
      cumulativeRevMinted += minted;
      cumulativeStickyMinted += newStickyRev;
      if (eligibleStakedFund > 0 && newStickyRev > 0) {
        const cohort = allocateSticky(newStickyRev, stakeWeights);
        stickyPending += newStickyRev;
        personalPendingSticky += cohort.personal;
        if (automaticHolderRewards || config.stickyVestingMonths === 0) vestSticky(cohort);
        else cohorts.set(month + config.stickyVestingMonths, cohort);
      } else {
        // No eligible stakers: issued tokens remain outstanding and unallocated.
        // They are not recycled into a later cohort or credited to any holder.
        stickyUnallocated += newStickyRev;
      }
      // Spend the separate operating reserve before redeeming operator INCOME.
      opsFromReserve = Math.min(reserve, costs);
      reserve -= opsFromReserve;
      const costsAfterReserve = costs - opsFromReserve;
      const supplyBeforeOps = totalRevSupply();
      const opsAvailableGross = quoteCents(revCash, operatorRev, supplyBeforeOps);
      const opsNeededGross = ceil(costsAfterReserve / (1 - config.revCashoutFeePercent / 100));
      const opsGross = Math.min(opsAvailableGross, opsNeededGross);
      const opsBurn = revCash > 0 ? opsGross / revCash * supplyBeforeOps : 0;
      operatorRev = Math.max(0, operatorRev - opsBurn);
      cumulativeRevBurned += opsBurn;
      revCash -= opsGross;
      opsFromRevnet = floor(opsGross * (1 - config.revCashoutFeePercent / 100));
      monthFees += opsGross - opsFromRevnet;
      const uncovered = Math.max(0, costs - opsFromRevnet);
      reserveNeeded += uncovered;
      const unpaid = uncovered - opsFromReserve;
      unpaidOps += unpaid;
      if (unpaid > 0 && firstUnfundedMonth === null) firstUnfundedMonth = month;

      // Only this month's renter allocation is eligible for the exit scenario.
      // The renter exits after ops. Prior renter holdings remain outstanding.
      const requestedRenterBurn = newRenterRev * config.renterCashoutPercent / 100;
      const supplyBeforeRenter = totalRevSupply();
      const renterGross = quoteCents(revCash, requestedRenterBurn, supplyBeforeRenter);
      if (renterGross > 0) {
        renterRev = Math.max(0, renterRev - requestedRenterBurn);
        cumulativeRevBurned += requestedRenterBurn;
        revCash -= renterGross;
        renterCashout = floor(renterGross * (1 - config.revCashoutFeePercent / 100));
        monthFees += renterGross - renterCashout;
      }
      cumulativeRent = safeCents('Cumulative rent', cumulativeRent + rent);
      cumulativeCosts = safeCents('Cumulative costs', cumulativeCosts + costs);
      cumulativeOpsFromRevnet += opsFromRevnet;
      cumulativeOpsFromReserve += opsFromReserve;
      cumulativeRenterCashouts += renterCashout;
      cumulativeFees += monthFees;
    }
    const supply = totalRevSupply();
    const personalRevTokens = plannedPersonalRevTokens + personalSticky;
    const personalRevCash = quoteCents(revCash, personalRevTokens, supply);
    const personalLoan = loanQuote(personalRevCash);
    history.push({
      month,
      monthsApplied: month,
      revCash: usd(revCash),
      revSupply: supply,
      revInvestorTokens: investorRev,
      revOperatorTokens: operatorRev,
      revRenterTokens: renterRev,
      revStickyPendingTokens: stickyPending,
      revStickyUnallocatedTokens: stickyUnallocated,
      stickyPendingTokens: stickyPending,
      stickyUnallocatedTokens: stickyUnallocated,
      personalRevTokens,
      personalPremintTokens: plannedPersonalRevTokens,
      personalStickyTokens: personalSticky,
      personalPendingStickyTokens: personalPendingSticky,
      personalStakedFundTokens: personalStakedFund,
      otherStakedFundTokens: otherStakedFund,
      operatorStakedFundTokens: operatorStakedFund,
      eligibleStakedFundTokens: automaticHolderRewards ? 0 : eligibleStakedFund,
      eligibleFundRewardTokens: eligibleStakedFund,
      personalFundRewardTokens: personalSticky,
      personalPendingFundRewardTokens: personalPendingSticky,
      personalFundRewardSharePercent: eligibleStakedFund > 0 ? stakeWeights[0] / eligibleStakedFund * 100 : 0,
      personalStickySharePercent: eligibleStakedFund > 0 ? stakeWeights[0] / eligibleStakedFund * 100 : 0,
      revPriceNow: supply > 0 ? usd(revCash) / supply : 0,
      currentIssuanceRate: issuanceRate,
      currentIssuancePrice: 1 / issuanceRate,
      issuanceCutsApplied,
      currentOperatorSplitPercent: split,
      currentStickySplitPercent: config.stickySplitPercent,
      currentRenterSplitPercent: 100 - split - config.stickySplitPercent,
      lastMonthRent: usd(rent),
      lastMonthCosts: usd(costs),
      lastOpsCashFromRevnet: usd(opsFromRevnet),
      lastOpsFromReserve: usd(opsFromReserve),
      lastRenterCashout: usd(renterCashout),
      lastMonthFees: usd(monthFees),
      opsReserveCash: usd(reserve),
      unpaidOps: usd(unpaidOps),
      cumulativeRent: usd(cumulativeRent),
      cumulativeCosts: usd(cumulativeCosts),
      cumulativeOpsFromRevnet: usd(cumulativeOpsFromRevnet),
      cumulativeOpsFromReserve: usd(cumulativeOpsFromReserve),
      cumulativeRenterCashouts: usd(cumulativeRenterCashouts),
      cumulativeFees: usd(cumulativeFees),
      cumulativeRevMinted,
      cumulativeRevBurned,
      cumulativeStickyMinted,
      cumulativeStickyVested,
      cumulativeFundRewardsAllocated: cumulativeStickyVested,
      cumulativeOperatorFundRewards: cumulativeOperatorStickyVested,
      cumulativeOtherInvestorFundRewards: cumulativeOtherInvestorStickyVested,
      cumulativeOperatorStickyVested,
      cumulativeOtherInvestorStickyVested,
      reserveNeeded: usd(reserveNeeded),
      personalCashout: usd(personalRevCash),
      personalLoanPrincipal: usd(personalLoan.principal),
      personalLoanCash: usd(personalLoan.cash),
      personalLoanFees: usd(personalLoan.fees),
      loanAvailable: personalLoan.cash > 0,
    });
  }

  const projected = history[config.revenueMonths];
  const current = isClosed ? { ...projected } : Object.fromEntries(
    Object.entries(history[0]).map(([name, value]) => [name, typeof value === 'boolean' ? false : 0]),
  );
  const projectedReserve = Math.round(projected.opsReserveCash * 100);
  const projectedUnpaid = Math.round(projected.unpaidOps * 100);
  const saleCosts = Math.round(cents.salePrice * config.saleCostPercent / 100);
  const netSale = Math.max(0, cents.salePrice - saleCosts - cents.saleDebt - projectedUnpaid + projectedReserve);
  const fundSaleCash = phase === 'liquidated' ? netSale : 0;
  const personalFundSale = phase === 'liquidated' ? quoteCents(fundSaleCash, personalFundTokens, totalFundSupply) : 0;
  const refundCash = isRefund ? availableEscrow : 0;
  const personalRefund = isRefund ? quoteCents(refundCash, personalFundTokens, investorFundSupply) : 0;
  const personalFundCashout = phase === 'raising'
    ? Math.min(availableEscrow, floor(availableEscrow * personalFundFraction * (0.9 + 0.1 * personalFundFraction)))
    : phase === 'refunding' ? personalRefund : phase === 'liquidated' ? personalFundSale : 0;
  const nextMonthLoanCash = isClosed
    ? phase === 'liquidated' ? current.personalLoanCash : history[config.revenueMonths + 1].personalLoanCash
    : 0;
  const finalDiagnostic = history.at(-1);

  return {
    ...config,
    ...current,
    phase,
    raiseGoal: usd(raiseGoal),
    closingGrossRequired: usd(closingGross),
    closingFeeEstimate: usd(closingGross - netClosingBudget),
    raised: usd(raised),
    escrowCash: phase === 'raising' || phase === 'funded' || phase === 'refunding' ? usd(availableEscrow) : 0,
    fundInvestorSupply: investorFundSupply,
    fundOperatorMint: operatorFundMint,
    fundTotalSupply: totalFundSupply,
    fundSupply,
    personalFundTokens: phase === 'refunded' ? 0 : personalFundTokens,
    historicalPersonalFundTokens: personalFundTokens,
    personalFundPercent: personalFundFraction * 100,
    plannedPersonalRevTokens,
    personalRevTokens: current.personalRevTokens,
    refundableCash: phase === 'refunding' ? usd(refundCash) : 0,
    refundedCash: phase === 'refunded' ? usd(refundCash) : 0,
    personalRefund: usd(personalRefund),
    personalFundCashout: usd(personalFundCashout),
    fundCashOutTaxPercent: phase === 'raising' ? 10 : phase === 'funded' || phase === 'earning' ? 100 : 0,
    operatorFundMinted: isClosed,
    revenuePreminted: isClosed,
    purchaseCompleted: isClosed,
    netSaleProceeds: usd(netSale),
    saleCostEstimate: usd(saleCosts),
    fundSaleCash: usd(fundSaleCash),
    personalFundSaleClaim: usd(personalFundSale),
    reserveReturnedToFund: phase === 'liquidated' ? projected.opsReserveCash : 0,
    opsReserveCash: phase === 'liquidated' ? 0 : current.opsReserveCash,
    nextMonthLoanCash,
    nextMonthLoanCashIncrease: Math.round((nextMonthLoanCash - current.personalLoanCash) * 100) / 100,
    history,
    trajectory: history,
    milestones: [6, 12, 24, 60, 120].map((month) => history[month]),
    diagnosticHorizonMonths: horizon,
    reserveNeeded: finalDiagnostic.reserveNeeded,
    minimumOpsReserveCash: finalDiagnostic.opsReserveCash,
    firstUnfundedMonth,
  };
}
