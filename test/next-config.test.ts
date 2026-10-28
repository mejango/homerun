// @vitest-environment node

import { PHASE_PRODUCTION_BUILD } from 'next/constants'
import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
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
