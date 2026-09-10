import { describe, expect, it, vi } from 'vitest'
import { verifyMarkedParaSession } from '@/providers/para-session'

describe('verifyMarkedParaSession', () => {
  it('does not load Para without a reconnect marker', async () => {
    const load = vi.fn()
    const markSession = vi.fn()

    await expect(
      verifyMarkedParaSession({
        hasMarker: () => false,
        load: load as never,
        markSession,
      }),
    ).resolves.toBeUndefined()

    expect(load).not.toHaveBeenCalled()
    expect(markSession).not.toHaveBeenCalled()
  })

  it('clears the marker only after Para authoritatively reports logout', async () => {
    const markSession = vi.fn()
    const isFullyLoggedIn = vi.fn(async () => false)

    await expect(
      verifyMarkedParaSession({
        hasMarker: () => true,
        load: async () =>
          ({ getParaClient: () => ({ isFullyLoggedIn }) }) as never,
        markSession,
      }),
    ).resolves.toBe(false)

    expect(markSession).toHaveBeenCalledOnce()
    expect(markSession).toHaveBeenCalledWith(false)
  })

  it('keeps the marker after transient Para failures', async () => {
    const markSession = vi.fn()

    await expect(
      verifyMarkedParaSession({
        hasMarker: () => true,
        load: async () => {
          throw new Error('temporary outage')
        },
        markSession,
      }),
    ).resolves.toBeUndefined()

    expect(markSession).not.toHaveBeenCalled()
  })
})
