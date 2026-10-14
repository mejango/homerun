/**
 * A Sticky creation is held by the SDK's write hold under its intent (the FUND project), like every
 * other write: a lost wallet reply refuses another creation until the user's exit, and a creation
 * the journal saved as pending before SDK holds is adopted into that hold on load.
 */
import './dialog-shim'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { encodeFunctionData, type Address, type PublicClient } from 'viem'
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
vi.mock('@/lib/fund-global-manifest', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/fund-global-manifest')>()),
  parseFundGlobalManifest: () => ({ allocations: [{ chainId: 1, fundProjectId: '7', snapshotBlockNumber: '100', snapshotBlockHash: `0x${'11'.repeat(32)}` }] }),
  fundGlobalManifestHash: () => `0x${'22'.repeat(32)}`,
}))
vi.mock('@/lib/jbcenter-ipfs', () => ({ jbCenterIpfs: { pinJson: async () => ({ cid: 'bafkreisticky' }) } }))
const m = vi.hoisted(() => ({ prepared: null as unknown }))
vi.mock('@/lib/sticky-create', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/sticky-create')>()),
  stickyCreateBlockers: () => [],
  prepareStickyCreate: async () => m.prepared,
}))

import { wallet } from './support/fake-wallet'
import { StickyCreate } from '@/components/StickyCreate'
import { stickyCreateAbi } from '@/lib/sticky-create'
import { stickySessionKey } from '@/lib/sticky-session'
import type { FundProjectState } from '@/lib/fund-state'

const OWNER = '0x4444444444444444444444444444444444444444' as Address
const DEPLOYER = '0x1111111111111111111111111111111111111111' as Address
const FUND = '0x2222222222222222222222222222222222222222' as Address
const EXIT = 'I checked my wallet. Send again'
const state = { chainId: 1, projectId: 7n, blockNumber: 120n, owner: OWNER, tokenAddress: FUND } as unknown as FundProjectState
const request = {
  chainId: 1, address: DEPLOYER, abi: stickyCreateAbi, functionName: 'deployStickyFor' as const,
  args: [FUND, 'Homerun SHARE', 'SHARE', 'ipfs://bafkreisticky', 0n, [], true] as const, value: 1n,
}

let host: HTMLDivElement
let root: Root
const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 30)) })
const button = (text: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === text)
async function click(text: string) { expect(button(text), text).toBeDefined(); await act(async () => button(text)!.click()); await settle(); await settle() }
async function render() {
  await act(async () => root.render(createElement(StickyCreate, { state, client: wallet.client as unknown as PublicClient, manifest: {}, onCreated: vi.fn() })))
  await settle(); await settle()
}
async function review() { if (button('Prepare Sticky creation')) await click('Prepare Sticky creation'); await click('Review Sticky creation') }

beforeEach(() => {
  localStorage.clear(); installRecoveryLocks()
  wallet.reset(); wallet.connect(OWNER)
  m.prepared = { request, fund: state, manifest: {}, localAllocation: { snapshotBlockNumber: '100' }, manifestHash: `0x${'22'.repeat(32)}`, deployer: DEPLOYER, distributor: DEPLOYER, hook: DEPLOYER, creationFee: 1n }
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); localStorage.clear() })

it('refuses another creation after a lost wallet reply until the user takes the exit', async () => {
  wallet.writeContract.mockRejectedValueOnce(new Error('Wallet reply was lost after broadcast'))
  await render()
  await review()
  expect(button(EXIT)).toBeDefined()
  await click(EXIT)
  expect(wallet.writeContract).toHaveBeenCalledOnce()
  await review()
  expect(wallet.writeContract).toHaveBeenCalledTimes(2)
})

it('refuses a resend while the lost reply is held', async () => {
  wallet.writeContract.mockRejectedValueOnce(new Error('Wallet reply was lost after broadcast'))
  await render()
  await review()
  await act(async () => root.unmount()); root = createRoot(host)
  await render()
  await review()
  expect(wallet.writeContract).toHaveBeenCalledOnce()
  expect(button(EXIT)).toBeDefined()
})

it('adopts a creation the journal saved before SDK holds: its records go, and only the exit creates again', async () => {
  const key = stickySessionKey(1, 7n, OWNER)
  localStorage.setItem('homerun:sticky:create-pending:v1:1:7', key)
  localStorage.setItem(key, JSON.stringify({
    version: 1, id: '11111111-1111-4111-8111-111111111111', chainId: 1, projectId: '7', holder: OWNER, target: DEPLOYER,
    data: encodeFunctionData(request), value: '1', label: 'Create the FUND Sticky project and SHARE token', safe: false,
    submittedAt: Date.now() - 31 * 60_000, afterBlock: '120',
  }))
  await render()
  expect(localStorage.getItem(key)).toBeNull()
  expect(localStorage.getItem('homerun:sticky:create-pending:v1:1:7')).toBeNull()
  expect(button(EXIT)).toBeDefined()
  await click(EXIT)
  expect(wallet.writeContract).not.toHaveBeenCalled()
  await review()
  expect(wallet.writeContract).toHaveBeenCalledOnce()
})
