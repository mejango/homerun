/** A poll reads Relayr's bundle without a cache, and takes an answer only when it names that bundle. */

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@wagmi/core', () => ({ getAccount: () => ({ address: undefined }) }))
vi.mock('@/providers/Providers', () => ({ wagmiConfig: {} }))
vi.mock('@/lib/safe-connector', () => ({ isSafeConnection: () => false }))
vi.mock('@/lib/wallet-core', () => ({ publicClient: vi.fn(), connectedWallet: vi.fn() }))

import { RelayrExecutionError, relayrPoll, type RelayrTransactionRecord } from '@/lib/relayr'

const BUNDLE = '9c33afcf-0000-4000-8000-000000000000'
const OTHER = '11111111-1111-4111-8111-111111111111'
const URL = `https://api.relayr.ba5ed.com/v1/bundle/${BUNDLE}`
const record = (state: string): RelayrTransactionRecord => ({ tx_uuid: '00000000-0000-4000-8000-000000000001', status: { state } })
const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

/** Polls every millisecond, for at most `timeoutMs`. */
const poll = (timeoutMs = 60) => relayrPoll(BUNDLE, 1, undefined, 1, timeoutMs)
const failure = (promise: Promise<unknown>) => promise.then(() => null, (error: unknown) => error as RelayrExecutionError)

beforeEach(() => {
  vi.mocked(fetch).mockImplementation(async () => answer({ bundle_uuid: BUNDLE, transactions: [record('Success')] }))
})

describe('relayrPoll', () => {
  it('reads the bundle without an HTTP cache, from the bundle\'s own address', async () => {
    expect(await poll()).toEqual([record('Success')])
    expect(fetch).toHaveBeenCalledWith(URL, expect.objectContaining({ cache: 'no-store', signal: expect.any(AbortSignal) }))
  })

  it('takes the answer of a bundle named in any letter case', async () => {
    vi.mocked(fetch).mockImplementation(async () => answer({ bundle_uuid: BUNDLE.toUpperCase(), transactions: [record('Completed')] }))
    expect(await poll()).toEqual([record('Completed')])
  })

  it.each([
    ['another bundle', { bundle_uuid: OTHER, transactions: [record('Success')] }],
    ['no bundle', { transactions: [record('Success')] }],
    ['a bundle that is not a string', { bundle_uuid: 7, transactions: [record('Success')] }],
    ['no list of records', { bundle_uuid: BUNDLE }],
    ['records that are not a list', { bundle_uuid: BUNDLE, transactions: { 0: record('Success') } }],
    ['nothing', null],
  ])('never takes an answer that names %s, and keeps the saved records', async (_name, body) => {
    vi.mocked(fetch).mockImplementation(async () => answer(body))
    const updates = vi.fn()
    const error = await failure(relayrPoll(BUNDLE, 1, updates, 1, 40))
    expect(error).toMatchObject({ name: 'RelayrExecutionError', code: 'RELAYR_TIMEOUT', records: [] })
    expect(updates).not.toHaveBeenCalled()
  })

  it('keeps polling through an answer that is not ok, and reads the next', async () => {
    vi.mocked(fetch)
      .mockImplementationOnce(async () => answer({ error: 'busy' }, 503))
      .mockImplementationOnce(async () => answer({ bundle_uuid: BUNDLE, transactions: [record('Pending')] }))
    const updates = vi.fn()
    expect(await relayrPoll(BUNDLE, 1, updates, 1, 200)).toEqual([record('Success')])
    expect(updates).toHaveBeenNthCalledWith(1, [record('Pending')])
  })

  it('fails when Relayr reports a call failed', async () => {
    vi.mocked(fetch).mockImplementation(async () => answer({ bundle_uuid: BUNDLE, transactions: [record('Failed')] }))
    expect(await failure(poll())).toMatchObject({ code: 'RELAYR_FAILED', retryable: false, records: [record('Failed')] })
  })

  it('stops at the third answer in a row that says it has no such bundle', async () => {
    vi.mocked(fetch).mockImplementation(async () => answer({ error: 'not found' }, 404))
    expect(await failure(relayrPoll(BUNDLE, 1, undefined, 1, 500))).toMatchObject({ code: 'RELAYR_NOT_FOUND', retryable: false })
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  it('counts only answers in a row that say it has no such bundle', async () => {
    vi.mocked(fetch)
      .mockImplementationOnce(async () => answer({}, 404))
      .mockImplementationOnce(async () => answer({}, 404))
      .mockImplementationOnce(async () => answer({ bundle_uuid: BUNDLE, transactions: [record('Pending')] }))
      .mockImplementationOnce(async () => answer({}, 404))
    expect(await relayrPoll(BUNDLE, 1, undefined, 1, 500)).toEqual([record('Success')])
  })
})
