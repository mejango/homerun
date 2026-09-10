// @vitest-environment node
import { webcrypto } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import {
  bendystraw,
  getAccountTokenHoldings,
  getProject,
  getProjectActivity,
  getProjectActivityByProject,
  getProjectsByRefs,
  getProjectsOwnedBy,
  normalizeBendystrawUrl,
  searchProjects,
  type BsProject,
} from '@/lib/bendystraw'
import registry from '@/lib/bendystraw-operation-registry.json'

function response(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } })
}
function request(init?: RequestInit) {
  return JSON.parse(String(init?.body)) as { query: string; variables: Record<string, unknown>; operation?: string }
}
function project(override: Partial<BsProject> = {}): BsProject {
  return {
    projectId: 11, chainId: 8453, version: 6, name: 'An asset', logoUri: null, projectTagline: null,
    volume: '0', volumeUsd: '0', balance: '0', paymentsCount: 0, contributorsCount: 0, createdAt: 1,
    suckerGroupId: null, token: null, tokenSymbol: null, decimals: null, currency: null,
    isRevnet: false, owner: null, metadataUri: null, ...override,
  }
}

describe('reference Bendystraw transport', () => {
  it('normalizes URLs and routes onchain project identities to the correct indexed environment', async () => {
    expect(normalizeBendystrawUrl('https://index.example/base/graphql/?key=ignored#fragment')).toBe('https://index.example/base/graphql')
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => response({ data: { project: null } }))
    vi.stubGlobal('fetch', fetcher)
    expect(await getProject(84532, 11)).toBeNull()
    expect(fetcher.mock.calls[0][0]).toBe('https://testnet.bendystraw.xyz/graphql')
    expect(request(fetcher.mock.calls[0][1])).toMatchObject({ variables: { chainId: 84532, projectId: 11 } })
    expect(request(fetcher.mock.calls[0][1]).query).toContain('version: 6')
    expect(fetcher.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal)
  })

  it('routes both activity scopes to testnet without narrowing an omnichain group to one chain', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => response({ data: { activityEvents: { items: [], totalCount: 0 } } }))
    vi.stubGlobal('fetch', fetcher)
    await getProjectActivity('linked-group', 20, 84532, 40)
    await getProjectActivityByProject(84532, 11, 20, 40)
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual(['https://testnet.bendystraw.xyz/graphql', 'https://testnet.bendystraw.xyz/graphql'])
    const group = request(fetcher.mock.calls[0][1])
    expect(group.variables).toEqual({ suckerGroupId: 'linked-group', limit: 20, offset: 40 })
    expect(group.query).not.toContain('chainId: $chainId')
    expect(request(fetcher.mock.calls[1][1]).variables).toEqual({ chainId: 84532, projectId: 11, limit: 20, offset: 40 })
  })

  it('rejects HTTP, GraphQL, missing-data, malformed-shape, and variable failures', async () => {
    const fetcher = vi.fn<typeof fetch>()
    vi.stubGlobal('fetch', fetcher)
    fetcher.mockImplementation(async () => response({}, 503))
    await expect(bendystraw('query { x }', {})).rejects.toThrow('503')
    fetcher.mockImplementation(async () => response({ errors: [{ message: 'schema mismatch' }] }))
    await expect(bendystraw('query { x }', {})).rejects.toThrow('schema mismatch')
    fetcher.mockImplementation(async () => response({}))
    await expect(bendystraw('query { x }', {})).rejects.toThrow('missing data')
    fetcher.mockImplementation(async () => response({ data: { project: {} } }))
    await expect(getProject(8453, 11)).rejects.toThrow('invalid data')
    await expect(bendystraw('query Project($projectId: Int!) { project(projectId: $projectId) { projectId } }', { projectId: 'wrong' })).rejects.toThrow('invalid variables')
  })

  it('sends only a registered operation identifier and variables from the browser', async () => {
    vi.stubGlobal('window', {})
    vi.stubGlobal('crypto', webcrypto)
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => response({ data: { project: project() } }))
    vi.stubGlobal('fetch', fetcher)
    await getProject(8453, 11)
    const [url, init] = fetcher.mock.calls[0]
    expect(url).toBe('/api/bendystraw/mainnet/query')
    const payload = request(init)
    expect(payload).not.toHaveProperty('query')
    expect(payload.variables).toEqual({ chainId: 8453, projectId: 11 })
    expect(registry[payload.operation as keyof typeof registry]).toContain('version: 6')
    expect(init?.cache).toBe('no-store')
  })
})

describe('V6 account discovery and pagination', () => {
  it('paginates credits plus ERC-20 holdings with complete pages and the selected network', async () => {
    const rows = Array.from({ length: 205 }, (_, index) => ({ chainId: 84532, projectId: index + 1, balance: '30', creditBalance: '10', erc20Balance: '20' }))
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      const { variables } = request(init)
      const offset = Number(variables.offset)
      return response({ data: { participants: { items: rows.slice(offset, offset + Number(variables.limit)), totalCount: rows.length } } })
    })
    vi.stubGlobal('fetch', fetcher)
    expect(await getAccountTokenHoldings('0xAbC', { network: 'testnet' })).toEqual({ items: rows, totalCount: 205 })
    expect(fetcher.mock.calls.map(([, init]) => request(init).variables)).toEqual([
      { address: '0xabc', offset: 0, limit: 200 }, { address: '0xabc', offset: 200, limit: 200 },
    ])
    expect(fetcher.mock.calls.every(([url]) => url === 'https://testnet.bendystraw.xyz/graphql')).toBe(true)
    expect(request(fetcher.mock.calls[0][1]).query).toContain('version: 6')
  })

  it('keeps standard Juicebox and Revnet projects in owned-project discovery', async () => {
    const rows = [project(), project({ projectId: 12, isRevnet: true })]
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => response({ data: { projects: { items: rows, totalCount: 2 } } }))
    vi.stubGlobal('fetch', fetcher)
    expect(await getProjectsOwnedBy(['0xAbC'])).toEqual(rows)
    const call = request(fetcher.mock.calls[0][1])
    expect(call.variables.owners).toEqual(['0xabc'])
    expect(call.query).toContain('version: 6')
    expect(call.query).not.toContain('isRevnet: true')
    expect(await getProjectsOwnedBy([])).toEqual([])
    expect(fetcher).toHaveBeenCalledOnce()
  })

  it('resolves exact chain/project/version pairs and filters indexer cross-product matches', async () => {
    const refs = [{ chainId: 8453, projectId: 11, version: 6 }, { chainId: 1, projectId: 12, version: 6 }]
    const rows = [project(), project({ chainId: 1, projectId: 12 }), project({ projectId: 12 }), project({ version: 5 })]
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => response({ data: { projects: { items: rows } } }))
    vi.stubGlobal('fetch', fetcher)
    expect(await getProjectsByRefs(refs)).toEqual(rows.slice(0, 2))
    expect(request(fetcher.mock.calls[0][1]).variables.where).toEqual({ OR: [
      { AND: [{ chainId: 8453 }, { projectId: 11 }, { version: 6 }] },
      { AND: [{ chainId: 1 }, { projectId: 12 }, { version: 6 }] },
    ] })
    await expect(getProjectsByRefs([{ chainId: 1, projectId: 0, version: 6 }])).rejects.toThrow('Invalid Bendystraw project reference')
  })

  it('searches name and token ticker, deduplicates exact deployments, and preserves testnet routing', async () => {
    const row = project({ chainId: 84532 })
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response({ data: { projects: { items: [row] } } }))
      .mockResolvedValueOnce(response({ data: { deployErc20Events: { items: [{ chainId: 84532, projectId: 11, symbol: 'FUND' }] } } }))
      .mockResolvedValueOnce(response({ data: { projects: { items: [row] } } }))
    vi.stubGlobal('fetch', fetcher)
    expect(await searchProjects('$FUND', 24, { network: 'testnet' })).toEqual([{ ...row, searchTicker: 'FUND' }])
    expect(fetcher.mock.calls.every(([url]) => url === 'https://testnet.bendystraw.xyz/graphql')).toBe(true)
    expect(request(fetcher.mock.calls[0][1]).variables.where).toEqual({ AND: [{ version: 6 }, { OR: [{ name_contains_nocase: 'FUND' }] }] })
    expect(request(fetcher.mock.calls[1][1]).query).toContain('version: 6')
    expect(request(fetcher.mock.calls[2][1]).variables.where).toEqual({ OR: [{ AND: [{ chainId: 84532 }, { projectId: 11 }, { version: 6 }] }] })
  })

  it('supports numeric IDs without accidentally matching a cross-version token', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response({ data: { projects: { items: [] } } }))
      .mockResolvedValueOnce(response({ data: { deployErc20Events: { items: [] } } }))
    vi.stubGlobal('fetch', fetcher)
    await searchProjects('11', 3)
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(request(fetcher.mock.calls[0][1]).variables).toEqual({ where: { AND: [{ version: 6 }, { OR: [{ name_contains_nocase: '11' }, { projectId: 11 }] }] }, limit: 3 })
  })
})
