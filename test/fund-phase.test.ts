import assert from 'node:assert/strict'
import { test } from 'vitest'
import { liveFundPhase, type LiveFundPhaseInput } from '../src/lib/fund-phase'

const base: LiveFundPhaseInput = { pausePay: false, cashOutTaxRate: 1_000, allowOwnerMinting: false, hasIncome: false, supported: true }
const phase = (overrides: Partial<LiveFundPhaseInput>) => liveFundPhase({ ...base, ...overrides })

test('unsupported configurations have no phase', () => {
  assert.deepEqual(phase({ supported: false }), { phase: null, status: 'Unsupported FUND configuration' })
  assert.deepEqual(phase({ supported: false, cashOutTaxRate: 0, hasIncome: true }), { phase: null, status: 'Unsupported FUND configuration' })
})

test('the raising template reads as raising, open or paused', () => {
  assert.deepEqual(phase({}), { phase: 'raising', status: 'Raising funds' })
  assert.deepEqual(phase({ pausePay: true }), { phase: 'raising', status: 'Contributions paused' })
  assert.deepEqual(phase({ hasIncome: true }), { phase: 'raising', status: 'Raising funds' })
})

test('the raising tax with owner minting is custom', () => {
  assert.deepEqual(phase({ allowOwnerMinting: true }), { phase: null, status: 'Custom rules' })
})

test('closed contributions and cash-outs without income read as funded', () => {
  assert.deepEqual(phase({ pausePay: true, cashOutTaxRate: 10_000 }), { phase: 'funded', status: 'Funded' })
  assert.deepEqual(phase({ pausePay: true, cashOutTaxRate: 10_000, allowOwnerMinting: true }), { phase: 'funded', status: 'Funded' })
})

test('closed cash-outs with open contributions and no income are custom', () => {
  assert.deepEqual(phase({ cashOutTaxRate: 10_000 }), { phase: null, status: 'Custom rules' })
})

test('closed cash-outs with income read as earning', () => {
  assert.deepEqual(phase({ cashOutTaxRate: 10_000, hasIncome: true }), { phase: 'earning', status: 'Earning' })
  assert.deepEqual(phase({ cashOutTaxRate: 10_000, hasIncome: true, pausePay: true }), { phase: 'earning', status: 'Earning' })
})

test('zero-tax cash-outs never claim a sale happened', () => {
  assert.deepEqual(phase({ cashOutTaxRate: 0, hasIncome: true, pausePay: true }), { phase: 'liquidated', status: 'Cash-outs open' })
  assert.deepEqual(phase({ cashOutTaxRate: 0, pausePay: true }), { phase: 'refunding', status: 'Cash-outs open' })
  assert.deepEqual(phase({ cashOutTaxRate: 0, allowOwnerMinting: true }), { phase: 'refunding', status: 'Cash-outs open' })
})

test('any other cash-out tax is custom', () => {
  for (const cashOutTaxRate of [1, 999, 1_001, 5_000, 9_999]) {
    assert.deepEqual(phase({ cashOutTaxRate, pausePay: true, hasIncome: true }), { phase: null, status: 'Custom rules' })
  }
})
