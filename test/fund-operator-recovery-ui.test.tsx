import './dialog-shim'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { jbControllerAbi } from '@bananapus/nana-sdk-core'
import { writeIntentKey } from '@bananapus/nana-sdk-core/review'
import { v6Address } from '@bananapus/nana-sdk-core/v6'
import { encodeAbiParameters, encodeEventTopics, encodeFunctionData, parseAbi, TransactionReceiptNotFoundError, zeroAddress, type Address, type Hex, type PublicClient, type TransactionReceipt } from 'viem'
import { buildFundRulesetChange, initialFundRuleset, type FundRulesetSnapshot } from '../src/lib/fund-contracts'
import type { RulesetSubmission } from '../src/components/FundOperatorActions'
import type { FundProjectState } from '../src/lib/fund-state'
import { safeExecutionLog } from './support/safe-logs'
import { placeReceipt } from './support/recovery-receipt'

const runtime = vi.hoisted(() => ({
  account: '0x1111111111111111111111111111111111111111' as Address,
  receipt: vi.fn(), transaction: vi.fn(), block: vi.fn(), wait: vi.fn(), send: vi.fn(), track: vi.fn(), adopt: vi.fn(), outcome: vi.fn(),
  states: [] as unknown[],
  tx: {} as Record<string, unknown>,
}))
vi.mock('@/providers/Providers', () => ({ wagmiConfig: {} }))
vi.mock('@/hooks/useWallet', () => ({ useWallet: () => ({ address: runtime.account }) }))
vi.mock('@/hooks/useSafeTx', () => ({ useSafeTx: () => ({ phase: 'idle', busy: false, send: runtime.send, track: runtime.track, ...runtime.tx }), txPhaseLabel: (_phase: string, labels: { idle: string }) => labels.idle }))
vi.mock('@/lib/fund-state', async importOriginal => ({
  ...await importOriginal<typeof import('../src/lib/fund-state')>(),
  readFundProjectState: async () => runtime.states[0],
  readLinkedFundProjects: async () => runtime.states,
}))
vi.mock('@/components/FundAssetWithdrawals', () => ({ FundAssetWithdrawals: () => null }))
vi.mock('@/lib/safe-connector', () => ({ waitForSafeExecutionHash: runtime.wait }))
vi.mock('@/lib/write-hold', async importOriginal => ({ ...await importOriginal<typeof import('../src/lib/write-hold')>(), adoptLegacyWrite: runtime.adopt, holdOutcome: runtime.outcome,
  // The shared rule, over this suite's hold outcomes.
  recoverFromHold: async (intent: unknown, verify: (hash?: Hex) => Promise<unknown>) => {
    const outcome = await runtime.outcome(intent)
    if (outcome.status === 'held') return { status: 'held' }
    let reason: string | null = null
    const attempt = async (hash?: Hex) => { try { return await verify(hash) } catch (failure) { reason = (failure as Error).message; return null } }
    if (outcome.status === 'settled') {
      const value = await attempt(outcome.hash) ?? await attempt()
      return value !== null ? { status: 'done', value } : { status: 'check', reason: reason ?? 'unshown' }
    }
    const value = await attempt()
    return value !== null ? { status: 'done', value } : reason !== null ? { status: 'check', reason } : { status: 'none' }
  },
}))
vi.mock('@wagmi/core', async importOriginal => ({
  ...await importOriginal<typeof import('@wagmi/core')>(),
  getAccount: () => ({ address: runtime.account }),
  getPublicClient: (_config: unknown, { chainId }: { chainId: number }) => ({ getChainId: async () => chainId, getTransactionReceipt: runtime.receipt, getTransaction: runtime.transaction, getBlock: runtime.block }),
}))
vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  useQuery: () => ({ data: undefined, isError: false }),
}))
import { deserializeRulesetRecovery, FundOperatorActions, serializeRulesetRecovery } from '../src/components/FundOperatorActions'

const ACCOUNT = '0x1111111111111111111111111111111111111111' as const
const ROOT = { chainId: 8453, projectId: 7n }
const PROPOSAL = `0x${'ab'.repeat(32)}` as Hex
const EXECUTION = `0x${'cd'.repeat(32)}` as Hex
const BLOCK_HASH = `0x${'ee'.repeat(32)}` as Hex
const STARTS_AT = 1_900_000_000
const execTransaction = parseAbi(['function execTransaction(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,bytes signatures) returns (bool success)'])

function plan() {
  const states = ([8453, 10] as const).map((chainId, index) => {
    const projectId = ROOT.projectId + BigInt(index)
    const rulesetSnapshot: FundRulesetSnapshot = {
      chainId, projectId, blockNumber: 100n, controller: v6Address('JBController', chainId), currentRulesetId: 71n, upcomingRulesetId: 0n,
      configuration: initialFundRuleset(), linkedChainIds: [8453, 10],
    }
    return { chainId, projectId, owner: ACCOUNT, rulesetSnapshot }
  })
  const requests = buildFundRulesetChange({ snapshots: states.map(state => state.rulesetSnapshot), action: 'pause', mustStartAtOrAfter: STARTS_AT }).requests
  return { states, requests, action: 'pause', startsAt: STARTS_AT, account: ACCOUNT } as Parameters<typeof serializeRulesetRecovery>[0]
}

function state(): FundProjectState {
  const configuration = initialFundRuleset()
  return {
    chainId: ROOT.chainId, projectId: ROOT.projectId, blockNumber: 100n, owner: ACCOUNT, account: ACCOUNT,
    controller: v6Address('JBController', 8453), supportedController: true, supportedTerminals: true, knownOwnerWrapper: true,
    ruleset: { id: 71 }, metadata: configuration.metadata, totalSupply: 0n, creditBalance: 0n, erc20Balance: 0n,
    pendingReservedTokens: 0n, hasPendingRuleset: false, linkedChainIds: [8453, 10], accountingContexts: [],
    rulesetSnapshot: plan().states[0].rulesetSnapshot,
    permissions: { queueRulesets: true, mintTokens: false },
  } as unknown as FundProjectState
}

describe('linked ruleset recovery of a Safe execution', () => {
  let host: HTMLDivElement, root: Root
  beforeEach(() => {
    localStorage.clear(); vi.resetAllMocks(); runtime.tx = {}
    runtime.adopt.mockResolvedValue({ adopted: false, state: { status: 'clear' } })
    // No hold has a record unless a test says so.
    runtime.outcome.mockResolvedValue({ status: 'none' })
    Object.defineProperty(navigator, 'locks', { configurable: true, value: { request: async (_name: string, _options: unknown, task: (lock: object) => Promise<unknown>) => task({}) } })
    host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  })
  afterEach(async () => { vi.restoreAllMocks(); await act(async () => root.unmount()); host.remove(); localStorage.clear(); Reflect.deleteProperty(navigator, 'locks') })
  const button = (label: string) => [...host.querySelectorAll('button')].find(node => node.textContent === label)
  const key = `homerun:fund-ruleset-recovery:${ROOT.chainId}:${ROOT.projectId}:${ACCOUNT.toLowerCase()}`

  it('sends each chain under its project and chosen action, saving nothing for the write itself', async () => {
    const saved = plan()
    localStorage.setItem(key, serializeRulesetRecovery(saved, new Map(), ROOT))
    runtime.states = saved.states.map(peer => ({
      ...state(), chainId: peer.chainId, projectId: peer.projectId, blockNumber: 101n, blockTimestamp: 1_000n,
      rulesetSnapshot: peer.rulesetSnapshot, linkedChainIds: [8453, 10],
    }))
    runtime.send.mockResolvedValue(null)
    await act(async () => root.render(<FundOperatorActions state={state()} client={{} as PublicClient} contextIndex={0} />))
    await act(async () => button('Verify and resume queued plan')!.click())
    await act(async () => button('Review transaction 1 of 2')!.click())
    expect(runtime.send).toHaveBeenCalledOnce()
    expect(runtime.send.mock.calls[0][1]).toMatchObject({ reviewedAccount: ACCOUNT, recoveryNamespace: writeIntentKey('fund-ruleset', { project: 7n, action: 'pause' }) })
    expect(localStorage.getItem(key)).toBe(serializeRulesetRecovery(saved, new Map(), ROOT))
  })

  it('leaves a saved failed Safe execution uncounted and adopts it into its chain’s hold', async () => {
    const saved = plan()
    localStorage.setItem(key, serializeRulesetRecovery(saved, new Map([[8453, { kind: 'safe-proposal' as const, hash: PROPOSAL }]]), ROOT))
    freshStates(saved)
    const request = saved.requests[0]
    runtime.wait.mockResolvedValue(EXECUTION)
    // The Safe ran the exact reviewed call, which failed: the receipt succeeds, with the Safe's ExecutionFailure.
    const receipt = { status: 'success', transactionHash: EXECUTION, blockHash: BLOCK_HASH, blockNumber: 120n, logs: [safeExecutionLog(ACCOUNT, PROPOSAL, { failed: true })] }
    const transaction = { hash: EXECUTION, blockHash: BLOCK_HASH, blockNumber: 120n, from: '0x2222222222222222222222222222222222222222', to: ACCOUNT, value: 0n,
      input: encodeFunctionData({ abi: execTransaction, functionName: 'execTransaction', args: [request.address, 0n, encodeFunctionData(request), 0, 0n, 0n, 0n, zeroAddress, zeroAddress, '0x'] }) }
    placeReceipt(transaction, receipt)
    runtime.receipt.mockResolvedValue(receipt)
    runtime.transaction.mockResolvedValue(transaction)
    runtime.adopt.mockResolvedValue({ adopted: true, state: { status: 'safe-unproven' } })
    await act(async () => root.render(<FundOperatorActions state={state()} client={{} as PublicClient} contextIndex={0} />))
    await act(async () => button('Verify and resume queued plan')!.click())
    const namespace = writeIntentKey('fund-ruleset', { project: 7n, action: 'pause' })
    expect(runtime.adopt).toHaveBeenCalledWith(expect.objectContaining({ chainId: 8453, account: ACCOUNT, safe: true, namespace }), { safe: { safeTxHash: PROPOSAL } }, expect.anything())
    expect(runtime.track).toHaveBeenCalledWith(expect.objectContaining({ chainId: 8453 }), expect.objectContaining({ recoveryNamespace: namespace, safe: true }))
    expect(deserializeRulesetRecovery(localStorage.getItem(key)!, ROOT, ACCOUNT).submissions.size).toBe(0)
  })

  function freshStates(saved = plan()) {
    runtime.states = saved.states.map(peer => ({ ...state(), chainId: peer.chainId, projectId: peer.projectId, blockNumber: 121n, blockTimestamp: 1_000n, rulesetSnapshot: peer.rulesetSnapshot, linkedChainIds: [8453, 10] }))
  }

  function successReceipt(saved = plan(), safe = true, index = 0) {
    const request = saved.requests[index]
    const hash = index === 1 ? `0x${'12'.repeat(32)}` as Hex : safe ? EXECUTION : PROPOSAL
    const receipt = { status: 'success', transactionHash: hash, blockHash: BLOCK_HASH, blockNumber: 120n, logs: [{
      address: saved.states[index].rulesetSnapshot.controller, topics: encodeEventTopics({ abi: jbControllerAbi, eventName: 'QueueRulesets' }),
      data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }, { type: 'string' }, { type: 'address' }], [72n, saved.states[index].projectId, 'Homerun: pause', ACCOUNT]), logIndex: 0,
    }, ...(safe ? [{ ...safeExecutionLog(ACCOUNT, PROPOSAL), logIndex: 1 }] : [])] }
    const transaction = { hash, blockHash: BLOCK_HASH, blockNumber: 120n, from: safe ? '0x2222222222222222222222222222222222222222' : ACCOUNT, to: safe ? ACCOUNT : request.address, value: 0n,
      input: safe ? encodeFunctionData({ abi: execTransaction, functionName: 'execTransaction', args: [request.address, 0n, encodeFunctionData(request), 0, 0n, 0n, 0n, zeroAddress, zeroAddress, '0x'] }) : encodeFunctionData(request) }
    placeReceipt(transaction, receipt)
    runtime.receipt.mockResolvedValue(receipt)
    runtime.transaction.mockResolvedValue(transaction)
    runtime.block.mockImplementation(async ({ blockNumber }: { blockNumber?: bigint }) => ({ hash: BLOCK_HASH, number: blockNumber ?? 120n, timestamp: 1_000n }))
    return { receipt: receipt as TransactionReceipt, transaction }
  }

  async function liveSubmission(safe = true) {
    const saved = plan()
    localStorage.setItem(key, serializeRulesetRecovery(saved, new Map(), ROOT)); freshStates(saved)
    runtime.tx = { isSafe: safe }
    runtime.send.mockResolvedValue(PROPOSAL)
    await act(async () => root.render(<FundOperatorActions state={state()} client={{} as PublicClient} contextIndex={0} />))
    await act(async () => button('Verify and resume queued plan')!.click())
    await act(async () => button('Review transaction 1 of 2')!.click())
    return saved
  }

  it.each([true, false])('requires canonical proof before advancing a live ruleset with safe=%s', async safe => {
    const saved = await liveSubmission(safe)
    const { receipt } = successReceipt(saved, safe)
    runtime.block.mockResolvedValue({ hash: `0x${'ff'.repeat(32)}`, number: 120n, timestamp: 1_000n })
    runtime.tx = { phase: 'success', receipt, isSafe: safe, submissionHash: PROPOSAL }
    await act(async () => root.render(<FundOperatorActions state={state()} client={{} as PublicClient} contextIndex={0} />))
    expect(button('Review transaction 2 of 2')).toBeUndefined()
    expect(button('Done')).toBeUndefined()
    expect(host.textContent).not.toContain('Execution confirmed.')
    expect(deserializeRulesetRecovery(localStorage.getItem(key)!, ROOT, ACCOUNT).submissions.has(8453)).toBe(false)
  })

  it('advances a canonically proven live Safe execution while retaining its proposal identity', async () => {
    const saved = await liveSubmission()
    const { receipt } = successReceipt(saved)
    runtime.tx = { phase: 'success', receipt, isSafe: true, submissionHash: PROPOSAL }
    await act(async () => root.render(<FundOperatorActions state={state()} client={{} as PublicClient} contextIndex={0} />))
    expect(button('Review transaction 2 of 2'), host.textContent ?? '').toBeDefined()
    expect(deserializeRulesetRecovery(localStorage.getItem(key)!, ROOT, ACCOUNT).submissions.get(8453)).toMatchObject({ kind: 'safe-proposal', hash: PROPOSAL })
  })

  it('does not apply a late successful proof over a replaced saved attempt', async () => {
    const saved = await liveSubmission()
    const { receipt, transaction } = successReceipt(saved)
    let resolve!: (value: typeof transaction) => void
    runtime.transaction.mockImplementationOnce(() => new Promise(done => { resolve = done }))
    runtime.tx = { phase: 'success', receipt, isSafe: true, submissionHash: PROPOSAL }
    await act(async () => root.render(<FundOperatorActions state={state()} client={{} as PublicClient} contextIndex={0} />))
    expect(resolve, host.textContent ?? '').toBeTypeOf('function')
    const newer = serializeRulesetRecovery(saved, new Map([[8453, { kind: 'submission-unknown', attemptId: crypto.randomUUID() }]]), ROOT)
    localStorage.setItem(key, newer)
    await act(async () => resolve(transaction))
    expect(button('Review transaction 2 of 2')).toBeUndefined()
    expect(localStorage.getItem(key)).toBe(newer)
    expect(host.textContent).toContain('changed in another tab')
  })

  it.each([true, false])('only closes a fully verified plan under its unchanged owner lock: replaced=%s', async replaced => {
    const saved = plan()
    const first = successReceipt(saved, false, 0); const second = successReceipt(saved, false, 1)
    const records = new Map([
      [8453, { kind: 'transaction' as const, hash: first.receipt.transactionHash, attemptId: crypto.randomUUID() }],
      [10, { kind: 'transaction' as const, hash: second.receipt.transactionHash, attemptId: crypto.randomUUID() }],
    ])
    localStorage.setItem(key, serializeRulesetRecovery(saved, records, ROOT))
    runtime.receipt.mockImplementation(async ({ hash }: { hash: Hex }) => hash === first.receipt.transactionHash ? first.receipt : second.receipt)
    // Each chain's hold settled its transaction with success.
    runtime.outcome.mockImplementation(async ({ chainId }: { chainId: number }) => ({ status: 'settled', hash: chainId === 8453 ? first.receipt.transactionHash : second.receipt.transactionHash }))
    runtime.transaction.mockImplementation(async ({ hash }: { hash: Hex }) => hash === first.receipt.transactionHash ? first.transaction : second.transaction)
    runtime.states = saved.states.map(peer => ({ ...state(), chainId: peer.chainId, projectId: peer.projectId, blockNumber: 121n, blockTimestamp: 1_000n, rulesetSnapshot: { ...peer.rulesetSnapshot, upcomingRulesetId: 72n }, linkedChainIds: [8453, 10] }))
    const locks = vi.spyOn(navigator.locks, 'request')
    await act(async () => root.render(<FundOperatorActions state={state()} client={{} as PublicClient} contextIndex={0} />))
    await act(async () => button('Verify and resume queued plan')!.click())
    expect(button('Done'), host.textContent ?? '').toBeDefined()
    const callsBeforeClose = locks.mock.calls.length
    const newer = serializeRulesetRecovery(saved, new Map([[8453, { kind: 'submission-unknown', attemptId: crypto.randomUUID() }]]), ROOT)
    if (replaced) localStorage.setItem(key, newer)
    await act(async () => button('Done')!.click())
    expect(locks.mock.calls.length).toBe(callsBeforeClose + 1)
    expect(localStorage.getItem(key)).toBe(replaced ? newer : null)
  })

  function savedChain(record: RulesetSubmission) {
    const saved = plan()
    localStorage.setItem(key, serializeRulesetRecovery(saved, new Map([[8453, record]]), ROOT))
    runtime.states = saved.states.map((peer, index) => ({ ...state(), chainId: peer.chainId, projectId: peer.projectId, blockNumber: 121n, blockTimestamp: 1_000n, rulesetSnapshot: { ...peer.rulesetSnapshot, upcomingRulesetId: index === 0 ? 72n : 0n }, linkedChainIds: [8453, 10] }))
    return saved
  }
  async function verify() {
    await act(async () => root.render(<FundOperatorActions state={state()} client={{} as PublicClient} contextIndex={0} />))
    await act(async () => button('Verify and resume queued plan')!.click())
  }

  it('never counts a chain whose hold still holds its write, even when its transaction authenticates', async () => {
    successReceipt(savedChain({ kind: 'transaction', hash: EXECUTION }))
    runtime.outcome.mockImplementation(async ({ chainId }: { chainId: number }) => ({ status: chainId === 8453 ? 'held' : 'none' }))
    await verify()
    // Its hold settles it: the chain is still the next one.
    expect(button('Review transaction 2 of 2')).toBeUndefined()
    expect(runtime.outcome).toHaveBeenCalledWith(expect.objectContaining({ chainId: 8453, account: ACCOUNT }))
    expect(host.textContent).not.toContain('Check this chain')
  })

  it('recognizes a completed chain on chain when its hold kept no record, and sends nothing again', async () => {
    // The browser's holds were cleared after the chain completed: the exact saved call is authenticated on chain.
    successReceipt(savedChain({ kind: 'transaction', hash: EXECUTION }))
    await verify()
    expect(button('Review transaction 2 of 2'), host.textContent ?? '').toBeDefined()
    expect(runtime.send).not.toHaveBeenCalled()
  })

  it('recognizes a chain its hold settled while the page was away, with nothing saved, and sends nothing again', async () => {
    const saved = plan()
    localStorage.setItem(key, serializeRulesetRecovery(saved, new Map(), ROOT))
    runtime.states = saved.states.map((peer, index) => ({ ...state(), chainId: peer.chainId, projectId: peer.projectId, blockNumber: 121n, blockTimestamp: 1_000n, rulesetSnapshot: { ...peer.rulesetSnapshot, upcomingRulesetId: index === 0 ? 72n : 0n }, linkedChainIds: [8453, 10] }))
    successReceipt(saved, false)
    runtime.outcome.mockImplementation(async ({ chainId }: { chainId: number }) => chainId === 8453 ? { status: 'settled', hash: PROPOSAL } : { status: 'none' })
    await verify()
    expect(button('Review transaction 2 of 2'), host.textContent ?? '').toBeDefined()
    expect(runtime.send).not.toHaveBeenCalled()
  })

  it('asks for a check, never aborting, when a settled chain shows no ruleset event', async () => {
    const saved = savedChain({ kind: 'transaction', hash: EXECUTION })
    const { receipt } = successReceipt(saved)
    // The settled transaction ran, but its receipt carries no QueueRulesets event for this plan.
    runtime.receipt.mockResolvedValue({ ...receipt, logs: [] })
    runtime.outcome.mockImplementation(async ({ chainId }: { chainId: number }) => chainId === 8453 ? { status: 'settled', hash: EXECUTION } : { status: 'none' })
    await verify()
    expect(host.querySelector('[role="alert"]')?.textContent ?? '').not.toContain('ruleset event')
    expect(host.textContent).toContain('Check this chain’s ruleset before running it again.')
    await act(async () => button('I checked it. Review it again')!.click())
    // Usable next steps: review the chain again, or close the plan without claiming it.
    expect(button('Review transaction 1 of 2')?.disabled).toBe(false)
    await act(async () => button('Close this plan')!.click())
    expect(localStorage.getItem(key)).toBeNull()
    expect(runtime.send).not.toHaveBeenCalled()
  })

  it('asks for a check before running a chain again when neither its hold nor the chain can show its saved transaction', async () => {
    savedChain({ kind: 'transaction', hash: EXECUTION })
    runtime.receipt.mockRejectedValue(new TransactionReceiptNotFoundError({ hash: EXECUTION }))
    await verify()
    expect(host.textContent).toContain('Check this chain’s ruleset before running it again.')
    expect(button('Review transaction 1 of 2')).toBeUndefined()
    await act(async () => button('I checked it. Review it again')!.click())
    expect(button('Review transaction 1 of 2')).toBeDefined()
    expect(runtime.send).not.toHaveBeenCalled()
  })

  it('closes a partly done plan whose shared start passed, without claiming the chains it never sent, unless one is still held', async () => {
    // Chain 1 confirmed; the start passed before chain 2 was sent.
    const saved = savedChain({ kind: 'transaction', hash: EXECUTION })
    successReceipt(saved)
    runtime.outcome.mockImplementation(async ({ chainId }: { chainId: number }) => chainId === 8453 ? { status: 'settled', hash: EXECUTION } : { status: 'none' })
    const clock = vi.spyOn(Date, 'now').mockReturnValue((STARTS_AT + 3_600) * 1000)
    try {
      await verify()
      expect(host.textContent).toContain('deadline has passed')
      expect(host.textContent).toContain('The chains not yet updated were not changed.')
      // A chain still held keeps the plan.
      runtime.outcome.mockImplementation(async ({ chainId }: { chainId: number }) => chainId === 10 ? { status: 'held' } : { status: 'none' })
      await act(async () => button('Close this plan')!.click())
      expect(host.textContent).toContain('Finish or exit the pending update first.')
      expect(localStorage.getItem(key)).not.toBeNull()
      runtime.outcome.mockResolvedValue({ status: 'none' })
      await act(async () => button('Close this plan')!.click())
      expect(localStorage.getItem(key)).toBeNull()
      expect(runtime.send).not.toHaveBeenCalled()
    } finally { clock.mockRestore() }
  })

  it('reverifies a legacy saved Safe execution hash without changing its saved identity', async () => {
    const saved = plan(); const record = { kind: 'transaction' as const, hash: EXECUTION, attemptId: crypto.randomUUID() }
    const previous = serializeRulesetRecovery(saved, new Map([[8453, record]]), ROOT)
    localStorage.setItem(key, previous)
    successReceipt(saved)
    runtime.states = saved.states.map((peer, index) => ({ ...state(), chainId: peer.chainId, projectId: peer.projectId, blockNumber: 121n, blockTimestamp: 1_000n, rulesetSnapshot: { ...peer.rulesetSnapshot, upcomingRulesetId: index === 0 ? 72n : 0n }, linkedChainIds: [8453, 10] }))
    await act(async () => root.render(<FundOperatorActions state={state()} client={{} as PublicClient} contextIndex={0} />))
    await act(async () => button('Verify and resume queued plan')!.click())
    expect(button('Review transaction 2 of 2'), host.textContent ?? '').toBeDefined()
    expect(localStorage.getItem(key)).toBe(previous)
  })

})
