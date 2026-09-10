'use client'

import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { formatUnits, isAddressEqual, zeroAddress, type Address, type PublicClient } from 'viem'
import { useSafeTx, txPhaseLabel } from '@/hooks/useSafeTx'
import { useWallet } from '@/hooks/useWallet'
import { explorerTxUrl } from '@/lib/chainDisplay'
import { assertIncomeReservedProject, assertSameIncomeReservedTokens, buildSendIncomeReservedTokensTx, readIncomeReservedTokens, verifyIncomeReservedReceipt, type IncomeReservedSnapshot } from '@/lib/income-reserved'
import type { IncomeProjectState } from '@/lib/income-state'

function message(error: unknown) { return error instanceof Error ? error.message : 'Reserved INCOME could not be verified.' }
function recipient(split: IncomeReservedSnapshot['splits'][number]) {
  const beneficiary = isAddressEqual(split.beneficiary, zeroAddress) ? 'the caller' : split.beneficiary
  if (!isAddressEqual(split.hook, zeroAddress)) return `Hook ${split.hook}, beneficiary ${split.beneficiary}`
  if (split.projectId > 0n) return `Project ${split.projectId}, beneficiary ${beneficiary} (also the fallback recipient)`
  if (split.beneficiary.toLowerCase() === '0x000000000000000000000000000000000000dead') return 'Burn'
  return beneficiary
}
function splitAmount(snapshot: IncomeReservedSnapshot, percent: number) { return snapshot.pending * BigInt(percent) / 1_000_000_000n }

/** Anyone can fund the existing reserved recipients; no operator privilege or holder balance is required. */
export function IncomeReservedTokens({ state, client }: { state: IncomeProjectState; client: PublicClient }) {
  const { address } = useWallet()
  const cache = useQueryClient()
  const tx = useSafeTx(state.chainId)
  const [preparing, setPreparing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [intent, setIntent] = useState<{ snapshot: IncomeReservedSnapshot; account: Address } | null>(null)
  const refreshed = useRef<string | null>(null)
  const query = useQuery({
    queryKey: ['income-reserved', state.chainId, state.projectId.toString()],
    queryFn: () => readIncomeReservedTokens(client, { chainId: state.chainId, projectId: state.projectId }),
    staleTime: 10_000, refetchInterval: 20_000, retry: 1,
  })
  const verified = useQuery({
    queryKey: ['income-reserved-receipt', state.chainId, state.projectId.toString(), tx.receipt?.transactionHash],
    enabled: tx.phase === 'success' && !!tx.receipt && !!intent,
    queryFn: () => verifyIncomeReservedReceipt(client, intent!.snapshot, intent!.account, tx.receipt!),
    retry: 1, staleTime: Infinity,
  })
  useEffect(() => {
    if (tx.phase !== 'success' || !tx.receipt || refreshed.current === tx.receipt.transactionHash) return
    // Even a receipt whose event proof is unavailable should refresh current
    // reserves, so a retry cannot misleadingly offer an already-flushed amount.
    refreshed.current = tx.receipt.transactionHash
    for (const prefix of ['income-project', 'income-reserved', 'income-pay', 'income-cash-out', 'income-borrow']) void cache.invalidateQueries({ queryKey: [prefix, state.chainId, state.projectId.toString()] })
    for (const prefix of ['sticky-project', 'sticky-rewards']) void cache.invalidateQueries({ queryKey: [prefix, state.chainId] })
    void cache.invalidateQueries({ queryKey: ['income-sticky-binding', state.chainId, state.projectId.toString()] })
  }, [cache, state.chainId, state.projectId, tx.phase, tx.receipt])

  async function submit() {
    if (!address || preparing || tx.busy || tx.phase === 'review') return
    setPreparing(true); setError(null)
    try {
      const snapshot = await readIncomeReservedTokens(client, { chainId: state.chainId, projectId: state.projectId })
      assertIncomeReservedProject(snapshot, state)
      if (snapshot.pending <= 0n) throw new Error('There is no reserved INCOME to distribute.')
      const recipients = snapshot.splits.map(split => `${formatUnits(splitAmount(snapshot, split.percent), 18)} INCOME (${split.percent / 10_000_000}% of reserves) to ${recipient(split)}`).join('; ')
      const leftover = snapshot.pending - snapshot.splits.reduce((sum, split) => sum + splitAmount(snapshot, split.percent), 0n)
      await tx.send({ ...buildSendIncomeReservedTokensTx(state.chainId, state.projectId), label: `Distribute pending reserved INCOME (currently ${formatUnits(snapshot.pending, 18)})` }, {
        reviewNotice: `${recipients}${leftover > 0n ? `${recipients ? '; ' : ''}${formatUnits(leftover, 18)} INCOME remainder to project owner ${snapshot.owner}` : ''}. This permissionless call spends only gas and distributes all reserves using the recipients active when it executes. The amount or ruleset can change before mining or Safe execution. Distributor funding does not immediately make holder rewards collectible. A failed hook can burn its unconsumed tokens.`,
        reverify: async () => { assertSameIncomeReservedTokens(snapshot, await readIncomeReservedTokens(client, { chainId: state.chainId, projectId: state.projectId })) },
        beforeWrite: () => { setIntent({ snapshot, account: address }) },
      })
    } catch (reason) { setError(message(reason)) } finally { setPreparing(false) }
  }
  const snapshot = query.data
  const busy = preparing || tx.busy || tx.phase === 'review'
  const leftover = snapshot ? snapshot.pending - snapshot.splits.reduce((sum, split) => sum + splitAmount(snapshot, split.percent), 0n) : 0n
  return <section className="rounded-md border border-[#c4cdbb] bg-[#eef1e7] p-5 sm:p-7" aria-label="Distribute reserved INCOME">
    <h3 className="mb-5 text-2xl">Distribute reserved INCOME</h3>
    <p className="text-sm">Payments accrue INCOME for the operator and other reserved recipients. Anyone can distribute these tokens, including funding the configured rewards. You pay only the transaction fee.</p>
    {snapshot && <>
      <p className="mt-4 text-2xl">{formatUnits(snapshot.pending, 18)} INCOME pending</p>
      <dl className="mt-4 grid gap-3 text-sm">
        {snapshot.splits.map((split, index) => <div className="break-words" key={index}><dt>{recipient(split)}</dt><dd>{split.percent / 10_000_000}% of reserves, currently {formatUnits(splitAmount(snapshot, split.percent), 18)} INCOME</dd></div>)}
        {leftover > 0n && <div className="break-words"><dt>Remainder to project owner {snapshot.owner}</dt><dd>{formatUnits(leftover, 18)} INCOME</dd></div>}
      </dl>
      <p className="mt-4 text-sm">Reward funding enters the distributor’s current round. Eligible holders claim and collect rewards separately.</p>
    </>}
    {query.isPending && <p className="mt-4 text-sm" role="status">Reading pending INCOME and its recipients…</p>}
    {query.isError && <p className="mt-4 text-sm" role="alert">{message(query.error)} <button type="button" className="underline" onClick={() => void query.refetch()}>Retry</button></p>}
    <button type="button" className="btn-primary mt-5 min-h-11 px-5" disabled={!address || busy || query.isError || !snapshot || snapshot.pending <= 0n} onClick={() => void submit()}>{preparing ? 'Preparing…' : txPhaseLabel(tx.phase, { idle: 'Review distribution', pending: 'Confirming onchain…' })}</button>
    {error && <p className="mt-4 text-sm text-red-800" role="alert">{error}</p>}
    <div className="mt-4 break-words text-sm" role="status" aria-live="polite">
      {tx.safeProposalHash ? <p>Proposed to Safe. Execution and onchain confirmation are still required.</p> : tx.phase === 'pending' ? <p>Submitted. Waiting for onchain confirmation…</p> : tx.phase === 'success' ? verified.data ? <>
        <p>Distribution confirmed: {formatUnits(verified.data.tokenCount, 18)} INCOME processed.</p>
        {verified.data.hookFailures > 0 && <p role="alert">{verified.data.hookFailures} reward hook calls failed. Unconsumed ERC-20 tokens are burned by the controller; this receipt does not confirm reward delivery.</p>}
        {verified.data.projectFallbacks > 0 && <p role="alert">{verified.data.projectFallbacks} project payments failed and used their configured fallback recipients.</p>}
      </> : verified.isError ? <p role="alert">The transaction was mined, but its distribution could not be verified. {message(verified.error)} <button type="button" className="underline" onClick={() => void verified.refetch()}>Retry verification</button></p> : <p>Transaction mined. Verifying the distribution…</p> : null}
      {tx.error && <p className="text-red-800">{tx.error}</p>}
      {tx.hash && !tx.safeProposalHash && <a className="underline" href={explorerTxUrl(state.chainId, tx.hash) ?? undefined} target="_blank" rel="noreferrer">View transaction</a>}
    </div>
  </section>
}
