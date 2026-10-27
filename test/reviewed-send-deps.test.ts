/** The shared wallet adapter refuses a view-as session or the Center wallet that appeared while the wallet was fetched. */
import { afterEach, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ connector: { id: 'injected', uid: 'a' } as { id: string; uid: string }, onFetch: () => {}, fetched: [] as string[] }))
vi.mock('@wagmi/core', () => ({
  getAccount: () => ({ address: '0x1111111111111111111111111111111111111111', chainId: 1, connector: state.connector }),
  getWalletClient: async (_config: unknown, { connector }: { connector: { uid: string } }) => {
    state.fetched.push(connector.uid); state.onFetch()
    return { signMessage: vi.fn(async () => connector.uid) }
  },
  switchChain: vi.fn(),
  getPublicClient: vi.fn(),
}))
vi.mock('@/providers/Providers', () => ({ wagmiConfig: {} }))
vi.mock('@/lib/safe-connector', () => ({ isSafeConnection: () => false }))

import { walletAdapter } from '@/lib/reviewed-send-deps'
import { clearViewAs, setViewAs, VIEW_AS_WRITE_BLOCKED } from '@/lib/viewAs'

afterEach(() => { clearViewAs(); state.connector = { id: 'injected', uid: 'a' }; state.onFetch = () => {}; state.fetched = [] })

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
