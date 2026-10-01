/** A quote binds each posted transaction to the ID whose record echoes its exact request, never to the ID at its position. */

import { describe, expect, it, vi } from 'vitest'
import type { Address, Hex } from 'viem'

vi.mock('@wagmi/core', () => ({ getAccount: () => ({ address: undefined }) }))
vi.mock('@/providers/Providers', () => ({ wagmiConfig: {} }))
vi.mock('@/lib/safe-connector', () => ({ isSafeConnection: () => false, SAFE_NONCE_GUIDANCE: '', waitForSafeExecutionHash: vi.fn() }))
vi.mock('@/lib/wallet-core', () => ({ publicClient: vi.fn(), connectedWallet: vi.fn() }))

import { relayrPostBundle, relayrRecordsFor, type RelayrEntry, type RelayrTransactionRecord } from '@/lib/relayr'

const BUNDLE = '9c33afcf-0000-4000-8000-000000000000'
const TARGET = '0x2222222222222222222222222222222222222222' as Address
const CHAINS = [1, 10, 8453, 42161]
const uuid = (index: number) => `00000000-0000-4000-8000-${(index + 1).toString().padStart(12, '0')}`
const entry = (chain: number, data: Hex = `0x${chain.toString(16).padStart(8, '0')}`): RelayrEntry =>
  ({ chain, target: TARGET, data, value: String(chain * 3) })
const entries = CHAINS.map(chain => entry(chain))
// Requested 1, 10, 8453, 42161; the live bundle listed Arbitrum, Base, Ethereum, Optimism.
const LIVE_ORDER = [3, 2, 0, 1]

type Posted = RelayrEntry & { virtual_nonce: number }
type RelayrOptions = {
  listed?: number[]
  hexValues?: boolean
  quoteRecords?: boolean
  record?: (record: Record<string, unknown>, index: number) => Record<string, unknown> | null
  bundle?: () => Response
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

/** Relayr as seen live: IDs and records come back out of request order, and U256 values are echoed in hex. */
function relayr({ listed, hexValues = true, quoteRecords = false, record = r => r, bundle }: RelayrOptions = {}) {
  let posted: Posted[] = []
  const records = (order: number[]) => order.flatMap(index => {
    const echoed = { ...posted[index], value: hexValues ? `0x${BigInt(posted[index].value).toString(16)}` : posted[index].value }
    const changed = record({ tx_uuid: uuid(index), request: echoed }, index)
    return changed ? [changed] : []
  })
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/v1/bundle/prepaid')) {
      posted = JSON.parse(String(init?.body)).transactions
      const order = listed ?? posted.map((_, index) => index)
      return json({
        bundle_uuid: BUNDLE, payment_info: [], tx_uuids: order.map(uuid),
        ...(quoteRecords ? { transactions: records(order) } : {}),
      })
    }
    if (url.endsWith(`/v1/bundle/${BUNDLE}`)) {
      return bundle?.() ?? json({ bundle_uuid: BUNDLE, transactions: records(listed ?? posted.map((_, index) => index)) })
    }
    throw new Error(`Unexpected Relayr request: ${url}`)
  })
  vi.stubGlobal('fetch', fetcher)
  return fetcher
}

describe('Relayr quote binding', () => {
  it.each([
    ['in request order', [0, 1, 2, 3]],
    ['reversed', [3, 2, 1, 0]],
    ['as the live 1, 10, 8453, 42161 bundle listed them', LIVE_ORDER],
  ])('binds every chain to its own ID when Relayr lists the IDs %s', async (_name, listed) => {
    relayr({ listed })
    const quote = await relayrPostBundle(entries)
    expect(quote.expectedTransactions?.map(({ chain, txUuid }) => [chain, txUuid]))
      .toEqual(CHAINS.map((chain, index) => [chain, uuid(index)]))
    expect(quote.transactions?.map(record => record.tx_uuid)).toEqual(CHAINS.map((_, index) => uuid(index)))
    for (const [index, binding] of quote.expectedTransactions!.entries()) {
      expect(binding.entry).toEqual({ ...entries[index], virtual_nonce: 0 })
    }
    expect(quote.bundle_uuid).toBe(BUNDLE)
  })

  it('reads the bundle to learn each record when the quote lists only IDs', async () => {
    const fetcher = relayr({ listed: LIVE_ORDER })
    await relayrPostBundle(entries)
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      'https://api.relayr.ba5ed.com/v1/bundle/prepaid', `https://api.relayr.ba5ed.com/v1/bundle/${BUNDLE}`,
    ])
  })

  it('uses the records the quote carries without reading the bundle again', async () => {
    const fetcher = relayr({ listed: LIVE_ORDER, quoteRecords: true })
    const quote = await relayrPostBundle(entries)
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(quote.expectedTransactions?.map(({ txUuid }) => txUuid)).toEqual(CHAINS.map((_, index) => uuid(index)))
  })

  it('compares the echoed value as a number, whether Relayr writes it in hex or decimal', async () => {
    for (const hexValues of [true, false]) {
      relayr({ listed: LIVE_ORDER, hexValues })
      const quote = await relayrPostBundle(entries)
      expect(quote.expectedTransactions?.map(({ txUuid }) => txUuid)).toEqual(CHAINS.map((_, index) => uuid(index)))
    }
  })

  it('tells identical calls on one chain apart by their virtual nonce', async () => {
    const twice = [entry(1, '0xaa'), entry(1, '0xaa'), entry(10)]
    relayr({ listed: [2, 1, 0] })
    const quote = await relayrPostBundle(twice)
    expect(quote.expectedTransactions?.map(({ chain, txUuid, entry: bound }) => [chain, bound.virtual_nonce, txUuid]))
      .toEqual([[1, 0, uuid(0)], [1, 1, uuid(1)], [10, 0, uuid(2)]])
  })

  describe('pays nothing unless every posted call has exactly one quoted ID', () => {
    const unbound = 'did not bind every quoted transaction to a unique ID. Nothing was paid.'
    type Record_ = Record<string, unknown>
    // Relayr's record at `at`, echoing `change` over the request that was posted.
    const echoing = (at: number, change: Record_) => (record: Record_, index: number) =>
      index === at ? { ...record, request: { ...(record.request as object), ...change } } : record
    it.each([
      ['a record echoes different calldata', { record: echoing(1, { data: '0xdeadbeef' }) }],
      ['a record echoes a different target', { record: echoing(1, { target: '0x3333333333333333333333333333333333333333' }) }],
      ['a record echoes a different value', { record: echoing(2, { value: '0x1' }) }],
      ['a record echoes a different chain', { record: echoing(0, { chain: 10 }) }],
      ['a record echoes a different virtual nonce', { record: echoing(3, { virtual_nonce: 1 }) }],
      ['two records echo the same request', { record: echoing(1, { ...entries[0], value: '0x3', virtual_nonce: 0 }) }],
      ['a record carries an ID the quote never listed', { record: (record: Record_, index: number) =>
        index === 0 ? { ...record, tx_uuid: '00000000-0000-4000-8000-0000000000ff' } : record }],
      ['a record is missing', { record: (record: Record_, index: number) => index === 1 ? null : record }],
      ['a record has no request', { record: (record: Record_, index: number) => index === 1 ? { tx_uuid: record.tx_uuid } : record }],
    ])('when %s', async (_name, options) => {
      relayr({ listed: LIVE_ORDER, ...options })
      await expect(relayrPostBundle(entries)).rejects.toThrow(unbound)
    })

    it('when the quote repeats an ID', async () => {
      relayr({ listed: [0, 0, 2, 3] })
      await expect(relayrPostBundle(entries)).rejects.toThrow(unbound)
    })

    it.each([
      ['answers with an error', () => json({ error: 'unavailable' }, 502)],
      ['returns no transactions', () => json({ bundle_uuid: BUNDLE })],
      ['returns something unreadable', () => new Response('<html>', { status: 200 })],
    ])('when reading the bundle %s', async (_name, bundle) => {
      relayr({ listed: LIVE_ORDER, bundle })
      await expect(relayrPostBundle(entries)).rejects.toThrow('did not return the quoted transactions. Nothing was paid.')
    })
  })
})

describe('Relayr record selection', () => {
  const call = { ...entries[1], virtual_nonce: 0 }
  const quoted = new Set(CHAINS.map((_, index) => uuid(index)))
  const record = (index: number, request: Record<string, unknown> | undefined = { ...call, value: '0x1e' }): RelayrTransactionRecord =>
    ({ tx_uuid: uuid(index), request: request as RelayrTransactionRecord['request'] })
  const select = (records: readonly RelayrTransactionRecord[]) => relayrRecordsFor(records, { chain: call.chain, entry: call }, quoted)

  it('picks the record that echoes the call, wherever its ID sits in the quote', () => {
    const others = [0, 2, 3].map(index => record(index, { ...entries[index], value: `0x${(CHAINS[index] * 3).toString(16)}`, virtual_nonce: 0 }))
    expect(select([...others, record(1)])).toEqual([record(1)])
    expect(select([record(1), ...others])).toEqual([record(1)])
  })

  it('leaves out a record whose ID the bundle never quoted', () => {
    expect(select([{ ...record(1), tx_uuid: '00000000-0000-4000-8000-0000000000ff' }])).toEqual([])
  })

  it('leaves out a record that echoes another call, even on the same chain', () => {
    expect(select([record(1, { ...call, data: '0xdeadbeef', value: '0x1e' })])).toEqual([])
    expect(select([record(1, { ...call, value: '0x1f' })])).toEqual([])
  })

  it('takes a record that echoes no request when it sits on the call\'s chain', () => {
    const bare = (index: number, chain: number): RelayrTransactionRecord => ({ tx_uuid: uuid(index), chain })
    expect(select([bare(0, 1), bare(1, 10)])).toEqual([bare(1, 10)])
    expect(select([{ tx_uuid: uuid(1) }])).toEqual([])
  })

  it('reads IDs in any case and tolerates records that are not objects', () => {
    expect(select([record(1), null, 7, 'record'] as unknown as RelayrTransactionRecord[])).toEqual([record(1)])
    expect(select([{ ...record(1), tx_uuid: uuid(1).toUpperCase() }])).toHaveLength(1)
  })
})
