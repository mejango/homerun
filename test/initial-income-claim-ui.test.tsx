import { act, useEffect } from 'react'
import type { JBChainId } from '@bananapus/nana-sdk-core'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { encodeAbiParameters, encodeEventTopics, encodeFunctionData, type Address, type Hex } from 'viem'
import { buildFundGlobalManifest, fundGlobalManifestHash, type FundGlobalManifest } from '../src/lib/fund-global-manifest'
import type { FundGlobalSnapshot } from '../src/lib/fund-global-snapshot'
import type { InitialIncomeAllocationState } from '../src/lib/income-allocation-state'
import type { FundOwnershipSnapshot } from '../src/lib/fund-snapshot'
import type { TxSendOptions } from '../src/hooks/useSafeTx'

const runtime = vi.hoisted(() => ({
  address: '0x1111111111111111111111111111111111111111' as Address,
  allocation: {} as Record<string, unknown>, manifest: {} as Record<string, unknown>, claimed: {} as Record<string, unknown>,
  state: null as InitialIncomeAllocationState | null,
  send: vi.fn(), readState: vi.fn(), verifyExecution: vi.fn(), safeExecution: vi.fn(), invalidateQueries: vi.fn(),
  client: { readContract: vi.fn(), getBlockNumber: vi.fn(), getTransactionReceipt: vi.fn() },
  isSafe: false, phase: 'idle', error: null as string | null, mounted: 0, unmounted: 0,
  useRealManifestQuery: false,
  queryFunctions: {} as Record<string, (options: { signal: AbortSignal }) => Promise<unknown>>,
}))
const wallet = '0x1111111111111111111111111111111111111111' as const
const addr = (digit: string) => `0x${digit.repeat(40)}` as Address
const hash = (digit: string) => `0x${digit.repeat(64)}` as Hex
const units = 10n ** 18n
const pendingKey = `homerun:initial-income-claim:v1:8453:7:8:${wallet}`
const cache = { invalidateQueries: runtime.invalidateQueries }
vi.mock('wagmi', () => ({ usePublicClient: () => runtime.client }))
vi.mock('@/hooks/useWallet', () => ({ useWallet: () => ({ address: runtime.address, isConnected: true }) }))
vi.mock('@/lib/income-allocation-state', async original => ({ ...await original<typeof import('../src/lib/income-allocation-state')>(), readInitialIncomeAllocation: runtime.readState }))
vi.mock('@/lib/sticky-session', () => ({ verifyStickyExecution: runtime.verifyExecution }))
vi.mock('@/lib/safe-connector', () => ({ waitForSafeExecutionHash: runtime.safeExecution }))
vi.mock('@tanstack/react-query', async original => {
  const actual = await original<typeof import('@tanstack/react-query')>()
  return {
    ...actual,
    keepPreviousData: (value: unknown) => value,
    useQueryClient: () => cache,
    useQuery: (options: { queryKey: string[]; queryFn: (options: { signal: AbortSignal }) => Promise<unknown> }) => {
      runtime.queryFunctions[options.queryKey[0]] = options.queryFn
      if (runtime.useRealManifestQuery && options.queryKey[0] === 'initial-income-manifest') return actual.useQuery(options)
      return options.queryKey[0] === 'initial-income-allocation' ? runtime.allocation : options.queryKey[0] === 'initial-income-manifest' ? runtime.manifest : runtime.claimed
    },
  }
})
vi.mock('@/hooks/useSafeTx', () => ({
  txPhaseLabel: (_phase: string, labels: { idle: string }) => labels.idle,
  useSafeTx: () => {
    useEffect(() => { runtime.mounted++; return () => { runtime.unmounted++ } }, [])
    return { phase: runtime.phase, busy: runtime.phase === 'pending', isSafe: runtime.isSafe, error: runtime.error, hash: null, safeProposalHash: null, receipt: null, send: runtime.send }
  },
}))
import { InitialIncomeClaim } from '../src/components/InitialIncomeClaim'
import { homerunInitialIncomeVaultAbi } from '../src/lib/income-allocation-state'

function fixture(): { state: InitialIncomeAllocationState; manifest: FundGlobalManifest } {
  const source: FundOwnershipSnapshot = {
    chainId: 8453, projectId: 7n, blockNumber: 100n, blockHash: hash('a'), blockTimestamp: 10000n,
    creationBlockNumber: 50n, creationTransactionHash: hash('b'), owner: addr('2'), tokenAddress: null,
    totalFundSupply: 100n * units, totalCreditSupply: 100n * units, totalErc20Supply: 0n,
    holders: [{ holder: wallet, balance: 100n * units, creditBalance: 100n * units, erc20Balance: 0n }],
    evidence: { projects: addr('3'), tokens: addr('4'), controller: addr('5'), suckerRegistry: addr('6'), eventCounts: { Mint: 1 }, candidateCount: 1, bridgePolicy: 'no-historical-suckers' },
  }
  const report = {
    kind: 'homerun-global-fund-entitlements', version: 1, root: { chainId: source.chainId, projectId: source.projectId },
    claimPolicy: 'live-chain-and-pending-bridge-destination', historyAttestation: 'complete-canonical-rpc-log-history-required',
    graph: { cuts: [{ chainId: source.chainId, blockNumber: source.blockNumber, blockHash: source.blockHash, blockTimestamp: source.blockTimestamp }], projects: [{ chainId: source.chainId, projectId: source.projectId, owner: source.owner, controller: addr('5'), historicalSuckers: [] }], lanes: [] },
    projects: [{ ...source, evidence: { ...source.evidence, bridgePolicy: 'historical-graph-required' }, historicalSuckers: [] }], bridges: [],
    entitlements: [{ claimChainId: source.chainId, beneficiary: wallet, liveFundBalance: source.totalFundSupply, pendingFundBalance: 0n, fundBalance: source.totalFundSupply, sources: [{ kind: 'live-balance', chainId: source.chainId, projectId: source.projectId, amount: source.totalFundSupply }] }],
    totals: { liveFundSupply: source.totalFundSupply, pendingFundSupply: 0n, globalFundSupply: source.totalFundSupply },
  } as FundGlobalSnapshot
  const manifest = buildFundGlobalManifest(report, { helper: addr('7'), launchSalt: hash('c') })
  const allocation = manifest.allocations[0]
  const state: InitialIncomeAllocationState = {
    chainId: 8453, fundProjectId: 7n, incomeProjectId: 8n, account: null,
    blockNumber: 150n, blockHash: hash('d'), blockTimestamp: 15000n,
    deployer: addr('7'), vault: addr('8'), incomeToken: addr('9'), snapshotBlockNumber: source.blockNumber,
    snapshotBlockHash: source.blockHash, totalFundSupply: source.totalFundSupply, launchSalt: manifest.launchSalt,
    merkleRoot: allocation.merkleRoot, leafCount: 1n, manifestHash: fundGlobalManifestHash(manifest), distributionId: allocation.distributionId,
    sourceSetHash: manifest.sourceSetHash, localInitialIncomeSupply: BigInt(allocation.incomeAmount),
    manifestUri: 'ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi',
    initialIncomeSupply: 500000n * units, totalClaimed: 0n, vaultBalance: 500000n * units, remainingUnclaimed: 500000n * units,
  }
  return { state, manifest }
}
function linkedFixture(baseAmount = 25n * units, optimismAmount = 75n * units) {
  const base = fixture()
  const rows = [{ chainId: 10 as const, projectId: 77n, amount: optimismAmount }, { chainId: 8453 as const, projectId: 7n, amount: baseAmount }]
  const source = {
    kind: 'homerun-global-fund-entitlements', version: 1, root: { chainId: 8453, projectId: 7n },
    claimPolicy: 'live-chain-and-pending-bridge-destination', historyAttestation: 'complete-canonical-rpc-log-history-required',
    graph: {
      cuts: rows.map(row => ({ chainId: row.chainId, blockNumber: 100n, blockHash: hash('a'), blockTimestamp: 10000n })),
      projects: rows.map(row => ({ chainId: row.chainId, projectId: row.projectId, owner: addr('2'), controller: addr('5'), historicalSuckers: [] })),
      lanes: [],
    },
    projects: [], bridges: [],
    entitlements: rows.filter(row => row.amount > 0n).map(row => ({ claimChainId: row.chainId, beneficiary: wallet, liveFundBalance: row.amount, pendingFundBalance: 0n, fundBalance: row.amount, sources: [{ kind: 'live-balance', chainId: row.chainId, projectId: row.projectId, amount: row.amount }] })),
    totals: { liveFundSupply: baseAmount + optimismAmount, pendingFundSupply: 0n, globalFundSupply: baseAmount + optimismAmount },
  } as FundGlobalSnapshot
  const manifest = buildFundGlobalManifest(source, { helper: addr('7'), launchSalt: hash('c') })
  function stateFor(chainId: JBChainId): InitialIncomeAllocationState {
    const allocation = manifest.allocations.find(item => item.chainId === chainId)!
    const localSupply = BigInt(allocation.incomeAmount)
    return {
      ...base.state, chainId, fundProjectId: BigInt(allocation.fundProjectId), incomeProjectId: chainId === 8453 ? 8n : 88n,
      // A deterministic deployment can legitimately have the same vault address on both chains.
      merkleRoot: allocation.merkleRoot, leafCount: BigInt(allocation.leafCount), distributionId: allocation.distributionId,
      manifestHash: fundGlobalManifestHash(manifest), sourceSetHash: manifest.sourceSetHash, totalFundSupply: baseAmount + optimismAmount,
      localInitialIncomeSupply: localSupply, vaultBalance: localSupply, remainingUnclaimed: localSupply,
    }
  }
  return { manifest, stateFor }
}
function pending(hashValue?: Hex, safe = false) {
  return { version: 1, chainId: 8453, fundProjectId: '7', incomeProjectId: '8', holder: wallet, target: addr('8'), data: encodeFunctionData({ abi: homerunInitialIncomeVaultAbi, functionName: 'claim', args: [0n, wallet, 100n * units, 500000n * units, []] }), safe, submittedAt: Date.now(), afterBlock: '150', ...(hashValue ? { hash: hashValue } : {}) }
}
function claimReceipt(beneficiary: Address = wallet) {
  return {
    blockNumber: 160n, transactionHash: hash('e'), logs: [{ address: addr('8'), topics: encodeEventTopics({ abi: homerunInitialIncomeVaultAbi, eventName: 'Claimed', args: { index: 0n, beneficiary } }), data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }, { type: 'address' }], [100n * units, 500000n * units, wallet]) }],
  }
}

describe('initial INCOME claims', () => {
  let host: HTMLDivElement, root: Root, manifestCache: QueryClient
  beforeEach(() => {
    localStorage.clear()
    runtime.useRealManifestQuery = false
    manifestCache = new QueryClient({ defaultOptions: { queries: { retryDelay: 0, gcTime: Infinity } } })
    runtime.address = wallet; runtime.isSafe = false; runtime.phase = 'idle'; runtime.error = null
    runtime.mounted = 0; runtime.unmounted = 0
    for (const mock of [runtime.send, runtime.readState, runtime.verifyExecution, runtime.safeExecution, runtime.invalidateQueries, runtime.client.readContract, runtime.client.getBlockNumber, runtime.client.getTransactionReceipt]) mock.mockReset()
    const data = fixture()
    runtime.state = data.state
    runtime.allocation = { data: data.state, isError: false, isPending: false, isPlaceholderData: false, refetch: vi.fn() }
    runtime.manifest = { data: data.manifest, isError: false, isPending: false, refetch: vi.fn() }
    runtime.claimed = { data: false, isError: false, refetch: vi.fn() }
    runtime.readState.mockImplementation(async () => runtime.state)
    runtime.client.readContract.mockResolvedValue(false)
    runtime.client.getBlockNumber.mockResolvedValue(150n)
    runtime.verifyExecution.mockRejectedValue(new Error('The receipt is unavailable'))
    runtime.safeExecution.mockImplementation(() => new Promise(() => undefined))
    runtime.invalidateQueries.mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'locks', { configurable: true, value: { request: async (_key: string, _options: unknown, callback: (lock: object) => Promise<void>) => callback({}) } })
    host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  })
  afterEach(async () => { await act(async () => root.unmount()); host.remove(); manifestCache.clear(); vi.unstubAllGlobals() })
  async function render(chainId: JBChainId = 8453, fundProjectId = 7n, incomeProjectId = 8n) {
    await act(async () => root.render(<QueryClientProvider client={manifestCache}><InitialIncomeClaim chainId={chainId} fundProjectId={fundProjectId} incomeProjectId={incomeProjectId} /></QueryClientProvider>))
  }
  async function settleManifest() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 25)) }) }
  function claimButton() { return [...host.querySelectorAll('button')].find(button => button.textContent === 'Review initial INCOME claim')! }
  async function submit() { await act(async () => claimButton().click()) }
  async function setInput(input: HTMLInputElement, value: string) {
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })) })
  }
  async function recover() {
    await setInput(host.querySelector('input[placeholder="0x…"]')!, hash('e'))
    await act(async () => [...host.querySelectorAll('button')].find(button => button.textContent === 'Verify execution')!.click())
  }

  it('lets an unclaimed-credit holder review the exact initial claim without activation, staking, or approvals', async () => {
    await render()
    expect(claimButton().disabled).toBe(false)
    expect(host.textContent).toContain('including inactive balances, unclaimed credits, and pending bridge transfers')
    expect(host.textContent).toContain('500000 INCOME')
    await submit()
    expect(runtime.send).toHaveBeenCalledTimes(1)
    const [request, options] = runtime.send.mock.calls[0]
    expect(request.address).toBe(addr('8'))
    expect(request.functionName).toBe('claim')
    expect(request.args).toEqual([0n, wallet, 100n * units, 500000n * units, []])
    expect(options.reviewNotice).toContain('does not require FUND approval, staking, delegation, burning, or vesting')
    expect(localStorage.getItem(pendingKey)).toBeNull()
  })

  it('claims only the local portion when the same wallet has allocations on two chains', async () => {
    const linked = linkedFixture()
    runtime.manifest = { ...runtime.manifest, data: linked.manifest }
    runtime.state = linked.stateFor(8453)
    runtime.allocation = { ...runtime.allocation, data: runtime.state }
    await render()
    expect([...host.querySelectorAll('dd')].map(node => node.textContent)).toEqual(['125000 INCOME', '25'])
    expect(host.textContent).toContain('125000 initial INCOME allocated on Base')
    await submit()
    const baseCall = runtime.send.mock.calls[0][0]
    expect(baseCall.chainId).toBe(8453)
    expect(baseCall.args.slice(0, 4)).toEqual([0n, wallet, 25n * units, 125000n * units])

    // Reuse the mounted component and same wallet/vault/manifest addresses while
    // navigating to its separately verified counterpart on Optimism.
    runtime.state = linked.stateFor(10)
    runtime.allocation = { ...runtime.allocation, data: runtime.state }
    await render(10, 77n, 88n)
    expect([...host.querySelectorAll('dd')].map(node => node.textContent)).toEqual(['375000 INCOME', '75'])
    expect(host.textContent).toContain('375000 initial INCOME allocated on Optimism')
    await submit()
    const optimismCall = runtime.send.mock.calls[1][0]
    expect(optimismCall.chainId).toBe(10)
    expect(optimismCall.args.slice(0, 4)).toEqual([0n, wallet, 75n * units, 375000n * units])
    expect(baseCall.args[3] + optimismCall.args[3]).toBe(500000n * units)
  })

  it('offers no claim on an empty allocation chain even when the same address can claim elsewhere', async () => {
    const linked = linkedFixture(0n, 100n * units)
    runtime.manifest = { ...runtime.manifest, data: linked.manifest }
    runtime.state = linked.stateFor(8453)
    runtime.allocation = { ...runtime.allocation, data: runtime.state }
    await render()
    expect(host.textContent).toContain('0 initial INCOME allocated on Base')
    expect(host.textContent).toContain('This wallet has no allocation on this chain')
    expect(claimButton()).toBeUndefined()
    expect(runtime.send).not.toHaveBeenCalled()

    runtime.state = linked.stateFor(10)
    runtime.allocation = { ...runtime.allocation, data: runtime.state }
    await render(10, 77n, 88n)
    expect(claimButton().disabled).toBe(false)
    expect([...host.querySelectorAll('dd')].map(node => node.textContent)).toEqual(['500000 INCOME', '100'])
  })

  it.each(['gateway cache', 'imported file'] as const)('reverifies the destination vault before displaying a claim after a chain switch using %s', async source => {
    const linked = linkedFixture()
    runtime.useRealManifestQuery = true
    runtime.state = linked.stateFor(8453)
    runtime.allocation = { ...runtime.allocation, data: runtime.state }
    const gateway = vi.fn(async () => new Response(JSON.stringify(linked.manifest), { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', gateway)
    await render(); await settleManifest()
    expect(claimButton().disabled).toBe(false)
    expect([...host.querySelectorAll('dd')].map(node => node.textContent)).toEqual(['125000 INCOME', '25'])

    if (source === 'imported file') {
      const file = new File(['unused'], 'global-snapshot.json', { type: 'application/json' })
      Object.defineProperty(file, 'text', { value: async () => JSON.stringify(linked.manifest) })
      const input = host.querySelector('input[type="file"]')!
      Object.defineProperty(input, 'files', { configurable: true, value: [file] })
      await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })))
      expect(claimButton().disabled).toBe(false)
    }

    const destination = { ...linked.stateFor(10), merkleRoot: hash('e') }
    expect(destination.vault).toBe(runtime.state!.vault)
    expect(destination.manifestHash).toBe(runtime.state!.manifestHash)
    runtime.state = destination
    runtime.allocation = { ...runtime.allocation, data: destination }
    await render(10, 77n, 88n); await settleManifest()
    expect(host.textContent).toContain('The global manifest does not match the verified initial INCOME vault on this chain.')
    expect(claimButton()).toBeUndefined()
    expect(host.querySelectorAll('dd')).toHaveLength(0)
    expect(gateway.mock.calls.length).toBeGreaterThan(1)
    expect(runtime.send).not.toHaveBeenCalled()
  })

  it('rechecks immutable binding and claimed status after the user reviews the transaction', async () => {
    runtime.send.mockImplementation(async (_request, options: TxSendOptions) => {
      runtime.state = { ...runtime.state!, vault: addr('a') }
      await options.reverify!(_request)
    })
    await render(); await submit()
    expect(host.textContent).toContain('The verified initial allocation changed')
    expect(localStorage.getItem(pendingKey)).toBeNull()
  })

  it('retains an ambiguous wallet submission across remount and blocks duplicate claims', async () => {
    runtime.send.mockImplementation(async (_request, options: TxSendOptions) => { await options.beforeWrite!(); return null })
    await render(); await submit()
    expect(JSON.parse(localStorage.getItem(pendingKey)!)).toMatchObject({ holder: wallet, afterBlock: '150' })
    await act(async () => root.unmount()); root = createRoot(host); await render()
    expect(claimButton().disabled).toBe(true)
    expect(host.textContent).toContain('The wallet may have submitted this claim')
    expect(runtime.send).toHaveBeenCalledTimes(1)
  })

  it('releases a saved attempt only on a typed rejection reported by the shared writer', async () => {
    runtime.send.mockImplementation(async (_request, options: TxSendOptions) => { await options.beforeWrite!(); await options.onWriteRejected!(); return null })
    await render(); await submit()
    expect(localStorage.getItem(pendingKey)).toBeNull()
    expect(claimButton().disabled).toBe(false)
    expect(host.textContent).not.toContain('The wallet may have submitted')
  })

  it('does not treat a Safe proposal as an executed claim and retains recovery during RPC/account changes', async () => {
    localStorage.setItem(pendingKey, JSON.stringify(pending(hash('f'), true)))
    await render()
    expect(host.textContent).toContain('Proposed to Safe')
    expect(runtime.safeExecution).toHaveBeenCalledWith(8453, hash('f'), expect.objectContaining({ signal: expect.any(AbortSignal) }))
    expect(runtime.verifyExecution).not.toHaveBeenCalled()
    runtime.address = addr('2')
    runtime.allocation = { ...runtime.allocation, data: undefined, isError: true, error: new Error('RPC offline') }
    await render()
    expect(runtime.mounted).toBe(1)
    expect(runtime.unmounted).toBe(0)
    expect(host.textContent).toContain('Proposed to Safe')
    expect(localStorage.getItem(pendingKey)).not.toBeNull()
  })

  it('rejects successful receipts whose allocation event belongs to a different beneficiary', async () => {
    localStorage.setItem(pendingKey, JSON.stringify(pending()))
    runtime.verifyExecution.mockResolvedValue('confirmed')
    runtime.client.getTransactionReceipt.mockResolvedValue(claimReceipt(addr('2')))
    runtime.client.readContract.mockResolvedValue(true)
    await render(); await recover()
    expect(host.textContent).toContain('receipt does not prove this exact allocation')
    expect(localStorage.getItem(pendingKey)).not.toBeNull()
    expect(host.textContent).not.toContain('Initial INCOME claim confirmed onchain')
  })

  it('confirms only an exact executed claim event and onchain claimed bitmap, then refreshes balances', async () => {
    localStorage.setItem(pendingKey, JSON.stringify(pending()))
    runtime.verifyExecution.mockResolvedValue('confirmed')
    runtime.client.getTransactionReceipt.mockResolvedValue(claimReceipt())
    runtime.client.readContract.mockResolvedValue(true)
    await render(); await recover()
    expect(runtime.verifyExecution).toHaveBeenCalledWith(runtime.client, expect.objectContaining({ afterBlock: '150', data: pending().data, target: addr('8'), holder: wallet }), hash('e'))
    expect(localStorage.getItem(pendingKey)).toBeNull()
    expect(host.textContent).toContain('Initial INCOME claim confirmed onchain')
    expect(claimButton().disabled).toBe(true)
    expect(runtime.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['income-project'] })
  })

  it('checks the complete imported manifest against the immutable vault hash', async () => {
    runtime.manifest = { ...runtime.manifest, data: undefined, isError: true, error: new Error('Gateway offline') }
    await render()
    const file = new File(['unused'], 'snapshot.json', { type: 'application/json' })
    const unrelated = fixture().manifest
    const report = unrelated.snapshot as { graph: { cuts: { blockTimestamp: string }[] } }
    report.graph.cuts[0].blockTimestamp = '99999'
    Object.defineProperty(file, 'text', { value: async () => JSON.stringify(unrelated) })
    const input = host.querySelector('input[type="file"]')!
    Object.defineProperty(input, 'files', { configurable: true, value: [file] })
    await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })))
    expect(host.textContent).toContain('The global manifest does not match its complete deterministic allocations and commitments.')
    expect(host.textContent).not.toContain('Your initial allocation500000')
    expect(claimButton()).toBeUndefined()
  })

  it('accepts a matching local manifest during a gateway outage', async () => {
    runtime.manifest = { ...runtime.manifest, data: undefined, isError: true, error: new Error('Gateway offline') }
    await render()
    const file = new File(['unused'], 'snapshot.json', { type: 'application/json' })
    Object.defineProperty(file, 'text', { value: async () => JSON.stringify(fixture().manifest) })
    const input = host.querySelector('input[type="file"]')!
    Object.defineProperty(input, 'files', { configurable: true, value: [file] })
    await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })))
    expect(claimButton().disabled).toBe(false)
    expect(host.textContent).toContain('500000 INCOME')
  })

  it('rejects another tab’s submission arriving while the review is open', async () => {
    runtime.send.mockImplementation(async (_request, options: TxSendOptions) => {
      localStorage.setItem(pendingKey, JSON.stringify(pending()))
      await options.beforeWrite!()
    })
    await render(); await submit()
    expect(host.textContent).toContain('Another tab already recorded an initial claim submission')
    expect(localStorage.getItem(pendingKey)).not.toBeNull()
  })

  it('bounds the automatic download before reading its body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, headers: new Headers({ 'content-length': String(33 * 1024 * 1024) }) })))
    await render()
    await expect(runtime.queryFunctions['initial-income-manifest']({ signal: new AbortController().signal })).rejects.toThrow('too large for automatic loading')
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining('https://juicebox.center/ipfs/'), expect.objectContaining({ redirect: 'error' }))
  })
})
