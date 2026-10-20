import { describe, expect, it } from 'vitest'
import { payFailureMessage, payRetrySlippageBps } from '@/lib/pay-minimum'

const message = 'm'

describe('payRetrySlippageBps', () => {
  it('adds the shortfall to the tolerance, rounded up to a half percent', () => {
    expect(payRetrySlippageBps({ reason: 'TERMINAL_UNDER_MIN', received: 935n, minimum: 1_000n, message }, 100)).toBe(750)
    expect(payRetrySlippageBps({ reason: 'BUYBACK_SLIPPAGE_EXCEEDED', received: 999n, minimum: 1_000n, message }, 100)).toBe(150)
  })

  it('adds one percent when the amounts are unknown', () => {
    expect(payRetrySlippageBps({ reason: 'TERMINAL_UNDER_MIN', message }, 100)).toBe(200)
  })

  it('stays below half the quote, and offers nothing more at that limit', () => {
    expect(payRetrySlippageBps({ reason: 'TERMINAL_UNDER_MIN', received: 1n, minimum: 1_000n, message }, 100)).toBe(4950)
    expect(payRetrySlippageBps({ reason: 'TERMINAL_UNDER_MIN', received: 1n, minimum: 1_000n, message }, 4950)).toBeNull()
  })

  it('offers nothing a lower minimum cannot fix', () => {
    for (const reason of ['BUYBACK_DERIVED_FLOOR_NOT_MET', 'ROUTER_SLIPPAGE_EXCEEDED', 'PAYMENTS_PAUSED'] as const) {
      expect(payRetrySlippageBps({ reason, received: 1n, minimum: 2n, message }, 100)).toBeNull()
    }
    expect(payRetrySlippageBps(null, 100)).toBeNull()
  })
})

describe('a payment that would get no tokens', () => {
  const none = { reason: 'TERMINAL_UNDER_MIN' as const, received: 0n, minimum: 1_000n, message }

  it('offers no looser minimum and says so', () => {
    expect(payRetrySlippageBps(none, 100)).toBeNull()
    expect(payFailureMessage(none)).toBe('This payment would return no tokens.')
  })

  it('reads amounts only when both are bigints', () => {
    const odd = { reason: 'TERMINAL_UNDER_MIN' as const, received: 0 as unknown as bigint, minimum: 1_000n, message }
    expect(payRetrySlippageBps(odd, 100)).toBe(200)
    expect(payFailureMessage(odd)).toBe(message)
  })
})
