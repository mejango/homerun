import { describe, expect, it, vi } from 'vitest'

describe('optional Para configuration', () => {
  it.each(['', 'placeholder', ' PLACEHOLDER '])('uses external wallets for %j', async key => {
    vi.resetModules()
    vi.stubEnv('NEXT_PUBLIC_PARA_API_KEY', key)
    expect((await import('../src/providers/wallet-config')).PARA_AUTH_ENABLED).toBe(false)
  })
  it('enables Para when a non-placeholder key is configured', async () => {
    vi.resetModules()
    vi.stubEnv('NEXT_PUBLIC_PARA_API_KEY', 'configured-app-key')
    expect((await import('../src/providers/wallet-config')).PARA_AUTH_ENABLED).toBe(true)
  })
})
