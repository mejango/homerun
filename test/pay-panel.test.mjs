import test from 'node:test';
import assert from 'node:assert/strict';
import { projectNetwork } from '../web/network-model.mjs';
import { payPanelQuote } from '../web/pay-panel.mjs';

const close = (actual, expected) => {
  assert.ok(Number.isFinite(actual), `expected a finite number, received ${actual}`);
  assert.ok(Math.abs(actual - expected) <= 1e-8, `${actual} differs from ${expected}`);
};

test('raising quotes FUND for valid whole-cent amounts with correctly grouped commas', () => {
  const projection = projectNetwork({}, 'raising');
  for (const [amount, dollars] of [['1,234.56', 1_234.56], ['0.01', 0.01], [123.45, 123.45], ['1,000,000,000', 1e9]]) {
    const quote = payPanelQuote({ phase: 'raising', projection, amount });
    assert.equal(quote.kind, 'payment');
    assert.equal(quote.route, 'FUND');
    assert.equal(quote.enabled, true);
    close(quote.amount, dollars);
    close(quote.tokenOutput, dollars * 10_000);
    assert.equal(quote.cashOutput, null);
    assert.equal(quote.error, '');
    assert.ok(quote.actionLabel.length > 0);
  }
});

test('a contribution error suppresses a FUND mint quote even when the entered amount is valid', () => {
  const contributionError = 'Your investment exceeds the amount raised.';
  const quote = payPanelQuote({
    phase: 'raising', projection: projectNetwork({}, 'raising'), amount: '100', contributionError,
  });
  assert.equal(quote.enabled, false);
  assert.equal(quote.tokenOutput, null);
  assert.equal(quote.cashOutput, null);
  assert.ok(`${quote.error} ${quote.reason}`.includes(contributionError));
});

test('earning quotes the entered payment at issuance terms and ignores historical contribution errors', () => {
  const projection = { ...projectNetwork({ revenueMonths: 13 }, 'earning'), revPriceNow: 999_999 };
  const quote = payPanelQuote({
    phase: 'earning', projection, amount: '250.00', contributionError: 'The earlier FUND contribution was invalid.',
  });
  assert.equal(quote.kind, 'payment');
  assert.equal(quote.route, 'INCOME');
  assert.equal(quote.enabled, true);
  assert.equal(quote.error, '');
  close(quote.amount, 250);
  close(quote.tokenOutput, 203.6265625); // Four quarterly cuts: 250 dollars × (10 × .95^4) × 10%.
  assert.equal(quote.cashOutput, null);
  const differentBacking = payPanelQuote({ phase: 'earning', projection: { ...projection, revPriceNow: 0 }, amount: '250' });
  close(differentBacking.tokenOutput, quote.tokenOutput);
});

test('earning accepts zero current rent and explicitly permits payments with zero token allocation', () => {
  const projection = projectNetwork({ monthlyRent: 0, revenueMonths: 0 }, 'earning');
  const normal = payPanelQuote({ phase: 'earning', projection, amount: '100' });
  assert.equal(normal.enabled, true);
  close(normal.tokenOutput, 100);
  for (const terms of [{ currentIssuanceRate: 0 }, { currentRenterSplitPercent: 0 }]) {
    const quote = payPanelQuote({ phase: 'earning', projection: { ...projection, ...terms }, amount: '100' });
    assert.equal(quote.kind, 'payment');
    assert.equal(quote.route, 'INCOME');
    assert.equal(quote.enabled, true);
    assert.equal(quote.tokenOutput, 0);
    assert.equal(quote.error, '');
    assert.ok(quote.reason.trim().length > 0, 'zero-token payments need an explicit explanation');
  }
});

test('missing or invalid issuance terms cannot produce an INCOME mint quote', () => {
  const projection = projectNetwork({}, 'earning');
  for (const terms of [
    { currentIssuanceRate: undefined }, { currentIssuanceRate: null }, { currentIssuanceRate: NaN },
    { currentIssuanceRate: Infinity }, { currentIssuanceRate: -1 }, { currentIssuanceRate: '10' },
    { currentRenterSplitPercent: undefined }, { currentRenterSplitPercent: NaN },
    { currentRenterSplitPercent: -1 }, { currentRenterSplitPercent: 101 },
  ]) {
    const quote = payPanelQuote({ phase: 'earning', projection: { ...projection, ...terms }, amount: '100' });
    assert.equal(quote.enabled, false);
    assert.equal(quote.tokenOutput, null);
    assert.equal(quote.cashOutput, null);
    assert.ok(`${quote.error}${quote.reason}`.trim().length > 0);
  }
});

test('invalid amounts clear the mint output for both FUND and INCOME payments', () => {
  const invalidAmounts = [
    '', '   ', 'not a number', 'NaN', '1,00', '1,,000', '1,000,',
    '-1', '0', '1.001', '1,000,000,000.01', NaN, Infinity, -1, 0, 1.001, 1_000_000_000.01,
  ];
  for (const phase of ['raising', 'earning']) {
    const projection = projectNetwork({}, phase);
    for (const amount of invalidAmounts) {
      const quote = payPanelQuote({ phase, projection, amount });
      assert.equal(quote.enabled, false, `${phase}: ${String(amount)}`);
      assert.equal(quote.tokenOutput, null, `${phase}: ${String(amount)}`);
      assert.equal(quote.cashOutput, null);
    }
  }
});

test('refunds use the whole actual claim without the raising tax and ignore the payment amount', () => {
  const projection = projectNetwork({ precloseSpent: 12_345.67 }, 'refunding');
  const quote = payPanelQuote({ phase: 'refunding', projection, amount: 'not money' });
  assert.equal(quote.kind, 'refund');
  assert.equal(quote.route, 'FUND');
  assert.equal(quote.enabled, true);
  assert.equal(quote.amount, null);
  assert.equal(quote.tokenOutput, null);
  close(quote.cashOutput, projection.personalRefund);
  assert.ok(quote.cashOutput > projection.personalRefund * 0.9);
  const primary = payPanelQuote({ phase: 'refunding', projection: { ...projection, personalFundRefund: 123.45 }, amount: 1 });
  close(primary.cashOutput, 123.45);
  const zeroPrimary = payPanelQuote({ phase: 'refunding', projection: { ...projection, personalFundRefund: 0 }, amount: 1 });
  assert.equal(zeroPrimary.enabled, false);
  assert.ok(!(zeroPrimary.cashOutput > 0), 'a zero primary claim must not fall back to a positive historical field');
});

test('liquidation quotes the FUND sale claim and never mints INCOME from an entered payment', () => {
  const projection = projectNetwork({}, 'liquidated');
  assert.ok(projection.currentIssuanceRate > 0);
  const quote = payPanelQuote({ phase: 'liquidated', projection, amount: '999.99' });
  assert.equal(quote.kind, 'sale');
  assert.equal(quote.route, 'FUND');
  assert.equal(quote.enabled, true);
  assert.equal(quote.amount, null);
  assert.equal(quote.tokenOutput, null);
  close(quote.cashOutput, projection.personalFundSaleClaim);
});

test('funded and refunded phases disable the panel instead of quoting a mint or claim', () => {
  for (const phase of ['funded', 'refunded']) {
    const projection = { ...projectNetwork({}, phase), personalRefund: 100, personalFundSaleClaim: 100 };
    const quote = payPanelQuote({ phase, projection, amount: '100' });
    assert.equal(quote.kind, 'disabled');
    assert.equal(quote.enabled, false);
    assert.equal(quote.tokenOutput, null);
    assert.equal(quote.cashOutput, null);
    assert.ok(quote.reason.trim().length > 0);
  }
});

test('invalid claims and contribution errors cannot enable refund or sale actions', () => {
  for (const [phase, field] of [['refunding', 'personalRefund'], ['liquidated', 'personalFundSaleClaim']]) {
    for (const claim of [undefined, NaN, Infinity, -1, 0]) {
      const quote = payPanelQuote({ phase, projection: { [field]: claim }, amount: '100' });
      assert.equal(quote.enabled, false);
      assert.equal(quote.tokenOutput, null);
      assert.ok(!(quote.cashOutput > 0));
    }
    const blocked = payPanelQuote({
      phase, projection: { [field]: 100 }, amount: '100', contributionError: 'The FUND position is invalid.',
    });
    assert.equal(blocked.enabled, false);
    assert.equal(blocked.tokenOutput, null);
    assert.equal(blocked.cashOutput, null);
  }
});

test('unknown phases and absent or mismatched projections return a disabled panel', () => {
  const projection = projectNetwork({}, 'earning');
  for (const input of [
    undefined, { phase: 'unknown', projection, amount: 100 },
    { phase: 'raising', projection, amount: 100 },
    { phase: 'raising', amount: 100 }, { phase: 'earning', projection: null, amount: 100 },
  ]) {
    const quote = payPanelQuote(input);
    assert.equal(quote.kind, 'disabled');
    assert.equal(quote.enabled, false);
    assert.equal(quote.tokenOutput, null);
    assert.equal(quote.cashOutput, null);
    assert.ok(`${quote.error}${quote.reason}`.trim().length > 0);
  }
});

test('quoting does not mutate its inputs or projection and is repeatable', () => {
  const projection = Object.freeze(projectNetwork({}, 'earning'));
  const input = Object.freeze({ phase: 'earning', projection, amount: '123.45', contributionError: '' });
  const original = structuredClone(input);
  const first = payPanelQuote(input);
  assert.deepEqual(payPanelQuote(input), first);
  assert.deepEqual(input, original);
});

test('ETH previews settle to USDC before quoting FUND and INCOME', () => {
  for (const phase of ['raising', 'earning']) {
    const projection = projectNetwork({ revenueMonths: 13 }, phase);
    const eth = payPanelQuote({ phase, projection, currency: 'ETH', amount: '.1' });
    const usdc = payPanelQuote({ phase, projection, amount: '250' });
    assert.equal(eth.enabled, true);
    assert.equal(eth.sourceCurrency, 'ETH');
    assert.equal(eth.sourceAmount, .1);
    assert.equal(eth.previewRate, 2500);
    assert.equal(eth.amount, 250);
    assert.equal(eth.settlementCurrency, 'USDC');
    close(eth.tokenOutput, usdc.tokenOutput);
  }
});

test('ETH precision and settlement errors never emit a token quote', () => {
  const projection = projectNetwork({}, 'raising');
  for (const amount of ['0.00000001', '.00000399', '.000004001', '400000.00000001', '1,00', '-0.1', 'Infinity', '']) {
    const quote = payPanelQuote({ phase: 'raising', projection, currency: 'ETH', amount });
    assert.equal(quote.enabled, false, amount);
    assert.equal(quote.tokenOutput, null, amount);
    assert.ok(quote.error);
  }
  const malformed = payPanelQuote({ phase: 'raising', projection, currency: 'ETH', amount: '.000000001', contributionError: 'Contribution is invalid.' });
  assert.match(malformed.error, /8 decimal places/);
});

test('converted ETH respects contribution bounds from the project model', () => {
  const quote = payPanelQuote({ phase: 'raising', projection: projectNetwork({}, 'raising'), currency: 'ETH', amount: '10', contributionError: 'The USDC settlement exceeds the remaining raise.' });
  assert.equal(quote.enabled, false);
  assert.equal(quote.amount, null);
  assert.match(quote.error, /remaining raise/);
});

test('refunds and asset-sale claims stay in USDC after ETH was selected', () => {
  for (const phase of ['refunding', 'liquidated']) {
    const projection = projectNetwork({}, phase);
    const quote = payPanelQuote({ phase, projection, currency: 'ETH', amount: '.1' });
    const usual = payPanelQuote({ phase, projection, amount: '250' });
    assert.equal(quote.settlementCurrency, 'USDC');
    assert.equal(quote.sourceCurrency, null);
    assert.equal(quote.sourceAmount, null);
    assert.equal(quote.tokenOutput, null);
    close(quote.cashOutput, usual.cashOutput);
  }
});
