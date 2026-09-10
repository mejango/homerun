import { beforeEach, describe, expect, it, vi } from 'vitest'

const runtime = vi.hoisted(() => ({
  connector: { id: 'injected', name: 'Browser wallet' },
}))

vi.mock('wagmi/actions', () => ({
  getAccount: () => ({ connector: runtime.connector }),
}))

import {
  isSafeConnection,
  SAFE_NONCE_GUIDANCE,
  SAFE_PREFIX,
  SAFE_SERVICE_PREFIX,
  safeQueueUrl,
  safeServiceBase,
  swapDeadline,
  waitForSafeExecutionHash,
} from '@/lib/safe-connector'

const SAFE = '0x1111111111111111111111111111111111111111' as const
const PROPOSAL = `0x${'ab'.repeat(32)}` as const
const EXECUTION = `0x${'cd'.repeat(32)}` as const

describe('Safe connector transaction boundaries', () => {
  beforeEach(() => {
    runtime.connector = { id: 'injected', name: 'Browser wallet' }
  })

  it('identifies Safe connectors and explains the authoritative nonce selector', () => {
    runtime.connector = { id: 'safe', name: 'Safe' }
    expect(isSafeConnection({} as never)).toBe(true)
    expect(SAFE_NONCE_GUIDANCE).toMatch(/next available/i)
    expect(SAFE_NONCE_GUIDANCE).toMatch(/queued nonces/i)
    expect(safeQueueUrl(8453, SAFE)).toContain(`safe=base:${SAFE}`)
  })

  it('gives swaps a 20-minute deadline for EOAs and 30 days for Safe signature collection', () => {
    const nowMs = 1_700_000_000_000
    const nowSec = 1_700_000_000
    // EOA: proposal and execution are one act, so 20 minutes is plenty.
    expect(swapDeadline(false, nowMs)).toBe(BigInt(nowSec + 20 * 60))
    // Safe: co-signer collection routinely outlives 20 minutes — match the
    // 30-day Permit2 windows so the executed swap doesn't revert on deadline.
    expect(swapDeadline(true, nowMs)).toBe(BigInt(nowSec + 30 * 24 * 60 * 60))
  })

  it('resolves a proposal identifier to the mined execution hash before receipt polling', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          isExecuted: true,
          isSuccessful: true,
          transactionHash: EXECUTION,
        }),
      })),
    )

    await expect(waitForSafeExecutionHash(8453, PROPOSAL)).resolves.toBe(EXECUTION)
    // The polling URL must come from the hosted-service map, never the wider
    // app-URL map — `basesep` is hosted while `opsepolia`/`arb1-sep` 404.
    expect(fetch).toHaveBeenCalledWith(
      `https://api.safe.global/tx-service/base/api/v1/multisig-transactions/${PROPOSAL}/`,
    )
  })

  it('keeps the app-URL map wider than the hosted-service map (deliberate split)', () => {
    // Unifying these maps is what previously made service calls fire at
    // chains with none. The connector supports Safe links on all eight
    // chains; only six have a hosted transaction service.
    expect(Object.keys(SAFE_PREFIX).map(Number).sort()).toEqual(
      [1, 10, 8453, 42161, 11155111, 11155420, 84532, 421614].sort(),
    )
    expect(Object.keys(SAFE_SERVICE_PREFIX).map(Number).sort()).toEqual(
      [1, 10, 8453, 42161, 11155111, 84532].sort(),
    )
    expect(safeServiceBase(11155420)).toBeNull()
    expect(safeServiceBase(421614)).toBeNull()
    expect(safeServiceBase(84532)).toBe(
      'https://api.safe.global/tx-service/basesep',
    )
  })

  it('fails immediately on chains without a hosted transaction service instead of polling forever', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    // OP Sepolia and Arbitrum Sepolia have Safe app URLs but no hosted
    // service — polling `tx-service/{opsepolia,arb1-sep}` 404s forever, which
    // left every Safe write there stuck at "pending" with retry blocked.
    await expect(waitForSafeExecutionHash(11155420, PROPOSAL)).rejects.toThrow(
      /does not host a transaction service/i,
    )
    await expect(waitForSafeExecutionHash(421614, PROPOSAL)).rejects.toThrow(
      /does not host a transaction service/i,
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('treats sustained 404s from the service as terminal instead of pending forever', async () => {
    vi.stubGlobal('window', {
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
    })
    const fetchMock = vi.fn(async () => ({ ok: false, status: 404 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      waitForSafeExecutionHash(8453, PROPOSAL, { pollingIntervalMs: 1 }),
    ).rejects.toThrow(/no record of this proposal/i)
    expect(fetchMock).toHaveBeenCalledTimes(12)
  })

  it('rides out a transient 404 once the service starts responding', async () => {
    vi.stubGlobal('window', {
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
    })
    let calls = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls += 1
        // The service can lag a just-created proposal briefly.
        if (calls < 3) return { ok: false, status: 404 }
        return {
          ok: true,
          json: async () => ({
            isExecuted: true,
            isSuccessful: true,
            transactionHash: EXECUTION,
          }),
        }
      }),
    )

    await expect(
      waitForSafeExecutionHash(8453, PROPOSAL, { pollingIntervalMs: 1 }),
    ).resolves.toBe(EXECUTION)
  })
})
