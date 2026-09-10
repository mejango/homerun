import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePaymentAmount, sourceAmountFromUSDC, formatPaymentAmount } from '../web/payment-currencies.mjs';

test('ETH conversion uses the stated preview rate with exact cent rounding', () => {
  assert.deepEqual(parsePaymentAmount('0.1', 'ETH'), { sourceAmount: .1, sourceCurrency: 'ETH', amount: 250, settlementCurrency: 'USDC', previewRate: 2500 });
  assert.equal(parsePaymentAmount('.01234567', 'ETH').amount, 30.86);
  assert.equal(parsePaymentAmount('0.000004', 'ETH').amount, .01);
  assert.equal(parsePaymentAmount('0.00000799', 'ETH').amount, .01);
  assert.equal(parsePaymentAmount('400,000', 'ETH').amount, 1_000_000_000);
  assert.ok(parsePaymentAmount('400,000.00000001', 'ETH').error);
  assert.ok(parsePaymentAmount('0.00000399', 'ETH').error);
});

test('currency changes preserve the settled USDC amount', () => {
  for (const amount of [.01, .03, 100, 1234.56, 369230.77, 1_000_000_000]) {
    const ethRaw = sourceAmountFromUSDC(amount, 'ETH');
    const eth = parsePaymentAmount(ethRaw, 'ETH');
    assert.equal(eth.amount, amount, ethRaw);
    assert.equal(parsePaymentAmount(sourceAmountFromUSDC(eth.amount, 'USDC')).amount, amount);
  }
});

test('source formatting retains eight ETH decimals and grouped whole units', () => {
  assert.equal(formatPaymentAmount(.01234567, 'ETH'), '0.01234567');
  assert.equal(formatPaymentAmount(1000.00000001, 'ETH'), '1,000.00000001');
  assert.equal(formatPaymentAmount(1234.56), '1,234.56');
});

test('unsupported assets and malformed ETH amounts fail without converting', () => {
  for (const currency of ['BTC', 'eth', 'toString', '__proto__', null]) assert.ok(parsePaymentAmount('1', currency).error);
  for (const raw of ['0.123456789', '1e-4', '1,00', '1,,000', '1,000,', '', '-1', 0, Infinity, NaN]) assert.ok(parsePaymentAmount(raw, 'ETH').error, String(raw));
  assert.throws(() => formatPaymentAmount(1, 'BTC'), /Choose USDC or ETH/);
  assert.throws(() => sourceAmountFromUSDC(1, '__proto__'), /Choose USDC or ETH/);
});
