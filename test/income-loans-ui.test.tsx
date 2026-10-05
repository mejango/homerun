import './dialog-shim'
import { act, useEffect, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { NATIVE_TOKEN } from '@bananapus/nana-sdk-core'
import { netLoanProceeds } from '@bananapus/nana-sdk-core/v6/loan-math'
import { formatUnits, type Address, type Hex } from 'viem'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IncomeProjectState } from '@/lib/income-state'
import type { TxRequest, TxSendOptions } from '@/hooks/useSafeTx'

const WALLET = '0x1111111111111111111111111111111111111111' as Address
const TERMINAL = '0x3333333333333333333333333333333333333333' as Address
const USDC = '0x7777777777777777777777777777777777777777' as Address
const HASH = `0x${'a'.repeat(64)}` as Hex
const UNIT = 10n ** 18n

type Handle = { phase: string; busy: boolean; isSafe: boolean; error: null; hash: Hex | null; safeProposalHash: Hex | null; receipt: null; send: ReturnType<typeof vi.fn>; reset: ReturnType<typeof vi.fn> }
const runtime = vi.hoisted(() => ({
  handles: [] as Handle[], next: 0,
  permitted: false, loans: [] as unknown[], loan: undefined as unknown,
  sends: [] as { request: TxRequest; options: TxSendOptions }[],
}))
vi.mock('@/hooks/useWallet', () => ({ useWallet: () => ({ address: WALLET }) }))
vi.mock('@/hooks/useSafeTx', () => ({
  txPhaseLabel: (_phase: string, labels: { idle: string }) => labels.idle,
  useSafeTx: () => {
    const [index] = useState(() => runtime.next++)
    useEffect(() => undefined, [])
    return runtime.handles[index]
  },
}))
vi.mock('@bananapus/nana-sdk-core/v6', async importOriginal => ({
  ...await importOriginal<typeof import('@bananapus/nana-sdk-core/v6')>(),
  getBorrowableAmount: async () => ({ borrowableNow: 1_000_000n, borrowableCapacity: 1_000_000n }),
  hasPermissions: async () => runtime.permitted,
}))
vi.mock('@/lib/income-state', async importOriginal => ({
  ...await importOriginal<typeof import('@/lib/income-state')>(),
  readIncomeProjectState: async () => ({ ...state, blockNumber: 200n }),
  readIncomeLoan: async () => runtime.loan,
}))
vi.mock('@/lib/loans-queries', () => ({ getLoans: async () => ({ items: runtime.loans, totalCount: runtime.loans.length }) }))

import { IncomeBorrow, IncomeLoansList } from '@/components/IncomeProject'

const context = { token: USDC, terminal: TERMINAL, decimals: 6, currency: 1, symbol: 'USDC', isPrimary: true, balance: 0n }
const state = {
  chainId: 8453, projectId: 9n, blockNumber: 100n, controller: '0x2222222222222222222222222222222222222222', tokenAddress: '0x5555555555555555555555555555555555555555',
  totalBalance: 100n * UNIT, cashOutsAvailable: true, accountingContexts: [context],
} as unknown as IncomeProjectState
const client = { waitForTransactionReceipt: vi.fn(async () => ({ status: 'success', blockNumber: 101n })), readContract: vi.fn() }

let host: HTMLDivElement
let root: Root
let cache: QueryClient
const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
const button = (text: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === text)!
async function type(label: string, value: string) {
  const input = [...host.querySelectorAll('label')].find(node => node.textContent?.startsWith(label))!.querySelector('input')!
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })) })
}

beforeEach(() => {
  runtime.next = 0; runtime.permitted = false; runtime.loans = []; runtime.loan = undefined; runtime.sends = []
  runtime.handles = Array.from({ length: 4 }, () => ({
    phase: 'idle', busy: false, isSafe: false, error: null, hash: null, safeProposalHash: null, receipt: null, reset: vi.fn(),
    send: vi.fn(async (request: TxRequest, options: TxSendOptions = {}) => { await options.reverify?.(request); runtime.sends.push({ request, options }); return HASH }),
  }))
  cache = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); cache.clear() })

describe('INCOME loans like Juicebox Money', () => {
  it('borrows with the chosen prepaid fee, granting the collateral permission first and continuing on its own', async () => {
    await act(async () => root.render(<QueryClientProvider client={cache}><IncomeBorrow state={state} client={client as never} context={context} /></QueryClientProvider>))
    await type('INCOME collateral', '10'); await settle()
    await act(async () => button('5%').click()); await settle()
    expect(host.textContent).toContain(`You receive about ${formatUnits(netLoanProceeds(1_000_000n, 50n), 6)} USDC`)
    await act(async () => button('Review loan').click()); await settle()
    const dialog = host.querySelector('[data-tx-confirm]')!
    expect(dialog.textContent).toContain('Prepaid fee5%')
    expect([...dialog.querySelectorAll('li[data-state]')].map(step => step.textContent)).toEqual([
      expect.stringContaining('Allow REVLoans to use your INCOME as collateral'), expect.stringContaining('Borrow against 10 INCOME'),
    ])
    await act(async () => button('Confirm & borrow').click()); await settle()
    expect(runtime.sends.map(sent => sent.request.functionName)).toEqual(['setPermissionsFor', 'borrowFrom'])
    expect(runtime.sends.map(sent => sent.options.reviewedAccount)).toEqual([WALLET, WALLET])
    const borrow = runtime.sends[1]
    expect(borrow.request.args).toContain(50n)
    expect(borrow.options.simulationBlockNumber).toBe(200n)
    expect(borrow.options.reviewNotice).toContain('The prepaid source fee is 5%')
  })

  it('lists only the wallet’s open loans and repays one in full', async () => {
    runtime.loans = [
      { id: '41', owner: WALLET, collateral: String(5n * UNIT), borrowAmount: '400000', token: NATIVE_TOKEN, createdAt: 1_800_000_000, chainId: 8453 },
      { id: '42', owner: '0x9999999999999999999999999999999999999999', collateral: String(5n * UNIT), borrowAmount: '1', token: NATIVE_TOKEN, createdAt: 1_800_000_000, chainId: 8453 },
      { id: '43', owner: WALLET, collateral: '0', borrowAmount: '0', token: NATIVE_TOKEN, createdAt: 1_800_000_000, chainId: 8453 },
    ]
    const nativeContext = { ...context, token: NATIVE_TOKEN, decimals: 18, symbol: 'ETH' }
    const nativeState = { ...state, accountingContexts: [nativeContext] } as unknown as IncomeProjectState
    runtime.loan = { blockNumber: 200n, loanId: 41n, owner: WALLET, loan: { amount: 4n * UNIT / 10n, collateral: 5n * UNIT }, sourceContext: nativeContext, accruedFee: 0n, repayCeiling: 4n * UNIT / 10n + 4n * UNIT / 10_000n }
    await act(async () => root.render(<QueryClientProvider client={cache}><IncomeLoansList state={nativeState} client={client as never} /></QueryClientProvider>))
    await settle()
    const rows = [...host.querySelectorAll('li')]
    expect(rows).toHaveLength(1)
    expect(rows[0].textContent).toContain('Loan 41')
    await act(async () => button('Repay').click()); await settle()
    const dialog = host.querySelector('[data-tx-confirm]')!
    expect(dialog.textContent).toContain('You get back5 INCOME')
    await act(async () => button('Confirm & repay').click()); await settle()
    expect(runtime.sends).toHaveLength(1)
    expect(runtime.sends[0].request.functionName).toBe('repayLoan')
    expect(runtime.sends[0].request.value).toBe(4n * UNIT / 10n + 4n * UNIT / 10_000n)
  })
})
