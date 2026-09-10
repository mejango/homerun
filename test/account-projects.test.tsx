import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, type AnchorHTMLAttributes, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BsAccountTokenHolding, BsProject } from '../src/lib/bendystraw'

const ACCOUNT_A = '0x1111111111111111111111111111111111111111'
const ACCOUNT_B = '0x2222222222222222222222222222222222222222'
const mocks = vi.hoisted(() => ({
  wallet: { address: undefined as string | undefined, isConnected: false },
  owned: vi.fn(), holdings: vi.fn(), byRefs: vi.fn(), search: vi.fn(),
}))

vi.mock('@/hooks/useWallet', () => ({ useWallet: () => mocks.wallet }))
vi.mock('@/components/WalletButton', () => ({ WalletButton: () => <button>Connect wallet</button> }))
vi.mock('next/link', () => ({ default: ({ href, children, className }: AnchorHTMLAttributes<HTMLAnchorElement> & { children: ReactNode }) => <a href={href} className={className}>{children}</a> }))
vi.mock('@/lib/bendystraw', () => ({
  getProjectsOwnedBy: mocks.owned,
  getAccountTokenHoldings: mocks.holdings,
  getProjectsByRefs: mocks.byRefs,
  searchProjects: mocks.search,
}))

import { AccountProjects } from '../src/components/AccountProjects'

function project(overrides: Partial<BsProject> = {}): BsProject {
  return {
    chainId: 1, projectId: 7, version: 6, name: 'Neighborhood FUND',
    logoUri: null, projectTagline: null, volume: '0', volumeUsd: '0', balance: '0',
    paymentsCount: 0, contributorsCount: 0, createdAt: 1, suckerGroupId: null,
    token: null, tokenSymbol: 'ETH', decimals: 18, currency: 1, isRevnet: false,
    owner: ACCOUNT_A, metadataUri: null, ...overrides,
  }
}

function holding(overrides: Partial<BsAccountTokenHolding> = {}): BsAccountTokenHolding {
  return { chainId: 1, projectId: 7, balance: '5000000000000000000', creditBalance: '3000000000000000000', erc20Balance: '2000000000000000000', ...overrides }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

describe('account project discovery', () => {
  let host: HTMLDivElement
  let root: Root
  let client: QueryClient

  beforeEach(() => {
    mocks.wallet = { address: undefined, isConnected: false }
    mocks.owned.mockReset().mockResolvedValue([])
    mocks.holdings.mockReset().mockResolvedValue({ items: [], totalCount: 0 })
    mocks.byRefs.mockReset().mockResolvedValue([])
    mocks.search.mockReset().mockResolvedValue([])
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

  async function settle() {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
  }

  async function render(account?: string | null) {
    await act(async () => { root.render(<QueryClientProvider client={client}><AccountProjects account={account} /></QueryClientProvider>) })
    await settle()
    await settle()
  }

  async function search(text: string) {
    const input = host.querySelector<HTMLInputElement>('input[type="search"]')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }

  function section(title: string) {
    const heading = [...host.querySelectorAll('h3')].find(node => node.textContent === title)!
    return heading.closest('section')!
  }

  it('allows debounced search without a wallet and renders remote metadata only as text', async () => {
    mocks.search.mockResolvedValue([
      project({ name: '<img src=x onerror=alert(1)>', logoUri: 'javascript:alert(1)', projectTagline: '<script>alert(1)</script>' }),
      project({ chainId: 8453, projectId: 8, name: 'Neighborhood INCOME', isRevnet: true }),
      project({ projectId: 9, version: 5, name: 'Old version' }),
    ])
    await render()
    expect(host.textContent).toContain('Connect your wallet')
    expect(mocks.owned).not.toHaveBeenCalled()
    expect(mocks.holdings).not.toHaveBeenCalled()
    await search('Neighbor')
    expect(mocks.search).not.toHaveBeenCalled()
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 320)) })
    await settle()
    expect(mocks.search).toHaveBeenCalledExactlyOnceWith('Neighbor', 24, { network: 'mainnet' })
    expect(host.querySelector('a[href="/project/1/7"]')?.textContent).toBe('<img src=x onerror=alert(1)>')
    expect(host.querySelector('a[href="/income/8453/8"]')?.textContent).toBe('Neighborhood INCOME')
    expect(host.querySelector('img, script')).toBeNull()
    expect(host.textContent).not.toContain('Old version')
  })

  it('scopes owned projects to the explicit account and includes credits plus ERC-20 holdings of both project types', async () => {
    mocks.wallet = { address: ACCOUNT_B, isConnected: true }
    const fund = project()
    const income = project({ chainId: 8453, projectId: 8, name: 'Neighborhood INCOME', isRevnet: true })
    mocks.owned.mockResolvedValue([fund, project({ projectId: 10, name: 'Somebody else’s project', owner: ACCOUNT_B })])
    mocks.holdings.mockResolvedValue({ items: [holding(), holding({ chainId: 8453, projectId: 8 })], totalCount: 2 })
    mocks.byRefs.mockResolvedValue([fund, income])
    await render(ACCOUNT_A)
    expect(mocks.owned).toHaveBeenCalledWith([ACCOUNT_A], { network: 'mainnet' })
    expect(mocks.holdings).toHaveBeenCalledWith(ACCOUNT_A, { network: 'mainnet' })
    expect(mocks.byRefs).toHaveBeenCalledWith([
      { chainId: 1, projectId: 7, version: 6 }, { chainId: 8453, projectId: 8, version: 6 },
    ], { network: 'mainnet' })
    expect(section('Owned by this account').textContent).not.toContain('Somebody else')
    expect(section('Token holdings').querySelector('a[href="/project/1/7"]')).not.toBeNull()
    expect(section('Token holdings').querySelector('a[href="/income/8453/8"]')).not.toBeNull()
    expect(section('Token holdings').textContent).toContain('5 project tokens')
    expect(section('Token holdings').textContent).toContain('3 credits / 2 ERC-20')
    expect(section('Token holdings').textContent).not.toContain('5 ETH')
  })

  it('discards the former wallet’s late results when the wallet identity changes', async () => {
    const late = deferred<BsProject[]>()
    mocks.owned.mockImplementation((owners: string[]) => owners[0] === ACCOUNT_A ? late.promise : Promise.resolve([project({ owner: ACCOUNT_B, name: 'Second account project', projectId: 8 })]))
    mocks.wallet = { address: ACCOUNT_A, isConnected: true }
    await render()
    mocks.wallet = { address: ACCOUNT_B, isConnected: true }
    await render()
    expect(host.textContent).toContain('Second account project')
    await act(async () => late.resolve([project({ name: 'Former account project' })]))
    await settle()
    expect(host.textContent).not.toContain('Former account project')
    expect(host.textContent).toContain('Second account project')
    mocks.wallet = { address: ACCOUNT_B, isConnected: false }
    await render()
    expect(host.textContent).not.toContain('Second account project')
    expect(host.textContent).toContain('Connect your wallet')
  })

  it('retains the last successful owned and held data after background index failures', async () => {
    mocks.owned.mockResolvedValue([project()])
    mocks.holdings.mockResolvedValue({ items: [holding()], totalCount: 1 })
    mocks.byRefs.mockResolvedValue([project()])
    await render(ACCOUNT_A)
    mocks.owned.mockRejectedValue(new Error('Index offline'))
    mocks.holdings.mockRejectedValue(new Error('Index offline'))
    await act(async () => { await client.invalidateQueries({ queryKey: ['account-projects'] }) })
    await settle()
    expect(section('Owned by this account').textContent).toContain('Showing the last indexed data')
    expect(section('Owned by this account').querySelector('a[href="/project/1/7"]')).not.toBeNull()
    expect(section('Token holdings').textContent).toContain('Showing the last indexed data')
    expect(section('Token holdings').textContent).toContain('5 project tokens')
  })

  it('keeps holdings visible when project metadata fails without guessing a FUND link', async () => {
    mocks.holdings.mockResolvedValue({ items: [holding()], totalCount: 1 })
    mocks.byRefs.mockRejectedValue(new Error('Details unavailable'))
    await render(ACCOUNT_A)
    expect(section('Token holdings').textContent).toContain('5 project tokens')
    expect(section('Token holdings').textContent).toContain('Could not load holding details')
    expect(section('Token holdings').querySelector('a')).toBeNull()
    mocks.byRefs.mockResolvedValue([project({ isRevnet: true, name: 'Recovered INCOME' })])
    await act(async () => { [...host.querySelectorAll('button')].find(node => node.textContent === 'Retry holding details')!.click() })
    await settle()
    expect(section('Token holdings').querySelector('a[href="/income/1/7"]')?.textContent).toBe('Recovered INCOME')
  })

  it('isolates mainnet and testnet queries and clears the previous network’s rows', async () => {
    mocks.owned.mockImplementation((_owners, options) => Promise.resolve([options.network === 'testnet'
      ? project({ chainId: 11155111, name: 'Testnet FUND' }) : project({ name: 'Mainnet FUND' })]))
    await render(ACCOUNT_A)
    expect(host.textContent).toContain('Mainnet FUND')
    await act(async () => {
      const select = host.querySelector('select')!
      select.value = 'testnet'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await settle()
    expect(mocks.owned).toHaveBeenCalledWith([ACCOUNT_A], { network: 'testnet' })
    expect(mocks.holdings).toHaveBeenCalledWith(ACCOUNT_A, { network: 'testnet' })
    expect(host.textContent).not.toContain('Mainnet FUND')
    expect(host.querySelector('a[href="/project/11155111/7"]')?.textContent).toBe('Testnet FUND')
  })

  it('does not query an invalid explicit account or silently replace it with the connected wallet', async () => {
    mocks.wallet = { address: ACCOUNT_A, isConnected: true }
    await render('not-an-address')
    expect(host.textContent).toContain('This account address is invalid')
    expect(mocks.owned).not.toHaveBeenCalled()
    expect(mocks.holdings).not.toHaveBeenCalled()
  })
})
