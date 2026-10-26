'use client'


import { NATIVE_TOKEN, jbControllerAbi, jbTokensAbi, type JBChainId } from '@bananapus/nana-sdk-core'
import { v6Address } from '@bananapus/nana-sdk-core/v6'
import { getAccount, getPublicClient } from '@wagmi/core'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useEffectEvent, useMemo, useRef, useState } from 'react'
import { HeldWritesNotice, useHeldIntents, useSavedAttempt } from '@bananapus/nana-sdk-core/review/react'
import { decodeEventLog, decodeFunctionData, encodeFunctionData, erc20Abi, formatUnits, getAddress, isAddress, isAddressEqual, zeroAddress, type Address, type Hex, type PublicClient, type TransactionReceipt } from 'viem'
import { useReviewedAction, txPhaseLabel, type TxStep } from '@/hooks/useReviewedAction'
import { FundAssetWithdrawals, type FundAssetAllowanceConfiguration } from '@/components/FundAssetWithdrawals'
import { reviewContext, TxProgress, type TxProgressRow } from '@/components/ui/TxProgress'
import { TxSteps } from '@/components/ui/TxSteps'
import { useWallet } from '@/hooks/useWallet'
import { displayChainName, explorerTxUrl } from '@/lib/chainDisplay'
import {
  FUND_WEIGHT, buildFundApproval, buildFundAssetAllowanceChange, buildFundMint, buildFundReturn, buildFundRulesetChange,
  offchainFundAmount, ownerMintAmount, parseAmount, parsePercent,
  type FundAssetAllowance, type FundRulesetAction, type FundRulesetSnapshot, type FundTransaction,
} from '@/lib/fund-contracts'
import { assertFundStateForWrite, readFundProjectState, readLinkedFundProjects, type FundProjectState } from '@/lib/fund-state'
import { SAFE_EXEC_ABI, safeExecutionResult } from '@bananapus/nana-sdk-core/safe-service'
import { isSafeConnection, waitForSafeExecutionHash } from '@/lib/safe-connector'
import { intent, verifyReviewedWriteReceipt, writeIntentKey, type SavedAttempt, type SavedAttemptScope } from '@bananapus/nana-sdk-core/review'
import { wagmiConfig } from '@/providers/Providers'
import { readableError } from '@/lib/readable-error'
import { HeldNotice, retiringExit } from '@/components/ui/HeldWriteExit'
import { SavedAttemptNotice } from '@/components/ui/SavedAttemptNotice'
import { attempts, callOf, holds } from '@/lib/write-hold'
import type { WriteHoldClient } from '@bananapus/nana-sdk-core/review'

type Props = { state: FundProjectState; client: PublicClient; contextIndex: number }
type Tx = ReturnType<typeof useReviewedAction>

function message(error: unknown): string {
  return readableError(error, 'The transaction could not be prepared. Refresh the verified project state and try again.')
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
  'enable-success-minting': 'Enable owner-controlled FUND minting after the confirmed asset purchase',
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
  /** Empty when a saved plan can no longer be built (`unbuildable` says why): it recovers, but sends nothing. */
  requests: FundTransaction[]
  unbuildable?: string
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

/** A ruleset change is held by its project and the owner's chosen action, on one chain or each linked one. */
function rulesetIntent(projectId: bigint, action: FundRulesetAction): string {
  return writeIntentKey('fund-ruleset', { project: projectId, action })
}
/**
 * A purchase allowance is held by its project, terminal and token alone: no entered terms, so its
 * hold is found on load whatever can be configured now. A second edit waits while one is unresolved.
 */
export function allowanceIntent(projectId: bigint, allowance: Pick<FundAssetAllowance, 'terminal' | 'token'>): string {
  return writeIntentKey('fund-allowance', { project: projectId, terminal: intent.address(allowance.terminal), token: intent.address(allowance.token) })
}
function planIntent(plan: RulesetPlan, projectId: bigint): string {
  const allowance = plan.allowances?.[0]
  return allowance ? allowanceIntent(projectId, allowance) : rulesetIntent(projectId, plan.action as FundRulesetAction)
}

export type RulesetSubmission = ({ hash: Hex; kind: 'transaction' | 'safe-proposal' } | { kind: 'submission-unknown' }) & { attemptId?: string }
type RulesetCompletion = { rulesetId: bigint; receipt: TransactionReceipt; submission: RulesetSubmission }
type RecoveryRoot = { chainId: number; projectId: bigint }
const MAX_RECOVERY_BYTES = 262_144

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

/**
 * A saved plan, validated. `saved`: this browser's own journal, which loads even when its requests
 * can no longer be built (its writes recover first, and it sends nothing); an imported file must build.
 */
export function deserializeRulesetRecovery(raw: string, root: RecoveryRoot, account: Address, { saved: own = false }: { saved?: boolean } = {}): { plan: RulesetPlan; submissions: Map<number, RulesetSubmission> } {
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
  // A plan that can no longer be built still loads: its saved writes recover first, and it sends nothing.
  let built: ReturnType<typeof rebuildPlan> | null = null, unbuildable: string | undefined
  try { built = rebuildPlan({ states, action: saved.action, startsAt: saved.startsAt!, allowances: saved.allowances }) }
  catch (reason) { if (!own) throw reason; unbuildable = message(reason) }
  if (!Array.isArray(data.submissions) || data.submissions.length > states.length) throw new Error('Invalid recovery transaction list.')
  const submissions = new Map<number, RulesetSubmission>()
  for (const entry of data.submissions) {
    if (!Array.isArray(entry) || entry.length !== 2) throw new Error('Invalid recovery transaction entry.')
    const [chainId, transaction] = entry as [number, RulesetSubmission]
    if (!states.some(project => project.chainId === chainId) || submissions.has(chainId) || !transaction) throw new Error('Invalid or duplicate recovery transaction.')
    if (transaction.attemptId !== undefined && (typeof transaction.attemptId !== 'string' || !/^[0-9a-f-]{36}$/i.test(transaction.attemptId))) throw new Error('Invalid recovery attempt identity.')
    const identity = transaction.attemptId ? { attemptId: transaction.attemptId } : {}
    if (transaction.kind === 'submission-unknown') {
      if (Object.keys(transaction).some(key => key !== 'kind' && key !== 'attemptId')) throw new Error('Invalid unknown-submission marker.')
      submissions.set(chainId, { kind: 'submission-unknown', ...identity })
    } else {
      if ((transaction.kind !== 'transaction' && transaction.kind !== 'safe-proposal') || typeof transaction.hash !== 'string' || !/^0x[\da-fA-F]{64}$/.test(transaction.hash)) throw new Error('Invalid recovery transaction hash.')
      submissions.set(chainId, { hash: transaction.hash, kind: transaction.kind, ...identity })
    }
  }
  return { plan: { states, requests: built?.requests ?? [], ...(unbuildable ? { unbuildable } : {}), account: getAddress(saved.account), action: saved.action, startsAt: saved.startsAt!, ...(saved.allowances ? { allowances: saved.allowances } : {}) }, submissions }
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
export async function verifyRulesetRecoveryExecution(client: PublicClient, request: FundTransaction, account: Address, receipt: TransactionReceipt): Promise<'transaction' | 'safe'> {
  const transaction = await client.getTransaction({ hash: receipt.transactionHash })
  const block = await client.getBlock({ blockNumber: receipt.blockNumber })
  if (transaction.blockHash !== receipt.blockHash || block.hash !== receipt.blockHash) throw new Error('The transaction changed during recovery. Refresh its canonical receipt.')
  const expectedData = encodeFunctionData({ abi: request.abi, functionName: request.functionName, args: request.args })
  const expectedValue = request.value ?? 0n
  if (transaction.to && isAddressEqual(transaction.to, request.address) && isAddressEqual(transaction.from, account) && transaction.value === expectedValue && transaction.input.toLowerCase() === expectedData.toLowerCase()) return 'transaction'
  if (transaction.to && isAddressEqual(transaction.to, account)) {
    try {
      const decoded = decodeFunctionData({ abi: SAFE_EXEC_ABI, data: transaction.input })
      if (decoded.functionName === 'execTransaction') {
        const [to, value, data, operation] = decoded.args
        if (operation === 0 && isAddressEqual(to, request.address) && value === expectedValue && data.toLowerCase() === expectedData.toLowerCase()) return 'safe'
      }
    } catch { /* Unsupported execution wrapper must be reconciled explicitly. */ }
  }
  throw new Error('The recovered transaction does not execute this exact reviewed call. No remaining transaction will be offered until the plan is reconciled.')
}

/** The saved submission stays authoritative even when a Safe executes at another hash. */
async function verifyRulesetSubmissionReceipt(plan: RulesetPlan, chainId: number, submission: RulesetSubmission, receipt: TransactionReceipt) {
  if (submission.kind === 'submission-unknown') throw new Error('The ruleset submission hash is still unknown. Keep this attempt pending until its execution is reconciled.')
  const index = plan.states.findIndex(project => project.chainId === chainId)
  if (index < 0) throw new Error('This transaction is not part of the linked plan.')
  const request = plan.requests[index]
  const client = chainClient(plan.states[index].chainId)
  if (submission.kind === 'transaction' && submission.hash.toLowerCase() !== receipt.transactionHash.toLowerCase()) throw new Error('This receipt belongs to another saved ruleset submission.')
  const execution = await verifyRulesetRecoveryExecution(client, request, plan.account, receipt)
  if (submission.kind === 'safe-proposal' && execution !== 'safe') throw new Error('The saved Safe proposal must be proven by its Safe execution.')
  return verifyReviewedWriteReceipt(client, {
    version: 1, id: submission.attemptId ?? `ruleset:${plan.startsAt}:${chainId}`, chainId, account: plan.account,
    safe: execution === 'safe', hash: submission.hash,
    call: { to: request.address, data: encodeFunctionData(request), value: (request.value ?? 0n).toString() },
  }, receipt)
}


/** A Safe proposal not executed by then can't be shown on chain here. */
const SAFE_CHECK_MS = 10_000
/** A chain's saved call's own execution, authenticated on chain: its receipt, exact call and ruleset event. */
async function authenticateChain(plan: RulesetPlan, submission: Exclude<RulesetSubmission, { kind: 'submission-unknown' }>, project: PlanProject, signal?: AbortSignal, settledHash?: Hex): Promise<RulesetCompletion | null> {
  const client = chainClient(project.chainId)
  let hash = settledHash ?? submission.hash
  if (!settledHash && submission.kind === 'safe-proposal') {
    try { hash = await waitForSafeExecutionHash(project.chainId, hash, { signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(SAFE_CHECK_MS)]) }) } catch (reason) { if (signal?.aborted) throw reason; return null }
  }
  let receipt: TransactionReceipt
  try { receipt = await client.getTransactionReceipt({ hash }) } catch { return null }
  if (signal?.aborted) throw new DOMException('Recovery checks paused.', 'AbortError')
  if (receipt.status !== 'success' || safeExecutionResult(receipt, plan.account, submission.hash).status === 'failed') return null
  const rulesetId = validateRulesetRecoveryReceipt(receipt, project.projectId, project.rulesetSnapshot.controller, `Homerun: ${plan.action}`)
  if (await verifyRulesetSubmissionReceipt(plan, project.chainId, submission, receipt) !== 'success') throw new Error('The saved ruleset submission has not been proven successful.')
  return { rulesetId, receipt, submission }
}

/**
 * One chain of a linked plan as the SDK's saved-attempt recovery reads it: the plan's saved
 * submission (from before SDK holds, or a confirmed one), else the chain's hold alone (saved as
 * unsent: the hold has any send). Built only from what was saved, never by rebuilding the plan.
 */
function planChainScope(plan: RulesetPlan, index: number, submission: RulesetSubmission | undefined, isSafe: boolean, confirmRetirable: () => Promise<boolean>): SavedAttemptScope {
  const project = plan.states[index], request = plan.requests[index]
  const safe = submission?.kind === 'safe-proposal' || (submission?.kind === 'submission-unknown' && isSafe) || (!submission && isSafe)
  return {
    chainId: project.chainId, account: plan.account, safe, namespaces: [planIntent(plan, project.projectId)],
    ...(request ? { call: callOf(request) } : {}),
    saved: !submission ? { started: false } : submission.kind === 'submission-unknown' ? { started: true }
      : submission.kind === 'safe-proposal' ? { started: true, safeTxHash: submission.hash } : { started: true, hash: submission.hash },
    confirmRetirable,
  }
}
/** The chain's attempt with its domain check: one transaction ran exactly this chain's reviewed call and queued its ruleset. */
function planChainAttempt(plan: RulesetPlan, index: number, submission: RulesetSubmission | undefined, isSafe: boolean, confirmRetirable: () => Promise<boolean>): SavedAttempt<RulesetCompletion> {
  const project = plan.states[index]
  return {
    ...planChainScope(plan, index, submission, isSafe, confirmRetirable),
    authenticate: async hash => {
      if (!hash) return { result: 'unknown', reason: 'No saved ruleset transaction to check.' }
      if (plan.unbuildable) return { result: 'unknown', reason: plan.unbuildable }
      const saved = submission && submission.kind !== 'submission-unknown' ? submission : { kind: 'transaction' as const, hash }
      // The saved hash is followed to its execution; a settled one is its own.
      const done = await authenticateChain(plan, saved, project, undefined, hash.toLowerCase() === saved.hash.toLowerCase() ? undefined : hash)
      return done ? { result: 'proven', value: done } : { result: 'unknown', reason: 'Its ruleset could not be shown here.' }
    },
  }
}
/** Recovered progress: the chains done. Every other chain's step recovers its own attempt before sending. */
type Recovered = { completed: Map<number, RulesetCompletion> }

function RecoveryPanel({ plan, submissions, onResume, onFailed, recorded }: {
  plan: RulesetPlan; submissions: ReadonlyMap<number, RulesetSubmission>
  /** A chain's completion its own recovery already recorded. */
  recorded: (chainId: number) => RulesetCompletion | undefined
  onResume: (recovered: Recovered) => Promise<void>
  /** Recovery can't resume this plan (its start passed, or its chains changed): only closing it is left. */
  onFailed: () => void
}) {
  const [checking, setChecking] = useState(false)
  const [notice, setNotice] = useState('Saved intent found. The transactions and every linked project must be verified again before continuing.')
  const [error, setError] = useState<string | null>(null)
  const abort = useRef<AbortController | null>(null)
  useEffect(() => () => abort.current?.abort(), [])

  /** One chain through the SDK's saved-attempt recovery: done, or unsettled (held, to be checked, or settled unshown), or nothing sent. */
  async function chainOutcome(index: number, signal: AbortSignal): Promise<RulesetCompletion | 'unsettled' | 'none'> {
    const project = plan.states[index]
    setNotice(`Checking ${displayChainName(project.chainId)}'s transaction.`)
    const outcome = await attempts.recover(planChainAttempt(plan, index, submissions.get(project.chainId), isSafeConnection(wagmiConfig), async () => false), chainClient(project.chainId as JBChainId) as WriteHoldClient)
    if (signal.aborted) throw new DOMException('Recovery checks paused.', 'AbortError')
    if (outcome.status === 'done' && outcome.result === 'success' && outcome.authenticated) return outcome.value
    // Followed and recorded by the chain's own recovery: done; a followed settlement this screen hasn't recorded is not nothing.
    const followed = recorded(project.chainId)
    if (followed) return followed
    if (outcome.status === 'none' && outcome.retired === 'settled') return 'unsettled'
    return outcome.status === 'none' || (outcome.status === 'done' && outcome.result === 'failed') ? 'none' : 'unsettled'
  }

  async function recover() {
    if (checking) return
    const controller = new AbortController(); abort.current = controller
    setChecking(true); setError(null); setNotice('Checking the saved transaction hashes against chain receipts…')
    try {
      const completed = new Map<number, RulesetCompletion>(), unsettled = new Set<number>()
      // Every chain, saved or not: a chain with nothing saved may still have been sent and settled while the page was away.
      for (const [index, project] of plan.states.entries()) {
        const result = await chainOutcome(index, controller.signal)
        if (result === 'unsettled') unsettled.add(project.chainId)
        else if (result !== 'none') completed.set(project.chainId, result)
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
        // An unsettled submission may already have run: its chain's step verifies its execution.
        if (unsettled.has(original.chainId)) continue
        const confirmed = completed.get(original.chainId)
        if (confirmed && latest.blockNumber < confirmed.receipt.blockNumber) throw new Error('A linked RPC has not caught up with its confirmed transaction. Wait and verify again.')
        const expected = { ...original.rulesetSnapshot, ...(confirmed ? { upcomingRulesetId: confirmed.rulesetId } : {}) }
        const alreadyActivated = confirmed && BigInt(latest.ruleset.id) === confirmed.rulesetId && latest.blockTimestamp >= BigInt(plan.startsAt)
        if (!alreadyActivated && snapshotTerms(expected) !== snapshotTerms(latest.rulesetSnapshot)) throw new Error(`The rules on ${displayChainName(original.chainId)} do not match the saved plan. Reconcile them before continuing.`)
      }
      if (completed.size < plan.states.length && (Date.now() / 1000 >= plan.startsAt - 60 || current.some(project => project.blockTimestamp >= BigInt(plan.startsAt - 60)))) throw new Error('Some chains confirmed, but the shared activation deadline has passed. The remaining calls cannot be sent late. Export this plan and reconcile the active and queued rules on every chain before scheduling a replacement.')
      await onResume({ completed })
    } catch (reason) {
      if (!(reason instanceof DOMException && reason.name === 'AbortError')) { setError(`${message(reason)} No duplicate transaction will be submitted during recovery.`); onFailed() }
    } finally { setChecking(false); abort.current = null }
  }

  return <div className="grid gap-4 border-t border-[var(--line)] pt-6">
    <p role="status" className="text-sm">{notice}</p>
    <div className="flex flex-wrap gap-3"><button type="button" className="btn-primary min-h-11 px-5" disabled={checking} onClick={() => void recover()}>{checking ? 'Verifying saved transactions…' : 'Verify and resume queued plan'}</button>{checking && <button type="button" className="btn-secondary min-h-10 px-4" onClick={() => abort.current?.abort()}>Pause recovery checks</button>}</div>
    {error && <p role="alert" className="text-sm text-red-800">{error}</p>}
  </div>
}

/**
 * One chain's write in a linked plan, recovered through the SDK before anything is sent: a held write
 * shows with its exit (a submission the plan saved before SDK holds goes once the hold has it), one
 * that settled where no screen followed it is verified and recorded, one nothing can show asks the
 * user. A write this screen sends is verified and recorded against its exact call once it settles.
 */
function usePlanChainHold(plan: RulesetPlan, index: number, { submission, done = false, onAdopted, onConfirmed, setError, confirmRetirable }: {
  submission?: RulesetSubmission
  /** The plan counts this chain done: a settlement found here is already recorded. */
  done?: boolean
  onAdopted: (chainId: number, submission: RulesetSubmission) => Promise<void>
  onConfirmed: (chainId: number, result: RulesetCompletion) => Promise<void>
  setError: (error: string | null) => void
  confirmRetirable: () => Promise<boolean>
}) {
  const state = plan.states[index]
  const request = plan.requests[index] as FundTransaction | undefined
  const tx = useReviewedAction(state.chainId)
  useConfirmedRefresh(tx, state)
  const delivered = useRef(false)
  const namespace = planIntent(plan, state.projectId)
  const label = `${RULESET_LABELS[plan.action]} on ${displayChainName(state.chainId)}`
  const { track, isSafe } = tx
  const adopted = useEffectEvent((chainId: number, saved: RulesetSubmission) => onAdopted(chainId, saved))
  const confirmed = useEffectEvent((chainId: number, result: RulesetCompletion) => onConfirmed(chainId, result))
  const failed = useEffectEvent((reason: unknown) => setError(message(reason)))
  const client = useMemo(() => chainClient(state.chainId as JBChainId) as WriteHoldClient, [state.chainId])
  const attempt = useMemo(() => done ? null : planChainAttempt(plan, index, submission, isSafe, confirmRetirable),
  // The plan, chain and saved submission are the attempt; the journal re-read reads storage as it is then.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [done, index, isSafe, plan, submission])
  const recovery = useSavedAttempt({ recovery: attempts, attempt, client })
  const { outcome } = recovery
  useEffect(() => {
    if (!outcome) return
    if (outcome.status === 'held') {
      track(request ? { ...request, label } : { chainId: state.chainId, call: { ...outcome.state.record.call, value: BigInt(outcome.state.record.call.value) } }, { reviewedAccount: plan.account, recoveryNamespace: namespace, safe: outcome.state.record.safe, reservation: outcome.state.record.id })
      // A submission the plan saved before SDK holds goes once the hold has it.
      if (submission) void adopted(state.chainId, submission).catch(failed)
    } else if (outcome.status === 'done' && outcome.result === 'success' && outcome.authenticated) {
      void confirmed(state.chainId, outcome.value).catch(failed)
    }
  // Each outcome is handled once.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [outcome])
  /** This chain can be sent only once its recovery says nothing ran. */
  const recovered = !attempt || (!!outcome && (outcome.status === 'none' || (outcome.status === 'done' && outcome.result === 'failed')))

  // The SDK's hold settled this chain's write: its exact call and ruleset event are verified before it counts.
  const settled = tx.phase === 'success' ? tx.receipt : null, sentHash = tx.submissionHash ?? tx.hash ?? settled?.transactionHash
  useEffect(() => {
    if (delivered.current || !settled || settled.status !== 'success' || !sentHash) return
    const sent: RulesetSubmission = { kind: sentHash.toLowerCase() === settled.transactionHash.toLowerCase() ? 'transaction' : 'safe-proposal', hash: sentHash }
    let stopped = false
    void (async () => {
      try {
        const rulesetId = validateRulesetRecoveryReceipt(settled, state.projectId, state.rulesetSnapshot.controller, `Homerun: ${plan.action}`)
        if (await verifyRulesetSubmissionReceipt(plan, state.chainId, sent, settled) !== 'success') throw new Error('The ruleset transaction has not been proven successful.')
        if (stopped) return
        await confirmed(state.chainId, { rulesetId, receipt: settled, submission: sent })
        delivered.current = true
      } catch (reason) { if (!stopped) failed(reason) }
    })()
    return () => { stopped = true }
  }, [plan, sentHash, settled, state.chainId, state.rulesetSnapshot.controller, state.projectId])
  return { state, request, tx, namespace, label, recovery, recovered }
}

/** A linked chain's held write while the plan is being verified: shown with its exit, whatever the plan's deadline or state. */
function PlanChainHold({ plan, index, submission, done, onAdopted, onConfirmed, confirmRetirable }: {
  plan: RulesetPlan; index: number; submission?: RulesetSubmission; done: boolean
  onAdopted: (chainId: number, submission: RulesetSubmission) => Promise<void>
  onConfirmed: (chainId: number, result: RulesetCompletion) => Promise<void>
  confirmRetirable: () => Promise<boolean>
}) {
  const [error, setError] = useState<string | null>(null)
  const { state, tx, recovery } = usePlanChainHold(plan, index, { submission, done, onAdopted, onConfirmed, setError, confirmRetirable })
  const asks = !!recovery.checkAction || (recovery.outcome?.status === 'done' && recovery.outcome.result === 'success' && !recovery.outcome.authenticated)
  if (tx.phase === 'idle' && !error && !asks) return null
  return <div className="grid gap-2">
    <p className="text-sm">{displayChainName(state.chainId)}, project {state.projectId.toString()}:</p>
    {error && <p role="alert" className="text-sm text-red-800">{error}</p>}
    <SavedAttemptNotice attempt={recovery} />
    <Status tx={tx.phase === 'success' ? { ...tx, phase: 'pending' } : tx} chainId={state.chainId} retire={recovery.retire} />
  </div>
}

/** A chain-specific hook instance prevents a wallet switch from watching the wrong chain. */
function LinkedRulesetStep({ plan, index, completed, onConfirmed, onCancel, onAdopted, onCloseChecked, submission, confirmRetirable }: {
  plan: RulesetPlan; index: number; completed: ReadonlyMap<number, RulesetCompletion>
  /** After the user checked a chain this screen couldn't authenticate: close the plan without claiming it. */
  onCloseChecked: () => void
  confirmRetirable: () => Promise<boolean>
  onConfirmed: (chainId: number, result: RulesetCompletion) => Promise<void>
  onCancel: () => void
  /** The plan drops a submission once this chain's hold has adopted it. */
  onAdopted: (chainId: number, submission: RulesetSubmission) => Promise<void>
  submission?: RulesetSubmission
}) {
  const [preparing, setPreparing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { state, request, tx, namespace, label, recovery, recovered } = usePlanChainHold(plan, index, { submission, onAdopted, onConfirmed, setError, confirmRetirable })
  /** The user checked this chain's saved transaction: the plan may be reviewed again here, or closed. */
  const checked = recovery.outcome?.status === 'none' && recovery.outcome.retired === 'check'
  const busy = preparing || tx.busy || tx.phase === 'review' || !recovered

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
    setError(null); setPreparing(true)
    try {
      if (!request) throw new Error(plan.unbuildable ?? 'This linked plan can no longer be built. Close it and prepare a new one.')
      await reverify()
      await tx.send({ ...request, label }, {
        reviewedAccount: plan.account,
        recoveryNamespace: namespace,
        reviewNotice: [`This is transaction ${index + 1} of ${plan.requests.length}. Every chain must confirm before ${new Date(plan.startsAt * 1000).toLocaleString()}. Changes are separate transactions and are not atomic.`, rulesetNotice(plan.action)].filter(Boolean).join('\n\n'),
        reverify,
      })
    } catch (reason) { setError(message(reason)) } finally { setPreparing(false) }
  }

  /** The write is with the wallet, the chain or a Safe: no other is sent meanwhile. */
  const sending = tx.phase === 'submitted' || tx.phase === 'pending' || tx.phase === 'success'
  return <div className="grid gap-3">
    <p className="text-sm">Next: {displayChainName(state.chainId)}, project {state.projectId.toString()}.</p>
    <SavedAttemptNotice attempt={recovery} />
    {plan.unbuildable && <p role="alert" className="text-sm">{plan.unbuildable}</p>}
    <div className="flex flex-wrap gap-3">{recovered && request
      && <button type="button" className="btn-primary min-h-11 px-5" disabled={busy || sending} onClick={() => void submit()}>{preparing ? 'Verifying every chain…' : txPhaseLabel(tx.phase, { idle: `Review transaction ${index + 1} of ${plan.requests.length}`, pending: 'Confirming onchain…' })}</button>}
    {completed.size === 0 && !busy && !sending && !tx.hash && <button type="button" className="btn-secondary min-h-10 px-4" onClick={onCancel}>Cancel plan</button>}
    {checked && !busy && !sending && <button type="button" className="btn-secondary min-h-10 px-4" onClick={onCloseChecked}>Close this plan</button>}</div>
    {error && <p role="alert" className="text-sm text-red-800">{error}</p>}
    <Status tx={tx.phase === 'success' ? { ...tx, phase: 'pending' } : tx} chainId={state.chainId} retire={recovery.retire} />
  </div>
}

function Status({ tx, chainId, retire }: { tx: Tx; chainId: number; retire?: (reason: { by: 'exit' }) => Promise<unknown> }) {
  const explorer = tx.hash && !tx.safeProposalHash ? explorerTxUrl(chainId, tx.hash) : null
  return <div role="status" aria-live="polite" className="break-words text-sm">
    {tx.phase === 'submitted' ? <HeldNotice tx={{ notice: tx.notice, held: retire ? retiringExit(tx.held, retire) : tx.held }} />
      : tx.phase === 'success' ? <p>Transaction confirmed onchain. Refreshing the project’s contract state.</p>
        : tx.phase === 'pending' ? <p>Submitted. Waiting for onchain confirmation…</p>
          : tx.phase === 'review' ? <p>Review the exact transaction before continuing.</p> : null}
    {tx.error && <p className="text-red-800">{tx.error}</p>}
    {tx.submissionHash && !tx.hash && <p className="break-all">Safe proposal: <code>{tx.submissionHash}</code></p>}
    {explorer && <a className="underline" href={explorer} target="_blank" rel="noreferrer">View transaction</a>}
  </div>
}

function Field({ label, value, onChange, disabled, decimal = true }: {
  label: string; value: string; onChange: (value: string) => void; disabled: boolean; decimal?: boolean
}) {
  return <label className="grid gap-2 text-sm">{label}<input className="min-h-11 w-full rounded border border-[#bfc9b5] bg-white px-3 text-base" value={value} onChange={event => onChange(event.target.value)} disabled={disabled} inputMode={decimal ? 'decimal' : 'text'} autoComplete="off" /></label>
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
  const tx = useReviewedAction(state.chainId)
  useConfirmedRefresh(tx, state)
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
  const [plan, setPlan] = useState<RulesetPlan | null>(null)
  const [completed, setCompleted] = useState<Map<number, RulesetCompletion>>(new Map())
  const completedRef = useRef<Map<number, RulesetCompletion>>(new Map())
  /** Recovery couldn't resume the plan: closing it is offered. */
  const [unresumable, setUnresumable] = useState(false)
  const [submissions, setSubmissions] = useState<Map<number, RulesetSubmission>>(new Map())
  const submissionsRef = useRef<Map<number, RulesetSubmission>>(new Map())
  const planRef = useRef<RulesetPlan | null>(null)
  const [recovering, setRecovering] = useState(false)
  const [storageChecked, setStorageChecked] = useState(false)
  const [recoveryLoadError, setRecoveryLoadError] = useState(false)
  const loadedStorageKey = useRef<string | null>(null)
  const savedRecovery = useRef<{ key: string; raw: string | null } | null>(null)
  const [scheduleHours, setScheduleHours] = useState('1')
  // The owner action open in Juicebox Money's confirm dialog; linked multi-chain changes use the plan below instead.
  const [review, setReview] = useState<FundRulesetAction | 'mint' | 'return' | null>(null)
  const clearedReceipt = useRef<string | null>(null)
  useEffect(() => {
    if (tx.phase !== 'success' || !tx.receipt || tx.receipt.status !== 'success' || tx.receipt.transactionHash === clearedReceipt.current) return
    clearedReceipt.current = tx.receipt.transactionHash
    setOffchainUsd(''); setContributionReference(''); setLinkedOperatorCount(''); setReturnAmount('')
    setPurchased(false); setRefundAttestation(false)
  }, [tx.phase, tx.receipt])
  const baseBusy = !storageChecked || recoveryLoadError || preparing || tx.busy || tx.phase === 'review' || !!plan
  const busy = baseBusy || assetBusy
  const linked = state.linkedChainIds.length > 1
  // Single-chain owner actions keep no record of their own: their result is the project's state. Whatever
  // their holds hold shows with its exit, and one that settled while away refreshes that state.
  const heldIntents = useMemo(() => linked ? [] : [
    ...(Object.keys(RULESET_LABELS) as PlanAction[]).filter(action => action !== 'configure-asset-allowance').map(action => ({ namespace: rulesetIntent(state.projectId, action as FundRulesetAction), label: RULESET_LABELS[action] })),
    ...state.accountingContexts.map(context => ({ namespace: allowanceIntent(state.projectId, context), label: `Purchase allowance in ${context.symbol}` })),
  ], [linked, state.accountingContexts, state.projectId])
  const heldActions = useHeldIntents({ hold: holds, chainId: state.chainId, account: address, client: client as WriteHoldClient, intents: heldIntents })
  const queryClient = useQueryClient()
  const settledAway = heldActions.filter(item => item.view.phase === 'succeeded').map(item => item.key).join(',')
  useEffect(() => {
    if (settledAway) for (const key of ['fund-project', 'fund-allowance']) void queryClient.invalidateQueries({ queryKey: [key, state.chainId, state.projectId.toString()] })
  }, [queryClient, settledAway, state.chainId, state.projectId])
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
  const ownerHoldings = useQuery({
    queryKey: ['fund-owner-balance', state.chainId, state.projectId.toString(), state.owner, state.blockNumber.toString()],
    enabled: mintKind === 'operator-share' && !linked && !connectedOwner,
    queryFn: () => client.readContract({ address: v6Address('JBTokens', state.chainId), abi: jbTokensAbi, functionName: 'totalBalanceOf', args: [state.owner, state.projectId], blockNumber: state.blockNumber }),
    staleTime: Infinity,
    retry: 1,
  })
  const ownerBalance = connectedOwner ? state.creditBalance + state.erc20Balance : ownerHoldings.data
  let mintCount = 0n
  try { mintCount = mintKind === 'offchain-contribution' ? offchainFundAmount(offchainUsd) : linked ? parseAmount(linkedOperatorCount, 18) : ownerBalance === undefined ? 0n : ownerMintAmount(state.totalSupply, ownerBalance, parsePercent(targetShare)) } catch { /* Invalid inputs disable the action. */ }
  // The historical action ID is retained, but this allocation always belongs to the current project owner.
  const mintRecipient = mintKind === 'operator-share' ? state.owner : destination(recipient)
  const returnRaw = context ? amountOrZero(returnAmount, context.decimals) : 0n
  const returnIntent = context && address ? encoded([state.chainId, state.projectId, address, context.terminal, context.token, returnRaw, returnReason]) : null
  const returnNative = !!context && isAddressEqual(context.token, NATIVE_TOKEN)
  const returnRows: TxProgressRow[] = [
    { label: 'Return', value: `${returnAmount || '0'} ${context?.symbol ?? ''}`, strong: true },
    { label: 'For', value: returnReason === 'asset-sale' ? 'Asset-sale proceeds' : 'Campaign refunds' },
    { label: 'To', value: `FUND treasury on ${displayChainName(state.chainId)}` },
  ]
  // Whether the return needs an approval first, read before the first prompt so the step list is right.
  const returnAllowance = useQuery({
    queryKey: ['fund-return-allowance', state.chainId, state.projectId.toString(), context?.terminal, context?.token, address],
    enabled: review === 'return' && !!context && !returnNative && !!address,
    queryFn: () => client.readContract({ address: context!.token, abi: erc20Abi, functionName: 'allowance', args: [address!, context!.terminal] }),
    staleTime: 10_000, retry: false,
  })
  function openReview(kind: FundRulesetAction | 'mint' | 'return') {
    setError(null)
    // A settled earlier action must not show as this one's result.
    if (tx.phase === 'success' || tx.phase === 'error') tx.reset()
    setReview(kind)
  }

  function recoveryKey(account: Address): string {
    return `homerun:fund-ruleset-recovery:${state.chainId}:${state.projectId}:${account.toLowerCase()}`
  }

  function persistIntent(next: RulesetPlan, records: ReadonlyMap<number, RulesetSubmission>) {
    const raw = serializeRulesetRecovery(next, records, { chainId: state.chainId, projectId: state.projectId })
    const key = recoveryKey(next.account)
    const expected = savedRecovery.current?.key === key ? savedRecovery.current.raw : null
    if (window.localStorage.getItem(key) === raw) { savedRecovery.current = { key, raw }; return }
    if (window.localStorage.getItem(key) !== expected) throw new Error('The linked ruleset recovery changed in another tab. Reload its saved progress before continuing.')
    window.localStorage.setItem(key, raw)
    if (window.localStorage.getItem(key) !== raw) throw new Error('Recovery intent could not be saved. Enable browser storage before preparing linked transactions.')
    savedRecovery.current = { key, raw }
  }

  function activatePlan(next: RulesetPlan, records = new Map<number, RulesetSubmission>(), restore = false) {
    planRef.current = next; submissionsRef.current = records
    setPlan(next); setSubmissions(records); completedRef.current = new Map(); setCompleted(completedRef.current); setRecovering(restore); setRecoveryLoadError(false)
  }

  useEffect(() => {
    if (!address) { setStorageChecked(true); return }
    if (planRef.current && !isAddressEqual(planRef.current.account, address)) { setStorageChecked(true); return }
    const key = `homerun:fund-ruleset-recovery:${state.chainId}:${state.projectId}:${address.toLowerCase()}`
    if (loadedStorageKey.current === key) return
    loadedStorageKey.current = key
    try {
      const raw = window.localStorage.getItem(key)
      savedRecovery.current = { key, raw }
      if (raw) {
        const restored = deserializeRulesetRecovery(raw, { chainId: state.chainId, projectId: state.projectId }, address, { saved: true })
        planRef.current = restored.plan; submissionsRef.current = restored.submissions
        setPlan(restored.plan); setSubmissions(restored.submissions); completedRef.current = new Map(); setCompleted(completedRef.current); setRecovering(true)
      }
    } catch (reason) { setRecoveryLoadError(true); setError(`Saved recovery intent could not be loaded. Import a valid recovery file before preparing another linked plan: ${message(reason)}`) }
    setStorageChecked(true)
  }, [address, state.chainId, state.projectId, plan])

  function recordSubmission(chainId: number, submission: RulesetSubmission) {
    const active = planRef.current
    if (!active) throw new Error('The linked ruleset plan is no longer available. Verify its transactions again.')
    const records = new Map(submissionsRef.current).set(chainId, submission)
    persistIntent(active, records)
    submissionsRef.current = records; setSubmissions(records)
  }

  function assertSubmission(chainId: number, expected: RulesetSubmission | null) {
    if (JSON.stringify(submissionsRef.current.get(chainId) ?? null) !== JSON.stringify(expected)) throw new Error('This ruleset submission changed during recovery. Keep the current attempt pending.')
  }

  function removeSubmission(chainId: number) {
    const active = planRef.current
    if (!active) return
    const records = new Map(submissionsRef.current); records.delete(chainId)
    persistIntent(active, records)
    submissionsRef.current = records; setSubmissions(records)
  }

  async function withSubmissionLock(task: () => Promise<void>) {
    const active = planRef.current
    if (!active) throw new Error('Reload the saved linked ruleset plan before continuing.')
    if (typeof navigator.locks?.request !== 'function') throw new Error('Use a browser with Web Locks support to coordinate linked ruleset submissions.')
    const key = recoveryKey(active.account)
    await navigator.locks.request(key, { mode: 'exclusive', ifAvailable: true }, async lock => {
      if (!lock) throw new Error('This linked ruleset plan is being reviewed or submitted in another tab.')
      if (savedRecovery.current?.key !== key || window.localStorage.getItem(key) !== savedRecovery.current.raw) throw new Error('The linked ruleset recovery changed in another tab. Reload its saved progress before continuing.')
      await task()
    })
  }

  /** The plan's journal, re-read strictly: a chain may be retired only while its success isn't recorded. */
  const chainRetirable = (chainId: number) => async () => {
    const active = planRef.current
    if (!active || completedRef.current.has(chainId)) return false
    return savedRecovery.current?.key === recoveryKey(active.account) && window.localStorage.getItem(recoveryKey(active.account)) === savedRecovery.current.raw
  }
  function chainScope(active: RulesetPlan, index: number, submission = submissionsRef.current.get(active.states[index].chainId)) {
    return planChainScope(active, index, submission, tx.isSafe, chainRetirable(active.states[index].chainId))
  }
  /**
   * A chain's verified write is recorded. Its settlement is followed only as the plan closes: until
   * then each reload proves it again from its saved submission, so a completion is never lost.
   */
  const confirmChain = (active: RulesetPlan) => (chainId: number, result: RulesetCompletion) => withSubmissionLock(async () => {
    if (planRef.current !== active) throw new Error('The linked plan changed during confirmation.')
    recordSubmission(chainId, result.submission)
    completedRef.current = new Map(completedRef.current).set(chainId, result)
    setCompleted(completedRef.current)
  })

  /**
   * Close the plan. Normally every saved submission must be verified first; after the user checked a chain
   * this screen couldn't authenticate (`checked`), it closes without claiming that chain, and sends nothing.
   */
  async function closePlan(checked = false) {
    const active = planRef.current
    if (!active) return
    try {
      await withSubmissionLock(async () => {
        if (planRef.current !== active) throw new Error('The linked plan changed while closing. Keep its current submissions pending.')
        // A chain whose write its hold still holds keeps the plan, and its exit, until it settles or the user takes that exit;
        // one that settled keeps it until its result is recorded. A recorded chain is checked once it is followed, below.
        for (const [index, peer] of active.states.entries()) {
          if (!completedRef.current.has(peer.chainId) && !attempts.canDiscard(chainScope(active, index))) throw new Error('Finish or exit the pending update first.')
        }
        const records = submissionsRef.current
        if (!checked && (records.size || completed.size)) {
          if (completed.size !== active.states.length || records.size !== active.states.length) throw new Error('Every saved submission must be verified before this plan can be closed.')
          for (const project of active.states) {
            const result = completed.get(project.chainId)
            if (!result) throw new Error('A linked submission is not yet verified.')
            assertSubmission(project.chainId, result.submission)
          }
        }
        // Every check passed: each recorded chain's settlement is followed now, as its plan closes, and nothing else holds it.
        for (const [chainId, result] of completedRef.current) {
          const index = active.states.findIndex(peer => peer.chainId === chainId)
          if (index < 0) continue
          await attempts.retire(chainScope(active, index, result.submission), { by: 'settled', hash: result.receipt.transactionHash })
          if (!attempts.canDiscard(chainScope(active, index, result.submission))) throw new Error('Finish or exit the pending update first.')
        }
        const key = recoveryKey(active.account)
        window.localStorage.removeItem(key)
        if (window.localStorage.getItem(key) !== null) throw new Error('The saved recovery plan could not be cleared.')
        savedRecovery.current = { key, raw: null }
        planRef.current = null; submissionsRef.current = new Map()
        setPlan(null); setSubmissions(new Map()); completedRef.current = new Map(); setCompleted(completedRef.current); setRecovering(false); setUnresumable(false)
      })
    } catch (reason) { setError(message(reason)) }
  }

  function downloadRecovery() {
    if (!plan) return
    const blob = new Blob([serializeRulesetRecovery(plan, submissionsRef.current, { chainId: state.chainId, projectId: state.projectId })], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a'); link.href = url; link.download = `homerun-fund-${state.chainId}-${state.projectId}-recovery.json`
    link.click(); URL.revokeObjectURL(url)
  }

  async function importRecovery(file: File | undefined) {
    if (!file || !address || preparing || tx.busy || tx.phase === 'review' || plan) return
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
    if (!isAddressEqual(latest.owner, state.owner)) throw new Error('Project ownership changed. Refresh and review the current owner.')
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
      if (!address) throw new Error('Connect the verified project owner wallet.')
      const current = await fresh()
      if (!current.permissions.queueRulesets) throw new Error('This wallet does not have permission to change the project rules.')
      if (current.linkedChainIds.length > 1) {
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
        reviewedAccount: address,
        // The rebuilt configuration copies every field it preserves: a retry is held by the chosen action.
        recoveryNamespace: rulesetIntent(state.projectId, action),
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
      if (!address) throw new Error('Connect the project owner wallet.')
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
        reviewedAccount: address,
        // The rebuilt configuration copies every field it preserves: a retry is held by the allowance chosen.
        recoveryNamespace: allowanceIntent(state.projectId, allowances[0]),
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
        if (!isAddressEqual(peer.owner, current.owner)) throw new Error('The linked projects do not have the same owner. Review all project owners before issuing allocations.')
        if (peer.pendingReservedTokens !== 0n) throw new Error('Distribute pending reserved FUND before calculating the owner allocation.')
      }
      if (mintKind === 'offchain-contribution' && current.rulesetSnapshot.configuration?.weight !== FUND_WEIGHT) throw new Error('The project’s issuance rate differs from the initial FUND rate. Review its contribution records and current rules in Juicebox before minting.')
      const currentBalance = await client.readContract({ address: v6Address('JBTokens', state.chainId), abi: jbTokensAbi, functionName: 'totalBalanceOf', args: [mintRecipient, state.projectId], blockNumber: current.blockNumber })
      const count = mintKind === 'offchain-contribution' ? offchainFundAmount(offchainUsd) : linked ? parseAmount(linkedOperatorCount, 18) : ownerMintAmount(current.totalSupply, currentBalance, parsePercent(targetShare))
      if (count <= 0n) throw new Error('No additional FUND is needed for this allocation.')
      const memo = mintKind === 'offchain-contribution' ? `Homerun: offchain contribution ${contributionReference.trim()}` : 'Homerun: owner share after successful purchase'
      const request = buildFundMint({ snapshot: current.rulesetSnapshot, beneficiary: mintRecipient, tokenCount: count, kind: mintKind, memo })
      await tx.send({ ...request, label: `Mint ${formatUnits(count, 18)} FUND to ${mintRecipient}` }, {
        reviewedAccount: address,
        // An owner share's count is calculated from supply and holdings: a retry is held by the chosen target.
        recoveryNamespace: writeIntentKey('fund-mint', { project: state.projectId, kind: mintKind, beneficiary: intent.address(mintRecipient),
          ...(mintKind === 'offchain-contribution' ? { amount: count, reference: contributionReference.trim() }
            : linked ? { amount: count } : { target: parsePercent(targetShare) }) }),
        reviewNotice: mintKind === 'operator-share'
          ? linked ? `Issue exactly ${formatUnits(count, 18)} FUND to the owner on ${displayChainName(state.chainId)}. Reconcile the owner’s holdings on all linked chains, including unclaimed bridged FUND. The owner may distribute these tokens to the operator at their discretion. Homerun does not infer a global ownership percentage from incomplete bridge supply.` : `Target a ${targetShare}% FUND share for the owner after this mint, including the owner’s current FUND. The owner may distribute these tokens to the operator at their discretion. This is an owner-selected allocation, not a contract-enforced entitlement.`
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
          const latestBalance = await client.readContract({ address: v6Address('JBTokens', state.chainId), abi: jbTokensAbi, functionName: 'totalBalanceOf', args: [mintRecipient, state.projectId], blockNumber: latest.blockNumber })
          if (latestBalance !== currentBalance) throw new Error('Owner holdings changed during review. Recalculate the allocation before minting.')
          const rebuilt = buildFundMint({ snapshot: latest.rulesetSnapshot, beneficiary: mintRecipient, tokenCount: count, kind: mintKind, memo })
          if (!sameRequest(request, rebuilt)) throw new Error('The mint request changed. Refresh and review again.')
        },
      })
    })
  }

  async function returnFunds() {
    await run(async () => {
      if (!context || !address || returnRaw <= 0n || !returnIntent) throw new Error('Enter a positive treasury return amount.')
      const current = await fresh()
      const native = isAddressEqual(context.token, NATIVE_TOKEN)
      const verifyContext = (latest: FundProjectState) => {
        const verified = latest.accountingContexts.find(item => isAddressEqual(item.token, context.token) && isAddressEqual(item.terminal, context.terminal))
        if (!verified || verified.decimals !== context.decimals) throw new Error('The treasury terminal or currency changed. Refresh and review again.')
        return verified
      }
      verifyContext(current)
      const terminal = { chainId: state.chainId, projectId: state.projectId, terminal: context.terminal, token: context.token }
      const approving = !native && await client.readContract({ address: context.token, abi: erc20Abi, functionName: 'allowance', args: [address, context.terminal], blockNumber: current.blockNumber }) < returnRaw
      const approvalRequest = approving ? buildFundApproval({ ...terminal, amount: returnRaw }) : null
      if (approving && !approvalRequest) throw new Error('The required token approval could not be built.')
      const request = buildFundReturn({ ...terminal, amount: returnRaw, reason: returnReason, shouldReturnHeldFees: true })
      const back: TxStep = { ...request, label: `Return ${formatUnits(returnRaw, context.decimals)} ${context.symbol} to FUND for ${returnReason === 'asset-sale' ? 'the asset sale' : 'refunds'}`, ...(approving ? { dependsOnPrior: true } : {}) }
      // The approval and the return are one review, and resume as one action after a reload.
      await tx.send(approvalRequest ? [{ ...approvalRequest, label: `Approve exactly ${formatUnits(returnRaw, context.decimals)} ${context.symbol} for the treasury return` }, back] : [back], {
        reviewedAccount: address,
        scope: `homerun:fund-return:${returnIntent}`,
        context: reviewContext(returnRows),
        reviewNotice: 'This adds money to the project treasury without minting FUND. It does not change cash-out rules. Opening zero-tax refunds or asset-sale cash-outs is a separate reviewed transaction.',
        reverify: async (step, _index, prior) => {
          const latest = await fresh(prior?.blockNumber)
          verifyContext(latest)
          if (!native && step.functionName !== 'approve') {
            const available = await client.readContract({ address: context.token, abi: erc20Abi, functionName: 'allowance', args: [address, context.terminal], blockNumber: latest.blockNumber })
            if (available < returnRaw) throw new Error('The token approval changed. Confirm a sufficient approval before returning funds.')
          }
        },
      })
    })
  }

  const select = 'min-h-11 w-full rounded border border-[#bfc9b5] bg-white px-3 pr-9'
  return <div className="grid gap-8">
    <p className="text-xs text-[var(--muted)]">Each action is reviewed, simulated and confirmed separately. The owner declares the real-world purchase, failure or sale; the contracts only store rules and balances.</p>
    {rulesetUnavailable && <p role="status" className="text-sm">{rulesetUnavailable}</p>}
    {linked && <div className="grid gap-2"><Field label="Shared ruleset start, in hours from now (1–168)" value={scheduleHours} onChange={setScheduleHours} disabled={busy} /><p className="text-xs text-[var(--muted)]">Linked changes need one confirmed transaction per chain before this start. Leave time for every wallet or Safe.</p></div>}
    {!plan && (linked || recoveryLoadError) && <details><summary className="cursor-pointer text-sm">Recover a linked ruleset plan</summary><div className="mt-4 grid gap-4"><p className="text-xs text-[var(--muted)]">Restore a downloaded plan if this browser lost it. Every saved hash is checked onchain before another transaction is offered.</p><label className="grid gap-2 text-sm">Import recovery file<input type="file" accept="application/json,.json" disabled={!address || preparing} onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; void importRecovery(file) }} /></label></div></details>}
    {plan && <section className="grid gap-4 border-t border-[var(--line)] pt-6" aria-label="Linked ruleset transaction plan">
      <h3 className="text-[15px] font-medium">Update every linked chain</h3>
      <dl className="demo-live-rows"><div><dt>Change</dt><dd>{RULESET_LABELS[plan.action]}</dd></div><div><dt>Shared activation</dt><dd>{new Date(plan.startsAt * 1000).toLocaleString()}</dd></div></dl>
      {(!address || !isAddressEqual(address, plan.account)) && <p role="status" className="break-words text-sm">Reconnect {plan.account} to continue this plan. Its pending transaction tracking remains active.</p>}
      <p className="text-xs text-[var(--muted)]">Calls and hashes are saved for recovery and verified again on return. Confirmed updates stay queued if a later transaction is cancelled or delayed.</p>
      <div className="flex flex-wrap gap-3"><button type="button" className="btn-secondary min-h-10 px-4" onClick={downloadRecovery}>Download recovery plan</button>{!recovering && submissions.size > completed.size && <button type="button" className="btn-secondary min-h-10 px-4" onClick={() => setRecovering(true)}>Recheck saved transaction</button>}</div>
      <TxSteps
        ariaLabel="Linked chains"
        intro={`Every linked chain needs its own transaction before ${new Date(plan.startsAt * 1000).toLocaleString()}. This list advances as each one confirms.`}
        activeIndex={completed.size >= plan.states.length ? plan.states.length : plan.states.findIndex(peer => !completed.has(peer.chainId))}
        steps={plan.states.map(peer => {
          const result = completed.get(peer.chainId)
          const explorer = result ? explorerTxUrl(peer.chainId, result.receipt.transactionHash) : null
          const saved = submissions.get(peer.chainId)
          return {
            key: String(peer.chainId),
            title: <>{displayChainName(peer.chainId)}, project {peer.projectId.toString()}{explorer && <> (<a className="underline" href={explorer} target="_blank" rel="noreferrer">transaction</a>)</>}</>,
            detail: result ? 'Execution confirmed.' : saved ? saved.kind === 'submission-unknown' ? 'Submission started; hash not yet recorded.' : saved.kind === 'safe-proposal' ? 'Safe proposal recorded; execution not yet verified.' : 'Transaction recorded; confirmation not yet verified.' : 'Not yet confirmed.',
          }
        })}
      />
      {/* Every chain's hold is shown with its exit, while the plan is verified and after it resumes, except the chain its step shows. */}
      {plan.states.map((peer, index) => (recovering || peer.chainId !== plan.states.find(next => !completed.has(next.chainId))?.chainId) && <PlanChainHold key={`${plan.startsAt}:${peer.chainId}`} plan={plan} index={index} submission={submissions.get(peer.chainId)} onConfirmed={confirmChain(plan)} done={completed.has(peer.chainId)} onAdopted={(chainId, submission) => withSubmissionLock(async () => { assertSubmission(chainId, submission); removeSubmission(chainId) })} confirmRetirable={chainRetirable(peer.chainId)} />)}
      {/* A plan that can no longer finish (its shared start passed, or recovery can't resume it) can always be closed. */}
      {(unresumable || (completed.size < plan.states.length && Date.now() / 1000 >= plan.startsAt - 60)) && <div role="status" className="grid gap-2 text-sm">
        <p>This plan can no longer finish. The chains not yet updated were not changed.</p>
        <button type="button" className="btn-secondary min-h-10 w-fit px-4" onClick={() => void closePlan(true)}>Close this plan</button>
      </div>}
      {recovering ? <RecoveryPanel plan={plan} submissions={submissions} recorded={chainId => completedRef.current.get(chainId)} onFailed={() => setUnresumable(true)} onResume={recovered => withSubmissionLock(async () => { if (planRef.current !== plan) throw new Error('The linked plan changed during recovery.'); for (const [chainId, submission] of submissions) assertSubmission(chainId, submission); if (submissionsRef.current.size !== submissions.size) throw new Error('A linked submission changed during recovery.'); completedRef.current = new Map([...completedRef.current, ...recovered.completed]); setCompleted(completedRef.current); setRecovering(false) })} />
        : completed.size < plan.states.length ? <LinkedRulesetStep key={`${plan.startsAt}:${completed.size}`} plan={plan} index={plan.states.findIndex(peer => !completed.has(peer.chainId))} submission={submissions.get(plan.states.find(peer => !completed.has(peer.chainId))!.chainId)} confirmRetirable={chainRetirable(plan.states.find(peer => !completed.has(peer.chainId))!.chainId)} completed={completed} onConfirmed={confirmChain(plan)} onCancel={() => void closePlan()} onCloseChecked={() => void closePlan(true)} onAdopted={(chainId, submission) => withSubmissionLock(async () => { assertSubmission(chainId, submission); removeSubmission(chainId) })} />
          : <><p role="status" className="text-sm">Every ruleset transaction is confirmed. The new rules take effect at the shared activation time.</p><button type="button" className="btn-secondary min-h-10 w-fit px-4" onClick={() => void closePlan()}>Done</button></>}
    </section>}

    {!linked && <HeldWritesNotice items={heldActions} className="grid gap-2 text-sm" />}
    <section className="grid gap-4 border-t border-[var(--line)] pt-6" aria-labelledby="fund-campaign-controls">
      <h3 id="fund-campaign-controls" className="text-[15px] font-medium">Campaign controls</h3>
      <p className="text-sm">Pausing stops new contributions. Closing also disables FUND cash-outs while the purchase settles.</p>
      <div className="flex flex-wrap gap-3">
        <button type="button" className="btn-secondary min-h-10 px-4" disabled={busy || !canQueue || !!rulesetUnavailable || state.metadata.pausePay} onClick={() => linked ? void changeRules('pause') : openReview('pause')}>Review pause</button>
        <button type="button" className="btn-secondary min-h-10 px-4" disabled={busy || !canQueue || !!rulesetUnavailable || !state.metadata.pausePay || !fundraising} onClick={() => linked ? void changeRules('resume') : openReview('resume')}>Review resume</button>
        <button type="button" className="btn-secondary min-h-10 px-4" disabled={busy || !canQueue || !!rulesetUnavailable || !fundraising} onClick={() => linked ? void changeRules('close') : openReview('close')}>Review close campaign</button>
      </div>
      {!canQueue && <p className="text-xs text-[var(--muted)]">This wallet does not have permission to change the project’s rules.</p>}
    </section>

    <FundAssetWithdrawals state={state} client={client} contextIndex={contextIndex} disabled={baseBusy} onConfigureAllowance={configureAssetAllowance} onBusyChange={setAssetBusy} />

    <section className="grid gap-4 border-t border-[var(--line)] pt-6" aria-labelledby="fund-success-controls">
      <h3 id="fund-success-controls" className="text-[15px] font-medium">Successful purchase and FUND allocations</h3>
      <p className="text-sm">In order: close the campaign, enable success minting, record offchain contributions, mint the owner share, then disable owner minting.</p>
      <p className="text-xs text-[var(--muted)]">The owner may pass FUND to the operator at their discretion. Failed offchain contributions are refunded outside the treasury.</p>
      <label className="flex items-start gap-3 text-sm"><input className="mt-1 size-4 shrink-0" type="checkbox" checked={purchased} onChange={event => setPurchased(event.target.checked)} disabled={busy} />I confirm that the asset purchase succeeded and the contribution records are reconciled.</label>
      <button type="button" className="btn-secondary min-h-10 w-fit px-4" disabled={busy || !canQueue || !!rulesetUnavailable || !purchased || !closed || mintEnabled} onClick={() => linked ? void changeRules('enable-success-minting') : openReview('enable-success-minting')}>Review enabling success mints</button>
      <div className="grid gap-4 border-t border-[var(--line)] pt-6">
        <label className="grid gap-2 text-sm">Allocation<select className={select} value={mintKind} disabled={busy} onChange={event => setMintKind(event.target.value as typeof mintKind)}><option value="offchain-contribution">Offchain contribution</option><option value="operator-share">Owner share</option></select></label>
        {mintKind === 'operator-share' && <p className="break-words text-sm">Owner recipient: {state.owner}. This is the current Juicebox project owner.</p>}
        {mintKind === 'offchain-contribution' ? <><div className="grid gap-4 sm:grid-cols-2"><Field label="Contribution received in USD" value={offchainUsd} onChange={setOffchainUsd} disabled={busy} /><Field label="Contributor wallet" value={recipient} onChange={setRecipient} disabled={busy} decimal={false} /></div><Field label="Unique public contribution reference" value={contributionReference} onChange={setContributionReference} disabled={busy} decimal={false} /><p className="text-xs text-[var(--muted)]">The reference is public onchain. Use a receipt number, not personal information.</p></>
          : linked ? <><Field label="Additional owner FUND to mint on this chain" value={linkedOperatorCount} onChange={setLinkedOperatorCount} disabled={busy} /><p className="text-xs text-[var(--muted)]">Reconcile contributor allocations, owner holdings and unclaimed bridged FUND on every chain first. Chain supplies alone cannot give a global share.</p></>
            : <><Field label="Target owner FUND ownership after mint (%)" value={targetShare} onChange={setTargetShare} disabled={busy} /><p className="text-xs text-[var(--muted)]">Complete contributor mints first. The calculation includes the owner’s holdings and current FUND supply.</p></>}
        <p className="break-words text-sm">Additional FUND to mint: {formatUnits(mintCount, 18)}. It is checked again with fresh contract reads before review.</p>
        {mintKind === 'operator-share' && !linked && !connectedOwner && ownerHoldings.isError && <p role="alert" className="text-sm">The owner’s FUND holdings could not be verified. Refresh before calculating this allocation.</p>}
        {!mintEnabled && <p className="text-xs text-[var(--muted)]">Minting opens once the onchain ruleset closes cash-outs and enables owner minting.</p>}
        <div className="flex flex-wrap gap-3"><button type="button" className="btn-primary min-h-11 px-5" disabled={busy || !canMint || !!rulesetUnavailable || !purchased || !mintEnabled || mintCount <= 0n || !mintRecipient || (mintKind === 'offchain-contribution' && !contributionReference.trim())} onClick={() => openReview('mint')}>Review FUND allocation</button><button type="button" className="btn-secondary min-h-10 px-4" disabled={busy || !canQueue || !!rulesetUnavailable || !mintEnabled} onClick={() => linked ? void changeRules('finish-success-minting') : openReview('finish-success-minting')}>Review disabling owner minting</button></div>
        {!canMint && <p className="text-xs text-[var(--muted)]">This wallet does not have permission to mint FUND.</p>}
      </div>
    </section>

    <section className="grid gap-4 border-t border-[var(--line)] pt-6" aria-labelledby="fund-return-controls">
      <h3 id="fund-return-controls" className="text-[15px] font-medium">Return funds to the treasury</h3>
      <p className="text-sm">Add money for refunds or net asset-sale proceeds. No FUND is minted.</p>
      {context ? <div className="grid gap-4"><div className="grid gap-4 sm:grid-cols-2"><label className="grid gap-2 text-sm">Reason<select className={select} value={returnReason} disabled={busy} onChange={event => setReturnReason(event.target.value as typeof returnReason)}><option value="refunds">Campaign refunds</option><option value="asset-sale">Asset-sale proceeds</option></select></label><Field label={`Amount in ${context.symbol}`} value={returnAmount} onChange={setReturnAmount} disabled={busy} /></div>
        <button type="button" className="btn-primary min-h-11 w-fit px-5" disabled={busy || returnRaw <= 0n} onClick={() => openReview('return')}>Review treasury return</button><p className="text-xs text-[var(--muted)]">A token approval, if needed, is reviewed with the return.</p></div> : <p className="text-sm">No supported treasury currency has been verified.</p>}
    </section>

    <section className="grid gap-4 border-t border-[var(--line)] pt-6" aria-labelledby="fund-refund-controls">
      <h3 id="fund-refund-controls" className="text-[15px] font-medium">Open refunds or asset-sale cash-outs</h3>
      <p className="text-sm">Once funds are returned, open pro rata FUND cash-outs at zero tax. This removes payout limits and surplus allowances; contributions and owner minting stay paused.</p>
      <label className="grid gap-2 text-sm">Outcome<select className={select} value={refundReason} disabled={busy} onChange={event => { setRefundReason(event.target.value as typeof refundReason); setRefundAttestation(false) }}><option value="failure-refunds">Campaign failed</option><option value="asset-sale-refunds">Asset sold</option></select></label>
      <label className="flex items-start gap-3 text-sm"><input className="mt-1 size-4 shrink-0" type="checkbox" checked={refundAttestation} disabled={busy} onChange={event => setRefundAttestation(event.target.checked)} />{refundReason === 'failure-refunds' ? 'I confirm that the campaign failed and the available onchain funds have been returned for refunds. Offchain refunds are handled separately.' : 'I confirm that the asset was sold and net sale proceeds are in the treasury for FUND holders.'}</label>
      <button type="button" className="btn-secondary min-h-10 w-fit px-4" disabled={busy || !canQueue || !!rulesetUnavailable || !refundAttestation} onClick={() => linked ? void changeRules(refundReason) : openReview(refundReason)}>{refundReason === 'failure-refunds' ? 'Review opening failure refunds' : 'Review opening asset-sale cash-outs'}</button>
    </section>

    {!review && <div className="grid gap-3">
      {error && <p role="alert" className="text-sm text-red-800">{error}</p>}
      <Status tx={tx} chainId={state.chainId} />
    </div>}
    {review && (() => {
      const chain = displayChainName(state.chainId)
      const returnNeedsApproval = review === 'return' && !returnNative && (returnAllowance.data === undefined || returnAllowance.data < returnRaw)
      const spec: { title: string; rows: TxProgressRow[]; steps: { key: string; title: string; detail?: string }[]; notice?: string; run: () => Promise<void> } =
        review === 'mint' ? {
          title: 'Mint FUND',
          rows: [
            { label: 'Mint', value: `${formatUnits(mintCount, 18)} FUND`, strong: true },
            { label: 'To', value: mintRecipient ?? '', mono: true },
            { label: 'For', value: mintKind === 'offchain-contribution' ? `Offchain contribution ${contributionReference.trim()}` : 'The owner share after the purchase' },
            { label: 'On', value: chain },
          ],
          steps: [{ key: 'mint', title: 'Mint FUND', detail: 'Checked again with fresh contract reads before your wallet opens.' }],
          run: mint,
        } : review === 'return' ? {
          title: 'Return funds to the treasury',
          rows: returnRows,
          steps: [
            ...(returnNeedsApproval ? [{ key: 'approve', title: `Approve ${context?.symbol ?? 'the token'}`, detail: 'Lets the treasury take exactly this amount.' }] : []),
            { key: 'return', title: 'Return to the treasury', detail: 'No FUND is minted.' },
          ],
          run: returnFunds,
        } : {
          title: 'Change the rules',
          rows: [{ label: 'Change', value: RULESET_LABELS[review] }, { label: 'On', value: chain }],
          steps: [{ key: 'queue', title: 'Queue the new rules' }],
          notice: rulesetNotice(review),
          run: () => changeRules(review),
        }
      const running = preparing || tx.busy || tx.phase === 'review'
      return <TxProgress
        open
        eyebrow="Owner action"
        title={tx.phase === 'success' ? `${spec.title}: confirmed` : spec.title}
        rows={spec.rows}
        steps={spec.steps}
        activeIndex={running ? Math.min(spec.steps.length - 1, spec.steps.length - tx.total + tx.step) : -1}
        start={() => void spec.run()}
        busy={running && !tx.safeProposalHash}
        complete={tx.phase === 'success'}
        settled={tx.phase === 'submitted'}
        held={tx.held}
        status={tx.notice ?? (tx.phase === 'pending' ? 'Submitted. Waiting for onchain confirmation…' : null)}
        error={error ?? tx.error}
        onClose={() => { setReview(null); if (tx.phase === 'submitted') tx.dismiss() }}
      >
        {spec.notice && <p className="text-sm text-smoke-600">{spec.notice}</p>}
      </TxProgress>
    })()}
  </div>
}
