import { describe, expect, it } from 'vitest'
import type { Address, Hex } from 'viem'
import { safeExecutionResult } from '../src/lib/safe-execution'
import { safeExecutionLog } from './support/safe-logs'

const SAFE = '0x1111111111111111111111111111111111111111' as Address
const OTHER_SAFE = '0x2222222222222222222222222222222222222222' as Address
const PROPOSAL = `0x${'ab'.repeat(32)}` as Hex
const OTHER_PROPOSAL = `0x${'ef'.repeat(32)}` as Hex
const EXECUTION = `0x${'cd'.repeat(32)}` as Hex
const receipt = (logs: unknown[], status = 'success') => ({ status, transactionHash: EXECUTION, logs })

describe('Safe execution results', () => {
  it('proves success and failure in the Safe 1.4.1 and the Safe 1.3 layout', () => {
    for (const version of ['1.4.1', '1.3'] as const) {
      expect(safeExecutionResult(receipt([safeExecutionLog(SAFE, PROPOSAL, { version })]), SAFE, PROPOSAL)).toEqual({ status: 'success' })
      expect(safeExecutionResult(receipt([safeExecutionLog(SAFE, PROPOSAL, { version, failed: true })]), SAFE, PROPOSAL)).toEqual({ status: 'failed' })
    }
  })

  it('counts only this Safe’s event for this proposal', () => {
    const logs = [
      safeExecutionLog(OTHER_SAFE, PROPOSAL, { failed: true }),
      safeExecutionLog(SAFE, OTHER_PROPOSAL, { failed: true }),
      safeExecutionLog(SAFE, PROPOSAL),
    ]
    expect(safeExecutionResult(receipt(logs), SAFE, PROPOSAL)).toEqual({ status: 'success' })
    expect(safeExecutionResult(receipt([safeExecutionLog(OTHER_SAFE, PROPOSAL)]), SAFE, PROPOSAL)).toMatchObject({ status: 'unproven' })
  })

  it('keeps a refund from voiding the proof, in either layout', () => {
    const refund = `0x${'00'.repeat(31)}05` as Hex
    const [success] = safeExecutionLog(SAFE, PROPOSAL).topics
    const [failure] = safeExecutionLog(SAFE, PROPOSAL, { failed: true }).topics
    expect(safeExecutionResult(receipt([{ address: SAFE, topics: [success, PROPOSAL], data: refund }]), SAFE, PROPOSAL)).toEqual({ status: 'success' })
    expect(safeExecutionResult(receipt([{ address: SAFE, topics: [failure], data: `${PROPOSAL}${refund.slice(2)}` }]), SAFE, PROPOSAL)).toEqual({ status: 'failed' })
  })

  it('lets no other proposal’s event decide, malformed or not', () => {
    const [success] = safeExecutionLog(SAFE, PROPOSAL).topics
    const others = [
      { address: SAFE, topics: [success, OTHER_PROPOSAL], data: '0x' },
      { address: SAFE, topics: [success], data: `${OTHER_PROPOSAL}00` },
      safeExecutionLog(SAFE, OTHER_PROPOSAL, { failed: true }),
    ]
    expect(safeExecutionResult(receipt([...others, safeExecutionLog(SAFE, PROPOSAL)]), SAFE, PROPOSAL)).toEqual({ status: 'success' })
  })

  it('proves nothing from two results for this proposal, or a malformed event that may be its own', () => {
    const both = [safeExecutionLog(SAFE, PROPOSAL), safeExecutionLog(SAFE, PROPOSAL, { failed: true })]
    expect(safeExecutionResult(receipt(both), SAFE, PROPOSAL)).toMatchObject({ status: 'unproven' })
    const [topic] = safeExecutionLog(SAFE, PROPOSAL).topics
    // Its own hash, with a payment that is not one word.
    expect(safeExecutionResult(receipt([{ address: SAFE, topics: [topic, PROPOSAL], data: '0x' }]), SAFE, PROPOSAL)).toMatchObject({ status: 'unproven', reason: expect.stringContaining('malformed') })
    // No readable hash at all.
    expect(safeExecutionResult(receipt([{ address: SAFE, topics: [topic, '0x1234'], data: `0x${'00'.repeat(32)}` }, safeExecutionLog(SAFE, PROPOSAL)]), SAFE, PROPOSAL)).toMatchObject({ status: 'unproven' })
  })

  it('reads an execution Safe{Wallet} ran at once by the transaction’s own hash', () => {
    expect(safeExecutionResult(receipt([safeExecutionLog(SAFE, OTHER_PROPOSAL, { failed: true })]), SAFE, EXECUTION)).toEqual({ status: 'failed' })
    expect(safeExecutionResult(receipt([]), SAFE, EXECUTION)).toMatchObject({ status: 'unproven' })
  })

  it('separates an outer revert from a failed call, and refuses a malformed hash or Safe', () => {
    expect(safeExecutionResult(receipt([], 'reverted'), SAFE, PROPOSAL)).toEqual({ status: 'reverted' })
    expect(safeExecutionResult({ status: 'success' }, SAFE, PROPOSAL)).toMatchObject({ status: 'unproven' })
    expect(() => safeExecutionResult(receipt([]), SAFE, '0x1234')).toThrow('Invalid Safe transaction hash')
    expect(() => safeExecutionResult(receipt([]), '0x12' as Address, PROPOSAL)).toThrow('Invalid Safe address')
  })
})
