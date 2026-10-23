/**
 * The exact bytes the project-page write hook hands the wallet for a payment, a cash out and a
 * permission grant, against test/fixtures/reviewed-calldata.json. The
 * baseline was recorded through useSafeTx; the reviewed send that replaced it must send the same bytes.
 */
import './dialog-shim'
import { createElement, createRef, forwardRef, useImperativeHandle } from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { Address } from 'viem'
import { buildCashOutTx, buildPayTx, buildSetPermissionsTx } from '@bananapus/nana-sdk-core/v6'
import { expect, it, vi } from 'vitest'
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

import { wallet } from './support/fake-wallet'
import { useReviewedAction, type TxRequest } from '@/hooks/useReviewedAction'

const ALICE = '0x1111111111111111111111111111111111111111' as Address
const TERMINAL = '0x2db6d704058e552defe415753465df8df0361846' as Address
const TOKEN = '0x000000000000000000000000000000000000EEEe' as Address

const REQUESTS: Record<string, TxRequest> = {
  pay: buildPayTx({ chainId: 10, terminal: TERMINAL, projectId: 4n, token: TOKEN, amount: 10n ** 16n, beneficiary: ALICE, minReturnedTokens: 7n, memo: 'Homerun FUND payment', metadata: '0x' }),
  cashOut: buildCashOutTx({ chainId: 10, terminal: TERMINAL, holder: ALICE, projectId: 4n, cashOutCount: 10n ** 18n, tokenToReclaim: TOKEN, minTokensReclaimed: 5n, beneficiary: ALICE, metadata: '0x' }),
  permissions: buildSetPermissionsTx({ chainId: 10, account: ALICE, operator: TERMINAL, projectId: 4n, permissionIds: [1, 17] }),
}

type Hook = ReturnType<typeof useReviewedAction>
const Harness = forwardRef<Hook>(function Harness(_, ref) {
  const value = useReviewedAction(10)
  useImperativeHandle(ref, () => value, [value])
  return null
})

it('sends exactly the baseline bytes for a payment, a cash out and a permission grant', async () => {
  const sent: Record<string, unknown> = {}
  for (const [name, request] of Object.entries(REQUESTS)) {
    localStorage.clear(); installRecoveryLocks()
    wallet.reset(); wallet.connect(ALICE)
    const host = document.createElement('div')
    const root = createRoot(host)
    const ref = createRef<Hook>()
    await act(async () => root.render(createElement(Harness, { ref })))
    await act(async () => { await ref.current!.send(request, { reviewedAccount: ALICE }) })
    expect(wallet.sent()).toHaveLength(1)
    sent[name] = wallet.sent()[0]
    await act(async () => root.unmount())
  }
  await expect(`${JSON.stringify(sent, null, 2)}\n`).toMatchFileSnapshot('fixtures/reviewed-calldata.json')
})
