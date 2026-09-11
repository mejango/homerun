import { describe, expect, it } from 'vitest'
import { demoPaymentResult, fundPaymentLimitError } from '@/lib/demo-payment-result'
import { DEFAULT_NETWORK, projectNetwork } from '../web/network-model.mjs'

describe('one additional demo payment', () => {
  it('adds a FUND payment exactly once to the unchanged project baseline', () => {
    const baseline = projectNetwork({ ...DEFAULT_NETWORK, investment: 0 }, 'raising')
    const before = structuredClone(baseline)
    const result = demoPaymentResult(baseline, 10_000, 100_000_000)
    expect(result.tokens).toBe(100_000_000)
    expect(result.balanceAfter).toBe(379_230.77)
    expect(result.supplyAfter).toBe(3_792_307_700)
    expect(result.sharePercent).toBeCloseTo(100_000_000 / 3_792_307_700 * 100, 12)
    expect(result.allocations.reduce((sum, part) => sum + part.percent, 0)).toBeCloseTo(100, 12)
    expect(baseline).toEqual(before)
    // A second draft quotes independently; it does not accumulate the first one.
    expect(demoPaymentResult(baseline, 1, 10_000).balanceAfter).toBe(369_231.77)
  })

  it('shows 100% for the first contribution to a newly created raise', () => {
    const baseline = projectNetwork({ ...DEFAULT_NETWORK, investment: 0, raisedPercent: 0 }, 'raising')
    const result = demoPaymentResult(baseline, 2_500, 25_000_000)
    expect(result.balanceAfter).toBe(2_500)
    expect(result.supplyAfter).toBe(25_000_000)
    expect(result.sharePercent).toBe(100)
    expect(result.allocations.map(part => part.percent)).toEqual([100, 0])
  })

  it('accepts a new contribution above past contributions and up to the remaining goal', () => {
    const baseline = projectNetwork({ ...DEFAULT_NETWORK, investment: 0, raisedPercent: 1 }, 'raising')
    expect(10_000).toBeGreaterThan(baseline.raised)
    expect(fundPaymentLimitError(baseline, 10_000)).toBe('')
    expect(demoPaymentResult(baseline, 10_000, 100_000_000).tokens).toBe(100_000_000)
    const remaining = (Math.round(baseline.raiseGoal * 100) - Math.round(baseline.raised * 100)) / 100
    expect(fundPaymentLimitError(baseline, remaining)).toBe('')
    expect(demoPaymentResult(baseline, remaining, remaining * 10_000).balanceAfter).toBe(baseline.raiseGoal)
    expect(fundPaymentLimitError(baseline, remaining + 0.01)).toContain('left to raise')
    expect(() => demoPaymentResult(baseline, (Math.round(remaining * 100) + 1) / 100, 100)).toThrow('left to raise')
  })

  it('credits only the customer allocation in an INCOME payment', () => {
    const baseline = projectNetwork({ ...DEFAULT_NETWORK, investment: 0, revenueMonths: 12 }, 'earning')
    const result = demoPaymentResult(baseline, 100, 999_999_999)
    const minted = 100 * baseline.currentIssuanceRate
    const customerTokens = minted * baseline.currentRenterSplitPercent / 100
    expect(result.tokens).toBe(customerTokens)
    expect(result.supplyAfter).toBe(baseline.revSupply + minted)
    expect(result.balanceAfter).toBe((Math.round(baseline.revCash * 100) + 10_000) / 100)
    expect(result.sharePercent).toBeCloseTo(customerTokens / (baseline.revSupply + minted) * 100, 12)
    expect(result.allocations.find(part => part.key === 'operators')!.tokens).toBe(minted * baseline.currentOperatorSplitPercent / 100)
    expect(result.allocations.find(part => part.key === 'stakers')!.tokens).toBe(minted * baseline.currentStickySplitPercent / 100)
    expect(result.allocations.reduce((sum, part) => sum + part.percent, 0)).toBeCloseTo(100, 12)
  })

  it('handles no customer allocation without painting any payer ownership', () => {
    const baseline = projectNetwork({ ...DEFAULT_NETWORK, investment: 0, operatorSplitPercent: 20, ongoingOperatorSplitPercent: 20, stickySplitPercent: 80 }, 'earning')
    const result = demoPaymentResult(baseline, 100, 0)
    expect(result.tokens).toBe(0)
    expect(result.sharePercent).toBe(0)
    expect(result.cashoutValue).toBe(0)
    expect(result.allocations.find(part => part.key === 'payer')!.percent).toBe(0)
  })

  it('handles zero issuance and zero supply without NaN segments', () => {
    const baseline = projectNetwork({ ...DEFAULT_NETWORK, investment: 0 }, 'earning')
    const result = demoPaymentResult({ ...baseline, revSupply: 0, currentIssuanceRate: 0 }, 100, 0)
    expect(result.supplyAfter).toBe(0)
    expect(result.sharePercent).toBe(0)
    expect(result.allocations.every(part => part.percent === 0)).toBe(true)
  })

  it('preserves a tiny, nonzero ownership share and cent precision', () => {
    const baseline = projectNetwork({ ...DEFAULT_NETWORK, investment: 0 }, 'raising')
    const result = demoPaymentResult(baseline, 0.01, 100)
    expect(result.balanceAfter).toBe(369_230.78)
    expect(result.sharePercent).toBeGreaterThan(0)
    expect(result.sharePercent).toBeLessThan(0.01)
  })

  it.each([0, -1, 0.001, NaN, Infinity])('rejects invalid amount %s instead of publishing a graph', amount => {
    const baseline = projectNetwork({ ...DEFAULT_NETWORK, investment: 0 }, 'raising')
    expect(() => demoPaymentResult(baseline, amount, 10_000)).toThrow()
  })

  it.each(['funded', 'refunding', 'refunded', 'liquidated'])('does not quote payments for %s', phase => {
    const baseline = projectNetwork({ ...DEFAULT_NETWORK, investment: 0 }, phase)
    expect(() => demoPaymentResult(baseline, 100, 1_000_000)).toThrow('not accepting payments')
  })

  it('rejects invalid baseline supplies and combined currency overflow', () => {
    const baseline = projectNetwork({ ...DEFAULT_NETWORK, investment: 0 }, 'raising')
    expect(() => demoPaymentResult({ ...baseline, fundSupply: NaN }, 100, 1_000_000)).toThrow()
    expect(() => demoPaymentResult(baseline, 100, -1)).toThrow()
    expect(() => demoPaymentResult({ ...baseline, raised: Number.MAX_SAFE_INTEGER / 100 }, 100, 1_000_000)).toThrow()
  })
})
