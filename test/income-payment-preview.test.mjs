import test from 'node:test';
import assert from 'node:assert/strict';
import { projectNetwork } from '../web/network-model.mjs';
import { incomePaymentPreview, renderIncomePaymentDetails } from '../web/income-payment-preview.mjs';

const close = (actual, expected, tolerance = 1e-8) => {
  assert.ok(Number.isFinite(actual), `expected a finite number, received ${actual}`);
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} differs from ${expected}`);
};
const emptyPool = {
  phase: 'earning', monthsApplied: 0, revCash: 0, revSupply: 0,
  currentIssuanceRate: 10, currentOperatorSplitPercent: 75,
  currentStickySplitPercent: 15, currentRenterSplitPercent: 10,
};
const validationError = error => error instanceof TypeError || error instanceof RangeError;

test('a $100 payment after four quarterly cuts quotes only the new payer share', () => {
  const projection = projectNetwork({}, 'earning');
  const quote = incomePaymentPreview(projection, 100);
  const rate = 10 * 0.95 ** 4;
  const minted = 100 * rate;
  const payer = minted * 0.10;
  const expectedCashCents = Math.round(projection.revCash * 100) + 10_000;
  const expectedClaimCents = Math.floor(expectedCashCents * payer / (projection.revSupply + minted));
  const expectedLoanCents = Math.floor(expectedClaimCents * 94 / 100);
  assert.equal(quote.month, 12);
  assert.equal(quote.amount, 100);
  close(quote.cashBefore, Math.round(projection.revCash * 100) / 100);
  close(quote.cashAfter, expectedCashCents / 100);
  close(quote.supplyBefore, projection.revSupply);
  close(quote.supplyAfter, projection.revSupply + minted);
  close(quote.totalMinted, minted);
  close(quote.payerTokens, payer);
  close(quote.operatorTokens, minted * 0.75);
  close(quote.stakerTokens, minted * 0.15);
  close(quote.payerTokens + quote.operatorTokens + quote.stakerTokens, quote.totalMinted);
  close(quote.payerSharePercent, 100 * quote.payerTokens / quote.supplyAfter);
  close(quote.cashoutValue, expectedClaimCents / 100);
  close(quote.loanPrincipal, expectedClaimCents / 100);
  close(quote.loanCash, expectedLoanCents / 100);
  close(quote.loanFees, (expectedClaimCents - expectedLoanCents) / 100);
  close(quote.issuanceRate, rate);
  assert.equal(quote.payerPercent, 10);
  assert.equal(quote.operatorPercent, 75);
  assert.equal(quote.stakerPercent, 15);
});

test('an empty pool and an unbacked premint produce different claims from the same payment', () => {
  const empty = incomePaymentPreview(emptyPool, 100);
  close(empty.cashAfter, 100);
  close(empty.supplyAfter, 1_000);
  close(empty.payerSharePercent, 10);
  close(empty.cashoutValue, 10);
  close(empty.loanCash, 9.4);
  const preminted = incomePaymentPreview({ ...emptyPool, revSupply: 500_000 }, 100);
  close(preminted.payerTokens, empty.payerTokens);
  close(preminted.cashAfter, empty.cashAfter);
  close(preminted.supplyAfter, 501_000);
  close(preminted.cashoutValue, 0.01);
  assert.equal(preminted.loanCash, 0);
  assert.equal(preminted.loanAvailable, false);
});

test('past holdings, cash-out prices, operating costs, and future history do not change the new payer quote', () => {
  const projection = projectNetwork({}, 'earning');
  const original = incomePaymentPreview(projection, 100);
  const unrelated = {
    ...projection, personalFundTokens: 9_876_543_210, personalRevTokens: 9_876_543,
    personalStickyTokens: 8_765_432, personalCashout: 7_654_321, personalLoanCash: 6_543_210,
    revPriceNow: 5_432_109, monthlyCosts: 4_321_098, unpaidOps: 3_210_987,
    history: [{ month: 13, revCash: 2_109_876, personalLoanCash: 1_098_765 }],
  };
  assert.deepEqual(incomePaymentPreview(unrelated, 100), original);
  close(original.cashAfter, original.cashBefore + 100, 0.000001);
  close(original.supplyAfter, original.supplyBefore + original.totalMinted);
});

test('cash-out and loan quotes floor cents and leave the deposited cash available in the preview', () => {
  for (const [amount, principal, net] of [[0.01, 0, 0], [0.17, 0.01, 0], [1.79, 0.17, 0.15], [100, 10, 9.4]]) {
    const quote = incomePaymentPreview({ ...emptyPool, revCashoutFeePercent: 2.5 }, amount);
    close(quote.cashoutValue, principal);
    close(quote.loanPrincipal, principal);
    close(quote.loanCash, net);
    close(quote.loanFees + quote.loanCash, quote.loanPrincipal);
    close(quote.cashAfter, amount, 1e-7);
    assert.equal(quote.loanAvailable, net > 0);
    assert.ok(quote.loanPrincipal <= quote.cashAfter);
  }
});

test('zero issuance or zero payer allocation produces finite zero claims without inventing ownership', () => {
  for (const terms of [
    { currentIssuanceRate: 0 },
    { currentOperatorSplitPercent: 85, currentStickySplitPercent: 15, currentRenterSplitPercent: 0 },
  ]) {
    const quote = incomePaymentPreview({ ...emptyPool, ...terms }, 100);
    assert.equal(quote.cashAfter, 100);
    assert.equal(quote.payerTokens, 0);
    assert.equal(quote.payerSharePercent, 0);
    assert.equal(quote.cashoutValue, 0);
    assert.equal(quote.loanPrincipal, 0);
    assert.equal(quote.loanCash, 0);
    assert.equal(quote.loanFees, 0);
    assert.equal(quote.loanAvailable, false);
    for (const row of quote.allocations) assert.ok(Number.isFinite(row.percent));
  }
});

test('the cash ledger adds whole-cent payments and rejects sub-cent treasury balances', () => {
  const quote = incomePaymentPreview({ ...emptyPool, revCash: 123.46, revSupply: 1_000 }, '0.17');
  close(quote.cashBefore, 123.46);
  close(quote.cashAfter, 123.63);
  close(quote.totalMinted, 1.7);
  close(quote.supplyAfter, 1_001.7);
  assert.throws(() => incomePaymentPreview({ ...emptyPool, revCash: 123.456 }, '0.17'), validationError);
});

test('amount parsing accepts correctly grouped comma strings and the supported payment bounds', () => {
  for (const [raw, expected] of [['1,234.56', 1_234.56], ['0.01', 0.01], [123.45, 123.45], ['1,000,000,000', 1e9]]) {
    const quote = incomePaymentPreview(emptyPool, raw);
    close(quote.amount, expected);
    close(quote.totalMinted, expected * 10);
  }
});

test('invalid payment amounts and non-earning phases fail explicitly', () => {
  for (const amount of [
    '', '   ', 'NaN', '1,00', '1,,000', '1,000,', '-1', '0', '1.001',
    '1,000,000,000.01', NaN, Infinity, -1, 0, 1.001, 1_000_000_000.01,
  ]) assert.throws(() => incomePaymentPreview(emptyPool, amount), validationError);
  for (const phase of ['raising', 'funded', 'refunding', 'refunded', 'liquidated', 'unknown', undefined]) {
    assert.throws(() => incomePaymentPreview({ ...emptyPool, phase }, 100), validationError);
  }
  for (const projection of [undefined, null, {}, []]) {
    assert.throws(() => incomePaymentPreview(projection, 100), validationError);
  }
});

test('required pool fields and allocation bounds reject non-finite or inconsistent projections', () => {
  for (const terms of [
    { revCash: undefined }, { revCash: NaN }, { revCash: -1 },
    { revSupply: undefined }, { revSupply: Infinity }, { revSupply: -1 },
    { currentIssuanceRate: undefined }, { currentIssuanceRate: '10' }, { currentIssuanceRate: -1 },
    { currentOperatorSplitPercent: undefined }, { currentStickySplitPercent: NaN },
    { currentRenterSplitPercent: -1 }, { currentRenterSplitPercent: 101 },
    { currentOperatorSplitPercent: 74 }, { currentOperatorSplitPercent: 76 },
  ]) assert.throws(() => incomePaymentPreview({ ...emptyPool, ...terms }, 100), validationError);
});

test('allocation rows use the complete post-payment supply as their percentage denominator', () => {
  const quote = incomePaymentPreview({ ...emptyPool, revSupply: 5_000 }, 100);
  assert.ok(quote.allocations.length >= 3);
  const keys = new Set();
  for (const row of quote.allocations) {
    assert.match(row.key, /^[A-Za-z][\w-]*$/);
    assert.ok(!keys.has(row.key));
    keys.add(row.key);
    assert.ok(row.label.length > 0);
    assert.ok(row.tokens >= 0);
    close(row.percent, row.tokens / quote.supplyAfter * 100);
  }
});

test('large finite token quantities do not overflow when calculating ownership percentages', () => {
  const largeSupply = incomePaymentPreview({ ...emptyPool, revSupply: 1e308 }, 100);
  const largeMint = incomePaymentPreview({ ...emptyPool, currentIssuanceRate: 1e306 }, 100);
  for (const quote of [largeSupply, largeMint]) {
    for (const field of ['totalMinted', 'supplyAfter', 'payerTokens', 'operatorTokens', 'stakerTokens', 'payerSharePercent']) {
      assert.ok(Number.isFinite(quote[field]), field);
    }
    for (const row of quote.allocations) {
      assert.ok(Number.isFinite(row.percent));
      assert.ok(row.percent >= 0 && row.percent <= 100);
    }
  }
  assert.equal(largeSupply.cashoutValue, 0);
  close(largeMint.payerSharePercent, 10);
  close(largeMint.operatorTokens / largeMint.totalMinted, 0.75);
  close(largeMint.stakerTokens / largeMint.totalMinted, 0.15);
  close(largeMint.cashoutValue, 10);
  close(largeMint.loanCash, 9.4);
});

test('the helper and renderer leave inputs and history unchanged across repeated previews', () => {
  const projection = Object.freeze(projectNetwork({}, 'earning'));
  const snapshot = structuredClone(projection);
  const quote = incomePaymentPreview(projection, '123.45');
  assert.deepEqual(incomePaymentPreview(projection, '123.45'), quote);
  const html = renderIncomePaymentDetails(projection, '123.45');
  assert.equal(renderIncomePaymentDetails(projection, '123.45'), html);
  assert.deepEqual(projection, snapshot);
});

test('the renderer supplies an accessible inline chart and rejects unsafe dynamic text', () => {
  const projection = projectNetwork({}, 'earning');
  const html = renderIncomePaymentDetails(projection, 100);
  assert.match(html, /<details\b/i);
  assert.match(html, /<summary\b/i);
  assert.match(html, /<svg\b/i);
  assert.match(html, /role=["']img["']/i);
  assert.match(html, /aria-label=["'][^"']+["']|<title\b[^>]*>[^<]+<\/title>/i);
  const visible = html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
  assert.match(visible, /after this payment/i);
  assert.match(visible, /month\s*12/i);
  assert.match(visible, /cash|USDC/i);
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i);
  const firstIds = [...html.matchAll(/\sid=["']([^"']+)["']/g)].map(match => match[1]);
  const second = renderIncomePaymentDetails(projection, 50);
  const secondIds = [...second.matchAll(/\sid=["']([^"']+)["']/g)].map(match => match[1]);
  assert.equal(new Set(firstIds).size, firstIds.length);
  assert.equal(firstIds.filter(id => secondIds.includes(id)).length, 0, 'separate previews cannot collide on IDs');
  assert.throws(() => renderIncomePaymentDetails(projection, '100<img src=x onerror=alert(1)>'), validationError);
  assert.throws(() => renderIncomePaymentDetails({ ...projection, monthsApplied: '12<script>alert(1)</script>' }, 100), validationError);
});
