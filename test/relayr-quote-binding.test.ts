/** A quote binds each posted transaction to the ID whose record echoes its exact request, never to the ID at its position. */

import { describe, expect, it, vi } from 'vitest'
import type { Address, Hex } from 'viem'

vi.mock('@wagmi/core', () => ({ getAccount: () => ({ address: undefined }) }))
vi.mock('@/providers/Providers', () => ({ wagmiConfig: {} }))
vi.mock('@/lib/safe-connector', () => ({ isSafeConnection: () => false, SAFE_NONCE_GUIDANCE: '', waitForSafeExecutionHash: vi.fn() }))
vi.mock('@/lib/wallet-core', () => ({ publicClient: vi.fn(), connectedWallet: vi.fn() }))

import {
  relayrDestinationHash, relayrDestinationRecords, relayrPostBundle, relayrRecordChain,
  type RelayrEntry, type RelayrTransactionBinding, type RelayrTransactionRecord,
} from '@/lib/relayr'

const BUNDLE = '9c33afcf-0000-4000-8000-000000000000'
const OTHER_BUNDLE = '11111111-1111-4111-8111-111111111111'
const TARGET = '0x2222222222222222222222222222222222222222' as Address
const CHAINS = [1, 10, 8453, 42161]
const uuid = (index: number) => `00000000-0000-4000-8000-${(index + 1).toString().padStart(12, '0')}`
const UNQUOTED = uuid(254)
const hex = (value: string) => `0x${BigInt(value).toString(16)}`
const entry = (chain: number, data: Hex = `0x${chain.toString(16).padStart(8, '0')}`): RelayrEntry =>
  ({ chain, target: TARGET, data, value: String(chain * 3) })
const entries = CHAINS.map(chain => entry(chain))
// Requested 1, 10, 8453, 42161; the live bundle listed Arbitrum, Base, Ethereum, Optimism.
const LIVE_ORDER = [3, 2, 0, 1]

type Raw = Record<string, unknown>
type Posted = RelayrEntry & { virtual_nonce: number }
type RelayrOptions = {
  /** The order Relayr lists the posted calls in, by request index. */
  listed?: number[]
  hexValues?: boolean
  /** Overrides or adds fields of the quote itself. */
  body?: Raw
  /** The records the quote carries, from the listed ones. None by default. */
  inQuote?: (records: Raw[]) => unknown
  /** The records the bundle read returns, from the listed ones. */
  inBundle?: (records: Raw[]) => unknown
  /** The bundle read's `bundle_uuid`. */
  echo?: unknown
  /** Replaces the bundle read's whole answer, given the records it would have returned. */
  reply?: (records: Raw[]) => Response
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

/** Relayr as seen live: IDs and records come back out of request order, and U256 values are echoed in hex. */
function relayr({ listed, hexValues = true, body, inQuote, inBundle, echo = BUNDLE, reply }: RelayrOptions = {}) {
  let posted: Posted[] = []
  const order = () => listed ?? posted.map((_, index) => index)
  const records = (): Raw[] => order().map(index => ({
    tx_uuid: uuid(index),
    request: { ...posted[index], value: hexValues ? hex(posted[index].value) : posted[index].value },
  }))
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/v1/bundle/prepaid')) {
      posted = JSON.parse(String(init?.body)).transactions
      return json({
        bundle_uuid: BUNDLE, payment_info: [], tx_uuids: order().map(uuid),
        ...(inQuote ? { transactions: inQuote(records()) } : {}), ...body,
      })
    }
    if (url.endsWith(`/v1/bundle/${BUNDLE}`)) {
      return reply?.(records()) ?? json({ bundle_uuid: echo, transactions: inBundle ? inBundle(records()) : records() })
    }
    throw new Error(`Unexpected Relayr request: ${url}`)
  })
  vi.stubGlobal('fetch', fetcher)
  return fetcher
}

/** Changes the record at `index` of Relayr's listing, or drops it when `change` returns null. */
const at = (index: number, change: (record: Raw) => Raw | null) => (records: Raw[]) =>
  records.flatMap((record, position) => position === index ? change(record) ?? [] : [record])
/** Relayr's record at `index`, echoing `change` over the request that was posted. */
const echoing = (index: number, change: Raw) =>
  at(index, record => ({ ...record, request: { ...(record.request as object), ...change } }))
const callIds = CHAINS.map((_, index) => uuid(index))

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
    expect(quote.transactions?.map(record => record.tx_uuid)).toEqual(callIds)
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
    const fetcher = relayr({ listed: LIVE_ORDER, inQuote: records => records })
    const quote = await relayrPostBundle(entries)
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(quote.expectedTransactions?.map(({ txUuid }) => txUuid)).toEqual(callIds)
  })

  it.each([
    ['a record lacks its request', at(1, record => ({ tx_uuid: record.tx_uuid }))],
    ['a record lacks its ID', at(1, record => ({ request: record.request }))],
    ['a record is empty', at(1, () => ({}))],
    ['a record has an ID that is not a UUID', at(1, record => ({ ...record, tx_uuid: 'tx-1' }))],
    ['a record is missing', at(1, () => null)],
    ['the quote carries one record too many', (records: Raw[]) => [...records, records[0]]],
  ])('reads the bundle instead when %s in the quote', async (_name, inQuote) => {
    const fetcher = relayr({ listed: LIVE_ORDER, inQuote })
    const quote = await relayrPostBundle(entries)
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(quote.expectedTransactions?.map(({ txUuid }) => txUuid)).toEqual(callIds)
  })

  it('compares the echoed value as a number, whether Relayr writes it in hex or decimal', async () => {
    for (const hexValues of [true, false]) {
      relayr({ listed: LIVE_ORDER, hexValues })
      const quote = await relayrPostBundle(entries)
      expect(quote.expectedTransactions?.map(({ txUuid }) => txUuid)).toEqual(callIds)
    }
  })

  it('reads the bundle ID it echoes in any case', async () => {
    relayr({ listed: LIVE_ORDER, echo: BUNDLE.toUpperCase() })
    await expect(relayrPostBundle(entries)).resolves.toMatchObject({ bundle_uuid: BUNDLE })
  })

  it('tells identical calls on one chain apart by their virtual nonce', async () => {
    const twice = [entry(1, '0xaa'), entry(1, '0xaa'), entry(10)]
    relayr({ listed: [2, 1, 0] })
    const quote = await relayrPostBundle(twice)
    expect(quote.expectedTransactions?.map(({ chain, txUuid, entry: bound }) => [chain, bound.virtual_nonce, txUuid]))
      .toEqual([[1, 0, uuid(0)], [1, 1, uuid(1)], [10, 0, uuid(2)]])
  })

  describe('pays nothing unless the bundle holds exactly the quoted IDs, each bound to its own call', () => {
    const unbound = 'did not bind every quoted transaction to a unique ID. Nothing was paid.'
    const foreign = { chain: 10, target: TARGET, data: '0xdead', value: '0x0', virtual_nonce: 5 }
    it.each([
      ['a record echoes different calldata', echoing(1, { data: '0xdeadbeef' })],
      ['a record echoes a different target', echoing(1, { target: '0x3333333333333333333333333333333333333333' })],
      ['a record echoes a different value', echoing(2, { value: '0x1' })],
      ['a record echoes a different chain', echoing(0, { chain: 10 })],
      ['a record echoes a different virtual nonce', echoing(3, { virtual_nonce: 1 })],
      ['a record echoes a null virtual nonce', echoing(3, { virtual_nonce: null })],
      ['two records echo the same request', echoing(1, { ...entries[0], value: '0x3', virtual_nonce: 0 })],
      ['a record carries an ID the quote never listed', at(0, record => ({ ...record, tx_uuid: UNQUOTED }))],
      ['a record is missing', at(1, () => null)],
      ['a record has no request', at(1, record => ({ tx_uuid: record.tx_uuid }))],
      ['a record has no ID', at(2, record => ({ request: record.request }))],
      ['a record has an ID that is not a UUID', at(2, record => ({ ...record, tx_uuid: 'tx-1' }))],
      ['a fifth record carries an unquoted ID and a foreign request',
        (records: Raw[]) => [...records, { tx_uuid: UNQUOTED, request: foreign }]],
      ['a fifth record carries a quoted ID and a foreign request',
        (records: Raw[]) => [...records, { tx_uuid: uuid(0), request: foreign }]],
      ['a fifth record carries a quoted ID and echoes the first call again',
        (records: Raw[]) => [...records, { ...records.find(record => record.tx_uuid === uuid(0))!, tx_uuid: uuid(1) }]],
      ['two records carry one quoted ID', at(0, record => ({ ...record, tx_uuid: uuid(2) }))],
    ])('when %s', async (_name, inBundle) => {
      relayr({ listed: LIVE_ORDER, inBundle })
      await expect(relayrPostBundle(entries)).rejects.toThrow(unbound)
    })

    it.each([
      ['no IDs', { tx_uuids: [] }],
      ['too few IDs', { tx_uuids: callIds.slice(1) }],
      ['too many IDs', { tx_uuids: [...callIds, UNQUOTED] }],
      ['one ID too many, repeating another', { tx_uuids: [...callIds, callIds[0]] }],
      ['a repeated ID', { tx_uuids: [callIds[0], callIds[0], callIds[2], callIds[3]] }],
      ['an ID that is not a UUID', { tx_uuids: [...callIds.slice(0, 3), 'tx-1'] }],
      ['an ID that is not a string', { tx_uuids: [...callIds.slice(0, 3), 7] }],
      ['an ID inside a list', { tx_uuids: [...callIds.slice(0, 3), [callIds[3]]] }],
      ['no payment list', { payment_info: undefined }],
    ])('when the quote lists %s, before reading the bundle', async (_name, body) => {
      const fetcher = relayr({ body })
      await expect(relayrPostBundle(entries)).rejects.toThrow(unbound)
      expect(fetcher).toHaveBeenCalledTimes(1)
    })

    it('when the quote lists its IDs twice and the lists differ', async () => {
      relayr({ body: { tx_uuids: callIds, txn_uuids: [...callIds].reverse() } })
      await expect(relayrPostBundle(entries)).rejects.toThrow('Relayr returned conflicting transaction IDs. Nothing was paid.')
    })

    it.each([
      ['no bundle ID', undefined],
      ['a bundle ID that is not a UUID', 'bundle-1'],
      ['a bundle ID that is not a string', 7],
      ['a bundle ID inside a list', [BUNDLE]],
    ])('when the quote has %s', async (_name, bundleUuid) => {
      relayr({ body: { bundle_uuid: bundleUuid } })
      await expect(relayrPostBundle(entries)).rejects.toThrow('Relayr returned no valid bundle ID. Nothing was paid.')
    })

    it.each([
      ['answers with an error', { reply: () => json({ error: 'unavailable' }, 502) }],
      ['answers with an error status, whatever it carries', { reply: (records: Raw[]) => json({ bundle_uuid: BUNDLE, transactions: records }, 503) }],
      ['cannot be fetched', { reply: () => { throw new TypeError('fetch failed') } }],
      ['returns something unreadable', { reply: () => new Response('{not json', { status: 200 }) }],
      ['returns nothing', { reply: () => json(null) }],
      ['returns no bundle ID', { reply: () => json({ transactions: [] }) }],
      ['returns another bundle', { echo: OTHER_BUNDLE }],
      ['returns a bundle ID that is not a string', { echo: [BUNDLE] }],
      ['returns no records', { reply: () => json({ bundle_uuid: BUNDLE }) }],
      ['returns records that are not a list', { inBundle: () => 'records' }],
    ])('when reading the bundle %s', async (_name, options) => {
      relayr({ listed: LIVE_ORDER, ...options })
      await expect(relayrPostBundle(entries)).rejects.toThrow('Relayr did not return the quoted transactions. Nothing was paid.')
    })

    it('when the bundle read fails, keeping its cause out of the message', async () => {
      const failure = new TypeError('fetch failed: https://relayr.invalid/key')
      relayr({ listed: LIVE_ORDER, reply: () => { throw failure } })
      const error = await relayrPostBundle(entries).then(() => null, (thrown: Error) => thrown)
      expect(error?.message).toBe('Relayr did not return the quoted transactions. Nothing was paid.')
      expect(error?.cause).toBe(failure)
      expect(JSON.stringify(error)).not.toContain('relayr.invalid')
    })
  })
})

describe('Relayr destination records', () => {
  const first: RelayrEntry = { ...entry(1), virtual_nonce: 0 }
  const second: RelayrEntry = { ...entry(10), virtual_nonce: 0 }
  const bindings: RelayrTransactionBinding[] = [
    { txUuid: uuid(0), chain: 1, entry: first },
    { txUuid: uuid(1), chain: 10, entry: second },
  ]
  const HASH_ONE = `0x${'ab'.repeat(32)}` as Hex
  const HASH_TWO = `0x${'cd'.repeat(32)}` as Hex
  const recordOf = (call: RelayrEntry, id: string, hash?: Hex): RelayrTransactionRecord => ({
    tx_uuid: id, request: { ...call, value: hex(call.value) },
    ...(hash ? { status: { state: 'Success', data: { hash } } } : {}),
  })
  // Out of order, as Relayr lists them.
  const listed = () => [recordOf(second, uuid(1), HASH_TWO), recordOf(first, uuid(0), HASH_ONE)]
  const NO_PROOF = 'This saved Relayr bundle lacks exact destination proof. Keep it pending and verify the original transactions; do not pay again.'
  const NOT_IDENTIFIED = 'Relayr has not identified every exact destination transaction. Keep checking the original bundle; do not pay again.'
  const UNBOUND = "Relayr's status names a transaction this quote did not bind. Keep the original bundle pending; do not pay again."
  const MISMATCHED = "Relayr's destination call does not match the signed request. Keep the original bundle pending; do not pay again."
  const SHARED = 'Relayr reported one destination transaction for two signed calls. Keep the original bundle pending; do not pay again.'

  it('names each binding\'s record in binding order, wherever Relayr lists it', () => {
    const [one, two] = [recordOf(first, uuid(0), HASH_ONE), recordOf(second, uuid(1), HASH_TWO)]
    expect(relayrDestinationRecords(listed(), bindings)).toEqual({ records: [one, two], refusal: null })
    expect(relayrDestinationRecords([two, one], bindings)).toEqual({ records: [one, two], refusal: null })
  })

  it('names the records of bindings that hold each other\'s IDs', () => {
    const swapped = [{ ...bindings[0], txUuid: uuid(1) }, { ...bindings[1], txUuid: uuid(0) }]
    expect(relayrDestinationRecords(listed(), swapped)).toEqual({
      records: [recordOf(first, uuid(0), HASH_ONE), recordOf(second, uuid(1), HASH_TWO)], refusal: null,
    })
  })

  it('pairs a record that echoes no request by its chain and its exact ID', () => {
    const bare = (id: string, chain: number): RelayrTransactionRecord => ({ tx_uuid: id, chain })
    expect(relayrDestinationRecords([bare(uuid(1), 10), bare(uuid(0), 1)], bindings))
      .toEqual({ records: [bare(uuid(0), 1), bare(uuid(1), 10)], refusal: null })
    expect(relayrDestinationRecords([bare(uuid(0), 10), bare(uuid(1), 1)], bindings).refusal).toBe(MISMATCHED)
    expect(relayrDestinationRecords([bare(uuid(0), 1), { tx_uuid: uuid(1) }], bindings).refusal).toBe(MISMATCHED)
  })

  it('compares virtual nonces only when both sides carry one', () => {
    const unnumberedRecords = listed().map(({ request, ...record }) => ({ ...record, request: { ...request!, virtual_nonce: undefined } }))
    const unnumberedBindings = bindings.map(binding => ({ ...binding, entry: { ...binding.entry, virtual_nonce: undefined } }))
    expect(relayrDestinationRecords(unnumberedRecords, bindings).refusal).toBeNull()
    expect(relayrDestinationRecords(listed(), unnumberedBindings).refusal).toBeNull()
    const other = listed()
    other[1] = { ...other[1], request: { ...first, value: hex(first.value), virtual_nonce: 1 } }
    expect(relayrDestinationRecords(other, bindings).refusal).toBe(MISMATCHED)
  })

  it('names no call from records that cannot tell two calls on one chain apart', () => {
    const twice: RelayrTransactionBinding[] = [
      { txUuid: uuid(0), chain: 1, entry: { ...entry(1, '0xaa'), virtual_nonce: 0 } },
      { txUuid: uuid(1), chain: 1, entry: { ...entry(1, '0xaa'), virtual_nonce: 1 } },
    ]
    const unnumbered = twice.map(({ txUuid, entry: call }): RelayrTransactionRecord =>
      ({ tx_uuid: txUuid, request: { ...call, value: hex(call.value), virtual_nonce: undefined } }))
    expect(relayrDestinationRecords(unnumbered, twice).refusal).toBe(MISMATCHED)
    const numbered = twice.map(({ txUuid, entry: call }): RelayrTransactionRecord =>
      ({ tx_uuid: txUuid, request: { ...call, value: hex(call.value) } }))
    expect(relayrDestinationRecords([...numbered].reverse(), twice)).toEqual({ records: numbered, refusal: null })
  })

  it.each([
    ['no bindings', [] as RelayrTransactionBinding[]],
    ['an ID that is not a UUID', [{ ...bindings[0], txUuid: 'tx-1' }, bindings[1]]],
    ['an ID that is not a string', [{ ...bindings[0], txUuid: 7 as unknown as string }, bindings[1]]],
    ['a repeated ID', [bindings[0], { ...bindings[1], txUuid: uuid(0) }]],
    ['a chain other than its entry\'s', [{ ...bindings[0], chain: 8453 }, bindings[1]]],
    ['a malformed entry', [{ ...bindings[0], entry: { ...first, value: '-5' } }, bindings[1]]],
    ['a missing binding', [null as unknown as RelayrTransactionBinding]],
  ])('keeps a saved bundle with %s pending', (_name, saved) => {
    expect(relayrDestinationRecords(listed(), saved)).toEqual({ records: [], refusal: NO_PROOF })
  })

  it.each([
    ['fewer records', (records: RelayrTransactionRecord[]) => records.slice(1)],
    ['no records', () => [] as RelayrTransactionRecord[]],
    ['more records', (records: RelayrTransactionRecord[]) => [...records, recordOf(first, UNQUOTED)]],
  ])('keeps checking while Relayr lists %s', (_name, change) => {
    expect(relayrDestinationRecords(change(listed()), bindings)).toEqual({ records: [], refusal: NOT_IDENTIFIED })
  })

  it.each([
    ['an ID this quote did not bind', (records: RelayrTransactionRecord[]) => [{ ...records[0], tx_uuid: UNQUOTED }, records[1]], UNBOUND],
    ['one ID twice', (records: RelayrTransactionRecord[]) => [{ ...records[0], tx_uuid: uuid(0) }, records[1]], UNBOUND],
    ['an ID that is not a UUID', (records: RelayrTransactionRecord[]) => [{ ...records[0], tx_uuid: 'tx-1' }, records[1]], UNBOUND],
    ['no ID', (records: RelayrTransactionRecord[]) => [{ request: records[0].request }, records[1]], UNBOUND],
    ['an empty record', (records: RelayrTransactionRecord[]) => [records[0], null as unknown as RelayrTransactionRecord], UNBOUND],
    ['changed calldata', (records: RelayrTransactionRecord[]) => [records[0], { ...records[1], request: { ...records[1].request!, data: '0x99' as Hex } }], MISMATCHED],
    ['changed value', (records: RelayrTransactionRecord[]) => [records[0], { ...records[1], request: { ...records[1].request!, value: '0x1' } }], MISMATCHED],
    ['one request twice', (records: RelayrTransactionRecord[]) => [{ ...records[0], request: records[1].request }, records[1]], MISMATCHED],
    ['one hash for two calls', (records: RelayrTransactionRecord[]) => [{ ...records[0], status: { data: { hash: HASH_ONE } } }, records[1]], SHARED],
    ['one hash for two calls, in another case', (records: RelayrTransactionRecord[]) => [{ ...records[0], status: { data: { hash: HASH_ONE.toUpperCase().replace('0X', '0x') as Hex } } }, records[1]], SHARED],
  ])('refuses a status with %s', (_name, change, refusal) => {
    expect(relayrDestinationRecords(change(listed()), bindings)).toEqual({ records: [], refusal })
  })

  it('still names a record that reports no hash yet, or a malformed one, since readiness is per call', () => {
    const waiting = listed()
    waiting[0] = { ...waiting[0], status: { state: 'Pending' } }
    waiting[1] = { ...waiting[1], status: { state: 'Success', data: { hash: '0x12' as Hex } } }
    const named = relayrDestinationRecords(waiting, bindings)
    expect(named.refusal).toBeNull()
    expect(named.records.map(relayrDestinationHash)).toEqual([null, null])
  })
})

describe('Relayr destination hash', () => {
  const HASH = `0x${'ab'.repeat(32)}` as Hex
  const NESTED = `0x${'cd'.repeat(32)}` as Hex
  const reporting = (data: unknown) => ({ status: { data } }) as RelayrTransactionRecord

  it('reads a transaction hash, in either place Relayr reports it', () => {
    expect(relayrDestinationHash(reporting({ hash: HASH }))).toBe(HASH)
    expect(relayrDestinationHash(reporting({ transaction: { hash: NESTED } }))).toBe(NESTED)
    expect(relayrDestinationHash(reporting({ hash: HASH, transaction: { hash: NESTED } }))).toBe(HASH)
    const upper = `0x${'AB'.repeat(32)}` as Hex
    expect(relayrDestinationHash(reporting({ hash: upper }))).toBe(upper)
  })

  it.each([
    ['an empty string', ''],
    ['text', '0xnot-a-hash'],
    ['too few digits', '0x12'],
    ['one digit short', `0x${'ab'.repeat(32)}`.slice(0, -1)],
    ['one digit long', `0x${'ab'.repeat(32)}0`],
    ['no prefix', 'ab'.repeat(32)],
    ['a number', 7],
    ['a list', [HASH]],
    ['an object', { hash: HASH }],
  ])('reads no hash from %s', (_name, hash) => {
    expect(relayrDestinationHash(reporting({ hash }))).toBeNull()
    expect(relayrDestinationHash(reporting({ transaction: { hash } }))).toBeNull()
  })

  it('does not fall back to the nested hash once the plain one is present but malformed', () => {
    expect(relayrDestinationHash(reporting({ hash: '', transaction: { hash: NESTED } }))).toBeNull()
    expect(relayrDestinationHash(reporting({ hash: '0xnot-a-hash', transaction: { hash: NESTED } }))).toBeNull()
  })

  it('reads no hash from a record that reports none', () => {
    for (const record of [{}, { status: {} }, { status: { data: {} } }, { status: null }, null, undefined]) {
      expect(relayrDestinationHash(record as unknown as RelayrTransactionRecord)).toBeNull()
    }
  })

  it('reads a record\'s chain from its request before its own, and never from a record that is not one', () => {
    expect(relayrRecordChain({ chain: 1, request: { ...entry(10) } })).toBe(10)
    expect(relayrRecordChain({ chain: 8453 })).toBe(8453)
    for (const chain of [0, -1, 1.5, '1']) expect(relayrRecordChain({ chain: chain as number })).toBeNull()
    expect(relayrRecordChain(null as unknown as RelayrTransactionRecord)).toBeNull()
  })
})
