import { beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('@bananapus/nana-sdk-core', async importOriginal => (await import('./fixtures/homerun-deployer')).withHomerunDeployer(await importOriginal()))

import { HttpRequestError, encodeFunctionResult, toHex, encodeFunctionData, type Address, type Hex } from 'viem'
import { erc2771ForwarderAbi, JBCoreContracts, jbContractAddress, type JBChainId } from '@bananapus/nana-sdk-core'
import type { RelayrEntry, RelayrPayment, RelayrQuote, RelayrTransactionRecord } from '@/lib/relayr'

const m = vi.hoisted(() => ({
  account: '0x1111111111111111111111111111111111111111' as Address,
  chainId: undefined as number | undefined,
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
  multisigCheck: vi.fn(),
}))
vi.mock('@/lib/create-multisig', async original => ({ ...await original<typeof import('@/lib/create-multisig')>(), checkCreateMultisigs: m.multisigCheck }))
vi.mock('@wagmi/core', () => ({ getAccount: () => ({ address: m.account, chainId: m.chainId }) }))
vi.mock('@/providers/Providers', () => ({ wagmiConfig: {},
  SUPPORTED_CHAINS: [1, 10, 8453, 42161, 11155111, 11155420, 84532, 421614].map(id => ({ id, name: `Chain ${id}` })),
}))
vi.mock('@/lib/transaction-review', async importOriginal => ({
  ...await importOriginal<typeof import('@/lib/transaction-review')>(), requireFundingChainSelection: m.funding, requireTransactionReview: m.review,
}))
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
  readRelayrPendingSessionsForAuthorization: () => {
    const session = m.pending()
    return session ? [{ scope: 'another-action', session }] : []
  },
}))

import { relayrDestinationHash, relayrHeldMessage, relayrPaymentDetails, relayrPaymentLabel, RelayrPaymentSubmittedError, RELAYR_PAYMENT_ADDRESS, RELAYR_NATIVE_TOKEN, RELAYR_PAYMENT_SELECTOR } from '@/lib/relayr'
import { predictMultisig, MULTICALL3, CREATE_BATCH_ABI, unbundleMultisigLaunch, type CreateMultisig } from '@/lib/create-multisig'
import { canRelayrLaunch, launchRequestsDead, runRelayrLaunch } from '@/lib/fund-launch-relayr'
import { FUND_LAUNCH_KEY, canCancelLaunch, cancelUnsubmittedLaunch, loadLaunchSession, saveLaunch as saveLaunchSession, type FundLaunchSession as LaunchSession } from '@/lib/fund-launch-session'

const ACCOUNT = '0x1111111111111111111111111111111111111111' as Address
const TARGET = '0x2222222222222222222222222222222222222222' as Address
const HASH = `0x${'aa'.repeat(32)}` as Hex
const BLOCK = `0x${'bb'.repeat(32)}` as Hex
const NOW = 1_900_000_000
const BUNDLE = '00000000-0000-0000-0000-000000000001'
const TESTNETS = [11155111, 11155420, 84532, 421614]
const MAY_HAVE_RUN = 'This launch\'s earlier signature may already have run. Check the project, then cancel creation to start over.'
const CHANGED = 'The launch changed since this review. Cancel creation to start over.'
const UNCHECKED = 'Couldn\'t check the launch. Try again.'
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
const txId = (index: number) => `00000000-0000-4000-8000-${(index + 1).toString().padStart(12, '0')}`
const TX_ELSEWHERE = txId(254)
/** A status record as Relayr lists it: the posted request echoed back, with U256 values in hex. */
function recordFor(entry: RelayrEntry, index: number, status?: RelayrTransactionRecord['status']): RelayrTransactionRecord {
  return { tx_uuid: txId(index), request: { ...entry, value: `0x${BigInt(entry.value).toString(16)}`, virtual_nonce: 0 }, status }
}
/** What Relayr's status lists on every poll from now on: the records of the launch, changed. */
function listing(change: (list: RelayrTransactionRecord[]) => RelayrTransactionRecord[]) {
  m.poll.mockImplementation(async (_uuid, _count, update) => { const changed = change(records); update(changed); return changed })
}
/** The records of `chain`, reporting `hash` for it. */
const reporting = (chain: number, hash: unknown) => (list: RelayrTransactionRecord[]) => list.map(record =>
  record.request?.chain === chain ? { ...record, status: { data: { hash } } as RelayrTransactionRecord['status'] } : record)
function makeClient(chainId: number) {
  return {
    getCode: vi.fn(async ({ address }: { address: Address }): Promise<Hex> => address === ACCOUNT ? '0x' : '0x6000'),
    readContract: vi.fn(async ({ functionName }: { functionName: string }): Promise<bigint | boolean> => functionName === 'nonces' ? 0n : true),
    estimateGas: vi.fn(async (_request: unknown) => 2_000_000n),
    call: vi.fn(async () => ({ data: '0x' })),
    getBlock: vi.fn(async () => ({ number: 123n, hash: BLOCK, timestamp: BigInt(NOW) })),
    // A node looks a hash up in any case and answers in lowercase.
    getTransaction: vi.fn(async ({ hash }: { hash: Hex }) => {
      const entry = entries.find(item => hashFor(item.chain) === hash.toLowerCase())
      if (!entry) throw new Error('Transaction not found')
      return { hash: hash.toLowerCase() as Hex, to: entry.target, input: entry.data, value: BigInt(entry.value), chainId: entry.chain, blockHash: BLOCK }
    }),
    getTransactionReceipt: vi.fn(async ({ hash }: { hash: Hex }) => ({
      transactionHash: hash.toLowerCase() as Hex, blockHash: BLOCK, blockNumber: 123n, status: failed.has(chainId) ? 'reverted' : 'success', logs: [],
    })),
  }
}

function session(chains = [1, 10], paymentChainId = 8453): LaunchSession {
  return { version: 1, name: 'Asset',
    input: { owner: TARGET, sender: ACCOUNT, chainIds: chains, projectUri: 'ipfs://launch', tokenName: 'House FUND', ticker: 'HOUSE', salt: `0x${'cc'.repeat(32)}`, mustStartAtOrAfter: NOW, creationFees: Object.fromEntries(chains.map(chain => [chain, 17n])) },
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
  m.chainId = undefined
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
        args: [{ from: account, to: call.target, value: call.value, gas: call.gas, deadline: Math.floor(Date.now() / 1000) + 3600,
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
      payment_info: offeredPaymentChains.map(chain => paymentFor(chain, Math.floor(Date.now() / 1000) + 600)),
      expectedTransactions: signed.map((entry, i) => ({ txUuid: txId(i), chain: entry.chain, entry: { ...entry, virtual_nonce: 0 } })) }
    records = signed.map((entry, i) => recordFor(entry, i, { state: 'Confirmed', data: { hash: hashFor(entry.chain) } }))
    return quote
  })
  m.pay.mockImplementation(async (_payment, _account, _uuid, destinationChainIds, { onSubmitted: submitted, reverify, onSending: sending }) => {
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
  it('creates a single-chain owner Safe and project in one destination transaction and one payment', async () => {
    storage.clear()
    const value = session([1])
    const policy = { owners: [ACCOUNT, TARGET], threshold: 2, saltNonce: value.input.salt, proxyCreationCode: '0x6000' as Hex }
    const plan: CreateMultisig = { ...policy, role: 'owner', address: predictMultisig(policy) }
    value.input = { ...value.input, owner: plan.address, operator: plan.address, multisigs: [plan] }
    saveLaunchSession(value)
    clients.get(1)!.call.mockResolvedValue({ data: encodeFunctionResult({ abi: CREATE_BATCH_ABI, functionName: 'aggregate3Value', result: [{ success: true, returnData: toHex(BigInt(plan.address), { size: 32 }) }, { success: true, returnData: '0x' }] }) })
    expect(canRelayrLaunch(value)).toBe(true)
    await run(value)
    expect(m.forward).toHaveBeenCalledTimes(1)
    expect(m.pay).toHaveBeenCalledTimes(1)
    expect(entries).toHaveLength(1)
    expect(entries[0].target).toBe(MULTICALL3)
    expect(unbundleMultisigLaunch(entries[0], [plan]).target).toBe(jbContractAddress['6'][JBCoreContracts.ERC2771Forwarder][1])
    expect(m.multisigCheck).toHaveBeenCalled()
    expect(loadLaunchSession()?.statuses[1].phase).toBe('confirmed')
    const nonceReads = clients.get(1)!.readContract.mock.calls.map(([call]) => call).filter(call => call.functionName === 'nonces')
    expect(nonceReads.every(call => (call as unknown as { address: Address }).address !== MULTICALL3)).toBe(true)
    await run()
    expect(m.pay).toHaveBeenCalledTimes(1)
  })

  it('bundles separate Owner and Operator Safes on each chain with one funding payment', async () => {
    storage.clear()
    const value = session([1, 10])
    const policy = { owners: [ACCOUNT, TARGET], threshold: 2, saltNonce: value.input.salt, proxyCreationCode: '0x6000' as Hex }
    const owner: CreateMultisig = { ...policy, role: 'owner', address: predictMultisig(policy) }
    const operator: CreateMultisig = { ...policy, threshold: 1, role: 'operator', address: predictMultisig({ ...policy, threshold: 1 }) }
    value.input = { ...value.input, owner: owner.address, operator: operator.address, multisigs: [owner, operator] }
    saveLaunchSession(value)
    const result = [owner, operator].map(plan => ({ success: true, returnData: toHex(BigInt(plan.address), { size: 32 }) }))
    for (const chainId of [1, 10]) clients.get(chainId)!.call.mockResolvedValue({ data: encodeFunctionResult({
      abi: CREATE_BATCH_ABI, functionName: 'aggregate3Value', result: [...result, { success: true, returnData: '0x' }],
    }) })
    await run(value)
    expect(m.forward).toHaveBeenCalledTimes(2)
    expect(m.pay).toHaveBeenCalledTimes(1)
    expect(entries.map(entry => entry.chain)).toEqual([1, 10])
    for (const entry of entries) {
      expect(entry.target).toBe(MULTICALL3)
      expect(unbundleMultisigLaunch(entry, [owner, operator]).target).toBe(jbContractAddress['6'][JBCoreContracts.ERC2771Forwarder][entry.chain as JBChainId])
      expect(loadLaunchSession()?.statuses[entry.chain].phase).toBe('confirmed')
    }
    await run()
    expect(m.pay).toHaveBeenCalledTimes(1)
  })

  it('stops before authorizing or paying when a multisig prerequisite cannot be verified', async () => {
    m.multisigCheck.mockRejectedValueOnce(new Error('Safe creation code changed'))
    await expect(run()).rejects.toThrow('Safe creation code changed')
    expect(m.forward).not.toHaveBeenCalled()
    expect(m.pay).not.toHaveBeenCalled()
  })

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
    expect(m.funding).toHaveBeenCalledExactlyOnceWith([{ chainId: 11155111, label: expect.stringContaining('Sepolia') }], undefined)
    expect(m.pay.mock.calls[0][0].chain).toBe(11155111)
    expect(loadLaunchSession()?.relayr?.paymentChainId).toBe(11155111)
  })

  it('prefers the chain the wallet started on, not the destination signing left it on', async () => {
    m.chainId = 8453
    const prepare = m.forward.getMockImplementation()!
    m.forward.mockImplementation(async (call, account, nonce) => {
      const prepared = await prepare(call, account, nonce)
      return { ...prepared, sign: async () => { m.chainId = call.chainId; return prepared.sign() } }
    })
    await run()
    expect(m.chainId).toBe(10)
    expect(m.funding).toHaveBeenCalledExactlyOnceWith([
      { chainId: 8453, label: relayrPaymentLabel(paymentFor(8453)) },
      { chainId: 1, label: relayrPaymentLabel(paymentFor(1)) },
    ], 8453)
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
    m.pay.mockImplementationOnce(async (_p, _a, _u, _destinations, { reverify: verify, onSending: sending }) => {
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
    records = entries.map((entry, i) => recordFor(entry, i, { data: { hash: hashFor(entry.chain) } })).reverse()
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
    records = entries.map((entry, i) => recordFor(entry, i, { data: { hash: hashFor(entry.chain) } }))
    m.pending.mockImplementation(() => { throw new Error('An unrelated authorization ledger is unreadable') })
    await run()
    expect(m.forward).toHaveBeenCalledTimes(2)
    expect(m.quote).toHaveBeenCalledTimes(1)
    expect(m.pay).toHaveBeenCalledTimes(1)
    expect(m.funding).toHaveBeenCalledTimes(1)
  })

  it('launches against a Relayr that lists transaction IDs out of request order', async () => {
    const actual = await vi.importActual<typeof import('@/lib/relayr')>('@/lib/relayr')
    const id = txId
    let posted: RelayrEntry[] = []
    let paid = false
    const listed = () => posted.map((_, index) => posted.length - 1 - index)
    const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/v1/bundle/prepaid')) {
        posted = JSON.parse(String(init?.body)).transactions
        return json({ bundle_uuid: BUNDLE, payment_info: offeredPaymentChains.map(chain => paymentFor(chain)), tx_uuids: listed().map(id) })
      }
      if (url.endsWith(`/v1/bundle/${BUNDLE}`)) {
        return json({ bundle_uuid: BUNDLE, transactions: listed().map(index => ({ tx_uuid: id(index),
          request: { ...posted[index], value: `0x${BigInt(posted[index].value).toString(16)}` },
          status: paid ? { state: 'success', data: { hash: hashFor(posted[index].chain) } } : null })) })
      }
      throw new Error(`Unexpected Relayr request: ${url}`)
    }))
    m.quote.mockImplementation(async (signed: RelayrEntry[]) => { entries = signed; return actual.relayrPostBundle(signed) })
    m.poll.mockImplementation(actual.relayrPoll)
    const pay = m.pay.getMockImplementation()!
    m.pay.mockImplementation(async (...args: unknown[]) => { paid = true; return pay(...args) })
    await run()
    expect(loadLaunchSession()?.statuses).toMatchObject({ 1: { phase: 'confirmed', hash: hashFor(1), projectId: '101' }, 10: { phase: 'confirmed', hash: hashFor(10), projectId: '110' } })
    expect(loadLaunchSession()?.relayr?.quote?.expectedTransactions?.map(({ chain, txUuid }) => [chain, txUuid])).toEqual([[1, id(0)], [10, id(1)]])
    expect(m.pay).toHaveBeenCalledTimes(1)
  })

  describe('a launch saved with each chain holding the other chain\'s transaction ID', () => {
    async function savedPaidAndUnresolved() {
      m.poll.mockImplementationOnce(async () => { records = []; throw new Error('offline') })
      await expect(run()).rejects.toThrow('unfinished')
      const saved = loadLaunchSession()!
      const [first, second] = saved.relayr!.quote!.expectedTransactions!
      saved.relayr!.quote!.expectedTransactions = [{ ...first, txUuid: second.txUuid }, { ...second, txUuid: first.txUuid }]
      saveLaunchSession(saved)
      records = entries.map((entry, i) => recordFor(entry, i, { state: 'success', data: { hash: hashFor(entry.chain) } })).reverse()
      return saved
    }
    const confirmed = { 1: { phase: 'confirmed', hash: hashFor(1), projectId: '101' }, 10: { phase: 'confirmed', hash: hashFor(10), projectId: '110' } }

    it('confirms each chain from the record that carries its call, without paying or signing again', async () => {
      const saved = await savedPaidAndUnresolved()
      await run(saved)
      expect(loadLaunchSession()?.statuses).toMatchObject(confirmed)
      expect(m.forward).toHaveBeenCalledTimes(2)
      expect(m.quote).toHaveBeenCalledTimes(1)
      expect(m.pay).toHaveBeenCalledTimes(1)
    })

    it('replaces the other chain\'s hash that was saved while it stayed unresolved', async () => {
      const saved = await savedPaidAndUnresolved()
      saved.statuses[1] = { phase: 'unresolved', hash: hashFor(10), error: 'Relayr destination transaction does not match the signed launch.' }
      saved.statuses[10] = { phase: 'unresolved', hash: hashFor(1), error: 'Relayr destination transaction does not match the signed launch.' }
      saveLaunchSession(saved)
      await run(saved)
      expect(loadLaunchSession()?.statuses).toMatchObject(confirmed)
      expect(m.pay).toHaveBeenCalledTimes(1)
    })
  })

  describe('Relayr\'s status', () => {
    const NOT_IDENTIFIED = 'Relayr has not identified every exact destination transaction. Keep checking the original bundle; do not pay again.'
    const UNBOUND = "Relayr's status names a transaction this quote did not bind. Keep the original bundle pending; do not pay again."
    const MISMATCHED = "Relayr's destination call does not match the signed request. Keep the original bundle pending; do not pay again."
    const SHARED = 'Relayr reported one destination transaction for two signed calls. Keep the original bundle pending; do not pay again.'

    it.each([
      ['lists a record too few', (list: RelayrTransactionRecord[]) => list.slice(1), NOT_IDENTIFIED],
      ['lists no records', () => [] as RelayrTransactionRecord[], NOT_IDENTIFIED],
      ['lists an extra record with an ID the quote never listed', (list: RelayrTransactionRecord[]) => [...list, { ...list[0], tx_uuid: TX_ELSEWHERE }], NOT_IDENTIFIED],
      ['lists an extra record under a quoted ID', (list: RelayrTransactionRecord[]) => [...list, { ...list[0] }], NOT_IDENTIFIED],
      ['names an ID the quote never listed', (list: RelayrTransactionRecord[]) => [list[0], { ...list[1], tx_uuid: TX_ELSEWHERE }], UNBOUND],
      ['carries one quoted ID on two records', (list: RelayrTransactionRecord[]) => [list[0], { ...list[1], tx_uuid: list[0].tx_uuid }], UNBOUND],
      ['carries an ID that is not a UUID', (list: RelayrTransactionRecord[]) => [{ ...list[0], tx_uuid: 'tx-0' }, list[1]], UNBOUND],
      ['echoes another call than the one signed', (list: RelayrTransactionRecord[]) => [list[0], { ...list[1], request: { ...list[1].request!, data: '0xdeadbeef' as Hex } }], MISMATCHED],
      ['echoes one call under two quoted IDs', (list: RelayrTransactionRecord[]) => [list[0], { ...list[1], request: list[0].request }], MISMATCHED],
      ['reports one hash for both calls', (list: RelayrTransactionRecord[]) => list.map(record => ({ ...record, status: { data: { hash: hashFor(1) } } })), SHARED],
    ])('gives no hash when it %s, and says why', async (_name, change, refusal) => {
      listing(change)
      await expect(run()).rejects.toThrow('unfinished')
      for (const chain of [1, 10]) {
        expect(loadLaunchSession()?.statuses[chain]).toMatchObject({ phase: 'unresolved', error: refusal })
        expect(loadLaunchSession()?.statuses[chain].hash).toBeUndefined()
        expect(clients.get(chain)!.getTransaction).not.toHaveBeenCalled()
      }
      expect(m.projectId).not.toHaveBeenCalled()
      expect(m.pay).toHaveBeenCalledTimes(1)
    })

    it('confirms both chains once its records are exactly the quote\'s again', async () => {
      listing(list => list.slice(1))
      await expect(run()).rejects.toThrow('unfinished')
      listing(list => list)
      await run()
      expect(loadLaunchSession()?.statuses).toMatchObject({ 1: { phase: 'confirmed', projectId: '101' }, 10: { phase: 'confirmed', projectId: '110' } })
      expect(m.pay).toHaveBeenCalledTimes(1)
    })

    it('still takes a hash a chain saved earlier, however the status reads', async () => {
      clients.get(10)!.getTransactionReceipt.mockRejectedValueOnce(new Error('receipt unavailable'))
      await expect(run()).rejects.toThrow('unfinished')
      listing(list => [...list, { ...list[0], tx_uuid: TX_ELSEWHERE }])
      await run()
      expect(loadLaunchSession()?.statuses[10]).toMatchObject({ phase: 'confirmed', hash: hashFor(10), projectId: '110' })
    })

    it('waits on a record that reports no hash yet while the other chain confirms', async () => {
      listing(list => list.map(record => record.request?.chain === 10 ? { ...record, status: { state: 'Pending' } } : record))
      await expect(run()).rejects.toThrow('unfinished')
      expect(loadLaunchSession()?.statuses[1]).toMatchObject({ phase: 'confirmed', projectId: '101' })
      expect(loadLaunchSession()?.statuses[10]).toMatchObject({ phase: 'unresolved', error: 'Waiting for the original Relayr destination transaction.' })
    })
  })

  describe('a hash that Relayr reports', () => {
    const malformed = ['', '0xnot-a-hash', `0x${'ab'.repeat(31)}`, `0x${'ab'.repeat(33)}`, 7]

    it.each(malformed)('is never kept or preferred when it is not a transaction hash (%j)', async hash => {
      // The real relayrDestinationHash is in play; a stand-in would hand the malformed value through.
      expect(relayrDestinationHash({ status: { data: { hash } } } as unknown as RelayrTransactionRecord)).toBeNull()
      clients.get(10)!.getTransactionReceipt.mockRejectedValueOnce(new Error('receipt unavailable'))
      await expect(run()).rejects.toThrow('unfinished')
      expect(loadLaunchSession()?.statuses[10]).toMatchObject({ phase: 'unresolved', hash: hashFor(10) })
      listing(reporting(10, hash))
      await run()
      expect(loadLaunchSession()?.statuses[10]).toMatchObject({ phase: 'confirmed', hash: hashFor(10), projectId: '110' })
    })

    it.each(malformed)('is not saved the first time Relayr reports it (%j)', async hash => {
      listing(reporting(10, hash))
      await expect(run()).rejects.toThrow('unfinished')
      expect(loadLaunchSession()?.statuses[10].phase).toBe('unresolved')
      expect(loadLaunchSession()?.statuses[10].hash).toBeUndefined()
      expect(clients.get(10)!.getTransaction).not.toHaveBeenCalled()
      await expect(run()).rejects.toThrow('unresolved')
    })

    it('is tried before, and never instead of, the hash the chain saved', async () => {
      const unknown = hashFor(8453)
      clients.get(10)!.getTransactionReceipt.mockRejectedValueOnce(new Error('receipt unavailable'))
      await expect(run()).rejects.toThrow('unfinished')
      expect(loadLaunchSession()?.statuses[10]).toMatchObject({ phase: 'unresolved', hash: hashFor(10) })
      listing(reporting(10, unknown))
      await run()
      expect(loadLaunchSession()?.statuses[10]).toMatchObject({ phase: 'confirmed', hash: hashFor(10), projectId: '110' })
      expect(clients.get(10)!.getTransaction.mock.calls.map(([call]) => call.hash)).toEqual([hashFor(10), unknown, hashFor(10)])
    })

    it('is proven in lowercase when Relayr reports it in uppercase', async () => {
      const upper = `0x${hashFor(10).slice(2).toUpperCase()}` as Hex
      expect(upper).not.toBe(hashFor(10))
      listing(reporting(10, upper))
      await run()
      expect(loadLaunchSession()?.statuses[10]).toMatchObject({ phase: 'confirmed', hash: hashFor(10), projectId: '110' })
    })

    it('is proven in lowercase when the chain saved it in uppercase', async () => {
      const upper = `0x${hashFor(10).slice(2).toUpperCase()}` as Hex
      clients.get(10)!.getTransactionReceipt.mockRejectedValueOnce(new Error('receipt unavailable'))
      await expect(run()).rejects.toThrow('unfinished')
      const saved = loadLaunchSession()!
      saved.statuses[10] = { phase: 'unresolved', hash: upper, error: 'receipt unavailable' }
      saveLaunchSession(saved)
      listing(() => [])
      await run(saved)
      expect(loadLaunchSession()?.statuses[10]).toMatchObject({ phase: 'confirmed', hash: hashFor(10), projectId: '110' })
    })

    it('is tried once when the saved hash differs from it only in case', async () => {
      clients.get(10)!.getTransactionReceipt.mockRejectedValueOnce(new Error('receipt unavailable'))
      await expect(run()).rejects.toThrow('unfinished')
      listing(reporting(10, `0x${hashFor(10).slice(2).toUpperCase()}`))
      clients.get(10)!.getTransaction.mockClear()
      clients.get(10)!.getTransactionReceipt.mockRejectedValueOnce(new Error('receipt unavailable'))
      await expect(run()).rejects.toThrow('unresolved')
      expect(clients.get(10)!.getTransaction).toHaveBeenCalledTimes(1)
    })

    it('stops at the first hash that proves, so the saved hash is never read', async () => {
      clients.get(10)!.getTransactionReceipt.mockRejectedValueOnce(new Error('receipt unavailable'))
      await expect(run()).rejects.toThrow('unfinished')
      const saved = loadLaunchSession()!
      saved.statuses[10] = { phase: 'unresolved', hash: hashFor(8453), error: 'Transaction not found' }
      saveLaunchSession(saved)
      clients.get(10)!.getTransaction.mockClear()
      await run(saved)
      expect(loadLaunchSession()?.statuses[10]).toMatchObject({ phase: 'confirmed', hash: hashFor(10), projectId: '110' })
      expect(clients.get(10)!.getTransaction.mock.calls.map(([call]) => call.hash)).toEqual([hashFor(10)])
    })

    it('is tried once when the chain saved the same hash', async () => {
      clients.get(10)!.getTransactionReceipt.mockRejectedValueOnce(new Error('receipt unavailable'))
      await expect(run()).rejects.toThrow('unfinished')
      clients.get(10)!.getTransaction.mockClear()
      clients.get(10)!.getTransactionReceipt.mockRejectedValueOnce(new Error('receipt unavailable'))
      await expect(run()).rejects.toThrow('unresolved')
      expect(clients.get(10)!.getTransaction).toHaveBeenCalledTimes(1)
      expect(loadLaunchSession()?.statuses[10]).toMatchObject({ phase: 'unresolved', hash: hashFor(10) })
    })

    it('does not replace the saved hash when neither it nor the reported hash can be proven', async () => {
      const unknown = hashFor(8453)
      clients.get(10)!.getTransactionReceipt.mockRejectedValueOnce(new Error('receipt unavailable'))
      await expect(run()).rejects.toThrow('unfinished')
      listing(reporting(10, unknown))
      clients.get(10)!.getTransactionReceipt.mockRejectedValueOnce(new Error('receipt unavailable')).mockRejectedValueOnce(new Error('receipt unavailable'))
      await expect(run()).rejects.toThrow('unresolved')
      // The status says why the hash Relayr reports now could not be proven.
      expect(loadLaunchSession()?.statuses[10]).toMatchObject({ phase: 'unresolved', hash: hashFor(10), error: 'Transaction not found' })
      listing(() => [])
      await run()
      expect(loadLaunchSession()?.statuses[10]).toMatchObject({ phase: 'confirmed', hash: hashFor(10), projectId: '110' })
    })

    it('is the hash a chain saves when it is the first one Relayr reported and could not be proven', async () => {
      listing(reporting(10, hashFor(8453)))
      await expect(run()).rejects.toThrow('unfinished')
      expect(loadLaunchSession()?.statuses[10]).toMatchObject({ phase: 'unresolved', hash: hashFor(8453) })
    })

    it('never moves a confirmed chain off the hash it was verified with', async () => {
      await run()
      listing(list => list.map(record => ({ ...record, status: { data: { hash: hashFor(record.request!.chain === 1 ? 10 : 1) } } })))
      await run()
      expect(loadLaunchSession()?.statuses).toMatchObject({ 1: { phase: 'confirmed', hash: hashFor(1) }, 10: { phase: 'confirmed', hash: hashFor(10) } })
      expect(clients.get(1)!.getTransaction.mock.calls.every(([call]) => call.hash === hashFor(1))).toBe(true)
      expect(clients.get(10)!.getTransaction.mock.calls.every(([call]) => call.hash === hashFor(10))).toBe(true)
    })

    it('is rejected when it points to another chain, even if that receipt has a launch log', async () => {
      listing(list => list.map(record => ({ ...record, status: { data: { hash: hashFor(record.request!.chain === 1 ? 10 : 1) } } })))
      await expect(run()).rejects.toThrow('unfinished')
      expect(loadLaunchSession()?.statuses[1].phase).toBe('unresolved')
      expect(loadLaunchSession()?.statuses[10].phase).toBe('unresolved')
      expect(m.projectId).not.toHaveBeenCalled()
    })
  })

  it('never treats provider-only success or failure as a completed launch or permission to pay again', async () => {
    m.poll.mockImplementation(async (_uuid, _count, update) => {
      update([recordFor(entries[0], 0, { state: 'Confirmed' }), recordFor(entries[1], 1, { state: 'Failed' })])
      throw new Error('provider claims failed')
    })
    await expect(run()).rejects.toThrow('unfinished')
    await expect(run()).rejects.toThrow('unresolved')
    expect(m.pay).toHaveBeenCalledTimes(1)
    expect(loadLaunchSession()?.relayr?.abandonable).not.toBe(true)
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
    expect(loadLaunchSession()?.relayr?.abandonable).not.toBe(true)
    failed.clear()
    await run()
    expect(m.forward).toHaveBeenCalledTimes(3)
    expect(m.forward.mock.calls[2][0].chainId).toBe(10)
    expect(m.forward.mock.calls[2][2]).toBe(0n)
    expect(loadLaunchSession()?.statuses[1].projectId).toBe('101')
  })

  it('refuses a retry if the prior authorization nonce was consumed between attempts, and offers cancelling', async () => {
    failed.add(10)
    await expect(run()).rejects.toThrow('unfinished')
    expect(canCancelLaunch(loadLaunchSession()!)).toBe(false)
    clients.get(10)!.readContract.mockImplementation(async ({ functionName }) => functionName === 'nonces' ? 1n : true)
    await expect(run()).rejects.toThrow(MAY_HAVE_RUN)
    expect(canCancelLaunch(loadLaunchSession()!)).toBe(true)
    expect(m.forward).toHaveBeenCalledTimes(2)
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
    m.pay.mockImplementation(async (_p, _a, _u, _destinationChainIds, { reverify: verify, onSending: sending }) => {
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

  it("hands the launch's signal to its payment, and a payment whose Safe wait it ends stays sent and is never paid again", async () => {
    const page = new AbortController()
    let handed: AbortSignal | undefined
    m.pay.mockImplementationOnce(async (_p, _a, _u, _destinationChainIds, { onSubmitted: submitted, reverify: verify, onSending: sending, signal }) => {
      handed = signal
      await verify(); sending(); submitted(HASH)
      page.abort()
      throw new RelayrPaymentSubmittedError(HASH, 8453)
    })
    await expect(runRelayrLaunch({ session: loadLaunchSession()!, account: m.account, onStatus: vi.fn(), onProgress: vi.fn(), signal: page.signal }))
      .rejects.toThrow('Do not pay again')
    expect(handed).toBe(page.signal)
    expect(loadLaunchSession()?.relayr).toMatchObject({ phase: 'submitted', paymentHash: HASH })
    await run()
    expect(m.pay).toHaveBeenCalledTimes(1)
    expect(m.funding).toHaveBeenCalledTimes(1)
  })

  it('allows retrying a positively rejected funding prompt', async () => {
    m.pay.mockImplementationOnce(async (_p, _a, _u, _destinationChainIds, { reverify: verify, onSending: sending }) => {
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





  describe('what a published launch does next, from the finalized chain', () => {
    /** Every chain's finalized block is at `timestamp`. */
    const finalizedAt = (timestamp: number) => {
      for (const client of clients.values()) client.getBlock.mockResolvedValue({ number: 123n, hash: BLOCK, timestamp: BigInt(timestamp) })
    }
    /** The forwarder expects `nonce` next from the signer on each of `chains`. */
    const noncesAre = (nonce: bigint, chains: number[] = [...clients.keys()]) => {
      for (const chain of chains) clients.get(chain)!.readContract.mockImplementation(async ({ functionName }) => functionName === 'nonces' ? nonce : true)
    }
    /** Signed, quoted and published, and left unpaid at the funding choice. */
    const publishedUnpaid = async () => {
      m.funding.mockRejectedValueOnce(new Error('Funding selection cancelled'))
      await expect(run()).rejects.toThrow('cancelled')
    }
    /** Paid for, with no destination hash anywhere. */
    const paidUnproven = async () => {
      m.poll.mockImplementation(async () => { records = []; throw new Error('provider unavailable') })
      await expect(run()).rejects.toThrow('unfinished')
    }
    /** Past every signed deadline at the finalized block and by the device clock. */
    const pastDeadlines = () => {
      finalizedAt(NOW + 3601)
      vi.mocked(Date.now).mockReturnValue((NOW + 3601) * 1000)
    }

    it('settles a paid launch whose forwarder nonces moved, with no destination hash, as ran: cancelling only, never a retry', async () => {
      await paidUnproven()
      expect(canCancelLaunch(loadLaunchSession()!)).toBe(false)
      finalizedAt(NOW + 3601)
      noncesAre(1n)
      await expect(run()).rejects.toThrow(MAY_HAVE_RUN)
      expect(loadLaunchSession()?.relayr?.abandonable).toBe(true)
      expect(loadLaunchSession()?.statuses).toMatchObject({ 1: { phase: 'unresolved', error: MAY_HAVE_RUN }, 10: { phase: 'unresolved', error: MAY_HAVE_RUN } })
      expect(canCancelLaunch(loadLaunchSession()!)).toBe(true)
      await expect(run()).rejects.toThrow(MAY_HAVE_RUN)
      expect(m.pay).toHaveBeenCalledTimes(1)
      expect(m.quote).toHaveBeenCalledTimes(1)
      expect(m.forward).toHaveBeenCalledTimes(2)
    })

    it('keeps a paid launch held while one chain\'s request moved and another can still run', async () => {
      await paidUnproven()
      noncesAre(1n, [1])
      await expect(run()).rejects.toThrow('unresolved')
      expect(loadLaunchSession()?.relayr?.abandonable).not.toBe(true)
      expect(canCancelLaunch(loadLaunchSession()!)).toBe(false)
      expect(m.pay).toHaveBeenCalledTimes(1)
    })

    it('holds a paid launch while the node cannot answer which of its requests ran', async () => {
      await paidUnproven()
      for (const client of clients.values()) client.getBlock.mockRejectedValue(new Error('node unavailable'))
      await expect(run()).rejects.toThrow('unresolved')
      expect(loadLaunchSession()?.relayr?.abandonable).not.toBe(true)
      expect(loadLaunchSession()?.statuses).toMatchObject({ 1: { phase: 'unresolved' }, 10: { phase: 'unresolved' } })
      expect(m.forward).toHaveBeenCalledTimes(2)
      expect(m.pay).toHaveBeenCalledTimes(1)
    })

    it('signs a paid launch again at its saved nonces once every request expired unused and the recheck passed', async () => {
      await paidUnproven()
      pastDeadlines()
      m.poll.mockImplementation(async (_uuid, _count, update) => { update(records); return records })
      await run()
      expect(m.forward.mock.calls.slice(2).map(([call, _account, nonce]) => [call.chainId, nonce])).toEqual([[1, 0n], [10, 0n]])
      expect(m.pay).toHaveBeenCalledTimes(2)
      expect(loadLaunchSession()?.statuses).toMatchObject({ 1: { phase: 'confirmed' }, 10: { phase: 'confirmed' } })
    })

    it('offers only cancelling, after one line, once every published request is dead and one nonce moved', async () => {
      await publishedUnpaid()
      expect(canCancelLaunch(loadLaunchSession()!)).toBe(false)
      finalizedAt(NOW + 3601)
      // Ethereum's nonce moved: another action used it, or anyone holding the request ran it.
      noncesAre(1n, [1])
      await expect(run()).rejects.toThrow(MAY_HAVE_RUN)
      expect(canCancelLaunch(loadLaunchSession()!)).toBe(true)
      expect(loadLaunchSession()?.statuses).toMatchObject({ 1: { phase: 'unresolved', error: MAY_HAVE_RUN }, 10: { phase: 'authorized' } })
      await expect(run()).rejects.toThrow(MAY_HAVE_RUN)
      expect(m.forward).toHaveBeenCalledTimes(2)
      expect(m.quote).toHaveBeenCalledTimes(1)
      expect(m.pay).not.toHaveBeenCalled()
    })

    it('holds a published launch while another chain\'s request can still run, and says until when', async () => {
      await publishedUnpaid()
      // Ethereum's nonce moved; Optimism's request can run until NOW + 3600.
      noncesAre(1n, [1])
      await expect(run()).rejects.toThrow(relayrHeldMessage(NOW + 3600))
      expect(canCancelLaunch(loadLaunchSession()!)).toBe(false)
      expect(m.forward).toHaveBeenCalledTimes(2)
      expect(m.funding).toHaveBeenCalledTimes(1)
      expect(m.pay).not.toHaveBeenCalled()
    })

    it('holds a published launch whose finalized nonce fell below a saved one, rather than letting it be cancelled', async () => {
      noncesAre(1n)
      const prepare = m.forward.getMockImplementation()!
      m.forward.mockImplementation((call, account) => prepare(call, account, 0n))
      await publishedUnpaid()
      // A reorg dropped an earlier forwarded transaction: the finalized nonce is below the saved one.
      finalizedAt(NOW + 3601)
      noncesAre(0n)
      await expect(run()).rejects.toThrow(relayrHeldMessage(0))
      expect(canCancelLaunch(loadLaunchSession()!)).toBe(false)
      expect(m.pay).not.toHaveBeenCalled()
    })

    it('offers cancelling a published launch once every request expired unused, and signs it again at its saved nonces after the recheck', async () => {
      await publishedUnpaid()
      expect(canCancelLaunch(loadLaunchSession()!)).toBe(false)
      pastDeadlines()
      const estimated = clients.get(10)!.estimateGas.mock.calls.length
      await expect(run()).rejects.toThrow('expired unused')
      expect(clients.get(10)!.estimateGas.mock.calls.length).toBeGreaterThan(estimated)
      expect(canCancelLaunch(loadLaunchSession()!)).toBe(true)
      await run()
      expect(m.forward.mock.calls.slice(2).map(([call, _account, nonce]) => [call.chainId, nonce])).toEqual([[1, 0n], [10, 0n]])
      expect(m.pay).toHaveBeenCalledTimes(1)
      expect(loadLaunchSession()?.statuses).toMatchObject({ 1: { phase: 'confirmed' }, 10: { phase: 'confirmed' } })
    })

    it('does not sign a published launch again when its recheck refuses, and offers cancelling', async () => {
      await publishedUnpaid()
      pastDeadlines()
      clients.get(10)!.estimateGas.mockRejectedValue(new Error('launch prerequisites changed'))
      await expect(run()).rejects.toThrow(CHANGED)
      expect(canCancelLaunch(loadLaunchSession()!)).toBe(true)
      expect(loadLaunchSession()?.relayr).toMatchObject({ phase: 'quoted', signed: [expect.anything(), expect.anything()] })
      expect(loadLaunchSession()?.relayr?.superseded).toBeUndefined()
      await expect(run()).rejects.toThrow(CHANGED)
      expect(m.forward).toHaveBeenCalledTimes(2)
      expect(m.pay).not.toHaveBeenCalled()
    })

    it('holds a published launch whose recheck cannot reach the chain, and decides nothing', async () => {
      await publishedUnpaid()
      pastDeadlines()
      clients.get(10)!.estimateGas.mockRejectedValue(new HttpRequestError({ url: 'https://rpc.example', body: {}, details: 'fetch failed' }))
      await expect(run()).rejects.toThrow(UNCHECKED)
      expect(canCancelLaunch(loadLaunchSession()!)).toBe(false)
      expect(loadLaunchSession()?.relayr?.abandonable).toBeUndefined()
      expect(loadLaunchSession()?.relayr?.superseded).toBeUndefined()
      expect(m.forward).toHaveBeenCalledTimes(2)
      // The node answers again, so the launch can be signed again or cancelled.
      clients.get(10)!.estimateGas.mockResolvedValue(2_000_000n)
      await expect(run()).rejects.toThrow('expired unused')
      expect(canCancelLaunch(loadLaunchSession()!)).toBe(true)
    })

    it('refreshes a published launch at the same nonces while its requests can still run', async () => {
      await publishedUnpaid()
      m.fee.mockResolvedValue(18n)
      // The forwarder runs one request per nonce, so the old and new signatures cannot both run.
      await expect(run()).rejects.toThrow('creation fee changed')
      expect(loadLaunchSession()?.relayr).toMatchObject({ phase: 'signing', signed: [], retryNonces: { 1: '0', 10: '0' } })
      await run()
      expect(m.forward.mock.calls.slice(2).map(([call, _account, nonce]) => [call.chainId, call.value, nonce])).toEqual([[1, 18n, 0n], [10, 18n, 0n]])
      expect(m.pay).toHaveBeenCalledTimes(1)
    })

    it('retains an ambiguous payment, and permits cancelling only after both canonical deadlines pass', async () => {
      m.pay.mockImplementation(async (_p, _a, _u, _destinations, { reverify: verify, onSending: sending }) => {
        await verify(); sending(); throw new Error('no hash returned')
      })
      await expect(run()).rejects.toThrow('no hash returned')
      m.poll.mockImplementation(async () => { throw new Error('provider unavailable') })
      // The destinations' requests expired unused, but the payment chain's finalized block is before its deadline.
      for (const chainId of [1, 10]) clients.get(chainId)!.getBlock.mockResolvedValue({ number: 123n, hash: BLOCK, timestamp: BigInt(NOW + 3601) })
      await expect(run()).rejects.toThrow('may have sent')
      expect(canCancelLaunch(loadLaunchSession()!)).toBe(false)
      finalizedAt(NOW + 3601)
      await expect(run()).rejects.toThrow('earlier payment may have been charged')
      expect(loadLaunchSession()?.relayr?.phase).toBe('payment-signing')
      expect(canCancelLaunch(loadLaunchSession()!)).toBe(true)
      expect(m.pay).toHaveBeenCalledTimes(1)
      expect(m.forward).toHaveBeenCalledTimes(2)
    })

    describe('cancelling a published launch', () => {
      it('releases a launch settled as ran, and keeps its record', async () => {
        await paidUnproven()
        finalizedAt(NOW + 3601)
        noncesAre(1n)
        await expect(run()).rejects.toThrow(MAY_HAVE_RUN)
        const settled = loadLaunchSession()!
        expect(await launchRequestsDead(settled)).toBe(true)
        await cancelUnsubmittedLaunch(settled.input.salt, launchRequestsDead)
        expect(loadLaunchSession()).toBeNull()
        expect(JSON.parse(storage.get(`${FUND_LAUNCH_KEY}:cancelled:${settled.input.salt}`)!).relayr.abandonable).toBe(true)
      })

      it('refuses while a request can still run, whatever the saved record says', async () => {
        await publishedUnpaid()
        const stale = loadLaunchSession()!
        stale.relayr!.abandonable = true
        saveLaunchSession(stale)
        expect(canCancelLaunch(stale)).toBe(true)
        expect(await launchRequestsDead(stale)).toBe(false)
        await expect(cancelUnsubmittedLaunch(stale.input.salt, launchRequestsDead)).rejects.toThrow('can still run')
        await expect(cancelUnsubmittedLaunch(stale.input.salt)).rejects.toThrow('can still run')
        expect(loadLaunchSession()).not.toBeNull()
      })

      it('refuses while the node cannot say whether a request ran', async () => {
        await publishedUnpaid()
        pastDeadlines()
        await expect(run()).rejects.toThrow('expired unused')
        for (const client of clients.values()) client.getBlock.mockRejectedValue(new Error('node unavailable'))
        const settled = loadLaunchSession()!
        expect(await launchRequestsDead(settled)).toBe(false)
        await expect(cancelUnsubmittedLaunch(settled.input.salt, launchRequestsDead)).rejects.toThrow('can still run')
        expect(loadLaunchSession()).not.toBeNull()
      })
    })
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
      { calldata: '0xdeadbeef' as Hex }, { payment_deadline: NOW + 5 },
    ]) expect(() => relayrPaymentDetails({ ...payment, ...change }, BUNDLE, NOW)).toThrow()
    expect(() => relayrPaymentDetails(payment, '00000000-0000-0000-0000-000000000002', NOW)).toThrow(/bundle/)
    expect(() => relayrPaymentDetails(payment, BUNDLE, NOW + 601)).toThrow()
  })

  it('words a funding option as its chain and quoted fee', () => {
    expect(relayrPaymentLabel({ ...paymentFor(8453), amount: '123456789012345' })).toBe('Base (~0.000123 ETH)')
    expect(relayrPaymentLabel({ ...paymentFor(1), amount: '1000000000000000' })).toBe('Ethereum (0.001 ETH)')
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
