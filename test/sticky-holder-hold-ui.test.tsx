/**
 * Sticky holder writes are held by the SDK's write hold under each action's intent, like every
 * other write: a lost wallet reply refuses the same action until the user's exit, and an action the
 * Sticky journal saved as pending before SDK holds is adopted into that hold on load.
 */
import './dialog-shim'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { encodeFunctionData, erc20Abi, type Address } from 'viem'
import { jbContractAddress, type JBChainId } from '@bananapus/nana-sdk-core'
import { v6Address } from '@bananapus/nana-sdk-core/v6'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { installRecoveryLocks } from './runtime/write-recovery-fixture'

vi.mock('@/providers/Providers', () => ({ wagmiConfig: {} }))
vi.mock('@wagmi/core', async importOriginal => {
  const { wallet } = await import('./support/fake-wallet')
  return { ...(await importOriginal<typeof import('@wagmi/core')>()), getAccount: () => ({ address: wallet.account, chainId: 1 }) }
})
vi.mock('wagmi', async importOriginal => {
  const { walletHooks } = await import('./support/fake-wallet')
  return { ...(await importOriginal<typeof import('wagmi')>()), ...walletHooks }
})
vi.mock('@/hooks/useWallet', async () => {
  const { useFakeWallet } = await import('./support/fake-wallet')
  return { useWallet: useFakeWallet }
})
vi.mock('@/lib/transaction-review', async importOriginal => {
  const { wallet } = await import('./support/fake-wallet')
  return { ...(await importOriginal<typeof import('@/lib/transaction-review')>()), requestContractTransactionReview: wallet.requestReview }
})
vi.mock('@/lib/safe-connector', async importOriginal => ({ ...(await importOriginal<typeof import('@/lib/safe-connector')>()), isSafeConnection: () => false, useSafeConnection: () => false }))
vi.mock('@/lib/sticky-state', () => ({
  readStickyProjectState: vi.fn(), readStickyRewards: vi.fn(), quoteStickyStake: vi.fn(), quoteStickyUnstake: vi.fn(),
}))

import { wallet } from './support/fake-wallet'
import { StickyHolder } from '@/components/StickyHolder'
import { quoteStickyStake, readStickyProjectState, type StickyProjectState } from '@/lib/sticky-state'
import { stickySessionKey } from '@/lib/sticky-session'

const HOLDER = '0x1111111111111111111111111111111111111111' as Address
const FUND = '0x2222222222222222222222222222222222222222' as Address
const SHARE = '0x3333333333333333333333333333333333333333' as Address
const DEPLOYER = '0x4444444444444444444444444444444444444444' as Address
const TERMINAL = v6Address('JBMultiTerminal', 1)
const EXIT = 'I checked my wallet. Send again'
const registry = jbContractAddress['6'] as Record<string, Partial<Record<JBChainId, Address>>>
const oldFactory = registry.StickyDeployer
const state = {
  chainId: 1, fundProjectId: 7n, stickyProjectId: 9n, blockNumber: 100n, blockTimestamp: 1800000000n, account: HOLDER,
  fundToken: FUND, shareToken: SHARE, deployer: DEPLOYER, terminal: TERMINAL, controller: v6Address('JBController', 1), hook: DEPLOYER, feed: DEPLOYER,
  fundBalance: 2n * 10n ** 18n, fundCreditBalance: 0n, shareBalance: 0n, allowance: 0n, cashOutTaxRate: 0n, soulbound: true,
  streakStart: 0n, longestStreak: 0n, trancheCount: 0n, trancheStart: 0n, tranches: [], rewards: null, rewardIssue: null,
} as StickyProjectState

let host: HTMLDivElement
let root: Root
let cache: QueryClient
const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 30)) })
const button = (text: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === text)
async function click(text: string) { expect(button(text), text).toBeDefined(); await act(async () => button(text)!.click()); await settle(); await settle() }
async function render() {
  await act(async () => root.render(createElement(QueryClientProvider, { client: cache }, createElement(StickyHolder, { chainId: 1, fundProjectId: 7n, stickyProjectId: 9n }))))
  await settle(); await settle()
}

beforeEach(() => {
  localStorage.clear(); installRecoveryLocks()
  wallet.reset(); wallet.connect(HOLDER)
  registry.StickyDeployer = { 1: DEPLOYER }
  vi.mocked(readStickyProjectState).mockResolvedValue(state)
  vi.mocked(quoteStickyStake).mockResolvedValue({ shares: 10n ** 18n, minimumShares: 99n * 10n ** 16n })
  cache = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => {
  if (oldFactory) registry.StickyDeployer = oldFactory
  else delete registry.StickyDeployer
  await act(async () => root.unmount()); host.remove(); cache.clear(); localStorage.clear()
})

it('refuses the same approval after a lost wallet reply until the user takes the exit', async () => {
  wallet.writeContract.mockRejectedValueOnce(new Error('Wallet reply was lost after broadcast'))
  await render()
  await click('Use available FUND')
  await click('Review FUND approval')
  expect(button(EXIT)).toBeDefined()
  await click('Review FUND approval')
  expect(wallet.writeContract).toHaveBeenCalledOnce()
  await click(EXIT)
  await click('Review FUND approval')
  expect(wallet.writeContract).toHaveBeenCalledTimes(2)
})

it('adopts an approval the Sticky journal saved as pending before SDK holds: the journal goes, and only the exit sends it again', async () => {
  const key = stickySessionKey(1, 9n, HOLDER)
  localStorage.setItem(key, JSON.stringify({
    version: 1, id: '11111111-1111-4111-8111-111111111111', chainId: 1, projectId: '9', holder: HOLDER, target: FUND,
    data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [TERMINAL, 2n * 10n ** 18n] }), value: '0',
    label: 'Approve FUND', safe: false, submittedAt: Date.now() - 31 * 60_000, afterBlock: '99',
  }))
  await render()
  expect(localStorage.getItem(key)).toBeNull()
  expect(host.textContent).not.toContain('Saved transaction')
  expect(button(EXIT)).toBeDefined()
  await click('Use available FUND')
  await click('Review FUND approval')
  expect(wallet.writeContract).not.toHaveBeenCalled()
  await click(EXIT)
  await click('Review FUND approval')
  expect(wallet.writeContract).toHaveBeenCalledOnce()
})

it('shows a held holder action and its exit after a reload, even when the Sticky contracts can no longer be verified', async () => {
  wallet.writeContract.mockRejectedValueOnce(new Error('Wallet reply was lost after broadcast'))
  await render()
  await click('Use available FUND')
  await click('Review FUND approval')
  expect(button(EXIT)).toBeDefined()
  vi.mocked(readStickyProjectState).mockRejectedValue(new Error('Sticky unavailable'))
  await act(async () => root.unmount()); root = createRoot(host); cache.clear()
  await render()
  expect(button('Review FUND approval')).toBeUndefined()
  expect(button(EXIT), host.textContent ?? '').toBeDefined()
  await click(EXIT)
  expect(button(EXIT)).toBeUndefined()
})

