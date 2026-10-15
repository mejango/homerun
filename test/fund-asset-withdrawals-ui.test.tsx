import './dialog-shim'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { parseAbi, type Address, type Hex } from 'viem'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { FundProjectState } from '@/lib/fund-state'
import type { TxRequest, TxSendOptions } from '@/hooks/useSafeTx'
import { allowanceIntent, intent, writeIntentKey } from '@bananapus/nana-sdk-core/review'
import { expectRetryHeldByIntent } from './support/intent-retry'

const OPERATOR = '0x1111111111111111111111111111111111111111' as Address
const RECIPIENT = '0x2222222222222222222222222222222222222222' as Address
const FEE_RECIPIENT = '0x3333333333333333333333333333333333333333' as Address
const TERMINAL = '0x4444444444444444444444444444444444444444' as Address
const USDC = '0x7777777777777777777777777777777777777777' as Address
const BLOCK_HASH = `0x${'ef'.repeat(32)}` as Hex

const runtime = vi.hoisted(() => ({ net: 0n, sends: [] as { request: TxRequest; options: TxSendOptions }[] }))
vi.mock('@/hooks/useWallet', () => ({ useWallet: () => ({ address: OPERATOR }) }))
vi.mock('@/providers/Providers', () => ({ wagmiConfig: {} }))
vi.mock('@wagmi/core', () => ({ getPublicClient: () => client }))
vi.mock('@/hooks/useSafeTx', () => ({
  txPhaseLabel: (_phase: string, labels: { idle: string }) => labels.idle,
  useSafeTx: () => ({ phase: 'idle', busy: false, error: null, hash: null, safeProposalHash: null, receipt: null, held: null, notice: null, reset: vi.fn(), dismiss: vi.fn(),
    // Handed over, then nothing follows it: a lost reply or a Safe proposal.
    send: async (request: TxRequest, options: TxSendOptions) => { runtime.sends.push({ request, options }); return null } }),
}))
vi.mock('@/lib/fund-state', async importOriginal => ({
  ...await importOriginal<typeof import('@/lib/fund-state')>(),
  readFundProjectState: async () => state,
  readLinkedFundProjects: async () => [state],
  assertFundStateForWrite: () => undefined,
}))
// The terminal's call, with the minimum net payout it carries: what the component sends.
const useAllowanceAbi = parseAbi(['function useAllowanceOf(uint256 projectId,address token,uint256 amount,uint256 currency,uint256 minTokensPaidOut,address beneficiary,address feeBeneficiary,string memo)'])
vi.mock('@/lib/fund-contracts', async importOriginal => ({
  ...await importOriginal<typeof import('@/lib/fund-contracts')>(),
  buildFundUseAllowance: (input: { terminal: Address; token: Address; amount: bigint; currency: number; minTokensPaidOut: bigint; beneficiary: Address; feeBeneficiary: Address; memo?: string }) => ({
    chainId: 1, address: input.terminal, abi: useAllowanceAbi, functionName: 'useAllowanceOf',
    args: [7n, input.token, input.amount, BigInt(input.currency), input.minTokensPaidOut, input.beneficiary, input.feeBeneficiary, input.memo ?? ''] }),
}))

import { FundAssetWithdrawals } from '@/components/FundAssetWithdrawals'
import { FUND_CASH_OUTS_DISABLED } from '@/lib/fund-contracts'

const context = { token: USDC, terminal: TERMINAL, decimals: 6, currency: 1, symbol: 'USDC', balance: 10n ** 12n, surplus: 10n ** 12n,
  surplusAllowances: [{ currency: 1, amount: 10n ** 12n }] }
const state = {
  chainId: 1, projectId: 7n, blockNumber: 100n, blockHash: BLOCK_HASH, owner: OPERATOR, controller: TERMINAL, linkedChainIds: [1],
  metadata: { pausePay: true, cashOutTaxRate: FUND_CASH_OUTS_DISABLED }, hasPendingRuleset: false, ruleset: { id: 3 },
  rulesetSnapshot: { configuration: { id: 3 }, blockNumber: 100n }, permissions: { useAllowance: true, queueRulesets: false },
  accountingContexts: [context],
} as unknown as FundProjectState
const client = {
  readContract: vi.fn(async () => 0n),
  getBlock: vi.fn(async () => ({ hash: BLOCK_HASH, number: 100n })),
  // The terminal quotes the net payout for the exact sender, amount and recipients: fresh each attempt.
  simulateContract: vi.fn(async () => ({ result: runtime.net })),
}

let host: HTMLDivElement
let root: Root
const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
async function type(label: string, value: string) {
  const input = [...host.querySelectorAll('label')].find(node => node.textContent?.startsWith(label))!.querySelector('input')!
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })) })
}
const review = () => [...host.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === 'Review asset withdrawal')!

beforeEach(() => {
  runtime.sends = []
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => { await act(async () => root.unmount()); host.remove() })

it('withdraws under the chosen withdrawal, and a retry with a fresh net quote is held by the first', async () => {
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await act(async () => root.render(<QueryClientProvider client={cache}><FundAssetWithdrawals state={state} client={client as never} contextIndex={0} /></QueryClientProvider>))
  await settle()
  await type('Withdraw in USDC', '1000')
  await type('Asset purchase recipient', RECIPIENT)
  await type('Fee token recipient', FEE_RECIPIENT)
  await type('Public purchase reference', 'Invoice 12, Rotterdam')
  await settle()
  runtime.net = 975_000_000n
  await act(async () => review().click()); await settle()
  runtime.net = 974_000_000n
  await act(async () => review().click()); await settle()
  expect(runtime.sends.map(sent => sent.request.functionName)).toEqual(['useAllowanceOf', 'useAllowanceOf'])
  await expectRetryHeldByIntent(runtime.sends[0], runtime.sends[1], allowanceIntent({ chainId: 1, project: 7n, terminal: TERMINAL, token: USDC, currency: 1, beneficiary: RECIPIENT }))
  // A hold saved under the earlier key still holds it.
  expect(runtime.sends[0].options.recoveryLegacy).toEqual([writeIntentKey('asset-withdrawal', {
    project: 7n, token: intent.address(USDC), amount: 1_000_000_000n, beneficiary: intent.address(RECIPIENT), feeBeneficiary: intent.address(FEE_RECIPIENT), memo: 'Homerun asset purchase: Invoice 12, Rotterdam' })])
  cache.clear()
})
