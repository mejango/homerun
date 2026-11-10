import { describe, expect, it } from 'vitest'
import { reviewedRunStatus } from '@bananapus/nana-sdk-core/review'
import { txPhaseOf } from '@/hooks/useReviewedAction'

describe("the phase a flow shows for the SDK's run status", () => {
  it.each([
    ['idle', 'idle'], ['cancelled', 'idle'], ['settled', 'idle'],
    ['review', 'review'], ['simulating', 'simulating'], ['signing', 'signing'],
    ['receipt', 'pending'], ['proposed', 'held'], ['held', 'held'],
    ['done', 'success'], ['failed', 'error'],
  ] as const)('%s reads %s', (status, phase) => expect(txPhaseOf(status)).toBe(phase))

  it('reads a Safe execution whose receipt is confirming as pending, not held', () => {
    const { status } = reviewedRunStatus({ phase: 'idle', error: null, settled: null, held: { phase: 'confirming' } })
    expect(txPhaseOf(status)).toBe('pending')
  })
})
