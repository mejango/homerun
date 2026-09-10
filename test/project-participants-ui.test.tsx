import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectParticipantsPage } from '../src/lib/project-participants'

const mocks = vi.hoisted(() => ({ get: vi.fn() }))
vi.mock('@/lib/project-participants', async importOriginal => ({ ...await importOriginal<typeof import('../src/lib/project-participants')>(), getProjectParticipants: mocks.get }))
import { ProjectParticipants } from '../src/components/ProjectParticipants'

function page(address = '0x1111111111111111111111111111111111111111', overrides: Partial<ProjectParticipantsPage> = {}): ProjectParticipantsPage {
  return { items: [{ address, chainId: 8453, projectId: 7, version: 6, balance: '3000000000000000000', creditBalance: '3000000000000000000', erc20Balance: '0' }], totalCount: 1, offset: 0, nextOffset: null, ...overrides }
}

describe('holder account view', () => {
  let client: QueryClient
  let root: Root
  let host: HTMLDivElement
  beforeEach(() => {
    mocks.get.mockReset().mockResolvedValue(page())
    client = new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 0, gcTime: Infinity } } })
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
  })
  afterEach(async () => { await act(async () => root.unmount()); client.clear(); host.remove() })
  async function settle() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 25)) }) }
  async function render(id = '7', label = 'FUND') {
    await act(async () => { root.render(<QueryClientProvider client={client}><ProjectParticipants chainId={8453} projectId={id} tokenLabel={label} /></QueryClientProvider>) })
    await settle(); await settle()
  }
  async function click(label: string) {
    const button = [...host.querySelectorAll('button')].find(node => node.textContent === label)!
    expect(button).toBeDefined()
    await act(async () => button.click())
    await settle(); await settle()
  }

  it('includes credit-only holders, the balance breakdown, and exact explorer links without a wallet connection', async () => {
    await render()
    expect(mocks.get).toHaveBeenCalledWith(8453, 7, 0)
    expect(host.textContent).toContain('FUND holders')
    expect(host.textContent).toContain('Total FUND3Wallet tokens0Unclaimed credits3')
    expect(host.querySelector('a')?.href).toBe('https://basescan.org/address/0x1111111111111111111111111111111111111111')
    expect(host.textContent).toContain('1 indexed account')
  })

  it('supports paged accounts and back navigation without combining different query pages', async () => {
    const secondAddress = '0x2222222222222222222222222222222222222222'
    mocks.get.mockImplementation((_chain: number, _project: number, offset: number) => Promise.resolve(offset === 0 ? page(undefined, { totalCount: 2, nextOffset: 1 }) : page(secondAddress, { totalCount: 2, offset: 1 })))
    await render()
    await click('Next')
    expect(mocks.get).toHaveBeenLastCalledWith(8453, 7, 1)
    expect(host.querySelectorAll('li')).toHaveLength(1)
    expect(host.querySelector('a')?.href).toContain(secondAddress)
    expect(host.textContent).toContain('Showing 2–2')
    await click('Previous')
    expect(host.querySelector('a')?.href).toContain('0x111111')
  })

  it('discloses an unavailable index instead of showing zero holders', async () => {
    mocks.get.mockRejectedValue(new Error('Indexer unavailable'))
    await render()
    expect(host.textContent).toContain('Holder balances are temporarily unavailable')
    expect(host.textContent).not.toContain('No positive balances')
    expect(host.textContent).not.toContain('0 indexed')
  })

  it('retains cached balances and labels them stale when a refresh fails', async () => {
    await render()
    mocks.get.mockRejectedValue(new Error('Indexer unavailable'))
    await click('Refresh holders')
    expect(host.textContent).toContain('Showing the last indexed page')
    expect(host.querySelectorAll('li')).toHaveLength(1)
  })

  it('resets pagination and balance scope when switching from FUND to INCOME', async () => {
    mocks.get.mockResolvedValue(page(undefined, { totalCount: 2, nextOffset: 1 }))
    await render()
    await click('Next')
    mocks.get.mockResolvedValue(page('0x2222222222222222222222222222222222222222'))
    await render('8', 'INCOME')
    expect(mocks.get).toHaveBeenLastCalledWith(8453, 8, 0)
    expect(host.textContent).toContain('INCOME holders')
    expect(host.textContent).not.toContain('Total FUND')
    expect(host.querySelector('a')?.href).toContain('0x222222')
  })

  it('supports a successful empty page and refuses unsupported identities without fetching', async () => {
    mocks.get.mockResolvedValue({ items: [], totalCount: 0, offset: 0, nextOffset: null })
    await render()
    expect(host.textContent).toContain('No positive balances are indexed yet')
    mocks.get.mockClear()
    await render('0')
    expect(host.textContent).toContain('not supported by the index')
    expect(mocks.get).not.toHaveBeenCalled()
  })
})
