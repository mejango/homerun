import './dialog-shim'
import { act, useEffect, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { NATIVE_TOKEN } from '@bananapus/nana-sdk-core'
import { netLoanProceeds } from '@bananapus/nana-sdk-core/v6/loan-math'
import { formatUnits, type Address, type Hex } from 'viem'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IncomeProjectState } from '@/lib/income-state'
import type { TxRequest, TxSendOptions, TxStep } from '@/hooks/useReviewedAction'
import { intent, writeIntentKey } from '@bananapus/nana-sdk-core/review'

const WALLET = '0x1111111111111111111111111111111111111111' as Address
const TERMINAL = '0x3333333333333333333333333333333333333333' as Address
const USDC = '0x7777777777777777777777777777777777777777' as Address
const HASH = `0x${'a'.repeat(64)}` as Hex
const UNIT = 10n ** 18n

type Handle = { notice: string | null; dismiss: ReturnType<typeof vi.fn>; phase: string; busy: boolean; isSafe: boolean; error: null; hash: Hex | null; safeProposalHash: Hex | null; receipt: null; send: ReturnType<typeof vi.fn>; reset: ReturnType<typeof vi.fn> }
const runtime = vi.hoisted(() => ({
  handles: [] as Handle[], next: 0,
  permitted: false, loans: [] as unknown[], loan: undefined as unknown,
  sends: [] as { request: TxRequest; options: TxSendOptions }[],
  allowance: 0n, reallocation: undefined as unknown, partial: undefined as unknown,
}))
vi.mock('@/hooks/useWallet', () => ({ useWallet: () => ({ address: WALLET }) }))
vi.mock('@/hooks/useReviewedAction', () => ({
  txPhaseLabel: (_phase: string, labels: { idle: string }) => labels.idle,
  useReviewedAction: () => {
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
// The loan tools' quotes, as a fresh quote returns them each attempt.
vi.mock('@/lib/income-loan-tools', async importOriginal => ({
  ...await importOriginal<typeof import('@/lib/income-loan-tools')>(),
  prepareIncomeLoanReallocation: async () => runtime.reallocation,
  prepareIncomePartialRepayment: async () => runtime.partial,
}))

import { IncomeBorrow, IncomeLoansList } from '@/components/IncomeProject'
import { IncomeLoanTools } from '@/components/IncomeLoanTools'
import { buildReallocateCollateralTx, MIN_PREPAID_FEE_PERCENT } from '@bananapus/nana-sdk-core/v6'
import { expectRetryHeldByIntent } from './support/intent-retry'
import { runSteps } from './support/reviewed-steps'
import { loanRepaymentIntent } from '@/lib/income-loan-tools'
import { approvalIntentKey } from '@/lib/transaction-builders'
import { v6Address } from '@/lib/income-contracts'

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
  runtime.allowance = 0n; runtime.reallocation = undefined; runtime.partial = undefined
  client.readContract.mockReset().mockImplementation(async ({ functionName }: { functionName: string }) => functionName === 'hasPermission' ? true : runtime.allowance)
  runtime.handles = Array.from({ length: 4 }, () => {
    const handle: Handle = {
      notice: null, dismiss: vi.fn(), phase: 'idle', busy: false, isSafe: false, error: null, hash: null, safeProposalHash: null, receipt: null, reset: vi.fn(),
      // A permission or approval and its loan step are one reviewed run.
      send: vi.fn(async (requested: TxRequest | TxRequest[], options: TxSendOptions) => runSteps(requested, options, (request, _index, sent) => { runtime.sends.push({ request, options: sent as TxSendOptions }); return HASH }, { safe: handle.isSafe, receipt: () => client.waitForTransactionReceipt() })),
    }
    return handle
  })
  cache = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); cache.clear() })

describe('INCOME loans like Juicebox Money', () => {
  it('ends a submitted collateral permission on Done without opening a loan', async () => {
    runtime.handles.forEach(handle => { handle.isSafe = true })
    const render = () => act(async () => root.render(<QueryClientProvider client={cache}><IncomeBorrow state={state} client={client as never} context={context} /></QueryClientProvider>))
    await render()
    await type('INCOME collateral', '10'); await settle()
    await act(async () => button('Review loan').click()); await settle()
    const permission = runtime.handles[0]
    permission.phase = 'submitted'
    permission.notice = 'Proposed to your Safe. Its other signers can approve it there.'
    await render()
    expect(host.querySelector('[data-tx-confirm]')!.textContent).toContain(permission.notice)
    expect(runtime.sends.map(sent => sent.request.functionName)).toEqual(['setPermissionsFor'])
    expect(host.querySelector('li[data-state="complete"]')).toBeNull()
    expect(button('Done').disabled).toBe(false)
    await act(async () => button('Done').click())
    expect(permission.dismiss).toHaveBeenCalledOnce()
    expect(host.querySelector('[data-tx-confirm]')).toBeNull()
  })

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
    expect(runtime.sends.map(sent => sent.request.functionName)).toEqual(['setPermissionsFor', 'borrowFrom'])
    expect(runtime.sends.map(sent => sent.options.reviewedAccount)).toEqual([WALLET, WALLET])
    const borrow = runtime.sends[1]
    expect(borrow.request.args).toContain(50n)
    // It simulates on the block its permission confirmed in.
    expect((borrow.request as TxStep).dependsOnPrior).toBe(true)
    expect(borrow.options.reviewNotice).toContain('The prepaid source fee is 5%')
    // Its borrow amount and minimum come from a fresh quote: a retry is held by the collateral the user chose.
    expect(borrow.options.recoveryNamespace).toBe(writeIntentKey('borrow', { project: state.projectId, token: 'auto:token', collateral: 10n * UNIT, fee: 50n }))
  })

  it('keys a borrow with the default prepaid fee as that default, not its value', async () => {
    runtime.permitted = true
    await act(async () => root.render(<QueryClientProvider client={cache}><IncomeBorrow state={state} client={client as never} context={context} /></QueryClientProvider>))
    await type('INCOME collateral', '10'); await settle()
    await act(async () => button('Review loan').click()); await settle()
    const borrow = runtime.sends.find(sent => sent.request.functionName === 'borrowFrom')!
    expect(borrow.options.recoveryNamespace).toBe(writeIntentKey('borrow', { project: state.projectId, token: 'auto:token', collateral: 10n * UNIT, fee: 'auto:fee' }))
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
    expect(runtime.sends).toHaveLength(1)
    expect(runtime.sends[0].request.functionName).toBe('repayLoan')
    // Its ceiling accrues with time: a retry is held by the loan the user chose to repay.
    expect(runtime.sends[0].options.recoveryNamespace).toBe(loanRepaymentIntent(state.projectId, 41n))
    expect(runtime.sends[0].request.value).toBe(4n * UNIT / 10n + 4n * UNIT / 10_000n)
  })

  /** An open USDC loan this wallet owns, whose repay ceiling is `ceiling` now. */
  const usdcLoan = (ceiling: bigint) => ({ blockNumber: 200n, chainId: 8453, projectId: 9n, loanId: 41n, owner: WALLET, loan: { amount: 400_000n, collateral: 5n * UNIT, sourceToken: USDC },
    sourceContext: context, accruedFee: ceiling - 400_400n, repayCeiling: ceiling })
  /** Every send stops after it is handed over, as a Safe proposal or a lost reply does: nothing follows it. */
  const stopAfterEachSend = () => { for (const handle of runtime.handles) handle.send.mockImplementation(async (requested: TxRequest | TxRequest[], options: TxSendOptions) => runSteps(requested, options, (request, _index, sent) => { runtime.sends.push({ request, options: sent as TxSendOptions }); return null })) }

  it('approves a full repayment under its loan, and a retry with a ceiling that accrued is held by the first', async () => {
    runtime.loans = [{ id: '41', owner: WALLET, collateral: String(5n * UNIT), borrowAmount: '400000', token: USDC, createdAt: 1_800_000_000, chainId: 8453 }]
    runtime.loan = usdcLoan(400_400n)
    stopAfterEachSend()
    await act(async () => root.render(<QueryClientProvider client={cache}><IncomeLoansList state={state} client={client as never} /></QueryClientProvider>))
    await settle()
    await act(async () => button('Repay').click()); await settle()
    runtime.loan = usdcLoan(400_500n)
    await act(async () => button('Review again').click()); await settle()
    expect(runtime.sends.map(sent => sent.request.functionName)).toEqual(['approve', 'approve'])
    await expectRetryHeldByIntent(runtime.sends[0], runtime.sends[1], approvalIntentKey(loanRepaymentIntent(state.projectId, 41n), { token: USDC, spender: v6Address('REVLoans', 8453), step: 'repay' }))
  })

  async function loanTools(action: 'reallocate' | 'partialRepay', collateral: string) {
    await act(async () => root.render(<QueryClientProvider client={cache}><IncomeLoanTools state={state} client={client as never} /></QueryClientProvider>))
    await type('Loan NFT ID', '41'); await settle()
    await act(async () => {
      const select = host.querySelector('select')!
      select.value = action
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await type(action === 'reallocate' ? 'INCOME collateral to move' : 'INCOME collateral to return', collateral); await settle()
  }
  const reviewLoanChange = async () => { await act(async () => button('Review loan change').click()); await settle() }

  it('refinances under the chosen move, and a retry with a fresh minimum is held by the first', async () => {
    runtime.loan = usdcLoan(400_400n)
    const quoteWith = (minimum: bigint) => ({
      loan: runtime.loan, grossBorrowAmount: minimum + 1n, minimumBorrowAmount: minimum, remainingCollateral: 3n * UNIT, newCollateral: 2n * UNIT,
      transaction: buildReallocateCollateralTx({ chainId: 8453, loanId: 41n, collateralCountToTransfer: 2n * UNIT, token: USDC, minBorrowAmount: minimum,
        collateralCountToAdd: 0n, beneficiary: WALLET, prepaidFeePercent: MIN_PREPAID_FEE_PERCENT }),
    })
    await loanTools('reallocate', '2')
    runtime.reallocation = quoteWith(100_000n)
    await reviewLoanChange()
    runtime.reallocation = quoteWith(99_000n)
    await reviewLoanChange()
    expect(runtime.sends.map(sent => sent.request.functionName)).toEqual(['reallocateCollateralFromLoan', 'reallocateCollateralFromLoan'])
    await expectRetryHeldByIntent(runtime.sends[0], runtime.sends[1], writeIntentKey('loan-reallocate', { project: state.projectId, loan: 41n, collateral: 2n * UNIT, added: 0n }))
  })

  /** A partial repayment's quote whose ceiling is `ceiling` now. */
  const partialWith = (ceiling: bigint) => ({ loan: runtime.loan, principal: 200_000n, fee: 1_000n, owed: 201_000n, ceiling,
    collateralToReturn: 2n * UNIT, remainingPrincipal: 200_000n, remainingCollateral: 3n * UNIT })

  it('approves a partial repayment under its loan, and a retry with a ceiling that accrued is held by the first', async () => {
    runtime.loan = usdcLoan(400_400n)
    stopAfterEachSend()
    await loanTools('partialRepay', '2')
    runtime.partial = partialWith(201_300n)
    await reviewLoanChange()
    runtime.partial = partialWith(201_400n)
    await reviewLoanChange()
    expect(runtime.sends.map(sent => sent.request.functionName)).toEqual(['approve', 'approve'])
    await expectRetryHeldByIntent(runtime.sends[0], runtime.sends[1], approvalIntentKey(loanRepaymentIntent(state.projectId, 41n), { token: USDC, spender: v6Address('REVLoans', 8453), step: 'repay' }))
  })

  it('repays part of a loan under the chosen collateral, and a retry with a ceiling that accrued is held by the first', async () => {
    runtime.loan = usdcLoan(400_400n)
    runtime.allowance = 10n ** 30n
    await loanTools('partialRepay', '2')
    runtime.partial = partialWith(201_300n)
    await reviewLoanChange()
    runtime.partial = partialWith(201_400n)
    await reviewLoanChange()
    expect(runtime.sends.map(sent => sent.request.functionName)).toEqual(['repayLoan', 'repayLoan'])
    await expectRetryHeldByIntent(runtime.sends[0], runtime.sends[1], loanRepaymentIntent(state.projectId, 41n))
  })

  it('holds a full repayment by one key from either screen: started in the repay dialog, the loan tools\' retry is refused', async () => {
    runtime.loans = [{ id: '41', owner: WALLET, collateral: String(5n * UNIT), borrowAmount: '400000', token: USDC, createdAt: 1_800_000_000, chainId: 8453 }]
    runtime.loan = usdcLoan(400_400n)
    runtime.allowance = 10n ** 30n
    stopAfterEachSend()
    await act(async () => root.render(<QueryClientProvider client={cache}><IncomeLoansList state={state} client={client as never} /></QueryClientProvider>))
    await settle()
    await act(async () => button('Repay').click()); await settle()
    // The loan tools close the loan: the contract returns all of its collateral, whatever was entered.
    runtime.loan = usdcLoan(400_600n)
    runtime.partial = { loan: runtime.loan, principal: 400_000n, fee: 500n, owed: 400_500n, ceiling: 400_600n, collateralToReturn: 5n * UNIT, remainingPrincipal: 0n, remainingCollateral: 0n }
    await loanTools('partialRepay', '2')
    await reviewLoanChange()
    expect(runtime.sends.map(sent => sent.request.functionName)).toEqual(['repayLoan', 'repayLoan'])
    await expectRetryHeldByIntent(runtime.sends[0], runtime.sends[1], loanRepaymentIntent(state.projectId, 41n))
  })

  it('holds a repayment by its loan whatever its quote returns: 200 of 1,000 asked, a quote that closes the loan, then a retry that does not', async () => {
    runtime.loan = usdcLoan(400_400n)
    runtime.allowance = 10n ** 30n
    await loanTools('partialRepay', '200')
    // No remaining capacity: the contract would close the loan and return all 1,000.
    runtime.partial = { ...partialWith(400_600n), collateralToReturn: 1_000n * UNIT, remainingPrincipal: 0n }
    await reviewLoanChange()
    // A fresh quote with capacity again: it returns the 200 asked.
    runtime.partial = { ...partialWith(201_400n), collateralToReturn: 200n * UNIT }
    await reviewLoanChange()
    expect(runtime.sends.map(sent => sent.request.functionName)).toEqual(['repayLoan', 'repayLoan'])
    await expectRetryHeldByIntent(runtime.sends[0], runtime.sends[1], loanRepaymentIntent(state.projectId, 41n))
  })
})
