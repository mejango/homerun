import './dialog-shim'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { v6Address } from '@bananapus/nana-sdk-core/v6'
import { encodeFunctionData, parseAbi, zeroAddress, type Address, type Hex, type PublicClient } from 'viem'
import { buildFundRulesetChange, initialFundRuleset, type FundRulesetSnapshot } from '../src/lib/fund-contracts'
import type { FundProjectState } from '../src/lib/fund-state'
import { safeExecutionLog } from './support/safe-logs'

const runtime = vi.hoisted(() => ({
  account: '0x1111111111111111111111111111111111111111' as Address,
  receipt: vi.fn(), transaction: vi.fn(), block: vi.fn(), wait: vi.fn(), send: vi.fn(),
  states: [] as unknown[],
}))
vi.mock('@/providers/Providers', () => ({ wagmiConfig: {} }))
vi.mock('@/hooks/useWallet', () => ({ useWallet: () => ({ address: runtime.account }) }))
vi.mock('@/hooks/useSafeTx', () => ({ useSafeTx: () => ({ phase: 'idle', busy: false, send: runtime.send }), txPhaseLabel: (_phase: string, labels: { idle: string }) => labels.idle }))
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
  getPublicClient: () => ({ getTransactionReceipt: runtime.receipt, getTransaction: runtime.transaction, getBlock: runtime.block }),
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
    localStorage.clear(); vi.clearAllMocks()
    host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  })
  afterEach(async () => { await act(async () => root.unmount()); host.remove(); localStorage.clear() })
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
    runtime.send.mockImplementation(async (_request: unknown, options: { beforeWrite: () => void; onBeforeWriteAborted: () => void }) => {
      options.beforeWrite()
      marked = deserializeRulesetRecovery(localStorage.getItem(key)!, ROOT, ACCOUNT).submissions.get(8453)?.kind === 'submission-unknown'
      // A Safe connection that changes at the write: nothing reaches the wallet.
      options.onBeforeWriteAborted()
      return null
    })
    await act(async () => root.render(<FundOperatorActions state={state()} client={{} as PublicClient} contextIndex={0} />))
    await act(async () => button('Verify and resume queued plan')!.click())
    await act(async () => button('Review transaction 1 of 2')!.click())
    expect(runtime.send).toHaveBeenCalledOnce()
    expect(marked).toBe(true)
    expect(deserializeRulesetRecovery(localStorage.getItem(key)!, ROOT, ACCOUNT).submissions.has(8453)).toBe(false)
    expect(host.textContent).not.toContain('Submission started; hash not yet recorded.')
  })

  it('reads a proposal whose execution logged ExecutionFailure as failed, and lets it be cleared for a retry', async () => {
    const saved = plan()
    localStorage.setItem(
      `homerun:fund-ruleset-recovery:${ROOT.chainId}:${ROOT.projectId}:${ACCOUNT.toLowerCase()}`,
      serializeRulesetRecovery(saved, new Map([[8453, { kind: 'safe-proposal' as const, hash: PROPOSAL }]]), ROOT),
    )
    const request = saved.requests[0]
    runtime.wait.mockResolvedValue(EXECUTION)
    // The Safe ran the exact reviewed call, which failed: the receipt succeeds, with the Safe's ExecutionFailure.
    runtime.receipt.mockResolvedValue({ status: 'success', transactionHash: EXECUTION, blockHash: BLOCK_HASH, blockNumber: 120n, logs: [safeExecutionLog(ACCOUNT, PROPOSAL, { failed: true })] })
    runtime.transaction.mockResolvedValue({ hash: EXECUTION, blockHash: BLOCK_HASH, from: '0x2222222222222222222222222222222222222222', to: ACCOUNT, value: 0n,
      input: encodeFunctionData({ abi: execTransaction, functionName: 'execTransaction', args: [request.address, 0n, encodeFunctionData(request), 0, 0n, 0n, 0n, zeroAddress, zeroAddress, '0x'] }) })
    runtime.block.mockResolvedValue({ hash: BLOCK_HASH })
    await act(async () => root.render(<FundOperatorActions state={state()} client={{} as PublicClient} contextIndex={0} />))
    await act(async () => button('Verify and resume queued plan')!.click())
    expect(host.textContent).toContain('The Safe executed this transaction, but its call failed. It has not changed the rules.')
    const clear = button('Clear the confirmed reverted attempt')
    expect(clear).toBeDefined()
    await act(async () => clear!.click())
    expect(host.textContent).toContain('The failed execution was verified and removed from this plan.')
  })
})
