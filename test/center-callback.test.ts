import { describe, expect, it, vi } from 'vitest'
import { CENTER_FRAME_CALLBACK, captureCenterCallback, centerReturnPath, deliverCenterCallbackToParent } from '@/providers/center-callback'
describe('Center callback containment', () => {
  it('removes all callback data before the SDK or page controller runs, including malformed callbacks', () => {
    const replace = vi.fn(), url = 'https://homerun.money/center/callback?code=secret&state=state&iss=https%3A%2F%2Fwallet.juicebox.center#bad'
    expect(captureCenterCallback({ href: url, replace })).toEqual({ url })
    expect(replace).toHaveBeenCalledExactlyOnceWith('/center/callback')
  })
  it('leaves ordinary navigation intact and fails closed when history cannot be cleared', () => {
    const replace = vi.fn()
    expect(captureCenterCallback({ href: 'https://homerun.money/projects', replace })).toBeNull()
    expect(replace).not.toHaveBeenCalled()
    expect(() => captureCenterCallback({ href: 'https://homerun.money/center/callback?code=x', replace: () => { throw Error('blocked') } })).toThrow()
  })
  it('restores only a bounded local page path without callback secrets or external redirects', () => {
    expect(centerReturnPath('/project/8453/7')).toBe('/project/8453/7')
    for (const path of ['//evil.example', '/\\evil.example', 'https://evil.example', '/center/callback', '/project/7?code=x', '/%2f%2fevil', '/a#secret'])
      expect(() => centerReturnPath(path)).toThrow()
  })
})

describe('Framed review hand-back', () => {
  const frame = (parent: object, origin = 'https://homerun.money') => {
    const win = { location: { origin }, postMessage: vi.fn() } as unknown as Window & { postMessage: ReturnType<typeof vi.fn> }
    Object.assign(win, { parent: Object.assign(Object.create(parent), { postMessage: vi.fn() }) })
    return win
  }
  it('hands a review callback only to a same-origin page framing it', () => {
    const url = 'https://homerun.money/center/callback?review=r1&code=secret'
    const own = { location: { origin: 'https://homerun.money' }, postMessage: vi.fn() } as unknown as Window
    Object.assign(own, { parent: own })
    expect(deliverCenterCallbackToParent(url, own)).toBe(false)
    const framed = frame({ location: { origin: 'https://homerun.money' } })
    expect(deliverCenterCallbackToParent(url, framed)).toBe(true)
    expect((framed.parent as unknown as { postMessage: ReturnType<typeof vi.fn> }).postMessage).toHaveBeenCalledExactlyOnceWith({ type: CENTER_FRAME_CALLBACK, url }, 'https://homerun.money')
  })
  it('never posts the callback to a foreign or unreadable parent', () => {
    const url = 'https://homerun.money/center/callback?review=r1&code=secret'
    const foreign = frame({ location: { origin: 'https://evil.example' } })
    expect(deliverCenterCallbackToParent(url, foreign)).toBe(false)
    const opaque = frame({ get location(): { origin: string } { throw new DOMException('Blocked', 'SecurityError') } })
    expect(deliverCenterCallbackToParent(url, opaque)).toBe(false)
    for (const win of [foreign, opaque]) expect((win.parent as unknown as { postMessage: ReturnType<typeof vi.fn> }).postMessage).not.toHaveBeenCalled()
  })
})
