import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BsProject } from '../src/lib/bendystraw'
import type { ProjectHolder } from '../src/lib/project-participants'

const mocks = vi.hoisted(() => ({ holders: vi.fn(), project: vi.fn(), group: vi.fn() }))
vi.mock('@/lib/project-participants', async importOriginal => ({ ...await importOriginal<typeof import('../src/lib/project-participants')>(), getProjectHolders: mocks.holders }))
vi.mock('@/lib/bendystraw', async importOriginal => ({ ...await importOriginal<typeof import('../src/lib/bendystraw')>(), getProject: mocks.project, getSuckerGroupProjects: mocks.group }))
import { ProjectParticipants } from '../src/components/ProjectParticipants'

const FIRST = '0x1111111111111111111111111111111111111111'
function holder(address = FIRST, overrides: Partial<ProjectHolder> = {}): ProjectHolder {
  return { address, balance: 3n * 10n ** 18n, creditBalance: 3n * 10n ** 18n, erc20Balance: 0n, chains: [8453], ...overrides }
}
function indexRow(overrides: Partial<BsProject> = {}): BsProject {
  return { chainId: 8453, projectId: 7, version: 6, suckerGroupId: null, ...overrides } as BsProject
}

describe('holder account view', () => {
  let client: QueryClient
  let root: Root
  let host: HTMLDivElement
  beforeEach(() => {
    mocks.holders.mockReset().mockResolvedValue({ holders: [holder()], complete: true })
    mocks.project.mockReset().mockResolvedValue(indexRow())
    mocks.group.mockReset().mockResolvedValue([])
    client = new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 0, gcTime: Infinity } } })
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
  })
  afterEach(async () => { await act(async () => root.unmount()); client.clear(); host.remove() })
  async function settle() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 25)) }) }
  async function render(id = '7', label = 'FUND') {
    await act(async () => { root.render(<QueryClientProvider client={client}><ProjectParticipants chainId={8453} projectId={id} tokenLabel={label} /></QueryClientProvider>) })
    await settle(); await settle(); await settle()
  }
  async function click(label: string) {
    const button = [...host.querySelectorAll('button')].find(node => node.textContent === label)!
    expect(button).toBeDefined()
    await act(async () => button.click())
    await settle()
  }

  it('includes credit-only holders, the balance breakdown, and exact explorer links without a wallet connection', async () => {
    await render()
    expect(mocks.holders).toHaveBeenCalledWith([[8453, 7]], { signal: expect.any(AbortSignal) })
    expect(host.textContent).toContain('FUND holders')
    expect(host.textContent).toContain('Total FUND3Wallet tokens0Unclaimed credits3')
    expect(host.querySelector('a')?.href).toBe(`https://basescan.org/address/${FIRST}`)
    expect(host.textContent).toContain('1 holder')
    expect(host.textContent).not.toContain('across')
  })

  it('reads every chain of the project and shows one row per holder with the chains it holds on', async () => {
    mocks.project.mockResolvedValue(indexRow({ suckerGroupId: 'group-1' }))
    mocks.group.mockResolvedValue([indexRow({ chainId: 10, projectId: 9, suckerGroupId: 'group-1' }), indexRow({ suckerGroupId: 'group-1' })])
    mocks.holders.mockResolvedValue({ holders: [holder(FIRST, { chains: [10, 8453] })], complete: true })
    await render()
    expect(mocks.group).toHaveBeenCalledWith('group-1', 8453, { signal: expect.any(AbortSignal) })
    expect(mocks.holders).toHaveBeenLastCalledWith([[10, 9], [8453, 7]], { signal: expect.any(AbortSignal) })
    expect(host.textContent).toContain('across 2 chains')
    expect(host.querySelector('[aria-label="Holds on Optimism, Base"]')).not.toBeNull()
    expect(host.querySelector('a')?.href).toBe(`https://optimistic.etherscan.io/address/${FIRST}`)
  })

  it('keeps this chain alone when the group names another project on it', async () => {
    mocks.project.mockResolvedValue(indexRow({ suckerGroupId: 'group-1' }))
    mocks.group.mockResolvedValue([indexRow({ projectId: 8, suckerGroupId: 'group-1' }), indexRow({ chainId: 10, projectId: 9, suckerGroupId: 'group-1' })])
    await render()
    expect(mocks.holders).toHaveBeenLastCalledWith([[8453, 7]], { signal: expect.any(AbortSignal) })
  })

  it('pages the folded list and says when a deployment was only partly read', async () => {
    const many = Array.from({ length: 30 }, (_, index) => holder(`0x${(index + 1).toString(16).padStart(40, '0')}`))
    mocks.holders.mockResolvedValue({ holders: many, complete: false })
    await render()
    expect(host.textContent).toContain('30+ holders / Showing 1–25')
    expect(host.querySelectorAll('li')).toHaveLength(25)
    await click('Next')
    expect(host.textContent).toContain('Showing 26–30')
    expect(host.querySelectorAll('li')).toHaveLength(5)
    await click('Previous')
    expect(host.textContent).toContain('Showing 1–25')
  })

  it('discloses an unavailable index instead of showing zero holders', async () => {
    mocks.holders.mockRejectedValue(new Error('Indexer unavailable'))
    await render()
    expect(host.textContent).toContain('Holder balances are temporarily unavailable')
    expect(host.textContent).not.toContain('No one holds')
    expect(host.textContent).not.toContain('0 holders')
  })

  it('retains cached balances and labels them stale when a refresh fails', async () => {
    await render()
    mocks.holders.mockRejectedValue(new Error('Indexer unavailable'))
    await act(async () => { await client.refetchQueries({ queryKey: ['project-participants'] }) })
    await settle()
    expect(host.textContent).toContain('Showing the last list')
    expect(host.querySelectorAll('li')).toHaveLength(1)
  })

  it('lists holders for this chain when the index has no row for the project', async () => {
    mocks.project.mockRejectedValue(new Error('Indexer unavailable'))
    await render()
    expect(mocks.holders).toHaveBeenCalledWith([[8453, 7]], { signal: expect.any(AbortSignal) })
  })

  it('resets pagination and balance scope when switching from FUND to INCOME', async () => {
    mocks.holders.mockResolvedValue({ holders: Array.from({ length: 30 }, (_, index) => holder(`0x${(index + 1).toString(16).padStart(40, '0')}`)), complete: true })
    await render()
    await click('Next')
    mocks.project.mockResolvedValue(indexRow({ projectId: 8 }))
    mocks.holders.mockResolvedValue({ holders: [holder('0x2222222222222222222222222222222222222222')], complete: true })
    await render('8', 'INCOME')
    expect(mocks.holders).toHaveBeenLastCalledWith([[8453, 8]], { signal: expect.any(AbortSignal) })
    expect(host.textContent).toContain('INCOME holders')
    expect(host.textContent).not.toContain('Total FUND')
    expect(host.querySelector('a')?.href).toContain('0x222222')
  })

  it('supports a successful empty list and refuses unsupported identities without fetching', async () => {
    mocks.holders.mockResolvedValue({ holders: [], complete: true })
    await render()
    expect(host.textContent).toContain('No one holds FUND yet')
    mocks.holders.mockClear()
    await render('0')
    expect(host.textContent).toContain('not supported by the index')
    expect(mocks.holders).not.toHaveBeenCalled()
  })
})
