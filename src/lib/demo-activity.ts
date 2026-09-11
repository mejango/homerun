import type { projectNetwork } from '../../web/network-model.mjs';

type Projection = ReturnType<typeof projectNetwork>;
type ActivityHistoryRow = {
  month: number;
  lastMonthRent: number;
  cumulativeRevMinted: number;
  cumulativeFundRewardsAllocated: number;
  revStickyUnallocatedTokens: number;
  lastOpsFromReserve: number;
  lastOpsCashFromRevnet: number;
  lastRenterCashout: number;
  lastMonthFees: number;
  unpaidOps: number;
};

export type DemoActivityKind = 'configuration' | 'contribution' | 'milestone' | 'purchase' | 'issuance' | 'income' | 'expense' | 'cashout' | 'reward' | 'refund' | 'sale';

export type DemoActivityEvent = {
  id: string;
  kind: DemoActivityKind;
  title: string;
  detail: string;
  period: string;
  amount?: number;
  unit?: 'USD' | 'FUND' | 'INCOME';
  tokens?: { amount: number; unit: 'FUND' | 'INCOME'; action: 'issued' | 'redeemed' };
};

const contributionWeights = [8, 12, 15, 10, 15, 12, 18, 10];
const dollars = (value: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value);
const number = (value: number) => new Intl.NumberFormat('en-US', { maximumFractionDigits: 9 }).format(value);

/** Assign the final rounding remainder once, including for tiny or very large raises. */
function splitCents(total: number, weights: readonly number[]): number[] {
  const sum = weights.reduce((value, weight) => value + BigInt(weight), 0n);
  if (!sum) return weights.map(() => 0);
  let remaining = BigInt(total);
  const last = weights.findLastIndex(weight => weight > 0);
  return weights.map((weight, index) => {
    const part = index === last ? remaining : BigInt(total) * BigInt(weight) / sum;
    remaining -= part;
    return Number(part);
  });
}

/** Use an illustrative scenario clock, independent of wall time and rendering. */
function withRelativePeriods(events: DemoActivityEvent[], monthsApplied: number): DemoActivityEvent[] {
  const day = 24 * 60;
  const stageDays: Record<string, number> = {
    Setup: 0,
    'During the raise': 10,
    'Raise closed': 10,
    Refunds: 11,
    'Refunds complete': 12,
    Purchase: 12,
    'Income begins': 12,
    'Asset sale': 13 + monthsApplied * 30,
  };
  let cursor = -8;
  const elapsed = events.map(event => {
    const raiseDay = /^Raise day (\d+)$/.exec(event.period);
    const month = /^Month (\d+)$/.exec(event.period);
    const scenarioDay = raiseDay ? Number(raiseDay[1]) : month ? 12 + Number(month[1]) * 30 : stageDays[event.period] ?? 0;
    // Events within one modeled period remain ordered; month boundaries retain their spacing.
    cursor = Math.max(cursor + 8, scenarioDay * day);
    return cursor;
  });
  const latest = elapsed.at(-1) ?? 0;
  const units = [[365 * day, 'y'], [30 * day, 'mo'], [day, 'd'], [60, 'h'], [1, 'm']] as const;
  return events.map((event, index) => {
    const age = latest - elapsed[index] + 8;
    const [minutes, unit] = units.find(([minutes]) => age >= minutes)!;
    return { ...event, period: `${Math.floor(age / minutes)}${unit} ago` };
  });
}

/**
 * Illustrative history, not indexed transactions. Configuration rows describe assumptions;
 * fictional contribution/refund installments conserve the model's aggregate whole cents.
 * Current-stage events never consume forward diagnostics or an individual holder's quote.
 */
export function buildDemoActivity(p: Projection): DemoActivityEvent[] {
  const events: DemoActivityEvent[] = [];
  const add = (id: string, kind: DemoActivityKind, title: string, detail: string, period: string, amount?: number, unit?: DemoActivityEvent['unit'], tokens?: DemoActivityEvent['tokens']) => {
    events.push({ id, kind, title, detail, period, ...(amount === undefined ? {} : { amount, unit }), ...(tokens ? { tokens } : {}) });
  };
  const setting = (id: string, title: string, detail: string, amount?: number, unit?: DemoActivityEvent['unit']) => add(`setup-${id}`, 'configuration', title, detail, 'Setup', amount, unit);

  // Distinct assumptions provide useful older history even before the first contribution.
  setting('scenario', 'Demo scenario prepared', 'This illustrative history follows the project’s modeling inputs.');
  setting('goal', 'Raise goal modeled', 'The modeled goal includes the purchase, reserve, closing costs and pre-purchase spending.', p.raiseGoal, 'USD');
  setting('asset', 'Asset budget modeled', 'The purchase price is a planning assumption until the asset is bought.', p.purchaseBudget, 'USD');
  setting('reserve', 'Operating reserve planned', 'This amount is planned for operating costs after a successful purchase.', p.opsReserve, 'USD');
  setting('closing', 'Closing costs estimated', 'Planned closing costs are included in the raise goal.', p.closingCosts, 'USD');
  setting('fee', 'Closing fee estimated', 'The modeled payout fee is included in the amount to raise.', p.closingFeeEstimate, 'USD');
  setting('preclose', 'Pre-purchase spending modeled', `${dollars(p.precloseSpent)} of modeled spending is included in the goal and reduces the available escrow.`);
  setting('contributor-share', 'Contributor FUND share planned', `Contributors retain ${number(100 - p.operatorFundPercent)}% of FUND after the planned operator allocation.`);
  setting('operator-share', 'Operator FUND share planned', `The planned ${number(p.operatorFundPercent)}% operator share is issued only after a successful purchase.`);
  setting('revenue', 'Monthly revenue modeled', 'This monthly revenue assumption is used for income projections.', p.monthlyRent, 'USD');
  setting('costs', 'Monthly expenses modeled', 'This monthly expense assumption is used for operating projections.', p.monthlyCosts, 'USD');
  setting('revenue-growth', 'Revenue growth modeled', `The revenue assumption changes ${number(p.rentGrowthPercent)}% per year.`);
  setting('cost-growth', 'Expense growth modeled', `The expense assumption changes ${number(p.costGrowthPercent)}% per year.`);
  setting('premint', 'Initial INCOME allocation planned', 'This initial INCOME supply is planned for FUND ownership after purchase.', p.revenuePremint, 'INCOME');
  setting('price', 'INCOME issuance price planned', `The initial modeled price is $${number(p.revPrice)} per INCOME token.`);
  setting('issuance', 'INCOME issuance schedule planned', `Issuance is modeled to decrease ${number(p.issuanceCutPercent)}% every ${p.issuanceCutMonths} months for ${p.issuanceCutYears} years.`);
  setting('operator-income', 'Operator INCOME allocation planned', `Operators are allocated ${number(p.operatorSplitPercent)}% of new INCOME in year one and ${number(p.ongoingOperatorSplitPercent)}% afterward.`);
  setting('rewards', 'FUND rewards planned', `${number(p.stickySplitPercent)}% of new INCOME is allocated to FUND rewards under the modeled ${p.fundRewardMode === 'holders' ? 'holder' : 'participation and vesting'} assumptions.`);
  setting('customer-income', 'Customer INCOME allocation planned', `Customers are allocated ${number(100 - p.operatorSplitPercent - p.stickySplitPercent)}% of new INCOME in year one and ${number(100 - p.ongoingOperatorSplitPercent - p.stickySplitPercent)}% afterward.`);
  setting('sale', 'Eventual asset sale modeled', `The planned sale price is ${dollars(p.salePrice)}, with ${number(p.saleCostPercent)}% sale costs and ${dollars(p.saleDebt)} debt. These are future assumptions until the Asset sale stage.`);

  add('raise-opened', 'milestone', 'FUND raise opened', 'Contributions build FUND ownership before the asset is purchased.', 'Raise day 1');
  const portions = splitCents(Math.round(p.raised * 100), contributionWeights);
  const goalCents = Math.round(p.raiseGoal * 100);
  let raisedCents = 0;
  let milestone = 25;
  portions.forEach((cents, index) => {
    if (!cents) return;
    raisedCents += cents;
    const period = `Raise day ${index + 2}`;
    add(`contribution-${index}`, 'contribution', 'Contribution received', `${number(cents * 100)} FUND issued.`, period, cents / 100, 'USD', { amount: cents * 100, unit: 'FUND', action: 'issued' });
    while (milestone <= 100 && BigInt(raisedCents) * 100n >= BigInt(goalCents) * BigInt(milestone)) {
      add(`raise-${milestone}`, 'milestone', milestone === 100 ? 'Raise goal reached' : `${milestone}% of the goal reached`, `${dollars(raisedCents / 100)} raised in this illustrative history.`, period);
      milestone += 25;
    }
  });
  if (p.precloseSpent > 0) add('preclose-spending', 'expense', 'Pre-purchase costs paid', 'This spending reduces the cash remaining in escrow.', 'During the raise', -p.precloseSpent, 'USD');

  if (p.phase === 'refunding' || p.phase === 'refunded') {
    add('raise-failed', 'milestone', 'Raise marked unsuccessful', 'The demo follows the refund path; the asset was not purchased.', 'Refunds');
    add('refunds-opened', 'refund', 'Refunds opened', `${dollars(p.phase === 'refunding' ? p.refundableCash : p.refundedCash)} remains after pre-purchase spending for contributor refunds.`, 'Refunds');
    if (p.phase === 'refunded') {
      splitCents(Math.round(p.refundedCash * 100), portions).forEach((cents, index) => {
        if (cents) add(`refund-${index}`, 'refund', 'Refund sent', `${number(portions[index] * 100)} FUND redeemed for this share of the remaining escrow.`, 'Refunds complete', -cents / 100, 'USD', { amount: portions[index] * 100, unit: 'FUND', action: 'redeemed' });
      });
      add('refunds-complete', 'milestone', 'Refunds complete', 'The remaining refund cash has been distributed; no escrow remains.', 'Refunds complete');
      if (p.fundInvestorSupply > 0) add('fund-refund-burn', 'issuance', 'Refunded FUND burned', 'The completed refund stage leaves no FUND supply outstanding.', 'Refunds complete', -p.fundInvestorSupply, 'FUND');
    }
  }

  const purchased = p.phase === 'earning' || p.phase === 'liquidated';
  if (p.phase === 'funded' || purchased) add('raise-closed', 'milestone', 'Raise closed', 'The modeled raise is complete. Funds are held for the asset purchase.', 'Raise closed');
  if (purchased) {
    add('asset-purchased', 'purchase', 'Asset purchased', 'The acquisition budget is applied to the asset purchase.', 'Purchase', -p.purchaseBudget, 'USD');
    if (p.closingCosts > 0) add('closing-costs', 'expense', 'Closing costs paid', 'Closing expenses come from the completed raise.', 'Purchase', -p.closingCosts, 'USD');
    if (p.closingFeeEstimate > 0) add('closing-fee', 'expense', 'Closing fee applied', 'The payout fee estimate is accounted for at purchase.', 'Purchase', -p.closingFeeEstimate, 'USD');
    if (p.opsReserve > 0) add('reserve-funded', 'milestone', 'Operating reserve set aside', `${dollars(p.opsReserve)} is held separately to cover operating costs.`, 'Purchase');
    if (p.operatorFundMinted && p.fundOperatorMint > 0) add('operator-fund', 'issuance', 'Operator FUND share issued', `The operator receives the planned ${number(p.operatorFundPercent)}% ownership after purchase.`, 'Purchase', p.fundOperatorMint, 'FUND');
    if (p.revenuePreminted && p.revenuePremint > 0) add('initial-income', 'issuance', 'Initial INCOME allocated', 'The initial modeled INCOME supply is allocated across FUND ownership.', 'Income begins', p.revenuePremint, 'INCOME');

    const history: readonly ActivityHistoryRow[] = p.history;
    const elapsed = history.filter(row => row.month >= 0 && row.month <= p.monthsApplied);
    let monthlyEvents = 0;
    for (let index = 1; index < elapsed.length; index++) {
      const row = elapsed[index];
      const before = elapsed[index - 1];
      const period = `Month ${row.month}`;
      const monthEvent = (name: string, kind: DemoActivityKind, title: string, detail: string, amount?: number, unit?: DemoActivityEvent['unit']) => {
        add(`month-${row.month}-${name}`, kind, title, detail, period, amount, unit);
        monthlyEvents++;
      };
      if (row.lastMonthRent > 0) monthEvent('revenue', 'income', 'Revenue received', 'Modeled monthly revenue enters the INCOME treasury.', row.lastMonthRent, 'USD');
      const issued = row.cumulativeRevMinted - before.cumulativeRevMinted;
      if (issued > 0) monthEvent('issued', 'issuance', 'INCOME issued from revenue', 'New INCOME follows the modeled issuance rate and allocation settings.', issued, 'INCOME');
      const rewards = row.cumulativeFundRewardsAllocated - before.cumulativeFundRewardsAllocated;
      if (rewards > 0) monthEvent('rewards', 'reward', 'FUND rewards allocated', 'INCOME rewards are allocated to eligible FUND ownership under this model’s reward assumptions.', rewards, 'INCOME');
      const unallocated = row.revStickyUnallocatedTokens - before.revStickyUnallocatedTokens;
      if (unallocated > 0) monthEvent('unallocated', 'reward', 'Reward INCOME remains unallocated', 'These issued rewards have no eligible allocation under the modeled participation assumptions.', unallocated, 'INCOME');
      if (row.lastOpsFromReserve > 0) monthEvent('reserve', 'expense', 'Reserve covered operating costs', 'The separate operating reserve pays costs before operator INCOME is cashed out.', -row.lastOpsFromReserve, 'USD');
      if (row.lastOpsCashFromRevnet > 0) monthEvent('operator-cashout', 'cashout', 'Operator INCOME cashed out', 'Net cash after fees covers operating costs that remain after using the reserve.', -row.lastOpsCashFromRevnet, 'USD');
      if (row.lastRenterCashout > 0) monthEvent('customer-cashout', 'cashout', 'Customer INCOME cashed out', 'The modeled customer exit exchanges this month’s eligible INCOME allocation for net cash.', -row.lastRenterCashout, 'USD');
      if (row.lastMonthFees > 0) monthEvent('fees', 'expense', 'INCOME cash-out fees applied', 'Combined fees from the modeled operator and customer cash-outs.', -row.lastMonthFees, 'USD');
      const unpaid = Math.round(row.unpaidOps * 100) - Math.round(before.unpaidOps * 100);
      if (unpaid > 0) monthEvent('unpaid', 'milestone', 'Operating costs remain unpaid', `${dollars(unpaid / 100)} of this month’s costs could not be covered by the reserve or operator cash-out.`);
    }
    if (p.monthsApplied > 0 && monthlyEvents === 0) add('income-checkpoint', 'milestone', `Income modeled through month ${p.monthsApplied}`, 'No revenue receipts, expense payments or reward allocations occur under the selected assumptions.', `Month ${p.monthsApplied}`);
  }

  if (p.phase === 'liquidated') {
    add('asset-sale', 'sale', 'Asset sold', `The asset is sold at the modeled ${dollars(p.salePrice)} sale price.`, 'Asset sale');
    if (p.saleCostEstimate > 0) add('sale-costs', 'sale', 'Sale costs accounted for', `${dollars(p.saleCostEstimate)} is deducted in the sale settlement calculation.`, 'Asset sale');
    if (p.saleDebt > 0) add('sale-debt', 'sale', 'Debt accounted for at sale', `${dollars(p.saleDebt)} is included in the settlement calculation; this is not a separate modeled repayment.`, 'Asset sale');
    if (p.unpaidOps > 0) add('sale-unpaid', 'sale', 'Unpaid operating costs accounted for', `${dollars(p.unpaidOps)} is deducted in the sale settlement calculation.`, 'Asset sale');
    if (p.reserveReturnedToFund > 0) add('sale-reserve', 'sale', 'Unused reserve included in settlement', `${dollars(p.reserveReturnedToFund)} is already included in the final FUND balance.`, 'Asset sale');
    add('sale-settlement', 'sale', p.fundSaleCash > 0 ? 'Sale proceeds available to FUND' : 'No distributable sale proceeds remain', 'The modeled FUND settlement is available to holders; individual sale claims are not simulated.', 'Asset sale', p.fundSaleCash, 'USD');
  }

  return withRelativePeriods(events, p.monthsApplied).slice(-20).reverse();
}
