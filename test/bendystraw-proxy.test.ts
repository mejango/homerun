// @vitest-environment node
import { webcrypto } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import registry from '@/lib/bendystraw-operation-registry.json'
import { bendystrawOperationId } from '@/lib/bendystraw-operation-id'
import { resolvePersistedBendystrawRequest } from '@/lib/bendystraw-proxy'
import { POST } from '@/app/api/bendystraw/[net]/query/route'

const operation = Object.entries(registry).find(([, query]) => query.includes('project(chainId:'))![0]
const makeRequest = (body: unknown, headers = { 'content-type': 'application/json' }) => new Request('https://homerun.money/api/bendystraw/mainnet/query', { method: 'POST', headers, body: JSON.stringify(body) })
const mainnet = { params: Promise.resolve({ net: 'mainnet' }) }

describe('same-origin persisted query proxy', () => {
  it('registers the exact SHA-256 documents used by the source', async () => {
    vi.stubGlobal('crypto', webcrypto)
    for (const [id, query] of Object.entries(registry)) expect(await bendystrawOperationId(query)).toBe(id)
  })

  it('rejects arbitrary documents, unknown IDs, extra fields, and malformed variables', () => {
    expect(resolvePersistedBendystrawRequest({ operation, variables: {} })?.query).toBe(registry[operation as keyof typeof registry])
    for (const payload of [{ operation, variables: {}, query: 'query Attacker { projects { totalCount } }' }, { operation: '0'.repeat(64), variables: {} }, { operation, variables: [] }]) {
      expect(resolvePersistedBendystrawRequest(payload)).toBeNull()
    }
  })

  it('rejects unsupported networks, non-JSON requests, unknown operations, and oversized streams', async () => {
    expect((await POST(makeRequest({}), { params: Promise.resolve({ net: 'staging' }) })).status).toBe(404)
    expect((await POST(makeRequest({}, { 'content-type': 'text/plain' }), mainnet)).status).toBe(415)
    expect((await POST(makeRequest({ operation: '0'.repeat(64), variables: {} }), mainnet)).status).toBe(400)
    expect((await POST(makeRequest({ operation, variables: { value: 'x'.repeat(33_000) } }), mainnet)).status).toBe(413)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('forwards a valid registered testnet operation with no-store response headers', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ data: { project: null } }), { headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetcher)
    const result = await POST(makeRequest({ operation, variables: { chainId: 84532, projectId: 11 } }), { params: Promise.resolve({ net: 'testnet' }) })
    expect(result.status).toBe(200)
    expect(result.headers.get('cache-control')).toBe('no-store')
    expect(result.headers.get('x-content-type-options')).toBe('nosniff')
    expect(await result.json()).toEqual({ data: { project: null } })
    expect(fetcher.mock.calls[0][0]).toBe('https://testnet.bendystraw.xyz/graphql')
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toMatchObject({ query: registry[operation as keyof typeof registry], variables: { chainId: 84532, projectId: 11 } })
  })

  it('does not translate an indexer failure into a successful empty response', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(new Response('Offline', { status: 503 })))
    const result = await POST(makeRequest({ operation, variables: { chainId: 1, projectId: 11 } }), mainnet)
    expect(result.status).toBe(502)
    expect(await result.json()).toEqual({ error: 'Bendystraw unavailable' })
  })
})
