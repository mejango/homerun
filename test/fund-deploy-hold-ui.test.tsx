/**
 * A direct FUND launch is held by the SDK's write hold under its intent (the launch), like every other
 * write: a lost wallet reply refuses another deployment until the user's exit, and an attempt the launch
 * record saved before SDK holds is adopted into that hold, with its saved nonce evidence.
 */
import './dialog-shim'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Address, Hex } from 'viem'
import { installRecoveryLocks } from './runtime/write-recovery-fixture'

vi.mock('@bananapus/nana-sdk-core', async importOriginal => (await import('./fixtures/homerun-deployer')).withHomerunDeployer(await importOriginal()))
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: vi.fn(), push: vi.fn() }) }))
vi.mock('@/providers/Providers', () => ({ wagmiConfig: {} }))
vi.mock('@wagmi/core', async importOriginal => {
  const { wallet } = await import('./support/fake-wallet')
  return { ...(await importOriginal<typeof import('@wagmi/core')>()), getAccount: () => ({ address: wallet.account, chainId: 8453 }), getPublicClient: () => wallet.client }
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
vi.mock('@/components/WalletButton', () => ({ WalletButton: () => null }))
vi.mock('@/components/CreateFlow', () => ({ default: () => null }))
const verification = vi.hoisted(() => ({ launch: null as null | (() => Promise<bigint>) }))
vi.mock('@/lib/fund-launch-verification', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/lib/fund-launch-verification')>()
  return { ...actual, checkLaunchDeployment: async () => undefined, verifyFundLaunch: (...args: Parameters<typeof actual.verifyFundLaunch>) => verification.launch ? verification.launch() : actual.verifyFundLaunch(...args) }
})
vi.mock('@/lib/fund-launch-relayr', () => ({ runRelayrLaunch: vi.fn(), launchRequestsDead: vi.fn() }))

import { wallet } from './support/fake-wallet'
import { FundDeploy } from '../src/components/LiveCreate'
import type { CreateValues } from '../src/components/CreateFlow'
import { FUND_LAUNCH_KEY, decodeLaunchSession, saveLaunch, type LaunchStatus } from '../src/lib/fund-launch-session'

const OWNER = '0x1111111111111111111111111111111111111111' as Address
const SALT = `0x${'12'.repeat(32)}` as Hex
const EXIT = 'I checked my wallet. Send again'

let host: HTMLDivElement
let root: Root
const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 30)) })
const button = (text: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === text)
async function click(text: string) { expect(button(text), `${text}: ${host.textContent}`).toBeDefined(); await act(async () => button(text)!.click()); await settle(); await settle() }
async function render() {
  await act(async () => root.render(<FundDeploy values={{} as CreateValues} />))
  await settle(); await settle()
}
function save(status: LaunchStatus) {
  saveLaunch({ version: 1, name: 'Test asset', input: { owner: OWNER, sender: OWNER, chainIds: [8453], projectUri: 'ipfs://bafkreimetadata', tokenName: 'House FUND', ticker: 'HOUSE', salt: SALT, mustStartAtOrAfter: 0, creationFees: { 8453: 0n } }, statuses: { 8453: status } })
}
const saved = () => decodeLaunchSession(localStorage.getItem(FUND_LAUNCH_KEY)!).statuses[8453]

beforeEach(() => {
  localStorage.clear(); installRecoveryLocks()
  wallet.reset(); wallet.connect(OWNER)
  wallet.client.getChainId.mockImplementation(async () => 8453)
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => { verification.launch = null; await act(async () => root.unmount()); host.remove(); localStorage.clear() })

it('refuses another deployment after a lost wallet reply until the user takes the exit', async () => {
  save({ phase: 'ready' })
  wallet.writeContract.mockRejectedValueOnce(new Error('Wallet reply was lost after broadcast'))
  await render()
  await click('Review and deploy FUND')
  expect(button(EXIT)).toBeDefined()
  await act(async () => root.unmount()); root = createRoot(host)
  await render()
  await click('Review and deploy FUND')
  expect(wallet.writeContract).toHaveBeenCalledOnce()
  await click(EXIT)
  await click('Review and deploy FUND')
  expect(wallet.writeContract).toHaveBeenCalledTimes(2)
})

it('adopts a hashless attempt the launch record saved before SDK holds: the record reopens, and only the exit deploys again', async () => {
  save({ phase: 'signing', safe: false, attemptId: '11111111-1111-4111-8111-111111111111', nonce: '0', fromBlock: '900' })
  await render()
  expect(saved().phase).toBe('ready')
  expect(saved().attemptId).toBeUndefined()
  expect(button(EXIT), host.textContent ?? '').toBeDefined()
  expect(wallet.writeContract).not.toHaveBeenCalled()
  await click(EXIT)
  await click('Review and deploy FUND')
  expect(wallet.writeContract).toHaveBeenCalledOnce()
})

it('refuses to discard a launch whose deployment is held, and keeps its exit', async () => {
  save({ phase: 'ready' })
  wallet.writeContract.mockRejectedValueOnce(new Error('Wallet reply was lost after broadcast'))
  await render()
  await click('Review and deploy FUND')
  expect(button(EXIT)).toBeDefined()
  await click('Discard and edit details')
  expect(localStorage.getItem(FUND_LAUNCH_KEY)).not.toBeNull()
  expect(host.textContent).toContain('Finish or exit the pending launch first.')
  expect(button(EXIT)).toBeDefined()
  // A network change does not discard it either.
  await act(async () => root.render(<FundDeploy values={{ networkEnvironment: 'production', networks: ['optimism'] } as unknown as CreateValues} />))
  await settle(); await settle()
  expect(localStorage.getItem(FUND_LAUNCH_KEY)).not.toBeNull()
  expect(button(EXIT)).toBeDefined()
})

it('does not confirm a launch from a mined receipt until its hold settles', async () => {
  save({ phase: 'ready' })
  // The node has a receipt, and the domain checks would pass, but the transaction still reads as pending.
  verification.launch = async () => 42n
  const chainReceipt = wallet.client.getTransactionReceipt.getMockImplementation()!
  wallet.client.getTransactionReceipt.mockImplementation(async ({ hash }: { hash: Hex }) => ({ status: 'success', transactionHash: hash, blockNumber: 10n, blockHash: `0x${'0a'.repeat(32)}`, transactionIndex: 0, from: OWNER, to: OWNER, logs: [] }) as never)
  await render()
  await click('Review and deploy FUND')
  expect(wallet.writeContract).toHaveBeenCalledOnce()
  if (button('Check confirmation')) await click('Check confirmation')
  expect(saved().phase).not.toBe('confirmed')
  // The chain places it: the hold settles, and only then is the launch confirmed.
  wallet.client.getTransactionReceipt.mockImplementation(chainReceipt)
  await act(async () => { wallet.confirm(`0x${'1'.padStart(64, '0')}` as Hex) })
  await settle(); await settle(); await settle()
  expect(saved()).toMatchObject({ phase: 'confirmed', projectId: '42' })
})

