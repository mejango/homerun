import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import type { Address, PublicClient } from 'viem'
import type { FundProjectState } from '../src/lib/fund-state'

const runtime = vi.hoisted(() => ({ fresh: undefined as unknown, verify: undefined as undefined | ((account: Address) => Promise<unknown>) }))
vi.mock('@/lib/fund-state', () => ({ readFundWriteState: async () => runtime.fresh }))
vi.mock('@/hooks/useWallet', () => ({ useWallet: () => ({ address: '0x1111111111111111111111111111111111111111' }) }))
vi.mock('@/components/ProjectPayment', () => ({ ProjectPayment: ({ verify }: { verify: (account: Address) => Promise<unknown> }) => { runtime.verify = verify; return null } }))
vi.mock('@/components/FundOperatorActions', () => ({ FundOperatorActions: () => null }))
import { PaymentPanel } from '../src/components/live-transactions'

const context = { token: '0x000000000000000000000000000000000000EEEe', terminal: '0x3333333333333333333333333333333333333333', decimals: 18, currency: 1, symbol: 'ETH', balance: 0n }
const state = {
  chainId: 1, projectId: 7n, blockNumber: 100n, account: null, controller: '0x2222222222222222222222222222222222222222',
  supportedController: true, supportedTerminals: true, knownOwnerWrapper: true, accountingContexts: [context],
  metadata: { pausePay: false, reservedPercent: 0 }, ruleset: { id: 5 }, allowlist: { hook: '0x4545454545454545454545454545454545454545', open: false, accountAllowed: null },
} as unknown as FundProjectState

it('opens on a retained snapshot but rejects a wallet the fresh read finds off the allowlist', async () => {
  const root = createRoot(document.createElement('div'))
  await act(async () => root.render(<PaymentPanel state={state} client={{} as PublicClient} contextIndex={0} />))
  runtime.fresh = { ...state, allowlist: { ...state.allowlist!, accountAllowed: false } }
  await expect(runtime.verify!('0x1111111111111111111111111111111111111111')).rejects.toThrow('not on the allowlist')
  runtime.fresh = { ...state, allowlist: { ...state.allowlist!, accountAllowed: true } }
  await expect(runtime.verify!('0x1111111111111111111111111111111111111111')).resolves.toBeTruthy()
  await act(async () => root.unmount())
})
