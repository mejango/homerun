// @vitest-environment node

import { PHASE_PRODUCTION_BUILD } from 'next/constants'
import { unstable_getResponseFromNextConfig } from 'next/experimental/testing/server'
import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

describe('framing policy', () => {
  const safePolicy = 'frame-ancestors https://app.safe.global https://app.5afe.dev'

  async function responseFor(path: string) {
    const { default: nextConfig } = await import('../next.config')
    return unstable_getResponseFromNextConfig({
      url: `https://homerun.money${path}`,
      nextConfig: nextConfig(PHASE_PRODUCTION_BUILD),
    })
  }

  async function matchingPolicies(path: string) {
    const { default: nextConfig } = await import('../next.config')
    const policies: string[] = []
    for (const route of await nextConfig(PHASE_PRODUCTION_BUILD).headers?.() ?? []) {
      const response = await unstable_getResponseFromNextConfig({
        url: `https://homerun.money${path}`,
        nextConfig: { headers: async () => [route] },
      })
      const policy = response.headers.get('content-security-policy')
      if (policy) policies.push(policy)
    }
    return policies
  }

  it.each(['/', '/founderhaus', '/create', '/op:11', '/account/0x1111111111111111111111111111111111111111', '/api/healthz'])(
    'allows only the supported Safe origins to frame %s', async path => {
      expect(await matchingPolicies(path)).toEqual([safePolicy])
    },
  )

  it.each(['/center/callback', '/center/callback/', '/center/callback?code=secret&state=state'])(
    'gives %s only its same-origin framing policy', async path => {
      expect(await matchingPolicies(path)).toEqual(["frame-ancestors 'self'"])
      const response = await responseFor(path)
      expect(response.headers.get('cache-control')).toBe('no-store')
      expect(response.headers.get('referrer-policy')).toBe('strict-origin')
    },
  )

  it.each(['/center/callback/x', '/center/callbackfoo', '/center/callback-x', '/center/', '/center'])(
    'keeps near-match %s under the normal policy', async path => {
      expect(await matchingPolicies(path)).toEqual([safePolicy])
    },
  )

  it.each(['/', '/center/callback', '/center/callback/', '/center/callbackfoo'])(
    'retains common security headers on %s', async path => {
      const response = await responseFor(path)
      expect(response.headers.get('x-content-type-options')).toBe('nosniff')
      expect(response.headers.get('permissions-policy')).toBe('camera=(), microphone=(), geolocation=()')
      if (!path.startsWith('/center/callback') || path === '/center/callbackfoo') {
        expect(response.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin')
      }
    },
  )

  it('keeps the Safe manifest readable cross-origin', async () => {
    expect((await responseFor('/manifest.json')).headers.get('access-control-allow-origin')).toBe('*')
  })
})

describe('deployment version', () => {
  it('uses the build revision for Next version-skew protection', async () => {
    vi.stubEnv('NEXT_PUBLIC_VERSION', '0123456789abcdef0123456789abcdef01234567')
    const { default: nextConfig } = await import('../next.config')
    expect(nextConfig(PHASE_PRODUCTION_BUILD).deploymentId).toBe(
      '0123456789abcdef0123456789abcdef01234567',
    )
  })

  it('leaves an unversioned local build without a deployment ID', async () => {
    vi.stubEnv('NEXT_PUBLIC_VERSION', undefined)
    const { default: nextConfig } = await import('../next.config')
    expect(nextConfig(PHASE_PRODUCTION_BUILD).deploymentId).toBeUndefined()
  })
})
