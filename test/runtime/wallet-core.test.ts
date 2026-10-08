import { beforeEach, expect, it, vi } from 'vitest'
import type { Address } from 'viem'

const state = vi.hoisted(() => ({
  address: '0x1111111111111111111111111111111111111111' as Address,
  chainId: 1, uid: 'reviewed', safe: false, id: 'injected',
  getWalletClient: vi.fn(), switchChain: vi.fn(),
}))
vi.mock('@wagmi/core', () => ({
  getAccount: () => ({ address: state.address, chainId: state.chainId, connector: { uid: state.uid, id: state.id } }),
  getWalletClient: state.getWalletClient, switchChain: state.switchChain, getPublicClient: vi.fn(),
}))
vi.mock('@/providers/Providers', () => ({ wagmiConfig: {} }))
vi.mock('@/lib/safe-connector', () => ({ isSafeConnection: () => state.safe }))
import { connectedWallet } from '@/lib/wallet-core'
import { clearViewAs, setViewAs } from '@/lib/viewAs'

const account = '0x1111111111111111111111111111111111111111' as Address
const other = '0x2222222222222222222222222222222222222222' as Address
beforeEach(() => {
  state.address = account; state.chainId = 1; state.uid = 'reviewed'; state.id = 'injected'; state.safe = false
  state.switchChain.mockReset().mockImplementation(async (_config, { chainId }) => { state.chainId = chainId })
  state.getWalletClient.mockReset().mockResolvedValue({ marker: 'captured wallet' })
})

it.each(['account', 'chain', 'connector', 'safe', 'center', 'view-as'] as const)(
  'rejects a %s change while the wallet client is acquired', async changed => {
    state.getWalletClient.mockImplementationOnce(async () => {
      await Promise.resolve()
      if (changed === 'account') state.address = other
      if (changed === 'chain') state.chainId = 8453
      if (changed === 'connector') state.uid = 'replacement'
      if (changed === 'safe') state.safe = true
      if (changed === 'center') state.id = 'juicebox-center'
      if (changed === 'view-as') setViewAs(other)
      return { marker: 'stale wallet' }
    })
    try {
      await expect(connectedWallet(1, { expected: account, requireUnchanged: true, changedError: 'Review again' })).rejects.toThrow()
    } finally { clearViewAs() }
  },
)

it('returns the reviewed wallet only after its requested chain is current', async () => {
  const result = await connectedWallet(8453, { expected: account, requireUnchanged: true, changedError: 'Review again' })
  expect(state.switchChain).toHaveBeenCalledWith({}, { chainId: 8453 })
  expect(state.getWalletClient).toHaveBeenCalledWith({}, { chainId: 8453 })
  expect(result).toEqual({ wallet: { marker: 'captured wallet' }, account })
})
