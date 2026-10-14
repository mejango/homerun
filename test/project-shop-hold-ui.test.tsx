/**
 * A shop update's steps are held by the SDK's write hold under each step's intent, like every other
 * write: a lost wallet reply refuses the same step until the user's exit, and a step the shop
 * journal saved as pending before SDK holds is adopted into that hold on load.
 */
import './dialog-shim'
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { v6Address } from '@bananapus/nana-sdk-core/v6'
import type { Address } from 'viem'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { installRecoveryLocks } from './runtime/write-recovery-fixture'
import { checkedItLabel, HELD_SUCCESS_LINE, SAVED_ATTEMPT_CHECK_LINE } from '@bananapus/nana-sdk-core/review'

const m = vi.hoisted(() => ({ read: vi.fn() }))
vi.mock('@/providers/Providers', () => ({ wagmiConfig: {} }))
vi.mock('@wagmi/core', async importOriginal => {
  const { wallet } = await import('./support/fake-wallet')
  return { ...(await importOriginal<typeof import('@wagmi/core')>()), getAccount: () => ({ address: wallet.account, chainId: 8453 }) }
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
vi.mock('@/lib/project-shop-write', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/project-shop-write')>()),
  readProjectShopWriteState: m.read, reverifyProjectShopWrite: async () => undefined,
}))
vi.mock('@/lib/project-shop', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/project-shop')>()),
  readProjectShop: async () => null, readShopCustomers: async () => ({ items: [], totalCount: 0, nextOffset: null, skipped: 0 }),
}))
vi.mock('@/components/ui/ModalShell', () => ({
  ModalShell: ({ title, children, footer }: { title: ReactNode; children: ReactNode; footer: ReactNode }) => <div role="dialog"><h2>{title}</h2>{children}{footer}</div>,
}))

import { wallet } from './support/fake-wallet'
import { ProjectShop } from '@/components/ProjectShop'
import { initialFundRuleset } from '@/lib/fund-contracts'
import { newDemoShopItem } from '@/lib/demo-shop'
import { parseProjectShopWrite, type PreparedProjectShopWrite } from '@/lib/project-shop-write'
import { shopStepIntent, shopWriteSessionKey, startShopWriteSession } from '@/lib/project-shop-session'

const OWNER = '0x1111111111111111111111111111111111111111' as Address
const DIGEST = `0x${'ab'.repeat(32)}` as const
const KEY = shopWriteSessionKey(8453, 7n)
const EXIT = 'I checked my wallet. Send again'
function plan(): PreparedProjectShopWrite {
  const facts = {
    version: 1, snapshot: {
      chainId: 8453, projectId: 7n, account: OWNER, owner: OWNER, controller: v6Address('JBController', 8453),
      hookOwner: null, shop: null, blockNumber: 100n, mode: 'create', pricing: { currency: 2, decimals: 6 },
      currency: 'USD', symbol: 'USD', canAdd: true, canRemove: false, blockedReason: null, flags: null,
      maxTierId: 0n, rulesetId: 1, identity: 'reviewed project configuration',
      create: { configuration: initialFundRuleset(), projectUri: 'ipfs://project', deployerCanQueue: false, deployerPermissions: 1n << 255n, canManagePermissions: true },
    },
    pinned: [{ draft: { ...newDemoShopItem(), name: 'A weekend stay', price: '25', supply: '10' }, encodedIpfsUri: DIGEST }],
    removeTierIds: [], removalIdentity: '[]', salt: DIGEST,
  }
  return parseProjectShopWrite(JSON.stringify(facts, (_key, value) => typeof value === 'bigint' ? { $bigint: value.toString() } : value))!
}

let host: HTMLDivElement
let root: Root
let cache: QueryClient
const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 30)) })
const button = (text: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent?.trim() === text)
async function click(text: string) { expect(button(text), text).toBeDefined(); await act(async () => button(text)!.click()); await settle(); await settle() }
async function render() {
  await act(async () => root.render(<QueryClientProvider client={cache}><ProjectShop chainId={8453} projectId={7n} tokenLabel="FUND" /></QueryClientProvider>))
  await settle(); await settle()
}

beforeEach(() => {
  localStorage.clear(); installRecoveryLocks()
  wallet.reset(); wallet.connect(OWNER)
  m.read.mockResolvedValue({ ...plan().snapshot })
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 1 })
  cache = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); cache.clear(); localStorage.clear(); vi.unstubAllGlobals() })

it('refuses the same step after a lost wallet reply until the user takes the exit', async () => {
  startShopWriteSession(localStorage, KEY, plan())
  wallet.writeContract.mockRejectedValueOnce(new Error('Wallet reply was lost after broadcast'))
  await render()
  await click('Resume shop update')
  await click('Review transaction')
  expect(button(EXIT)).toBeDefined()
  await click('Review transaction')
  expect(wallet.writeContract).toHaveBeenCalledOnce()
  await click(EXIT)
  await click('Review transaction')
  expect(wallet.writeContract).toHaveBeenCalledTimes(2)
})

it('asks for the user’s check on a hashless step the journal saved as pending before SDK holds: that check closes the update without sending', async () => {
  startShopWriteSession(localStorage, KEY, plan())
  const saved = JSON.parse(localStorage.getItem(KEY)!)
  localStorage.setItem(KEY, JSON.stringify({ ...saved, pending: { safe: false, afterBlock: '100', startedAt: Date.now() - 31 * 60_000 } }))
  await render()
  await click('Resume shop update')
  // Nothing proves what it did: the step isn't offered until the user says they checked it.
  expect(host.textContent).toContain(SAVED_ATTEMPT_CHECK_LINE)
  expect(button('Review transaction')).toBeUndefined()
  await click(checkedItLabel('Close this update'))
  expect(localStorage.getItem(KEY)).toBeNull()
  expect(wallet.writeContract).not.toHaveBeenCalled()
})

it('shows a held step and its exit after a reload, even when the shop can no longer be read', async () => {
  startShopWriteSession(localStorage, KEY, plan())
  wallet.writeContract.mockRejectedValueOnce(new Error('Wallet reply was lost after broadcast'))
  await render()
  await click('Resume shop update')
  await click('Review transaction')
  expect(button(EXIT)).toBeDefined()
  // A reload while the shop's state can't be revalidated: the held step is still found, with its exit.
  m.read.mockRejectedValue(new Error('Shop unavailable'))
  await act(async () => root.unmount()); root = createRoot(host)
  cache.clear()
  await render()
  if (button('Resume shop update')) await click('Resume shop update')
  expect(button(EXIT), host.textContent ?? '').toBeDefined()
  await click(EXIT)
  expect(button(EXIT)).toBeUndefined()
})

it('refuses to cancel an update whose step reverted but is not final yet, and keeps it', async () => {
  startShopWriteSession(localStorage, KEY, plan())
  // The chain's finalized block is still behind the revert.
  wallet.client.getBlock.mockImplementation(async ({ blockNumber, blockTag }: { blockNumber?: bigint; blockTag?: string }) => ({ number: blockTag === 'finalized' ? 5n : blockNumber ?? 1_000n, hash: `0x${'0b'.repeat(32)}`, timestamp: 1_000n }) as never)
  await render()
  await click('Resume shop update')
  await click('Review transaction')
  expect(wallet.writeContract).toHaveBeenCalledOnce()
  await act(async () => { wallet.confirm(`0x${'1'.padStart(64, '0')}` as `0x${string}`, 10n, 'reverted') })
  await settle(); await settle(); await settle()
  if (button('Cancel update')) await click('Cancel update')
  expect(localStorage.getItem(KEY)).not.toBeNull()
  if (button('Cancel update') !== undefined) expect(host.textContent).toContain('Finish or exit the pending update first.')
})

async function settleAway(blockNumber: bigint) {
  const session = startShopWriteSession(localStorage, KEY, plan())
  await render()
  await click('Resume shop update')
  await click('Review transaction')
  expect(wallet.writeContract).toHaveBeenCalledOnce()
  await act(async () => root.unmount()); root = createRoot(host); cache.clear()
  // The chain places it and the SDK settles it meanwhile.
  const hash = `0x${'1'.padStart(64, '0')}` as `0x${string}`
  await act(async () => { wallet.confirm(hash, blockNumber) })
  const { holds } = await import('@/lib/write-hold')
  const hold = holds.open({ chainId: 8453, account: session.plan.snapshot.account, safe: false, namespace: shopStepIntent(session, 0), call: { to: session.plan.snapshot.account, data: '0x' } })
  expect(await hold.onReceipt(await wallet.client.getTransactionReceipt({ hash }) as never, wallet.client as never)).toMatchObject({ status: 'clear', settled: { result: 'success' } })
  await render()
  if (button('Resume shop update')) await click('Resume shop update')
}

it('records a step its hold settled while the page was away, and never sends it again', async () => {
  await settleAway(200n)
  expect(JSON.parse(localStorage.getItem(KEY)!).completed, host.textContent ?? '').toHaveLength(1)
  expect(wallet.writeContract).toHaveBeenCalledOnce()
})

it('keeps a step that settled while away as done when it cannot be shown: never a check, never sent again, never closed', async () => {
  // Placed at a block before the plan's snapshot: this screen can't show it as the plan's step.
  await settleAway(10n)
  // A settled success always wins: it went through, and its only action is to check again.
  expect(host.textContent).toContain(HELD_SUCCESS_LINE)
  expect(host.textContent).not.toContain(SAVED_ATTEMPT_CHECK_LINE)
  expect(button('Review transaction')).toBeUndefined()
  await click('Check again')
  expect(button('Review transaction')).toBeUndefined()
  expect(localStorage.getItem(KEY)).not.toBeNull()
  expect(wallet.writeContract).toHaveBeenCalledOnce()
})

it('records a first step once its hold settles, after the plan’s snapshot block', async () => {
  startShopWriteSession(localStorage, KEY, plan())
  await render()
  await click('Resume shop update')
  await click('Review transaction')
  expect(wallet.writeContract).toHaveBeenCalledOnce()
  await act(async () => { wallet.confirm(`0x${'1'.padStart(64, '0')}` as `0x${string}`, 200n) })
  await settle(); await settle(); await settle()
  expect(JSON.parse(localStorage.getItem(KEY)!).completed, host.textContent ?? '').toHaveLength(1)
})

