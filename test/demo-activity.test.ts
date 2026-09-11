import { describe, expect, it } from 'vitest';
import { projectNetwork } from '../web/network-model.mjs';
import { buildDemoActivity, type DemoActivityEvent } from '../src/lib/demo-activity';

const phases = ['raising', 'funded', 'refunding', 'refunded', 'earning', 'liquidated'];
const cents = (amount: number) => Math.round(amount * 100);
const moneyTotal = (events: DemoActivityEvent[]) => events.reduce((sum, event) => sum + cents(event.amount ?? 0), 0);
const get = (events: DemoActivityEvent[], id: string) => events.find(event => event.id === id);
const monthly = (events: DemoActivityEvent[]) => events.filter(event => event.id.startsWith('month-'));

describe('modeled demo activity', () => {
  it.each(phases)('provides twenty deterministic, distinct, well-formed events for %s', phase => {
    const p = projectNetwork({}, phase);
    const events = buildDemoActivity(p);
    expect(events).toHaveLength(20);
    expect(new Set(events.map(event => event.id)).size).toBe(20);
    expect(buildDemoActivity(p)).toEqual(events);
    for (const event of events) {
      expect(event.title.length).toBeGreaterThan(0);
      expect(event.detail.length).toBeGreaterThan(0);
      expect(event.period.length).toBeGreaterThan(0);
      expect(event).not.toHaveProperty('timestamp');
      expect(event).not.toHaveProperty('txHash');
      expect(event).not.toHaveProperty('address');
      if (event.amount !== undefined) {
        expect(Number.isFinite(event.amount)).toBe(true);
        expect(['USD', 'FUND', 'INCOME']).toContain(event.unit);
        if (event.unit === 'USD') expect(event.amount).toBe(cents(event.amount) / 100);
      }
    }
  });

  it('conserves contributed cents, including fractional-dollar and one-cent raises', () => {
    for (const purchaseBudget of [.01, 1.03, 500_000.17, 1_000_000_000]) {
      const p = projectNetwork({ purchaseBudget, opsReserve: 0, payoutFeePercent: 0, raisedPercent: 100, investment: 0 });
      const contributions = buildDemoActivity(p).filter(event => event.kind === 'contribution');
      expect(moneyTotal(contributions)).toBe(cents(p.raised));
      expect(contributions.every(event => event.amount! > 0 && event.detail.includes('FUND issued'))).toBe(true);
      for (const event of contributions) expect(event.tokens).toEqual({ amount: cents(event.amount!) * 100, unit: 'FUND', action: 'issued' });
    }
  });

  it('uses current progress for raise milestones and leaves purchase pending after the raise closes', () => {
    const low = buildDemoActivity(projectNetwork({ raisedPercent: 10, investment: 0 }));
    expect(low.some(event => /^raise-\d+$/.test(event.id))).toBe(false);
    const raising = buildDemoActivity(projectNetwork({ raisedPercent: 60, investment: 0 }));
    expect(get(raising, 'raise-25')).toBeDefined();
    expect(get(raising, 'raise-50')).toBeDefined();
    expect(get(raising, 'raise-75')).toBeUndefined();
    const funded = buildDemoActivity(projectNetwork({}, 'funded'));
    expect(funded[0].id).toBe('raise-closed');
    expect(get(funded, 'raise-100')).toBeDefined();
    expect(funded.some(event => ['purchase', 'income', 'refund', 'sale', 'issuance'].includes(event.kind))).toBe(false);
    expect(monthly(funded)).toEqual([]);
  });

  it.each(['raising', 'funded', 'refunding', 'refunded'])('%s ignores the fully populated future revenue trajectory', phase => {
    const p = projectNetwork({ revenueMonths: 120 }, phase);
    expect(p.history[120].cumulativeRent).toBeGreaterThan(0);
    const events = buildDemoActivity(p);
    expect(monthly(events)).toEqual([]);
    expect(events.some(event => ['asset-purchased', 'operator-fund', 'initial-income', 'sale-settlement'].includes(event.id))).toBe(false);
  });

  it('describes meaningful setup at zero raised without inventing contributions', () => {
    const events = buildDemoActivity(projectNetwork({ raisedPercent: 0, investment: 0 }));
    expect(events).toHaveLength(20);
    expect(events.filter(event => event.kind === 'configuration')).toHaveLength(19);
    expect(events.filter(event => event.kind === 'contribution')).toEqual([]);
    expect(events[0].id).toBe('raise-opened');
    expect(events.every(event => event.kind === 'configuration' || event.id === 'raise-opened')).toBe(true);
    expect(get(events, 'setup-sale')?.detail).toContain('future assumptions');
    expect(get(events, 'setup-operator-share')?.detail).toContain('only after');
  });

  it('shows purchase and initial allocations at month zero, with no revenue or ongoing rewards', () => {
    const p = projectNetwork({ revenueMonths: 0 }, 'earning');
    const events = buildDemoActivity(p);
    expect(get(events, 'asset-purchased')?.amount).toBe(-p.purchaseBudget);
    expect(get(events, 'operator-fund')?.amount).toBe(p.fundOperatorMint);
    expect(get(events, 'initial-income')?.amount).toBe(p.revenuePremint);
    expect(monthly(events)).toEqual([]);
    expect(events.some(event => event.kind === 'income' || event.kind === 'reward')).toBe(false);
  });

  it('takes monthly receipts, paid costs, issuance and reward allocations from elapsed history', () => {
    const p = projectNetwork({ revenueMonths: 1 }, 'earning');
    const row = p.history[1];
    const before = p.history[0];
    const events = buildDemoActivity(p);
    expect(get(events, 'month-1-revenue')?.amount).toBe(row.lastMonthRent);
    expect(get(events, 'month-1-reserve')?.amount).toBe(-row.lastOpsFromReserve);
    expect(get(events, 'month-1-issued')?.amount).toBe(row.cumulativeRevMinted - before.cumulativeRevMinted);
    expect(get(events, 'month-1-rewards')?.amount).toBe(row.cumulativeFundRewardsAllocated - before.cumulativeFundRewardsAllocated);
    expect(get(events, 'month-1-operator-cashout')).toBeUndefined();
    expect(get(events, 'month-1-customer-cashout')).toBeUndefined();
    expect(get(events, 'month-1-fees')).toBeUndefined();
    expect(monthly(events).every(event => event.period === 'Month 1')).toBe(true);
  });

  it('records net cash-outs and combined fees while distinguishing unpaid cost demand', () => {
    const p = projectNetwork({ opsReserve: 0, monthlyCosts: 100_000, revenueMonths: 1, renterCashoutPercent: 100, revCashoutFeePercent: 5 }, 'earning');
    const row = p.history[1];
    const events = buildDemoActivity(p);
    expect(get(events, 'month-1-operator-cashout')?.amount).toBe(-row.lastOpsCashFromRevnet);
    expect(get(events, 'month-1-customer-cashout')?.amount).toBe(-row.lastRenterCashout);
    expect(get(events, 'month-1-fees')?.amount).toBe(-row.lastMonthFees);
    expect(get(events, 'month-1-unpaid')).toBeDefined();
    expect(get(events, 'month-1-unpaid')?.amount).toBeUndefined();
    const treasuryFlow = moneyTotal(monthly(events).filter(event => ['income', 'cashout'].includes(event.kind) || event.id.endsWith('-fees')));
    expect(treasuryFlow).toBe(cents(row.revCash));
    expect(cents(row.lastOpsCashFromRevnet + row.lastOpsFromReserve + row.unpaidOps)).toBe(cents(row.lastMonthCosts));
  });

  it('does not equate issued rewards with allocations when modeled rewards remain unvested', () => {
    const p = projectNetwork({ fundRewardMode: 'staking', stickyVestingMonths: 4, revenueMonths: 1 }, 'earning');
    expect(p.history[1].cumulativeStickyMinted).toBeGreaterThan(0);
    expect(p.history[1].cumulativeFundRewardsAllocated).toBe(0);
    const events = buildDemoActivity(p);
    expect(get(events, 'month-1-rewards')).toBeUndefined();
    expect(events.some(event => /staked|stake deposited|loan taken|shop sale/i.test(event.title))).toBe(false);
  });

  it('caps monthly activity at the selected horizon and orders it newest first', () => {
    const p = projectNetwork({ revenueMonths: 3 }, 'earning');
    const events = buildDemoActivity(p);
    const months = monthly(events).map(event => Number(event.period.replace('Month ', '')));
    expect(Math.max(...months)).toBe(3);
    expect(months).toEqual([...months].sort((a, b) => b - a));
    expect(events[0].period).toBe('Month 3');
    const prior = buildDemoActivity(p);
    // Poisoning future rows and diagnostics must not affect completed activity.
    for (const row of p.history.filter(row => row.month > 3)) Object.assign(row, { lastMonthRent: 987_654_321, cumulativeFundRewardsAllocated: 987_654_321 });
    Object.assign(p, { firstUnfundedMonth: 100, nextMonthLoanCash: 987_654_321, netSaleProceeds: 987_654_321 });
    expect(buildDemoActivity(p)).toEqual(prior);
  });

  it('responds to changed project assumptions without depending on the selected personal investment', () => {
    const baseline = buildDemoActivity(projectNetwork({ revenueMonths: 1, investment: 0 }, 'earning'));
    const changed = buildDemoActivity(projectNetwork({ revenueMonths: 1, monthlyRent: 25_000, investment: 0 }, 'earning'));
    expect(get(baseline, 'month-1-revenue')?.amount).toBe(10_000);
    expect(get(changed, 'month-1-revenue')?.amount).toBe(25_000);
    for (const phase of phases) {
      expect(buildDemoActivity(projectNetwork({ investment: 0 }, phase))).toEqual(buildDemoActivity(projectNetwork({ investment: 1000 }, phase)));
    }
  });

  it('opens refunds without inventing completed claims', () => {
    const p = projectNetwork({ precloseSpent: 12_345.67 }, 'refunding');
    const events = buildDemoActivity(p);
    expect(get(events, 'refunds-opened')).toBeDefined();
    expect(get(events, 'refunds-opened')?.amount).toBeUndefined();
    expect(events.some(event => /^refund-\d+$/.test(event.id))).toBe(false);
    expect(get(events, 'fund-refund-burn')).toBeUndefined();
    expect(get(events, 'preclose-spending')?.amount).toBe(-p.precloseSpent);
  });

  it.each(['refunding', 'refunded'])('keeps twenty useful events at zero cash in %s without invented refunds', phase => {
    const events = buildDemoActivity(projectNetwork({ raisedPercent: 0, investment: 0 }, phase));
    expect(events).toHaveLength(20);
    expect(events.some(event => /^refund-\d+$/.test(event.id))).toBe(false);
    expect(get(events, 'fund-refund-burn')).toBeUndefined();
    expect(monthly(events)).toEqual([]);
  });

  it('conserves completed refunds after spending and closes with the final FUND burn', () => {
    for (const purchaseBudget of [.01, 1.03, 500_000.17]) {
      const p = projectNetwork({ purchaseBudget, opsReserve: 0, payoutFeePercent: 0, precloseSpent: .01, raisedPercent: 100, investment: 0 }, 'refunded');
      const events = buildDemoActivity(p);
      const refunds = events.filter(event => /^refund-\d+$/.test(event.id));
      expect(moneyTotal(refunds)).toBe(-cents(p.refundedCash));
      expect(events[0].id).toBe('fund-refund-burn');
      expect(events[0].amount).toBe(-p.fundInvestorSupply);
      expect(get(events, 'refunds-complete')).toBeDefined();
      expect(refunds.every(event => event.amount! < 0)).toBe(true);
      expect(refunds.reduce((total, event) => total + event.tokens!.amount, 0)).toBe(p.fundInvestorSupply);
      expect(refunds.every(event => event.tokens?.action === 'redeemed' && event.tokens.unit === 'FUND')).toBe(true);
    }
  });

  it('only settles the sale in the sale phase without double-counting returned reserve', () => {
    const earning = projectNetwork({ revenueMonths: 1, saleDebt: 25_000 }, 'earning');
    expect(earning.netSaleProceeds).toBeGreaterThan(0);
    expect(buildDemoActivity(earning).some(event => event.kind === 'sale')).toBe(false);
    const p = projectNetwork({ revenueMonths: 1, saleDebt: 25_000 }, 'liquidated');
    const events = buildDemoActivity(p);
    expect(events[0].id).toBe('sale-settlement');
    expect(events[0].amount).toBe(p.fundSaleCash);
    expect(get(events, 'sale-reserve')).toBeDefined();
    expect(get(events, 'sale-reserve')?.amount).toBeUndefined();
    expect(get(events, 'sale-debt')?.amount).toBeUndefined();
    expect(moneyTotal(events.filter(event => event.kind === 'sale'))).toBe(cents(p.fundSaleCash));
    expect(get(events, 'sale-settlement')?.detail).toContain('claims are not simulated');
    const insolvent = buildDemoActivity(projectNetwork({ revenueMonths: 0, opsReserve: 0, salePrice: 10_000, saleDebt: 100_000 }, 'liquidated'));
    expect(get(insolvent, 'sale-settlement')?.amount).toBe(0);
    expect(get(insolvent, 'sale-debt')?.title).not.toMatch(/paid|repaid/);
  });

  it('keeps zero-flow income and sale scenarios meaningful without fabricated payments', () => {
    for (const phase of ['earning', 'liquidated']) {
      const p = projectNetwork({ monthlyRent: 0, monthlyCosts: 0, revenuePremint: 0, opsReserve: 0, operatorFundPercent: 0, payoutFeePercent: 0, salePrice: 0, revenueMonths: 120 }, phase);
      const events = buildDemoActivity(p);
      expect(events).toHaveLength(20);
      expect(monthly(events)).toEqual([]);
      expect(get(events, 'income-checkpoint')?.period).toBe('Month 120');
      expect(events.some(event => ['income', 'reward', 'cashout'].includes(event.kind))).toBe(false);
    }
  });

  it('does not mutate or access any personal quote or investment fields', () => {
    const raw = projectNetwork({ revenueMonths: 2 }, 'earning');
    const rejectPersonal = <T extends object>(value: T): T => new Proxy(value, {
      get(target, key, receiver) {
        if (typeof key === 'string' && (key === 'investment' || /personal|otherStaked|operatorStaked|Loan|trajectory|milestones|reserveNeeded|firstUnfunded|minimumOpsReserve/.test(key))) throw new Error(`Unexpected individual or future field: ${key}`);
        return Reflect.get(target, key, receiver);
      },
      set() { throw new Error('Activity must not mutate the projection'); },
    });
    const p = rejectPersonal({ ...raw, history: raw.history.map(rejectPersonal) });
    expect(() => buildDemoActivity(p)).not.toThrow();
    expect(buildDemoActivity(p)).toEqual(buildDemoActivity(raw));
  });
});
