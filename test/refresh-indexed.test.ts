import { QueryClient } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { refreshIndexedProject } from '../src/lib/refresh-indexed'

describe('refreshIndexedProject', () => {
  afterEach(() => vi.useRealTimers())
  it('refreshes the numeric-keyed indexed reads now and again while the index catches up', async () => {
    vi.useFakeTimers()
    const cache = new QueryClient()
    const invalidate = vi.spyOn(cache, 'invalidateQueries')
    refreshIndexedProject(cache, 10, 11n)
    await vi.advanceTimersByTimeAsync(0)
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['project-activity', 10, 11] })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['project-participants', 10, 11] })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['indexed-project', 10, 11] })
    expect(invalidate).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(12_000)
    expect(invalidate).toHaveBeenCalledTimes(9)
    cache.clear()
  })

  it('discards a pre-confirmation initial read without cancelling unrelated reads', async () => {
    vi.useFakeTimers()
    const cache = new QueryClient({ defaultOptions: { queries: { staleTime: 30_000 } } })
    let finishOld!: (value: string) => void
    let finishOther!: (value: string) => void
    const queryKey = ['project-activity', 10, 11, 'group']
    const options = {
      queryKey,
      queryFn: vi.fn()
        .mockImplementationOnce(() => new Promise<string>(resolve => { finishOld = resolve }))
        .mockResolvedValue('confirmed'),
    }
    const old = cache.fetchQuery(options).catch(() => undefined)
    const otherKey = ['project-activity', 10, 12]
    const other = cache.fetchQuery({
      queryKey: otherKey,
      queryFn: () => new Promise<string>(resolve => { finishOther = resolve }),
    })
    const unrelated = [
      ['project-activity', 1, 11],
      ['project-participants', 10, 12],
      ['indexed-project', 1, 11],
      ['fund-project', 10, 11],
    ]
    for (const key of unrelated) cache.setQueryData(key, 'unchanged')

    refreshIndexedProject(cache, 10, 11n)
    await vi.advanceTimersByTimeAsync(0)
    expect(cache.getQueryState(queryKey)?.fetchStatus).toBe('idle')
    expect(cache.getQueryState(otherKey)?.fetchStatus).toBe('fetching')
    for (const key of unrelated) {
      expect(cache.getQueryState(key)?.isInvalidated).toBe(false)
      expect(cache.getQueryData(key)).toBe('unchanged')
    }

    expect(await cache.fetchQuery(options)).toBe('confirmed')
    finishOld('before confirmation')
    finishOther('other project')
    await old
    expect(await other).toBe('other project')
    expect(cache.getQueryData(queryKey)).toBe('confirmed')
    cache.clear()
  })
})
