import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const runtime = vi.hoisted(() => ({ prepare: vi.fn(), pending: vi.fn(), assign: vi.fn() }))
vi.mock('@juicebox/center-client', () => ({ createCenterWalletClient: () => ({
  prepareConnection: runtime.prepare, payments: () => ({ pendingPayment: runtime.pending }),
}) }))
vi.mock('@/providers/wallet-config', () => ({ CENTER_WALLET_CONFIG: { issuer: 'https://wallet.juicebox.center', audience: 'https://juicebox.center' } }))
beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks(); runtime.pending.mockReturnValue(null)
  const values = new Map<string, string>()
  vi.stubGlobal('window', { location: { origin: 'https://homerun.money', pathname: '/project/8453/7', assign: runtime.assign },
    sessionStorage: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) } })
})
afterEach(() => vi.unstubAllGlobals())
describe('Center handoff continuation', () => {
  it('does not redirect after the wallet chooser closes while preparation is pending', async () => {
    let resolve!: (value: unknown) => void
    runtime.prepare.mockReturnValue(new Promise(complete => { resolve = complete }))
    const { beginCenterConnection, originalCenterPage } = await import('@/providers/center-runtime')
    const controller = new AbortController(), attempt = beginCenterConnection(controller.signal)
    controller.abort(); resolve({ authorizationUrl: 'https://wallet.juicebox.center/wallet?intent=original' })
    await expect(attempt).rejects.toThrow()
    expect(runtime.assign).not.toHaveBeenCalled(); expect(originalCenterPage()).toBe('/project/8453/7')
  })
  it('keeps an existing payment and refuses handoff when its original path cannot be preserved', async () => {
    const { beginCenterConnection } = await import('@/providers/center-runtime')
    runtime.pending.mockReturnValue({ status: 'unknown' })
    await expect(beginCenterConnection()).rejects.toThrow('existing Juicebox payment')
    runtime.pending.mockReturnValue(null)
    window.sessionStorage.setItem = () => { throw Error('full') }
    await expect(beginCenterConnection()).rejects.toThrow('full')
    expect(runtime.prepare).not.toHaveBeenCalled(); expect(runtime.assign).not.toHaveBeenCalled()
  })
})
