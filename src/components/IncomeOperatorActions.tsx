'use client'

import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { isAddress, isAddressEqual, zeroAddress, type Address, type PublicClient } from 'viem'
import { txPhaseLabel, useSafeTx } from '@/hooks/useSafeTx'
import { useWallet } from '@/hooks/useWallet'
import { displayChainName, explorerTxUrl } from '@/lib/chainDisplay'
import { assertSameIncomeOperatorSnapshot, buildIncomeOperatorTx, readIncomeOperatorSnapshot, verifyIncomeOperatorReceipt, type IncomeOperatorSnapshot } from '@/lib/income-operator'
import type { IncomeProjectState } from '@/lib/income-state'

function message(error: unknown) { return error instanceof Error ? error.message : 'The INCOME Operator could not be verified.' }

export function IncomeOperatorActions({ state, client }: { state: IncomeProjectState; client: PublicClient }) {
  const { address } = useWallet()
  const cache = useQueryClient()
  const tx = useSafeTx(state.chainId)
  const [recipient, setRecipient] = useState('')
  const [preparing, setPreparing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [intent, setIntent] = useState<{ snapshot: IncomeOperatorSnapshot; rulesetId: bigint; recipient: Address; account: Address } | null>(null)
  const refreshed = useRef<string | null>(null)
  const query = useQuery({
    queryKey: ['income-operator', state.chainId, state.projectId.toString(), address ?? null],
    queryFn: () => readIncomeOperatorSnapshot(client, { chainId: state.chainId, projectId: state.projectId, account: address }),
    staleTime: 10_000, refetchInterval: 20_000, retry: 1,
  })
  const verified = useQuery({
    queryKey: ['income-operator-receipt', state.chainId, state.projectId.toString(), tx.receipt?.transactionHash, intent?.rulesetId.toString()],
    enabled: tx.phase === 'success' && !tx.safeProposalHash && !!tx.receipt && !!intent,
    queryFn: () => verifyIncomeOperatorReceipt(client, intent!.snapshot, intent!.rulesetId, intent!.recipient, intent!.account, tx.receipt!),
    retry: 1, staleTime: Infinity,
  })
  useEffect(() => {
    if (tx.phase !== 'success' || !tx.receipt || tx.safeProposalHash || refreshed.current === tx.receipt.transactionHash) return
    refreshed.current = tx.receipt.transactionHash
    for (const prefix of ['income-operator', 'income-project', 'income-reserved', 'income-sticky-binding', 'income-pay', 'income-cash-out', 'income-borrow']) void cache.invalidateQueries({ queryKey: [prefix, state.chainId, state.projectId.toString()] })
    for (const prefix of ['sticky-project', 'sticky-rewards']) void cache.invalidateQueries({ queryKey: [prefix, state.chainId] })
  }, [cache, state.chainId, state.projectId, tx.phase, tx.receipt, tx.safeProposalHash])

  const snapshot = query.data
  const validRecipient = isAddress(recipient.trim()) && !isAddressEqual(recipient.trim() as Address, zeroAddress)
  const configured = snapshot?.stages.filter(stage => stage.operatorIndex !== null) ?? []
  const remaining = configured.filter(stage => !validRecipient || !isAddressEqual(stage.splits[stage.operatorIndex!].beneficiary, recipient.trim() as Address))
  const nextStage = remaining[0]
  const locked = nextStage && snapshot ? BigInt(nextStage.splits[nextStage.operatorIndex!].lockedUntil) > snapshot.blockTimestamp : false
  const accountMatches = !!address && !!snapshot?.account && isAddressEqual(address, snapshot.account)
  const verifyingReceipt = tx.phase === 'success' && !!intent && !verified.data
  const busy = preparing || tx.busy || tx.phase === 'review' || verifyingReceipt

  async function submit() {
    if (!address || !nextStage || busy) return
    setPreparing(true); setError(null)
    try {
      const fresh = await readIncomeOperatorSnapshot(client, { chainId: state.chainId, projectId: state.projectId, account: address })
      if (!isAddressEqual(fresh.controller, state.controller) || !isAddressEqual(fresh.owner, state.owner)) throw new Error('The INCOME project contracts changed. Refresh before changing the Operator.')
      if (tx.receipt && fresh.blockNumber < tx.receipt.blockNumber) throw new Error('The RPC has not caught up with your confirmed change. Wait a moment and try again.')
      const request = buildIncomeOperatorTx(fresh, nextStage.rulesetId, recipient.trim())
      const stage = fresh.stages.find(item => item.rulesetId === nextStage.rulesetId)!
      const previous = stage.splits[stage.operatorIndex!].beneficiary
      const target = request.args[2][0].splits[stage.operatorIndex!].beneficiary
      const otherStages = fresh.stages.filter(item => item.rulesetId !== stage.rulesetId && item.operatorIndex !== null && !isAddressEqual(item.splits[item.operatorIndex].beneficiary, target)).length
      await tx.send({ ...request, label: `Change ${stage.isCurrent ? 'current' : 'upcoming'} INCOME stage Operator` }, {
        reviewNotice: `On ${displayChainName(state.chainId)}, stage ${stage.rulesetId} will pay its Operator INCOME split to ${target} instead of ${previous}. Split percentages and all other recipients stay as currently configured. Owner authority stays with the current Owner. ${stage.isCurrent ? 'This also changes where pending reserved INCOME is distributed after execution.' : `This stage starts ${new Date(Number(stage.start) * 1_000).toLocaleString()}.`} ${otherStages ? `${otherStages} other stage${otherStages === 1 ? '' : 's'} still require${otherStages === 1 ? 's' : ''} a separate reviewed transaction to use the same Operator.` : 'This is the last remaining stage for this Operator on this chain.'}`,
        reverify: async () => {
          const latest = await readIncomeOperatorSnapshot(client, { chainId: state.chainId, projectId: state.projectId, account: address })
          assertSameIncomeOperatorSnapshot(fresh, latest)
          buildIncomeOperatorTx(latest, stage.rulesetId, target)
        },
        beforeWrite: () => { setIntent({ snapshot: fresh, rulesetId: stage.rulesetId, recipient: target, account: address }) },
      })
    } catch (reason) { setError(message(reason)) } finally { setPreparing(false) }
  }

  return <section className="rounded-md border border-[#c4cdbb] bg-[#eef1e7] p-5 sm:p-7" aria-label="Change INCOME Operator">
    <h3 className="mb-5 text-2xl">Change INCOME Operator</h3>
    <p className="text-sm">The Owner can change the wallet receiving the Operator’s INCOME split. Update each current and upcoming stage on {displayChainName(state.chainId)}. Each stage requires its own transaction.</p>
    {snapshot && <dl className="mt-4 grid gap-3 text-sm">{snapshot.stages.map(stage => <div key={stage.rulesetId.toString()} className="break-words"><dt>{stage.isCurrent ? 'Current' : 'Upcoming'} stage {stage.rulesetId.toString()}</dt><dd>{stage.operatorIndex === null ? 'No Operator token split configured' : <>{stage.splits[stage.operatorIndex].beneficiary}{validRecipient && isAddressEqual(stage.splits[stage.operatorIndex].beneficiary, recipient.trim() as Address) ? ' — pays the selected Operator' : ''}</>}</dd></div>)}</dl>}
    {query.isPending && <p className="mt-4 text-sm" role="status">Reading the current Owner permissions and INCOME recipients…</p>}
    {query.isError && <p className="mt-4 text-sm" role="alert">{message(query.error)} <button type="button" className="underline" onClick={() => void query.refetch()}>Retry</button></p>}
    {snapshot && (!snapshot.isOwner || !accountMatches) && <p className="mt-4 text-sm">Connect the current Owner wallet to change the INCOME Operator. Receiving the Operator split does not grant Owner authority.</p>}
    <label className="mt-5 grid gap-2 text-sm">New Operator wallet<input className="min-h-12 w-full rounded border border-[#bfc9b5] bg-white px-3 text-base" value={recipient} onChange={event => setRecipient(event.target.value)} autoComplete="off" spellCheck={false} disabled={busy} placeholder="0x…" /></label>
    {recipient.trim() && !validRecipient && <p className="mt-2 text-sm text-red-800">Enter a valid, nonzero wallet address.</p>}
    {locked && <p className="mt-4 text-sm" role="alert">This existing Operator split is locked onchain. It cannot be changed before its lock expires. New INCOME launches use unlocked splits.</p>}
    {validRecipient && configured.length > 0 && remaining.length === 0 && !query.isError && <p className="mt-4 text-sm" role="status">All current and upcoming Operator splits on {displayChainName(state.chainId)} pay this wallet.</p>}
    {validRecipient && remaining.length > 1 && <p className="mt-4 text-sm">{remaining.length} stages still need updating. Confirm each stage to keep this Operator when the next stage begins.</p>}
    <button type="button" className="btn-primary mt-5 min-h-11 px-5" disabled={!address || !snapshot?.isOwner || !accountMatches || !validRecipient || !nextStage || locked || busy || query.isError} onClick={() => void submit()}>{preparing ? 'Preparing…' : txPhaseLabel(tx.phase, { idle: `Review ${nextStage?.isCurrent ? 'current' : 'upcoming'} stage change`, pending: 'Confirming onchain…' })}</button>
    {error && <p className="mt-4 text-sm text-red-800" role="alert">{error}</p>}
    <div className="mt-4 break-words text-sm" role="status" aria-live="polite">
      {tx.safeProposalHash ? <p>Proposed to Safe. The Operator has not changed yet; execution and onchain confirmation are still required.</p> : tx.phase === 'pending' ? <p>Submitted. Waiting for onchain confirmation…</p> : tx.phase === 'success' ? verified.data ? <p>Operator change confirmed for stage {verified.data.rulesetId.toString()}. Check the remaining stages above.</p> : verified.isError ? <p role="alert">The transaction was mined, but the Operator change could not be verified. {message(verified.error)} <button type="button" className="underline" onClick={() => void verified.refetch()}>Retry verification</button></p> : <p>Transaction mined. Verifying the Operator change…</p> : null}
      {tx.error && <p className="text-red-800">{tx.error}</p>}
      {tx.hash && !tx.safeProposalHash && <a className="underline" href={explorerTxUrl(state.chainId, tx.hash) ?? undefined} target="_blank" rel="noreferrer">View transaction</a>}
    </div>
  </section>
}
