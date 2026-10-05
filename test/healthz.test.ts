// @vitest-environment node

import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => vi.unstubAllEnvs())

describe('GET /api/healthz', () => {
  it('reports ok with the build revision', async () => {
    vi.stubEnv('NEXT_PUBLIC_VERSION', 'abc1234')
    const { GET } = await import('@/app/api/healthz/route')
    const response = GET()
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ status: 'ok', revision: 'abc1234' })
  })

  it('is never cached, so a probe reaches the running server', async () => {
    const { GET } = await import('@/app/api/healthz/route')
    expect(GET().headers.get('cache-control')).toBe('no-store')
  })

  it.each([
    ['unset', undefined],
    ['empty', ''],
    ['blank', '  '],
  ])('names the revision unknown when the version is %s', async (_case, version) => {
    vi.stubEnv('NEXT_PUBLIC_VERSION', version)
    const { GET } = await import('@/app/api/healthz/route')
    const response = GET()
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ status: 'ok', revision: 'unknown' })
  })
})
