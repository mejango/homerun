'use client'

import { NATIVE_TOKEN, jbPermissionsAbi } from '@bananapus/nana-sdk-core'
import { buildSetPermissionsTx, REVLOANS_BURN_PERMISSION_ID } from '@bananapus/nana-sdk-core/v6'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { erc20Abi, formatUnits, isAddressEqual, type PublicClient } from 'viem'
import { useReviewedAction, txPhaseLabel, type TxRequest, type TxStep } from '@/hooks/useReviewedAction'
import { useWallet } from '@/hooks/useWallet'
import { explorerTxUrl } from '@/lib/chainDisplay'
import { parseAmount } from '@/lib/fund-contracts'
import { approvalIntentKey, buildErc20ApproveRequest } from '@/lib/transaction-builders'
import { v6Address } from '@/lib/income-contracts'
import { readIncomeLoan, type IncomeProjectState } from '@/lib/income-state'
import { assertSameIncomeLoan, buildIncomePartialRepayment, incomeLoanRecipient, loanRepaymentIntent, prepareIncomeLoanReallocation, prepareIncomeLoanTransfer, prepareIncomePartialRepayment } from '@/lib/income-loan-tools'
import { readableError } from '@/lib/readable-error'
import { HeldNotice } from '@/components/ui/HeldWriteExit'
import { writeIntentKey, type ReviewedPriorBlock } from '@bananapus/nana-sdk-core/review'

type Props = { state: IncomeProjectState; client: PublicClient }
type LoanAction = 'transfer' | 'reallocate' | 'partialRepay'
function numberInput(value: string) { try { return parseAmount(value.trim(), 18) } catch { return null } }
function errorMessage(error: unknown) { return readableError(error, 'This loan transaction could not be prepared.') }
function loanIdInput(value: string) { return /^\d{1,78}$/.test(value.trim()) ? BigInt(value.trim()) : 0n }
function Field({ label, value, onChange, address = false }: { label: string; value: string; onChange: (value: string) => void; address?: boolean }) {
  return <label className="grid gap-2 text-sm">{label}<input className="min-h-12 w-full rounded border border-[#bfc9b5] bg-white px-3 text-base" value={value} onChange={event => onChange(event.target.value)} inputMode={address ? 'text' : 'decimal'} autoComplete="off" /></label>
}
function TransactionStatus({ tx, chainId }: { tx: ReturnType<typeof useReviewedAction>; chainId: number }) {
  return <div className="mt-4 break-words text-sm" role="status" aria-live="polite">
    {tx.phase === 'submitted' ? <HeldNotice tx={tx} /> : tx.phase === 'pending' ? <p>Submitted. Waiting for onchain confirmation…</p> : tx.phase === 'success' ? <p>Confirmed onchain. Loan balances are refreshing.</p> : null}
    {tx.error && <p className="text-red-800">{tx.error}</p>}
    {tx.hash && !tx.safeProposalHash && <a className="underline" href={explorerTxUrl(chainId, tx.hash) ?? undefined} target="_blank" rel="noreferrer">View transaction</a>}
  </div>
}

/** Ordinary loan NFTs only; distributor-held vesting loans have a separate owner and are rejected. */
export function IncomeLoanTools({ state, client }: Props) {
  const { address } = useWallet()
  const cache = useQueryClient()
  const tx = useReviewedAction(state.chainId)
  const seenReceipts = useRef(new Set<string>())
  const [loanInput, setLoanInput] = useState('')
  const [action, setAction] = useState<LoanAction>('partialRepay')
  const [recipient, setRecipient] = useState('')
  const [collateralInput, setCollateralInput] = useState('')
  const [additionalInput, setAdditionalInput] = useState('0')
  const [preparing, setPreparing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const loanId = loanIdInput(loanInput)
  const parsedCollateral = numberInput(collateralInput)
  const parsedAdditional = numberInput(additionalInput)
  const collateral = parsedCollateral ?? 0n
  const additional = parsedAdditional ?? 0n
  const busy = preparing || tx.busy || tx.phase === 'review' || tx.phase === 'submitted'
  const loan = useQuery({
    queryKey: ['income-loan-tools', state.chainId, state.projectId.toString(), loanId.toString(), address],
    enabled: !!address && loanId > 0n,
    queryFn: () => readIncomeLoan(client, { chainId: state.chainId, projectId: state.projectId, loanId, account: address! }),
    retry: false,
  })

  useEffect(() => {
    if (tx.phase !== 'success' || !tx.receipt || seenReceipts.current.has(tx.receipt.transactionHash)) return
    seenReceipts.current.add(tx.receipt.transactionHash)
    for (const prefix of ['income-project', 'income-loan', 'income-loan-tools', 'income-borrow', 'income-pay', 'income-cash-out']) void cache.invalidateQueries({ queryKey: [prefix, state.chainId, state.projectId.toString()] })
  }, [cache, state.chainId, state.projectId, tx.phase, tx.receipt])

  async function submit() {
    if (!address || loanId <= 0n || (action !== 'transfer' && parsedCollateral === null) || (action === 'reallocate' && parsedAdditional === null)) return
    setPreparing(true); setError(null)
    const input = { client, state, account: address, loanId }
    // A step after a permission or approval reads at or after the block that step confirmed in.
    const after = (prior?: ReviewedPriorBlock) => ({ ...input, minimumBlock: prior?.blockNumber })
    try {
      if (action === 'transfer') {
        const prepared = await prepareIncomeLoanTransfer({ ...input, recipient })
        await tx.send({ ...prepared.transaction, label: `Transfer loan NFT ${loanId} and its collateral claim to ${prepared.recipient}` }, {
          reviewedAccount: input.account,
          reviewNotice: `The recipient becomes the owner of this loan and can reclaim its ${formatUnits(prepared.loan.loan.collateral, 18)} INCOME collateral by repaying. This transfers the loan position, not spendable INCOME tokens.`,
          reverify: async () => { const current = await prepareIncomeLoanTransfer({ ...input, recipient: prepared.recipient }); assertSameIncomeLoan(prepared.loan, current.loan) },
        })
      } else if (action === 'reallocate') {
        const prepared = await prepareIncomeLoanReallocation({ ...input, collateralToTransfer: collateral, collateralToAdd: additional })
        const loans = v6Address('REVLoans', state.chainId)
        // Reallocation remints the moved collateral and burns it again for the new loan, so even zero additions require ID 11.
        const permitted = await client.readContract({ address: v6Address('JBPermissions', state.chainId), abi: jbPermissionsAbi, functionName: 'hasPermission', args: [loans, address, state.projectId, BigInt(REVLOANS_BURN_PERMISSION_ID), true, true], blockNumber: prepared.loan.blockNumber })
        const source = prepared.loan.sourceContext
        const refinance: TxStep = { ...prepared.transaction, label: `Refinance loan ${loanId}; borrow at least ${formatUnits(prepared.minimumBorrowAmount, source.decimals)} ${source.symbol} before fees`,
          // Its minimum comes from a fresh quote: a retry is held by the refinance the user chose.
          recoveryNamespace: writeIntentKey('loan-reallocate', { project: state.projectId, loan: loanId, collateral, added: additional }),
          ...(permitted ? {} : { dependsOnPrior: true }) }
        // The permission and the refinance are one review, and resume as one action after a reload.
        await tx.send(permitted ? [refinance] : [{ ...buildSetPermissionsTx({ chainId: state.chainId, account: address, operator: loans, projectId: state.projectId, permissionIds: [REVLOANS_BURN_PERMISSION_ID] }), label: 'Allow REVLoans to burn this project’s INCOME collateral for refinancing' }, refinance], {
          reviewedAccount: input.account,
          scope: `homerun:loan-reallocate:${refinance.recoveryNamespace}`,
          reviewNotice: `The original debt remains backed by ${formatUnits(prepared.remainingCollateral, 18)} INCOME. A new loan uses ${formatUnits(prepared.newCollateral, 18)} INCOME. Its minimum has 1% slippage protection before the 2.5% prepaid source fee and applicable protocol and REV fees. Proceeds and both replacement loan NFTs stay with your wallet.`,
          reverify: async (step: TxRequest, _index: number, prior?: ReviewedPriorBlock) => { const current = await prepareIncomeLoanReallocation({ ...after(prior), collateralToTransfer: collateral, collateralToAdd: additional }); assertSameIncomeLoan(prepared.loan, current.loan); if (step.functionName !== 'setPermissionsFor' && current.grossBorrowAmount < prepared.minimumBorrowAmount) throw new Error('The protected borrowing quote is no longer available. Review a fresh quote.') },
        })
      } else {
        const prepared = await prepareIncomePartialRepayment({ ...input, collateralToReturn: collateral })
        const source = prepared.loan.sourceContext
        const loans = v6Address('REVLoans', state.chainId)
        const native = isAddressEqual(source.token, NATIVE_TOKEN)
        let maximum = prepared.ceiling
        const allowance = !native && prepared.owed > 0n ? await client.readContract({ address: source.token, abi: erc20Abi, functionName: 'allowance', args: [address, loans], blockNumber: prepared.loan.blockNumber }) : undefined
        const approving = allowance !== undefined && allowance < prepared.owed
        // Use existing allowance that covers actual debt even when a newly calculated buffer grew by one wei.
        if (allowance !== undefined && !approving && allowance < maximum) maximum = allowance
        const transaction = buildIncomePartialRepayment({ quote: prepared, account: address, maximum })
        const repay: TxStep = { ...transaction, label: `Return ${formatUnits(prepared.collateralToReturn, 18)} INCOME; repay at most ${formatUnits(maximum, source.decimals)} ${source.symbol}`,
          // Its ceiling and what it returns come from a quote: a retry is held by the loan, the same
          // hold as a full repayment from the repay dialog.
          recoveryNamespace: loanRepaymentIntent(state.projectId, loanId),
          ...(approving ? { dependsOnPrior: true } : {}) }
        // The approval and the repayment are one review, and resume as one action after a reload.
        await tx.send(approving ? [{ ...buildErc20ApproveRequest({ chainId: state.chainId, token: source.token, spender: loans, amount: maximum }), label: `Approve up to ${formatUnits(maximum, source.decimals)} ${source.symbol} for this loan repayment`,
          // Its amount, the repay ceiling, accrues with time: it is held as the repayment's approval step.
          recoveryNamespace: approvalIntentKey(loanRepaymentIntent(state.projectId, loanId), { token: source.token, spender: loans, step: 'repay' }) }, repay] : [repay], {
          reviewedAccount: input.account,
          scope: `homerun:loan-partial-repay:${repay.recoveryNamespace}`,
          reviewNotice: `This repayment owes ${formatUnits(prepared.principal, source.decimals)} ${source.symbol} principal and ${formatUnits(prepared.fee, source.decimals)} ${source.symbol} accrued fees. ${prepared.remainingPrincipal === 0n ? 'It closes the loan and returns all collateral.' : `A replacement loan keeps ${formatUnits(prepared.remainingCollateral, 18)} INCOME collateral and ${formatUnits(prepared.remainingPrincipal, source.decimals)} ${source.symbol} principal outstanding.`} Unused funds from the maximum are refunded to your wallet.`,
          reverify: async (step: TxRequest, _index: number, prior?: ReviewedPriorBlock) => {
            const current = await prepareIncomePartialRepayment({ ...after(prior), collateralToReturn: collateral }); assertSameIncomeLoan(prepared.loan, current.loan)
            if (step.functionName === 'approve' ? current.owed > maximum : current.owed > maximum || current.collateralToReturn !== prepared.collateralToReturn) throw new Error('The repayment amount or collateral return changed. Review a fresh quote.')
          },
        })
      }
    } catch (reason) { setError(errorMessage(reason)) } finally { setPreparing(false) }
  }

  const validInput = action === 'transfer' ? !!incomeLoanRecipient(recipient) && !!address && !isAddressEqual(incomeLoanRecipient(recipient)!, address)
    : action === 'reallocate' ? parsedCollateral !== null && parsedAdditional !== null && (collateral > 0n || additional > 0n)
      : collateral > 0n
  return <section className="demo-section" aria-label="Manage INCOME loans">
    <h2>Manage INCOME loans</h2>
    <p className="mb-5">Change loan NFTs your wallet owns. Each change is quoted and reviewed before you sign.</p>
    <div className="grid gap-4 sm:grid-cols-2">
      <Field label="Loan NFT ID" value={loanInput} onChange={setLoanInput} />
      <label className="grid gap-2 text-sm">Action<select className="min-h-12 w-full rounded border border-[#bfc9b5] bg-white px-3 pr-9" value={action} onChange={event => setAction(event.target.value as LoanAction)}><option value="partialRepay">Return some collateral</option><option value="reallocate">Refinance excess collateral</option><option value="transfer">Transfer loan NFT</option></select></label>
    </div>
    {loan.isFetching && !loan.data && <p className="mt-4 text-sm" role="status">Reading this loan…</p>}
    {loan.data && <dl className="demo-live-rows mt-4"><div><dt>Collateral</dt><dd>{formatUnits(loan.data.loan.collateral, 18)} INCOME</dd></div><div><dt>Outstanding principal</dt><dd>{formatUnits(loan.data.loan.amount, loan.data.sourceContext.decimals)} {loan.data.sourceContext.symbol}</dd></div></dl>}
    {loan.isError && <p className="mt-4 text-sm text-red-800" role="alert">{errorMessage(loan.error)}</p>}
    <div className="mt-5 grid gap-4 sm:grid-cols-2">
      {action === 'transfer' ? <Field label="Recipient address" value={recipient} onChange={setRecipient} address /> : <Field label={action === 'reallocate' ? 'INCOME collateral to move to a new loan' : 'INCOME collateral to return to your wallet'} value={collateralInput} onChange={setCollateralInput} />}
      {action === 'reallocate' && <Field label="Additional INCOME from your wallet" value={additionalInput} onChange={setAdditionalInput} />}
    </div>
    {action === 'reallocate' && <p className="mt-4 text-xs text-[var(--muted)]">The original debt stays fully backed. The new loan pays a 2.5% prepaid source fee plus protocol and REV fees; minima are shown before fees.</p>}
    {action === 'partialRepay' && <p className="mt-4 text-xs text-[var(--muted)]">The contracts set the debt owed for this return, including fees. If the rest has no borrowing value, the loan closes and returns all collateral.</p>}
    <button type="button" className="btn-primary mt-5 min-h-11 px-5" disabled={!address || busy || !loan.data || loan.isError || !validInput} onClick={() => void submit()}>{preparing ? 'Preparing…' : txPhaseLabel(tx.phase, { idle: 'Review loan change', pending: 'Confirming onchain…' })}</button>
    {error && <p className="mt-4 text-sm text-red-800" role="alert">{error}</p>}
    <TransactionStatus tx={tx} chainId={state.chainId} />
  </section>
}
