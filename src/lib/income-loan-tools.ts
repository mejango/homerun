/** Preparation for ordinary, wallet-owned REVLoans positions. All amounts remain bigint. */
import { NATIVE_TOKEN } from '@bananapus/nana-sdk-core'
import { buildReallocateCollateralTx, buildRepayLoanTx, MIN_PREPAID_FEE_PERCENT } from '@bananapus/nana-sdk-core/v6'
import { getAddress, isAddress, isAddressEqual, zeroAddress, type Address, type PublicClient } from 'viem'
import type { FundTransaction } from './fund-contracts'
import { incomeRepayCeiling, protectedIncomeMinimum, revLoansAbi, v6Address } from './income-contracts'
import { readIncomeLoan, readIncomeProjectState, type IncomeLoanState, type IncomeProjectState } from './income-state'

export type IncomeLoanToolInput = { client: PublicClient; state: IncomeProjectState; account: Address; loanId: bigint; minimumBlock?: bigint }

export function incomeLoanRecipient(value: string): Address | null {
  const text = value.trim()
  return isAddress(text) && !isAddressEqual(text as Address, zeroAddress) ? getAddress(text) : null
}

function requireCaughtUp(blockNumber: bigint, minimumBlock?: bigint) {
  if (minimumBlock !== undefined && blockNumber < minimumBlock) throw new Error('The RPC has not caught up with the confirmed prerequisite. Wait and retry.')
}

async function currentLoan(input: IncomeLoanToolInput) {
  const current = await readIncomeLoan(input.client, { chainId: input.state.chainId, projectId: input.state.projectId, loanId: input.loanId, account: input.account })
  requireCaughtUp(current.blockNumber, input.minimumBlock)
  return current
}

async function verifyLoanBlock(client: PublicClient, loan: IncomeLoanState) {
  const block = await client.getBlock({ blockNumber: loan.blockNumber })
  if (block.hash !== loan.blockHash) throw new Error('The chain changed while the loan quote was being prepared. Refresh and retry.')
}

export function assertSameIncomeLoan(reviewed: IncomeLoanState, current: IncomeLoanState) {
  if (reviewed.loanId !== current.loanId || reviewed.projectId !== current.projectId || reviewed.chainId !== current.chainId || !isAddressEqual(reviewed.owner, current.owner) || !isAddressEqual(reviewed.loan.sourceToken, current.loan.sourceToken) || reviewed.loan.amount !== current.loan.amount || reviewed.loan.collateral !== current.loan.collateral || reviewed.loan.createdAt !== current.loan.createdAt || reviewed.loan.prepaidDuration !== current.loan.prepaidDuration || reviewed.loan.prepaidFeePercent !== current.loan.prepaidFeePercent) throw new Error('The reviewed loan changed. Prepare a new transaction.')
  if (reviewed.sourceContext.decimals !== current.sourceContext.decimals || reviewed.sourceContext.currency !== current.sourceContext.currency || !isAddressEqual(reviewed.sourceContext.terminal, current.sourceContext.terminal) || !current.sourceContext.isPrimary) throw new Error('The loan source accounting changed. Prepare a new transaction.')
}

export async function prepareIncomeLoanTransfer(input: IncomeLoanToolInput & { recipient: string }) {
  const recipient = incomeLoanRecipient(input.recipient)
  if (!recipient) throw new Error('Enter the explicit recipient address for this loan NFT.')
  if (isAddressEqual(recipient, input.account)) throw new Error('Choose a different recipient for the loan NFT.')
  const loan = await currentLoan(input)
  const transaction: FundTransaction = { chainId: input.state.chainId, address: v6Address('REVLoans', input.state.chainId), abi: revLoansAbi, functionName: 'safeTransferFrom', args: [input.account, recipient, input.loanId] }
  return { loan, recipient, transaction }
}

export async function prepareIncomeLoanReallocation(input: IncomeLoanToolInput & { collateralToTransfer: bigint; collateralToAdd: bigint }) {
  const { collateralToTransfer, collateralToAdd, account, state, client } = input
  if (collateralToTransfer < 0n || collateralToAdd < 0n || collateralToTransfer + collateralToAdd <= 0n || collateralToTransfer + collateralToAdd >= 1n << 112n) throw new Error('Enter a positive amount of collateral within the loan limit.')
  const project = await readIncomeProjectState(client, { chainId: state.chainId, projectId: state.projectId, account })
  requireCaughtUp(project.blockNumber, input.minimumBlock)
  if (!project.cashOutsAvailable) throw new Error('INCOME borrowing is still locked.')
  if (!isAddressEqual(project.controller, state.controller) || project.tokenAddress !== state.tokenAddress) throw new Error('The INCOME contracts changed. Refresh before refinancing.')
  if (collateralToAdd > project.totalBalance) throw new Error('This wallet does not have enough additional INCOME collateral.')
  const loan = await currentLoan(input)
  if (collateralToTransfer > loan.loan.collateral) throw new Error('The collateral to move exceeds this loan’s collateral.')
  const source = loan.sourceContext
  const loans = v6Address('REVLoans', state.chainId)
  // Only the old loan's source is permitted by REVLoans; never offer cross-source refinancing.
  const [remainingCapacity, freshBorrow] = await Promise.all([
    client.readContract({ address: loans, abi: revLoansAbi, functionName: 'borrowableAmountFrom', args: [state.projectId, loan.loan.collateral - collateralToTransfer, BigInt(source.decimals), BigInt(source.currency)], blockNumber: loan.blockNumber }),
    client.readContract({ address: loans, abi: revLoansAbi, functionName: 'borrowableAmountFrom', args: [state.projectId, collateralToTransfer + collateralToAdd, BigInt(source.decimals), BigInt(source.currency)], blockNumber: loan.blockNumber }),
  ])
  if (remainingCapacity[1] < loan.loan.amount) throw new Error('The remaining collateral cannot cover the original loan. Move less collateral or repay part of the loan first.')
  const grossBorrowAmount = freshBorrow[0]
  const minimumBorrowAmount = protectedIncomeMinimum(grossBorrowAmount)
  const transaction = buildReallocateCollateralTx({ chainId: state.chainId, loanId: input.loanId, collateralCountToTransfer: collateralToTransfer, token: source.token, minBorrowAmount: minimumBorrowAmount, collateralCountToAdd: collateralToAdd, beneficiary: account, prepaidFeePercent: MIN_PREPAID_FEE_PERCENT }) satisfies FundTransaction
  await verifyLoanBlock(client, loan)
  return { loan, project, transaction, grossBorrowAmount, minimumBorrowAmount, remainingCollateral: loan.loan.collateral - collateralToTransfer, newCollateral: collateralToTransfer + collateralToAdd }
}

/** Reads the same economic-capacity and source-fee views used by REVLoans.repayLoan. */
export async function prepareIncomePartialRepayment(input: IncomeLoanToolInput & { collateralToReturn: bigint }) {
  if (input.collateralToReturn <= 0n) throw new Error('Enter a positive amount of INCOME collateral to return.')
  const loan = await currentLoan(input)
  if (input.collateralToReturn > loan.loan.collateral) throw new Error('The amount to return exceeds this loan’s collateral.')
  const source = loan.sourceContext
  const loans = v6Address('REVLoans', input.state.chainId)
  const remaining = await input.client.readContract({ address: loans, abi: revLoansAbi, functionName: 'borrowableAmountFrom', args: [input.state.projectId, loan.loan.collateral - input.collateralToReturn, BigInt(source.decimals), BigInt(source.currency)], blockNumber: loan.blockNumber })
  // The contract uses capacity (tuple[1]), even when the treasury currently has no liquidity.
  const remainingPrincipal = remaining[1]
  if (remainingPrincipal > loan.loan.amount) throw new Error('This return leaves more borrowing capacity than the existing debt. Return more collateral to quote repayment.')
  const principal = loan.loan.amount - remainingPrincipal
  const fee = await input.client.readContract({ address: loans, abi: revLoansAbi, functionName: 'determineSourceFeeAmount', args: [loan.loan, principal], blockNumber: loan.blockNumber })
  const owed = principal + fee
  // If remaining capacity is zero, REVLoans itself returns all collateral and closes the loan.
  const collateralToReturn = remainingPrincipal === 0n ? loan.loan.collateral : input.collateralToReturn
  const ceiling = principal === 0n ? owed : incomeRepayCeiling(principal, fee)
  await verifyLoanBlock(input.client, loan)
  return { loan, principal, fee, owed, ceiling, collateralToReturn, remainingPrincipal, remainingCollateral: loan.loan.collateral - collateralToReturn }
}

export function buildIncomePartialRepayment(input: { quote: Awaited<ReturnType<typeof prepareIncomePartialRepayment>>; account: Address; maximum: bigint }) {
  const { quote, account, maximum } = input
  if (!isAddressEqual(account, quote.loan.owner) || maximum < quote.owed || maximum > quote.ceiling) throw new Error('The repayment maximum or beneficiary does not match the reviewed loan quote.')
  return buildRepayLoanTx({ chainId: quote.loan.chainId, loanId: quote.loan.loanId, maxRepayBorrowAmount: maximum, collateralCountToReturn: quote.collateralToReturn, beneficiary: account, value: isAddressEqual(quote.loan.sourceContext.token, NATIVE_TOKEN) ? maximum : 0n }) satisfies FundTransaction
}
