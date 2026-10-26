/**
 * One in-app confirmation per action: the site's own review provider and
 * dialog, the real useReviewedAction and core's reviewed run. An action with
 * an approval opens one review for all its steps, sends each step to the
 * wallet once, and its progress dialog has no confirm of its own.
 * Fund launch with Relayr and deploy chains join this file with Relayr's
 * move to core (H5).
 */
import './dialog-shim'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { toFunctionSelector, type Address } from 'viem'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { installRecoveryLocks } from './runtime/write-recovery-fixture'

const WALLET = '0x1111111111111111111111111111111111111111' as Address
const TERMINAL = '0x3333333333333333333333333333333333333333' as Address
const USDC = '0x7777777777777777777777777777777777777777' as Address
const UNIT = 10n ** 6n

vi.mock('@/providers/Providers', () => ({ wagmiConfig: {} }))
vi.mock('next/image', () => ({ default: (props: Record<string, unknown>) => createElement('img', { ...props, src: 'asset' }) }))
vi.mock('@wagmi/core', async importOriginal => {
  const { wallet, walletCore } = await import('./support/fake-wallet')
  return { ...(await importOriginal<typeof import('@wagmi/core')>()), ...walletCore, getAccount: () => ({ address: wallet.account, chainId: 1 }) }
})
vi.mock('wagmi', async importOriginal => {
  const { wallet, walletHooks } = await import('./support/fake-wallet')
  return { ...(await importOriginal<typeof import('wagmi')>()), ...walletHooks, useAccount: () => ({ address: wallet.useAccount(), chainId: 1 }) }
})
vi.mock('@/hooks/useWallet', async () => {
  const { useFakeWallet } = await import('./support/fake-wallet')
  return { useWallet: useFakeWallet }
})
vi.mock('@/lib/safe-connector', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/safe-connector')>()),
  isSafeConnection: () => false,
  useSafeConnection: () => false,
}))
// No fee-buyback reads: the notice stays in its unknown state.
vi.mock('@/lib/fee-buyback-client', () => ({ feeBuybackContext: () => { throw new Error('No fee-buyback reads in this test.') } }))
vi.mock('@/lib/project-pay-quote', () => ({
  prepareProjectPayQuote: async () => ({ terminal: TERMINAL, preview: { beneficiaryTokenCount: 100n * 10n ** 18n, reservedTokenCount: 0n }, minimumTokenCount: 99n * 10n ** 18n, reservedTokenCount: 0n, metadata: '0x', blockNumber: 100n, quoteFailed: false }),
  readProjectPayTokenOptions: async () => [{ token: USDC, terminal: TERMINAL, decimals: 6, symbol: 'USDC', viaRouter: false }],
}))

import { sentHash, wallet } from './support/fake-wallet'
import { TransactionReviewProvider } from '@/components/TransactionReviewProvider'
import { ProjectPayment } from '@/components/ProjectPayment'

let host: HTMLDivElement
let root: Root
let cache: QueryClient
let reviews: number
let observer: MutationObserver
const settle = () => act(async () => { await vi.dynamicImportSettled(); await new Promise(resolve => setTimeout(resolve, 20)) })
const buttons = () => [...document.querySelectorAll<HTMLButtonElement>('button')]
const reviewOpen = () => !!document.querySelector('button[aria-label="Cancel transaction review"]')

beforeEach(() => {
  localStorage.clear(); installRecoveryLocks()
  wallet.reset(); wallet.connect(WALLET)
  // The allowance the terminal has: the approval's, once the wallet sent it.
  wallet.client.readContract.mockImplementation(async ({ functionName }) => {
    if (functionName === 'allowance') return wallet.writes().length ? 2n * UNIT : 0n
    throw new Error(`Unexpected read ${functionName}`)
  })
  cache = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  // Each review dialog the provider renders, counted as it opens.
  reviews = 0
  let open = false
  observer = new MutationObserver(() => { const now = reviewOpen(); if (now && !open) reviews++; open = now })
  observer.observe(document.body, { childList: true, subtree: true })
})
afterEach(async () => { observer.disconnect(); await act(async () => root.unmount()); host.remove(); cache.clear(); localStorage.clear() })

it('wallet-action:one-confirmation pay', async () => {
  await act(async () => root.render(<QueryClientProvider client={cache}><TransactionReviewProvider>
    <ProjectPayment chainId={1} projectId={7n} tokenLabel="FUND" title="Contribute" context={{ token: USDC, terminal: TERMINAL, decimals: 6, symbol: 'USDC' }}
      paused={false} reservedPercent={0} rulesetId="1" verify={async (_account, minimumBlock) => ({ blockNumber: minimumBlock ?? 100n })} />
  </TransactionReviewProvider></QueryClientProvider>))
  const input = host.querySelector('input')!
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '2'); input.dispatchEvent(new Event('input', { bubbles: true })) })
  await settle()
  await act(async () => buttons().find(button => button.textContent === 'Pay on Ethereum')!.click())
  await vi.waitFor(async () => { await settle(); expect(reviewOpen()).toBe(true) })

  // The approval and the payment are one review, and the progress behind it has no confirm.
  const review = document.querySelector('button[aria-label="Cancel transaction review"]')!.closest('dialog')!
  expect(review.textContent).toMatch(/approve/i)
  expect(review.textContent).toMatch(/pay/i)
  expect(buttons().some(button => /^Confirm & /.test(button.textContent ?? ''))).toBe(false)
  await act(async () => review.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click())
  // Its one confirm; with no fee-return reads here it sends without that estimate.
  const confirm = () => buttons().find(button => button.textContent === 'Submit without estimate')
  await vi.waitFor(async () => { await settle(); expect(confirm()?.disabled).toBe(false) })
  await act(async () => confirm()!.click())

  await vi.waitFor(async () => { await settle(); expect(wallet.writeContract).toHaveBeenCalledOnce() })
  await act(async () => wallet.confirm(sentHash(1), 101n))
  await vi.waitFor(async () => { await settle(); expect(wallet.writeContract).toHaveBeenCalledTimes(2) })
  await act(async () => wallet.confirm(sentHash(2), 102n))
  await settle()

  expect(reviews).toBe(1)
  // One wallet send per step: the exact approval to the token, then the payment to the terminal.
  expect(wallet.sent().map(sent => [sent.to, sent.data.slice(0, 10)])).toEqual([[USDC, toFunctionSelector('approve(address,uint256)')], [TERMINAL, expect.any(String)]])
  expect(buttons().some(button => /^Confirm & /.test(button.textContent ?? ''))).toBe(false)
})
