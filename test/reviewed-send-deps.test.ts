/** The shared wallet adapter refuses a view-as session or the Center wallet that appeared while the wallet was fetched. */
import { afterEach, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ connector: { id: 'injected' }, onFetch: () => {} }))
vi.mock('@wagmi/core', () => ({
  getAccount: () => ({ address: '0x1111111111111111111111111111111111111111', chainId: 1, connector: state.connector }),
  getWalletClient: async () => { state.onFetch(); return { signMessage: vi.fn() } },
  switchChain: vi.fn(),
  getPublicClient: vi.fn(),
}))
vi.mock('@/providers/Providers', () => ({ wagmiConfig: {} }))
vi.mock('@/lib/safe-connector', () => ({ isSafeConnection: () => false }))

import { walletAdapter } from '@/lib/reviewed-send-deps'
import { clearViewAs, setViewAs, VIEW_AS_WRITE_BLOCKED } from '@/lib/viewAs'

afterEach(() => { clearViewAs(); state.connector = { id: 'injected' }; state.onFetch = () => {} })

it('signs for the wallet that stayed as it was', async () => {
  await expect(walletAdapter.signMessage('hi')).resolves.toBeUndefined()
})

it('refuses view-as turned on while the wallet was fetched', async () => {
  state.onFetch = () => setViewAs('0x2222222222222222222222222222222222222222')
  await expect(walletAdapter.signMessage('hi')).rejects.toThrow(VIEW_AS_WRITE_BLOCKED)
})

it('refuses the Center wallet connected while the wallet was fetched', async () => {
  state.onFetch = () => { state.connector = { id: 'juicebox-center' } }
  await expect(walletAdapter.signMessage('hi')).rejects.toThrow('Wallet connection changed')
})
