import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, type AnchorHTMLAttributes, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Address } from 'viem'
import type { BsAccountActivityEvent, BsAccountNft, BsProject } from '../src/lib/bendystraw'

const ACCOUNT_A = '0x1111111111111111111111111111111111111111' as const
const ACCOUNT_B = '0x2222222222222222222222222222222222222222' as const
const HOOK_A = '0x3333333333333333333333333333333333333333'
const HOOK_B = '0x4444444444444444444444444444444444444444'
const mocks = vi.hoisted(() => ({
  wallet: { address: undefined as Address | undefined, isConnected: false },
  name: null as string | null,
  activity: vi.fn(), nfts: vi.fn(), grants: vi.fn(), owned: vi.fn(), holdings: vi.fn(), byRefs: vi.fn(), search: vi.fn(),
}))
vi.mock('@/hooks/useWallet', () => ({ useWallet: () => mocks.wallet }))
vi.mock('@/hooks/useAccountIdentity', () => ({ useAccountIdentity: (address: string) => ({ name: mocks.name, label: `${address.slice(0, 6)}…${address.slice(-4)}` }) }))
vi.mock('@/components/WalletButton', () => ({ WalletButton: () => <button>Sign in</button> }))
vi.mock('next/link', () => ({ default: ({ href, children, className }: AnchorHTMLAttributes<HTMLAnchorElement> & { children: ReactNode }) => <a href={href} className={className}>{children}</a> }))
vi.mock('next/navigation', async () => {
  const { useMemo, useSyncExternalStore } = await import('react')
  const subscribe = (notify: () => void) => {
    window.addEventListener('popstate', notify)
    return () => window.removeEventListener('popstate', notify)
  }
  return {
    notFound: () => { throw new Error('NOT_FOUND') },
    useSearchParams: () => {
      const url = useSyncExternalStore(subscribe, () => window.location.href)
      return useMemo(() => new URL(url).searchParams, [url])
    },
  }
})
vi.mock('@/lib/bendystraw', () => ({
  getAccountActivity: mocks.activity, getAccountNfts: mocks.nfts, getOperatorGrants: mocks.grants,
  getProjectsOwnedBy: mocks.owned, getAccountTokenHoldings: mocks.holdings,
  getProjectsByRefs: mocks.byRefs, searchProjects: mocks.search,
}))

import { AccountView } from '../src/components/AccountView'
import AccountPage, { generateMetadata } from '../src/app/account/[address]/page'

function project(overrides: Partial<BsProject> = {}): BsProject {
  return {
    chainId: 1, projectId: 7, version: 6, name: 'Neighborhood FUND', logoUri: null, projectTagline: null,
    volume: '0', volumeUsd: '0', balance: '0', paymentsCount: 0, contributorsCount: 0,
    createdAt: 1, suckerGroupId: null, token: null, tokenSymbol: 'ETH', decimals: 18,
    currency: 1, isRevnet: false, owner: ACCOUNT_A, metadataUri: null, ...overrides,
  }
}
function event(overrides: Partial<BsAccountActivityEvent> = {}): BsAccountActivityEvent {
  return {
    id: 'event-1', chainId: 1, projectId: 7, version: 6, timestamp: 1_750_000_000, from: ACCOUNT_A,
    txHash: `0x${'a'.repeat(64)}`, payEvent: { amount: '1', amountUsd: null, beneficiary: ACCOUNT_A, memo: null, newlyIssuedTokenCount: '0' },
    cashOutTokensEvent: null, project: { name: 'Neighborhood FUND', logoUri: null, tokenSymbol: 'ETH', decimals: 18, isRevnet: false }, ...overrides,
  }
}
function nft(overrides: Partial<BsAccountNft> = {}): BsAccountNft {
  return { chainId: 1, projectId: 7, tokenId: '100', tierId: 1, createdAt: 1, hook: { address: HOOK_A }, tier: { resolvedUri: null, metadata: { name: 'Weekend stay' } }, ...overrides }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

describe('public account dashboard', () => {
  let host: HTMLDivElement
  let root: Root
  let client: QueryClient
  let clipboard: ReturnType<typeof vi.fn>

  beforeEach(() => {
    mocks.wallet = { address: undefined, isConnected: false }
    mocks.name = null
    mocks.activity.mockReset().mockResolvedValue({ items: [], totalCount: 0 })
    mocks.nfts.mockReset().mockResolvedValue({ items: [], totalCount: 0 })
    mocks.grants.mockReset().mockResolvedValue([])
    mocks.owned.mockReset().mockResolvedValue([])
    mocks.holdings.mockReset().mockResolvedValue({ items: [], totalCount: 0 })
    mocks.byRefs.mockReset().mockResolvedValue([])
    mocks.search.mockReset().mockResolvedValue([])
    clipboard = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', Object.assign(Object.create(navigator), { clipboard: { writeText: clipboard } }))
    window.history.replaceState({}, '', `/account/${ACCOUNT_A}`)
    const replaceState = window.history.replaceState.bind(window.history)
    vi.spyOn(window.history, 'replaceState').mockImplementation((state, unused, url) => {
      replaceState(state, unused, url)
      // Model Next's publication of externally replaced URLs to navigation hooks.
      window.dispatchEvent(new PopStateEvent('popstate'))
    })
    client = new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 0, gcTime: Infinity } } })
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
  })
  afterEach(async () => {
    await act(async () => root.unmount())
    client.clear()
    host.remove()
  })
  async function settle() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) }) }
  async function render(address: Address = ACCOUNT_A, network: 'mainnet' | 'testnet' = 'mainnet') {
    await act(async () => root.render(<QueryClientProvider client={client}><AccountView key={`${address}:${network}`} address={address} initialNetwork={network} /></QueryClientProvider>))
    await settle()
    await settle()
  }
  function tab(label: string) { return [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(node => node.textContent === label)! }
  async function openTab(label: string) { await act(async () => tab(label).click()); await settle(); await settle() }
  function button(label: string) { return [...host.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === label)! }
  function panel() { return host.querySelector<HTMLElement>('[role="tabpanel"]:not([hidden])')! }

  it('shows the viewed address when disconnected or signed in to another wallet, with working identity and copy controls', async () => {
    await render()
    expect(mocks.activity).toHaveBeenCalledWith(ACCOUNT_A, { network: 'mainnet', limit: 25, offset: 0 })
    expect(host.textContent).toContain(ACCOUNT_A)
    expect(host.textContent).not.toContain('Signed in to this account')
    expect(mocks.owned).not.toHaveBeenCalled()
    await act(async () => button('Copy address').click())
    expect(clipboard).toHaveBeenCalledWith(ACCOUNT_A)
    expect(host.textContent).toContain('Address copied.')
    expect(host.querySelector(`a[href="https://basescan.org/address/${ACCOUNT_A}"]`)).not.toBeNull()

    mocks.wallet = { address: ACCOUNT_B, isConnected: true }
    mocks.name = 'haus.eth'
    await render()
    expect(host.querySelector('h1')?.textContent).toBe('haus.eth')
    expect(host.textContent).not.toContain('Signed in to this account')
    expect(mocks.activity.mock.calls.every(([address]) => address === ACCOUNT_A)).toBe(true)
    mocks.wallet = { address: ACCOUNT_A, isConnected: true }
    await render()
    expect(host.textContent).toContain('Signed in to this account')
    clipboard.mockRejectedValue(new Error('Clipboard denied'))
    await act(async () => button('Copy address').click())
    expect(host.textContent).toContain('Could not copy. Select the address above')
    expect(host.textContent).not.toContain('Address copied.')
  })

  it('supports linked tabs and roving keyboard focus', async () => {
    window.history.replaceState({}, '', `/account/${ACCOUNT_A}#holdings`)
    await render()
    expect(tab('Holdings').getAttribute('aria-selected')).toBe('true')
    expect(panel().textContent).toContain('Token holdings')
    expect(panel().textContent).toContain('Store items')
    await act(async () => tab('Holdings').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })))
    await settle()
    expect(document.activeElement).toBe(tab('Projects'))
    expect(window.location.hash).toBe('#projects')
    expect(panel().textContent).toContain('Your projects')
    expect(panel().textContent).toContain('Delegated access')
    expect([...host.querySelectorAll('[role="tab"]')].filter(node => node.getAttribute('tabindex') === '0')).toHaveLength(1)
    await act(async () => tab('Projects').dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true })))
    expect(document.activeElement).toBe(tab('Activity'))
    expect(tab('Activity').getAttribute('aria-controls')).toBe(panel().id)
  })

  it('keeps multichain events distinct, uses project phase links, and loads later activity pages', async () => {
    const first = event()
    const second = event({ chainId: 8453, projectId: 8, project: { ...first.project!, name: 'Neighborhood INCOME', isRevnet: true } })
    mocks.activity.mockImplementation((_account, { offset }) => Promise.resolve(offset === 0
      ? { items: [first, second], totalCount: 3 }
      : { items: [event({ id: 'older', projectId: 9, project: null })], totalCount: 3 }))
    await render()
    expect(panel().querySelectorAll('ol > li')).toHaveLength(2)
    expect(panel().querySelector('a[href="/project/1/7"]')?.textContent).toBe('Neighborhood FUND')
    expect(panel().querySelector('a[href="/income/8453/8"]')?.textContent).toBe('Neighborhood INCOME')
    await act(async () => button('Load more activity').click())
    await settle()
    expect(mocks.activity).toHaveBeenCalledWith(ACCOUNT_A, { network: 'mainnet', limit: 25, offset: 2 })
    expect(panel().querySelectorAll('ol > li')).toHaveLength(3)
    expect(panel().textContent).toContain('Project 9')
    expect(panel().querySelector('a[href="/project/1/9"]')).toBeNull()
    expect(button('Load more activity')).toBeUndefined()
  })

  it('preserves activity after a refresh fails and never presents an initial error as an empty account', async () => {
    mocks.activity.mockRejectedValue(new Error('Index offline'))
    await render()
    expect(panel().textContent).toContain('Could not load activity')
    expect(panel().textContent).not.toContain('No account activity')
    mocks.activity.mockResolvedValue({ items: [event()], totalCount: 1 })
    await act(async () => button('Retry activity').click())
    await settle()
    expect(panel().textContent).toContain('Neighborhood FUND')
    mocks.activity.mockRejectedValue(new Error('Index offline'))
    await act(async () => { await client.invalidateQueries({ queryKey: ['account-view', 'activity'] }) })
    await settle()
    expect(panel().textContent).toContain('Showing the last available data')
    expect(panel().textContent).toContain('Neighborhood FUND')
  })

  it('keeps held store collections separate and treats their metadata as text', async () => {
    mocks.holdings.mockResolvedValue({ items: [{ chainId: 1, projectId: 7, balance: '5000000000000000000', creditBalance: '3000000000000000000', erc20Balance: '2000000000000000000' }], totalCount: 1 })
    mocks.nfts.mockResolvedValue({ items: [nft(), nft({ tokenId: '101' }), nft({ hook: { address: HOOK_B }, tokenId: '102', tier: { resolvedUri: null, metadata: { name: '<img src=x onerror=alert(1)>' } } }), nft({ chainId: 8453, projectId: 8, tier: { metadata: null, resolvedUri: 'data:application/json,%7B%22name%22%3A%22Dinner%22%7D' } })], totalCount: 4 })
    mocks.byRefs.mockResolvedValue([project(), project({ chainId: 8453, projectId: 8, name: 'Neighborhood INCOME', isRevnet: true })])
    await render()
    await openTab('Holdings')
    const items = panel().querySelector('section[aria-label="Store items"]')!
    expect(items.querySelectorAll('li')).toHaveLength(3)
    expect(items.textContent).toContain('Weekend stay2 owned')
    expect(items.textContent).toContain('<img src=x onerror=alert(1)>1 owned')
    expect(items.querySelector('img, script')).toBeNull()
    expect(items.querySelector('a[href="/income/8453/8#shop"]')).not.toBeNull()
    expect(items.textContent).toContain('Dinner')
    expect(panel().textContent).toContain('5 project tokens')
    expect(panel().textContent).not.toContain('5 ETH')
  })

  it('shows owned and delegated projects while keeping wildcard grants out of project reference queries', async () => {
    mocks.owned.mockResolvedValue([project()])
    mocks.grants.mockResolvedValue([
      { chainId: 1, projectId: 0, version: 6, permissions: [1, 2], account: ACCOUNT_B, operator: ACCOUNT_A, isRevnetOperator: false },
      { chainId: 8453, projectId: 8, version: 6, permissions: [5], account: ACCOUNT_B, operator: ACCOUNT_A, isRevnetOperator: true },
      { chainId: 1, projectId: 99, version: 6, permissions: [5], account: ACCOUNT_A, operator: ACCOUNT_B, isRevnetOperator: false },
    ])
    mocks.byRefs.mockResolvedValue([project({ chainId: 8453, projectId: 8, name: 'Neighborhood INCOME', isRevnet: true })])
    await render()
    await openTab('Projects')
    expect(mocks.byRefs).toHaveBeenCalledExactlyOnceWith([{ chainId: 8453, projectId: 8, version: 6 }], { network: 'mainnet' })
    expect(panel().textContent).toContain('All projects')
    expect(panel().querySelector(`a[href="/account/${ACCOUNT_B}#projects"]`)).not.toBeNull()
    expect(panel().querySelector('a[href="/project/1/7"]')).not.toBeNull()
    expect(panel().querySelector('a[href="/income/8453/8"]')).not.toBeNull()
    expect(panel().textContent).not.toContain('Project 99')
    expect(mocks.holdings).not.toHaveBeenCalled()
    await act(async () => window.history.replaceState(null, '', `/account/${ACCOUNT_A}?network=testnet#projects`))
    await render(ACCOUNT_A, 'testnet')
    expect(panel().querySelector(`a[href="/account/${ACCOUNT_B}?network=testnet#projects"]`)).not.toBeNull()
  })

  it('switches data and explorer links to testnet without accepting late results from the former network', async () => {
    const late = deferred<{ items: BsAccountActivityEvent[]; totalCount: number }>()
    mocks.activity.mockImplementation((_account, { network }) => network === 'mainnet' ? late.promise
      : Promise.resolve({ items: [event({ chainId: 84532, project: { ...event().project!, name: 'Testnet activity' } })], totalCount: 1 }))
    await render()
    expect(panel().textContent).toContain('Loading activity')
    await act(async () => {
      const select = host.querySelector<HTMLSelectElement>('select[aria-label="Account network"]')!
      select.value = 'testnet'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await settle()
    expect(window.location.search).toBe('?network=testnet')
    expect(host.querySelector(`a[href="https://sepolia.basescan.org/address/${ACCOUNT_A}"]`)).not.toBeNull()
    expect(host.querySelector(`a[href="https://basescan.org/address/${ACCOUNT_A}"]`)).toBeNull()
    expect(panel().textContent).toContain('Testnet activity')
    await act(async () => late.resolve({ items: [event()], totalCount: 1 }))
    await settle()
    expect(panel().textContent).not.toContain('Neighborhood FUND')
    expect(panel().textContent).toContain('Testnet activity')
  })

  it('retains the account address when opening Holdings and distinguishes unavailable item data from empty holdings', async () => {
    mocks.wallet = { address: ACCOUNT_B, isConnected: true }
    mocks.nfts.mockRejectedValue(new Error('Items unavailable'))
    await render()
    await openTab('Holdings')
    expect(mocks.nfts).toHaveBeenCalledWith(ACCOUNT_A, { network: 'mainnet' })
    expect(mocks.holdings).toHaveBeenCalledWith(ACCOUNT_A, { network: 'mainnet' })
    expect(panel().textContent).toContain('Could not load store items')
    expect(panel().textContent).not.toContain('No store items held')
  })

  it('follows same-account navigation back to mainnet after a local testnet selection', async () => {
    mocks.activity.mockImplementation((_account, { network }) => Promise.resolve({
      items: [event({ chainId: network === 'testnet' ? 84532 : 8453, project: { ...event().project!, name: `${network} activity` } })], totalCount: 1,
    }))
    await render()
    await openTab('Projects')
    await act(async () => {
      const select = host.querySelector<HTMLSelectElement>('select[aria-label="Account network"]')!
      select.value = 'testnet'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await settle()
    expect(window.history.replaceState).toHaveBeenLastCalledWith(null, '', `/account/${ACCOUNT_A}?network=testnet#projects`)
    expect(host.querySelector<HTMLSelectElement>('select')?.value).toBe('testnet')
    // The account route may reuse its original mainnet server props. The live URL must win.
    await act(async () => window.history.replaceState(null, '', `/account/${ACCOUNT_A}`))
    await settle()
    expect(host.querySelector<HTMLSelectElement>('select')?.value).toBe('mainnet')
    expect(tab('Activity').getAttribute('aria-selected')).toBe('true')
    expect(panel().textContent).toContain('mainnet activity')
    expect(host.querySelector(`a[href="https://basescan.org/address/${ACCOUNT_A}"]`)).not.toBeNull()
    expect(host.querySelector(`a[href="https://sepolia.basescan.org/address/${ACCOUNT_A}"]`)).toBeNull()
  })

  it('validates route addresses before rendering and includes account identity in metadata', async () => {
    await expect(AccountPage({ params: Promise.resolve({ address: 'not-an-address' }), searchParams: Promise.resolve({}) })).rejects.toThrow('NOT_FOUND')
    await expect(generateMetadata({ params: Promise.resolve({ address: '<script>' }), searchParams: Promise.resolve({}) })).rejects.toThrow('NOT_FOUND')
    const metadata = await generateMetadata({ params: Promise.resolve({ address: ACCOUNT_A }), searchParams: Promise.resolve({}) })
    expect(metadata.title).toContain('0x1111…1111')
    expect(metadata.alternates?.canonical).toBe(`/account/${ACCOUNT_A}`)
    const page = await AccountPage({ params: Promise.resolve({ address: ACCOUNT_A }), searchParams: Promise.resolve({ network: 'testnet' }) })
    const main = page.props.children.find((child: { type?: string }) => child.type === 'main')
    expect(main.props.children.key).toBe(`${ACCOUNT_A}:testnet`)
    expect(main.props.children.props.initialNetwork).toBe('testnet')
  })
})
