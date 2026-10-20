import { afterEach, describe, expect, it, vi } from 'vitest'
import { preloadWhenIdle } from '@/lib/idle-preload'

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('preloadWhenIdle', () => {
  it('runs every load once the browser is idle and ignores a failed load', async () => {
    let idle: (() => void) | undefined
    vi.stubGlobal('requestIdleCallback', (callback: () => void) => { idle = callback; return 7 })
    vi.stubGlobal('cancelIdleCallback', vi.fn())
    const loads = [vi.fn(() => Promise.resolve()), vi.fn(() => Promise.reject(new Error('offline')))]
    preloadWhenIdle(loads)
    expect(loads[0]).not.toHaveBeenCalled()
    idle!()
    expect(loads[0]).toHaveBeenCalledTimes(1)
    expect(loads[1]).toHaveBeenCalledTimes(1)
  })

  it('cancels a pending preload, with a timer where idle callbacks are missing', () => {
    vi.useFakeTimers()
    vi.stubGlobal('requestIdleCallback', undefined)
    const load = vi.fn(() => Promise.resolve())
    const cancel = preloadWhenIdle([load])
    cancel()
    vi.runAllTimers()
    expect(load).not.toHaveBeenCalled()
    preloadWhenIdle([load])
    vi.runAllTimers()
    expect(load).toHaveBeenCalledTimes(1)
  })
})
