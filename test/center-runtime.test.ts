import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const runtime = vi.hoisted(() => ({ create: vi.fn() }))
vi.mock('@bananapus/nana-sdk-connect/core', () => ({ createCenterWalletClient: runtime.create }))
vi.mock('@/providers/wallet-config', () => ({ CENTER_WALLET_CONFIG: { issuer: 'https://my.juicebox.center', audience: 'https://juicebox.center' } }))
beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks(); runtime.create.mockReturnValue({ client: true })
  const values = new Map<string, string>()
  vi.stubGlobal('window', { location: { origin: 'https://homerun.money', pathname: '/project/8453/7' },
    sessionStorage: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) } })
})
afterEach(() => vi.unstubAllGlobals())
describe('Center runtime', () => {
  it('builds one wallet client for this origin with the exact callback', async () => {
    const { centerWalletClient } = await import('@/providers/center-runtime')
    expect(centerWalletClient()).toBe(centerWalletClient())
    expect(runtime.create).toHaveBeenCalledExactlyOnceWith({ issuer: 'https://my.juicebox.center', audience: 'https://juicebox.center', callbackUri: 'https://homerun.money/center/callback' })
  })
  it('preserves the original page before a passkey launch and refuses when it cannot', async () => {
    const { saveCenterReturnPath, originalCenterPage } = await import('@/providers/center-runtime')
    expect(originalCenterPage()).toBe('/')
    saveCenterReturnPath()
    expect(originalCenterPage()).toBe('/project/8453/7')
    window.sessionStorage.setItem = () => { throw Error('full') }
    expect(() => saveCenterReturnPath()).toThrow('full')
    window.location.pathname = '/center/callback'
    window.sessionStorage.setItem = () => {}
    expect(() => saveCenterReturnPath()).toThrow()
  })
})
