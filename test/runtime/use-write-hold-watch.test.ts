import { createElement } from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import type { WriteHoldHandle, WriteHoldState } from '@bananapus/nana-sdk-core/review'
import { useWriteHoldWatch } from '@/hooks/useWriteHoldWatch'

const record = { version: 1, id: 'held', chainId: 10, account: '0x1111111111111111111111111111111111111111', safe: true,
  call: { to: '0x2222222222222222222222222222222222222222', data: '0x12345678', value: '0' }, hash: `0x${'ab'.repeat(32)}` } as never
const unproven = { status: 'safe-unproven', record, hash: `0x${'ab'.repeat(32)}`, exit: true, line: 'unproven', warning: 'twice' } as WriteHoldState
const pending = { status: 'pending-known-hash', record, hash: `0x${'ab'.repeat(32)}`, exit: false, line: 'pending' } as WriteHoldState

describe('useWriteHoldWatch', () => {
  it('shows an exit only from a chain check, never from a replayed or peeked state', async () => {
    let listener!: (state: WriteHoldState) => void
    let answer!: (state: WriteHoldState) => void
    const hold = {
      subscribe: vi.fn((next: (state: WriteHoldState) => void) => { listener = next; next(unproven); return () => {} }),
      state: vi.fn(() => new Promise<WriteHoldState>(resolve => { answer = resolve })),
    } as unknown as WriteHoldHandle
    const seen: WriteHoldState[] = []
    function Watch() { useWriteHoldWatch(hold, {} as never, state => seen.push(state)); return null }
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => { renderer = TestRenderer.create(createElement(Watch)) })
    // The replay offered an exit: it is asked of the chain instead of shown.
    expect(seen).toEqual([])
    expect(hold.state).toHaveBeenCalledOnce()
    // A storage event while that check runs is not shown either, nor asked twice.
    await act(async () => { listener(unproven) })
    expect(seen).toEqual([])
    expect(hold.state).toHaveBeenCalledOnce()
    // The chain says the hash is still pending: that is what shows.
    await act(async () => { answer(pending) })
    expect(seen).toEqual([pending])
    // An exit the chain check itself returns does show.
    await act(async () => { listener(unproven) })
    await act(async () => { answer(unproven) })
    expect(seen).toEqual([pending, unproven])
    await act(async () => renderer.unmount())
  })
})
