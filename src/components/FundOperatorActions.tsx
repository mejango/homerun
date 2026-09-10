'use client'

import { NATIVE_TOKEN, jbControllerAbi, jbTokensAbi, type JBChainId } from '@bananapus/nana-sdk-core'
import { v6Address } from '@bananapus/nana-sdk-core/v6'
import { getAccount, getPublicClient } from '@wagmi/core'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { decodeEventLog, decodeFunctionData, encodeFunctionData, erc20Abi, formatUnits, getAddress, isAddress, isAddressEqual, parseAbi, zeroAddress, type Address, type Hex, type PublicClient, type TransactionReceipt } from 'viem'
import { useSafeTx, txPhaseLabel } from '@/hooks/useSafeTx'
import { FundAssetWithdrawals, type FundAssetAllowanceConfiguration } from '@/components/FundAssetWithdrawals'
import { useWallet } from '@/hooks/useWallet'
import { displayChainName, explorerTxUrl } from '@/lib/chainDisplay'
import {
  FUND_WEIGHT, buildFundApproval, buildFundAssetAllowanceChange, buildFundMint, buildFundReturn, buildFundRulesetChange,
  offchainFundAmount, operatorMintAmount, parseAmount, parsePercent,
  type FundAssetAllowance, type FundRulesetAction, type FundRulesetSnapshot, type FundTransaction,
} from '@/lib/fund-contracts'
import { assertFundStateForWrite, readFundProjectState, readLinkedFundProjects, type FundProjectState } from '@/lib/fund-state'
import { waitForSafeExecutionHash } from '@/lib/safe-connector'
import { wagmiConfig } from '@/providers/Providers'

type Props = { state: FundProjectState; client: PublicClient; contextIndex: number }
type Tx = ReturnType<typeof useSafeTx>

function message(error: unknown): string {
  return error instanceof Error ? error.message : 'The transaction could not be prepared. Refresh the verified project state and try again.'
}

function amountOrZero(value: string, decimals: number): bigint {
  try { return parseAmount(value, decimals) } catch { return 0n }
}

function destination(value: string): Address | null {
  return isAddress(value) && !isAddressEqual(value, zeroAddress) ? getAddress(value) : null
}

function encoded(value: unknown): string {
  return JSON.stringify(value, (_, item) => typeof item === 'bigint' ? item.toString() : item)
}

function sameRequest(expected: FundTransaction, actual: FundTransaction): boolean {
  return expected.chainId === actual.chainId && isAddressEqual(expected.address, actual.address)
    && expected.functionName === actual.functionName && encoded(expected.args) === encoded(actual.args)
    && (expected.value ?? 0n) === (actual.value ?? 0n)
}

function snapshotTerms(snapshot: FundRulesetSnapshot): string {
  const { blockNumber: _block, ...terms } = snapshot
  return encoded(terms)
}

function chainClient(chainId: JBChainId): PublicClient {
  const client = getPublicClient(wagmiConfig, { chainId })
  if (!client) throw new Error(`A verified RPC for ${displayChainName(chainId)} is unavailable.`)
  return client as PublicClient
}

type PlanAction = FundRulesetAction | 'configure-asset-allowance'
const RULESET_LABELS: Record<PlanAction, string> = {
  pause: 'Pause FUND contributions; preserve current cash-out terms',
  resume: 'Resume FUND contributions under the current fundraising rules',
  close: 'Close fundraising: pause contributions and disable FUND cash-outs',
  'enable-success-minting': 'Enable operator-controlled FUND minting after the confirmed asset purchase',
  'finish-success-minting': 'Disable owner minting; keep contributions and cash-outs closed',
  'failure-refunds': 'Open failure refunds: zero cash-out tax and remove every treasury withdrawal limit',
  'asset-sale-refunds': 'Open asset-sale cash-outs: zero cash-out tax and remove every treasury withdrawal limit',
  'configure-asset-allowance': 'Set the explicitly reviewed asset-purchase withdrawal allowance',
}

function rulesetNotice(action: PlanAction): string | undefined {
  return action === 'enable-success-minting'
    ? 'You attest that the asset purchase succeeded. The Juicebox contracts do not verify the purchase or enforce a maximum owner mint. Disable owner minting when all reviewed allocations are complete.'
    : action === 'configure-asset-allowance' ? 'This is a new contract withdrawal budget on the explicitly selected chain. It is not taken from the modeling inputs. A new ruleset resets allowance usage; confirm that previously spent amounts and this new budget are reconciled. An amount of zero removes the selected allowance.'
      : action === 'failure-refunds' || action === 'asset-sale-refunds'
      ? 'This changes the contract cash-out terms. It does not recover money held outside the treasury. Holders can claim only the funds actually available onchain.' : undefined
}

type PlanProject = Pick<FundProjectState, 'chainId' | 'projectId' | 'owner' | 'rulesetSnapshot'>
export type RulesetPlan = {
  states: PlanProject[]
  requests: FundTransaction[]
  action: PlanAction
  startsAt: number
  account: Address
  allowances?: readonly FundAssetAllowance[]
}

function rebuildPlan(plan: Pick<RulesetPlan, 'states' | 'action' | 'startsAt' | 'allowances'>) {
  const snapshots = plan.states.map(project => project.rulesetSnapshot)
  if (plan.action === 'configure-asset-allowance') {
    if (!Array.isArray(plan.allowances) || plan.allowances.length === 0 || plan.allowances.length > plan.states.length) throw new Error('A purchase-allowance plan requires bounded explicit chain selections.')
    return buildFundAssetAllowanceChange({ snapshots, mustStartAtOrAfter: plan.startsAt, allowances: plan.allowances })
  }
  if (plan.allowances !== undefined) throw new Error('Unexpected withdrawal allowance in a lifecycle plan.')
  return buildFundRulesetChange({ snapshots, action: plan.action, mustStartAtOrAfter: plan.startsAt })
}

export type RulesetSubmission = { hash: Hex; kind: 'transaction' | 'safe-proposal' } | { kind: 'submission-unknown' }
type RecoveryRoot = { chainId: number; projectId: bigint }
const MAX_RECOVERY_BYTES = 262_144
const safeExecutionAbi = parseAbi(['function execTransaction(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,bytes signatures) returns (bool success)'])

/** Store intent and hashes only. The browser never certifies execution. */
export function serializeRulesetRecovery(plan: RulesetPlan, submissions: ReadonlyMap<number, RulesetSubmission>, root: RecoveryRoot): string {
  const raw = JSON.stringify({
    version: 1, root,
    plan: { states: plan.states.map(({ chainId, projectId, owner, rulesetSnapshot }) => ({ chainId, projectId, owner, rulesetSnapshot })), action: plan.action, startsAt: plan.startsAt, account: plan.account, ...(plan.allowances ? { allowances: plan.allowances } : {}) },
    submissions: [...submissions],
  }, (_, value) => typeof value === 'bigint' ? { $bigint: value.toString() } : value)
  if (raw.length > MAX_RECOVERY_BYTES) throw new Error('The recovery plan exceeds the permitted size.')
  return raw
}

export function deserializeRulesetRecovery(raw: string, root: RecoveryRoot, account: Address): { plan: RulesetPlan; submissions: Map<number, RulesetSubmission> } {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_RECOVERY_BYTES) throw new Error('The recovery file has an invalid size.')
  const data = JSON.parse(raw, (key, value) => {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') throw new Error('Unsupported recovery field.')
    if (value && typeof value === 'object' && '$bigint' in value) {
      if (Object.keys(value).length !== 1 || typeof value.$bigint !== 'string' || !/^(0|[1-9]\d{0,77})$/.test(value.$bigint)) throw new Error('Invalid recovery integer.')
      return BigInt(value.$bigint)
    }
    return value
  }) as { version?: unknown; root?: RecoveryRoot; plan?: Partial<RulesetPlan>; submissions?: unknown }
  if (data.version !== 1 || data.root?.chainId !== root.chainId || data.root?.projectId !== root.projectId) throw new Error('This recovery plan belongs to a different project.')
  const saved = data.plan
  if (!saved || !saved.account || !isAddress(saved.account) || !isAddressEqual(saved.account, account)) throw new Error('Connect the wallet that prepared this recovery plan.')
  if (!saved.action || !Object.hasOwn(RULESET_LABELS, saved.action) || !Number.isSafeInteger(saved.startsAt) || saved.startsAt! <= 0) throw new Error('Invalid recovery action or activation time.')
  if (!Array.isArray(saved.states) || saved.states.length < 2 || saved.states.length > 8) throw new Error('A linked recovery plan requires two to eight verified projects.')
  const states: PlanProject[] = saved.states.map(candidate => {
    if (!candidate || typeof candidate.projectId !== 'bigint' || candidate.projectId <= 0n || !Number.isSafeInteger(candidate.chainId) || !isAddress(candidate.owner) || isAddressEqual(candidate.owner, zeroAddress)) throw new Error('Invalid project in the recovery plan.')
    const snapshot = candidate.rulesetSnapshot
    if (!snapshot || snapshot.chainId !== candidate.chainId || snapshot.projectId !== candidate.projectId) throw new Error('The recovery snapshot does not match its project.')
    return { chainId: candidate.chainId, projectId: candidate.projectId, owner: getAddress(candidate.owner), rulesetSnapshot: snapshot }
  })
  if (!states.some(project => project.chainId === root.chainId && project.projectId === root.projectId)) throw new Error('This project is absent from the recovery plan.')
  // This validates all metadata, supported chains, complete peer membership,
  // hooks and original snapshots. Serialized targets/calldata are never used.
  const built = rebuildPlan({ states, action: saved.action, startsAt: saved.startsAt!, allowances: saved.allowances })
  if (!Array.isArray(data.submissions) || data.submissions.length > states.length) throw new Error('Invalid recovery transaction list.')
  const submissions = new Map<number, RulesetSubmission>()
  for (const entry of data.submissions) {
    if (!Array.isArray(entry) || entry.length !== 2) throw new Error('Invalid recovery transaction entry.')
    const [chainId, transaction] = entry as [number, RulesetSubmission]
    if (!states.some(project => project.chainId === chainId) || submissions.has(chainId) || !transaction) throw new Error('Invalid or duplicate recovery transaction.')
    if (transaction.kind === 'submission-unknown') {
      if (Object.keys(transaction).length !== 1) throw new Error('Invalid unknown-submission marker.')
      submissions.set(chainId, { kind: 'submission-unknown' })
    } else {
      if ((transaction.kind !== 'transaction' && transaction.kind !== 'safe-proposal') || typeof transaction.hash !== 'string' || !/^0x[\da-fA-F]{64}$/.test(transaction.hash)) throw new Error('Invalid recovery transaction hash.')
      submissions.set(chainId, { hash: transaction.hash, kind: transaction.kind })
    }
  }
  return { plan: { states, requests: built.requests, account: getAddress(saved.account), action: saved.action, startsAt: saved.startsAt!, ...(saved.allowances ? { allowances: saved.allowances } : {}) }, submissions }
}

export function validateRulesetRecoveryReceipt(receipt: TransactionReceipt, projectId: bigint, controller: Address, memo: string): bigint {
  if (receipt.status !== 'success') throw new Error('The recovered transaction reverted onchain. It has not changed the rules.')
  const matching: bigint[] = []
  for (const log of receipt.logs) {
    if (!isAddressEqual(log.address, controller)) continue
    try {
      const event = decodeEventLog({ abi: jbControllerAbi, data: log.data, topics: log.topics })
      if (event.eventName === 'QueueRulesets' && event.args.projectId === projectId && event.args.memo === memo) matching.push(event.args.rulesetId)
    } catch { /* Unrelated log. */ }
  }
  if (matching.length !== 1 || matching[0] <= 0n) throw new Error('The expected unique ruleset event could not be verified. Do not submit another transaction until this execution is reconciled.')
  return matching[0]
}

/** A matching log alone cannot authenticate imported transaction intent. */
export async function verifyRulesetRecoveryExecution(client: PublicClient, request: FundTransaction, account: Address, receipt: TransactionReceipt): Promise<void> {
  const transaction = await client.getTransaction({ hash: receipt.transactionHash })
  const block = await client.getBlock({ blockNumber: receipt.blockNumber })
  if (transaction.blockHash !== receipt.blockHash || block.hash !== receipt.blockHash) throw new Error('The transaction changed during recovery. Refresh its canonical receipt.')
  const expectedData = encodeFunctionData({ abi: request.abi, functionName: request.functionName, args: request.args })
  const expectedValue = request.value ?? 0n
  if (transaction.to && isAddressEqual(transaction.to, request.address) && isAddressEqual(transaction.from, account) && transaction.value === expectedValue && transaction.input.toLowerCase() === expectedData.toLowerCase()) return
  if (transaction.to && isAddressEqual(transaction.to, account)) {
    try {
      const decoded = decodeFunctionData({ abi: safeExecutionAbi, data: transaction.input })
      const [to, value, data, operation] = decoded.args
      if (operation === 0 && isAddressEqual(to, request.address) && value === expectedValue && data.toLowerCase() === expectedData.toLowerCase()) return
    } catch { /* Unsupported execution wrapper must be reconciled explicitly. */ }
  }
  throw new Error('The recovered transaction does not execute this exact reviewed call. No remaining transaction will be offered until the plan is reconciled.')
}

function RecoveryPanel({ plan, submissions, onSubmitted, onRemoveSubmission, onResume }: {
  plan: RulesetPlan; submissions: ReadonlyMap<number, RulesetSubmission>
  onSubmitted: (chainId: number, submission: RulesetSubmission) => void
  onRemoveSubmission: (chainId: number) => void
  onResume: (completed: Map<number, { rulesetId: bigint; receipt: TransactionReceipt }>) => void
}) {
  const [checking, setChecking] = useState(false)
  const [notice, setNotice] = useState('Saved intent found. The transactions and every linked project must be verified again before continuing.')
  const [error, setError] = useState<string | null>(null)
  const [manualChain, setManualChain] = useState(plan.states[0].chainId)
  const [manualHash, setManualHash] = useState('')
  const [reverted, setReverted] = useState<{ chainId: number; hash: Hex } | null>(null)
  const abort = useRef<AbortController | null>(null)
  useEffect(() => () => abort.current?.abort(), [])

  async function execution(chainId: number, submission: RulesetSubmission, signal: AbortSignal) {
    if (submission.kind === 'submission-unknown') throw new Error(`A wallet submission may have started on ${displayChainName(chainId)}, but no hash was recorded. Inspect the wallet or Safe and add its execution hash below; this uncertainty cannot authorize a duplicate.`)
    const index = plan.states.findIndex(project => project.chainId === chainId)
    if (index < 0) throw new Error('This transaction is not part of the linked plan.')
    const project = plan.states[index]
    const client = chainClient(project.chainId)
    let hash = submission.hash
    if (submission.kind === 'safe-proposal') {
      setNotice(`Waiting for the Safe proposal on ${displayChainName(chainId)} to execute. An unexecuted proposal is not a confirmed ruleset change.`)
      hash = await waitForSafeExecutionHash(chainId, hash, { signal })
    }
    const receipt = await client.getTransactionReceipt({ hash })
    if (signal.aborted) throw new DOMException('Recovery checks paused.', 'AbortError')
    if (receipt.status === 'reverted' && submission.kind === 'transaction') {
      await verifyRulesetRecoveryExecution(client, plan.requests[index], plan.account, receipt)
      setReverted({ chainId, hash })
    }
    const rulesetId = validateRulesetRecoveryReceipt(receipt, project.projectId, project.rulesetSnapshot.controller, `Homerun: ${plan.action}`)
    await verifyRulesetRecoveryExecution(client, plan.requests[index], plan.account, receipt)
    return { rulesetId, receipt }
  }

  async function recover() {
    if (checking) return
    const controller = new AbortController(); abort.current = controller
    setChecking(true); setError(null); setNotice('Checking the saved transaction hashes against chain receipts…')
    try {
      const completed = new Map<number, { rulesetId: bigint; receipt: TransactionReceipt }>()
      for (const [chainId, submission] of submissions) {
        const result = await execution(chainId, submission, controller.signal)
        completed.set(chainId, result)
        if (submission.kind === 'safe-proposal') onSubmitted(chainId, { kind: 'transaction', hash: result.receipt.transactionHash })
      }
      const seed = plan.states[0]
      const current = await readLinkedFundProjects(chainClient, await readFundProjectState(chainClient(seed.chainId), { chainId: seed.chainId, projectId: seed.projectId, account: plan.account }))
      if (controller.signal.aborted) throw new DOMException('Recovery checks paused.', 'AbortError')
      if (current.length !== plan.states.length) throw new Error('Linked membership changed. Reconcile every project before continuing this plan.')
      for (const original of plan.states) {
        const latest = current.find(project => project.chainId === original.chainId && project.projectId === original.projectId)
        if (!latest) throw new Error('A saved project is absent from the current linked membership.')
        assertFundStateForWrite(latest, plan.account)
        if (!isAddressEqual(latest.owner, original.owner)) throw new Error('The project owner changed during this plan. Review its current authority before continuing.')
        const confirmed = completed.get(original.chainId)
        if (confirmed && latest.blockNumber < confirmed.receipt.blockNumber) throw new Error('A linked RPC has not caught up with its confirmed transaction. Wait and verify again.')
        const expected = { ...original.rulesetSnapshot, ...(confirmed ? { upcomingRulesetId: confirmed.rulesetId } : {}) }
        const alreadyActivated = confirmed && BigInt(latest.ruleset.id) === confirmed.rulesetId && latest.blockTimestamp >= BigInt(plan.startsAt)
        if (!alreadyActivated && snapshotTerms(expected) !== snapshotTerms(latest.rulesetSnapshot)) throw new Error(`The rules on ${displayChainName(original.chainId)} do not match the saved plan. If a submitted transaction hash is missing, add it below; do not submit a duplicate.`)
      }
      if (completed.size < plan.states.length && (Date.now() / 1000 >= plan.startsAt - 60 || current.some(project => project.blockTimestamp >= BigInt(plan.startsAt - 60)))) throw new Error('Some chains confirmed, but the shared activation deadline has passed. The remaining calls cannot be sent late. Export this plan and reconcile the active and queued rules on every chain before scheduling a replacement.')
      onResume(completed)
    } catch (reason) {
      if (!(reason instanceof DOMException && reason.name === 'AbortError')) setError(`${message(reason)} No duplicate transaction will be submitted during recovery.`)
    } finally { setChecking(false); abort.current = null }
  }

  async function recordExecution() {
    if (checking || !/^0x[\da-fA-F]{64}$/.test(manualHash)) return
    const controller = new AbortController(); abort.current = controller
    setChecking(true); setError(null)
    try {
      const result = await execution(manualChain, { kind: 'transaction', hash: manualHash as Hex }, controller.signal)
      onSubmitted(manualChain, { kind: 'transaction', hash: result.receipt.transactionHash })
      setManualHash(''); setNotice('The exact execution was verified and its hash saved. Verify every chain to resume the remaining plan.')
    } catch (reason) { setError(message(reason)) } finally { setChecking(false); abort.current = null }
  }

  async function clearReverted() {
    if (!reverted || checking) return
    const saved = submissions.get(reverted.chainId)
    if (saved?.kind !== 'transaction' || saved.hash.toLowerCase() !== reverted.hash.toLowerCase()) return
    setChecking(true); setError(null)
    try {
      const index = plan.states.findIndex(project => project.chainId === reverted.chainId)
      const client = chainClient(plan.states[index].chainId)
      const receipt = await client.getTransactionReceipt({ hash: saved.hash })
      if (receipt.status !== 'reverted') throw new Error('The transaction is not confirmed as reverted. Its recovery lock must remain.')
      await verifyRulesetRecoveryExecution(client, plan.requests[index], plan.account, receipt)
      onRemoveSubmission(reverted.chainId); setReverted(null)
      setNotice('The failed execution was verified and removed from this plan. Verify every chain again before reviewing a retry.')
    } catch (reason) { setError(message(reason)) } finally { setChecking(false) }
  }

  return <div className="mt-5 grid gap-4 rounded border border-[#cbd7db] bg-[#edf2f4] p-4">
    <p role="status" className="text-sm">{notice}</p>
    <div className="flex flex-wrap gap-3"><button type="button" className="btn-primary min-h-11 px-4" disabled={checking} onClick={() => void recover()}>{checking ? 'Verifying saved transactions…' : 'Verify and resume queued plan'}</button>{checking && <button type="button" className="btn-secondary min-h-11 px-4" onClick={() => abort.current?.abort()}>Pause recovery checks</button>}</div>
    {error && <p role="alert" className="text-sm text-red-800">{error}</p>}
    {reverted && submissions.get(reverted.chainId)?.kind === 'transaction' && <button type="button" className="btn-secondary min-h-11 w-fit px-4" disabled={checking} onClick={() => void clearReverted()}>Clear the confirmed reverted attempt</button>}
    <details><summary className="cursor-pointer text-sm">Add a missing execution hash</summary><p className="my-3 text-sm">Use the onchain transaction hash if a Safe executed without automatic tracking or the page closed before a hash was saved. Its exact call and receipt are verified before it can count as confirmed.</p><label className="grid gap-2 text-sm">Network<select className="min-h-12 rounded border border-[#bfc9b5] bg-white px-3 pr-9" value={manualChain} disabled={checking} onChange={event => setManualChain(Number(event.target.value) as JBChainId)}>{plan.states.map(project => <option key={project.chainId} value={project.chainId}>{displayChainName(project.chainId)}</option>)}</select></label><div className="mt-3"><Field label="Onchain transaction hash" value={manualHash} onChange={setManualHash} disabled={checking} decimal={false} /></div><button type="button" className="btn-secondary mt-3 min-h-11 px-4" disabled={checking || !/^0x[\da-fA-F]{64}$/.test(manualHash)} onClick={() => void recordExecution()}>Verify execution hash</button></details>
  </div>
}

/** A chain-specific hook instance prevents a wallet switch from watching the wrong chain. */
function LinkedRulesetStep({ plan, index, completed, onConfirmed, onCancel, onSubmitted, onBeforeWrite, onWriteRejected, submission }: {
  plan: RulesetPlan; index: number; completed: ReadonlyMap<number, { rulesetId: bigint; receipt: TransactionReceipt }>
  onConfirmed: (chainId: number, rulesetId: bigint, receipt: TransactionReceipt) => void
  onCancel: () => void
  onSubmitted: (chainId: number, submission: RulesetSubmission) => void
  onBeforeWrite: (chainId: number) => void
  onWriteRejected: (chainId: number) => void
  submission?: RulesetSubmission
}) {
  const state = plan.states[index]
  const request = plan.requests[index]
  const tx = useSafeTx(state.chainId)
  useConfirmedRefresh(tx, state)
  const [preparing, setPreparing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const delivered = useRef(false)
  const recordedHash = useRef<string | null>(null)
  const busy = preparing || tx.busy || tx.phase === 'review'

  useEffect(() => {
    if (delivered.current || tx.phase !== 'success' || !tx.receipt || tx.receipt.status !== 'success') return
    try {
      const rulesetId = validateRulesetRecoveryReceipt(tx.receipt, state.projectId, state.rulesetSnapshot.controller, `Homerun: ${plan.action}`)
      delivered.current = true
      onConfirmed(state.chainId, rulesetId, tx.receipt)
    } catch (reason) { setError(message(reason)) }
  }, [onConfirmed, plan.action, state.chainId, state.rulesetSnapshot.controller, state.projectId, tx.phase, tx.receipt])

  useEffect(() => {
    if (!tx.hash) return
    const kind = tx.safeProposalHash ? 'safe-proposal' : 'transaction'
    const key = `${kind}:${tx.hash}`
    if (recordedHash.current === key) return
    recordedHash.current = key
    onSubmitted(state.chainId, { kind, hash: tx.hash })
  }, [onSubmitted, state.chainId, tx.hash, tx.safeProposalHash])

  async function reverify() {
    const connected = getAccount(wagmiConfig).address
    if (!connected || !isAddressEqual(connected, plan.account)) throw new Error('Reconnect the wallet that prepared this linked plan before continuing.')
    if (Date.now() / 1000 >= plan.startsAt - 60) throw new Error('The shared ruleset start is too close or has passed. Do not send a late update; review every linked chain’s scheduled rules before preparing a replacement.')
    const seed = await readFundProjectState(chainClient(state.chainId), { chainId: state.chainId, projectId: state.projectId, account: plan.account })
    const current = await readLinkedFundProjects(chainClient, seed)
    if (current.length !== plan.states.length) throw new Error('The linked project membership changed. Stop and review every chain.')
    for (const original of plan.states) {
      const latest = current.find(item => item.chainId === original.chainId && item.projectId === original.projectId)
      if (!latest) throw new Error('A linked project changed. Stop and review every chain.')
      assertFundStateForWrite(latest, plan.account)
      if (!latest.permissions.queueRulesets || !isAddressEqual(latest.owner, original.owner)) throw new Error('Ruleset permissions changed on a linked chain. Stop and review every chain.')
      const confirmed = completed.get(original.chainId)
      const expected = { ...original.rulesetSnapshot, ...(confirmed ? { upcomingRulesetId: confirmed.rulesetId } : {}) }
      if (confirmed && latest.blockNumber < confirmed.receipt.blockNumber) throw new Error('A linked RPC has not caught up with the confirmed ruleset transaction. Wait and try again.')
      if (snapshotTerms(expected) !== snapshotTerms(latest.rulesetSnapshot)) throw new Error(`The rules on ${displayChainName(original.chainId)} changed since this plan was reviewed. Stop and review every linked chain.`)
      if (latest.blockTimestamp >= BigInt(plan.startsAt - 60)) throw new Error('The shared ruleset start is too close. Review all linked rules before rescheduling.')
    }
  }

  async function submit() {
    if (busy) return
    if (submission) { setError('A transaction or Safe proposal is already recorded for this chain. Recheck the saved transaction before considering another submission.'); return }
    setError(null); setPreparing(true)
    try {
      await reverify()
      const hash = await tx.send({ ...request, label: `${RULESET_LABELS[plan.action]} on ${displayChainName(state.chainId)}` }, {
        reviewNotice: [`This is transaction ${index + 1} of ${plan.requests.length}. Every chain must confirm before ${new Date(plan.startsAt * 1000).toLocaleString()}. Changes are separate transactions and are not atomic.`, rulesetNotice(plan.action)].filter(Boolean).join('\n\n'),
        reverify,
        beforeWrite: () => onBeforeWrite(state.chainId),
        onWriteRejected: () => onWriteRejected(state.chainId),
      })
      if (hash) onSubmitted(state.chainId, { kind: tx.isSafe ? 'safe-proposal' : 'transaction', hash })
    } catch (reason) { setError(message(reason)) } finally { setPreparing(false) }
  }

  return <div className="mt-4">
    <p className="mb-3 text-sm">Next: {displayChainName(state.chainId)}, project {state.projectId.toString()}.</p>
    <button type="button" className="btn-primary min-h-11 px-4" disabled={busy || !!submission || tx.phase === 'success'} onClick={() => void submit()}>{preparing ? 'Verifying every chain…' : txPhaseLabel(tx.phase, { idle: `Review transaction ${index + 1} of ${plan.requests.length}`, pending: 'Confirming onchain…' })}</button>
    {completed.size === 0 && !busy && !tx.hash && !submission && <button type="button" className="btn-secondary ml-3 min-h-11 px-4" onClick={onCancel}>Cancel plan</button>}
    {error && <p role="alert" className="mt-3 text-sm text-red-800">{error}</p>}
    <Status tx={tx} chainId={state.chainId} />
  </div>
}

function Status({ tx, chainId }: { tx: Tx; chainId: number }) {
  const explorer = tx.hash && !tx.safeProposalHash ? explorerTxUrl(chainId, tx.hash) : null
  return <div role="status" aria-live="polite" className="mt-3 break-words text-sm">
    {tx.safeProposalHash ? <p>Proposed to Safe. The action takes effect only after Safe execution is confirmed onchain.</p>
      : tx.phase === 'success' ? <p>Transaction confirmed onchain. Refreshing the project’s contract state.</p>
        : tx.phase === 'pending' ? <p>Submitted. Waiting for onchain confirmation…</p>
          : tx.phase === 'review' ? <p>Review the exact transaction before continuing.</p> : null}
    {tx.error && <p className="text-red-800">{tx.error}</p>}
    {explorer && <a className="underline" href={explorer} target="_blank" rel="noreferrer">View transaction</a>}
  </div>
}

function Field({ label, value, onChange, disabled, decimal = true }: {
  label: string; value: string; onChange: (value: string) => void; disabled: boolean; decimal?: boolean
}) {
  return <label className="grid gap-2 text-sm">{label}<input className="min-h-12 w-full rounded border border-[#bfc9b5] bg-white px-3 text-base" value={value} onChange={event => onChange(event.target.value)} disabled={disabled} inputMode={decimal ? 'decimal' : 'text'} autoComplete="off" /></label>
}

function useConfirmedRefresh(tx: Tx, state: Pick<FundProjectState, 'chainId' | 'projectId'>) {
  const queryClient = useQueryClient()
  const last = useRef<string | null>(null)
  useEffect(() => {
    if (tx.phase !== 'success' || !tx.receipt || tx.receipt.status !== 'success' || tx.receipt.transactionHash === last.current) return
    last.current = tx.receipt.transactionHash
    for (const key of ['fund-project', 'fund-allowance', 'fund-pay-quote', 'fund-cash-out-quote']) {
      void queryClient.invalidateQueries({ queryKey: [key, state.chainId, state.projectId.toString()] })
    }
  }, [queryClient, state.chainId, state.projectId, tx.phase, tx.receipt])
}

/** No campaign outcome is inferred from browser storage or a submitted hash. */
export function FundOperatorActions({ state, client, contextIndex }: Props) {
  const { address } = useWallet()
  const tx = useSafeTx(state.chainId)
  const approval = useSafeTx(state.chainId)
  useConfirmedRefresh(tx, state)
  useConfirmedRefresh(approval, state)
  const [preparing, setPreparing] = useState(false)
  const [assetBusy, setAssetBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [purchased, setPurchased] = useState(false)
  const [refundAttestation, setRefundAttestation] = useState(false)
  const [refundReason, setRefundReason] = useState<'failure-refunds' | 'asset-sale-refunds'>('failure-refunds')
  const [mintKind, setMintKind] = useState<'offchain-contribution' | 'operator-share'>('offchain-contribution')
  const [recipient, setRecipient] = useState('')
  const [offchainUsd, setOffchainUsd] = useState('')
  const [targetShare, setTargetShare] = useState('20')
  const [linkedOperatorCount, setLinkedOperatorCount] = useState('')
  const [contributionReference, setContributionReference] = useState('')
  const [returnAmount, setReturnAmount] = useState('')
  const [returnReason, setReturnReason] = useState<'refunds' | 'asset-sale'>('refunds')
  const [approvalNeeded, setApprovalNeeded] = useState(false)
  const [approvedIntent, setApprovedIntent] = useState<string | null>(null)
  const [plan, setPlan] = useState<RulesetPlan | null>(null)
  const [completed, setCompleted] = useState<Map<number, { rulesetId: bigint; receipt: TransactionReceipt }>>(new Map())
  const [submissions, setSubmissions] = useState<Map<number, RulesetSubmission>>(new Map())
  const submissionsRef = useRef<Map<number, RulesetSubmission>>(new Map())
  const planRef = useRef<RulesetPlan | null>(null)
  const [recovering, setRecovering] = useState(false)
  const [storageChecked, setStorageChecked] = useState(false)
  const [recoveryLoadError, setRecoveryLoadError] = useState(false)
  const loadedStorageKey = useRef<string | null>(null)
  const [scheduleHours, setScheduleHours] = useState('1')
  const clearedReceipt = useRef<string | null>(null)
  useEffect(() => {
    if (tx.phase !== 'success' || !tx.receipt || tx.receipt.status !== 'success' || tx.receipt.transactionHash === clearedReceipt.current) return
    clearedReceipt.current = tx.receipt.transactionHash
    setOffchainUsd(''); setContributionReference(''); setLinkedOperatorCount(''); setReturnAmount('')
    setPurchased(false); setRefundAttestation(false)
  }, [tx.phase, tx.receipt])
  const baseBusy = !storageChecked || recoveryLoadError || preparing || tx.busy || approval.busy || tx.phase === 'review' || approval.phase === 'review' || !!plan
  const busy = baseBusy || assetBusy
  const linked = state.linkedChainIds.length > 1
  const snapshot = state.rulesetSnapshot
  const complete = !!snapshot.configuration
  const context = state.accountingContexts[contextIndex] ?? state.accountingContexts[0]
  const mintEnabled = state.metadata.pausePay && state.metadata.cashOutTaxRate === 10_000 && state.metadata.allowOwnerMinting
  const closed = state.metadata.pausePay && state.metadata.cashOutTaxRate === 10_000
  const fundraising = state.metadata.cashOutTaxRate === 1_000 && !state.metadata.allowOwnerMinting
  const rulesetUnavailable = !complete ? 'The complete current ruleset, splits, and treasury limits could not be verified. Ruleset changes and mints are unavailable until these reads succeed.'
      : null
  const canQueue = state.permissions.queueRulesets
  const canMint = state.permissions.mintTokens
  const connectedOwner = !!address && isAddressEqual(address, state.owner)
  const ownerBalance = useQuery({
    queryKey: ['fund-operator-balance', state.chainId, state.projectId.toString(), state.owner, state.blockNumber.toString()],
    enabled: mintKind === 'operator-share' && !linked && !connectedOwner,
    queryFn: () => client.readContract({ address: v6Address('JBTokens', state.chainId), abi: jbTokensAbi, functionName: 'totalBalanceOf', args: [state.owner, state.projectId], blockNumber: state.blockNumber }),
    staleTime: Infinity,
    retry: 1,
  })
  const operatorBalance = connectedOwner ? state.creditBalance + state.erc20Balance : ownerBalance.data
  let mintCount = 0n
  try { mintCount = mintKind === 'offchain-contribution' ? offchainFundAmount(offchainUsd) : linked ? parseAmount(linkedOperatorCount, 18) : operatorBalance === undefined ? 0n : operatorMintAmount(state.totalSupply, operatorBalance, parsePercent(targetShare)) } catch { /* Invalid inputs disable the action. */ }
  const mintRecipient = mintKind === 'operator-share' ? state.owner : destination(recipient)
  const returnRaw = context ? amountOrZero(returnAmount, context.decimals) : 0n
  const returnIntent = context && address ? encoded([state.chainId, state.projectId, address, context.terminal, context.token, returnRaw, returnReason]) : null
  const approvalBlock = approval.phase === 'success' && approvedIntent === returnIntent ? approval.receipt?.blockNumber : undefined

  function recoveryKey(account: Address): string {
    return `homerun:fund-ruleset-recovery:${state.chainId}:${state.projectId}:${account.toLowerCase()}`
  }

  function persistIntent(next: RulesetPlan, records: ReadonlyMap<number, RulesetSubmission>) {
    const raw = serializeRulesetRecovery(next, records, { chainId: state.chainId, projectId: state.projectId })
    const key = recoveryKey(next.account)
    window.localStorage.setItem(key, raw)
    if (window.localStorage.getItem(key) !== raw) throw new Error('Recovery intent could not be saved. Enable browser storage before preparing linked transactions.')
  }

  function activatePlan(next: RulesetPlan, records = new Map<number, RulesetSubmission>(), restore = false) {
    planRef.current = next; submissionsRef.current = records
    setPlan(next); setSubmissions(records); setCompleted(new Map()); setRecovering(restore); setRecoveryLoadError(false)
  }

  useEffect(() => {
    if (!address) { setStorageChecked(true); return }
    if (planRef.current && !isAddressEqual(planRef.current.account, address)) { setStorageChecked(true); return }
    const key = `homerun:fund-ruleset-recovery:${state.chainId}:${state.projectId}:${address.toLowerCase()}`
    if (loadedStorageKey.current === key) return
    loadedStorageKey.current = key
    try {
      const raw = window.localStorage.getItem(key)
      if (raw) {
        const restored = deserializeRulesetRecovery(raw, { chainId: state.chainId, projectId: state.projectId }, address)
        planRef.current = restored.plan; submissionsRef.current = restored.submissions
        setPlan(restored.plan); setSubmissions(restored.submissions); setCompleted(new Map()); setRecovering(true)
      }
    } catch (reason) { setRecoveryLoadError(true); setError(`Saved recovery intent could not be loaded. Import a valid recovery file before preparing another linked plan: ${message(reason)}`) }
    setStorageChecked(true)
  }, [address, state.chainId, state.projectId, plan])

  function recordSubmission(chainId: number, submission: RulesetSubmission) {
    const active = planRef.current
    if (!active) return
    const records = new Map(submissionsRef.current).set(chainId, submission)
    submissionsRef.current = records; setSubmissions(records)
    try { persistIntent(active, records) } catch (reason) { setError(`The transaction was submitted, but browser recovery storage failed. Download the recovery plan now. ${message(reason)}`) }
  }

  function recordBeforeWrite(chainId: number) {
    const active = planRef.current
    if (!active || submissionsRef.current.has(chainId)) throw new Error('This chain already has an unresolved submission. Recheck its saved transaction before continuing.')
    const records = new Map(submissionsRef.current).set(chainId, { kind: 'submission-unknown' } as const)
    // Deliberately throws before the wallet writer if durable storage fails.
    // A page close after this point must never reopen a duplicate submit button.
    persistIntent(active, records)
    submissionsRef.current = records; setSubmissions(records)
  }

  function removeSubmission(chainId: number) {
    const active = planRef.current
    if (!active) return
    const records = new Map(submissionsRef.current); records.delete(chainId)
    try {
      persistIntent(active, records)
      submissionsRef.current = records; setSubmissions(records)
    } catch (reason) { setError(`The recovery lock could not be updated: ${message(reason)}`) }
  }

  function closePlan() {
    const active = planRef.current
    if (!active) return
    try { window.localStorage.removeItem(recoveryKey(active.account)) } catch { /* A stale saved intent is reverified, never assumed executed. */ }
    planRef.current = null; submissionsRef.current = new Map()
    setPlan(null); setSubmissions(new Map()); setCompleted(new Map()); setRecovering(false)
  }

  function downloadRecovery() {
    if (!plan) return
    const blob = new Blob([serializeRulesetRecovery(plan, submissionsRef.current, { chainId: state.chainId, projectId: state.projectId })], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a'); link.href = url; link.download = `homerun-fund-${state.chainId}-${state.projectId}-recovery.json`
    link.click(); URL.revokeObjectURL(url)
  }

  async function importRecovery(file: File | undefined) {
    if (!file || !address || preparing || tx.busy || approval.busy || tx.phase === 'review' || approval.phase === 'review' || plan) return
    setError(null); setPreparing(true)
    try {
      if (file.size > MAX_RECOVERY_BYTES) throw new Error('The recovery file is too large.')
      const restored = deserializeRulesetRecovery(await file.text(), { chainId: state.chainId, projectId: state.projectId }, address)
      persistIntent(restored.plan, restored.submissions)
      activatePlan(restored.plan, restored.submissions, true)
    } catch (reason) { setError(message(reason)) } finally { setPreparing(false) }
  }

  async function fresh(minimumBlock?: bigint): Promise<FundProjectState> {
    if (!address) throw new Error('Connect the verified project owner wallet.')
    const latest = await readFundProjectState(client, { chainId: state.chainId, projectId: state.projectId, account: address })
    if (minimumBlock !== undefined && latest.blockNumber < minimumBlock) throw new Error('The network has not caught up with the confirmed approval. Wait a moment and try again.')
    assertFundStateForWrite(latest, address)
    if (!isAddressEqual(latest.owner, state.owner)) throw new Error('Project ownership changed. Refresh and review the current operator.')
    if (encoded([...latest.linkedChainIds].sort((a, b) => a - b)) !== encoded([...state.linkedChainIds].sort((a, b) => a - b))) throw new Error('The project’s linked chains changed. Refresh and review its complete chain membership before continuing.')
    if (!isAddressEqual(latest.controller, state.controller)) throw new Error('The project controller changed. Refresh and review the project again.')
    return latest
  }

  async function run(task: () => Promise<void>) {
    if (busy) return
    setPreparing(true); setError(null)
    try { await task() } catch (reason) { setError(message(reason)) } finally { setPreparing(false) }
  }

  async function changeRules(action: FundRulesetAction) {
    await run(async () => {
      if (rulesetUnavailable) throw new Error(rulesetUnavailable)
      if (action === 'enable-success-minting' && !purchased) throw new Error('Confirm the asset purchase before enabling success mints.')
      if ((action === 'failure-refunds' || action === 'asset-sale-refunds') && !refundAttestation) throw new Error('Confirm the refund or sale outcome before opening cash-outs.')
      const current = await fresh()
      if (!current.permissions.queueRulesets) throw new Error('This wallet does not have permission to change the project rules.')
      if (current.linkedChainIds.length > 1) {
        if (!address) throw new Error('Connect the operator wallet.')
        const states = await readLinkedFundProjects(chainClient, current)
        for (const peer of states) {
          assertFundStateForWrite(peer, address)
          if (!peer.permissions.queueRulesets) throw new Error(`This wallet cannot change rules on ${displayChainName(peer.chainId)}.`)
        }
        const hours = Number(scheduleHours)
        if (!/^\d+$/.test(scheduleHours) || !Number.isInteger(hours) || hours < 1 || hours > 168) throw new Error('Choose a shared ruleset start between 1 and 168 hours from now.')
        const start = Math.max(Math.ceil(Date.now() / 1000), ...states.map(peer => Number(peer.blockTimestamp))) + hours * 3600
        const built = buildFundRulesetChange({ snapshots: states.map(peer => peer.rulesetSnapshot), action, mustStartAtOrAfter: start })
        const next = { states, requests: built.requests, action, startsAt: start, account: address }
        persistIntent(next, new Map())
        activatePlan(next)
        return
      }
      const request = buildFundRulesetChange({ snapshots: [current.rulesetSnapshot], action, mustStartAtOrAfter: 0 }).requests[0]
      await tx.send({ ...request, label: RULESET_LABELS[action] }, {
        reviewNotice: rulesetNotice(action),
        reverify: async () => {
          const latest = await fresh()
          if (!latest.permissions.queueRulesets) throw new Error('This wallet’s ruleset permission changed. Refresh and review again.')
          const rebuilt = buildFundRulesetChange({ snapshots: [latest.rulesetSnapshot], action, mustStartAtOrAfter: 0 }).requests[0]
          if (snapshotTerms(current.rulesetSnapshot) !== snapshotTerms(latest.rulesetSnapshot) || !sameRequest(request, rebuilt)) throw new Error('Project rules changed during review. Refresh and review the updated action.')
        },
      })
    })
  }

  async function configureAssetAllowance(input: FundAssetAllowanceConfiguration) {
    if (baseBusy) throw new Error('Finish the current transaction before configuring the purchase allowance.')
    setPreparing(true); setError(null)
    try {
      if (!address) throw new Error('Connect the operator wallet.')
      const selected = state.accountingContexts[input.contextIndex]
      if (!selected) throw new Error('Select a verified treasury currency.')
      const current = await fresh()
      const currentContext = current.accountingContexts.find(item => isAddressEqual(item.terminal, selected.terminal) && isAddressEqual(item.token, selected.token))
      if (!currentContext || currentContext.currency !== input.currency || currentContext.decimals !== selected.decimals) throw new Error('The treasury currency changed. Refresh before setting the allowance.')
      const peers = current.linkedChainIds.length > 1 ? await readLinkedFundProjects(chainClient, current) : [current]
      for (const peer of peers) {
        assertFundStateForWrite(peer, address)
        if (!peer.permissions.queueRulesets) throw new Error(`This wallet cannot set rules on ${displayChainName(peer.chainId)}.`)
      }
      const hours = Number(scheduleHours)
      if (peers.length > 1 && (!/^\d+$/.test(scheduleHours) || !Number.isInteger(hours) || hours < 1 || hours > 168)) throw new Error('Choose a shared start between 1 and 168 hours from now.')
      const start = peers.length > 1 ? Math.max(Math.ceil(Date.now() / 1000), ...peers.map(peer => Number(peer.blockTimestamp))) + hours * 3600 : 0
      const allowances = [{ chainId: current.chainId, terminal: currentContext.terminal, token: currentContext.token, currency: input.currency, amount: input.amount }]
      const built = buildFundAssetAllowanceChange({ snapshots: peers.map(peer => peer.rulesetSnapshot), mustStartAtOrAfter: start, allowances })
      if (peers.length > 1) {
        const next: RulesetPlan = { states: peers, action: 'configure-asset-allowance', allowances, startsAt: start, account: address, requests: built.requests }
        persistIntent(next, new Map()); activatePlan(next)
        return
      }
      const request = built.requests[0]
      await tx.send({ ...request, label: input.amount === 0n ? 'Remove the asset-purchase withdrawal allowance' : `Set a new gross purchase allowance of ${formatUnits(input.amount, selected.decimals)} ${selected.symbol}` }, {
        reviewNotice: rulesetNotice('configure-asset-allowance'),
        reverify: async () => {
          const latest = await fresh()
          if (!latest.permissions.queueRulesets) throw new Error('This wallet’s ruleset permission changed.')
          const rebuilt = buildFundAssetAllowanceChange({ snapshots: [latest.rulesetSnapshot], mustStartAtOrAfter: 0, allowances }).requests[0]
          if (snapshotTerms(current.rulesetSnapshot) !== snapshotTerms(latest.rulesetSnapshot) || !sameRequest(request, rebuilt)) throw new Error('The asset-purchase terms changed during review. Prepare a new allowance review.')
        },
      })
    } catch (reason) { setError(message(reason)); throw reason } finally { setPreparing(false) }
  }

  async function mint() {
    await run(async () => {
      if (rulesetUnavailable) throw new Error(rulesetUnavailable)
      if (!purchased || !mintRecipient || !address) throw new Error('Confirm the successful purchase and the mint recipient.')
      if (mintKind === 'offchain-contribution' && !contributionReference.trim()) throw new Error('Add a unique public contribution reference so the mint can be reconciled against prior mints.')
      const current = await fresh()
      if (!current.permissions.mintTokens) throw new Error('This wallet does not have permission to mint FUND.')
      const peers = current.linkedChainIds.length > 1 ? await readLinkedFundProjects(chainClient, current) : [current]
      for (const peer of peers) {
        assertFundStateForWrite(peer, address)
        if (!peer.metadata.pausePay || peer.metadata.cashOutTaxRate !== 10_000 || !peer.metadata.allowOwnerMinting || peer.hasPendingRuleset) throw new Error(`Success minting must be active with no pending ruleset on ${displayChainName(peer.chainId)} before issuing FUND.`)
        if (!isAddressEqual(peer.owner, current.owner)) throw new Error('The linked projects do not have the same operator. Review all project owners before issuing allocations.')
        if (peer.pendingReservedTokens !== 0n) throw new Error('Distribute pending reserved FUND before calculating the operator allocation.')
      }
      if (mintKind === 'offchain-contribution' && current.rulesetSnapshot.configuration?.weight !== FUND_WEIGHT) throw new Error('The project’s issuance rate differs from the initial FUND rate. Review its contribution records and current rules in Juicebox before minting.')
      const currentBalance = await client.readContract({ address: v6Address('JBTokens', state.chainId), abi: jbTokensAbi, functionName: 'totalBalanceOf', args: [current.owner, state.projectId], blockNumber: current.blockNumber })
      const count = mintKind === 'offchain-contribution' ? offchainFundAmount(offchainUsd) : linked ? parseAmount(linkedOperatorCount, 18) : operatorMintAmount(current.totalSupply, currentBalance, parsePercent(targetShare))
      if (count <= 0n) throw new Error('No additional FUND is needed for this allocation.')
      const memo = mintKind === 'offchain-contribution' ? `Homerun: offchain contribution ${contributionReference.trim()}` : 'Homerun: operator share after successful purchase'
      const request = buildFundMint({ snapshot: current.rulesetSnapshot, beneficiary: mintRecipient, tokenCount: count, kind: mintKind, memo })
      await tx.send({ ...request, label: `Mint ${formatUnits(count, 18)} FUND to ${mintRecipient}` }, {
        reviewNotice: mintKind === 'operator-share'
          ? linked ? `Issue exactly ${formatUnits(count, 18)} FUND to the operator on ${displayChainName(state.chainId)}. This amount is entered by the operator after reconciling holdings on all linked chains, including unclaimed bridged FUND. Homerun does not infer a global ownership percentage from incomplete bridge supply.` : `Target ${targetShare}% operator ownership after this mint, including the operator’s current FUND. This is an operator-selected allocation, not a contract-enforced entitlement.`
          : `Record ${offchainUsd} USD contributed outside the contract. No payment enters the treasury in this transaction. Check that reference “${contributionReference.trim()}” has not already been minted; the contract does not deduplicate these references.`,
        reverify: async () => {
          const latest = await fresh()
          if (!latest.permissions.mintTokens) throw new Error('This wallet’s minting permission changed. Refresh and review again.')
          const latestPeers = latest.linkedChainIds.length > 1 ? await readLinkedFundProjects(chainClient, latest) : [latest]
          if (latestPeers.length !== peers.length) throw new Error('The linked FUND membership changed during review.')
          for (const peer of peers) {
            const latestPeer = latestPeers.find(item => item.chainId === peer.chainId && item.projectId === peer.projectId)
            if (!latestPeer || snapshotTerms(peer.rulesetSnapshot) !== snapshotTerms(latestPeer.rulesetSnapshot) || !isAddressEqual(latestPeer.owner, peer.owner)) throw new Error('The minting rules changed on a linked chain during review. Refresh and review again.')
            if (latestPeer.totalSupply !== peer.totalSupply || latestPeer.pendingReservedTokens !== 0n) throw new Error('FUND supply changed during review. Reconcile the allocation before minting.')
          }
          const latestBalance = await client.readContract({ address: v6Address('JBTokens', state.chainId), abi: jbTokensAbi, functionName: 'totalBalanceOf', args: [latest.owner, state.projectId], blockNumber: latest.blockNumber })
          if (latestBalance !== currentBalance) throw new Error('Operator holdings changed during review. Recalculate the allocation before minting.')
          const rebuilt = buildFundMint({ snapshot: latest.rulesetSnapshot, beneficiary: mintRecipient, tokenCount: count, kind: mintKind, memo })
          if (!sameRequest(request, rebuilt)) throw new Error('The mint request changed. Refresh and review again.')
        },
      })
    })
  }

  async function returnFunds() {
    await run(async () => {
      if (!context || !address || returnRaw <= 0n) throw new Error('Enter a positive treasury return amount.')
      const current = await fresh(approvalBlock)
      const native = isAddressEqual(context.token, NATIVE_TOKEN)
      const verifyContext = (latest: FundProjectState) => {
        const verified = latest.accountingContexts.find(item => isAddressEqual(item.token, context.token) && isAddressEqual(item.terminal, context.terminal))
        if (!verified || verified.decimals !== context.decimals) throw new Error('The treasury terminal or currency changed. Refresh and review again.')
        return verified
      }
      verifyContext(current)
      const terminal = { chainId: state.chainId, projectId: state.projectId, terminal: context.terminal, token: context.token }
      if (!native) {
        const available = await client.readContract({ address: context.token, abi: erc20Abi, functionName: 'allowance', args: [address, context.terminal], blockNumber: current.blockNumber })
        if (available < returnRaw) {
          setApprovalNeeded(true)
          const request = buildFundApproval({ ...terminal, amount: returnRaw })
          if (!request) throw new Error('The required token approval could not be built.')
          setApprovedIntent(returnIntent)
          await approval.send({ ...request, label: `Approve exactly ${formatUnits(returnRaw, context.decimals)} ${context.symbol} for the treasury return` }, {
            reverify: async () => { verifyContext(await fresh()) },
          })
          return
        }
      }
      setApprovalNeeded(false)
      const request = buildFundReturn({ ...terminal, amount: returnRaw, reason: returnReason, shouldReturnHeldFees: true })
      await tx.send({ ...request, label: `Return ${formatUnits(returnRaw, context.decimals)} ${context.symbol} to FUND for ${returnReason === 'asset-sale' ? 'the asset sale' : 'refunds'}` }, {
        simulationBlockNumber: approvalBlock,
        reviewNotice: 'This adds money to the project treasury without minting FUND. It does not change cash-out rules. Opening zero-tax refunds or asset-sale cash-outs is a separate reviewed transaction.',
        reverify: async () => {
          const latest = await fresh(approvalBlock)
          verifyContext(latest)
          if (!native) {
            const available = await client.readContract({ address: context.token, abi: erc20Abi, functionName: 'allowance', args: [address, context.terminal], blockNumber: latest.blockNumber })
            if (available < returnRaw) throw new Error('The token approval changed. Confirm a sufficient approval before returning funds.')
          }
        },
      })
    })
  }

  return <div className="grid gap-7">
    <p className="text-sm">Every action is reviewed, simulated, signed, and confirmed separately. The contracts store rules and balances; the operator is responsible for declaring the real-world purchase, failure, or sale.</p>
    {rulesetUnavailable && <p role="status" className="rounded border border-[#cbd7db] bg-[#edf2f4] p-4 text-sm text-[#3f5b66]">{rulesetUnavailable}</p>}
    {linked && <div className="grid gap-3 rounded border border-[#c4cdbb] p-4"><Field label="Shared ruleset start, in hours from now (1–168)" value={scheduleHours} onChange={setScheduleHours} disabled={busy} /><p className="text-sm">Linked ruleset changes require one separately confirmed transaction on every chain before this start time. Allow enough time for every wallet or Safe to execute.</p></div>}
    {!plan && (linked || recoveryLoadError) && <details className="text-sm"><summary className="cursor-pointer">Recover a linked ruleset plan</summary><p className="my-3">Restore a downloaded plan if this browser no longer has its saved intent. Imported hashes and status claims are checked against the blockchain before any remaining transaction can be offered.</p><label className="grid gap-2">Import recovery file<input type="file" accept="application/json,.json" disabled={!address || preparing} onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; void importRecovery(file) }} /></label></details>}
    {plan && <section className="rounded border border-[#c4cdbb] bg-white p-5" aria-label="Linked ruleset transaction plan">
      <h3 className="mb-3 text-xl">Update every linked chain</h3><p className="text-sm">{RULESET_LABELS[plan.action]}. Shared activation: {new Date(plan.startsAt * 1000).toLocaleString()}.</p>
      {(!address || !isAddressEqual(address, plan.account)) && <p role="status" className="mt-3 break-words text-sm">Reconnect {plan.account} to continue this plan. Its pending transaction tracking remains active.</p>}
      <p className="mt-3 text-sm">The intended calls and transaction hashes are saved for recovery. On return, Homerun verifies every execution again. Confirmed updates remain queued if a later transaction is cancelled or delayed.</p>
      <div className="mt-4 flex flex-wrap gap-3"><button type="button" className="btn-secondary min-h-11 px-4" onClick={downloadRecovery}>Download recovery plan</button>{!recovering && submissions.size > completed.size && <button type="button" className="btn-secondary min-h-11 px-4" onClick={() => setRecovering(true)}>Recheck saved transaction</button>}</div>
      <ol className="mt-4 grid gap-2 text-sm">{plan.states.map(peer => {
        const result = completed.get(peer.chainId)
        const explorer = result ? explorerTxUrl(peer.chainId, result.receipt.transactionHash) : null
        const saved = submissions.get(peer.chainId)
        return <li key={peer.chainId}>{displayChainName(peer.chainId)}, project {peer.projectId.toString()}: {result ? 'execution confirmed' : saved ? saved.kind === 'submission-unknown' ? 'submission started; hash not yet recorded' : saved.kind === 'safe-proposal' ? 'Safe proposal recorded; execution not yet verified' : 'transaction recorded; confirmation not yet verified' : 'not yet confirmed'}{explorer && <> / <a className="underline" href={explorer} target="_blank" rel="noreferrer">Transaction</a></>}</li>
      })}</ol>
      {recovering ? <RecoveryPanel plan={plan} submissions={submissions} onSubmitted={recordSubmission} onRemoveSubmission={removeSubmission} onResume={verified => { setCompleted(verified); setRecovering(false) }} />
        : completed.size < plan.states.length ? <LinkedRulesetStep key={`${plan.startsAt}:${completed.size}`} plan={plan} index={plan.states.findIndex(peer => !completed.has(peer.chainId))} submission={submissions.get(plan.states.find(peer => !completed.has(peer.chainId))!.chainId)} completed={completed} onConfirmed={(chainId, rulesetId, receipt) => { recordSubmission(chainId, { kind: 'transaction', hash: receipt.transactionHash }); setCompleted(previous => new Map(previous).set(chainId, { rulesetId, receipt })) }} onCancel={closePlan} onSubmitted={recordSubmission} onBeforeWrite={recordBeforeWrite} onWriteRejected={chainId => { if (submissionsRef.current.get(chainId)?.kind === 'submission-unknown') removeSubmission(chainId) }} />
          : <><p role="status" className="mt-4 text-sm">Every ruleset transaction is confirmed. The new rules take effect at the shared activation time; the project reads show the current active terms.</p><button type="button" className="btn-secondary mt-4 min-h-11 px-4" onClick={closePlan}>Done</button></>}
    </section>}

    <section className="border-t border-[#c4cdbb] pt-5" aria-labelledby="fund-campaign-controls">
      <h3 id="fund-campaign-controls" className="mb-3 text-xl">Campaign controls</h3>
      <p className="mb-4 text-sm">Pausing stops new contributions. Closing also disables FUND cash-outs while the asset purchase is settled.</p>
      <div className="flex flex-wrap gap-3">
        <button type="button" className="btn-secondary min-h-11 px-4" disabled={busy || !canQueue || !!rulesetUnavailable || state.metadata.pausePay} onClick={() => void changeRules('pause')}>Review pause</button>
        <button type="button" className="btn-secondary min-h-11 px-4" disabled={busy || !canQueue || !!rulesetUnavailable || !state.metadata.pausePay || !fundraising} onClick={() => void changeRules('resume')}>Review resume</button>
        <button type="button" className="btn-secondary min-h-11 px-4" disabled={busy || !canQueue || !!rulesetUnavailable || !fundraising} onClick={() => void changeRules('close')}>Review close campaign</button>
      </div>
      {!canQueue && <p className="mt-3 text-sm">This wallet does not have permission to change the project’s rules.</p>}
    </section>

    <FundAssetWithdrawals state={state} client={client} contextIndex={contextIndex} disabled={baseBusy} onConfigureAllowance={configureAssetAllowance} onBusyChange={setAssetBusy} />

    <section className="border-t border-[#c4cdbb] pt-5" aria-labelledby="fund-success-controls">
      <h3 id="fund-success-controls" className="mb-3 text-xl">Successful purchase and FUND allocations</h3>
      <p className="mb-4 text-sm">Close the campaign, enable success minting, record offchain contributions, issue the operator allocation, then disable owner minting. Offchain contributors receive FUND after a successful purchase; failed offchain contributions are refunded outside the treasury.</p>
      <label className="mb-4 flex items-start gap-3 text-sm"><input className="mt-1 size-4 shrink-0" type="checkbox" checked={purchased} onChange={event => setPurchased(event.target.checked)} disabled={busy} />I confirm that the asset purchase succeeded and the contribution records are reconciled.</label>
      <button type="button" className="btn-secondary min-h-11 px-4" disabled={busy || !canQueue || !!rulesetUnavailable || !purchased || !closed || mintEnabled} onClick={() => void changeRules('enable-success-minting')}>Review enabling success mints</button>
      <div className="mt-5 grid gap-4">
        <label className="grid gap-2 text-sm">Allocation<select className="min-h-12 rounded border border-[#bfc9b5] bg-white px-3 pr-9" value={mintKind} disabled={busy} onChange={event => setMintKind(event.target.value as typeof mintKind)}><option value="offchain-contribution">Offchain contribution</option><option value="operator-share">Operator share</option></select></label>
        {mintKind === 'offchain-contribution' ? <><div className="grid gap-4 sm:grid-cols-2"><Field label="Contribution received in USD" value={offchainUsd} onChange={setOffchainUsd} disabled={busy} /><Field label="Contributor wallet" value={recipient} onChange={setRecipient} disabled={busy} decimal={false} /></div><Field label="Unique public contribution reference" value={contributionReference} onChange={setContributionReference} disabled={busy} decimal={false} /><p className="text-sm">Use a receipt reference without personal information. The reference is public onchain.</p></>
          : linked ? <><Field label="Additional operator FUND to mint on this chain" value={linkedOperatorCount} onChange={setLinkedOperatorCount} disabled={busy} /><p className="text-sm">Recipient: {state.owner}. Reconcile all contributor allocations, operator holdings, and unclaimed bridged FUND across every chain before entering this amount. A global ownership percentage cannot be calculated from chain token supplies alone.</p></>
            : <><Field label="Target operator FUND ownership after mint (%)" value={targetShare} onChange={setTargetShare} disabled={busy} /><p className="text-sm">Recipient: {state.owner}. Complete contributor mints first. The calculation includes existing operator holdings and the current FUND supply.</p></>}
        <p className="break-words text-sm">{mintKind === 'operator-share' && !linked && address && !isAddressEqual(address, state.owner) ? 'The additional FUND amount is calculated using the operator’s holdings before review.' : `Additional FUND to mint: ${formatUnits(mintCount, 18)}.`} The exact request is verified with fresh contract reads before review.</p>
        {mintKind === 'operator-share' && !linked && !connectedOwner && ownerBalance.isError && <p role="alert" className="text-sm">The operator’s FUND holdings could not be verified. Refresh before calculating this allocation.</p>}
        {!mintEnabled && <p className="text-sm">Minting becomes available only when the current onchain ruleset has closed cash-outs and enabled owner minting.</p>}
        <div className="flex flex-wrap gap-3"><button type="button" className="btn-primary min-h-11 px-4" disabled={busy || !canMint || !!rulesetUnavailable || !purchased || !mintEnabled || mintCount <= 0n || !mintRecipient || (mintKind === 'offchain-contribution' && !contributionReference.trim())} onClick={() => void mint()}>Review FUND allocation</button><button type="button" className="btn-secondary min-h-11 px-4" disabled={busy || !canQueue || !!rulesetUnavailable || !mintEnabled} onClick={() => void changeRules('finish-success-minting')}>Review disabling owner minting</button></div>
        {!canMint && <p className="text-sm">This wallet does not have permission to mint FUND.</p>}
      </div>
    </section>

    <section className="border-t border-[#c4cdbb] pt-5" aria-labelledby="fund-return-controls">
      <h3 id="fund-return-controls" className="mb-3 text-xl">Return funds to the treasury</h3>
      <p className="mb-4 text-sm">Return money for refunds or deposit net asset-sale proceeds. This uses the terminal’s balance-addition action and mints no new FUND.</p>
      {context ? <div className="grid gap-4"><label className="grid gap-2 text-sm">Reason<select className="min-h-12 rounded border border-[#bfc9b5] bg-white px-3 pr-9" value={returnReason} disabled={busy} onChange={event => { setReturnReason(event.target.value as typeof returnReason); setApprovalNeeded(false) }}><option value="refunds">Campaign refunds</option><option value="asset-sale">Asset-sale proceeds</option></select></label><Field label={`Amount in ${context.symbol}`} value={returnAmount} onChange={value => { setReturnAmount(value); setApprovalNeeded(false) }} disabled={busy} />
        {approvalBlock !== undefined && <p className="text-sm">Token approval confirmed. Review the treasury return to continue.</p>}
        <button type="button" className="btn-primary min-h-11 w-fit px-4" disabled={busy || returnRaw <= 0n} onClick={() => void returnFunds()}>{preparing ? 'Preparing…' : txPhaseLabel(approval.busy ? approval.phase : tx.phase, { idle: approvalNeeded && approvalBlock === undefined ? 'Review token approval' : 'Review treasury return', pending: 'Confirming onchain…' })}</button><p className="text-sm">If token approval is required, it is reviewed and confirmed before the treasury return is offered.</p></div> : <p>No supported treasury currency has been verified.</p>}
    </section>

    <section className="border-t border-[#c4cdbb] pt-5" aria-labelledby="fund-refund-controls">
      <h3 id="fund-refund-controls" className="mb-3 text-xl">Open refunds or asset-sale cash-outs</h3>
      <p className="mb-4 text-sm">After returning the available funds, open pro rata FUND cash-outs with zero cash-out tax. This removes payout limits and surplus allowances and keeps new contributions and owner minting paused.</p>
      <label className="grid gap-2 text-sm">Outcome<select className="min-h-12 rounded border border-[#bfc9b5] bg-white px-3 pr-9" value={refundReason} disabled={busy} onChange={event => { setRefundReason(event.target.value as typeof refundReason); setRefundAttestation(false) }}><option value="failure-refunds">Campaign failed</option><option value="asset-sale-refunds">Asset sold</option></select></label>
      <label className="my-4 flex items-start gap-3 text-sm"><input className="mt-1 size-4 shrink-0" type="checkbox" checked={refundAttestation} disabled={busy} onChange={event => setRefundAttestation(event.target.checked)} />{refundReason === 'failure-refunds' ? 'I confirm that the campaign failed and the available onchain funds have been returned for refunds. Offchain refunds are handled separately.' : 'I confirm that the asset was sold and net sale proceeds are in the treasury for FUND holders.'}</label>
      <button type="button" className="btn-secondary min-h-11 px-4" disabled={busy || !canQueue || !!rulesetUnavailable || !refundAttestation} onClick={() => void changeRules(refundReason)}>{refundReason === 'failure-refunds' ? 'Review opening failure refunds' : 'Review opening asset-sale cash-outs'}</button>
    </section>

    {error && <p role="alert" className="text-sm text-red-800">{error}</p>}
    <Status tx={approval} chainId={state.chainId} /><Status tx={tx} chainId={state.chainId} />
  </div>
}
