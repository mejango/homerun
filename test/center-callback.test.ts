import { describe, expect, it, vi } from 'vitest'
import { captureCenterCallback, centerReturnPath } from '@/providers/center-callback'
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
