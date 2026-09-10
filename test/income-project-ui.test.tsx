import { act, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { zeroAddress, type Address, type Hex, type TransactionReceipt } from 'viem'
import type { IncomeProjectState } from '../src/lib/income-state'
import type { IncomeReservedSnapshot } from '../src/lib/income-reserved'

const runtime = vi.hoisted(() => ({
  address: '0x1111111111111111111111111111111111111111' as Address,
  query: {} as Record<string, unknown>,
  sticky: null as { stickyProjectId: bigint } | null,
  stickyError: false, stickyMounted: 0, stickyUnmounted: 0,
  discoveredFund: null as bigint | null, discoveryError: false,
  payQuote: { beneficiaryTokenCount: 0n, reservedTokenCount: 0n },
  mounted: 0, unmounted: 0, busy: false, phase: 'idle',
  reserved: undefined as IncomeReservedSnapshot | undefined, reservedError: false,
  reservedReceipt: undefined as { tokenCount: bigint; hookFailures: number; projectFallbacks: number } | undefined,
  receipt: null as TransactionReceipt | null, safeProposalHash: null as Hex | null,
  readReserved: vi.fn(),
  invalidateQueries: vi.fn(), send: vi.fn(), readState: vi.fn(), autoIssuance: vi.fn(),
}))
vi.mock('@/components/ProjectParticipants', () => ({ ProjectParticipants: () => <span>Indexed holders</span> }))
vi.mock('@/components/ProjectPayerAddresses', () => ({ ProjectPayerAddresses: () => <span>Project payer addresses</span> }))
vi.mock('@/components/ProjectShop', () => ({ ProjectShop: () => <span>Project shop</span> }))
vi.mock('wagmi', () => ({ usePublicClient: () => ({}) }))
vi.mock('@/hooks/useWallet', () => ({ useWallet: () => ({ address: runtime.address, isConnected: true }) }))
vi.mock('@/components/InitialIncomeClaim', () => ({ InitialIncomeClaim: ({ fundProjectId, incomeProjectId }: { fundProjectId: bigint; incomeProjectId: bigint }) => <div>Initial claim FUND {fundProjectId.toString()} INCOME {incomeProjectId.toString()}</div> }))
vi.mock('@/components/StickyHolder', () => ({ StickyHolder: ({ stickyProjectId }: { stickyProjectId: bigint }) => {
  useEffect(() => { runtime.stickyMounted++; return () => { runtime.stickyUnmounted++ } }, [])
  return <div>Verified Sticky {stickyProjectId.toString()}<button type="button">Sticky action</button></div>
} }))
vi.mock('@/components/IncomeBridgeActions', () => ({ IncomeBridgeActions: () => <span>INCOME bridge</span> }))
vi.mock('@/components/IncomeLoanTools', () => ({ IncomeLoanTools: () => <span>Additional loan operations</span> }))
vi.mock('@/lib/income-state', async importOriginal => ({ ...await importOriginal<typeof import('../src/lib/income-state')>(), readIncomeProjectState: runtime.readState, readIncomeAutoIssuance: runtime.autoIssuance }))
vi.mock('@/lib/income-reserved', async importOriginal => ({ ...await importOriginal<typeof import('../src/lib/income-reserved')>(), readIncomeReservedTokens: runtime.readReserved }))
vi.mock('@bananapus/nana-sdk-core/v6', async importOriginal => ({ ...await importOriginal<typeof import('@bananapus/nana-sdk-core/v6')>(), previewPay: () => runtime.payQuote }))
vi.mock('@tanstack/react-query', () => ({
  keepPreviousData: (value: unknown) => value,
  useQueryClient: () => ({ invalidateQueries: runtime.invalidateQueries }),
  useQuery: ({ queryKey }: { queryKey: unknown[] }) => queryKey[0] === 'income-project' ? runtime.query
    : queryKey[0] === 'income-fund-binding' ? { data: runtime.discoveredFund, isError: runtime.discoveryError, refetch: vi.fn() }
    : queryKey[0] === 'income-sticky-binding' ? { data: runtime.sticky, isError: runtime.stickyError }
    : queryKey[0] === 'income-pay' ? { data: runtime.payQuote, isError: false }
    : queryKey[0] === 'income-reserved' ? { data: runtime.reserved, isError: runtime.reservedError, error: new Error('RPC unavailable'), refetch: vi.fn() }
    : queryKey[0] === 'income-reserved-receipt' ? { data: runtime.reservedReceipt, isError: false }
      : { data: undefined, isError: false, isFetching: false },
}))
vi.mock('@/hooks/useSafeTx', () => ({
  txPhaseLabel: (_phase: string, labels: { idle: string }) => labels.idle,
  useSafeTx: () => {
    useEffect(() => { runtime.mounted += 1; return () => { runtime.unmounted += 1 } }, [])
    return { phase: runtime.phase, busy: runtime.busy, error: null, hash: runtime.busy ? `0x${'a'.repeat(64)}` : null, safeProposalHash: runtime.safeProposalHash, receipt: runtime.receipt, send: runtime.send, reset: vi.fn() }
  },
}))

import { IncomeProject } from '../src/components/IncomeProject'

function state(): IncomeProjectState {
  const terminal = '0x3333333333333333333333333333333333333333'
  return {
    chainId: 1, projectId: 7n, blockNumber: 100n, blockHash: `0x${'1'.repeat(64)}`, blockTimestamp: 1_800_000_000n,
    owner: '0x2222222222222222222222222222222222222222', operator: runtime.address, account: runtime.address,
    controller: '0x4444444444444444444444444444444444444444',
    ruleset: { id: 1, start: 1 }, metadata: { pausePay: false, cashOutTaxRate: 0, pauseCreditTransfers: false, reservedPercent: 8000 },
    projectUri: '', tokenAddress: '0x5555555555555555555555555555555555555555', totalSupply: 100n * 10n ** 18n,
    tokenSymbol: 'INCOME', tokenDecimals: 18, totalCreditSupply: 0n, pendingReservedTokens: 0n, totalSupplyWithReservedTokens: 100n * 10n ** 18n,
    creditBalance: 0n, erc20Balance: 10n * 10n ** 18n, totalBalance: 10n * 10n ** 18n,
    terminals: [terminal], accountingContexts: [{ token: '0x000000000000000000000000000000000000EEEe', decimals: 18, currency: 61166, terminal, primaryTerminal: terminal, isPrimary: true, balance: 100n, surplus: 100n, symbol: 'ETH' }],
    cashOutDelay: 0n, cashOutsAvailable: true, isOperator: true, rewards: null, rewardIssue: null, issues: [],
  } as unknown as IncomeProjectState
}

describe('INCOME transaction surfaces', () => {
  let root: Root
  let host: HTMLDivElement
  beforeEach(() => {
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }) })
    window.history.replaceState(null, '', '/')
    runtime.mounted = 0; runtime.unmounted = 0; runtime.busy = false; runtime.phase = 'idle'; runtime.sticky = null
    runtime.stickyError = false; runtime.stickyMounted = 0; runtime.stickyUnmounted = 0
    runtime.discoveredFund = null; runtime.discoveryError = false
    runtime.address = '0x1111111111111111111111111111111111111111'
    runtime.send.mockReset(); runtime.autoIssuance.mockReset(); runtime.readState.mockReset()
    runtime.readReserved.mockReset(); runtime.invalidateQueries.mockClear()
    runtime.reserved = undefined; runtime.reservedError = false; runtime.reservedReceipt = undefined
    runtime.receipt = null; runtime.safeProposalHash = null
    runtime.query = { data: state(), isError: false, isPending: false, isFetching: false, isPlaceholderData: false, refetch: vi.fn() }
    runtime.payQuote = { beneficiaryTokenCount: 1n * 10n ** 18n, reservedTokenCount: 4n * 10n ** 18n }
    runtime.readState.mockImplementation(() => runtime.query.data)
    host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  })
  afterEach(async () => { await act(async () => root.unmount()); host.remove() })
  async function tab(label: string) { const target = [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(button => button.textContent === label); expect(target, `Missing ${label} tab`).toBeDefined(); await act(async () => target!.click()) }
  async function visitActions() { for (const label of ['Owners', 'Accounts', 'You', 'Market', 'Settlement', 'Splits', 'Loans', 'Overview']) await tab(label) }
  async function render() { await act(async () => root.render(<IncomeProject chainId={1} projectId={7n} />)); await visitActions() }
  function section(title: string) { return [...host.querySelectorAll('section')].find(element => element.querySelector('h3')?.textContent === title)! }
  function pendingReserved() {
    const current = state()
    const snapshot: IncomeReservedSnapshot = { chainId: 1, projectId: 7n, blockNumber: 100n, blockHash: current.blockHash, controller: current.controller, owner: current.owner, tokenAddress: current.tokenAddress, rulesetId: 1n, pending: 8n * 10n ** 18n, splits: [{ percent: 1_000_000_000, beneficiary: current.owner, projectId: 0n, hook: zeroAddress, preferAddToBalance: false, lockedUntil: 0 }] }
    runtime.reserved = snapshot; runtime.readReserved.mockResolvedValue(snapshot)
    return snapshot
  }
  async function setInput(input: HTMLInputElement, value: string) {
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })) })
  }

  it('mounts initial claims separately and uses the verified Sticky project ID for ongoing rewards', async () => {
    runtime.sticky = { stickyProjectId: 91n }
    await act(async () => root.render(<IncomeProject chainId={1} projectId={7n} fundProjectId={3n} />)); await visitActions()
    expect(host.textContent).toContain('Initial claim FUND 3 INCOME 7')
    expect(host.textContent).toContain('Verified Sticky 91')
    expect(host.textContent).not.toContain('self-delegate')
  })

  it('does not offer a Sticky write target when the connection is unverified', async () => {
    await act(async () => root.render(<IncomeProject chainId={1} projectId={7n} fundProjectId={3n} />)); await visitActions()
    expect(host.textContent).toContain('Initial claim FUND 3 INCOME 7')
    expect(host.textContent).toContain('No verified Sticky reward connection')
    expect(host.textContent).not.toContain('Verified Sticky')
    expect(runtime.send).not.toHaveBeenCalled()
  })

  it('discovers holder operations from a canonical standalone INCOME link without a FUND query parameter', async () => {
    runtime.discoveredFund = 3n; runtime.sticky = { stickyProjectId: 91n }
    await render()
    expect(host.textContent).toContain('Initial claim FUND 3 INCOME 7')
    expect(host.textContent).toContain('Verified Sticky 91')
    runtime.discoveryError = true
    await render()
    expect(runtime.stickyUnmounted).toBe(0)
    expect(host.textContent).toContain('Initial claim FUND 3 INCOME 7')
  })

  it('keeps INCOME transactions reachable when historical FUND discovery is unavailable', async () => {
    runtime.discoveryError = true
    await render()
    expect(host.textContent).toContain('The original FUND connection could not be discovered')
    expect(host.textContent).not.toContain('Initial claim FUND')
    expect(host.querySelector('fieldset[aria-label="INCOME transactions"]')?.hasAttribute('disabled')).toBe(false)
    expect(section('Pay the project')).toBeDefined()
  })

  it('retains Sticky receipt watchers through failed binding reads while disabling stale actions', async () => {
    const renderWithFund = async (fundProjectId = 3n) => { await act(async () => root.render(<IncomeProject chainId={1} projectId={7n} fundProjectId={fundProjectId} />)); await visitActions() }
    runtime.sticky = { stickyProjectId: 91n }
    await renderWithFund()
    expect(runtime.stickyMounted).toBe(1)
    for (const loseCachedBinding of [false, true]) {
      runtime.stickyError = true
      if (loseCachedBinding) runtime.sticky = null
      await renderWithFund()
      expect(host.textContent).toContain('Verified Sticky 91')
      expect(host.querySelector('fieldset[aria-label="Verified Sticky connection"]')?.hasAttribute('disabled')).toBe(true)
      expect(runtime.stickyUnmounted).toBe(0)
    }
    runtime.stickyError = false; runtime.sticky = { stickyProjectId: 91n }
    await renderWithFund()
    expect(runtime.stickyMounted).toBe(1)
    expect(host.querySelector('fieldset[aria-label="Verified Sticky connection"]')?.hasAttribute('disabled')).toBe(false)
    runtime.sticky = null
    await renderWithFund(4n)
    expect(host.textContent).not.toContain('Verified Sticky 91')
    expect(runtime.stickyUnmounted).toBe(1)
  })

  it('keeps submitted receipt watchers mounted when a background read fails', async () => {
    runtime.busy = true; runtime.phase = 'pending'
    await render()
    const mounted = runtime.mounted
    expect(mounted).toBeGreaterThan(0)
    runtime.query = { ...runtime.query, isError: true, error: new Error('RPC offline') }
    await render()
    expect(runtime.unmounted).toBe(0)
    expect(runtime.mounted).toBe(mounted)
    expect(host.querySelector('fieldset[aria-label="INCOME transactions"]')?.hasAttribute('disabled')).toBe(true)
    expect(host.textContent).toContain('Waiting for onchain confirmation')
  })

  it('preserves pending status and disables stale account data while another wallet loads', async () => {
    runtime.busy = true; runtime.phase = 'pending'
    await render()
    const mounted = runtime.mounted
    runtime.address = '0x9999999999999999999999999999999999999999'
    runtime.query = { ...runtime.query, data: undefined, isPending: true }
    await render()
    expect(runtime.mounted).toBe(mounted)
    expect(runtime.unmounted).toBe(0)
    expect(host.querySelector('fieldset[aria-label="INCOME transactions"]')?.hasAttribute('disabled')).toBe(true)
  })

  it('never silently substitutes the connected wallet for a malformed allocation beneficiary', async () => {
    await render()
    const allocation = section('Collect a scheduled allocation')
    const inputs = allocation.querySelectorAll('input')
    await setInput(inputs[0], '123')
    await setInput(inputs[1], '0xnotanaddress')
    expect(allocation.querySelector('button')?.disabled).toBe(true)
    expect(runtime.autoIssuance).not.toHaveBeenCalled()
    await setInput(inputs[1], zeroAddress)
    expect(allocation.querySelector('button')?.disabled).toBe(true)
  })

  it('supports an explicit zero-customer allocation with a mandatory no-tokens notice', async () => {
    runtime.query = { ...runtime.query, data: { ...state(), metadata: { ...state().metadata, reservedPercent: 10000 } } }
    runtime.payQuote = { beneficiaryTokenCount: 0n, reservedTokenCount: 10n * 10n ** 18n }
    await render()
    const pay = section('Pay the project')
    await setInput(pay.querySelector('input')!, '1')
    expect(pay.textContent).toContain('gives you no INCOME')
    const button = pay.querySelector('button')!
    expect(button.disabled).toBe(false)
    await act(async () => button.click())
    expect(runtime.send).toHaveBeenCalledTimes(1)
    const [request, options] = runtime.send.mock.calls[0]
    expect(request.functionName).toBe('pay')
    expect(request.args[4]).toBe(0n)
    expect(options.reviewNotice).toContain('You receive no INCOME')
  })

  it('does not treat an unexpected zero quote as permission to send an unprotected payment', async () => {
    runtime.payQuote = { beneficiaryTokenCount: 0n, reservedTokenCount: 10n * 10n ** 18n }
    await render()
    const pay = section('Pay the project')
    await setInput(pay.querySelector('input')!, '1')
    expect(pay.querySelector('button')?.disabled).toBe(true)
    expect(runtime.send).not.toHaveBeenCalled()
  })

  it('offers permissionless reserved distribution to a non-operator with no INCOME balance', async () => {
    pendingReserved()
    runtime.query = { ...runtime.query, data: { ...state(), operator: null, isOperator: false, totalBalance: 0n, erc20Balance: 0n } }
    await render()
    const reserved = section('Distribute reserved INCOME')
    expect(reserved.textContent).toContain('8 INCOME pending')
    expect(reserved.querySelector('button')?.disabled).toBe(false)
    await act(async () => reserved.querySelector('button')!.click())
    const [request, options] = runtime.send.mock.calls[0]
    expect(request.functionName).toBe('sendReservedTokensToSplitsOf')
    expect(request.args).toEqual([7n])
    expect(options.reviewNotice).toContain(state().owner)
    expect(options.reviewNotice).toContain('amount or ruleset can change')
    expect(options.reviewNotice).toContain('does not immediately make holder rewards collectible')
    expect(options.reviewedInParent).toBeUndefined()
    expect(runtime.readReserved).toHaveBeenCalledOnce()
    await options.reverify()
    expect(runtime.readReserved).toHaveBeenCalledTimes(2)
  })

  it('blocks a changed reserve amount or recipients at the shared pre-wallet boundary', async () => {
    const snapshot = pendingReserved()
    await render()
    await act(async () => section('Distribute reserved INCOME').querySelector('button')!.click())
    const [, options] = runtime.send.mock.calls[0]
    runtime.readReserved.mockResolvedValueOnce({ ...snapshot, pending: 0n })
    await expect(options.reverify()).rejects.toThrow('changed during review')
    runtime.readReserved.mockResolvedValueOnce({ ...snapshot, splits: [{ ...snapshot.splits[0], beneficiary: runtime.address }] })
    await expect(options.reverify()).rejects.toThrow('recipients changed')
  })

  it('shows the literal hook beneficiary while direct zero-address splits use the caller', async () => {
    const snapshot = pendingReserved()
    runtime.reserved = { ...snapshot, splits: [
      { ...snapshot.splits[0], percent: 500_000_000, beneficiary: zeroAddress, hook: state().tokenAddress! },
      { ...snapshot.splits[0], percent: 500_000_000, beneficiary: zeroAddress },
    ] }
    await render()
    const reserved = section('Distribute reserved INCOME')
    expect(reserved.textContent).toContain(`Hook ${state().tokenAddress}, beneficiary ${zeroAddress}`)
    expect(reserved.textContent).toContain('the caller')
  })

  it('does not prepare an empty reserved distribution and disables stale failed reads', async () => {
    const snapshot = pendingReserved()
    runtime.reserved = { ...snapshot, pending: 0n }
    await render()
    expect(section('Distribute reserved INCOME').querySelector('button')?.disabled).toBe(true)
    runtime.reserved = snapshot; runtime.reservedError = true
    await render()
    expect(section('Distribute reserved INCOME').querySelector<HTMLButtonElement>('.btn-primary')?.disabled).toBe(true)
    expect(runtime.send).not.toHaveBeenCalled()
  })

  it('refreshes pending reserves and Sticky rewards but reports hook failures separately', async () => {
    pendingReserved()
    runtime.receipt = { transactionHash: `0x${'b'.repeat(64)}`, blockNumber: 101n, status: 'success' } as TransactionReceipt
    runtime.phase = 'success'
    runtime.reservedReceipt = { tokenCount: 9n * 10n ** 18n, hookFailures: 1, projectFallbacks: 1 }
    await render()
    const reserved = section('Distribute reserved INCOME')
    expect(reserved.textContent).toContain('Distribution confirmed: 9 INCOME processed')
    expect(reserved.textContent).toContain('does not confirm reward delivery')
    expect(reserved.textContent).toContain('fallback recipients')
    expect(runtime.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['income-reserved', 1, '7'] })
    expect(runtime.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['sticky-rewards', 1] })
  })

  it('never presents a Safe proposal as confirmed reserved delivery', async () => {
    pendingReserved()
    runtime.phase = 'pending'; runtime.safeProposalHash = `0x${'b'.repeat(64)}`
    await render()
    const reserved = section('Distribute reserved INCOME')
    expect(reserved.textContent).toContain('Execution and onchain confirmation are still required')
    expect(reserved.textContent).not.toContain('Distribution confirmed')
  })
})
