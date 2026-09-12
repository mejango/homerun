import { beforeEach, describe, expect, it, vi } from 'vitest'
import { encodeFunctionData, type Address, type Hex } from 'viem'
import { erc2771ForwarderAbi, JBCoreContracts, jbContractAddress, type JBChainId } from '@bananapus/nana-sdk-core'
import type { RelayrEntry, RelayrPayment, RelayrQuote, RelayrTransactionRecord } from '@/lib/relayr'

const m = vi.hoisted(() => ({
  account: '0x1111111111111111111111111111111111111111' as Address,
  safe: false,
  fee: vi.fn(),
  review: vi.fn(),
  projectId: vi.fn(),
  forward: vi.fn(),
  quote: vi.fn(),
  pay: vi.fn(),
  funding: vi.fn(),
  poll: vi.fn(),
  client: vi.fn(),
  pending: vi.fn(),
}))
vi.mock('@wagmi/core', () => ({ getAccount: () => ({ address: m.account }) }))
vi.mock('@/providers/Providers', () => ({ wagmiConfig: {},
  SUPPORTED_CHAINS: [1, 10, 8453, 42161, 11155111, 11155420, 84532, 421614].map(id => ({ id, name: `Chain ${id}` })),
}))
vi.mock('@/lib/transaction-review', () => ({ requireFundingChainSelection: m.funding, requireTransactionReview: m.review }))
vi.mock('@/lib/safe-connector', () => ({ isSafeConnection: () => m.safe }))
vi.mock('@/lib/wallet-core', () => ({ publicClient: m.client }))
vi.mock('@bananapus/nana-sdk-core/v6', async original => ({ ...await original<typeof import('@bananapus/nana-sdk-core/v6')>(), getProjectCreationFee: m.fee }))
vi.mock('@/lib/fund-launch-verification', () => ({ verifyFundLaunch: m.projectId }))
vi.mock('@/lib/relayr', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/relayr')>()),
  TRUSTED_FORWARDER_ABI: [{ type: 'function', name: 'isTrustedForwarder', stateMutability: 'view',
    inputs: [{ name: 'forwarder', type: 'address' }], outputs: [{ type: 'bool' }] }],
  prepareForwardedTx: m.forward, relayrPostBundle: m.quote, relayrPay: m.pay,
  relayrPoll: m.poll,
  relayrDestinationHash: (record: RelayrTransactionRecord) => record.status?.data?.hash ?? null,
  readRelayrPendingSessionsForAuthorization: () => {
    const session = m.pending()
    return session ? [{ scope: 'another-action', session }] : []
  },
}))

import { relayrPaymentDetails, RELAYR_PAYMENT_ADDRESS, RELAYR_NATIVE_TOKEN, RELAYR_PAYMENT_SELECTOR } from '@/lib/relayr'
import { canRelayrLaunch, runRelayrLaunch } from '@/lib/fund-launch-relayr'
import { FUND_LAUNCH_KEY, canCancelLaunch, cancelUnsubmittedLaunch, loadLaunchSession, saveLaunch as saveLaunchSession, type FundLaunchSession as LaunchSession } from '@/lib/fund-launch-session'

const ACCOUNT = '0x1111111111111111111111111111111111111111' as Address
const TARGET = '0x2222222222222222222222222222222222222222' as Address
const HASH = `0x${'aa'.repeat(32)}` as Hex
const BLOCK = `0x${'bb'.repeat(32)}` as Hex
const NOW = 1_900_000_000
const BUNDLE = '00000000-0000-0000-0000-000000000001'
const TESTNETS = [11155111, 11155420, 84532, 421614]
let storage: Map<string, string>
let quote: RelayrQuote
let entries: RelayrEntry[]
let records: RelayrTransactionRecord[]
let clients: Map<number, ReturnType<typeof makeClient>>
let failed: Set<number>
let offeredPaymentChains: number[]

function paymentFor(chain: number, deadline = NOW + 600): RelayrPayment {
  return { chain, amount: '200', target: RELAYR_PAYMENT_ADDRESS, token: RELAYR_NATIVE_TOKEN,
    payment_deadline: deadline,
    calldata: `${RELAYR_PAYMENT_SELECTOR}${BUNDLE.replaceAll('-', '').padEnd(64, '0')}${deadline.toString(16).padStart(64, '0')}` as Hex }
}

function hashFor(chainId: number): Hex { return `0x${chainId.toString(16).padStart(64, '0')}` }
function makeClient(chainId: number) {
  return {
    getCode: vi.fn(async ({ address }: { address: Address }) => address === ACCOUNT ? '0x' : '0x6000'),
    readContract: vi.fn(async ({ functionName }: { functionName: string }): Promise<bigint | boolean> => functionName === 'nonces' ? 0n : true),
    estimateGas: vi.fn(async (_request: unknown) => 2_000_000n),
    call: vi.fn(async () => ({ data: '0x' })),
    getBlock: vi.fn(async () => ({ number: 123n, hash: BLOCK, timestamp: BigInt(NOW) })),
    getTransaction: vi.fn(async ({ hash }: { hash: Hex }) => {
      const entry = entries.find(item => hashFor(item.chain) === hash)!
      return { hash, to: entry.target, input: entry.data, value: BigInt(entry.value), chainId: entry.chain, blockHash: BLOCK }
    }),
    getTransactionReceipt: vi.fn(async ({ hash }: { hash: Hex }) => ({
      transactionHash: hash, blockHash: BLOCK, blockNumber: 123n, status: failed.has(chainId) ? 'reverted' : 'success', logs: [],
    })),
  }
}

function session(chains = [1, 10], paymentChainId = 8453): LaunchSession {
  return { version: 1, name: 'Asset',
    input: { owner: TARGET, sender: ACCOUNT, chainIds: chains, projectUri: 'ipfs://launch', salt: `0x${'cc'.repeat(32)}`, mustStartAtOrAfter: NOW, creationFees: Object.fromEntries(chains.map(chain => [chain, 17n])) },
    statuses: Object.fromEntries(chains.map(chain => [chain, { phase: 'ready' as const }])),
    transport: 'relayr', paymentChainId,
  }
}
async function run(value = loadLaunchSession() ?? session()) {
  return runRelayrLaunch({ session: value, account: m.account, onStatus: vi.fn(), onProgress: vi.fn() })
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.spyOn(Date, 'now').mockReturnValue(NOW * 1000)
  m.account = ACCOUNT
  m.safe = false
  m.pending.mockReturnValue(null)
  storage = new Map()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
    clear: () => storage.clear(),
  })
  vi.stubGlobal('navigator', { locks: { request: async (_name: string, _options: unknown, fn: (lock: object) => Promise<void>) => fn({}) } })
  failed = new Set()
  clients = new Map([1, 10, 8453, 42161, ...TESTNETS].map(chain => [chain, makeClient(chain)]))
  offeredPaymentChains = [8453, 1]
  m.client.mockImplementation(chain => clients.get(chain))
  m.fee.mockResolvedValue(17n)
  m.funding.mockResolvedValue(8453)
  m.projectId.mockImplementation((_client, request) => BigInt(request.chainId + 100))
  m.forward.mockImplementation(async (call, account, nonce) => {
    expect(nonce).toBe(0n)
    return { review: { calls: [{ chainId: call.chainId, from: account, to: call.target, data: call.data, value: call.value }], authorization: { type: 'test' } }, sign: async () => ({ chain: call.chainId, target: jbContractAddress['6'][JBCoreContracts.ERC2771Forwarder][call.chainId as JBChainId],
      value: call.value.toString(), data: encodeFunctionData({ abi: erc2771ForwarderAbi, functionName: 'execute',
        args: [{ from: account, to: call.target, value: call.value, gas: call.gas, deadline: NOW + 3600,
          data: call.data, signature: `0x${'dd'.repeat(65)}` }] }) }) }
  })
  entries = []
  records = []
  m.quote.mockImplementation(async (signed: RelayrEntry[]) => {
    // Signatures must be journalled before they leave this browser.
    expect(loadLaunchSession()?.relayr?.phase).toBe('quoting')
    expect(loadLaunchSession()?.relayr?.signed).toHaveLength(signed.length)
    entries = signed
    quote = { bundle_uuid: '00000000-0000-0000-0000-000000000001',
      payment_info: offeredPaymentChains.map(chain => paymentFor(chain)),
      expectedTransactions: signed.map((entry, i) => ({ txUuid: `tx-${i}`, chain: entry.chain, entry })) }
    records = signed.map((entry, i) => ({ tx_uuid: `tx-${i}`, status: { state: 'Confirmed', data: { hash: hashFor(entry.chain) } } }))
    return quote
  })
  m.pay.mockImplementation(async (_payment, _account, _uuid, destinationChainIds, submitted, reverify, sending) => {
    expect(destinationChainIds).toEqual(entries.map(entry => entry.chain))
    await reverify()
    sending()
    expect(loadLaunchSession()?.relayr?.phase).toBe('payment-signing')
    submitted(HASH)
    return HASH
  })
  m.poll.mockImplementation(async (_uuid, _count, update) => { update(records); return records })
  saveLaunchSession(session())
})

describe('relayed launch execution and recovery', () => {
  it('waits for the quote before showing any funding choices or persisting a preferred chain', async () => {
    const makeQuote = m.quote.getMockImplementation()!
    let release!: () => void
    const waiting = new Promise<void>(resolve => { release = resolve })
    m.quote.mockImplementationOnce(async signed => { await waiting; return makeQuote(signed) })
    const pending = run()
    await vi.waitFor(() => expect(m.quote).toHaveBeenCalledTimes(1))
    expect(m.funding).not.toHaveBeenCalled()
    expect(m.pay).not.toHaveBeenCalled()
    expect(loadLaunchSession()?.paymentChainId).toBeUndefined()
    expect(loadLaunchSession()?.relayr?.paymentChainId).toBeUndefined()
    release()
    await pending
    expect(m.funding).toHaveBeenCalledTimes(1)
  })

  it('offers exactly the valid same-family quote choices, including a single explicit choice', async () => {
    storage.clear()
    saveLaunchSession(session(TESTNETS, 421614))
    const makeQuote = m.quote.getMockImplementation()!
    m.quote.mockImplementationOnce(async signed => ({ ...await makeQuote(signed), payment_info: [
      paymentFor(1), paymentFor(11155111), paymentFor(11155111),
      { ...paymentFor(84532), target: TARGET }, paymentFor(421614, NOW + 10),
    ] }))
    m.funding.mockResolvedValue(11155111)
    await run()
    expect(m.funding).toHaveBeenCalledExactlyOnceWith([{ chainId: 11155111, label: expect.stringContaining('Sepolia') }])
    expect(m.pay.mock.calls[0][0].chain).toBe(11155111)
    expect(loadLaunchSession()?.relayr?.paymentChainId).toBe(11155111)
  })

  it('validates quote destination bindings before presenting its funding choices', async () => {
    const makeQuote = m.quote.getMockImplementation()!
    m.quote.mockImplementationOnce(async signed => ({ ...await makeQuote(signed), expectedTransactions: [] }))
    await expect(run()).rejects.toThrow('does not bind')
    expect(m.funding).not.toHaveBeenCalled()
    expect(m.pay).not.toHaveBeenCalled()
  })

  it('rejects a chain absent from the displayed quote without sending payment', async () => {
    m.funding.mockResolvedValue(42161)
    await expect(run()).rejects.toThrow('selected funding chain is not available')
    expect(m.pay).not.toHaveBeenCalled()
    expect(loadLaunchSession()?.relayr?.paymentChainId).toBeUndefined()
  })

  it('refreshes an expired unpaid quote using the exact signed entries and asks for the newly offered chain', async () => {
    m.funding.mockRejectedValueOnce(new Error('Funding selection cancelled'))
    await expect(run()).rejects.toThrow('cancelled')
    const originalEntries = structuredClone(entries)
    vi.mocked(Date.now).mockReturnValue((NOW + 700) * 1000)
    offeredPaymentChains = [10]
    const makeQuote = m.quote.getMockImplementation()!
    m.quote.mockImplementationOnce(async signed => ({ ...await makeQuote(signed), payment_info: [paymentFor(10, NOW + 1300)] }))
    m.funding.mockResolvedValue(10)
    await run()
    expect(m.forward).toHaveBeenCalledTimes(2)
    expect(m.quote).toHaveBeenCalledTimes(2)
    expect(m.quote.mock.calls[1][0]).toEqual(originalEntries)
    expect(m.funding.mock.calls[1][0]).toEqual([{ chainId: 10, label: expect.any(String) }])
    expect(m.pay.mock.calls[0][0].chain).toBe(10)
  })

  it('refreshes unusable funding offers before asking for a choice', async () => {
    const makeQuote = m.quote.getMockImplementation()!
    m.quote.mockImplementationOnce(async signed => ({ ...await makeQuote(signed), payment_info: [paymentFor(11155111)] }))
    await run()
    expect(m.quote).toHaveBeenCalledTimes(2)
    expect(m.quote.mock.calls[1][0]).toEqual(m.quote.mock.calls[0][0])
    expect(m.forward).toHaveBeenCalledTimes(2)
    expect(m.funding).toHaveBeenCalledTimes(1)
    expect(m.pay).toHaveBeenCalledTimes(1)
  })

  it('does not open the chooser when both quotes lack usable same-family funding offers', async () => {
    offeredPaymentChains = [11155111]
    await expect(run()).rejects.toThrow('no usable payment options')
    expect(m.quote).toHaveBeenCalledTimes(2)
    expect(m.funding).not.toHaveBeenCalled()
    expect(m.pay).not.toHaveBeenCalled()
    expect(loadLaunchSession()?.relayr?.phase).toBe('quoted')
  })

  it('fails safely when a quote expires in the chooser and requests a new explicit choice on retry', async () => {
    m.funding.mockImplementationOnce(async () => { vi.mocked(Date.now).mockReturnValue((NOW + 700) * 1000); return 8453 })
    await expect(run()).rejects.toThrow('quote expired')
    expect(m.pay).not.toHaveBeenCalled()
    expect(loadLaunchSession()?.relayr?.paymentChainId).toBeUndefined()
    const makeQuote = m.quote.getMockImplementation()!
    m.quote.mockImplementationOnce(async signed => ({ ...await makeQuote(signed), payment_info: [paymentFor(1, NOW + 1300)] }))
    m.funding.mockResolvedValue(1)
    await run()
    expect(m.quote).toHaveBeenCalledTimes(2)
    expect(m.forward).toHaveBeenCalledTimes(2)
    expect(m.funding).toHaveBeenCalledTimes(2)
    expect(m.pay.mock.calls[0][0].chain).toBe(1)
  })

  it.each([undefined, 11155111])('rejects a started mainnet journal with invalid saved funding chain %s without reopening the picker', async paymentChainId => {
    m.pay.mockImplementationOnce(async (_p, _a, _u, _destinations, _submitted, verify, sending) => {
      await verify(); sending(); throw new Error('Wallet response lost')
    })
    await expect(run()).rejects.toThrow('Wallet response lost')
    const saved = loadLaunchSession()!
    saved.relayr!.paymentChainId = paymentChainId
    saveLaunchSession(saved)
    await expect(run()).rejects.toThrow('saved payment chain')
    expect(m.funding).toHaveBeenCalledTimes(1)
    expect(m.pay).toHaveBeenCalledTimes(1)
  })

  it('preserves a corrupt launch record and refuses new authorizations', async () => {
    storage.set(FUND_LAUNCH_KEY, '{not json')
    await expect(run()).rejects.toThrow('Saved launch authorizations could not be read')
    expect(storage.get(FUND_LAUNCH_KEY)).toBe('{not json')
    expect(m.forward).not.toHaveBeenCalled()
    expect(m.pay).not.toHaveBeenCalled()
  })



  it('signs one exact call per chain, pays only on the selected chain, and verifies reversed provider records onchain', async () => {
    m.poll.mockImplementation(async (_uuid, _count, update) => { update([...records].reverse()); return [...records].reverse() })
    await run()
    expect(m.forward).toHaveBeenCalledTimes(2)
    expect(m.forward.mock.calls.every(([call]) => call.gas === 4_000_000n && call.value === 17n)).toBe(true)
    expect(m.pay).toHaveBeenCalledTimes(1)
    expect(m.pay.mock.calls[0][0].chain).toBe(8453)
    expect(clients.get(1)!.estimateGas.mock.calls[0][0]).toMatchObject({ account: ACCOUNT,
      stateOverride: [{ address: ACCOUNT, balance: 100n * 10n ** 18n + 17n }] })
    expect(loadLaunchSession()?.statuses).toMatchObject({ 1: { phase: 'confirmed', projectId: '101' }, 10: { phase: 'confirmed', projectId: '110' } })
    expect(loadLaunchSession()?.relayr?.paymentHash).toBe(HASH)
  })

  it('launches all four Sepolia destinations with one payment and recovers without another authorization or charge', async () => {
    storage.clear()
    saveLaunchSession(session(TESTNETS, 84532))
    m.funding.mockResolvedValue(84532)
    offeredPaymentChains = [84532, 11155111]
    m.poll.mockImplementationOnce(async () => { records = []; throw new Error('offline') })
    await expect(run()).rejects.toThrow('unfinished')
    const saved = loadLaunchSession()!
    expect(saved.transport).toBe('relayr')
    expect(saved.relayr).toMatchObject({ paymentChainId: 84532, paymentHash: HASH })
    expect(saved.relayr?.signed.map(item => item.chainId)).toEqual(TESTNETS)
    records = entries.map((entry, i) => ({ tx_uuid: `tx-${i}`, status: { data: { hash: hashFor(entry.chain) } } })).reverse()
    await run(saved)
    expect(m.forward).toHaveBeenCalledTimes(4)
    expect(m.quote).toHaveBeenCalledTimes(1)
    expect(m.pay).toHaveBeenCalledTimes(1)
    expect(m.pay.mock.calls[0][0].chain).toBe(84532)
    for (const chain of TESTNETS) {
      expect(loadLaunchSession()?.statuses[chain]).toMatchObject({ phase: 'confirmed', projectId: String(chain + 100) })
      expect(entries.find(entry => entry.chain === chain)?.target).toBe(jbContractAddress['6'][JBCoreContracts.ERC2771Forwarder][chain as JBChainId])
    }
  })

  it('reuses an unpaid testnet quote only on an explicitly chosen offered testnet chain', async () => {
    storage.clear()
    saveLaunchSession(session(TESTNETS, 421614))
    offeredPaymentChains = [84532, 11155111]
    m.funding.mockRejectedValueOnce(new Error('Funding selection cancelled'))
    await expect(run()).rejects.toThrow('cancelled')
    expect(m.pay).not.toHaveBeenCalled()
    expect(loadLaunchSession()?.paymentChainId).toBeUndefined()
    expect(loadLaunchSession()?.relayr?.paymentChainId).toBeUndefined()
    expect(m.funding.mock.calls[0][0].map((option: { chainId: number }) => option.chainId)).toEqual([84532, 11155111])
    m.funding.mockResolvedValue(11155111)
    await run()
    expect(m.forward).toHaveBeenCalledTimes(4)
    expect(m.quote).toHaveBeenCalledTimes(1)
    expect(m.pay).toHaveBeenCalledTimes(1)
    expect(m.pay.mock.calls[0][0].chain).toBe(11155111)
  })

  it('does not reuse the old preselected funding chain; an unpaid quote requires a new explicit choice', async () => {
    m.funding.mockRejectedValueOnce(new Error('Funding selection cancelled'))
    await expect(run()).rejects.toThrow('cancelled')
    expect(m.pay).not.toHaveBeenCalled()
    m.funding.mockResolvedValue(1)
    await run()
    expect(m.forward).toHaveBeenCalledTimes(2)
    expect(m.quote).toHaveBeenCalledTimes(1)
    expect(m.pay.mock.calls[0][0].chain).toBe(1)
    expect(m.funding).toHaveBeenCalledTimes(2)
  })

  it('recovers a submitted bundle without fresh signatures, quote, or payment', async () => {
    m.poll.mockImplementationOnce(async () => { records = []; throw new Error('offline') })
    await expect(run()).rejects.toThrow('unfinished')
    records = entries.map((entry, i) => ({ tx_uuid: `tx-${i}`, status: { data: { hash: hashFor(entry.chain) } } }))
    m.pending.mockImplementation(() => { throw new Error('An unrelated authorization ledger is unreadable') })
    await run()
    expect(m.forward).toHaveBeenCalledTimes(2)
    expect(m.quote).toHaveBeenCalledTimes(1)
    expect(m.pay).toHaveBeenCalledTimes(1)
    expect(m.funding).toHaveBeenCalledTimes(1)
  })

  it('never treats provider-only success or failure as a completed launch or permission to pay again', async () => {
    m.poll.mockImplementation(async (_uuid, _count, update) => {
      update([{ tx_uuid: 'tx-0', status: { state: 'Confirmed' } }, { tx_uuid: 'tx-1', status: { state: 'Failed' } }])
      throw new Error('provider claims failed')
    })
    await expect(run()).rejects.toThrow('unfinished')
    await expect(run()).rejects.toThrow('unresolved')
    expect(m.pay).toHaveBeenCalledTimes(1)
    expect(loadLaunchSession()?.relayr?.abandonable).not.toBe(true)
  })

  it('rejects a provider hash pointing to another chain even if that receipt has a launch log', async () => {
    m.poll.mockImplementation(async (_uuid, _count, update) => {
      const swapped = records.map(record => ({ ...record, status: { data: { hash: hashFor(1) } } }))
      update(swapped); return swapped
    })
    await expect(run()).rejects.toThrow('unfinished')
    expect(loadLaunchSession()?.statuses[10].phase).toBe('unresolved')
    expect(m.projectId).toHaveBeenCalledTimes(1)
  })

  it('rejects a receipt whose block is no longer canonical', async () => {
    clients.get(10)!.getBlock.mockResolvedValue({ number: 123n, hash: HASH, timestamp: BigInt(NOW) })
    await expect(run()).rejects.toThrow('unfinished')
    expect(loadLaunchSession()?.statuses[10].phase).toBe('unresolved')
  })

  it('keeps successful chains and retries a proven revert using the original forwarder nonce', async () => {
    failed.add(10)
    await expect(run()).rejects.toThrow('unfinished')
    expect(loadLaunchSession()?.relayr?.retryNonces).toEqual({ 10: '0' })
    failed.clear()
    await run()
    expect(m.forward).toHaveBeenCalledTimes(3)
    expect(m.forward.mock.calls[2][0].chainId).toBe(10)
    expect(m.forward.mock.calls[2][2]).toBe(0n)
    expect(loadLaunchSession()?.statuses[1].projectId).toBe('101')
  })

  it('refuses a retry if the prior authorization nonce was consumed between attempts', async () => {
    failed.add(10)
    await expect(run()).rejects.toThrow('unfinished')
    clients.get(10)!.readContract.mockImplementation(async ({ functionName }) => functionName === 'nonces' ? 1n : true)
    await expect(run()).rejects.toThrow('earlier launch authorization')
    expect(m.pay).toHaveBeenCalledTimes(1)
  })

  it.each([
    { chains: [1, 10], funding: 8453, alternative: 1 },
    { chains: TESTNETS, funding: 84532, alternative: 11155111 },
  ])('journals ambiguous funding on $funding and never changes chain or repays', async ({ chains, funding, alternative }) => {
    storage.clear()
    saveLaunchSession(session(chains, funding))
    offeredPaymentChains = [funding, alternative]
    m.funding.mockResolvedValue(funding)
    m.pay.mockImplementation(async (_p, _a, _u, _destinationChainIds, _submitted, verify, sending) => {
      await verify(); sending(); throw new Error('wallet disconnected after broadcasting')
    })
    await expect(run()).rejects.toThrow('wallet disconnected')
    m.poll.mockImplementation(async () => { throw new Error('offline') })
    expect(loadLaunchSession()?.relayr?.phase).toBe('payment-signing')
    await expect(run()).rejects.toThrow('unresolved')
    expect(m.pay).toHaveBeenCalledTimes(1)
    m.funding.mockResolvedValue(alternative)
    await expect(run()).rejects.toThrow('unresolved')
    expect(m.funding).toHaveBeenCalledTimes(1)
    expect(loadLaunchSession()?.relayr?.paymentChainId).toBe(funding)
  })

  it('allows retrying a positively rejected funding prompt', async () => {
    m.pay.mockImplementationOnce(async (_p, _a, _u, _destinationChainIds, _submitted, verify, sending) => {
      await verify(); sending(); throw Object.assign(new Error('Rejected'), { code: 4001 })
    })
    await expect(run()).rejects.toThrow('Rejected')
    expect(loadLaunchSession()?.relayr?.phase).toBe('quoted')
    expect(loadLaunchSession()?.relayr?.paymentChainId).toBeUndefined()
    expect(loadLaunchSession()?.paymentChainId).toBeUndefined()
    await run()
    expect(m.forward).toHaveBeenCalledTimes(2)
    expect(m.funding).toHaveBeenCalledTimes(2)
  })

  it('accepts supported network families and blocks Safe wallets, mixed chains, direct sessions, and changed accounts', async () => {
    m.safe = true
    await expect(run()).rejects.toThrow('ordinary wallet')
    m.safe = false
    expect(canRelayrLaunch({ ...session(), input: { ...session().input, chainIds: [1] } })).toBe(false)
    expect(canRelayrLaunch(session(TESTNETS, 84532))).toBe(true)
    for (const chains of [[1, 84532], [11155111, 8453], [1, 1], [11155111, 11155111], [1, 137]]) {
      expect(canRelayrLaunch({ ...session(), input: { ...session().input, chainIds: chains } })).toBe(false)
    }
    expect(canRelayrLaunch({ ...session(TESTNETS, 84532), transport: 'direct' })).toBe(false)
    expect(canRelayrLaunch({ ...session(TESTNETS, 84532), transport: undefined })).toBe(false)
    m.account = TARGET
    await expect(run()).rejects.toThrow('originally signed')
    expect(m.forward).not.toHaveBeenCalled()
  })



  it('holds a shared cross-tab lock and refuses to execute without it', async () => {
    const request = vi.fn(async (_name, _options, fn) => fn(null))
    vi.stubGlobal('navigator', { locks: { request } })
    await expect(run()).rejects.toThrow('another tab')
    expect(request.mock.calls[0][0]).toBe('homerun:fund-launch')
    expect(m.forward).not.toHaveBeenCalled()
  })

  it('simulates exact signed forwarder execution and refuses funding when launch prerequisites now revert', async () => {
    clients.get(10)!.call.mockRejectedValue(new Error('launch prerequisites changed'))
    await expect(run()).rejects.toThrow('launch prerequisites changed')
    expect(m.forward).toHaveBeenCalledTimes(2)
    expect(m.quote).not.toHaveBeenCalled()
    expect(m.pay).not.toHaveBeenCalled()
  })

  it('refreshes changed creation fees with the same nonce before any funding', async () => {
    m.fee.mockResolvedValueOnce(17n).mockResolvedValueOnce(17n).mockResolvedValue(18n)
    await expect(run()).rejects.toThrow('creation fee changed')
    expect(m.pay).not.toHaveBeenCalled()
    expect(loadLaunchSession()?.relayr?.retryNonces).toEqual({ 1: '0', 10: '0' })
    await run()
    expect(m.forward.mock.calls.slice(2).every(([call, _account, nonce]) => call.value === 18n && nonce === 0n)).toBe(true)
    expect(m.pay).toHaveBeenCalledTimes(1)
  })





  it('retains independently observed destination hashes when a later provider response omits them', async () => {
    clients.get(10)!.getTransactionReceipt.mockRejectedValueOnce(new Error('receipt unavailable'))
    await expect(run()).rejects.toThrow('unfinished')
    expect(loadLaunchSession()?.statuses[10].hash).toBe(hashFor(10))
    m.poll.mockImplementation(async (_uuid, _count, update) => { update([]); throw new Error('provider lost records') })
    await run()
    expect(loadLaunchSession()?.statuses[10].phase).toBe('confirmed')
    expect(m.pay).toHaveBeenCalledTimes(1)
  })


})


describe('Relayr quote authentication', () => {
  it('accepts the exact bundle payment and rejects altered quote fields', () => {
    const payment = paymentFor(1)
    expect(relayrPaymentDetails(payment, BUNDLE, NOW).chainId).toBe(1)
    for (const change of [
      { target: TARGET }, { token: TARGET }, { chain: 99999 }, { amount: '-1' },
      { calldata: '0xdeadbeef' }, { payment_deadline: NOW + 5 },
    ]) expect(() => relayrPaymentDetails({ ...payment, ...change }, BUNDLE, NOW)).toThrow()
    expect(() => relayrPaymentDetails(payment, '00000000-0000-0000-0000-000000000002', NOW)).toThrow(/bundle/)
    expect(() => relayrPaymentDetails(payment, BUNDLE, NOW + 601)).toThrow()
  })
})


it('allows delegated EOA signatures while still rejecting contract wallets', async () => {
  clients.get(1)!.getCode.mockImplementation(async ({ address }) => address === ACCOUNT ? `0xef0100${'11'.repeat(20)}` : '0x6000')
  await run()
  expect(m.pay).toHaveBeenCalledTimes(1)
})

it('rejects arbitrary contract wallet code before requesting signatures', async () => {
  clients.get(1)!.getCode.mockResolvedValue('0x6000')
  await expect(run()).rejects.toThrow(/contract wallet/)
  expect(m.forward).not.toHaveBeenCalled()
})


it('cancels a closed pre-signature review but preserves published authorizations', async () => {
  const draft = session()
  draft.statuses[1] = { phase: 'signing' }
  draft.relayr = { account: ACCOUNT, phase: 'signing', signed: [], records: [] }
  saveLaunchSession(draft)
  expect(canCancelLaunch(draft)).toBe(true)
  await cancelUnsubmittedLaunch(draft.input.salt)
  expect(loadLaunchSession()).toBeNull()
  draft.relayr.published = true
  saveLaunchSession(draft)
  expect(canCancelLaunch(draft)).toBe(false)
  await expect(cancelUnsubmittedLaunch(draft.input.salt)).rejects.toThrow(/already be submitted/)
  expect(loadLaunchSession()).not.toBeNull()
})
