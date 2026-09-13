import './dialog-shim'
import { act, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { zeroAddress, type Address, type Hex, type TransactionReceipt } from 'viem'
import type { IncomeProjectState } from '../src/lib/income-state'
import type { IncomeReservedSnapshot } from '../src/lib/income-reserved'
import type { FundProjectState } from '../src/lib/fund-state'
import { parseFundProjectMetadata, type FundProjectMetadata } from '../src/lib/fund-project-metadata'
import type { CurrentProjectOperator } from '../src/lib/project-operator-profile'

const runtime = vi.hoisted(() => ({
  address: '0x1111111111111111111111111111111111111111' as Address,
  query: {} as Record<string, unknown>,
  operator: undefined as CurrentProjectOperator | undefined, operatorError: false,
  confirmedBlock: 0n,
  fundConfirmedBlock: 0n,
  fund: undefined as FundProjectState | undefined,
  details: {} as Record<string, FundProjectMetadata>,
  sticky: null as { stickyProjectId: bigint } | null,
  stickyError: false, stickyMounted: 0, stickyUnmounted: 0,
  discoveredFund: null as bigint | null, discoveryError: false,
  payQuote: { beneficiaryTokenCount: 0n, reservedTokenCount: 0n },
  mounted: 0, unmounted: 0, busy: false, phase: 'idle',
  reserved: undefined as IncomeReservedSnapshot | undefined, reservedError: false,
  reservedReceipt: undefined as { tokenCount: bigint; hookFailures: number; projectFallbacks: number } | undefined,
  receipt: null as TransactionReceipt | null, safeProposalHash: null as Hex | null,
  readReserved: vi.fn(), queries: vi.fn(),
  invalidateQueries: vi.fn(), send: vi.fn(), readState: vi.fn(), autoIssuance: vi.fn(),
}))
vi.mock('@/components/ProjectParticipants', () => ({ ProjectParticipants: () => <span>Indexed holders</span> }))
vi.mock('@/components/ProjectPayerAddresses', () => ({ ProjectPayerAddresses: () => <span>Project payer addresses</span> }))
vi.mock('@/components/ProjectShop', () => ({ ProjectShop: ({ chainId, projectId, tokenLabel }: { chainId: number; projectId: bigint; tokenLabel: string }) => <span data-testid={`shop-${tokenLabel}`} data-chain-id={chainId} data-project-id={projectId.toString()}>Project shop</span> }))
vi.mock('@/components/ProjectMetadataEditor', () => ({ ProjectMetadataEditor: ({ chainId, projectId, unavailable, inheritedMetadataUri, label }: { chainId: number; projectId: bigint; unavailable?: boolean; inheritedMetadataUri?: string; label?: string }) => <section data-testid="metadata-editor" data-chain-id={chainId} data-project-id={projectId.toString()} data-inherited-uri={inheritedMetadataUri}><button disabled={unavailable}>{label ?? 'Edit project details'}</button></section> }))
vi.mock('@/components/ProjectOwnershipEditor', () => ({ ProjectOwnershipEditor: ({ chainId, projectId, unavailable }: { chainId: number; projectId: bigint; unavailable?: boolean }) => <section data-testid="ownership-editor" data-chain-id={chainId} data-project-id={projectId.toString()}><button disabled={unavailable}>Edit project control</button></section> }))
vi.mock('@/components/ProjectPermissionsEditor', () => ({ ProjectPermissionsEditor: ({ chainId, projectId, unavailable }: { chainId: number; projectId: bigint; unavailable?: boolean }) => <section data-testid="permissions-editor" data-chain-id={chainId} data-project-id={projectId.toString()}><button disabled={unavailable}>Edit permissions</button></section> }))
vi.mock('@/components/ProjectSplitsEditor', () => ({ ProjectSplitsEditor: ({ chainId, projectId, phase, unavailable }: { chainId: number; projectId: bigint; phase: string; unavailable?: boolean }) => <section data-testid="splits-editor" data-chain-id={chainId} data-project-id={projectId.toString()} data-phase={phase}><button disabled={unavailable}>Edit splits</button></section> }))
vi.mock('wagmi', () => ({ usePublicClient: () => ({}) }))
vi.mock('@/hooks/useReviewedPermit2Signature', () => ({ useReviewedPermit2Signature: () => ({ signPermit2Async: vi.fn() }) }))
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
vi.mock('@/lib/project-pay-quote', () => ({ prepareProjectPayQuote: async () => ({ kind: 'pay', terminal: '0x3333333333333333333333333333333333333333', preview: runtime.payQuote, minimumTokenCount: runtime.payQuote.beneficiaryTokenCount * 99n / 100n, reservedTokenCount: runtime.payQuote.reservedTokenCount, blockNumber: 100n }), readProjectPayTokenOptions: vi.fn() }))
vi.mock('@tanstack/react-query', () => ({
  keepPreviousData: (value: unknown) => value,
  useQueryClient: () => ({ invalidateQueries: runtime.invalidateQueries }),
  useQuery: (options: { queryKey: unknown[]; enabled?: boolean }) => {
    runtime.queries(options)
    const { queryKey } = options
    return queryKey[0] === 'income-project' ? runtime.query
    : queryKey[0] === 'project-operator-profile' ? { data: runtime.operator, isError: runtime.operatorError, isPending: false, refetch: vi.fn() }
    : queryKey[0] === 'project-admin-confirmed-block' ? { data: queryKey[2] === '7' ? runtime.confirmedBlock : queryKey[2] === runtime.discoveredFund?.toString() ? runtime.fundConfirmedBlock : 0n }
    : queryKey[0] === 'fund-project' ? { data: runtime.fund, isError: false }
    : queryKey[0] === 'fund-project-metadata' ? { data: runtime.details[String(queryKey[1])], isError: false }
    : queryKey[0] === 'income-fund-binding' ? { data: runtime.discoveredFund, isError: runtime.discoveryError, refetch: vi.fn() }
    : queryKey[0] === 'income-sticky-binding' ? { data: runtime.sticky, isError: runtime.stickyError }
    : queryKey[0] === 'project-pay' ? { data: { kind: 'pay', terminal: '0x3333333333333333333333333333333333333333', preview: runtime.payQuote, minimumTokenCount: runtime.payQuote.beneficiaryTokenCount * 99n / 100n, reservedTokenCount: runtime.payQuote.reservedTokenCount, blockNumber: 100n }, isError: false }
    : queryKey[0] === 'income-reserved' ? { data: runtime.reserved, isError: runtime.reservedError, error: new Error('RPC unavailable'), refetch: vi.fn() }
    : queryKey[0] === 'income-reserved-receipt' ? { data: runtime.reservedReceipt, isError: false }
      : { data: undefined, isError: false, isFetching: false }
  },
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
    HTMLElement.prototype.scrollIntoView ??= () => {}
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }) })
    window.history.replaceState(null, '', '/')
    runtime.mounted = 0; runtime.unmounted = 0; runtime.busy = false; runtime.phase = 'idle'; runtime.sticky = null
    runtime.stickyError = false; runtime.stickyMounted = 0; runtime.stickyUnmounted = 0
    runtime.discoveredFund = null; runtime.discoveryError = false; runtime.fund = undefined; runtime.details = {}
    runtime.operator = undefined; runtime.operatorError = false; runtime.confirmedBlock = 0n; runtime.fundConfirmedBlock = 0n
    runtime.address = '0x1111111111111111111111111111111111111111'
    runtime.send.mockReset(); runtime.autoIssuance.mockReset(); runtime.readState.mockReset()
    runtime.readReserved.mockReset(); runtime.invalidateQueries.mockClear(); runtime.queries.mockClear()
    runtime.reserved = undefined; runtime.reservedError = false; runtime.reservedReceipt = undefined
    runtime.receipt = null; runtime.safeProposalHash = null
    runtime.query = { data: state(), isError: false, isPending: false, isFetching: false, isPlaceholderData: false, refetch: vi.fn() }
    runtime.payQuote = { beneficiaryTokenCount: 1n * 10n ** 18n, reservedTokenCount: 4n * 10n ** 18n }
    runtime.readState.mockImplementation(() => runtime.query.data)
    host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  })
  afterEach(async () => { await act(async () => root.unmount()); host.remove() })
  async function tab(label: string) {
    let target = [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(button => button.textContent === label)
    if (!target && ['Operators', 'Extras'].includes(label)) {
      await act(async () => host.querySelector<HTMLButtonElement>('.hpl-overflow-trigger')!.click())
      target = [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(button => button.textContent === label)
    }
    expect(target, `Missing ${label} tab`).toBeDefined(); await act(async () => target!.click())
  }
  async function visitActions() { for (const label of ['Owners', 'Accounts', 'Market', 'Settlement', 'Splits', 'Loans', 'Overview']) await tab(label) }
  async function render() { await act(async () => root.render(<IncomeProject chainId={1} projectId={7n} />)); await visitActions() }
  function section(title: string) { return [...host.querySelectorAll('section')].find(element => element.querySelector('h3')?.textContent === title)! }
  function pendingReserved() {
    const current = state()
    const snapshot: IncomeReservedSnapshot = { chainId: 1, projectId: 7n, blockNumber: 100n, blockHash: current.blockHash, controller: current.controller, owner: current.owner, tokenAddress: current.tokenAddress, rulesetId: 1n, pending: 8n * 10n ** 18n, splits: [{ percent: 1_000_000_000, beneficiary: current.owner, projectId: 0n, hook: zeroAddress, preferAddToBalance: false, lockedUntil: 0 }] }
    runtime.reserved = snapshot; runtime.readReserved.mockResolvedValue(snapshot)
    return snapshot
  }
  function currentOperator(address: Address = '0x7777777777777777777777777777777777777777'): CurrentProjectOperator {
    return { chainId: 1, incomeProjectId: 7n, blockNumber: 100n, blockHash: `0x${'1'.repeat(64)}`, rulesetId: 1n, reservedPercent: 8000, recipients: [{ address, percent: 300_000_000 }] }
  }
  async function setInput(input: HTMLInputElement, value: string) {
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })) })
  }

  it.each([undefined, 88n])('loads asset profiles from the canonical FUND metadata regardless of URL hint %s', async (fundProjectId) => {
    runtime.discoveredFund = 3n
    runtime.fund = { chainId: 1, projectId: 3n, owner: '0x9999999999999999999999999999999999999999', knownOwnerWrapper: true, projectUri: 'fund-uri' } as FundProjectState
    runtime.details['fund-uri'] = parseFundProjectMetadata({
      name: 'Linked house', homerun: { version: 1, kind: 'fund',
        setup: { ownerWallet: '0x8888888888888888888888888888888888888888', operatorWallet: '0x7777777777777777777777777777777777777777' },
        owner: { name: 'Asset owners', introduction: 'We own this house.' },
        operator: { name: 'Local team', introduction: 'We operate the house.' },
      },
    })
    runtime.operator = currentOperator()
    await act(async () => root.render(<IncomeProject chainId={1} projectId={7n} fundProjectId={fundProjectId} />))
    const queries = runtime.queries.mock.calls.map(([query]) => query)
    expect(queries.some(query => query.queryKey[0] === 'income-fund-binding' && query.queryKey[2] === '7' && query.enabled)).toBe(true)
    expect(queries.some(query => query.queryKey[0] === 'fund-project' && query.queryKey[2] === '3' && query.enabled)).toBe(true)
    expect(queries.some(query => query.queryKey[0] === 'fund-project' && query.queryKey[2] === '88' && query.enabled)).toBe(false)
    const owner = host.querySelector('section[aria-label="Owner introduction"]')!
    const operator = host.querySelector('section[aria-label="Operator introduction"]')!
    expect(owner.textContent).not.toContain('Asset owners')
    expect(owner.textContent).not.toContain('We own this house.')
    expect(owner.querySelector('a')?.getAttribute('href')).toBe('/account/0x9999999999999999999999999999999999999999')
    expect(owner.textContent).not.toContain('0x8888888888888888888888888888888888888888')
    expect(operator.textContent).toContain('Local team')
    expect(operator.querySelector('a')?.getAttribute('href')).toBe('/account/0x7777777777777777777777777777777777777777')
    expect(operator.textContent).not.toContain(runtime.address)
    expect(owner.textContent).not.toContain(state().owner)
  })

  it.each([false, true])('does not use an unverified FUND hint for public roles when canonical discovery fails or is absent (%s)', async (discoveryError) => {
    runtime.discoveryError = discoveryError
    runtime.discoveredFund = discoveryError ? 3n : null
    runtime.fund = { chainId: 1, projectId: 3n, owner: '0x9999999999999999999999999999999999999999', knownOwnerWrapper: true, projectUri: 'unrelated-fund-uri' } as FundProjectState
    runtime.details['unrelated-fund-uri'] = parseFundProjectMetadata({ name: 'Unrelated owners', homerun: { version: 1, kind: 'fund', setup: {}, owner: { name: 'Unrelated owners' } } })
    await act(async () => root.render(<IncomeProject chainId={1} projectId={7n} fundProjectId={3n} />))
    expect(runtime.queries.mock.calls.some(([query]) => query.queryKey[0] === 'fund-project' && query.enabled)).toBe(false)
    const owner = host.querySelector(`section[aria-label="${discoveryError ? 'Current Owner' : 'Owner introduction'}"]`)!
    expect(owner.textContent).toContain(discoveryError ? 'The current Owner could not be verified.' : 'Address not specified')
    expect(owner.querySelector('a')).toBeNull()
    expect(owner.textContent).not.toContain('Unrelated owners')
    if (discoveryError) expect(host.textContent).toContain('The FUND Owner and Operator details could not be refreshed.')
  })

  it('does not present revnet governance as an asset Owner when the connected FUND has changed to a revnet', async () => {
    runtime.discoveredFund = 3n
    runtime.fund = { chainId: 1, projectId: 3n, owner: state().owner, knownOwnerWrapper: false, projectUri: '' } as FundProjectState
    await act(async () => root.render(<IncomeProject chainId={1} projectId={7n} fundProjectId={3n} />))
    const owner = host.querySelector('section[aria-label="Current Owner"]')!
    expect(owner.textContent).toContain('The current Owner could not be verified.')
    expect(owner.querySelector('a')).toBeNull()
  })

  it('hides the previous FUND Owner after a verified transfer until the FUND read reaches the confirmed block', async () => {
    const original = '0x9999999999999999999999999999999999999999'
    const replacement = '0x6666666666666666666666666666666666666666'
    runtime.discoveredFund = 3n
    runtime.fund = { chainId: 1, projectId: 3n, blockNumber: 100n, owner: original, knownOwnerWrapper: true, projectUri: 'fund-uri' } as FundProjectState
    runtime.details['fund-uri'] = parseFundProjectMetadata({ name: 'House', homerun: { version: 1, kind: 'fund', setup: { ownerWallet: original }, owner: { name: 'Original trust', introduction: 'We hold the asset.' } } })
    await render()
    expect(host.querySelector('[aria-label="Owner introduction"]')?.textContent).toContain('Original trust')
    runtime.fundConfirmedBlock = 101n
    await act(async () => root.render(<IncomeProject chainId={1} projectId={7n} />))
    const waiting = host.querySelector('[aria-label="Current Owner"]')!
    expect(waiting.textContent).toContain('The current Owner could not be verified.')
    expect(waiting.querySelector('a')).toBeNull()
    expect(host.querySelector('[aria-label="Owner introduction"]')).toBeNull()
    expect(host.querySelector('[data-testid="metadata-editor"] button')?.hasAttribute('disabled')).toBe(false)
    expect(runtime.queries.mock.calls.some(([query]) => query.queryKey[0] === 'project-admin-confirmed-block' && query.queryKey[1] === 1 && query.queryKey[2] === '3' && query.enabled === false)).toBe(true)
    runtime.fund = { ...runtime.fund!, blockNumber: 101n, owner: replacement }
    await act(async () => root.render(<IncomeProject chainId={1} projectId={7n} />))
    const owner = host.querySelector('[aria-label="Owner introduction"]')!
    expect(owner.querySelector('a')?.textContent).toBe(replacement)
    expect(owner.textContent).not.toContain('Original trust')
    expect(owner.textContent).not.toContain('We hold the asset.')
    expect(runtime.send).not.toHaveBeenCalled()
  })

  it('keeps the verified FUND Owner visible when only the separate INCOME project is behind its confirmed block', async () => {
    const original = '0x9999999999999999999999999999999999999999'
    runtime.discoveredFund = 3n
    runtime.fund = { chainId: 1, projectId: 3n, blockNumber: 100n, owner: original, knownOwnerWrapper: true, projectUri: '' } as FundProjectState
    runtime.confirmedBlock = 101n
    await render()
    expect(host.querySelector('[aria-label="Owner introduction"] a')?.textContent).toBe(original)
    expect(host.querySelector('[aria-label="Current Owner"]')).toBeNull()
    expect(host.querySelector('[data-testid="metadata-editor"] button')?.hasAttribute('disabled')).toBe(true)
  })

  it('uses the published Owner and verified current Operator when an INCOME URI contains Homerun metadata without a verified FUND', async () => {
    runtime.query = { ...runtime.query, data: { ...state(), projectUri: 'income-uri' } }
    runtime.details['income-uri'] = parseFundProjectMetadata({
      name: 'Published house', homerun: { version: 1, kind: 'fund',
        setup: { ownerWallet: '0x8888888888888888888888888888888888888888', operatorWallet: '0x7777777777777777777777777777777777777777' },
        owner: { name: 'Published owners' }, operator: { name: 'Published team' },
      },
    })
    runtime.operator = currentOperator()
    await render()
    const owner = host.querySelector('section[aria-label="Owner introduction"]')!
    expect(owner.textContent).toContain('Published Owner wallet')
    expect(owner.querySelector('a')?.textContent).toBe('0x8888888888888888888888888888888888888888')
    expect(host.querySelector('section[aria-label="Operator introduction"] a')?.textContent).toBe('0x7777777777777777777777777777777777777777')
  })

  it('never substitutes revnet governance or the connected wallet for unpublished asset roles', async () => {
    await render()
    for (const role of ['Owner', 'Operator']) {
      const profile = host.querySelector(`section[aria-label="${role === 'Owner' ? 'Owner introduction' : 'Current Operator'}"]`)!
      expect(profile.textContent).toContain(role === 'Owner' ? 'Address not specified' : 'Reading the current Operator')
      expect(profile.querySelector('a')).toBeNull()
      expect(profile.textContent).not.toContain(runtime.address)
      expect(profile.textContent).not.toContain(state().owner)
    }
  })

  it('places INCOME details in Overview and control, permissions, and INCOME splits in their Owners tabs', async () => {
    runtime.discoveredFund = 3n
    runtime.fund = { chainId: 1, projectId: 3n, owner: '0x9999999999999999999999999999999999999999', knownOwnerWrapper: true, projectUri: 'fund-uri' } as FundProjectState
    await render()
    const metadata = host.querySelector<HTMLElement>('[data-testid="metadata-editor"]')!
    expect(metadata.dataset.projectId).toBe('7')
    expect(metadata.dataset.chainId).toBe('1')
    expect(metadata.dataset.inheritedUri).toBe('fund-uri')
    expect(metadata.textContent).toContain('Edit INCOME details')
    expect(metadata.closest('[hidden]')).toBeNull()
    await tab('Owners')
    for (const [label, testId] of [['Control', 'ownership-editor'], ['Permissions', 'permissions-editor'], ['Splits', 'splits-editor']]) {
      await tab(label)
      const editor = host.querySelector<HTMLElement>(`[data-testid="${testId}"]`)!
      expect(editor.dataset.chainId).toBe('1')
      expect(editor.dataset.projectId).toBe('7')
      expect(editor.closest('[hidden]')).toBeNull()
      expect(editor.closest('[role="tabpanel"]')?.id).toContain(`panel-${label.toLowerCase()}`)
      expect(editor.querySelector('button')?.disabled).toBe(false)
      expect(metadata.closest('[hidden]')).not.toBeNull()
    }
    expect(host.querySelector<HTMLElement>('[data-testid="splits-editor"]')?.dataset.phase).toBe('income')
    expect(host.querySelectorAll('[data-testid="splits-editor"]')).toHaveLength(1)
    expect(runtime.send).not.toHaveBeenCalled()
  })

  it('disables every post-launch editor during failed or stale confirmed reads without replacing the panels', async () => {
    await render(); await tab('Owners'); await tab('Control'); await tab('Permissions'); await tab('Splits')
    const editors = ['metadata-editor', 'ownership-editor', 'permissions-editor', 'splits-editor'].map(id => host.querySelector<HTMLElement>(`[data-testid="${id}"]`)!)
    for (const failed of [true, false]) {
      runtime.query = { ...runtime.query, isError: failed, error: new Error('RPC offline') }
      runtime.confirmedBlock = failed ? 0n : 101n
      await act(async () => root.render(<IncomeProject chainId={1} projectId={7n} />))
      for (const editor of editors) {
        expect(document.body.contains(editor)).toBe(true)
        expect(editor.querySelector('button')?.disabled).toBe(true)
      }
    }
    expect(runtime.send).not.toHaveBeenCalled()
  })

  it('updates the public Operator after confirmed replacement without assigning the previous profile to the new wallet', async () => {
    runtime.query = { ...runtime.query, data: { ...state(), projectUri: 'income-uri' } }
    runtime.details['income-uri'] = parseFundProjectMetadata({ name: 'Current house', homerun: { version: 1, kind: 'fund', setup: { operatorWallet: '0x7777777777777777777777777777777777777777' }, operator: { name: 'Original hosts', introduction: 'We host this house.' } } })
    runtime.operator = currentOperator()
    await render()
    expect(host.querySelector('[aria-label="Operator introduction"]')?.textContent).toContain('Original hosts')
    runtime.confirmedBlock = 101n
    await act(async () => root.render(<IncomeProject chainId={1} projectId={7n} />))
    expect(host.querySelector('[aria-label="Current Operator"]')?.textContent).toContain('Waiting for the confirmed Operator update')
    expect(host.querySelector('[aria-label="Operator introduction"]')).toBeNull()
    runtime.operator = { ...currentOperator('0x6666666666666666666666666666666666666666'), blockNumber: 101n }
    await act(async () => root.render(<IncomeProject chainId={1} projectId={7n} />))
    const operator = host.querySelector('[aria-label="Operator introduction"]')!
    expect(operator.querySelector('a')?.textContent).toBe('0x6666666666666666666666666666666666666666')
    expect(operator.textContent).not.toContain('Original hosts')
    expect(operator.textContent).not.toContain('We host this house.')
    runtime.operatorError = true
    await act(async () => root.render(<IncomeProject chainId={1} projectId={7n} />))
    const unavailable = host.querySelector('[aria-label="Current Operator"]')!
    expect(unavailable.textContent).toContain('The current Operator could not be verified')
    expect(unavailable.querySelector('a')).toBeNull()
  })

  it('displays an updated INCOME introduction associated with the current wallet ahead of inherited FUND metadata', async () => {
    const replacement = '0x6666666666666666666666666666666666666666'
    runtime.discoveredFund = 3n
    runtime.fund = { chainId: 1, projectId: 3n, owner: '0x9999999999999999999999999999999999999999', knownOwnerWrapper: true, projectUri: 'fund-uri' } as FundProjectState
    runtime.query = { ...runtime.query, data: { ...state(), projectUri: 'income-uri' } }
    runtime.details['fund-uri'] = parseFundProjectMetadata({ name: 'Original house', homerun: { version: 1, kind: 'fund', setup: { operatorWallet: '0x7777777777777777777777777777777777777777' }, operator: { name: 'Original hosts' } } })
    runtime.details['income-uri'] = parseFundProjectMetadata({ name: 'Updated house', homerun: { version: 1, kind: 'fund', setup: { operatorWallet: replacement }, operator: { name: 'New hosts', introduction: 'We now operate the house.' } } })
    runtime.operator = currentOperator(replacement)
    await render()
    const operator = host.querySelector('[aria-label="Operator introduction"]')!
    expect(operator.textContent).toContain('New hosts')
    expect(operator.textContent).toContain('We now operate the house.')
    expect(operator.querySelector('a')?.textContent).toBe(replacement)
    expect(operator.textContent).not.toContain('Original hosts')
  })

  it.each([undefined, 3n])('uses the INCOME project for the standalone shop with FUND connection %s', async (fundProjectId) => {
    runtime.discoveredFund = 3n
    await act(async () => root.render(<IncomeProject chainId={1} projectId={7n} fundProjectId={fundProjectId} />))
    await tab('Shop')
    const shop = host.querySelector<HTMLElement>('[data-testid="shop-INCOME"]')
    expect(shop?.dataset.chainId).toBe('1')
    expect(shop?.dataset.projectId).toBe('7')
    expect(host.querySelector('[data-testid="shop-FUND"]')).toBeNull()
    expect(runtime.send).not.toHaveBeenCalled()
  })

  it('mounts initial claims separately and uses the verified Sticky project ID for ongoing rewards', async () => {
    runtime.sticky = { stickyProjectId: 91n }
    await act(async () => root.render(<IncomeProject chainId={1} projectId={7n} fundProjectId={3n} />)); await visitActions()
    expect(host.textContent).toContain('Initial claim FUND 3 INCOME 7')
    expect(host.querySelector('.hpl-metadata')?.textContent).toContain('INCOME supply: 100')
    expect(host.querySelector('.hpl-metadata')?.textContent).toContain('INCOME treasury: <0.000001 ETH')
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
    const panel = section('Pay the project')
    await act(async () => panel.querySelector('button')!.click())
    const pay = panel.querySelector('dialog')!
    await setInput(pay.querySelector('input')!, '1')
    expect(pay.textContent).toContain('gives you no INCOME')
    const button = [...pay.querySelectorAll('button')].find(button => button.textContent === 'Review payment')!
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
    const panel = section('Pay the project')
    await act(async () => panel.querySelector('button')!.click())
    const pay = panel.querySelector('dialog')!
    await setInput(pay.querySelector('input')!, '1')
    expect([...pay.querySelectorAll('button')].find(button => button.textContent === 'Review payment')?.disabled).toBe(true)
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
