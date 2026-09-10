import { describe, expect, it, vi } from 'vitest'
import { JBCENTER_DEFAULT_URL } from '@bananapus/nana-sdk-core/jbcenter'
import { jbCenterAppOrigin, jbCenterBaseUrl } from '@/lib/jbcenter-config'

describe('Homerun JB Center deployment origins', () => {
  it('uses Homerun production origin for production without borrowing another application identity', () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', '')
    vi.stubEnv('NEXT_PUBLIC_JBCENTER_URL', '')
    expect(jbCenterAppOrigin()).toBe('https://homerun.money')
    expect(jbCenterBaseUrl()).toBe(JBCENTER_DEFAULT_URL)
  })

  it('maps supported local origins to development Center', () => {
    vi.stubEnv('NEXT_PUBLIC_JBCENTER_URL', '')
    for (const origin of ['http://localhost:3010', 'http://localhost:3014']) {
      expect(jbCenterAppOrigin(origin)).toBe(origin)
      expect(jbCenterBaseUrl(origin)).toBe('https://dev.juicebox.center')
    }
  })

  it('uses the default npm development port when no explicit site URL is set', () => {
    vi.stubEnv('NODE_ENV', 'development')
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', '')
    vi.stubEnv('NEXT_PUBLIC_JBCENTER_URL', '')
    expect(jbCenterAppOrigin()).toBe('http://localhost:3010')
    expect(jbCenterBaseUrl()).toBe('https://dev.juicebox.center')
  })

  it('respects an explicitly configured endpoint without altering the real app origin', () => {
    vi.stubEnv('NEXT_PUBLIC_JBCENTER_URL', 'https://center.example')
    expect(jbCenterBaseUrl('https://homerun.money/path')).toBe('https://center.example')
    expect(jbCenterAppOrigin('https://homerun.money/path')).toBe('https://homerun.money')
  })
})
