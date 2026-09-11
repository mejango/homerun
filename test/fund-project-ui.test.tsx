import { act, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { zeroAddress, type Address } from 'viem'
import type { FundProjectState } from '../src/lib/fund-state'

const runtime = vi.hoisted(() => ({
  address: '0x1111111111111111111111111111111111111111' as Address,
  query: {} as Record<string, unknown>,
  incomeId: undefined as bigint | undefined,
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
vi.mock('@/components/ProjectShop', () => ({ ProjectShop: ({ tokenLabel }: { tokenLabel: string }) => <span data-testid={`shop-${tokenLabel}`}>Project shop</span> }))
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
    : queryKey[0] === 'income-binding' ? { data: runtime.incomeId, isError: false, isFetching: false }
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

describe('live FUND transaction tracking survives refreshed data', () => {
  let root: Root
  let host: HTMLDivElement
  beforeEach(() => {
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }) })
    window.history.replaceState(null, '', '/')
    runtime.incomeId = undefined
    runtime.mounted = 0; runtime.unmounted = 0
    runtime.phase = 'pending'; runtime.delegated = zeroAddress
    runtime.send.mockReset().mockImplementation(async (_request, options) => { await options?.reverify?.(); return null })
    runtime.address = '0x1111111111111111111111111111111111111111'
    runtime.query = { data: state(), isError: false, isPending: false, isFetching: false, isPlaceholderData: false, refetch: vi.fn() }
    host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  })
  afterEach(async () => { await act(async () => root.unmount()); host.remove() })
  async function tab(label: string) {
    let target = [...host.querySelectorAll<HTMLButtonElement>('[role="tab"], [role="menuitemradio"]')].find(button => button.textContent === label)
    if (!target && ['Operators', 'Extras'].includes(label)) {
      await act(async () => host.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')!.click())
      target = [...host.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')].find(button => button.textContent === label)
    }
    expect(target, `Missing ${label} tab`).toBeDefined(); await act(async () => target!.click())
  }
  async function render() {
    await act(async () => root.render(<FundProject chainId={1} projectId="7" />))
    for (const label of ['Owners', 'Market', 'Settlement', 'Operators', 'Overview']) await tab(label)
  }

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
    expect([...host.querySelectorAll('[role="menuitemradio"]')].find(button => button.textContent === 'Operators')?.getAttribute('aria-checked')).toBe('true')
    expect(host.querySelector('[data-testid="income"]')).not.toBeNull()
    expect(host.querySelector('.hpl-metadata')?.textContent).toContain('FUND treasury: <0.000001 ETH')
    expect(host.querySelector('.hpl-metadata')?.textContent).toContain('FUND supply: <0.000001')
    expect(runtime.send).not.toHaveBeenCalled()
  })

  it.each([undefined, 9n])('shows INCOME shop only for a verified linked project (%s)', async (incomeId) => {
    runtime.incomeId = incomeId
    await render()
    await tab('Shop')
    expect(host.querySelector('[data-testid="shop-FUND"]')).not.toBeNull()
    expect(host.querySelector('[data-testid="shop-INCOME"]') !== null).toBe(incomeId !== undefined)
    expect(host.querySelector('.hpl-metadata')?.textContent).not.toContain('INCOME treasury:')
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

  it('does not offer vanilla voting activation as the new Sticky reward path', async () => {
    runtime.phase = 'idle'
    runtime.query = { ...runtime.query, data: { ...state(), tokenAddress: '0x5555555555555555555555555555555555555555' } }
    await render()
    expect(host.querySelector('option[value="activateRewards"]')).toBeNull()
    expect(host.textContent).toContain('Claim credits as wallet tokens')
    expect(runtime.send).not.toHaveBeenCalled()
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
