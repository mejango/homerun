/** The reviewed send's own gates: a success settled while away, and a replaced transaction. */
import './dialog-shim'
import { createElement, createRef, forwardRef, useImperativeHandle } from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { Address } from 'viem'
import { buildPayTx } from '@bananapus/nana-sdk-core/v6'
import { beforeEach, expect, it, vi } from 'vitest'
import { installRecoveryLocks } from './runtime/write-recovery-fixture'

vi.mock('@/providers/Providers', () => ({ wagmiConfig: {} }))
vi.mock('@wagmi/core', async importOriginal => {
  const { wallet, walletCore } = await import('./support/fake-wallet')
  return { ...(await importOriginal<typeof import('@wagmi/core')>()), ...walletCore, getAccount: () => ({ address: wallet.account, chainId: 10 }) }
})
vi.mock('wagmi', async importOriginal => {
  const { walletHooks } = await import('./support/fake-wallet')
  return { ...(await importOriginal<typeof import('wagmi')>()), ...walletHooks }
})
vi.mock('@/hooks/useWallet', async () => {
  const { useFakeWallet } = await import('./support/fake-wallet')
  return { useWallet: useFakeWallet }
})
vi.mock('@/lib/safe-connector', async importOriginal => ({ ...(await importOriginal<typeof import('@/lib/safe-connector')>()), isSafeConnection: () => false, useSafeConnection: () => false }))

import { sentHash, wallet } from './support/fake-wallet'
import { useReviewedAction, type TxRequest } from '@/hooks/useReviewedAction'

const ALICE = '0x1111111111111111111111111111111111111111' as Address
const TERMINAL = '0x2db6d704058e552defe415753465df8df0361846' as Address
const TOKEN = '0x000000000000000000000000000000000000EEEe' as Address

const PAY: TxRequest = buildPayTx({ chainId: 10, terminal: TERMINAL, projectId: 4n, token: TOKEN, amount: 10n ** 16n, beneficiary: ALICE, minReturnedTokens: 7n, memo: 'Homerun FUND payment', metadata: '0x' })

type Hook = ReturnType<typeof useReviewedAction>
const Harness = forwardRef<Hook>(function Harness(_, ref) {
  const value = useReviewedAction(10)
  useImperativeHandle(ref, () => value, [value])
  return null
})

async function mount() {
  const host = document.createElement('div')
  const root = createRoot(host)
  const ref = createRef<Hook>()
  await act(async () => root.render(createElement(Harness, { ref })))
  return { root, ref }
}

beforeEach(() => { localStorage.clear(); installRecoveryLocks(); wallet.reset(); wallet.connect(ALICE) })

it('a payment that went through while the user was away is shown with Send it again, never sent over', async () => {
  const first = await mount()
  let hash: `0x${string}` | null = null
  await act(async () => { hash = await first.ref.current!.send(PAY, { reviewedAccount: ALICE, recoveryNamespace: 'pay:4' }) })
  await act(async () => first.root.unmount())
  await act(async () => { wallet.confirm(hash!); await new Promise(resolve => setTimeout(resolve, 0)) })

  const back = await mount()
  await act(async () => { await back.ref.current!.send(PAY, { reviewedAccount: ALICE, recoveryNamespace: 'pay:4' }) })
  await vi.waitFor(() => expect(back.ref.current!.held?.kind).toBe('send-again'))
  expect(wallet.sent()).toHaveLength(1)
  await act(async () => back.root.unmount())
})

it('a same-nonce replacement is not shown as this payment\'s success', async () => {
  const replacement = sentHash(99)
  wallet.client.waitForTransactionReceipt.mockImplementationOnce(async () => ({
    status: 'success', blockNumber: 10n, blockHash: sentHash(10), transactionHash: replacement, transactionIndex: 0, from: ALICE, to: ALICE, logs: [],
  }))
  const { root, ref } = await mount()
  await act(async () => { await ref.current!.send(PAY, { reviewedAccount: ALICE }) })
  // The hold still has the payment: it is followed to its own receipt, never shown as done.
  await vi.waitFor(() => expect(ref.current!.phase).toBe('pending'))
  expect(ref.current!.receipt).toBeNull()
  expect(ref.current!.hash).not.toBe(replacement)
  await act(async () => root.unmount())
})
