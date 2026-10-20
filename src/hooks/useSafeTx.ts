'use client'

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { getAccount } from '@wagmi/core'
import {
  BaseError,
  isHash,
  zeroAddress,
  type Abi,
  type Address,
  type Hex,
  type TransactionReceipt,
} from 'viem'
import {
  usePublicClient,
  useSwitchChain,
  useWaitForTransactionReceipt,
  useWriteContract,
} from 'wagmi'
import { useWallet } from '@/hooks/useWallet'
import { useHeldSend, useHeldWrite, type HeldSendInput } from '@bananapus/nana-sdk-core/review/react'
import { submitReviewedContractWrite } from '@/lib/contract-write'
import {
  gasWithHeadroom, sameReviewedWrite, settledLine, SubmittedContractWriteError, WRITE_EXIT_LABEL, SAFE_PROPOSAL_REPLACED_LINE,
  HELD_AWAY_SUCCESS_LINE, HELD_SEND_AGAIN_LABEL, waitForTrackedReceipt, transactionMessage, WRITE_HOLD_PENDING_LINE, WRITE_HOLD_REVERTED_LINE, writeExitMessage, writeHeldMessage,
  WriteHeldError, WriteHoldBusyError, WriteHoldNonceError, WriteHoldStaleReviewError,
  type HeldWriteView, type ReviewedWriteRecoveryRecord, type WriteHeldState, type WriteHoldClient, type WriteHoldGate, type WriteHoldHandle, type WriteHoldSettled, type WriteHoldState,
} from '@bananapus/nana-sdk-core/review'
import { callOf, holds } from '@/lib/write-hold'
import { hasSafeService } from '@bananapus/nana-sdk-core/safe-service'
import { getViewAs, VIEW_AS_WRITE_BLOCKED } from '@/lib/viewAs'
import {
  requestContractTransactionReview,
  TransactionReviewCancelledError,
} from '@/lib/transaction-review'
import { chainName } from '@/lib/urn'
import { assertReviewedWallet } from '@/lib/wallet-core'
import { wagmiConfig } from '@/providers/Providers'
import {
  atOnceExecution,
  chainAnswer,
  findPendingSafeAppProposal,
  heldCall,
  isSafeConnection,
  readSafeAppExecution,
  reportedSafeExecution,
  SAFE_NONCE_GUIDANCE,
  SAFE_PROPOSAL_AWAITING,
  SAFE_PROPOSAL_UNCONFIRMED,
  useSafeConnection,
  waitForSafeExecutionHash,
  watchSafeProposal,
  type SafeAppCall,
} from '@/lib/safe-connector'

/** How long the block-subscription watcher gets before its silence is reported. */
const RECEIPT_WATCH_TIMEOUT_MS = 120_000
const RECEIPT_POLL_INTERVAL_MS = 4_000

/** ~10 minutes of direct lookups, matching the watcher's own retry horizon. */
const RECEIPT_POLL_ATTEMPTS = 150

type PolledReceipt = NonNullable<
  Awaited<ReturnType<NonNullable<ReturnType<typeof usePublicClient>>['getTransactionReceipt']>>
>

export type TxPhase =
  | 'idle'
  | 'review'
  | 'simulating'
  | 'signing'
  | 'pending'
  /** With a Safe, and not settled here: awaiting its signers, or its result unproven. */
  | 'submitted'
  | 'success'
  | 'error'

type FollowClient = NonNullable<ReturnType<typeof usePublicClient>>

export type TxRequest = {
  chainId: number
  address: `0x${string}`
  abi: Abi
  functionName: string
  args: readonly unknown[]
  value?: bigint
  label?: string
}

export type TxSendOptions = {
  /**
   * The account this request was built for: the one that reviewed it, and
   * whose beneficiary, holder or recipient it names when it names one. Only
   * that account may send it: while another is connected, nothing is reviewed
   * or sent (see contract-write.ts).
   */
  reviewedAccount: Address
  reverify?: (request: TxRequest) => Promise<unknown>
  /** Additional preflight work; this does not replace the durable recovery owner. */
  beforeWrite?: () => unknown | Promise<unknown>
  /** Synchronous caller intent/mount check at the final wallet boundary. */
  assertWriteState?: () => void
  /** Adopt known proposal facts without simulating or marking a new wallet write. */
  onExistingProposal?: (proposal: { proposalHash: Hex; call: SafeAppCall }) => unknown | Promise<unknown>
  /** Called if the final account gate aborts a persisted intent before the wallet write. */
  onBeforeWriteAborted?: () => unknown | Promise<unknown>
  /** Called only for a typed, explicit wallet rejection of the write itself. */
  onWriteRejected?: () => unknown | Promise<unknown>
  /** The error behind a send that failed before reaching the chain (simulation, estimate, wallet), for a flow to decode. */
  onFailure?: (error: unknown) => void
  /**
   * Hold the whole action under this stable name, not just the exact call: an earlier
   * attempt with another amount then holds a new one (a project's updates, say).
   */
  recoveryNamespace?: string
  /** Keys an earlier version held this action under (an old namespace, or its exact call). */
  recoveryLegacy?: HeldSendInput['legacy']
  /**
   * The exact request was already rendered in a parent confirmation surface.
   * This skips only the second app-owned review; account checks, revalidation,
   * simulation, duplicate protection, and the wallet confirmation still run.
   */
  reviewedInParent?: boolean
  /**
   * Simulate against a confirmed prerequisite block instead of a load
   * balancer's potentially lagging `latest` view. This is required when the
   * reviewed write immediately follows an ERC-20 or Permit2 approval.
   */
  simulationBlockNumber?: bigint
  /**
   * Plain-language sentence shown at the top of the mandatory review — for
   * when the freshly re-quoted payload is materially worse than what the
   * caller's panel displayed. Raw fixed-point arguments alone are not
   * effective disclosure of that.
   */
  reviewNotice?: string
}

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

/** A friendly one-line message out of a viem/wagmi error. */
function friendlyTxError(e: unknown): string {
  if (e instanceof BaseError) {
    const short = e.shortMessage || e.message
    if (/user rejected|denied/i.test(short)) return 'Transaction cancelled.'
    return transactionMessage(short)
  }
  if (e instanceof Error) return transactionMessage(e.message)
  return 'Something went wrong.'
}

// ── Safe proposals ───────────────────────────────────────────────────────────

/** Where a Safe proposal is, as its follow reads it. */
type ProposalPhase =
  /** The reply may be the execution itself: Safe{Wallet} executing at once. */
  | 'checking'
  /** With the Safe, awaiting its signers. */
  | 'awaiting'
  /** Executed: its receipt is being read. */
  | 'executing'
  /**
   * Executed, and not confirmed yet: its receipt still missing (held until it
   * arrives, or an hour after the execution was seen), or its transaction not
   * yet shown by a node behind its receipt.
   */
  | 'confirming'
  | 'success'
  | 'failed'
  /** Over, but this app can't prove it ran: held until the user dismisses it. */
  | 'unproven'
  /** Its deadline passed before the Safe ran it, so the contract refuses it now. */
  | 'expired'
  /** The Safe's nonce moved past it without running it. */
  | 'replaced'

/** How a flow shows each: in flight, with the Safe, or settled. */
const SHOWN_AS: Record<ProposalPhase, TxPhase> = {
  checking: 'pending',
  executing: 'pending',
  awaiting: 'submitted',
  confirming: 'submitted',
  unproven: 'submitted',
  success: 'success',
  failed: 'error',
  expired: 'error',
  replaced: 'error',
}

/** A shown hold is asked again this often, so an exit that becomes due with time appears. */
const HOLD_POLL_MS = 15_000
const SAFE_EXECUTION_CONFIRMING = 'Executed by your Safe. Confirming it onchain.'
/** What a Safe app replied in place of a proposal or execution hash. */
const SAFE_REPLY_UNREADABLE = 'Safe did not return a proposal hash. Check Safe before sending this again.'
const SAFE_PROPOSAL_EXPIRED = "This Safe proposal's deadline passed. Review it again."
/** A receipt still missing this long after its execution was first seen is not coming. */
const RECEIPT_HORIZON_MS = 60 * 60_000
/** Past the horizon, a known execution's receipt is asked for this often. */
const RECEIPT_RETRY_MS = 30_000

type SafeProposal = {
  chainId: number
  safe: Address
  call: SafeAppCall
  /** The safeTxHash, or the execution's own hash when Safe{Wallet} executed at once. */
  proposalHash: Hex
  phase: ProposalPhase
  executionHash: Hex | null
  receipt: TransactionReceipt | null
  /** The line for an end other than success: failed, unproven, expired or replaced. */
  message: string | null
  /** The follower authenticated that this exact proposal ran: its execution is proof, not a report. */
  proven?: boolean
}

/**
 * Every Safe proposal made here this session, by chain, Safe and the call it
 * holds: the exact call, with any field stamped at send time blanked
 * ({@link heldCall}). Every useSafeTx shares it and the registry follows each
 * proposal itself, so a flow that closes, remounts or changes chain never
 * drops one, and the same action is never proposed twice while one is
 * pending. Nothing is persisted: a reload starts empty, and Safe's own queue
 * answers for what it holds.
 */
const proposals = new Map<string, SafeProposal>()
const followingProposals = new Set<string>()
const proposalListeners = new Set<() => void>()

function subscribeProposals(listener: () => void): () => void {
  proposalListeners.add(listener)
  return () => {
    proposalListeners.delete(listener)
  }
}

function notifyProposals(): void {
  for (const listener of proposalListeners) listener()
}

function proposalKey(chainId: number, safe: Address, call: SafeAppCall): string {
  const held = heldCall(call)
  return `${chainId}:${safe.toLowerCase()}:${held.to.toLowerCase()}:${held.value ?? 0n}:${held.data.toLowerCase()}`
}

function updateProposal(key: string, next: Partial<SafeProposal>): void {
  const current = proposals.get(key)
  if (!current) return
  proposals.set(key, { ...current, ...next })
  notifyProposals()
}

/** A distinct execution hash cannot make the original Safe proposal safe to repeat. */
function unconfirmedProposal(key: string, message = SAFE_PROPOSAL_UNCONFIRMED): Partial<SafeProposal> {
  const proposal = proposals.get(key)
  const knownProposal = proposal?.executionHash &&
    proposal.executionHash.toLowerCase() !== proposal.proposalHash.toLowerCase()
  return { phase: knownProposal ? 'awaiting' : 'unproven', message }
}

/** Rechecks use the same follower; concurrent flows never start a second one. */
function startFollowingProposal(key: string, client: FollowClient, reply: boolean): void {
  if (followingProposals.has(key)) return
  followingProposals.add(key)
  void followProposal(key, client, reply)
    .catch(() => updateProposal(key, unconfirmedProposal(key)))
    .finally(() => followingProposals.delete(key))
}

/**
 * A proposal holds its call until it ends: while pending, and when unproven
 * until dismissed. It ends with a result, or once it can no longer run.
 */
function holdsCall(proposal: SafeProposal | undefined): proposal is SafeProposal {
  return !!proposal && SHOWN_AS[proposal.phase] !== 'success' && SHOWN_AS[proposal.phase] !== 'error'
}

/** The execution a proposal awaiting its signers runs in, or how it ends before it runs. */
type Outcome = { executionHash: Hex } | { phase: ProposalPhase; message: string }

/**
 * Waits for the proposal's execution, from Safe's service and the chain, and
 * where the service lists the proposal, watches it: it ends early when its
 * deadline passes before the Safe ran it, or when the Safe's nonce moves past
 * it ({@link watchSafeProposal}). Whichever answers first stops the other.
 */
async function awaitExecution(
  { chainId, safe, proposalHash }: SafeProposal,
  client: FollowClient,
): Promise<Outcome> {
  const stop = new AbortController()
  const executed = waitForSafeExecutionHash(chainId, proposalHash, { client, signal: stop.signal }).then(
    (executionHash): Outcome => ({ executionHash }),
    async (reason: unknown): Promise<Outcome> => {
      // Safe's service says it ran and failed: the execution its record names decides.
      const reported = await reportedSafeExecution(reason, chainId, safe, proposalHash)
      return reported
        ? { executionHash: reported }
        : { phase: 'unproven', message: `${SAFE_PROPOSAL_UNCONFIRMED} ${friendlyTxError(reason)}` }
    },
  )
  const ended = hasSafeService(chainId)
    ? watchSafeProposal(client, chainId, safe, proposalHash, stop.signal).then(
        (end): Promise<Outcome> | Outcome =>
          end === 'expired'
            ? { phase: 'expired', message: SAFE_PROPOSAL_EXPIRED }
            // The Safe's nonce passed this proposal at a finalized block and its events name it:
            // the execution's own hash still decides the result.
            : end === 'executed'
              ? executed
              : { phase: 'replaced', message: SAFE_PROPOSAL_REPLACED_LINE },
      )
    : new Promise<never>(() => {})
  try {
    return await Promise.race([executed, ended])
  } finally {
    stop.abort()
  }
}

/**
 * Follow a proposal to its result, whatever becomes of the flow that made it.
 * It ends unproven only on the chain's last word ({@link chainAnswer}): a
 * node that can't answer keeps it held, and is asked again a minute later.
 */
async function followProposal(key: string, client: FollowClient, reply: boolean): Promise<void> {
  const proposal = proposals.get(key)
  if (!proposal) return
  const { safe, call, proposalHash } = proposal
  // A reply the chain knows as a transaction is the execution itself; the
  // transaction read here is the one the execution is bound on.
  let execution = reply ? await atOnceExecution(client, proposalHash) : null
  let executionHash = execution ? proposalHash : null
  if (!executionHash) {
    updateProposal(key, { phase: 'awaiting' })
    const awaited = await awaitExecution(proposal, client)
    if ('executionHash' in awaited) executionHash = awaited.executionHash
    // An execution returned at once that the node learned only after the probe
    // is the execution: the chain is asked once more before the proposal ends.
    else if (
      awaited.phase === 'unproven' &&
      (execution = await chainAnswer(() => client.getTransaction({ hash: proposalHash })))
    ) {
      executionHash = proposalHash
    } else {
      updateProposal(key, awaited.phase === 'unproven' ? unconfirmedProposal(key, awaited.message) : awaited)
      return
    }
  }
  updateProposal(key, { phase: 'executing', executionHash })
  const failed = `Safe executed the proposal, but the onchain transaction failed (${executionHash}).`
  // The execution was first seen now: its receipt has an hour from here.
  const seenAt = Date.now()
  let receipt: TransactionReceipt | null = null
  while (!receipt) {
    receipt = await waitForTrackedReceipt(client, executionHash).catch(() => null)
    if (receipt) break
    if (Date.now() - seenAt >= RECEIPT_HORIZON_MS) {
      const hash = executionHash
      receipt = await chainAnswer(() => client.getTransactionReceipt({ hash }))
      if (receipt) break
      // A known execution stays held until its receipt decides it: success or failure, never a timer.
      updateProposal(key, { phase: 'confirming' })
      await new Promise(resolve => setTimeout(resolve, RECEIPT_RETRY_MS))
      continue
    }
    updateProposal(key, { phase: 'confirming' })
  }
  if (receipt.status !== 'success') {
    updateProposal(key, {
      ...(executionHash.toLowerCase() === proposalHash.toLowerCase()
        ? { phase: 'failed' as const, message: failed }
        : unconfirmedProposal(key)),
      receipt,
    })
    return
  }
  // Only the Safe's own event for this proposal decides it, and an execution
  // returned at once must also have run the reviewed call. Its receipt proves
  // its transaction exists, so with none read yet, a node that shows none is
  // only behind: the proposal stays held, and can end its confirm on Done.
  const atOnce = receipt.transactionHash.toLowerCase() === proposalHash.toLowerCase()
  const transaction =
    atOnce && !execution
      ? await chainAnswer(() => client.getTransaction({ hash: proposalHash }), {
          exists: true,
          onRetry: () => updateProposal(key, { phase: 'confirming' }),
        })
      : execution
  const { status } = await readSafeAppExecution({
    client: {
      getTransaction: async () => {
        if (!transaction) throw new Error(`The chain has no transaction ${proposalHash}.`)
        return transaction
      },
    },
    receipt,
    safe,
    proposalHash,
    calls: [call],
  }).catch(() => ({ status: 'unproven' as const }))
  updateProposal(
    key,
    status === 'success'
      ? { phase: 'success', receipt, proven: true }
      : status === 'failed'
        ? { phase: 'failed', receipt, message: failed, proven: true }
        : { ...unconfirmedProposal(key), receipt },
  )
}

/** Record a proposal and follow it; `reply` says whether the hash is the wallet's own answer. */
function recordProposal(
  proposal: Pick<SafeProposal, 'chainId' | 'safe' | 'call' | 'proposalHash'>,
  client: FollowClient,
  reply: boolean,
): string {
  const key = proposalKey(proposal.chainId, proposal.safe, proposal.call)
  proposals.set(key, {
    ...proposal,
    phase: reply ? 'checking' : 'awaiting',
    executionHash: null,
    receipt: null,
    message: null,
  })
  notifyProposals()
  startFollowingProposal(key, client, reply)
  return key
}

/**
 * The one transaction pipeline every project-page write flow uses
 * (website/ parity: exact review → simulate → send → status):
 *
 * 1. `send(request)` opens the global exact-payload review, then switches
 *    chains if needed and SIMULATES the approved call
 *    (nothing is ever sent that doesn't simulate clean), then requests the
 *    wallet signature and tracks the receipt.
 * 2. Phases drive the caller's UI; `error` carries a friendly message.
 */
export function useSafeTx(chainId: number) {
  const { isConnected, isCenterWallet } = useWallet()
  const publicClient = usePublicClient({ chainId })
  const { writeContractAsync } = useWriteContract()
  const { switchChainAsync } = useSwitchChain()
  const isSafe = useSafeConnection(wagmiConfig)

  const [phase, setPhase] = useState<TxPhase>('idle')
  const [error, setError] = useState<string | null>(null)
  /** The transaction an ordinary send is waiting on. */
  const [hash, setHash] = useState<`0x${string}` | null>(null)
  /** The Safe proposal this flow shows, by its key in the registry. */
  const [shownKey, setShownKey] = useState<string | null>(null)
  const proposal = useSyncExternalStore(
    subscribeProposals,
    () => (shownKey ? proposals.get(shownKey) : undefined),
    () => undefined,
  )
  const inFlightRef = useRef(false)
  const mounted = useRef(false)
  const generation = useRef(0)
  /** The reservation `track` last showed: recovery that finds it again shows it already. */
  const trackedReservation = useRef<string | null>(null)
  /**
   * The SDK's held-write views: `useHeldSend` for each send (its watch, exit and send gate; this hook
   * follows the hash itself), `useHeldWrite` for a hold this flow shows without sending (`track`).
   */
  const onSettled = useRef((_settled: WriteHoldSettled, _receipt: TransactionReceipt | null) => {})
  const heldSend = useHeldSend({ hold: holds, client: publicClient as WriteHoldClient | undefined, pollMs: HOLD_POLL_MS, follow: false, onSettled: (settled, settledReceipt) => onSettled.current(settled, settledReceipt) })
  const sendRef = useRef(heldSend.send)
  sendRef.current = heldSend.send
  const [tracking, setTracking] = useState<{ chainId: number; account: Address; safe: boolean; namespace?: string; call: { to: Address; data: Hex; value?: bigint } } | null>(null)
  const heldTrack = useHeldWrite({
    hold: holds, chainId: tracking?.chainId ?? chainId, account: tracking?.account ?? zeroAddress, safe: tracking?.safe,
    namespace: tracking?.namespace, call: tracking?.call, client: tracking ? publicClient as WriteHoldClient | undefined : undefined,
    pollMs: HOLD_POLL_MS, onSettled: (settled, settledReceipt) => onSettled.current(settled, settledReceipt),
  })
  /** Which view this flow shows: its send's, or a tracked hold's. */
  const [mode, setMode] = useState<'send' | 'track' | null>(null)
  const shownHold = mode === 'send' ? heldSend : mode === 'track' ? heldTrack : null
  const hold = shownHold?.handle ?? null
  const [held, setHeld] = useState<WriteHeldState | null>(null)
  /** A success the hold settled while this flow was away: no send goes out until the user says "Send it again". */
  const [awaySuccess, setAwaySuccess] = useState(false)
  /** The send generation the hold was opened in: a later reset, exit or chain change stops its states. */
  const holdAt = useRef(-1)
  /** The wallet is being handed the call: a hold with no hash yet is the send, not a lost reply. */
  const sending = useRef(false)
  /** The returned hash this flow already follows. */
  const tracked = useRef<Hex | null>(null)
  /** How the call's earlier write settled where this flow didn't see it. */
  const [settledNotice, setSettledNotice] = useState<string | null>(null)
  /** The SDK's own notice on the hold's states: that holds last in this tab alone, say. */
  const [holdNotice, setHoldNotice] = useState<string | null>(null)
  /** The hold reservation this flow follows: states of another one (another tab's later attempt) are not its own. */
  const reservation = useRef<string | null>(null)
  /** A write with a durable domain journal has no generic hold; its wallet may still have lost the reply. */
  const [recoveryNotice, setRecoveryNotice] = useState<string | null>(null)
  /** The receipt of a write the hold settled where this flow didn't follow it (adopted, or another tab's). */
  const [settledReceipt, setSettledReceipt] = useState<TransactionReceipt | null>(null)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; generation.current += 1 }
  }, [chainId])

  const receipt = useWaitForTransactionReceipt({
    hash: hash ?? undefined,
    chainId,
    // Bounded: a stalled watcher must surface as "confirmation unavailable",
    // never as a spinner that outlives the transaction it is watching.
    timeout: RECEIPT_WATCH_TIMEOUT_MS,
    query: { enabled: !!hash },
  })

  // The watcher subscribes to new blocks and can sit pending forever on some
  // wallet/RPC pairs even after the transaction mined (it stranded pay flows
  // at "Confirming onchain…" after a Permit2 approval). A plain receipt lookup
  // on an interval is the second source of truth; whichever answers first wins.
  const [polledReceipt, setPolledReceipt] = useState<PolledReceipt | null>(null)
  useEffect(() => {
    setPolledReceipt(null)
    if (!hash || !publicClient) return
    if (typeof publicClient.getTransactionReceipt !== 'function') return
    let cancelled = false
    let attempts = 0
    const timer = setInterval(() => {
      attempts += 1
      if (attempts > RECEIPT_POLL_ATTEMPTS) {
        clearInterval(timer)
        return
      }
      void publicClient
        .getTransactionReceipt({ hash })
        .then(found => {
          if (cancelled || !found) return
          clearInterval(timer)
          setPolledReceipt(found)
        })
        .catch(() => undefined)
    }, RECEIPT_POLL_INTERVAL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [hash, publicClient])
  // React Query may retain the prior query's data while a new hash starts.
  // Only a receipt for this exact transaction can settle this action.
  const receiptData = hash
    ? [receipt.data, polledReceipt].find(
        candidate => candidate?.transactionHash?.toLowerCase() === hash.toLowerCase(),
      )
    : undefined

  const receiptReverted = phase === 'pending' && receiptData?.status === 'reverted'
  // The receipt watch gave up on a transaction that has a hash. It may still
  // land, so it stays held and followed, but nothing is in flight to hold a
  // dialog open for: Done closes it, with the hold's line.
  const watchGaveUp = !shownKey && phase === 'pending' && receipt.isError && !receiptData
  /** A timed-out send is still followed: closing keeps it shown, so its receipt or exit lands here. */
  const following = useRef(false)
  following.current = watchGaveUp
  // A Safe proposal's state is the registry's. Its confirm ends on Done while
  // the signers decide, and when its result can't be proven here; no send of
  // its action goes out until it ends, or the user dismisses an unproven
  // result after its line. One the registry no longer holds (dismissed in
  // another flow) shows nothing.
  const shownPhase: TxPhase = shownKey
    ? proposal
      ? SHOWN_AS[proposal.phase]
      : 'idle'
    // A held write's success shows only once the hold verified it and let go, never from the raw receipt.
    : phase === 'pending' && receiptData?.status === 'success' && !hold
      ? 'success'
      : receiptReverted
        ? 'error'
        : watchGaveUp
          ? 'submitted'
          : phase
  // A success settles only once the hold has verified it and let go.
  const effectivePhase: TxPhase = held?.exit ? 'submitted' : held && shownPhase === 'success' ? 'pending' : shownPhase
  const shownNotice = held && held.status !== 'pending-known-hash' ? held.line
    : watchGaveUp ? (held?.line ?? WRITE_HOLD_PENDING_LINE) : recoveryNotice ?? (
    proposal?.phase === 'awaiting'
      ? (proposal.message ?? SAFE_PROPOSAL_AWAITING)
      : proposal?.phase === 'confirming'
        ? SAFE_EXECUTION_CONFIRMING
        : proposal?.phase === 'unproven'
          ? (proposal.message ?? SAFE_PROPOSAL_UNCONFIRMED)
          : settledNotice)
  const notice = [shownNotice, holdNotice].filter(Boolean).join(' ') || null
  const effectiveError = shownKey
    ? proposal && SHOWN_AS[proposal.phase] === 'error'
      ? proposal.message
      : null
    : receiptReverted
      ? hold ? WRITE_HOLD_REVERTED_LINE : `Transaction reverted onchain${hash ? ` (${hash})` : ''}.`
      : error
  const awaitingProposal =
    proposal?.phase === 'checking' || proposal?.phase === 'awaiting' ? proposal.proposalHash : null

  useEffect(() => {
    if (effectivePhase === 'success' || effectivePhase === 'error') inFlightRef.current = false
  }, [effectivePhase])

  // Product owners verify FUND/INCOME effects and invalidate their exact
  // project queries; a Safe proposal alone never refreshes financial state.

  /** Follow a saved write's returned identity: a Safe proposal, or the transaction itself. */
  const trackSubmitted = useCallback((record: ReviewedWriteRecoveryRecord, client: FollowClient) => {
    if (!record.hash) return
    tracked.current = record.hash
    if (!record.safe) { setHash(record.hash); return }
    const call = { ...record.call, value: BigInt(record.call.value) }
    const key = proposalKey(record.chainId, record.account, call)
    // A proposal the registry already follows keeps its place.
    setShownKey(holdsCall(proposals.get(key)) ? key
      : recordProposal({ chainId: record.chainId, safe: record.account, call, proposalHash: record.hash }, client, true))
  }, [])

  /**
   * Show what the hold says: a write the chain has not placed, a hash to follow, or its end. `shown`
   * is the SDK view's reading of it (released elsewhere, or a success settled while away).
   */
  const apply = useCallback((state: WriteHoldState | null, client: FollowClient, shown?: HeldWriteView) => {
    if (!mounted.current) return
    if (state?.reservation && reservation.current && state.reservation !== reservation.current) return
    if (state && state.status !== 'clear' && state.reservation) reservation.current = state.reservation
    if (shown) setAwaySuccess(shown.phase === 'succeeded')
    if (shown?.phase === 'succeeded') {
      setHeld(null); setHoldNotice(null); setSettledNotice(shown.line)
      inFlightRef.current = false
      setPhase('submitted')
      return
    }
    setHoldNotice(state?.notice ?? null)
    if (!state || state.status === 'clear') {
      setHeld(null)
      // Released by another window: nothing proves it ran.
      if (shown?.phase === 'released' && shown.releasedBy === 'other-tab') { setRecoveryNotice(shown.line); setPhase('submitted') }
      return
    }
    if (sending.current && state.status === 'held-no-hash') return
    setHeld(state)
    if (state.exit) {
      inFlightRef.current = false
      setPhase('submitted')
    } else if (state.record.hash) {
      if (tracked.current !== state.record.hash) trackSubmitted(state.record, client)
      setPhase('pending')
    }
  }, [trackSubmitted])

  /** The hold settled what this flow saw held, on authenticated evidence: its result shows here. */
  onSettled.current = (settled, settledReceipt) => {
    if (!mounted.current || holdAt.current !== generation.current) return
    if (!('hash' in settled)) {
      if (!tracked.current) { setError(SAFE_PROPOSAL_EXPIRED); setPhase('error') }
      return
    }
    const untracked = !tracked.current
    // A Safe proposal's own hash is followed through its registry entry, which shows its result.
    if (!untracked && tracked.current!.toLowerCase() !== settled.hash.toLowerCase()) return
    tracked.current = settled.hash
    // The view read this settlement's receipt: the flow verifies its result from it, whoever else watches.
    if (settledReceipt) setSettledReceipt(settledReceipt)
    if (settled.result === 'success') setPhase('success')
    else { setError(WRITE_HOLD_REVERTED_LINE); setPhase('error') }
  }

  // Whatever the shown view says reaches this flow's state.
  const shownState = shownHold?.state, shownPhase_ = shownHold?.phase, shownLine = shownHold?.line, shownExit = shownHold?.exit, shownBy = shownHold?.releasedBy, shownNote = shownHold?.notice
  useEffect(() => {
    if (!shownHold || !publicClient || holdAt.current !== generation.current) return
    apply(shownState ?? null, publicClient, shownHold)
  // The view's snapshot fields are what it shows.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, shownState, shownPhase_, shownLine, shownExit, shownBy, shownNote, apply])

  // A verified receipt releases the hold; a revert only once it is final.
  useEffect(() => {
    const confirmed = shownKey ? proposal?.receipt : receiptData
    if (hold && confirmed && publicClient) void hold.onReceipt(confirmed, publicClient).catch(() => null)
  }, [hold, shownKey, proposal?.receipt, receiptData, publicClient])
  // The follower's proven Safe execution is kept through a reload until its result settles it. A hash
  // the follower only saw (an execution returned at once, or the service's report) is never saved as one.
  const executionHash = shownKey && proposal?.proven ? proposal.executionHash : null
  useEffect(() => {
    if (hold && executionHash && publicClient) void hold.onExecuted(publicClient, executionHash).catch(() => null)
  }, [hold, executionHash, publicClient])
  // A proposal the follower saw expire or lose its nonce is the hold's to end or to offer the exit for.
  const proposalEnd = proposal?.phase === 'expired' || proposal?.phase === 'replaced'
  useEffect(() => {
    if (hold && proposalEnd && publicClient) void hold.state(publicClient).catch(() => null)
  }, [hold, proposalEnd, publicClient])
  // The follower ended without proof: the hold offers the exit, and later evidence still settles it.
  const unprovenHash = proposal?.phase === 'unproven' ? proposal.proposalHash : null
  useEffect(() => {
    if (hold && unprovenHash && publicClient) void hold.onUnproven(publicClient, unprovenHash).catch(() => null)
  }, [hold, unprovenHash, publicClient])

  /** The user checked their wallet: end the hold so the action can be sent again. True when released. */
  const exitAction = shownHold?.exitAction, sendAgainAction = shownHold?.sendAgainAction
  const release = useCallback(async (): Promise<boolean> => {
    if (!exitAction || !held?.exit) return false
    try {
      // The hold asks the chain again as the exit is taken, and shows what it finds instead of releasing.
      if (!(await exitAction.run())) return false
      // The registry's view of the proposal goes with it, so the next send asks Safe's queue again.
      const { record } = held
      if (record.safe && proposals.delete(proposalKey(record.chainId, record.account, { ...record.call, value: BigInt(record.call.value) }))) notifyProposals()
      generation.current += 1
      inFlightRef.current = false
      tracked.current = null
      setHeld(null); setHash(null); setShownKey(null); setError(null); setRecoveryNotice(null); setPhase('idle')
      return true
    } catch (reason) { setError(friendlyTxError(reason)); return false }
  }, [exitAction, held])

  /** The user saw a success that settled while they were away and chose to send again. */
  const sendAgain = useCallback(async (): Promise<boolean> => {
    if (!sendAgainAction) return false
    try { await sendAgainAction.run() } catch (reason) { setError(friendlyTxError(reason)); return false }
    inFlightRef.current = false
    setAwaySuccess(false); setSettledNotice(null); setError(null); setPhase('idle')
    return true
  }, [sendAgainAction])

  const send = useCallback(
    async (
      request: TxRequest,
      options: TxSendOptions,
    ) => {
      if (inFlightRef.current) return null
      if (isCenterWallet) {
        setError('This action needs an external wallet. Juicebox wallet payments use their own payment review.')
        setPhase('error')
        return null
      }
      if (getViewAs()) {
        setError(VIEW_AS_WRITE_BLOCKED)
        setPhase('error')
        return null
      }
      if (!isConnected || !publicClient) {
        setError('Connect a wallet first.')
        setPhase('error')
        return null
      }
      inFlightRef.current = true
      const at = generation.current
      const assertCurrent = () => {
        if (!mounted.current || generation.current !== at) throw new Error('This review closed. Open the action again before sending.')
      }
      setError(null)
      setHash(null)
      setShownKey(null)
      setPolledReceipt(null)
      tracked.current = null
      reservation.current = null
      setSettledNotice(null)
      setHoldNotice(null)
      setAwaySuccess(false)
      setHeld(null)
      setRecoveryNotice(null)
      setSettledReceipt(null)
      // Read once: the review, the sent gas and the proposal tracking must all
      // agree on whether a Safe proposes this call.
      const viaSafe = isSafeConnection(wagmiConfig)
      const account = options.reviewedAccount
      const connectorUid = getAccount(wagmiConfig).connector?.uid
      // Where the browser refuses to store a hold, the tab's memory holds it, and the review says so.
      const reviewNotice = [options.reviewNotice, holds.reviewLine()].filter(Boolean).join('\n\n') || undefined
      let current: WriteHoldHandle | undefined
      try {
        /** The exact call simulated and sent, which a Safe execution must run. */
        let sentCall = callOf(request)
        const input = { chainId: request.chainId, account, safe: viaSafe, call: sentCall }
        const reviewedSnapshot: ReviewedWriteRecoveryRecord = {
          version: 1, id: 'review', ...input, call: { ...input.call, value: String(input.call.value ?? 0n) },
        }
        const assertReviewedRequest = () => {
          if (!sameReviewedWrite(reviewedSnapshot, { ...input, chainId: request.chainId, call: callOf(request) })) {
            throw new Error('The reviewed transaction changed. Review it again.')
          }
        }
        // Every write is held by the SDK; this handle reads it for the error paths below.
        const namespace = options.recoveryNamespace ? { namespace: options.recoveryNamespace } : {}
        current = holds.open({ ...input, ...namespace }, options.recoveryLegacy ? { legacy: options.recoveryLegacy } : undefined)
        holdAt.current = at
        setTracking(null); setMode('send')
        const execute = async (gate?: WriteHoldGate) => {
          assertCurrent()
          if (viaSafe) {
            // An action the Safe already has, from this session or its own queue,
            // is shown as it is and never proposed again.
            const key = proposalKey(request.chainId, account, sentCall)
            const known = proposals.get(key)
            let queued: Awaited<ReturnType<typeof findPendingSafeAppProposal>> = null
            if (!holdsCall(known) && hasSafeService(request.chainId)) {
              // Reading Safe's queue takes a moment: the flow shows it checking.
              setPhase('simulating')
              queued = await findPendingSafeAppProposal(publicClient, request.chainId, account, sentCall)
            }
            if (holdsCall(known) || queued) {
              if (queued) {
                const { proposalHash, call } = queued
                recordProposal({ chainId: request.chainId, safe: account, call, proposalHash }, publicClient, false)
              } else if (known?.phase === 'awaiting') {
                startFollowingProposal(key, publicClient, false)
              }
              const existing = proposals.get(key)!
              assertCurrent()
              assertReviewedWallet({ account, connectorUid, safe: true })
              await options.onExistingProposal?.({ proposalHash: existing.proposalHash, call: existing.call })
              tracked.current = existing.proposalHash
              await gate?.beforeSend(existing.call)
              gate?.afterSubmit(existing.proposalHash)
              assertCurrent()
              inFlightRef.current = false
              setShownKey(key)
              return existing.proposalHash
            }
          }
          const txHash = await submitReviewedContractWrite({
            request,
            expectedAccount: account,
            review: async reviewed => {
              // A review notice always opens the review, even where the caller
              // already rendered the payload — the notice exists precisely
              // because what was rendered is no longer what will be signed.
              if (options.reviewedInParent && !reviewNotice) return
              const description = [
                reviewNotice,
                viaSafe ? SAFE_NONCE_GUIDANCE : null,
              ]
                .filter(Boolean)
                .join('\n\n')
              const approved = await requestContractTransactionReview(
                {
                  ...reviewed,
                  account,
                  // A Safe app signs the sent gas as safeTxGas; 0 makes a failed call revert.
                  ...(viaSafe ? { safeTxGas: 0n } : {}),
                },
                {
                  label: reviewed.label,
                  ...(description ? { description } : {}),
                  ...(viaSafe
                    ? { confirmLabel: 'Agree & continue to Safe' }
                    : {}),
                },
              )
              if (!approved) throw new TransactionReviewCancelledError()
            },
            switchChain: async reviewedChainId => {
              if (getAccount(wagmiConfig).chainId === reviewedChainId) return
              await switchChainAsync({ chainId: reviewedChainId }).catch(() => {
                throw new Error(`Switch your wallet to ${chainName(reviewedChainId)} to continue.`)
              })
            },
            currentAccount: () => getAccount(wagmiConfig).address,
            reverify: options.reverify,
            beforeWrite: async () => {
              assertCurrent()
              await options.beforeWrite?.()
              assertCurrent()
              assertReviewedRequest()
              await gate?.beforeSend()
            },
            onBeforeWriteAborted: async () => {
              gate?.onRejected()
              await options.onBeforeWriteAborted?.()
            },
            onWriteRejected: async () => {
              gate?.onRejected()
              await options.onWriteRejected?.()
            },
            onWriteSubmitted: async (submittedHash: Hex) => {
              if (!isHash(submittedHash)) throw new Error(SAFE_REPLY_UNREADABLE)
              tracked.current = submittedHash
              gate?.afterSubmit(submittedHash)
            },
            // Simulation is the safety gate: the exact reviewed call, args, and
            // value must succeed before a signature is requested. Only the
            // simulation result reaches the wallet writer.
            simulate: async reviewed => {
              sentCall = callOf(reviewed)
              const simulationRequest = {
                address: reviewed.address,
                abi: reviewed.abi,
                functionName: reviewed.functionName,
                args: reviewed.args as unknown[],
                value: reviewed.value,
                account,
                ...(options.simulationBlockNumber !== undefined
                  ? { blockNumber: options.simulationBlockNumber }
                  : {}),
              }
              const [{ request: simulated }, estimate] = await Promise.all([
                publicClient.simulateContract(simulationRequest),
                publicClient.estimateContractGas(simulationRequest),
              ])
              return {
                ...simulated,
                gas: viaSafe ? 0n : gasWithHeadroom(estimate),
              }
            },
            beforeSend: () => {
              // This synchronous SDK gate follows every awaited proof and marker.
              assertCurrent()
              assertReviewedRequest()
              assertReviewedWallet({ account, connectorUid, chainId: request.chainId, safe: viaSafe })
              options.assertWriteState?.()
            },
            write: simulated => writeContractAsync({ ...simulated, chainId: request.chainId }),
            onPhase: next => { if (generation.current === at) setPhase(next) },
          })
          if (!mounted.current || generation.current !== at) return txHash
          if (viaSafe) {
            // A reply that is not a 32-byte hash names no proposal and no execution.
            if (!isHash(txHash)) throw new Error(SAFE_REPLY_UNREADABLE)
            // The registry holds the call from here; this flow only shows it.
            inFlightRef.current = false
            setShownKey(
              recordProposal(
                { chainId: request.chainId, safe: account, call: sentCall, proposalHash: txHash },
                publicClient,
                true,
              ),
            )
          } else {
            setHash(txHash)
          }
          setPhase('pending')
          return txHash
        }
        sending.current = true
        // The send's view gates it: a success the hold settled while this flow was away refuses it
        // until the user says "Send it again", so the earlier write is never repeated unannounced.
        return await sendRef.current({ ...input, ...namespace, ...(options.recoveryLegacy ? { legacy: options.recoveryLegacy } : {}) }, execute)
      } catch (e) {
        sending.current = false
        const submitted = e instanceof SubmittedContractWriteError && typeof e.hash === 'string' && isHash(e.hash) ? e : undefined
        // A failed callback cannot erase the wallet's already-returned identity.
        if (!mounted.current || generation.current !== at) return submitted ? submitted.hash as Hex : null
        inFlightRef.current = false
        // The gate refused: the view shows the success that settled while this flow was away, with its "Send it again".
        if (e instanceof Error && e.message === HELD_AWAY_SUCCESS_LINE) return null
        if (e instanceof WriteHeldError) {
          apply(e.state, publicClient)
          // The same call already placed is the hash this send would have returned.
          try {
            return sameReviewedWrite(e.state.record, { chainId: request.chainId, account, safe: viaSafe, call: callOf(request) })
              ? (e.state.record.hash ?? null) : null
          } catch { return null }
        }
        if (e instanceof WriteHoldStaleReviewError) {
          // Another window sent this same write while its review was open: a fresh review is needed.
          // That window follows its own attempt; this flow doesn't adopt it.
          holdAt.current = -1
          setError(e.message)
          setPhase('error')
          if (e.settled && 'hash' in e.settled) setSettledNotice(settledLine(e.settled))
          return null
        }
        if (e instanceof WriteHoldBusyError || e instanceof WriteHoldNonceError) {
          setError(e.message)
          setPhase('error')
          return null
        }
        if (current) {
          // A reply lost on its way stays held: what the chain says of it is shown, with its hash followed.
          const now = await current.state(publicClient).catch(() => null)
          if (!now) {
            // The chain couldn't be asked: it stays held with its line, and an exit waits for the chain's answer.
            let saved: WriteHoldState | null = null
            try { saved = current.peek() } catch { /* An unreadable record is held all the same. */ }
            if (saved?.status !== 'clear') {
              setRecoveryNotice(writeHeldMessage())
              setPhase('submitted')
              return saved?.record.hash ?? null
            }
          } else if (now.status !== 'clear') {
            apply(now, publicClient)
            return now.record.hash ?? null
          }
        }
        if (e instanceof TransactionReviewCancelledError) {
          setPhase('idle')
          return null
        }
        options.onFailure?.(e)
        setError(friendlyTxError(e))
        setPhase('error')
        return null
      } finally {
        sending.current = false
      }
    },
    [isConnected, isCenterWallet, publicClient, switchChainAsync, writeContractAsync, apply],
  )

  /**
   * Show the hold of a write this flow didn't send in this page, which its saved-attempt recovery
   * found held. Nothing is sent; the hold's state is shown with its line and exit, a hash is
   * followed, and a send of the same write is refused while it holds.
   */
  const track = useCallback((request: TxRequest | { chainId: number; call: { to: Address; data: Hex; value?: bigint } }, options: Pick<TxSendOptions, 'reviewedAccount' | 'recoveryNamespace'> & { safe?: boolean; reservation?: string }) => {
    if (!publicClient || inFlightRef.current) return
    // A reservation this flow already shows is watched already.
    if (options.reservation && options.reservation === trackedReservation.current && holdAt.current === generation.current) return
    trackedReservation.current = options.reservation ?? null
    holdAt.current = generation.current
    setTracking({
      chainId: request.chainId, account: options.reviewedAccount, safe: options.safe ?? isSafeConnection(wagmiConfig),
      call: 'call' in request ? request.call : callOf(request),
      ...(options.recoveryNamespace ? { namespace: options.recoveryNamespace } : {}),
    })
    setMode('track')
  }, [publicClient])

  /**
   * Clear this flow's state, as a new review opens. A Safe proposal stays in
   * the registry: still followed while pending, and still held when unproven,
   * since the user may not have seen its line. A hold stays saved.
   */
  const reset = useCallback(() => {
    if (following.current) return
    generation.current += 1
    inFlightRef.current = false
    tracked.current = null
    reservation.current = null
    setSettledNotice(null)
    setHoldNotice(null)
    setPhase('idle')
    setError(null)
    setHash(null)
    setShownKey(null)
    setRecoveryNotice(null)
    setSettledReceipt(null)
    setMode(null); setTracking(null)
    setHeld(null)
    setAwaySuccess(false)
  }, [])

  /**
   * Close this confirm and its unproven registry view. A hold the chain has not
   * released stays, with its exit, until the user takes it.
   */
  const dismiss = useCallback(() => {
    if (following.current) return
    const shown = shownKey ? proposals.get(shownKey) : undefined
    // A known execution stays held until its receipt decides it: closing only hides it.
    if (shownKey && shown?.phase === 'unproven' && !shown.executionHash) {
      proposals.delete(shownKey)
      notifyProposals()
    }
    reset()
  }, [reset, shownKey])

  return {
    phase: effectivePhase,
    /** True while the transaction is in flight: simulating/signing/pending. */
    busy:
      effectivePhase === 'simulating' ||
      effectivePhase === 'signing' ||
      effectivePhase === 'pending',
    /** The confirm can end on Done: the transaction succeeded, or it is with a Safe. */
    settled: effectivePhase === 'success' || effectivePhase === 'submitted',
    /** The one line a `submitted` confirm shows. */
    notice,
    /** Whether the connected writer is a Safe connector. */
    isSafe,
    error: effectiveError,
    hash: shownKey ? (proposal?.executionHash ?? null) : hash,
    /** The wallet-returned identity, including a Safe proposal before execution. */
    submissionHash: shownKey ? (proposal?.proposalHash ?? null) : hash,
    safeProposalHash: awaitingProposal,
    safeNonceGuidance: awaitingProposal ? SAFE_NONCE_GUIDANCE : null,
    receipt: held ? null : shownKey ? (proposal?.receipt ?? null) : (receiptData ?? settledReceipt ?? null),
    /** A write the chain has not placed, with the user's one exit; null otherwise. */
    held: held?.exit
      ? { kind: 'exit' as const, line: held.line, warning: 'warning' in held && held.warning ? held.warning : writeExitMessage(held.record.call), label: WRITE_EXIT_LABEL, release }
      : awaySuccess ? { kind: 'send-again' as const, line: HELD_AWAY_SUCCESS_LINE, label: HELD_SEND_AGAIN_LABEL, release: sendAgain } : null,
    /** The transaction has a hash, but its result could not be confirmed here. */
    confirmationUncertain: !!recoveryNotice || !!held?.exit || (shownKey
      ? proposal?.phase === 'unproven' || (proposal?.phase === 'awaiting' && !!proposal.message)
      : watchGaveUp),
    send,
    track,
    reset,
    dismiss,
  }
}
