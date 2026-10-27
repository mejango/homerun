/**
 * A network's INCOME launch is held by the SDK's write hold under its intent (the FUND project), like
 * every other write: a lost wallet reply refuses another launch until the user's exit, and a launch the
 * journal saved before SDK holds (even one without a hash) is adopted into that hold on load.
 */
import './dialog-shim'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { encodeFunctionData, type PublicClient } from 'viem'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { installRecoveryLocks } from './runtime/write-recovery-fixture'
import { checkedItLabel, HELD_SUCCESS_LINE, SAVED_ATTEMPT_CHECK_LINE } from '@bananapus/nana-sdk-core/review'
import { HELPER, OWNER, fundState, globalDraft, globalManifest, launchInput, launchPlan } from './fixtures/income-global-launch'

vi.mock('@/providers/Providers', () => ({ wagmiConfig: {} }))
vi.mock('@wagmi/core', async importOriginal => {
  const { wallet, walletCore } = await import('./support/fake-wallet')
  return { ...(await importOriginal<typeof import('@wagmi/core')>()), ...walletCore, getAccount: () => ({ address: wallet.account, chainId: 8453 }) }
})
vi.mock('wagmi', async importOriginal => {
  const { walletHooks } = await import('./support/fake-wallet')
  return { ...(await importOriginal<typeof import('wagmi')>()), ...walletHooks }
})
vi.mock('@/hooks/useWallet', async () => {
  const { useFakeWallet } = await import('./support/fake-wallet')
  return { useWallet: useFakeWallet }
})
vi.mock('@tanstack/react-query', async importOriginal => ({
  ...(await importOriginal<typeof import('@tanstack/react-query')>()),
  keepPreviousData: (data: unknown) => data,
  useQuery: ({ queryKey }: { queryKey: [string, number] }) => ({ data: queryKey[0] === 'income-launch-fund' ? fundState(queryKey[1]) : null, isError: false, isPending: false }),
  useQueryClient: () => ({ invalidateQueries: async () => undefined }),
}))
vi.mock('@/lib/safe-connector', async importOriginal => ({ ...(await importOriginal<typeof import('@/lib/safe-connector')>()), isSafeConnection: () => false, useSafeConnection: () => false }))
vi.mock('@/lib/income-contracts', async importOriginal => ({ ...(await importOriginal<typeof import('@/lib/income-contracts')>()), registeredHomerunDeployer: () => HELPER }))
vi.mock('@/lib/income-launch', async importOriginal => {
  const { launchPlan } = await import('./fixtures/income-global-launch')
  return { ...(await importOriginal<typeof import('@/lib/income-launch')>()), incomeLaunchBlockers: () => [], prepareIncomeLaunch: async (_client: unknown, input: Parameters<typeof launchPlan>[0]) => launchPlan(input), readIncomeLaunchBinding: async () => null }
})

import { wallet } from './support/fake-wallet'
import { IncomeLaunch } from '@/components/IncomeLaunch'
import { incomeLaunchIntent, incomeLaunchSessionKey } from '@/lib/income-launch-session'
import { saveIncomeGlobalDraft } from '@/lib/income-global-launch-draft'

const EXIT = 'I checked my wallet'
const KEY = incomeLaunchSessionKey(8453, 7n)

let host: HTMLDivElement
let root: Root
const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 30)) })
const base = () => host.querySelector('[aria-label="Base INCOME launch"]')!
const button = (text: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === text)
async function click(text: string) { expect(button(text), text).toBeDefined(); await act(async () => button(text)!.click()); await settle(); await settle() }
async function render() {
  await act(async () => root.render(createElement(IncomeLaunch, { state: fundState(8453), client: wallet.client as unknown as PublicClient, plannedAllocation: { reservedPercent: null } })))
  await settle(); await settle()
}
async function review() {
  await click('Prepare Base INCOME')
  await act(async () => (base().querySelector('input[type="checkbox"]') as HTMLInputElement).click())
  await click('Review Base deployment')
}

beforeEach(() => {
  localStorage.clear(); installRecoveryLocks()
  wallet.reset(); wallet.connect(OWNER)
  wallet.client.getChainId.mockImplementation(async () => 8453)
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => globalManifest() })))
  saveIncomeGlobalDraft(localStorage, globalDraft())
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); localStorage.clear(); vi.unstubAllGlobals() })

it('refuses another launch after a lost wallet reply until the user takes the exit', async () => {
  wallet.writeContract.mockRejectedValueOnce(new Error('Wallet reply was lost after broadcast'))
  await render()
  await review()
  expect(button(EXIT)).toBeDefined()
  await act(async () => root.unmount()); root = createRoot(host)
  await render()
  // Reloaded, the held launch shows at once with its exit.
  expect(button(EXIT)).toBeDefined()
  expect(wallet.writeContract).toHaveBeenCalledOnce()
  await click(EXIT)
  await review()
  expect(wallet.writeContract).toHaveBeenCalledTimes(2)
})

it('asks for the user’s check on a hashless launch the journal saved before SDK holds: only that check launches again', async () => {
  localStorage.setItem(KEY, JSON.stringify({
    version: 1, kind: 'income-launch', sessionId: '11111111-1111-4111-8111-111111111111', phase: 'unknown',
    chainId: 8453, projectId: '7', holder: OWNER, target: HELPER, data: encodeFunctionData(launchPlan(launchInput()).request),
    value: '1', label: 'Deploy INCOME', safe: false, submittedAt: Date.now() - 31 * 60_000, afterBlock: '200',
  }))
  await render()
  // Nothing proves what it did: nothing launches until the user says they checked it.
  expect(host.textContent).toContain(SAVED_ATTEMPT_CHECK_LINE)
  expect(button('Prepare Base INCOME')).toBeUndefined()
  await click(checkedItLabel('Launch again'))
  expect(localStorage.getItem(KEY)).toBeNull()
  expect(wallet.writeContract).not.toHaveBeenCalled()
  await review()
  expect(wallet.writeContract).toHaveBeenCalledOnce()
})

it('shows a held launch and its exit after a reload while the published snapshot cannot load', async () => {
  wallet.writeContract.mockRejectedValueOnce(new Error('Wallet reply was lost after broadcast'))
  await render()
  await review()
  expect(button(EXIT)).toBeDefined()
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('IPFS unavailable') }))
  await act(async () => root.unmount()); root = createRoot(host)
  await render()
  expect(button('Prepare Base INCOME')).toBeUndefined()
  expect(button(EXIT), host.textContent ?? '').toBeDefined()
})

it('keeps a launch that settled while away as done when it can only be shown as a Safe execution: never a check, never launched again', async () => {
  await render()
  await review()
  expect(wallet.writeContract).toHaveBeenCalledOnce()
  await act(async () => root.unmount()); root = createRoot(host)
  const hash = `0x${'1'.padStart(64, '0')}` as `0x${string}`
  await act(async () => { wallet.confirm(hash) })
  const { holds } = await import('@/lib/write-hold')
  const hold = holds.open({ chainId: 8453, account: OWNER, safe: false, namespace: incomeLaunchIntent(7n), call: { to: HELPER, data: '0x' } })
  expect(await hold.onReceipt(await wallet.client.getTransactionReceipt({ hash }) as never, wallet.client as never)).toMatchObject({ status: 'clear' })
  // Read now, the settled transaction is a Safe's execTransaction, not the launcher call itself.
  const sent = await wallet.client.getTransaction({ hash })
  wallet.client.getTransaction.mockImplementation(async () => ({ ...sent!, to: OWNER, input: '0x6a761202' }) as never)
  await render()
  // A settled success always wins: it went through, and its only action is to check again.
  expect(host.textContent).toContain(HELD_SUCCESS_LINE)
  expect(host.textContent).not.toContain(SAVED_ATTEMPT_CHECK_LINE)
  expect(button('Prepare Base INCOME'), host.textContent ?? '').toBeUndefined()
  await click('Check again')
  expect(button('Prepare Base INCOME')).toBeUndefined()
  expect(wallet.writeContract).toHaveBeenCalledOnce()
})

it('gap 3: a recovery whose chain reads throw ends in the explicit check, never a dead end', async () => {
  localStorage.setItem(KEY, JSON.stringify({
    version: 1, kind: 'income-launch', sessionId: '11111111-1111-4111-8111-111111111111', phase: 'unknown',
    chainId: 8453, projectId: '7', holder: OWNER, target: HELPER, data: encodeFunctionData(launchPlan(launchInput()).request),
    value: '1', label: 'Deploy INCOME', safe: false, submittedAt: Date.now(), afterBlock: '200',
  }))
  wallet.client.getTransaction.mockRejectedValue(new Error('RPC unavailable'))
  wallet.client.getTransactionReceipt.mockRejectedValue(new Error('RPC unavailable'))
  await render()
  expect(host.textContent).toContain(SAVED_ATTEMPT_CHECK_LINE)
  await click(checkedItLabel('Launch again'))
  expect(button('Prepare Base INCOME')?.closest('fieldset')?.disabled, host.textContent ?? '').toBe(false)
  expect(wallet.writeContract).not.toHaveBeenCalled()
})
