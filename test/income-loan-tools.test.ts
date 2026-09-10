import { describe, expect, it, vi } from 'vitest'
import { NATIVE_TOKEN, USDC_ADDRESSES } from '@bananapus/nana-sdk-core'
import { v6Address } from '@bananapus/nana-sdk-core/v6'
import { zeroAddress, type Address, type Hex, type PublicClient } from 'viem'
import { assertSameIncomeLoan, buildIncomePartialRepayment, incomeLoanRecipient, prepareIncomeLoanReallocation, prepareIncomeLoanTransfer, prepareIncomePartialRepayment } from '../src/lib/income-loan-tools'
import { readIncomeLoan, readIncomeProjectState, type IncomeLoanState, type IncomeProjectState } from '../src/lib/income-state'

vi.mock('../src/lib/income-state', async importOriginal => ({
  ...await importOriginal<typeof import('../src/lib/income-state')>(),
  readIncomeLoan: vi.fn(), readIncomeProjectState: vi.fn(),
}))

const OWNER = '0x1111111111111111111111111111111111111111' as const
const RECIPIENT = '0x2222222222222222222222222222222222222222' as const
const TOKEN = '0x3333333333333333333333333333333333333333' as const
const HASH = `0x${'ab'.repeat(32)}` as Hex
const CHAIN = 1
const PROJECT = 7n
const LOAN_ID = 7_000_000_001n
const BLOCK = 12345n

function fixture(options: { remainingCapacity?: bigint; borrowNow?: bigint; fee?: bigint; native?: boolean; reorg?: boolean } = {}) {
  const sourceToken = options.native ? NATIVE_TOKEN : USDC_ADDRESSES[CHAIN]
  const state = {
    chainId: CHAIN, projectId: PROJECT, tokenAddress: TOKEN, controller: v6Address('JBController', CHAIN),
    account: OWNER, cashOutsAvailable: true, totalBalance: 300n, blockNumber: BLOCK,
  } as IncomeProjectState
  const loan: IncomeLoanState = {
    chainId: CHAIN, projectId: PROJECT, blockNumber: BLOCK, blockHash: HASH, blockTimestamp: 1_800_000_100n,
    loanId: LOAN_ID, owner: OWNER,
    loan: { amount: 100_000n, collateral: 1_000n, createdAt: 1_700_000_000, prepaidDuration: 15_768_000, prepaidFeePercent: 25, sourceToken },
    sourceContext: { token: sourceToken, decimals: options.native ? 18 : 6, currency: options.native ? 1 : 2, terminal: v6Address('JBMultiTerminal', CHAIN), primaryTerminal: v6Address('JBMultiTerminal', CHAIN), isPrimary: true, symbol: options.native ? 'ETH' : 'USDC', balance: 1_000_000n, surplus: 1_000_000n },
    accruedFee: 50n, repayCeiling: 100_150n,
  }
  vi.mocked(readIncomeLoan).mockResolvedValue(loan)
  vi.mocked(readIncomeProjectState).mockResolvedValue(state)
  const readContract = vi.fn(async (request: { address: Address; functionName: string; args: readonly unknown[]; blockNumber: bigint }) => {
    expect(request.address).toBe(v6Address('REVLoans', CHAIN))
    expect(request.blockNumber).toBe(BLOCK)
    if (request.functionName === 'borrowableAmountFrom') {
      expect(request.args[0]).toBe(PROJECT)
      expect(request.args[2]).toBe(BigInt(loan.sourceContext.decimals))
      expect(request.args[3]).toBe(BigInt(loan.sourceContext.currency))
      return request.args[1] === 800n ? [0n, options.remainingCapacity ?? 150_000n] : [options.borrowNow ?? 50_000n, 55_000n]
    }
    if (request.functionName === 'determineSourceFeeAmount') { expect(request.args[0]).toEqual(loan.loan); return options.fee ?? 500n }
    throw new Error(`Unexpected RPC call ${request.functionName}`)
  })
  const getBlock = vi.fn(async () => ({ hash: options.reorg ? `0x${'cd'.repeat(32)}` : HASH }))
  const client = { readContract, getBlock } as unknown as PublicClient
  return { loan, state, readContract, getBlock, input: { client, state, account: OWNER, loanId: LOAN_ID } }
}

describe('ordinary INCOME loan transfer', () => {
  it('requires a valid explicit recipient and safe-transfers the existing owner’s NFT', async () => {
    const f = fixture()
    const prepared = await prepareIncomeLoanTransfer({ ...f.input, recipient: ` ${RECIPIENT} ` })
    expect(prepared.transaction).toMatchObject({ chainId: CHAIN, address: v6Address('REVLoans', CHAIN), functionName: 'safeTransferFrom', args: [OWNER, RECIPIENT, LOAN_ID] })
    expect(readIncomeLoan).toHaveBeenCalledWith(f.input.client, { chainId: CHAIN, projectId: PROJECT, loanId: LOAN_ID, account: OWNER })
  })

  it.each(['', 'not an address', zeroAddress, OWNER])('rejects invalid or ineffective destination %s', async recipient => {
    await expect(prepareIncomeLoanTransfer({ ...fixture().input, recipient })).rejects.toThrow(/recipient/)
  })

  it('never replaces an invalid recipient with the connected wallet', () => {
    expect(incomeLoanRecipient('invalid')).toBeNull()
    expect(incomeLoanRecipient('')).toBeNull()
  })

  it('rejects loan ownership verification failures and RPCs behind a prerequisite', async () => {
    const f = fixture()
    vi.mocked(readIncomeLoan).mockRejectedValueOnce(new Error('Not the loan owner'))
    await expect(prepareIncomeLoanTransfer({ ...f.input, recipient: RECIPIENT })).rejects.toThrow(/owner/)
    await expect(prepareIncomeLoanTransfer({ ...f.input, recipient: RECIPIENT, minimumBlock: BLOCK + 1n })).rejects.toThrow(/caught up/)
  })
})

describe('ordinary INCOME collateral refinancing', () => {
  it('uses the original source, verifies old debt coverage and protects the fresh gross quote', async () => {
    const f = fixture()
    const prepared = await prepareIncomeLoanReallocation({ ...f.input, collateralToTransfer: 200n, collateralToAdd: 100n })
    expect(prepared).toMatchObject({ grossBorrowAmount: 50_000n, minimumBorrowAmount: 49_500n, remainingCollateral: 800n, newCollateral: 300n })
    expect(prepared.transaction).toMatchObject({ chainId: CHAIN, address: v6Address('REVLoans', CHAIN), functionName: 'reallocateCollateralFromLoan', args: [LOAN_ID, 200n, USDC_ADDRESSES[CHAIN], 49_500n, 100n, OWNER, 25n] })
    expect(f.readContract.mock.calls.map(([request]) => request.args[1])).toEqual([800n, 300n])
    expect(f.getBlock).toHaveBeenCalledWith({ blockNumber: BLOCK })
  })

  it('allows zero new wallet collateral while retaining a protected new loan', async () => {
    const prepared = await prepareIncomeLoanReallocation({ ...fixture().input, collateralToTransfer: 200n, collateralToAdd: 0n })
    expect(prepared.transaction.args[4]).toBe(0n)
    expect(prepared.newCollateral).toBe(200n)
  })

  it('rejects removing collateral needed by the original debt', async () => {
    await expect(prepareIncomeLoanReallocation({ ...fixture({ remainingCapacity: 99_999n }).input, collateralToTransfer: 200n, collateralToAdd: 100n })).rejects.toThrow(/cannot cover/)
  })

  it.each([{ collateralToTransfer: -1n, collateralToAdd: 100n }, { collateralToTransfer: 0n, collateralToAdd: 0n }, { collateralToTransfer: 1n << 112n, collateralToAdd: 0n }, { collateralToTransfer: 1001n, collateralToAdd: 0n }, { collateralToTransfer: 200n, collateralToAdd: 301n }])('rejects impossible collateral selections %o', async counts => {
    await expect(prepareIncomeLoanReallocation({ ...fixture().input, ...counts })).rejects.toThrow(/collateral|limit/)
  })

  it('refuses a zero live borrow quote instead of disabling minimum protection', async () => {
    await expect(prepareIncomeLoanReallocation({ ...fixture({ borrowNow: 0n }).input, collateralToTransfer: 200n, collateralToAdd: 100n })).rejects.toThrow(/positive live quote/)
  })

  it('rejects unavailable borrowing, changed contracts and stale prerequisite state', async () => {
    const f = fixture()
    vi.mocked(readIncomeProjectState).mockResolvedValueOnce({ ...f.state, cashOutsAvailable: false })
    await expect(prepareIncomeLoanReallocation({ ...f.input, collateralToTransfer: 200n, collateralToAdd: 100n })).rejects.toThrow(/locked/)
    vi.mocked(readIncomeProjectState).mockResolvedValueOnce({ ...f.state, tokenAddress: RECIPIENT })
    await expect(prepareIncomeLoanReallocation({ ...f.input, collateralToTransfer: 200n, collateralToAdd: 100n })).rejects.toThrow(/contracts changed/)
    await expect(prepareIncomeLoanReallocation({ ...f.input, collateralToTransfer: 200n, collateralToAdd: 100n, minimumBlock: BLOCK + 1n })).rejects.toThrow(/caught up/)
  })

  it('rejects reorganization during the extra quote reads', async () => {
    await expect(prepareIncomeLoanReallocation({ ...fixture({ reorg: true }).input, collateralToTransfer: 200n, collateralToAdd: 100n })).rejects.toThrow(/chain changed/)
  })
})

describe('partial INCOME loan repayment', () => {
  it('uses economic capacity, not live liquidity, then quotes the fee for just the repaid principal', async () => {
    const f = fixture({ remainingCapacity: 75_000n })
    const quote = await prepareIncomePartialRepayment({ ...f.input, collateralToReturn: 200n })
    expect(quote).toMatchObject({ principal: 25_000n, fee: 500n, owed: 25_500n, ceiling: 25_525n, collateralToReturn: 200n, remainingPrincipal: 75_000n, remainingCollateral: 800n })
    expect(f.readContract.mock.calls[1][0].args).toEqual([f.loan.loan, 25_000n])
    const tx = buildIncomePartialRepayment({ quote, account: OWNER, maximum: quote.ceiling })
    expect(tx).toMatchObject({ functionName: 'repayLoan', args: [LOAN_ID, 25_525n, 200n, OWNER, { amount: 0n, signature: '0x' }], value: 0n })
  })

  it('caps an ERC20 repayment to an existing allowance that covers actual debt without forcing another buffered approval', async () => {
    const f = fixture({ remainingCapacity: 75_000n })
    const quote = await prepareIncomePartialRepayment({ ...f.input, collateralToReturn: 200n })
    const tx = buildIncomePartialRepayment({ quote, account: OWNER, maximum: quote.owed + 1n })
    expect(tx.args[1]).toBe(25_501n)
    expect(() => buildIncomePartialRepayment({ quote, account: OWNER, maximum: quote.owed - 1n })).toThrow(/maximum/)
  })

  it('sends the identical repayment ceiling as native value', async () => {
    const f = fixture({ remainingCapacity: 75_000n, native: true })
    const quote = await prepareIncomePartialRepayment({ ...f.input, collateralToReturn: 200n })
    const tx = buildIncomePartialRepayment({ quote, account: OWNER, maximum: quote.ceiling })
    expect(tx.value).toBe(tx.args[1])
    expect(tx.value).toBe(25_525n)
  })

  it('quotes full closure when the remaining collateral has zero economic capacity', async () => {
    const quote = await prepareIncomePartialRepayment({ ...fixture({ remainingCapacity: 0n }).input, collateralToReturn: 200n })
    expect(quote).toMatchObject({ principal: 100_000n, collateralToReturn: 1000n, remainingPrincipal: 0n, remainingCollateral: 0n })
  })

  it('supports releasing excess collateral without spending money when capacity exactly equals debt', async () => {
    const f = fixture({ remainingCapacity: 100_000n, fee: 0n })
    const quote = await prepareIncomePartialRepayment({ ...f.input, collateralToReturn: 200n })
    expect(quote).toMatchObject({ principal: 0n, fee: 0n, owed: 0n, ceiling: 0n, collateralToReturn: 200n, remainingPrincipal: 100_000n })
    expect(buildIncomePartialRepayment({ quote, account: OWNER, maximum: 0n }).args[1]).toBe(0n)
  })

  it('does not clamp excess remaining capacity into an invalid zero-payment transaction', async () => {
    await expect(prepareIncomePartialRepayment({ ...fixture({ remainingCapacity: 100_001n }).input, collateralToReturn: 200n })).rejects.toThrow(/more borrowing capacity/)
  })

  it.each([0n, -1n, 1001n])('rejects invalid collateral return %s', async collateralToReturn => {
    await expect(prepareIncomePartialRepayment({ ...fixture().input, collateralToReturn })).rejects.toThrow(/collateral/)
  })

  it('rejects a changed beneficiary, a widened maximum and a quote reorg', async () => {
    const quote = await prepareIncomePartialRepayment({ ...fixture({ remainingCapacity: 75_000n }).input, collateralToReturn: 200n })
    expect(() => buildIncomePartialRepayment({ quote, account: RECIPIENT, maximum: quote.ceiling })).toThrow(/beneficiary/)
    expect(() => buildIncomePartialRepayment({ quote, account: OWNER, maximum: quote.ceiling + 1n })).toThrow(/maximum/)
    await expect(prepareIncomePartialRepayment({ ...fixture({ remainingCapacity: 75_000n, reorg: true }).input, collateralToReturn: 200n })).rejects.toThrow(/chain changed/)
  })
})

describe('loan review revalidation', () => {
  it('preserves debt, collateral, source and owner across the review boundary', () => {
    const { loan } = fixture()
    expect(() => assertSameIncomeLoan(loan, { ...loan })).not.toThrow()
    expect(() => assertSameIncomeLoan(loan, { ...loan, owner: RECIPIENT })).toThrow(/loan changed/)
    expect(() => assertSameIncomeLoan(loan, { ...loan, loan: { ...loan.loan, collateral: 999n } })).toThrow(/loan changed/)
    expect(() => assertSameIncomeLoan(loan, { ...loan, sourceContext: { ...loan.sourceContext, decimals: 18 } })).toThrow(/accounting changed/)
  })
})
