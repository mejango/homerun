import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BsActivityEvent, BsProject } from '../src/lib/bendystraw'

const mocks = vi.hoisted(() => ({ project: vi.fn(), exact: vi.fn(), group: vi.fn() }))
vi.mock('@/lib/bendystraw', () => ({
  getProject: mocks.project,
  getProjectActivityByProject: mocks.exact,
  getProjectActivity: mocks.group,
}))

import { ProjectActivity } from '../src/components/ProjectActivity'

type Page = { items: BsActivityEvent[]; totalCount: number }

function event(id: number, overrides: Partial<BsActivityEvent> = {}): BsActivityEvent {
  return {
    id: `event-${id}`, chainId: 1, projectId: 7, timestamp: 1_700_000_000 + id,
    from: '0x1111111111111111111111111111111111111111', txHash: `0x${id.toString(16).padStart(64, '0')}`,
    payEvent: null, cashOutTokensEvent: null, projectCreateEvent: { from: '0x1111111111111111111111111111111111111111' },
    ...overrides,
  }
}

function project(overrides: Partial<BsProject> = {}): BsProject {
  return {
    chainId: 1, projectId: 7, version: 6, name: 'Neighborhood FUND', logoUri: null,
    projectTagline: null, volume: '0', volumeUsd: '0', balance: '0', paymentsCount: 0,
    contributorsCount: 0, createdAt: 1, suckerGroupId: null, token: null,
    tokenSymbol: 'ETH', decimals: 18, currency: 1, isRevnet: false,
    owner: '0x1111111111111111111111111111111111111111', metadataUri: null,
    ...overrides,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

describe('indexed project activity', () => {
  let client: QueryClient
  let root: Root
  let host: HTMLDivElement

  beforeEach(() => {
    mocks.project.mockReset().mockResolvedValue(null)
    mocks.exact.mockReset().mockResolvedValue({ items: [], totalCount: 0 })
    mocks.group.mockReset().mockResolvedValue({ items: [], totalCount: 0 })
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

  async function render(projectId: string | number | bigint = '7', chainId = 1) {
    await act(async () => { root.render(<QueryClientProvider client={client}><ProjectActivity chainId={chainId} projectId={projectId} /></QueryClientProvider>) })
    await settle()
    await settle()
  }

  function eventIds() {
    return [...host.querySelectorAll('li pre')].map(node => (JSON.parse(node.textContent!) as BsActivityEvent).id)
  }

  async function click(label: string) {
    const button = [...host.querySelectorAll('button')].find(node => node.textContent === label)!
    expect(button).toBeDefined()
    await act(async () => button.click())
    await settle()
    await settle()
  }

  it('loads exact project history when group discovery fails', async () => {
    mocks.project.mockRejectedValue(new Error('Project metadata unavailable'))
    mocks.exact.mockResolvedValue({ items: [event(1)], totalCount: 1 })
    await render()
    expect(mocks.exact).toHaveBeenCalledWith(1, 7, 20, 0)
    expect(mocks.group).not.toHaveBeenCalled()
    expect(eventIds()).toEqual(['event-1'])
    expect(host.textContent).toContain('Activity on this project’s network')
    expect(host.textContent).not.toContain('No activity indexed yet')
  })

  it('uses group history only after the indexed row verifies the requested chain, project, and V6 identity', async () => {
    const lookup = deferred<BsProject>()
    mocks.project.mockReturnValue(lookup.promise)
    mocks.exact.mockResolvedValue({ items: [event(1)], totalCount: 1 })
    mocks.group.mockResolvedValue({ items: [event(2, { chainId: 8453, projectId: 8 })], totalCount: 1 })
    await render()
    expect(eventIds()).toEqual(['event-1'])
    expect(mocks.group).not.toHaveBeenCalled()
    await act(async () => lookup.resolve(project({ suckerGroupId: 'verified-linked-projects' })))
    await settle()
    await settle()
    expect(mocks.group).toHaveBeenCalledWith('verified-linked-projects', 20, 1, 0)
    expect(host.textContent).toContain('Activity across this project’s linked chains')
    expect(eventIds()).toEqual(['event-2'])
  })

  it('retains successful exact-project history and disables pagination when the discovered group feed fails', async () => {
    const lookup = deferred<BsProject>()
    mocks.project.mockReturnValue(lookup.promise)
    mocks.exact.mockImplementation((_chain: number, _project: number, _limit: number, offset: number) => Promise.resolve(offset === 0
      ? { items: [event(3), event(2)], totalCount: 6 }
      : { items: [event(1), event(0)], totalCount: 6 }))
    mocks.group.mockRejectedValue(new Error('Linked-chain index unavailable'))
    await render()
    await click('Load more activity')
    expect(eventIds()).toEqual(['event-3', 'event-2', 'event-1', 'event-0'])
    await act(async () => lookup.resolve(project({ suckerGroupId: 'verified-linked-projects' })))
    await settle()
    await settle()
    expect(mocks.group).toHaveBeenCalledWith('verified-linked-projects', 20, 1, 0)
    expect(eventIds()).toEqual(['event-3', 'event-2', 'event-1', 'event-0'])
    expect(host.textContent).toContain('Showing the last indexed events')
    expect(host.textContent).not.toContain('No activity indexed yet')
    const loadMore = [...host.querySelectorAll('button')].find(node => node.textContent === 'Load more activity')!
    expect(loadMore.disabled).toBe(true)
  })

  it('resets the offset to the successful group first page and ignores in-flight exact-project pagination', async () => {
    const lookup = deferred<BsProject>()
    const lateExactPage = deferred<Page>()
    mocks.project.mockReturnValue(lookup.promise)
    mocks.exact.mockImplementation((_chain: number, _project: number, _limit: number, offset: number) => offset > 0
      ? lateExactPage.promise
      : Promise.resolve({ items: [event(4), event(3), event(2), event(1)], totalCount: 6 }))
    mocks.group.mockImplementation((_group: string, _limit: number, _chain: number, offset: number) => Promise.resolve(offset === 0
      ? { items: [event(10), event(9)], totalCount: 4 }
      : { items: [event(8), event(7)], totalCount: 4 }))
    await render()
    await click('Load more activity')
    expect(mocks.exact).toHaveBeenLastCalledWith(1, 7, 20, 4)
    await act(async () => lookup.resolve(project({ suckerGroupId: 'verified-linked-projects' })))
    await settle()
    await settle()
    expect(eventIds()).toEqual(['event-10', 'event-9'])
    await act(async () => lateExactPage.resolve({ items: [event(0)], totalCount: 6 }))
    await settle()
    expect(eventIds()).toEqual(['event-10', 'event-9'])
    await click('Load more activity')
    expect(mocks.group).toHaveBeenLastCalledWith('verified-linked-projects', 20, 1, 2)
    expect(eventIds()).toEqual(['event-10', 'event-9', 'event-8', 'event-7'])
  })

  it('ignores wrong-chain, wrong-project, wrong-version, and malformed indexed identities', async () => {
    const mismatches = [
      { chainId: 8453, projectId: 20, version: 6 },
      { chainId: 1, projectId: 99, version: 6 },
      { chainId: 1, projectId: 22, version: 5 },
      { suckerGroupId: 'unverified' },
    ]
    for (let index = 0; index < mismatches.length; index += 1) {
      const id = 20 + index
      mocks.project.mockResolvedValue({ suckerGroupId: 'unverified', ...mismatches[index] })
      mocks.exact.mockResolvedValue({ items: [event(id, { projectId: id })], totalCount: 1 })
      await render(id)
      expect(mocks.exact).toHaveBeenCalledWith(1, id, 20, 0)
      expect(eventIds()).toEqual([`event-${id}`])
    }
    expect(mocks.group).not.toHaveBeenCalled()
  })

  it('paginates from the loaded count and merges refreshed newest events without losing older pages', async () => {
    mocks.exact.mockImplementation((_chain: number, _project: number, _limit: number, offset: number) => Promise.resolve(offset === 0
      ? { items: [event(3), event(2)], totalCount: 4 }
      : { items: [event(1), event(0)], totalCount: 4 }))
    await render()
    await click('Load more activity')
    expect(mocks.exact).toHaveBeenLastCalledWith(1, 7, 20, 2)
    expect(eventIds()).toEqual(['event-3', 'event-2', 'event-1', 'event-0'])
    mocks.exact.mockResolvedValue({ items: [event(4), event(3)], totalCount: 5 })
    await click('Refresh activity')
    expect(mocks.exact).toHaveBeenLastCalledWith(1, 7, 20, 0)
    expect(eventIds()).toEqual(['event-4', 'event-3', 'event-2', 'event-1', 'event-0'])
    expect([...host.querySelectorAll('button')].some(node => node.textContent === 'Load more activity')).toBe(false)
  })

  it('retains loaded history after background and older-page failures without showing a false empty state', async () => {
    mocks.exact.mockResolvedValue({ items: [event(2), event(1)], totalCount: 4 })
    await render()
    mocks.exact.mockRejectedValue(new Error('Activity index offline'))
    await click('Load more activity')
    expect(host.textContent).toContain('Could not load more activity')
    expect(eventIds()).toEqual(['event-2', 'event-1'])
    await act(async () => { await client.invalidateQueries({ queryKey: ['project-activity'] }) })
    await settle()
    expect(host.textContent).toContain('Showing the last indexed events')
    expect(eventIds()).toEqual(['event-2', 'event-1'])
    expect(host.textContent).not.toContain('No activity indexed yet')
  })

  it('discards an older-page response after the project identity changes', async () => {
    const late = deferred<Page>()
    mocks.exact.mockImplementation((_chain: number, projectId: number, _limit: number, offset: number) => {
      if (projectId === 7 && offset > 0) return late.promise
      return Promise.resolve({ items: [event(projectId, { projectId })], totalCount: projectId === 7 ? 2 : 1 })
    })
    await render()
    await click('Load more activity')
    expect(host.textContent).toContain('Loading…')
    await render(8)
    expect(eventIds()).toEqual(['event-8'])
    await act(async () => late.resolve({ items: [event(6)], totalCount: 2 }))
    await settle()
    expect(eventIds()).toEqual(['event-8'])
    expect(host.textContent).not.toContain('Project 7')
  })

  it('does not query unsupported chains or project IDs that cannot be represented exactly', async () => {
    for (const id of [9_007_199_254_740_993n, '1e3', '-1', '0']) {
      await render(id)
      expect(host.textContent).toContain('This project identity is not supported by the index')
    }
    await render('7', 999999)
    expect(host.textContent).toContain('This project identity is not supported by the index')
    expect(mocks.project).not.toHaveBeenCalled()
    expect(mocks.exact).not.toHaveBeenCalled()
    expect(mocks.group).not.toHaveBeenCalled()
  })

  it('links valid hashes to the event’s chain explorer and omits malformed transaction URLs', async () => {
    mocks.exact.mockResolvedValue({ items: [
      event(3, { txHash: 'javascript:alert(1)' }),
      event(2, { txHash: '0x123' }),
      event(1, { chainId: 8453 }),
    ], totalCount: 3 })
    await render()
    const links = [...host.querySelectorAll<HTMLAnchorElement>('li a')]
    expect(links).toHaveLength(1)
    expect(links[0].href).toBe(`https://basescan.org/tx/${event(1).txHash}`)
    expect(links[0].rel).toBe('noopener noreferrer')
    expect([...host.querySelectorAll('li')].filter(row => row.textContent?.includes('Transaction link unavailable'))).toHaveLength(2)
  })
})
