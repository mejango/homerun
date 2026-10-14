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

  it("keeps a shown exit through a check that lost the lock, and hides it only on the chain's pending answer", async () => {
    const lost = { status: 'held-no-hash', record, exit: true, line: 'lost reply' } as WriteHoldState
    let answer!: (state: WriteHoldState) => void
    const hold = {
      subscribe: vi.fn(() => () => {}),
      state: vi.fn(() => new Promise<WriteHoldState>(resolve => { answer = resolve })),
    } as unknown as WriteHoldHandle
    const seen: WriteHoldState[] = []
    let recheck!: () => void
    function Watch() { recheck = useWriteHoldWatch(hold, {} as never, state => seen.push(state), { shown: lost }); return null }
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => { renderer = TestRenderer.create(createElement(Watch)) })
    // A check that lost the lock: the saved state, which never carries an exit.
    await act(async () => { recheck() })
    await act(async () => { answer({ ...lost, exit: false } as WriteHoldState) })
    expect(seen).toEqual([])
    // The chain says the hash is pending after all: that hides the exit.
    const now = { status: 'pending-known-hash', record, hash: `0x${'ab'.repeat(32)}`, exit: false, line: 'pending' } as WriteHoldState
    await act(async () => { recheck() })
    await act(async () => { answer(now) })
    expect(seen).toEqual([now])
    await act(async () => renderer.unmount())
  })

  it("shows one flow's chain answer to every flow on the hold without asking the chain again", async () => {
    // As the SDK does, a check's answer also reaches every subscriber, after the check returns.
    const listeners = new Set<(state: WriteHoldState) => void>()
    const hold = {
      subscribe: vi.fn((next: (state: WriteHoldState) => void) => { listeners.add(next); return () => { listeners.delete(next) } }),
      state: vi.fn(async () => { setTimeout(() => { for (const next of [...listeners]) next(unproven) }, 0); return unproven }),
    } as unknown as WriteHoldHandle
    const seen: string[] = []
    function Watch({ name }: { name: string }) { useWriteHoldWatch(hold, {} as never, () => seen.push(name), { checkNow: true }); return null }
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => { renderer = TestRenderer.create(createElement('div', null, createElement(Watch, { name: 'a' }), createElement(Watch, { name: 'b' }))) })
    await act(async () => { for (let tick = 0; tick < 20; tick += 1) await new Promise(resolve => setTimeout(resolve, 0)) })
    expect(seen).toEqual(expect.arrayContaining(['a', 'b']))
    // Each flow asks once; neither answer sends the other back to the chain.
    expect(vi.mocked(hold.state).mock.calls.length).toBe(2)
    await act(async () => renderer.unmount())
  })
})
