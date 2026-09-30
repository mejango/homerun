// @vitest-environment node
import { webcrypto } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import registry from '@/lib/bendystraw-operation-registry.json'
import { bendystrawOperationId } from '@bananapus/nana-sdk-core/bendystraw-operations'
import { resolvePersistedBendystrawRequest } from '@/lib/bendystraw-proxy'
import { POST } from '@/app/api/bendystraw/[net]/query/route'

const operation = Object.entries(registry).find(([, query]) => query.includes('project(chainId:'))![0]
const makeRequest = (body: unknown, headers = { 'content-type': 'application/json' }) => new Request('https://homerun.money/api/bendystraw/mainnet/query', { method: 'POST', headers, body: JSON.stringify(body) })
const mainnet = { params: Promise.resolve({ net: 'mainnet' }) }

describe('same-origin persisted query proxy', () => {
  // The relay logs why it failed. Silencing the log keeps the run's output clean, and the spy lets a test read it.
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

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

  it('answers 502 and only that when the indexer fails, and logs the cause once', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify({ errors: [{ message: 'relation "secret_table" does not exist' }] }), { headers: { 'content-type': 'application/json' } })))
    const result = await POST(makeRequest({ operation, variables: { chainId: 1, projectId: 11 } }), mainnet)
    expect(result.status).toBe(502)
    expect(await result.json()).toEqual({ error: 'Bendystraw unavailable' })
    expect(console.error).toHaveBeenCalledExactlyOnceWith('Bendystraw relay failed:', 'BendystrawRequestError: relation "secret_table" does not exist')
  })

  it('logs a cause on one line, without the control characters a terminal or a log viewer would act on', async () => {
    // A line break could forge a log line, ESC starts a terminal sequence, and NUL cuts a line in some viewers. U+0085 (NEL), U+009B (CSI) and DEL are controls that `\s` does not match.
    const message = 'first line\r\n2026-09-29 ERROR forged line\n\tindented \u001b[31mred\u001b[0m\u0000nul \u0085 nel \u009b csi \u007f del'
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify({ errors: [{ message }] }), { headers: { 'content-type': 'application/json' } })))
    const result = await POST(makeRequest({ operation, variables: { chainId: 1, projectId: 11 } }), mainnet)
    expect(await result.json()).toEqual({ error: 'Bendystraw unavailable' })
    expect(console.error).toHaveBeenCalledExactlyOnceWith('Bendystraw relay failed:', 'BendystrawRequestError: first line 2026-09-29 ERROR forged line indented [31mred [0m nul nel csi del')
  })

  it('logs nothing when the relay answers', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify({ data: { project: null } }), { headers: { 'content-type': 'application/json' } })))
    expect((await POST(makeRequest({ operation, variables: { chainId: 1, projectId: 11 } }), mainnet)).status).toBe(200)
    expect(console.error).not.toHaveBeenCalled()
  })
})
