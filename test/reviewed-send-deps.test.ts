/** The shared wallet adapter refuses a view-as session or the Center wallet that appeared while the wallet was fetched. */
import { afterEach, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ connector: { id: 'injected', uid: 'a' } as { id: string; uid: string }, onFetch: () => {}, onRead: () => {},
  failSend: false, fetched: [] as string[], invoked: [] as { connector: string; live: string }[] }))
vi.mock('@wagmi/core', () => ({
  getAccount: () => { state.onRead(); return { address: '0x1111111111111111111111111111111111111111', chainId: 1, connector: state.connector } },
  getWalletClient: async (_config: unknown, { connector }: { connector: { uid: string } }) => {
    state.fetched.push(connector.uid); state.onFetch()
    // Each call records, as it is made, which connector's client it is and which connector is live.
    const called = <T,>(result: T) => { state.invoked.push({ connector: connector.uid, live: state.connector.uid }); return Promise.resolve(result) }
    return { signMessage: () => called(connector.uid),
      sendTransaction: () => state.failSend ? Promise.reject(new Error('RPC timeout')) : called(`0x${'12'.repeat(32)}`) }
  },
  switchChain: vi.fn(),
  getPublicClient: vi.fn(),
}))
vi.mock('@/providers/Providers', () => ({ wagmiConfig: {} }))
vi.mock('@/lib/safe-connector', () => ({ isSafeConnection: () => false }))

import { isWalletNotInvoked, readableEngine, walletAdapter } from '@/lib/reviewed-send-deps'
import { isDefiniteWalletRejection } from '@bananapus/nana-sdk-core/review'
import { clearViewAs, setViewAs, VIEW_AS_WRITE_BLOCKED } from '@/lib/viewAs'

afterEach(() => { clearViewAs(); state.connector = { id: 'injected', uid: 'a' }; state.onFetch = () => {}; state.onRead = () => {}; state.fetched = []; state.invoked = []; state.failSend = false })

const send = () => walletAdapter.sendTransaction({ chainId: 1, to: '0x1111111111111111111111111111111111111111', data: '0x', value: 0n, gas: 21_000n })

it('never calls a connector that was switched away after the wallet was fetched', async () => {
  // A same-account switch queued at the first connector read after the fetch, landing before any later continuation.
  state.onFetch = () => {
    state.onRead = () => { state.onRead = () => {}; queueMicrotask(() => { state.connector = { id: 'injected', uid: 'b' } }) }
  }
  await send().catch(() => {})
  expect(state.invoked.length).toBeLessThanOrEqual(1)
  expect(state.invoked.filter(call => call.connector !== call.live)).toEqual([])
})

it('calls only the new connector when it is switched in while the wallet is fetched', async () => {
  state.onFetch = () => { state.connector = { id: 'injected', uid: 'b' }; state.onFetch = () => {} }
  await expect(send()).resolves.toBe(`0x${'12'.repeat(32)}`)
  expect(state.invoked).toEqual([{ connector: 'b', live: 'b' }])
})

it('signs for the wallet that stayed as it was', async () => {
  await expect(walletAdapter.signMessage('hi')).resolves.toBe('a')
})

it("signs with the connector swapped in while the wallet was fetched, never the one it replaced", async () => {
  state.onFetch = () => { state.connector = { id: 'injected', uid: 'b' }; state.onFetch = () => {} }
  await expect(walletAdapter.signMessage('hi')).resolves.toBe('b')
  expect(state.fetched).toEqual(['a', 'b'])
})

it('refuses a connector that keeps changing while the wallet is fetched', async () => {
  let next = 0
  state.onFetch = () => { state.connector = { id: 'injected', uid: String(next++) } }
  await expect(walletAdapter.signMessage('hi')).rejects.toThrow('Wallet connection changed')
  expect(state.fetched).toHaveLength(3)
})

it('refuses view-as turned on while the wallet was fetched', async () => {
  state.onFetch = () => setViewAs('0x2222222222222222222222222222222222222222')
  await expect(walletAdapter.signMessage('hi')).rejects.toThrow(VIEW_AS_WRITE_BLOCKED)
})

it('refuses the Center wallet connected while the wallet was fetched', async () => {
  state.onFetch = () => { state.connector = { id: 'juicebox-center', uid: 'c' } }
  await expect(walletAdapter.signMessage('hi')).rejects.toThrow('Wallet connection changed')
})

it("tags a write refused before the wallet as core's release, and shows it as its own line", async () => {
  state.connector = { id: 'juicebox-center', uid: 'c' }
  const refused = await send().catch(error => error)
  expect(isDefiniteWalletRejection(refused)).toBe(true)
  expect(isWalletNotInvoked(refused)).toBe(true)
  const shown = await readableEngine({ sendReviewed: send }).sendReviewed().catch(error => error)
  expect(isDefiniteWalletRejection(shown)).toBe(false)
  expect(shown.message).toContain('Wallet connection changed')
  // A signature refused before the wallet is unsent too, but holds no step to release.
  expect(isDefiniteWalletRejection(await walletAdapter.signMessage('hi').catch(error => error))).toBe(false)
})

it('leaves a failure after the wallet was called as it is', async () => {
  state.failSend = true
  const failed = await send().catch(error => error)
  expect(failed.message).toBe('RPC timeout')
  expect(isDefiniteWalletRejection(failed)).toBe(false)
  expect(isWalletNotInvoked(failed)).toBe(false)
})
