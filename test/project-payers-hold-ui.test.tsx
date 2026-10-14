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
vi.mock('@/lib/project-payers', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/project-payers')>()),
  checkPayerFactory: async () => ({ acceptsNative: true }),
  getProjectPayerAddresses: async () => [],
}))

import { wallet } from './support/fake-wallet'
import { ProjectPayerAddresses } from '@/components/ProjectPayerAddresses'
import { buildPayerTransaction, payerAttemptKey, type PayerAttempt } from '@/lib/project-payers'

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

it('adopts a saved attempt with no hash from the payer journal: the journal goes, and only the exit lets it be sent again', async () => {
  localStorage.setItem(KEY, JSON.stringify(legacy()))
  await render()
  expect(localStorage.getItem(KEY)).toBeNull()
  expect(button(EXIT)).toBeDefined()
  await click('Review payer creation')
  expect(wallet.writeContract).not.toHaveBeenCalled()
  await click(EXIT)
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

