import './dialog-shim'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { jbControllerAbi } from '@bananapus/nana-sdk-core'
import { v6Address } from '@bananapus/nana-sdk-core/v6'
import { encodeAbiParameters, encodeEventTopics, encodeFunctionData, parseAbi, zeroAddress, type Address, type Hex, type PublicClient, type TransactionReceipt } from 'viem'
import { buildFundRulesetChange, initialFundRuleset, type FundRulesetSnapshot } from '../src/lib/fund-contracts'
import type { FundProjectState } from '../src/lib/fund-state'
import { safeExecutionLog } from './support/safe-logs'
import { placeReceipt } from './support/recovery-receipt'

const runtime = vi.hoisted(() => ({
  account: '0x1111111111111111111111111111111111111111' as Address,
  receipt: vi.fn(), transaction: vi.fn(), block: vi.fn(), wait: vi.fn(), send: vi.fn(),
  states: [] as unknown[],
  tx: {} as Record<string, unknown>,
}))
vi.mock('@/providers/Providers', () => ({ wagmiConfig: {} }))
vi.mock('@/hooks/useWallet', () => ({ useWallet: () => ({ address: runtime.account }) }))
vi.mock('@/hooks/useSafeTx', () => ({ useSafeTx: () => ({ phase: 'idle', busy: false, send: runtime.send, ...runtime.tx }), txPhaseLabel: (_phase: string, labels: { idle: string }) => labels.idle }))
vi.mock('@/lib/fund-state', async importOriginal => ({
  ...await importOriginal<typeof import('../src/lib/fund-state')>(),
  readFundProjectState: async () => runtime.states[0],
  readLinkedFundProjects: async () => runtime.states,
}))
vi.mock('@/components/FundAssetWithdrawals', () => ({ FundAssetWithdrawals: () => null }))
vi.mock('@/lib/safe-connector', () => ({ waitForSafeExecutionHash: runtime.wait }))
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
    Object.defineProperty(navigator, 'locks', { configurable: true, value: { request: async (_name: string, _options: unknown, task: (lock: object) => Promise<unknown>) => task({}) } })
    host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  })
  afterEach(async () => { vi.restoreAllMocks(); await act(async () => root.unmount()); host.remove(); localStorage.clear(); Reflect.deleteProperty(navigator, 'locks') })
  const button = (label: string) => [...host.querySelectorAll('button')].find(node => node.textContent === label)
  const key = `homerun:fund-ruleset-recovery:${ROOT.chainId}:${ROOT.projectId}:${ACCOUNT.toLowerCase()}`

  it('withdraws the unknown-submission marker when a linked write stops before the wallet', async () => {
    const saved = plan()
    localStorage.setItem(key, serializeRulesetRecovery(saved, new Map(), ROOT))
    // Fresh reads that still match the saved plan on both chains.
    runtime.states = saved.states.map(peer => ({
      ...state(), chainId: peer.chainId, projectId: peer.projectId, blockNumber: 101n, blockTimestamp: 1_000n,
      rulesetSnapshot: peer.rulesetSnapshot, linkedChainIds: [8453, 10],
    }))
    let marked = false
    runtime.send.mockImplementation(async (_request: unknown, options: { durableRecovery: { reserve: () => void; releaseUnsubmitted: () => void } }) => {
      await options.durableRecovery.reserve()
      marked = deserializeRulesetRecovery(localStorage.getItem(key)!, ROOT, ACCOUNT).submissions.get(8453)?.kind === 'submission-unknown'
      // A Safe connection that changes at the write: nothing reaches the wallet.
      await options.durableRecovery.releaseUnsubmitted()
      return null
    })
    await act(async () => root.render(<FundOperatorActions state={state()} client={{} as PublicClient} contextIndex={0} />))
    await act(async () => button('Verify and resume queued plan')!.click())
    await act(async () => button('Review transaction 1 of 2')!.click())
    expect(runtime.send).toHaveBeenCalledOnce()
    expect(runtime.send.mock.calls[0][1].reviewedAccount).toBe(ACCOUNT)
    expect(marked).toBe(true)
    expect(deserializeRulesetRecovery(localStorage.getItem(key)!, ROOT, ACCOUNT).submissions.has(8453)).toBe(false)
    expect(host.textContent).not.toContain('Submission started; hash not yet recorded.')
  })

  it.each([true, false])('only clears a saved Safe failure when finalized=%s', async finalized => {
    const saved = plan()
    localStorage.setItem(
      `homerun:fund-ruleset-recovery:${ROOT.chainId}:${ROOT.projectId}:${ACCOUNT.toLowerCase()}`,
      serializeRulesetRecovery(saved, new Map([[8453, { kind: 'safe-proposal' as const, hash: PROPOSAL }]]), ROOT),
    )
    const request = saved.requests[0]
    runtime.wait.mockResolvedValue(EXECUTION)
    // The Safe ran the exact reviewed call, which failed: the receipt succeeds, with the Safe's ExecutionFailure.
    const receipt = { status: 'success', transactionHash: EXECUTION, blockHash: BLOCK_HASH, blockNumber: 120n, logs: [safeExecutionLog(ACCOUNT, PROPOSAL, { failed: true })] }
    const transaction = { hash: EXECUTION, blockHash: BLOCK_HASH, blockNumber: 120n, from: '0x2222222222222222222222222222222222222222', to: ACCOUNT, value: 0n,
      input: encodeFunctionData({ abi: execTransaction, functionName: 'execTransaction', args: [request.address, 0n, encodeFunctionData(request), 0, 0n, 0n, 0n, zeroAddress, zeroAddress, '0x'] }) }
    placeReceipt(transaction, receipt)
    runtime.receipt.mockResolvedValue(receipt)
    runtime.transaction.mockResolvedValue(transaction)
    runtime.block.mockImplementation(async ({ blockNumber }: { blockNumber?: bigint }) => ({ hash: BLOCK_HASH, number: blockNumber ?? (finalized ? 120n : 119n), timestamp: 1_000n }))
    await act(async () => root.render(<FundOperatorActions state={state()} client={{} as PublicClient} contextIndex={0} />))
    await act(async () => button('Verify and resume queued plan')!.click())
    if (!finalized) {
      expect(button('Clear the confirmed reverted attempt')).toBeUndefined()
      expect(deserializeRulesetRecovery(localStorage.getItem(key)!, ROOT, ACCOUNT).submissions.get(8453)).toEqual({ kind: 'safe-proposal', hash: PROPOSAL })
      return
    }
    expect(host.textContent).toContain('The Safe executed this transaction, but its call failed. It has not changed the rules.')
    const clear = button('Clear the confirmed reverted attempt')
    expect(clear).toBeDefined()
    await act(async () => clear!.click())
    expect(host.textContent).toContain('The failed execution was verified and removed from this plan.')
  })

  it('blocks a stale tab before review when another tab saved a linked submission', async () => {
    const saved = plan()
    localStorage.setItem(key, serializeRulesetRecovery(saved, new Map(), ROOT))
    runtime.states = saved.states.map(peer => ({ ...state(), chainId: peer.chainId, projectId: peer.projectId, blockNumber: 101n, blockTimestamp: 1_000n, rulesetSnapshot: peer.rulesetSnapshot, linkedChainIds: [8453, 10] }))
    await act(async () => root.render(<FundOperatorActions state={state()} client={{} as PublicClient} contextIndex={0} />))
    await act(async () => button('Verify and resume queued plan')!.click())
    const newer = serializeRulesetRecovery(saved, new Map([[8453, { kind: 'submission-unknown' as const }]]), ROOT)
    localStorage.setItem(key, newer)
    await act(async () => button('Review transaction 1 of 2')!.click())
    expect(runtime.send).not.toHaveBeenCalled()
    expect(localStorage.getItem(key)).toBe(newer)
    expect(host.textContent).toContain('changed in another tab')
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
    runtime.send.mockImplementation(async (_request: unknown, options: { durableRecovery: { reserve: () => void; submitted: (hash: Hex, safe: boolean) => void } }) => {
      options.durableRecovery.reserve(); options.durableRecovery.submitted(PROPOSAL, safe); return PROPOSAL
    })
    await act(async () => root.render(<FundOperatorActions state={state()} client={{} as PublicClient} contextIndex={0} />))
    await act(async () => button('Verify and resume queued plan')!.click())
    await act(async () => button('Review transaction 1 of 2')!.click())
    return saved
  }

  it.each([true, false])('requires canonical proof before advancing a live ruleset with safe=%s', async safe => {
    const saved = await liveSubmission(safe)
    const { receipt } = successReceipt(saved, safe)
    runtime.block.mockResolvedValue({ hash: `0x${'ff'.repeat(32)}`, number: 120n, timestamp: 1_000n })
    runtime.tx = { phase: 'success', receipt, isSafe: safe }
    await act(async () => root.render(<FundOperatorActions state={state()} client={{} as PublicClient} contextIndex={0} />))
    expect(button('Review transaction 2 of 2')).toBeUndefined()
    expect(button('Done')).toBeUndefined()
    expect(host.textContent).not.toContain('Execution confirmed.')
    expect(deserializeRulesetRecovery(localStorage.getItem(key)!, ROOT, ACCOUNT).submissions.get(8453)).toMatchObject({ kind: safe ? 'safe-proposal' : 'transaction', hash: PROPOSAL })
  })

  it('advances a canonically proven live Safe execution while retaining its proposal identity', async () => {
    const saved = await liveSubmission()
    const { receipt } = successReceipt(saved)
    runtime.tx = { phase: 'success', receipt, isSafe: true }
    await act(async () => root.render(<FundOperatorActions state={state()} client={{} as PublicClient} contextIndex={0} />))
    expect(button('Review transaction 2 of 2'), host.textContent ?? '').toBeDefined()
    expect(deserializeRulesetRecovery(localStorage.getItem(key)!, ROOT, ACCOUNT).submissions.get(8453)).toMatchObject({ kind: 'safe-proposal', hash: PROPOSAL })
  })

  it('does not apply a late successful proof over a replaced saved attempt', async () => {
    const saved = await liveSubmission()
    const { receipt, transaction } = successReceipt(saved)
    let resolve!: (value: typeof transaction) => void
    runtime.transaction.mockImplementationOnce(() => new Promise(done => { resolve = done }))
    runtime.tx = { phase: 'success', receipt, isSafe: true }
    await act(async () => root.render(<FundOperatorActions state={state()} client={{} as PublicClient} contextIndex={0} />))
    expect(resolve, host.textContent ?? '').toBeTypeOf('function')
    const newer = serializeRulesetRecovery(saved, new Map([[8453, { kind: 'submission-unknown', attemptId: crypto.randomUUID() }]]), ROOT)
    localStorage.setItem(key, newer)
    await act(async () => resolve(transaction))
    expect(button('Review transaction 2 of 2')).toBeUndefined()
    expect(localStorage.getItem(key)).toBe(newer)
    expect(host.textContent).toContain('changed in another tab')
  })

  it('rolls back only its unsubmitted reservation after a transient readback failure', async () => {
    const saved = plan(); const previous = serializeRulesetRecovery(saved, new Map(), ROOT)
    localStorage.setItem(key, previous); freshStates(saved)
    runtime.send.mockImplementation(async (_request: unknown, options: { durableRecovery: { reserve: () => void } }) => { options.durableRecovery.reserve() })
    await act(async () => root.render(<FundOperatorActions state={state()} client={{} as PublicClient} contextIndex={0} />))
    await act(async () => button('Verify and resume queued plan')!.click())
    const get = Storage.prototype.getItem; const set = Storage.prototype.setItem
    let failRead = false
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, storageKey, value) { set.call(this, storageKey, value); if (storageKey === key && value !== previous) failRead = true })
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, storageKey) { if (storageKey === key && failRead) { failRead = false; throw new Error('Readback unavailable') }; return get.call(this, storageKey) })
    await act(async () => button('Review transaction 1 of 2')!.click())
    expect(localStorage.getItem(key)).toBe(previous)
    expect(host.textContent).toContain('Readback unavailable')
    expect(host.textContent).not.toContain('Submission started; hash not yet recorded.')
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

  it.each([true, false])('can authenticate an unknown Safe execution only as positive recovery: success=%s', async success => {
    const saved = plan(); const attemptId = crypto.randomUUID()
    const previous = serializeRulesetRecovery(saved, new Map([[8453, { kind: 'submission-unknown', attemptId }]]), ROOT)
    localStorage.setItem(key, previous); freshStates(saved)
    const { receipt, transaction } = successReceipt(saved)
    if (!success) {
      receipt.logs = [safeExecutionLog(ACCOUNT, PROPOSAL, { failed: true })] as TransactionReceipt['logs']
      placeReceipt(transaction, receipt)
    }
    await act(async () => root.render(<FundOperatorActions state={state()} client={{} as PublicClient} contextIndex={0} />))
    const input = [...host.querySelectorAll('label')].find(label => label.textContent?.startsWith('Onchain transaction hash'))!.querySelector('input')!
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, EXECUTION); input.dispatchEvent(new Event('input', { bubbles: true })) })
    await act(async () => button('Verify execution hash')!.click())
    if (success) expect(deserializeRulesetRecovery(localStorage.getItem(key)!, ROOT, ACCOUNT).submissions.get(8453), host.textContent ?? '').toEqual({ kind: 'transaction', hash: EXECUTION, attemptId })
    else {
      expect(localStorage.getItem(key)).toBe(previous)
      expect(button('Clear the confirmed reverted attempt')).toBeUndefined()
      expect(host.textContent).toContain('historical failure cannot release')
    }
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
