/**
 * A payer deployment is held by the SDK's write hold under its intent, like every other write: a
 * lost wallet reply refuses the same deployment until the user's exit, and a saved attempt from the
 * payer journal that predates SDK holds is adopted into that hold on load.
 */
import './dialog-shim'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { encodeFunctionData, type Address } from 'viem'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { installRecoveryLocks } from './runtime/write-recovery-fixture'
import { checkedItLabel, HELD_SUCCESS_LINE, SAVED_ATTEMPT_CHECK_LINE } from '@bananapus/nana-sdk-core/review'

vi.mock('@/providers/Providers', () => ({ wagmiConfig: {} }))
vi.mock('@wagmi/core', async importOriginal => {
  const { wallet } = await import('./support/fake-wallet')
  return { ...(await importOriginal<typeof import('@wagmi/core')>()), getWalletClient: async () => ({ writeContract: wallet.writeContract }), getAccount: () => ({ address: wallet.account, chainId: 1 }) }
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
const factory = vi.hoisted(() => ({ check: async (): Promise<{ acceptsNative: boolean }> => ({ acceptsNative: true }) }))
vi.mock('@/lib/project-payers', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/project-payers')>()),
  checkPayerFactory: () => factory.check(),
  getProjectPayerAddresses: async () => [],
}))

import { wallet } from './support/fake-wallet'
import { ProjectPayerAddresses } from '@/components/ProjectPayerAddresses'
import { buildPayerTransaction, payerAttemptKey, payerIntent, type PayerAttempt } from '@/lib/project-payers'

const ALICE = '0x1111111111111111111111111111111111111111' as Address
const KEY = payerAttemptKey(1, 7n)
const EXIT = 'I checked my wallet. Send again'
const legacy = (extra: Partial<PayerAttempt> = {}): PayerAttempt => ({
  version: 1, id: '11111111-1111-4111-8111-111111111111', account: ALICE, safe: false, phase: 'signing', afterBlock: '100',
  settings: { chainId: 1, projectId: '7', beneficiary: '0x0000000000000000000000000000000000000000', owner: '0x0000000000000000000000000000000000000000', memo: '', addToBalance: false },
  ...extra,
})

let host: HTMLDivElement
let root: Root
let cache: QueryClient
const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 30)) })
const button = (text: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === text)
async function click(text: string) { expect(button(text), text).toBeDefined(); await act(async () => button(text)!.click()); await settle(); await settle() }
async function render() {
  await act(async () => root.render(<QueryClientProvider client={cache}><ProjectPayerAddresses chainId={1} projectId={7n} tokenLabel="FUND" /></QueryClientProvider>))
  await settle(); await settle()
}

beforeEach(() => {
  localStorage.clear(); installRecoveryLocks()
  wallet.reset(); wallet.connect(ALICE)
  cache = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); cache.clear(); localStorage.clear() })

it('refuses the same deployment after a lost wallet reply until the user takes the exit', async () => {
  wallet.writeContract.mockRejectedValueOnce(new Error('Wallet reply was lost after broadcast'))
  await render()
  await click('Review payer creation')
  expect(button(EXIT)).toBeDefined()
  await click('Review payer creation')
  expect(wallet.writeContract).toHaveBeenCalledOnce()
  await click(EXIT)
  await click('Review payer creation')
  expect(wallet.writeContract).toHaveBeenCalledTimes(2)
})

it('asks for the user’s check on a saved attempt with no hash from the payer journal, and only that check lets it be sent again', async () => {
  localStorage.setItem(KEY, JSON.stringify(legacy()))
  await render()
  // Nothing proves what it did: no send until the user says they checked it.
  expect(host.textContent).toContain(SAVED_ATTEMPT_CHECK_LINE)
  expect(button('Review payer creation')!.matches(':disabled')).toBe(true)
  await click(checkedItLabel('Review payer creation'))
  expect(localStorage.getItem(KEY)).toBeNull()
  await click('Review payer creation')
  expect(wallet.writeContract).toHaveBeenCalledOnce()
})

it('adopts a saved submitted attempt with its hash and follows it, never sending it again', async () => {
  const hash = `0x${'ab'.repeat(32)}` as const
  const request = buildPayerTransaction(legacy().settings)
  // The saved hash is this exact call, still pending.
  wallet.client.getTransaction.mockImplementation(async () => ({ hash, chainId: 1, from: ALICE, to: request.address, input: encodeFunctionData(request), value: 0n, nonce: 3, blockHash: null, blockNumber: null, transactionIndex: null }) as never)
  localStorage.setItem(KEY, JSON.stringify(legacy({ phase: 'submitted', hash })))
  await render()
  expect(localStorage.getItem(KEY)).toBeNull()
  expect(host.textContent).toContain('Submitted. Verifying the payer deployment onchain')
  expect(button(EXIT)).toBeUndefined()
  // It is being followed: nothing can send it again meanwhile.
  expect(button('Review payer creation')).toBeUndefined()
  expect(wallet.writeContract).not.toHaveBeenCalled()
})

it('sends nothing while a saved attempt is still being adopted, and keeps the journal until it is', async () => {
  const hash = `0x${'ab'.repeat(32)}` as const
  const request = buildPayerTransaction(legacy().settings)
  let answer!: () => void
  const slow = new Promise<void>(resolve => { answer = resolve })
  // The node is slow to answer for the saved hash, which is this exact call, still pending.
  wallet.client.getTransaction.mockImplementation(async () => { await slow; return { hash, chainId: 1, from: ALICE, to: request.address, input: encodeFunctionData(request), value: 0n, nonce: 3, blockHash: null, blockNumber: null, transactionIndex: null } as never })
  localStorage.setItem(KEY, JSON.stringify(legacy({ phase: 'submitted', hash })))
  await render()
  // An early review while the adoption waits on the node: nothing reaches the wallet, and the journal stays.
  if (button('Review payer creation') && !button('Review payer creation')!.disabled) await click('Review payer creation')
  expect(wallet.writeContract).not.toHaveBeenCalled()
  expect(localStorage.getItem(KEY)).not.toBeNull()
  answer()
  await settle(); await settle()
  expect(localStorage.getItem(KEY)).toBeNull()
  expect(host.textContent).toContain('Submitted. Verifying the payer deployment onchain')
  expect(wallet.writeContract).not.toHaveBeenCalled()
})

it('shows a held payer deployment with custom settings after a reload, with nothing entered and the factory unverified', async () => {
  wallet.writeContract.mockRejectedValueOnce(new Error('Wallet reply was lost after broadcast'))
  await render()
  const memo = host.querySelector<HTMLInputElement>('input[maxlength="500"]')!
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(memo, 'Rent'); memo.dispatchEvent(new Event('input', { bubbles: true })) })
  await click('Review payer creation')
  expect(button(EXIT)).toBeDefined()
  factory.check = async () => { throw new Error('Factory unavailable') }
  try {
    await act(async () => root.unmount()); root = createRoot(host); cache.clear()
    await render()
    expect(button(EXIT), host.textContent ?? '').toBeDefined()
    await click(EXIT)
    expect(button(EXIT)).toBeUndefined()
  } finally { factory.check = async () => ({ acceptsNative: true }) }
})


it('gap 2: a saved attempt whose hash the hold refuses as another write asks for the check, never reopening the send', async () => {
  const hash = `0x${'ab'.repeat(32)}` as const
  // The saved hash is some other call: the hold refuses to adopt it.
  wallet.client.getTransaction.mockImplementation(async () => ({ hash, chainId: 1, from: ALICE, to: '0x9999999999999999999999999999999999999999', input: '0x12345678', value: 0n, nonce: 3, blockHash: null, blockNumber: null, transactionIndex: null }) as never)
  localStorage.setItem(KEY, JSON.stringify(legacy({ phase: 'submitted', hash })))
  await render()
  expect(host.textContent).toContain(SAVED_ATTEMPT_CHECK_LINE)
  expect(button('Review payer creation')!.matches(':disabled')).toBe(true)
  await click(checkedItLabel('Review payer creation'))
  await click('Review payer creation')
  expect(wallet.writeContract).toHaveBeenCalledOnce()
})

it('gap 8: a payer deployment that settled while away is shown and followed, and the next one sends once', async () => {
  await render()
  await click('Review payer creation')
  expect(wallet.writeContract).toHaveBeenCalledOnce()
  await act(async () => root.unmount()); root = createRoot(host); cache.clear()
  // The chain places it and the SDK settles it while the page is away.
  const hash = `0x${'1'.padStart(64, '0')}` as `0x${string}`
  await act(async () => { wallet.confirm(hash) })
  const { holds } = await import('@/lib/write-hold')
  const hold = holds.open({ chainId: 1, account: ALICE, safe: false, namespace: payerIntent(7n), call: { to: ALICE, data: '0x' } })
  expect(await hold.onReceipt(await wallet.client.getTransactionReceipt({ hash }) as never, wallet.client as never)).toMatchObject({ status: 'clear', settled: { result: 'success' } })
  await render()
  // Its result is shown, never hidden behind a separate send: until it can be proven, nothing else is created.
  expect(host.textContent).toContain(HELD_SUCCESS_LINE)
  expect(button('Check again')).toBeDefined()
  expect(button('Review payer creation')!.matches(':disabled')).toBe(true)
  // A reload still shows it: an unproven success is never retired.
  await act(async () => root.unmount()); root = createRoot(host); cache.clear()
  await render()
  expect(host.textContent).toContain(HELD_SUCCESS_LINE)
  expect(wallet.writeContract).toHaveBeenCalledOnce()
})
