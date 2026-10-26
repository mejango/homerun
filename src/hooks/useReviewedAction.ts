'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { zeroAddress, type Abi, type Address, type Hex, type TransactionReceipt } from 'viem'
import {
  openStepHold,
  ReviewedCallRevertedError,
  ReviewLineError,
  settledLine,
  transactionMessage,
  viemWalletAdapter,
  writeExitMessage,
  type ReviewContextRow,
  type ReviewedCall,
  type ReviewedPriorBlock,
  type ReviewedResult,
  type ReviewedSendDeps,
  type WriteHoldClient,
} from '@bananapus/nana-sdk-core/review'
import { useHeldWrite, useReviewedRun } from '@bananapus/nana-sdk-core/review/react'
import { getAccount, getWalletClient, switchChain } from '@wagmi/core'
import { loadReviewDialog } from '@/components/TransactionReviewProvider'
import type { HeldWrite } from '@/components/ui/HeldWriteExit'
import { useWallet } from '@/hooks/useWallet'
import { isSafeConnection, SAFE_NONCE_GUIDANCE, useSafeConnection, type SafeAppCall } from '@/lib/safe-connector'
import { preloadWhenIdle } from '@/lib/idle-preload'
import { getViewAs, VIEW_AS_WRITE_BLOCKED } from '@/lib/viewAs'
import { publicClient } from '@/lib/wallet-core'
import { callOf, holds } from '@/lib/write-hold'
import { wagmiConfig } from '@/providers/Providers'
import type { JBChainId } from '@bananapus/nana-sdk-core'
import { chainName } from '@/lib/urn'

export type TxPhase =
  | 'idle'
  | 'review'
  | 'simulating'
  | 'signing'
  | 'pending'
  /** With a Safe, or held: the hold's own line says where it is. */
  | 'submitted'
  | 'success'
  | 'error'

export type TxRequest = {
  chainId: number
  address: `0x${string}`
  abi: Abi
  functionName: string
  args: readonly unknown[]
  value?: bigint
  label?: string
}

/** One step of a multi-step action (an approval, then its payment): its own hold keys and simulation block. */
export type TxStep = TxRequest & Pick<TxSendOptions, 'recoveryNamespace' | 'recoveryLegacy' | 'simulationBlockNumber'> & {
  /** Simulate on the previous step's receipt block (a payment after its approval). */
  dependsOnPrior?: boolean
}

export type TxSendOptions = {
  /** The account this request was built for: while another is connected, nothing is reviewed or sent. */
  reviewedAccount: Address
  /** A stale-state check before each step's wallet prompt; it throws to stop with nothing sent. `prior` is where the step before confirmed. */
  reverify?: (request: TxRequest, index: number, prior?: ReviewedPriorBlock) => Promise<unknown>
  /** A flow's own record at the wallet boundary; it throws to stop with nothing sent. */
  beforeWrite?: () => unknown | Promise<unknown>
  /** Synchronous caller intent/mount check at the final wallet boundary. */
  assertWriteState?: () => void
  /** The connected Safe already queued this call: it is adopted, never proposed again. */
  onExistingProposal?: (proposal: { proposalHash: Hex; call: SafeAppCall }) => unknown | Promise<unknown>
  /** The error behind a send that failed before reaching the chain (simulation, estimate, wallet), for a flow to decode. */
  onFailure?: (error: unknown) => void
  /** Hold the whole action under this stable name, not just the exact call: a retry with another amount is held too. */
  recoveryNamespace?: string
  /** Keys an earlier version held this action under (an old namespace, or its exact call). */
  recoveryLegacy?: ReviewedCall['legacy']
  /** Simulate at or after this confirmed prerequisite block (an approval right before this write). */
  simulationBlockNumber?: bigint
  /** Plain-language sentence shown at the top of the review. */
  reviewNotice?: string
  /** What the action does, as rows at the top of its one review. */
  context?: readonly ReviewContextRow[]
  /** A multi-step action's key: its steps are one review and resume as one action after a reload. */
  scope?: string
  /** A step's wallet reply, before its receipt (a flow's own journal, its progress). */
  onStepSubmitted?: (index: number, hash: Hex, safe: boolean) => void
}

/** What a saved multi-step action shows: the steps it continues are the ones the person reviewed. */
export const SAVED_SEQUENCE_LINE = 'This continues your saved action exactly as you reviewed it. Its remaining steps are below.'

/** Homerun's wallet as core's reviewed sends use it: the connected wagmi wallet, switched to the chain each call is on. */
const walletAdapter = viemWalletAdapter({
  walletClient: () => getWalletClient(wagmiConfig),
  account: () => getAccount(wagmiConfig).address,
  chainId: () => getAccount(wagmiConfig).chainId,
  isSafe: () => isSafeConnection(wagmiConfig),
  switchChain: chainId => switchChain(wagmiConfig, { chainId: chainId as JBChainId }).catch(() => {
    throw new ReviewLineError(`Switch your wallet to ${chainName(chainId)} to continue.`)
  }),
})

/** What every reviewed send goes through: the wallet, each chain's client, and the app's one write hold. */
const reviewedSendDeps: ReviewedSendDeps = {
  adapter: walletAdapter,
  clientFor: chainId => publicClient(chainId as JBChainId),
  hold: holds,
}

/**
 * Core's send engine, out of every page's first load: a reviewed run loads it, and the review provider preloads it on intent.
 * Only its two entry points are marked used: a whole-namespace import marks every core review export used, and webpack then
 * bundles their imports into the shared chunk every page with a write hold loads.
 */
const loadReviewEngine = () => import(/* webpackExports: ["sendReviewed", "resumeReviewed", "findReviewedSequence", "discardReviewedSequence"] */ '@bananapus/nana-sdk-core/review')

const CENTER_WALLET_REFUSED = 'This action needs an external wallet. Juicebox wallet payments use their own payment review.'
const CLOSED_LINE = 'This review closed. Open the action again before sending.'

/**
 * The shared in-flight button copy: the fixed simulating/signing strings every
 * flow uses, the caller's `pending` progress text, and its `idle` label
 * (any non-in-flight phase falls through to `idle`). `confirm` overrides the
 * signing string for flows with more specific wallet copy.
 */
export function txPhaseLabel(
  phase: TxPhase,
  labels: { idle: string; pending: string; confirm?: string },
): string {
  if (phase === 'simulating') return 'Double-checking the transaction…'
  if (phase === 'signing') return labels.confirm ?? 'Confirm in your wallet…'
  if (phase === 'pending') return labels.pending
  return labels.idle
}

/** A flow's own refusal keeps its words, as it showed before: core shows only a ReviewLineError's text. */
function asLine(reason: unknown): unknown {
  return reason instanceof ReviewLineError || !(reason instanceof Error) ? reason
    : Object.assign(new ReviewLineError(transactionMessage(reason.message)), { cause: reason })
}

type Tracked = { chainId: number; account: Address; safe: boolean; namespace?: string; legacy?: ReviewedCall['legacy']; call: { to: Address; data: Hex; value?: bigint } }

/**
 * The one reviewed send every project-page write flow uses, over core's useReviewedRun: core reviews,
 * simulates, holds and sends, and follows a transaction or Safe proposal until its hold settles it.
 * This hook maps that state to the phases the flows show, and shows a hold a saved attempt's recovery
 * found (`track`) through core's useHeldWrite.
 */
export function useReviewedAction(chainId: number) {
  const { isConnected, isCenterWallet, address } = useWallet()
  const isSafe = useSafeConnection(wagmiConfig)
  const runner = useReviewedRun({
    account: address,
    ...reviewedSendDeps,
    engine: loadReviewEngine,
    guard: () => {
      if (isCenterWallet) throw new ReviewLineError(CENTER_WALLET_REFUSED)
      if (getViewAs()) throw new ReviewLineError(VIEW_AS_WRITE_BLOCKED)
    },
  })
  // Core loads its engine once this mounts; the review dialog loads at idle, so a click opens it without a wait.
  useEffect(() => preloadWhenIdle([loadReviewDialog]), [])
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  const inFlight = useRef(false)
  const [localError, setLocalError] = useState<string | null>(null)
  /** The wallet's reply for this send: a transaction, or a Safe proposal. */
  const [submission, setSubmission] = useState<{ hash: Hex; safe: boolean } | null>(null)
  const [result, setResult] = useState<ReviewedResult | null>(null)

  // A hold a saved attempt's recovery found, shown without sending.
  const [tracking, setTracking] = useState<Tracked | null>(null)
  const trackedReservation = useRef<string | null>(null)
  const [trackReceipt, setTrackReceipt] = useState<TransactionReceipt | null>(null)
  const trackView = useHeldWrite({
    hold: holds, chainId: tracking?.chainId ?? chainId, account: tracking?.account ?? zeroAddress, safe: tracking?.safe,
    namespace: tracking?.namespace, ...(tracking?.legacy ? { legacy: [...tracking.legacy] } : {}), call: tracking?.call,
    client: tracking ? publicClient(tracking.chainId as JBChainId) as WriteHoldClient : undefined,
    onSettled: (_settled, receipt) => setTrackReceipt(receipt),
  })

  // The callbacks below keep one identity, as flows key effects on them, and read the latest render.
  const live = useRef({ runner, isConnected, isCenterWallet })
  live.current = { runner, isConnected, isCenterWallet }
  const clear = useCallback(() => {
    trackedReservation.current = null
    setLocalError(null); setSubmission(null); setResult(null); setTracking(null); setTrackReceipt(null)
    live.current.runner.reset()
  }, [])

  /**
   * Show the hold of a write this flow didn't send in this page, which its saved-attempt recovery
   * found held. Nothing is sent; the hold's state is shown with its line and exit, and followed.
   */
  const track = useCallback((request: TxRequest | { chainId: number; call: { to: Address; data: Hex; value?: bigint } }, options: Pick<TxSendOptions, 'reviewedAccount' | 'recoveryNamespace' | 'recoveryLegacy'> & { safe?: boolean; reservation?: string }) => {
    if (inFlight.current) return
    // A reservation this flow already shows is watched already.
    if (options.reservation && options.reservation === trackedReservation.current) return
    trackedReservation.current = options.reservation ?? null
    setTrackReceipt(null)
    setTracking({
      chainId: request.chainId, account: options.reviewedAccount, safe: options.safe ?? isSafeConnection(wagmiConfig),
      call: 'call' in request ? request.call : callOf(request),
      ...(options.recoveryNamespace ? { namespace: options.recoveryNamespace } : {}),
      ...(options.recoveryLegacy ? { legacy: options.recoveryLegacy } : {}),
    })
  }, [])

  const send = useCallback(async (requested: TxRequest | readonly TxStep[], options: TxSendOptions): Promise<Hex | null> => {
    if (inFlight.current) return null
    const { runner, isConnected, isCenterWallet } = live.current
    if (!isConnected && !isCenterWallet && !getViewAs()) {
      setLocalError('Connect a wallet first.')
      return null
    }
    inFlight.current = true
    clear()
    const viaSafe = isSafeConnection(wagmiConfig)
    // A lone request takes its hold keys from the options; each step of an action carries its own.
    const steps: readonly TxStep[] = 'address' in requested
      ? [{ ...(requested as TxRequest), recoveryNamespace: options.recoveryNamespace, recoveryLegacy: options.recoveryLegacy, simulationBlockNumber: options.simulationBlockNumber }]
      : requested as readonly TxStep[]
    const reviewedCall = (step: TxStep): ReviewedCall => ({
      chainId: step.chainId, to: step.address, data: callOf(step).data, value: step.value ?? 0n,
      abi: step.abi, functionName: step.functionName, args: step.args,
      ...(step.label ? { label: step.label } : {}),
      ...(step.recoveryNamespace ? { intent: step.recoveryNamespace } : {}),
      ...(step.recoveryLegacy ? { legacy: step.recoveryLegacy } : {}),
      ...(step.dependsOnPrior ? { dependsOnPrior: true } : step.simulationBlockNumber !== undefined ? { simulationBlockNumber: step.simulationBlockNumber } : {}),
    })
    const requestedCalls = steps.map(reviewedCall)
    let calls = requestedCalls
    const last = steps.at(-1)!, action = calls.at(-1)!
    // A success of the action that settled while the user was away is shown with its "Send it again", never sent over.
    const away = { reviewedAccount: options.reviewedAccount, safe: viaSafe, ...(last.recoveryNamespace ? { recoveryNamespace: last.recoveryNamespace } : {}), ...(last.recoveryLegacy ? { recoveryLegacy: last.recoveryLegacy } : {}) }
    if (openStepHold(holds, options.reviewedAccount, viaSafe, action).unacknowledgedSuccess()) {
      inFlight.current = false
      track(last, away)
      return null
    }
    // A saved action with a step in flight continues exactly as reviewed; one with nothing in flight starts over.
    let saved = false
    // A sequence is the same action only on the same chain: its project IDs and amounts alone repeat across chains.
    const scope = options.scope ? `${options.scope}:chain-${last.chainId}` : undefined
    if (scope && calls.length > 1) {
      try {
        const engine = await loadReviewEngine()
        const unfinished = engine.findReviewedSequence(scope, options.reviewedAccount)
        if (unfinished && !unfinished.sending && !unfinished.proposed) await engine.discardReviewedSequence(unfinished).catch(() => { saved = true })
        else if (unfinished) saved = true
        if (saved && unfinished) calls = [...unfinished.calls]
      } catch { /* The run loads the engine again and reports its failure. */ }
    }
    const description = [saved ? SAVED_SEQUENCE_LINE : options.reviewNotice, holds.reviewLine(), viaSafe ? SAFE_NONCE_GUIDANCE : null].filter(Boolean).join('\n\n')
    const total = calls.length
    // The send resolves with the wallet's reply for the action's last step, as the flow journals it; core follows it to its receipt.
    return new Promise<Hex | null>(resolve => {
      let answered = false
      const answer = (hash: Hex | null) => { if (!answered) { answered = true; resolve(hash) } }
      void runner.run({
        account: options.reviewedAccount,
        calls,
        ...(total > 1 && scope ? { scope } : {}),
        ...(description ? { description } : {}),
        ...(!saved && options.context?.length ? { context: options.context } : {}),
        ...(viaSafe ? { confirmLabel: 'Agree & continue to Safe' } : {}),
        // A step's recheck is the flow's for that request; a saved step that differs from it (another amount, say)
        // continues as reviewed, guarded by its simulation and hold.
        ...(options.reverify ? { reverify: async (call, index, prior) => {
          const requested = requestedCalls[index]
          if (!requested || requested.chainId !== call.chainId || requested.to.toLowerCase() !== call.to.toLowerCase() || requested.data !== call.data || requested.value !== (call.value ?? 0n)) return
          await Promise.resolve(options.reverify!(steps[index], index, prior)).catch(reason => { throw asLine(reason) })
        } } : {}),
        ...(options.beforeWrite ? { beforeWallet: async () => { await Promise.resolve().then(options.beforeWrite).catch(reason => { throw asLine(reason) }) } } : {}),
        assertWriteState: () => {
          if (!mounted.current) throw new ReviewLineError(CLOSED_LINE)
          try { options.assertWriteState?.() } catch (reason) { throw asLine(reason) }
        },
        onSubmitted: async (sent, step, hash, how) => {
          if (how.adopted) await options.onExistingProposal?.({ proposalHash: hash, call: { to: sent.to, data: sent.data, value: sent.value ?? 0n } })
          options.onStepSubmitted?.(step, hash, how.safe)
          if (step !== total - 1) return
          if (mounted.current) setSubmission({ hash, safe: how.safe })
          answer(hash)
        },
      }).then(ended => {
        // Done is success only once the hold settled it: a receipt it did not verify (a same-nonce
        // replacement, a block since reorged out) leaves the call held, so the hold is shown.
        const unsettled = ended?.status === 'done' && openStepHold(holds, options.reviewedAccount, viaSafe, calls.at(-1)!).peek().status !== 'clear'
        if (ended?.status === 'failed') { if (!answered) options.onFailure?.(ended.failure) }
        else if (unsettled) { if (mounted.current) { inFlight.current = false; track(last, away) } }
        else if (mounted.current) setResult(ended)
        answer(ended?.status === 'done' ? ended.hashes.at(-1) ?? null : ended?.status === 'proposed' ? ended.safeTxHash : null)
      }, () => answer(null)).finally(() => { inFlight.current = false })
    })
  }, [clear, track])

  const shown = tracking ? (trackView.phase === 'clear' ? null : trackView) : runner.held
  const actions = tracking ? trackView : runner
  const record = shown?.state && shown.state.status !== 'clear' ? shown.state.record : null
  const heldSafe = tracking ? tracking.safe : !!record?.safe
  const trackSettled = tracking && trackView.phase === 'settled' ? trackView.settled ?? null : null

  const phase: TxPhase = tracking
    ? trackSettled ? (trackSettled.result === 'success' ? 'success' : 'error')
      : !shown || (trackView.phase === 'released' && trackView.releasedBy !== 'other-tab') ? 'idle'
        : trackView.phase === 'confirming' && !heldSafe ? 'pending' : 'submitted'
    : runner.phase === 'done' ? 'success'
      : runner.phase === 'proposed' ? 'submitted'
        : runner.phase === 'receipt' ? 'pending'
          : runner.phase !== 'idle' ? runner.phase
            : shown ? (shown.phase === 'confirming' && !heldSafe ? 'pending' : 'submitted')
              : runner.error || localError ? 'error'
                : 'idle'

  const afterExit = () => { if (mounted.current) clear() }
  const held: HeldWrite | null = shown && actions.exitAction
    ? {
        kind: 'exit', line: shown.line ?? '', label: actions.exitAction.label,
        warning: shown.warning ?? (record ? writeExitMessage(record.call) : undefined),
        release: async () => {
          try {
            if (!(await actions.exitAction!.run())) return false
          } catch (reason) { setLocalError(reason instanceof Error ? reason.message : String(reason)); return false }
          afterExit()
          return true
        },
      }
    : shown && actions.sendAgainAction
      ? {
          kind: 'send-again', line: shown.line ?? '', label: actions.sendAgainAction.label,
          release: async () => {
            try { await actions.sendAgainAction!.run() } catch (reason) { setLocalError(reason instanceof Error ? reason.message : String(reason)); return false }
            afterExit()
            return true
          },
        }
      : null

  const failure = runner.failure
  const receipt: TransactionReceipt | null = tracking
    ? trackReceipt
    : result?.status === 'done' ? result.receipts.at(-1) ?? null
      : runner.receipt ?? (failure instanceof ReviewedCallRevertedError ? failure.receipt : null)
  const submissionHash = tracking ? record?.hash ?? null : submission?.hash ?? null
  const hash = tracking
    ? trackReceipt?.transactionHash ?? (heldSafe ? null : record?.hash ?? null)
    : result?.status === 'done' ? result.hashes.at(-1) ?? null
      : runner.receipt?.transactionHash ?? (submission && !submission.safe ? submission.hash : null)
  const safeProposalHash = phase === 'submitted' && heldSafe ? (tracking ? record?.hash ?? null : runner.safeTxHash ?? submission?.hash ?? null) : null
  const notice = [phase === 'submitted' ? shown?.line : null, shown?.notice].filter(Boolean).join(' ') || null
  const error = localError ?? (phase === 'error' ? (trackSettled ? settledLine(trackSettled) : runner.error) : null)

  const reset = useCallback(() => {
    if (inFlight.current) return
    clear()
  }, [clear])

  return {
    phase,
    /** True while the transaction is in flight: simulating/signing/pending. */
    busy: phase === 'simulating' || phase === 'signing' || phase === 'pending',
    /** The confirm can end on Done: the transaction succeeded, or a Safe or the hold has it. */
    settled: phase === 'success' || phase === 'submitted',
    /** The one line a `submitted` confirm shows: the hold's. */
    notice,
    /** Whether the connected writer is a Safe connector. */
    isSafe,
    error,
    /** The write was mined and failed (a revert, or a Safe execution that failed): its receipt says so, not why. */
    reverted: phase === 'error' && !!receipt,
    hash,
    /** The wallet-returned identity, including a Safe proposal before execution. */
    submissionHash,
    safeProposalHash,
    safeNonceGuidance: safeProposalHash ? SAFE_NONCE_GUIDANCE : null,
    receipt,
    /** A write the chain has not placed, with the user's one exit, or a success settled while away; null otherwise. */
    held,
    /** The transaction has a hash, but its result could not be confirmed here. */
    confirmationUncertain: !!actions.exitAction || shown?.phase === 'held',
    /** The step of a multi-step action the run is on, of `total`. */
    step: runner.step,
    total: runner.total,
    /** The step a Safe was proposed, when a multi-step run stopped there for the Safe to execute it. */
    proposedStep: !tracking && result?.status === 'proposed' ? result.step : null,
    send,
    track,
    reset,
    /** Close the current confirmation. The hold keeps the write; dismissing is never evidence that it can be sent again. */
    dismiss: reset,
  }
}
