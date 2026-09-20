import { act, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('@bananapus/nana-sdk-core', async importOriginal => (await import('./fixtures/homerun-deployer')).withHomerunDeployer(await importOriginal()))
import { zeroAddress, type Address } from 'viem'
import type { FundProjectState } from '../src/lib/fund-state'
import type { IncomeProjectState } from '../src/lib/income-state'
import type { CurrentProjectOperator } from '../src/lib/project-operator-profile'
import { parseFundProjectMetadata, type FundProjectMetadata } from '../src/lib/fund-project-metadata'

type AdminEditorProps = { chainId: number; projectId: bigint; unavailable?: boolean; label?: string; inheritedMetadataUri?: string; phase?: string }

const runtime = vi.hoisted(() => ({
  address: '0x1111111111111111111111111111111111111111' as Address,
  query: {} as Record<string, unknown>,
  incomeId: undefined as bigint | undefined,
  incomeQuery: {} as Record<string, unknown>,
  bindingError: false,
  bindingPending: false,
  operator: undefined as CurrentProjectOperator | undefined,
  operatorError: false,
  details: undefined as FundProjectMetadata | undefined,
  mounted: 0,
  unmounted: 0,
  phase: 'pending',
  delegated: '0x0000000000000000000000000000000000000000' as Address,
  send: vi.fn(),
  invalidateQueries: vi.fn(),
}))

vi.mock('@/components/StickyHolder', () => ({ StickyHolder: () => <span>Sticky rewards</span> }))
vi.mock('@/components/IncomeBridgeActions', () => ({ IncomeBridgeActions: () => <span>INCOME bridge</span> }))
vi.mock('@/components/ProjectParticipants', () => ({ ProjectParticipants: () => <span>Indexed holders</span> }))
vi.mock('@/components/ProjectPayerAddresses', () => ({ ProjectPayerAddresses: () => <span>Project payer addresses</span> }))
vi.mock('@/components/ProjectShop', () => ({ ProjectShop: ({ chainId, projectId, tokenLabel }: { chainId: number; projectId: bigint; tokenLabel: string }) => <span data-testid={`shop-${tokenLabel}`} data-chain-id={chainId} data-project-id={projectId.toString()}>Project shop</span> }))
vi.mock('@/components/ProjectMetadataEditor', () => ({ ProjectMetadataEditor: ({ chainId, projectId, unavailable, label, inheritedMetadataUri }: AdminEditorProps) => <button data-testid={`metadata-${projectId}`} data-chain-id={chainId} data-project-id={projectId.toString()} data-inherited-uri={inheritedMetadataUri} disabled={unavailable}>{label}</button> }))
vi.mock('@/components/ProjectOwnershipEditor', () => ({ ProjectOwnershipEditor: ({ chainId, projectId, unavailable }: AdminEditorProps) => <button data-testid={`control-${projectId}`} data-chain-id={chainId} data-project-id={projectId.toString()} disabled={unavailable}>Edit ownership</button> }))
vi.mock('@/components/ProjectPermissionsEditor', () => ({ ProjectPermissionsEditor: ({ chainId, projectId, unavailable }: AdminEditorProps) => <button data-testid={`permissions-${projectId}`} data-chain-id={chainId} data-project-id={projectId.toString()} disabled={unavailable}>Edit permissions</button> }))
vi.mock('@/components/ProjectSplitsEditor', () => ({ ProjectSplitsEditor: ({ chainId, projectId, unavailable, phase }: AdminEditorProps) => <button data-testid={`splits-${projectId}`} data-chain-id={chainId} data-project-id={projectId.toString()} data-phase={phase} disabled={unavailable}>Edit splits</button> }))
vi.mock('wagmi', () => ({ usePublicClient: () => ({ readContract: async () => runtime.delegated }) }))
vi.mock('@/lib/fund-state', () => ({ readFundProjectState: async () => runtime.query.data }))
vi.mock('@/hooks/useReviewedPermit2Signature', () => ({ useReviewedPermit2Signature: () => ({ signPermit2Async: vi.fn() }) }))
vi.mock('@/hooks/useWallet', () => ({ useWallet: () => ({ address: runtime.address, isConnected: true }) }))
vi.mock('@/components/WalletButton', () => ({ WalletButton: () => <span>Wallet</span> }))
vi.mock('@/components/FundOperatorActions', () => ({ FundOperatorActions: () => <span>Operator actions</span> }))
vi.mock('@/components/IncomeLaunch', () => ({ IncomeLaunch: ({ launchUnavailable }: { launchUnavailable?: boolean }) => <section data-testid="income"><button disabled={launchUnavailable}>INCOME launch</button><button>Existing INCOME action</button></section> }))
vi.mock('@/components/FundBridgeActions', () => ({ FundBridgeActions: () => <span>FUND bridge</span> }))
vi.mock('@tanstack/react-query', () => ({
  keepPreviousData: (value: unknown) => value,
  useQueryClient: () => ({ invalidateQueries: runtime.invalidateQueries }),
  useQuery: ({ queryKey }: { queryKey: unknown[] }) => queryKey[0] === 'fund-project'
    ? runtime.query
    : queryKey[0] === 'income-project' ? runtime.incomeQuery
    : queryKey[0] === 'fund-project-metadata' ? { data: runtime.details, isError: false }
    : queryKey[0] === 'income-binding' ? { data: runtime.incomeId, isError: runtime.bindingError, isPending: runtime.bindingPending, isFetching: false }
    : queryKey[0] === 'project-operator-profile' ? { data: runtime.operator, isError: runtime.operatorError, isPending: false, refetch: vi.fn() }
    : queryKey[0] === 'fund-reward-activation' ? { data: runtime.delegated, isError: false, isFetching: false }
    : { data: undefined, isError: false, isFetching: false },
}))
vi.mock('@/hooks/useSafeTx', () => ({
  txPhaseLabel: (_phase: string, labels: { idle: string }) => labels.idle,
  useSafeTx: () => {
    useEffect(() => { runtime.mounted += 1; return () => { runtime.unmounted += 1 } }, [])
    return { phase: runtime.phase, busy: runtime.phase === 'pending', error: null, hash: `0x${'a'.repeat(64)}`, safeProposalHash: null, receipt: null, send: runtime.send, reset: vi.fn() }
  },
}))

import { FundProject } from '../src/components/FundProject'

function state(): FundProjectState {
  return {
    chainId: 1, projectId: 7n, blockNumber: 100n,
    owner: runtime.address, operator: runtime.address, account: runtime.address,
    controller: '0x2222222222222222222222222222222222222222',
    supportedController: true, supportedTerminals: true, knownOwnerWrapper: true,
    ruleset: { id: 1, start: 1 }, metadata: { pausePay: false, cashOutTaxRate: 1000, pauseCreditTransfers: false },
    upcoming: null, projectUri: '', tokenAddress: null, totalSupply: 100n,
    creditBalance: 10n, erc20Balance: 0n,
    accountingContexts: [{ token: '0x000000000000000000000000000000000000EEEe', decimals: 18, currency: 1, terminal: '0x3333333333333333333333333333333333333333', balance: 100n, symbol: 'ETH' }],
    permissions: { queueRulesets: true, mintTokens: true, deployErc20: true, useAllowance: true, sendPayouts: true, setProjectUri: true },
    issues: [],
  } as unknown as FundProjectState
}

function incomeState(): IncomeProjectState {
  return {
    chainId: 1, projectId: 9n, blockNumber: 100n, blockHash: `0x${'1'.repeat(64)}`, blockTimestamp: 1_800_000_000n,
    owner: '0x2222222222222222222222222222222222222222', operator: runtime.address, account: runtime.address,
    controller: '0x4444444444444444444444444444444444444444',
    ruleset: { id: 1, start: 1 }, metadata: { pausePay: false, cashOutTaxRate: 0, pauseCreditTransfers: false, reservedPercent: 8000 },
    projectUri: '', tokenAddress: '0x5555555555555555555555555555555555555555', totalSupply: 100n * 10n ** 18n,
    tokenSymbol: 'INCOME', tokenDecimals: 18, totalCreditSupply: 0n, pendingReservedTokens: 0n, totalSupplyWithReservedTokens: 100n * 10n ** 18n,
    creditBalance: 0n, erc20Balance: 10n * 10n ** 18n, totalBalance: 10n * 10n ** 18n,
    terminals: [], accountingContexts: [], cashOutDelay: 0n, cashOutsAvailable: true, isOperator: true, rewards: null, rewardIssue: null, issues: [],
  } as unknown as IncomeProjectState
}

function operatorState(address: Address = '0x3333333333333333333333333333333333333333'): CurrentProjectOperator {
  return { chainId: 1, incomeProjectId: 9n, blockNumber: 100n, blockHash: `0x${'2'.repeat(64)}`, rulesetId: 1n, reservedPercent: 8000, recipients: [{ address, percent: 300_000_000 }] }
}

describe('live FUND transaction tracking survives refreshed data', () => {
  let root: Root
  let host: HTMLDivElement
  beforeEach(() => {
    HTMLElement.prototype.scrollIntoView ??= () => {}
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }) })
    window.history.replaceState(null, '', '/')
    runtime.incomeId = undefined; runtime.details = undefined
    runtime.incomeQuery = { data: undefined, isError: false, isPending: false, isFetching: false, isPlaceholderData: false, refetch: vi.fn() }
    runtime.bindingError = false; runtime.bindingPending = false; runtime.operator = undefined; runtime.operatorError = false
    runtime.mounted = 0; runtime.unmounted = 0
    runtime.phase = 'pending'; runtime.delegated = zeroAddress
    runtime.send.mockReset().mockImplementation(async (_request, options) => { await options?.reverify?.(); return null })
    runtime.address = '0x1111111111111111111111111111111111111111'
    runtime.query = { data: state(), isError: false, isPending: false, isFetching: false, isPlaceholderData: false, refetch: vi.fn() }
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
  async function render() {
    await act(async () => root.render(<FundProject chainId={1} projectId="7" />))
    for (const label of ['Owners', 'Market', 'Settlement', 'Operators', 'Overview']) await tab(label)
  }

  it('shows verified Owner and Operator wallets without assigning an old Owner identity to a new wallet', async () => {
    runtime.details = parseFundProjectMetadata({
      name: 'Live house', homerun: { version: 1, kind: 'fund',
        setup: { ownerWallet: '0x4444444444444444444444444444444444444444', operatorWallet: '0x3333333333333333333333333333333333333333' },
        owner: { name: 'Asset owners', introduction: 'We own the house.' },
        operator: { name: 'House team', introduction: 'We host the guests.' },
      },
    })
    runtime.incomeId = 9n
    runtime.operator = operatorState()
    await render()
    const owner = host.querySelector('section[aria-label="Owner introduction"]')!
    const operator = host.querySelector('section[aria-label="Operator introduction"]')!
    expect(owner.textContent).not.toContain('Asset owners')
    expect(owner.textContent).not.toContain('We own the house.')
    expect(owner.textContent).toContain('Current Owner wallet')
    expect(owner.querySelector('a')?.getAttribute('href')).toBe(`/account/${runtime.address}`)
    expect(owner.textContent).not.toContain('0x4444444444444444444444444444444444444444')
    expect(operator.textContent).toContain('House team')
    expect(operator.textContent).toContain('Current Operator wallet')
    expect(operator.querySelector('a')?.getAttribute('href')).toBe('/account/0x3333333333333333333333333333333333333333')
    expect(operator.textContent).not.toContain(runtime.address)
    expect(host.querySelectorAll('section[aria-label="Owner introduction"]')).toHaveLength(1)
    expect(host.querySelectorAll('section[aria-label="Operator introduction"]')).toHaveLength(1)
  })

  it('shows the verified Owner even when no public profile is published', async () => {
    await render()
    expect(host.querySelector('section[aria-label="Owner introduction"] a')?.textContent).toBe(runtime.address)
    expect(host.querySelector('section[aria-label="Operator introduction"]')?.textContent).toContain('Address not specified')
  })

  it('waits for the initial INCOME binding read before presenting the published Operator as planned', async () => {
    runtime.bindingPending = true
    runtime.details = parseFundProjectMetadata({
      homerun: { version: 1, kind: 'fund', setup: { ownerWallet: runtime.address, operatorWallet: operatorState().recipients[0].address },
        operator: { name: 'Published hosts', introduction: 'We will operate the house.' } },
    })
    await act(async () => root.render(<FundProject chainId={1} projectId="7" />))
    expect(host.querySelector('[aria-label="Planned Operator"]')).toBeNull()
    expect(host.querySelector('[aria-label="Operator introduction"]')).toBeNull()
    expect(host.textContent).not.toContain('Planned Operator')
    expect(host.textContent).not.toContain('Published hosts')
    expect(host.textContent).not.toContain(operatorState().recipients[0].address)

    runtime.bindingPending = false
    await act(async () => root.render(<FundProject chainId={1} projectId="7" />))
    const planned = host.querySelector('[aria-label="Planned Operator"]')!
    expect(planned.textContent).toContain('Planned Operator for the INCOME phase.')
    expect(planned.textContent).toContain('Published hosts')
    expect(planned.querySelector('a')?.textContent).toBe(operatorState().recipients[0].address)
    expect(runtime.send).not.toHaveBeenCalled()
  })

  it('moves from a pending binding to the current INCOME Operator without displaying a planned identity', async () => {
    runtime.bindingPending = true
    runtime.details = parseFundProjectMetadata({
      homerun: { version: 1, kind: 'fund', setup: { ownerWallet: runtime.address, operatorWallet: operatorState().recipients[0].address },
        operator: { name: 'Published hosts', introduction: 'We originally operated the house.' } },
    })
    await act(async () => root.render(<FundProject chainId={1} projectId="7" />))
    expect(host.querySelector('[aria-label="Planned Operator"]')).toBeNull()
    expect(host.querySelector('[aria-label="Operator introduction"]')).toBeNull()
    expect(host.textContent).not.toContain('Published hosts')
    expect(host.textContent).not.toContain(operatorState().recipients[0].address)

    runtime.bindingPending = false
    runtime.incomeId = 9n
    await act(async () => root.render(<FundProject chainId={1} projectId="7" />))
    expect(host.querySelector('[aria-label="Planned Operator"]')).toBeNull()
    expect(host.querySelector('[aria-label="Operator introduction"]')).toBeNull()
    expect(host.textContent).not.toContain('Published hosts')

    runtime.operator = operatorState('0x6666666666666666666666666666666666666666')
    await act(async () => root.render(<FundProject chainId={1} projectId="7" />))
    const current = host.querySelector('[aria-label="Operator introduction"]')!
    expect(current.textContent).toContain('Current Operator wallet')
    expect(current.querySelector('a')?.textContent).toBe(runtime.operator.recipients[0].address)
    expect(host.querySelector('[aria-label="Planned Operator"]')).toBeNull()
    expect(host.textContent).not.toContain('Published hosts')
    expect(runtime.send).not.toHaveBeenCalled()
  })

  it.each(['operator', 'binding'] as const)('refreshes the public Operator after replacement and hides its cached identity on a failed %s read', async failure => {
    runtime.incomeId = 9n
    runtime.operator = operatorState()
    runtime.details = parseFundProjectMetadata({
      homerun: { version: 1, kind: 'fund', setup: { ownerWallet: runtime.address, operatorWallet: operatorState().recipients[0].address },
        operator: { name: 'Original hosts', introduction: 'We run the house.', photoUri: 'ipfs://QmOperatorPhoto' } },
    })
    await render()
    let profile = host.querySelector('section[aria-label="Operator introduction"]')!
    expect(profile.textContent).toContain('Original hosts')
    expect(profile.querySelector('img')).not.toBeNull()

    runtime.operator = { ...operatorState('0x6666666666666666666666666666666666666666'), blockNumber: 101n }
    await act(async () => root.render(<FundProject chainId={1} projectId="7" />))
    profile = host.querySelector('section[aria-label="Operator introduction"]')!
    expect(profile.querySelector('a')?.textContent).toBe('0x6666666666666666666666666666666666666666')
    expect(profile.textContent).toContain('Current Operator wallet')
    expect(profile.textContent).not.toContain('Original hosts')
    expect(profile.textContent).not.toContain('We run the house.')
    expect(profile.querySelector('img')).toBeNull()

    if (failure === 'operator') runtime.operatorError = true
    else runtime.bindingError = true
    await act(async () => root.render(<FundProject chainId={1} projectId="7" />))
    const unavailable = host.querySelector('section[aria-label="Current Operator"]')!
    expect(unavailable.textContent).toContain('The current Operator could not be verified.')
    expect(unavailable.querySelector('a')).toBeNull()
    expect(host.querySelector('section[aria-label="Operator introduction"]')).toBeNull()
    expect(runtime.send).not.toHaveBeenCalled()
  })

  it('places separate FUND and INCOME metadata editors in Overview and supplies the inherited FUND URI', async () => {
    runtime.incomeId = 9n
    runtime.incomeQuery = { ...runtime.incomeQuery, data: incomeState() }
    runtime.query = { ...runtime.query, data: { ...state(), projectUri: 'ipfs://QmPublishedFund' } }
    await render()
    for (const projectId of ['7', '9']) {
      const editor = host.querySelector<HTMLButtonElement>(`[data-testid="metadata-${projectId}"]`)!
      expect(editor.dataset.chainId).toBe('1')
      expect(editor.dataset.projectId).toBe(projectId)
      expect(editor.closest('[role="tabpanel"]')?.id).toMatch(/-panel-overview$/)
      expect(editor.disabled).toBe(false)
    }
    expect(host.querySelector('[data-testid="metadata-7"]')?.textContent).toBe('Edit FUND details')
    expect(host.querySelector('[data-testid="metadata-9"]')?.textContent).toBe('Edit INCOME details')
    expect(host.querySelector<HTMLElement>('[data-testid="metadata-9"]')?.dataset.inheritedUri).toBe('ipfs://QmPublishedFund')
    expect(runtime.send).not.toHaveBeenCalled()
  })

  it('places each phase’s ownership, permissions and split editor in its matching Owners tab', async () => {
    runtime.incomeId = 9n
    runtime.incomeQuery = { ...runtime.incomeQuery, data: incomeState() }
    await render()
    await tab('Owners')
    for (const [label, prefix] of [['Control', 'control'], ['Permissions', 'permissions'], ['Splits', 'splits']]) {
      await tab(label)
      for (const projectId of ['7', '9']) {
        const editor = host.querySelector<HTMLButtonElement>(`[data-testid="${prefix}-${projectId}"]`)!
        expect(editor, `Missing ${label} editor for project ${projectId}`).not.toBeNull()
        expect(editor.dataset.chainId).toBe('1')
        expect(editor.dataset.projectId).toBe(projectId)
        expect(editor.closest<HTMLElement>('[role="tabpanel"]')?.hidden).toBe(false)
        expect(editor.closest('[role="tabpanel"]')?.id).toMatch(new RegExp(`-panel-${prefix}$`))
        expect(editor.disabled).toBe(false)
      }
    }
    expect(host.querySelector<HTMLElement>('[data-testid="splits-7"]')?.dataset.phase).toBe('fund')
    expect(host.querySelector<HTMLElement>('[data-testid="splits-9"]')?.dataset.phase).toBe('income')
    expect(runtime.send).not.toHaveBeenCalled()
  })

  it('shows FUND control and permissions without phantom INCOME management while no INCOME project exists', async () => {
    await render()
    await tab('Owners')
    for (const [label, prefix] of [['Control', 'control'], ['Permissions', 'permissions']]) {
      await tab(label)
      const editor = host.querySelector<HTMLButtonElement>(`[data-testid="${prefix}-7"]`)!
      expect(editor.disabled).toBe(false)
      expect(editor.closest<HTMLElement>('[role="tabpanel"]')?.hidden).toBe(false)
      expect(host.querySelector(`[data-testid="${prefix}-9"]`)).toBeNull()
      const panel = editor.closest('[role="tabpanel"]')!
      expect(panel.textContent).not.toContain('INCOME control')
      expect(panel.textContent).not.toContain('INCOME permissions')
      expect(panel.textContent).not.toContain('Reading project ownership')
      expect(panel.textContent).not.toContain('Reading project permissions')
    }
    expect(runtime.unmounted).toBe(0)
    expect(runtime.send).not.toHaveBeenCalled()
  })

  it('keeps administrative editors mounted and independently gates each phase when FUND reads fail', async () => {
    runtime.incomeId = 9n
    runtime.incomeQuery = { ...runtime.incomeQuery, data: incomeState() }
    await render()
    await tab('Owners')
    for (const label of ['Control', 'Permissions', 'Splits']) await tab(label)
    const fundEditors = ['metadata', 'control', 'permissions', 'splits'].map(prefix => host.querySelector<HTMLButtonElement>(`[data-testid="${prefix}-7"]`)!)
    const incomeEditors = ['metadata', 'control', 'permissions', 'splits'].map(prefix => host.querySelector<HTMLButtonElement>(`[data-testid="${prefix}-9"]`)!)
    runtime.query = { ...runtime.query, isError: true, error: new Error('FUND RPC unavailable') }
    await act(async () => root.render(<FundProject chainId={1} projectId="7" />))
    for (const editor of fundEditors) {
      expect(editor.isConnected).toBe(true)
      expect(editor.disabled).toBe(true)
    }
    for (const editor of incomeEditors) {
      expect(editor.isConnected).toBe(true)
      expect(editor.disabled).toBe(false)
    }
    expect(runtime.send).not.toHaveBeenCalled()
  })

  it('shows the project navigation before RPC reads finish and preserves the selected tab', async () => {
    runtime.query = { ...runtime.query, data: undefined, isPending: true }
    await act(async () => root.render(<FundProject chainId={1} projectId="7" />))
    expect(host.querySelector('[aria-label="Project sections"]')).not.toBeNull()
    expect(host.querySelector('.hpl-metadata')?.textContent).not.toContain('FUND treasury:')
    expect(host.querySelector('.hpl-metadata')?.textContent).not.toContain('FUND supply:')
    await tab('Operators')
    expect(runtime.mounted).toBe(0)
    runtime.query = { ...runtime.query, data: state(), isPending: false }
    await act(async () => root.render(<FundProject chainId={1} projectId="7" />))
    expect([...host.querySelectorAll('[role="tab"]')].find(button => button.textContent === 'Operators')?.getAttribute('aria-selected')).toBe('true')
    expect(host.querySelector('[data-testid="income"]')).not.toBeNull()
    expect(host.querySelector('.hpl-metadata')?.textContent).toContain('FUND treasury: <0.000001 ETH')
    expect(host.querySelector('.hpl-metadata')?.textContent).toContain('FUND supply: <0.000001')
    expect(runtime.send).not.toHaveBeenCalled()
  })

  it.each([undefined, 9n])('keeps the FUND shop separate from its verified linked INCOME shop (%s)', async (incomeId) => {
    runtime.incomeId = incomeId
    await render()
    await tab('Shop')
    const fundShop = host.querySelector<HTMLElement>('[data-testid="shop-FUND"]')
    const incomeShop = host.querySelector<HTMLElement>('[data-testid="shop-INCOME"]')
    expect(fundShop?.dataset.chainId).toBe('1')
    expect(fundShop?.dataset.projectId).toBe('7')
    if (incomeId === undefined) expect(incomeShop).toBeNull()
    else {
      expect(incomeShop?.dataset.chainId).toBe('1')
      expect(incomeShop?.dataset.projectId).toBe(incomeId.toString())
    }
    expect(host.querySelector('.hpl-metadata')?.textContent).not.toContain('INCOME treasury:')
    expect(runtime.send).not.toHaveBeenCalled()
  })

  it('adds the INCOME shop when the launch is discovered without replacing the FUND shop', async () => {
    await render()
    await tab('Shop')
    const fundShop = host.querySelector<HTMLElement>('[data-testid="shop-FUND"]')
    expect(fundShop?.dataset.projectId).toBe('7')
    expect(host.querySelector('[data-testid="shop-INCOME"]')).toBeNull()
    runtime.incomeId = 9n
    await act(async () => root.render(<FundProject chainId={1} projectId="7" />))
    expect(host.querySelector('[data-testid="shop-FUND"]')).toBe(fundShop)
    expect(fundShop?.dataset.projectId).toBe('7')
    const incomeShop = host.querySelector<HTMLElement>('[data-testid="shop-INCOME"]')
    expect(incomeShop?.dataset.chainId).toBe('1')
    expect(incomeShop?.dataset.projectId).toBe('9')
    expect(runtime.send).not.toHaveBeenCalled()
  })

  it('keeps FUND submissions mounted when a linked INCOME project becomes discoverable', async () => {
    await render()
    const mounted = runtime.mounted
    runtime.incomeId = 9n
    await render()
    expect(runtime.unmounted).toBe(0)
    expect(runtime.mounted).toBe(mounted)
    const choices = host.querySelector('[aria-label="Payment token"]')!
    const buttons = [...choices.querySelectorAll<HTMLButtonElement>('button')]
    expect(buttons.map(button => button.textContent)).toEqual(['FUND', 'INCOME'])
    for (const button of [buttons[0], buttons[1], buttons[0]]) await act(async () => button.click())
    expect(runtime.unmounted).toBe(0)
    expect(host.textContent).toContain('Waiting for onchain confirmation')
  })

  it('offers only token transfers and burns to holders', async () => {
    runtime.phase = 'idle'
    runtime.query = { ...runtime.query, data: { ...state(), tokenAddress: '0x5555555555555555555555555555555555555555' } }
    await render()
    expect(host.querySelector('option[value="activateRewards"]')).toBeNull()
    expect(host.querySelector('option[value="claimCredits"]')).toBeNull()
    expect(host.textContent).toContain('Transfer FUND tokens')
    expect(runtime.send).not.toHaveBeenCalled()
  })

  it('tells a wallet outside the allowlist before any payment review and lets the owner manage the list', async () => {
    runtime.phase = 'idle'
    runtime.query = { ...runtime.query, data: { ...state(), allowlist: { hook: '0x4545454545454545454545454545454545454545', open: false, accountAllowed: false } } }
    await render()
    expect(host.textContent).toContain('Your wallet is not on this FUND’s allowlist')
    expect(host.textContent).not.toContain('Pay on Ethereum')
    await tab('Operators')
    const section = host.querySelector('[aria-label="Payment allowlist"]')!
    expect(section.textContent).toContain('Closed: only allowed wallets can receive FUND')
    const textarea = section.querySelector('textarea')!
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, '0x2222222222222222222222222222222222222222\n0x3333333333333333333333333333333333333333'); textarea.dispatchEvent(new Event('input', { bubbles: true })) })
    await act(async () => [...section.querySelectorAll('button')].find(button => button.textContent === 'Allow')!.click())
    expect(runtime.send).toHaveBeenCalledTimes(1)
    const [request] = runtime.send.mock.calls[0]
    expect(request.functionName).toBe('setAllowed')
    expect(request.args).toEqual([7n, ['0x2222222222222222222222222222222222222222', '0x3333333333333333333333333333333333333333'], true])
    await act(async () => [...section.querySelectorAll('button')].find(button => button.textContent === 'Open to everyone')!.click())
    expect(runtime.send.mock.calls[1][0].functionName).toBe('setOpen')
    expect(runtime.send.mock.calls[1][0].args).toEqual([7n, true])
  })

  it('does not gate payments once the owner opens the FUND or the wallet is allowed', async () => {
    runtime.phase = 'idle'
    runtime.query = { ...runtime.query, data: { ...state(), allowlist: { hook: '0x4545454545454545454545454545454545454545', open: false, accountAllowed: true } } }
    await render()
    expect(host.textContent).not.toContain('not on this FUND’s allowlist')
    runtime.query = { ...runtime.query, data: { ...state(), allowlist: { hook: '0x4545454545454545454545454545454545454545', open: true, accountAllowed: false } } }
    await render()
    expect(host.textContent).not.toContain('not on this FUND’s allowlist')
    await tab('Operators')
    expect(host.querySelector('[aria-label="Payment allowlist"]')?.textContent).toContain('Open: anyone can contribute')
  })

  it('keeps submitted transaction watchers mounted after a background RPC failure', async () => {
    await render()
    const mounted = runtime.mounted
    expect(mounted).toBeGreaterThan(0)
    runtime.query = { ...runtime.query, isError: true, error: new Error('RPC offline') }
    await render()
    expect(runtime.mounted).toBe(mounted)
    expect(runtime.unmounted).toBe(0)
    expect(host.querySelector('fieldset[aria-label="Project transactions"]')?.hasAttribute('disabled')).toBe(true)
    expect(host.textContent).toContain('Waiting for onchain confirmation')
    const income = host.querySelector('[data-testid="income"]')!
    expect(income.closest('fieldset[disabled]')).toBeNull()
    expect(income.querySelector('button')?.disabled).toBe(true)
  })

  it('retains submitted transaction tracking while a different wallet is being verified', async () => {
    await render()
    const mounted = runtime.mounted
    runtime.address = '0x4444444444444444444444444444444444444444'
    runtime.query = { ...runtime.query, data: undefined, isPending: true, isFetching: true }
    await render()
    expect(runtime.mounted).toBe(mounted)
    expect(runtime.unmounted).toBe(0)
    expect(host.querySelector('fieldset[aria-label="Project transactions"]')?.hasAttribute('disabled')).toBe(true)
  })

  it('fails closed for an unsupported controller without destroying pending receipt watchers', async () => {
    await render()
    const mounted = runtime.mounted
    runtime.query = { ...runtime.query, data: { ...state(), controller: zeroAddress, supportedController: false } }
    await render()
    expect(host.querySelector('.hpl-metadata')?.textContent).not.toContain('FUND treasury:')
    expect(host.querySelector('.hpl-metadata')?.textContent).not.toContain('FUND supply:')
    expect(runtime.mounted).toBe(mounted)
    expect(runtime.unmounted).toBe(0)
    expect(host.querySelector('fieldset[aria-label="Project transactions"]')?.hasAttribute('disabled')).toBe(true)
  })
})
