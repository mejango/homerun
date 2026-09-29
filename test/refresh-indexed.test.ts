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
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['project-activity', 10, 11] })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['project-participants', 10, 11] })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['indexed-project', 10, 11] })
    expect(invalidate).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(12_000)
    expect(invalidate).toHaveBeenCalledTimes(9)
  })
})
