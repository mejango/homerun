import { afterEach, describe, expect, it, vi } from 'vitest'
import { captureCenterCallback, centerReturnPath, clearCenterCallbackUrl } from '@/providers/center-callback'
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
    const account = '/account/0x1111111111111111111111111111111111111111'
    for (const path of ['/', '/project/8453/7', '/op:11', '/@jango', '/@sub.jango', account, `${account}/`, '/@jos%C3%A9.eth', '/' + 'a'.repeat(1023)])
      expect(centerReturnPath(path), path).toBe(path)
    for (const path of ['', 'op:11', '//evil.example', '/\\evil.example', 'https://evil.example', 'javascript:alert(1)', '#/x"><script>',
      '/center/callback', '/project/7?code=x', '/op:11?code=x', '/%2f%2fevil', '/%2F', '/a%5Cb', '/%zz', '/a#secret', '/a//b', '/a//', '/' + 'a'.repeat(1024)])
      expect(() => centerReturnPath(path), path).toThrow('The original Homerun page is unavailable.')
    expect(() => centerReturnPath(undefined as unknown as string)).toThrow()
  })
  it('refuses a short adversarial path at once: a backtracking pattern needs seconds for it', () => {
    const started = performance.now()
    expect(() => centerReturnPath('/' + 'a'.repeat(30) + '!')).toThrow()
    expect(performance.now() - started).toBeLessThan(50)
  })
})
describe('the callback address bar', () => {
  afterEach(() => window.history.replaceState(null, '', '/'))
  it('is cleared again once the router has written the callback back, and only on the callback page', () => {
    window.history.replaceState(null, '', '/center/callback?code=secret&state=state#frag')
    clearCenterCallbackUrl()
    expect(window.location.href).toBe(`${window.location.origin}/center/callback`)

    window.history.replaceState(null, '', '/op:11?x=1#tokens')
    const replaceState = vi.spyOn(window.history, 'replaceState')
    clearCenterCallbackUrl()
    expect(replaceState).not.toHaveBeenCalled()
    expect(window.location.pathname + window.location.search + window.location.hash).toBe('/op:11?x=1#tokens')
  })
  it('is left alone when it is already clean', () => {
    window.history.replaceState(null, '', '/center/callback')
    const replaceState = vi.spyOn(window.history, 'replaceState')
    clearCenterCallbackUrl()
    expect(replaceState).not.toHaveBeenCalled()
  })
})
