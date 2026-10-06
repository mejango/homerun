'use client'

import { bundleMultisigLaunch, unbundleMultisigLaunch, checkCreateMultisigs, multisigReview, multisigDeploymentCalls, SAFE_CREATE_ABI, verifyMultisigLaunchSimulation } from './create-multisig'
import { isEip7702DelegatedEoaRuntime } from '@bananapus/nana-sdk-core/safe'


import {
  JBCoreContracts,
  erc2771ForwarderAbi,
  jbContractAddress,
  type JBChainId,
} from '@bananapus/nana-sdk-core'
import { getProjectCreationFee } from '@bananapus/nana-sdk-core/v6'
import { getAccount } from '@wagmi/core'
import {
  decodeFunctionData,
  encodeFunctionData,
  isAddressEqual,
  type Address,
  type Abi,
  type Hex,
  type TransactionReceipt,
} from 'viem'
import { wagmiConfig } from '@/providers/Providers'
import { buildFundLaunch, type FundTransaction } from '@/lib/fund-contracts'
import { verifyFundLaunch } from '@/lib/fund-launch-verification'
import { loadLaunchSession, saveLaunch as saveLaunchSession, type LaunchStatus as LaunchChainStatus, type FundLaunchSession as LaunchSession } from '@/lib/fund-launch-session'
import { gasWithHeadroom } from '@bananapus/nana-sdk-core/review'
import {
  RelayrDestinationRevertedError,
  TRUSTED_FORWARDER_ABI,
  relayrDeadlinePassed,
  relayrDestinationHash,
  relayrForwardRequest,
  relayrPaymentChains,
  relayrPaymentDetails,
  relayrPaymentOptions,
  relayrRequestStates,
  relayrRequestsDead,
  relayrRequestsVerdict,
  relayrSessionOutcome,
  relayrSignedRequests,
  relayrSupportsChains,
  verifyRelayrDestination,
  type RelayrPayment,
  type RelayrSessionOutcome,
} from '@bananapus/nana-sdk-core/review/relayr'
import {
  prepareForwardedTx,
  relayrChainClient,
  relayrDestinationRecords,
  relayrHeldMessage,
  relayrPay,
  relayrPaymentAttemptOutcome,
  relayrPaymentLabel,
  relayrPoll,
  relayrPostBundle,
  relayrRetryOption,
  proveSavedRelayrPayment,
  revertedRelayrQuote,
  type RelayrEntry,
  type RelayrQuote,
  type RelayrTransactionRecord,
} from '@/lib/relayr'
import { relayrSentPaymentsSnapshot, type RelayrSentPayment } from '@/lib/relayr-payments'
import { isSafeConnection } from '@/lib/safe-connector'
import { assertNoViewAs } from '@/lib/viewAs'
import { publicClient } from '@/lib/wallet-core'
import { displayChainName as chainName } from '@/lib/chainDisplay'
import { withForwarderAuthorizationLock } from '@/lib/forwarder-authorization'
import { requireFundingChainSelection, requireTransactionReview } from '@/lib/transaction-review'

const activeLaunches = new Set<string>()
class LaunchSignaturesNeedRefresh extends Error {}

/** The line a launch shows once every request it published is dead and one may have run (ruling R114). */
const LAUNCH_MAY_HAVE_RUN = 'This launch\'s earlier signature may already have run. Check the project, then cancel creation to start over.'
/** The line a launch shows once every request it published is dead, none ran, and the launch's recheck refuses its calls. */
const LAUNCH_CHANGED = 'The launch changed since this review. Cancel creation to start over.'
/** The line a launch shows while the node cannot answer its recheck, which decides nothing about signing it again. */
const LAUNCH_UNCHECKED = 'Couldn\'t check the launch. Try again, or cancel creation.'
/** The same line once a payment was made, which cancelling does not refund. */
const LAUNCH_UNCHECKED_PAID = 'Couldn\'t check the launch. Try again, or cancel creation; the payment already made is not refunded.'

type SignedLaunch = {
  chainId: number
  entry: RelayrEntry
  nonce: string
  deadline: number
}

/** Exact signatures and quote bindings survive refreshes, including the wallet's no-hash send window. */
export type LaunchRelayrJournal = {
  account: Address
  paymentChainId?: number
  /** `payment-reverted`: the latest payment canonically reverted; only the SDK's retry rule lets the quote be paid again. */
  phase: 'signing' | 'quoting' | 'quoted' | 'payment-signing' | 'submitted' | 'executing' | 'payment-reverted'
  signed: SignedLaunch[]
  superseded?: SignedLaunch[]
  /** Retrying a known failed attempt must reuse its nonce, even if the old signature is still live. */
  retryNonces?: Record<number, string>
  quote?: RelayrQuote
  paymentHash?: Hex
  /** Every payment sent for the quote, as relayrPaymentDetails authenticated it, under the hash it was mined. */
  payments?: RelayrSentPayment[]
  paymentDeadline?: string
  records: RelayrTransactionRecord[]
  published?: true
  abandonable?: true
}

function requestFor(session: LaunchSession, chainId: number, fee: bigint): FundTransaction {
  return buildFundLaunch({ ...session.input, creationFees: { ...session.input.creationFees, [chainId]: fee } }).requests.find(request => request.chainId === chainId)!
}

function launchData(request: FundTransaction): Hex {
  return encodeFunctionData({ abi: request.abi as Abi, functionName: request.functionName, args: request.args }).toLowerCase() as Hex
}

/**
 * The gas the launch's call needs from `account`. Relayr supplies each destination's creation fee, so only the signer's
 * native balance is overridden: no destination ETH balance or token approval is needed, and no contract storage or code
 * is overridden, so the real launch rules still execute.
 */
function estimateLaunch(client: ReturnType<typeof publicClient>, account: Address, request: FundTransaction, creationFee: bigint): Promise<bigint> {
  return client.estimateGas({ account, to: request.address, data: launchData(request), value: request.value,
    stateOverride: [{ address: account, balance: creationFee + 100n * 10n ** 18n }] })
}

export function canRelayrLaunch(session: LaunchSession): boolean {
  return session.transport === 'relayr' && (session.input.chainIds.length > 1 || !!session.input.multisigs?.length) &&
    session.input.chainIds.length <= 4 && relayrSupportsChains(session.input.chainIds)
}

function forwarderFor(chainId: number): Address {
  const address = jbContractAddress['6'][JBCoreContracts.ERC2771Forwarder][chainId as JBChainId]
  if (!address) throw new Error(`No V6 forwarder is configured on ${chainName(chainId)}.`)
  return address
}

function requestOf(signed: SignedLaunch, plans: LaunchSession['input']['multisigs']) {
  signed = { ...signed, entry: unbundleMultisigLaunch(signed.entry, plans) }
  if (!isAddressEqual(signed.entry.target, forwarderFor(signed.chainId)) ||
      signed.entry.chain !== signed.chainId) throw new Error('The saved launch forwarder changed.')
  const request = relayrForwardRequest(signed.entry)
  if (!request) throw new Error('The saved launch is not a forwarder execution.')
  if (request.deadline !== signed.deadline || request.value !== BigInt(signed.entry.value)) {
    throw new Error('The saved launch authorization changed.')
  }
  return request
}

/**
 * What the launch has published to Relayr: the requests it quoted, and every one it replaced. A request signed and
 * not yet quoted has left this browser's record only.
 */
function publishedSigned(journal: LaunchRelayrJournal): SignedLaunch[] {
  return [...(journal.phase === 'signing' ? [] : journal.signed), ...(journal.superseded ?? [])]
}

/**
 * The requests among `signed` on chains not yet created, as the SDK's session rules read them: each its forwarder
 * execute, with the nonce it was signed at. `requests` is null when one cannot be read, and none then counts as dead.
 */
function outstandingOf(session: LaunchSession, signed: readonly SignedLaunch[]) {
  const outstanding = signed.filter(item => session.statuses[item.chainId]?.phase !== 'confirmed')
  const nonces = outstanding.map(item => item.nonce)
  let requests: ReturnType<typeof relayrSignedRequests> = null
  try {
    requests = relayrSignedRequests(outstanding.map(item => unbundleMultisigLaunch(item.entry, session.input.multisigs)), nonces)
  } catch { /* A saved call that cannot be read is classified as unknown. */ }
  return { outstanding, nonces, requests }
}

/**
 * Ruling R117: whether every request the launch published is dead at a canonical finalized block on its chain,
 * anything unknown counting as live. The launch reserves its signer's forwarder nonces exactly while one is live, so
 * only a launch for which this holds may be cancelled.
 */
export async function launchRequestsDead(session: LaunchSession): Promise<boolean> {
  const { requests } = outstandingOf(session, session.relayr ? publishedSigned(session.relayr) : [])
  return relayrRequestsDead(relayrChainClient, requests)
}

/**
 * One authorization per destination, one reviewed payment on the user's selected chain.
 * The launch journal owns recovery: provider labels never establish creation or permit a new payment.
 */
export async function runRelayrLaunch({ session, account, onStatus, onProgress }: {
  session: LaunchSession
  account: Address
  onStatus: (chainId: number, status: LaunchChainStatus & { error?: string }) => void
  onProgress: (message: string) => void
}): Promise<void> {
  assertNoViewAs()
  // Signing moves the wallet to each destination, so the fee picker prefers the chain it started on.
  const startChainId = getAccount(wagmiConfig).chainId
  if (!canRelayrLaunch(session) || isSafeConnection(wagmiConfig)) {
    throw new Error('Relayed creation requires an ordinary wallet and supported chains from the same network environment.')
  }
  if (!session.input.sender || !isAddressEqual(session.input.sender, account)) {
    throw new Error('Connect the wallet that originally signed this launch.')
  }
  if (activeLaunches.has(session.input.salt)) throw new Error('This launch is already running.')
  activeLaunches.add(session.input.salt)
  try {
    if (typeof navigator === 'undefined' || !navigator.locks) {
      throw new Error('This browser cannot coordinate launch recovery across tabs. Use a browser with Web Locks support.')
    }
    await navigator.locks.request('homerun:fund-launch', { ifAvailable: true }, async lock => {
      if (!lock) throw new Error('This launch is already running in another tab.')
      await withForwarderAuthorizationLock({ account, chainIds: [...session.input.chainIds], owner: `launch:${session.input.salt}`,
        execute: run })
    })
  } finally {
    activeLaunches.delete(session.input.salt)
  }

  async function run(assertAuthorizationAvailable: (destinations?: number[]) => void) {
    const saved = loadLaunchSession({ strict: true })
    if (saved && saved.input.salt !== session.input.salt) throw new Error('Another launch is saved in this browser. Resume it before starting a different launch.')
    const current = saved?.input.salt === session.input.salt ? saved : session
    if (!canRelayrLaunch(current)) {
      throw new Error('The saved launch must use supported chains from the same network environment.')
    }
    const persist = () => {
      const latest = loadLaunchSession()
      if (latest && latest.input.salt !== current.input.salt) throw new Error('Another tab changed the active launch. Stop and recover the original launch before continuing.')
      if (!saveLaunchSession(current)) {
        throw new Error('Allow browser storage before launching so payment and destination transactions can be recovered safely.')
      }
    }
    const status = (chainId: number, next: LaunchChainStatus & { error?: string }) => {
      // The React caller merges patches. Explicitly clear fields absent from this full
      // snapshot so a failed attempt's hash cannot attach itself to a newly signed bundle.
      const snapshot = { hash: undefined, projectId: undefined,
        error: undefined, ...next }
      current.statuses = { ...current.statuses, [chainId]: snapshot }
      persist()
      onStatus(chainId, snapshot)
    }
    const requireAccount = () => {
      const connected = getAccount(wagmiConfig).address
      if (!connected || !isAddressEqual(connected, account) || isSafeConnection(wagmiConfig)) {
        throw new Error('Connected account changed. Return to the wallet that started this launch.')
      }
    }
    requireAccount()
    if (!current.input.sender || !isAddressEqual(current.input.sender, account) || current.transport !== 'relayr') {
      throw new Error('The saved launch identity or payment chain changed.')
    }
    let journal = current.relayr
    if (journal && (!Array.isArray(journal.signed) || !Array.isArray(journal.records) ||
        !isAddressEqual(journal.account, account) ||
        journal.signed.length > current.input.chainIds.length ||
        new Set(journal.signed.map(item => item.chainId)).size !== journal.signed.length ||
        journal.signed.some(item => !current.input.chainIds.includes(item.chainId)) ||
        !['signing', 'quoting', 'quoted', 'payment-signing', 'submitted', 'executing', 'payment-reverted'].includes(journal.phase) ||
        (journal.payments !== undefined && !relayrSentPaymentsSnapshot(journal.payments)))) {
      throw new Error('The saved Relayr launch is invalid. Keep its original transaction records before continuing.')
    }
    if (journal && ['payment-signing', 'submitted', 'executing', 'payment-reverted'].includes(journal.phase)) {
      if (journal.paymentChainId === undefined || !relayrPaymentChains(current.input.chainIds).includes(journal.paymentChainId)) {
        throw new Error('The original Relayr payment requires its saved payment chain in the launch network environment.')
      }
      current.paymentChainId = journal.paymentChainId
    } else {
      // Older unfunded sessions may contain a pre-quote preference. Every new
      // payment requires a fresh, explicit choice among the actual quote offers.
      delete current.paymentChainId
      if (journal) {
        delete journal.paymentChainId
        delete journal.paymentDeadline
      }
    }
    const pinnedRequest = (signed: SignedLaunch) => {
      const request = requestOf(signed, current.input.multisigs)
      const expected = requestFor(current, signed.chainId, request.value)
      if (!isAddressEqual(request.from, account) || !isAddressEqual(request.to, expected.address) ||
          request.data !== launchData(expected)) throw new Error('The saved signature does not match this pinned launch.')
      return request
    }
    for (const signed of journal?.signed ?? []) pinnedRequest(signed)
    for (const signed of journal?.superseded ?? []) pinnedRequest(signed)
    /**
     * The launch's recheck (ruling R114): on each chain, its Safes can still be created and its call, at the creation
     * fee now, still estimates. The SDK runs it only once every request the launch published is dead and unused.
     */
    const recheckLaunch = async (chainIds: readonly number[]) => {
      for (const chainId of chainIds) {
        const client = publicClient(chainId as JBChainId)
        await checkCreateMultisigs(client, current.input.multisigs)
        const creationFee = await getProjectCreationFee(client, chainId as JBChainId)
        await estimateLaunch(client, account, requestFor(current, chainId, creationFee), creationFee)
      }
    }
    /**
     * What the SDK's session rules (rulings R104, R114 and R117) let the launch do next with the requests it published
     * on chains not yet created, each classified at one canonical finalized block on its chain; `states` follow
     * `outstanding`. Null when none is outstanding. Without `recheck`, a launch whose requests all expired unused ends
     * as `expired`, which no flow here signs again on its own.
     */
    const classify = async (target: LaunchRelayrJournal, { recheck = true } = {}) => {
      const { outstanding, nonces, requests } = outstandingOf(current, publishedSigned(target))
      if (!outstanding.length) return null
      const states = requests ? await relayrRequestStates(relayrChainClient, requests) : []
      const outcome = await relayrSessionOutcome(relayrRequestsVerdict(states), {
        nonces, ...(recheck ? { recheck: () => recheckLaunch([...new Set(outstanding.map(item => item.chainId))]) } : {}),
      })
      return { outstanding, states, outcome }
    }
    /** A chain whose request may have run is never signed again: it reads unresolved, and the line says why. */
    const markRan = ({ outstanding, states }: NonNullable<Awaited<ReturnType<typeof classify>>>) => {
      for (const chainId of new Set(outstanding.map(item => item.chainId))) {
        if (outstanding.some((item, index) => item.chainId === chainId && states[index] && !states[index].live && states[index].mayHaveRun)) {
          status(chainId, { phase: 'unresolved', hash: current.statuses[chainId]?.hash, error: LAUNCH_MAY_HAVE_RUN })
        }
      }
    }
    /** Marks the journal for cancelling and ends the run: every request it published is dead, and it is not signed again. */
    const abandon = (target: LaunchRelayrJournal, line: string, cause?: unknown): never => {
      target.abandonable = true
      persist()
      throw new Error(line, cause === undefined ? undefined : { cause })
    }
    /**
     * Ends the run for an outcome that allows no new signature or payment: a request that can still run while another
     * may have run, a finalized nonce below a saved one, a recheck the node could not answer, or every request dead and
     * the launch not to be signed again. Returns the outcomes that may go on.
     */
    const requireGoOn = (target: LaunchRelayrJournal, outcome: RelayrSessionOutcome): Extract<RelayrSessionOutcome, { kind: 'refresh' | 're-sign' | 'discard' }> => {
      if (outcome.kind === 'hold') throw new Error(relayrHeldMessage(outcome.until))
      if (outcome.kind === 'reorg-hold') throw new Error(relayrHeldMessage(0))
      if (outcome.kind === 'unchecked') {
        // The recheck runs only once every request is dead and unused, so none can run: the launch is not signed again
        // until the node answers, but it may be cancelled meanwhile.
        return abandon(target, target.payments?.length || target.paymentHash ? LAUNCH_UNCHECKED_PAID : LAUNCH_UNCHECKED, outcome.error)
      }
      if (outcome.kind === 'discard' && outcome.reason !== 'expired') {
        return abandon(target, outcome.reason === 'ran' ? LAUNCH_MAY_HAVE_RUN : LAUNCH_CHANGED, outcome.error)
      }
      return outcome
    }
    /** The original payment's deadline has passed at a canonical finalized block on its chain. */
    const originalPaymentExpired = async (): Promise<boolean> => {
      const client = journal?.paymentChainId === undefined ? undefined : relayrChainClient(journal.paymentChainId)
      return !!journal?.paymentDeadline && !!client && relayrDeadlinePassed(client, journal.paymentDeadline)
    }
    // Another payment may have funded a quote whose own payment reverted: what Relayr ran is reconciled below, never
    // paid again.
    let fundedElsewhere = false
    /** Why the reverted quote's release is unproven, which matters only while a request can still run (ruling R114). */
    let unreleased: unknown = null
    if (journal?.phase === 'payment-reverted' && journal.quote) {
      try {
        const reverted = await revertedRelayrQuote({ bundleUuid: journal.quote.bundle_uuid, payments: journal.payments ?? [],
          options: journal.quote.payment_info, destinationChainIds: journal.signed.map(item => item.chainId), account })
        if (reverted.records) journal.records = reverted.records
        fundedElsewhere = reverted.state === 'funded'
        if (reverted.state === 'released') {
          // Ruling R104: nothing can fund the quote any more, so the same signed calls are quoted again below, with a new
          // funding choice. The old quote goes now: a device clock behind the chain must never offer it.
          journal.phase = 'quoted'
          delete journal.quote
          delete journal.payments
          delete journal.paymentHash
          delete journal.paymentChainId
          delete journal.paymentDeadline
          delete current.paymentChainId
        }
        persist()
      } catch (error) {
        unreleased = error
      }
    }
    /**
     * While a published request can still run (ruling R114), when its last one stops. Until then the launch signs again
     * only at the saved nonces.
     */
    let heldUntil: number | null = null
    if (journal?.published && !fundedElsewhere && ['signing', 'quoting', 'quoted', 'payment-reverted'].includes(journal.phase)) {
      const classified = await classify(journal)
      if (classified) {
        if (classified.outcome.kind === 'discard' && classified.outcome.reason === 'ran') markRan(classified)
        const outcome = requireGoOn(journal, classified.outcome)
        if (outcome.kind === 'refresh') {
          heldUntil = outcome.until
        } else {
          // Relayr's answer matters only while a request can still run (ruling R114).
          unreleased = null
          if (!journal.abandonable) {
            // Every request expired unused and the recheck passed: the launch may be cancelled, or signed again at its saved nonces.
            journal.abandonable = true
            persist()
            throw new Error('All outstanding launch authorizations expired unused. You can change the setup or retry this launch; any earlier relay payments are not refunded automatically.')
          }
        }
      }
    }
    if (unreleased) throw heldUntil === null ? unreleased : new Error(relayrHeldMessage(heldUntil), { cause: unreleased })
    if (journal?.abandonable && ['signing', 'quoting', 'quoted', 'payment-reverted'].includes(journal.phase) && journal.signed.length) {
      const previous = journal
      journal = { account, phase: 'signing', signed: [], records: [],
        published: true, abandonable: true,
        retryNonces: { ...previous.retryNonces, ...Object.fromEntries(previous.signed.map(item => [item.chainId, item.nonce])) },
        superseded: [...(previous.superseded ?? []), ...previous.signed] }
      current.relayr = journal
      persist()
    }
    const requireQuoteBindings = () => {
      const bindings = journal?.quote?.expectedTransactions
      if (!bindings?.length || bindings.length !== journal!.signed.length ||
          new Set(bindings.map(item => item.txUuid)).size !== bindings.length ||
          new Set(bindings.map(item => item.chain)).size !== bindings.length) {
        throw new Error('The launch quote does not bind each signed destination exactly once.')
      }
      for (const signed of journal!.signed) {
        const binding = bindings.find(item => item.chain === signed.chainId)
        if (!binding || binding.entry.chain !== signed.chainId ||
            !isAddressEqual(binding.entry.target, signed.entry.target) || binding.entry.data !== signed.entry.data ||
            binding.entry.value !== signed.entry.value) throw new Error('The saved launch quote changed its destination calls.')
      }
      return bindings
    }

    /** Receipts are accepted only for the exact signed outer call on its bound chain. */
    const reconcile = async (): Promise<boolean> => {
      const bindings = requireQuoteBindings()
      const original = journal!
      // Relayr's status only points at hashes, and only when its records are exactly this quote's.
      const destinations = relayrDestinationRecords(original.records, bindings)
      /** Chains whose launch reverted at the destination, which leaves the forwarder's nonce unused. */
      const reverted = new Set<number>()
      /** Chains whose destination is not proven, with the last hash seen for each and why. */
      const waiting = new Map<number, { hash?: Hex; error: string }>()
      for (const signed of original.signed) {
        const request = pinnedRequest(signed)
        const client = publicClient(signed.chainId as JBChainId)
        const index = bindings.findIndex(item => item.chain === signed.chainId)
        const binding = bindings[index]
        if (!binding || !isAddressEqual(binding.entry.target, signed.entry.target) ||
            binding.entry.data !== signed.entry.data || binding.entry.value !== signed.entry.value) {
          throw new Error('The saved launch quote does not match its signed destination.')
        }
        /** Proves the hash is the signed launch on this chain, and records the destination as confirmed or reverted. */
        const prove = async (hash: Hex): Promise<'confirmed' | 'reverted'> => {
          let receipt: TransactionReceipt
          try {
            receipt = await verifyRelayrDestination(client, { entry: signed.entry, hash })
          } catch (error) {
            if (!(error instanceof RelayrDestinationRevertedError)) throw error
            // A reverted execute leaves the nonce unused. Whether its old authorization can still run, or another
            // request used the nonce, is classified below at a canonical finalized block.
            status(signed.chainId, { phase: 'reverted', hash, error: 'The destination launch reverted.' })
            return 'reverted'
          }
          const projectId = (await verifyFundLaunch(client, requestFor(current, signed.chainId, request.value), current.input, receipt, false, signed.entry)).toString()
          if (!projectId) throw new Error('The launch confirmed but its project ID could not be verified.')
          status(signed.chainId, { phase: 'confirmed', hash, projectId })
          return 'confirmed'
        }
        // A confirmed chain keeps its verified hash. Any other chain tries the hash its record reports now, then
        // the last hash it saw, and a hash that failed never replaces the one it saw. A node reports hashes in
        // lowercase, so candidates are lowercased before they are compared and de-duplicated.
        const saved = current.statuses[signed.chainId]
        const record = destinations.records[index]
        const reported = record ? relayrDestinationHash(record) : null
        const candidates = [...new Set((saved?.phase === 'confirmed' ? [saved.hash] : [reported, saved?.hash])
          .map(hash => hash?.toLowerCase()))].filter((hash): hash is Hex => !!hash)
        if (candidates.length) {
          let proven: 'confirmed' | 'reverted' | undefined
          let failure: unknown
          for (const hash of candidates) {
            try {
              proven = await prove(hash)
              break
            } catch (error) {
              failure ??= error
            }
          }
          if (proven === 'confirmed') continue
          if (proven === 'reverted') {
            reverted.add(signed.chainId)
            continue
          }
          waiting.set(signed.chainId, { hash: saved?.hash ?? candidates[0],
            error: failure instanceof Error ? failure.message : 'Destination confirmation is unavailable.' })
        } else {
          waiting.set(signed.chainId, { error: destinations.refusal ?? 'Waiting for the original Relayr destination transaction.' })
        }
      }
      if (!reverted.size && !waiting.size) return true
      // Ruling R114: what is not proven at a destination is classified at a canonical finalized block, whatever Relayr
      // reports. An unavailable node cannot prove that a request did not run, and a nonce that moved means it may have.
      // A request that is not dead can only compete with a retry at that same nonce, never create another project.
      const classified = (await classify(original, { recheck: !(original.phase === 'payment-signing' && !original.paymentHash) }))!
      const { outstanding, states, outcome } = classified
      const ownStates = (chainId: number) => outstanding.flatMap((item, index) => item.chainId === chainId ? [states[index]] : [])
      const expired = (chainId: number) => ownStates(chainId).length > 0 && ownStates(chainId).every(state => state && !state.live && state.unused)
      for (const [chainId, { hash, error }] of waiting) {
        const seen = hash ? { hash } : {}
        if (expired(chainId)) status(chainId, { phase: 'expired', ...seen, error: 'The unexecuted launch authorization expired.' })
        else status(chainId, { phase: 'unresolved', ...seen, error })
      }
      markRan(classified)
      if (outcome.kind === 'hold' || outcome.kind === 'reorg-hold') return false
      const next = requireGoOn(original, outcome)
      // Requests that can still run are signed again only for chains that reverted or expired, at their saved nonces.
      if (next.kind === 'refresh' && ![...waiting.keys()].every(expired)) return false
      current.relayr = {
        account, phase: 'signing', signed: [], records: [],
        published: true,
        ...(next.kind === 'refresh' ? {} : { abandonable: true }),
        superseded: [...(original.superseded ?? []), ...original.signed]
          .filter(item => current.statuses[item.chainId]?.phase !== 'confirmed'),
        retryNonces: Object.fromEntries(original.signed.filter(item => current.statuses[item.chainId]?.phase !== 'confirmed')
          .map(item => [item.chainId, item.nonce])),
      }
      delete current.paymentChainId
      persist()
      return false
    }

    if (journal && (['payment-signing', 'submitted', 'executing'].includes(journal.phase) || fundedElsewhere)) {
      // A payment that reverted funded nothing: the quote waits on the retry rule. A send with no hash yet stays as it
      // is, since it may still land.
      if (journal.phase === 'submitted' || journal.phase === 'executing') {
        const resumed = journal
        await proveSavedRelayrPayment(resumed.payments, account, () => {
          resumed.phase = 'payment-reverted'
          persist()
        })
      }
      onProgress('Checking the original payment and destination transactions. No new payment will be requested.')
      try {
        const records = await relayrPoll(journal.quote!.bundle_uuid, journal.signed.length, records => {
          journal!.records = records
          persist()
        }, 2_500, 15_000)
        journal.records = records
        persist()
      } catch { /* Provider failure labels and timeouts still require independent onchain reconciliation. */ }
      if (await reconcile()) return
      if (current.relayr === journal) {
        throw new Error('This launch is still unresolved. Check the original bundle; do not pay or launch again.')
      }
      // A no-hash funding attempt remains ambiguous even when destination signatures expire.
      // Re-running would risk paying twice. Keep the original funding journal for manual resolution.
      if (journal.phase === 'payment-signing' && !journal.paymentHash) {
        current.relayr = journal
        current.paymentChainId = journal.paymentChainId
        const classified = await classify(journal, { recheck: false })
        if (classified?.outcome.kind === 'discard' && classified.outcome.reason === 'expired' &&
            await originalPaymentExpired()) journal.abandonable = true
        persist()
        throw new Error(journal.abandonable
          ? 'The launch authorizations and payment quote expired. You may abandon this launch, but the earlier payment may have been charged; check your wallet. No refund is implied.'
          : 'Your wallet may have sent the Relayr payment without returning its hash. Check its activity before another payment.')
      }
      journal = current.relayr
    }

    journal ??= { account, phase: 'signing', signed: [], records: [] }
    current.relayr = journal
    persist()
    const remaining = current.input.chainIds.filter(chainId => current.statuses[chainId]?.phase !== 'confirmed')
    if (!remaining.length) return

    const verifySigned = async () => {
      requireAccount()
      assertAuthorizationAvailable(remaining)
      for (const signed of journal!.signed) {
        const request = requestOf(signed, current.input.multisigs)
        const client = publicClient(signed.chainId as JBChainId)
        await checkCreateMultisigs(client, current.input.multisigs)
        const creationFee = await getProjectCreationFee(client, signed.chainId as JBChainId)
        const expected = requestFor(current, signed.chainId, creationFee)
        const data = launchData(expected)
        if (!isAddressEqual(request.from, account) || !isAddressEqual(request.to, expected.address) ||
            request.data !== data || request.value !== expected.value) {
          throw new LaunchSignaturesNeedRefresh('A creation fee changed. Review fresh launch authorizations before payment.')
        }
        const [trusted, valid, code] = await Promise.all([
          client.readContract({ address: expected.address, abi: TRUSTED_FORWARDER_ABI, functionName: 'isTrustedForwarder', args: [forwarderFor(signed.chainId)] }),
          client.readContract({ address: forwarderFor(signed.chainId), abi: erc2771ForwarderAbi, functionName: 'verify', args: [request] }),
          client.getCode({ address: account }),
        ])
        if (request.deadline < Math.floor(Date.now() / 1000) + 120) {
          throw new LaunchSignaturesNeedRefresh('Launch signatures are about to expire. Review fresh authorizations before payment.')
        }
        if (!trusted || !valid || (code && code !== '0x' && !isEip7702DelegatedEoaRuntime(code))) {
          throw new Error('The wallet, forwarder, or launch authorization changed. Check the original bundle before continuing.')
        }
        // Simulate the exact signed forwarder execution as well as its authorization.
        // This catches stale launch prerequisites and an insufficient signed gas limit
        // before the user funds Relayr. Only native balance is supplied by the override.
        const simulation = await client.call({ account, to: signed.entry.target, data: signed.entry.data, value: request.value,
          gas: request.gas + request.gas / 63n + 100_000n + BigInt(current.input.multisigs?.length ?? 0) * 2_000_000n,
          stateOverride: [{ address: account, balance: request.value + 100n * 10n ** 18n }] })
        await verifyMultisigLaunchSimulation(client, current.input.multisigs, simulation.data)
      }
    }

    const authorizations: { chainId: number; nonce: bigint; prepared: Awaited<ReturnType<typeof prepareForwardedTx>> }[] = []
    for (const chainId of remaining) {
      if (journal.signed.some(item => item.chainId === chainId)) continue
      requireAccount()
      assertAuthorizationAvailable(remaining)
      const client = publicClient(chainId as JBChainId)
      await checkCreateMultisigs(client, current.input.multisigs)
      const creationFee = await getProjectCreationFee(client, chainId as JBChainId)
      const request = requestFor(current, chainId, creationFee)
      current.input = { ...current.input, creationFees: { ...current.input.creationFees, [chainId]: creationFee } }
      persist()
      const forwarder = forwarderFor(chainId)
      const [code, forwarderCode, trusted, nonce] = await Promise.all([
        client.getCode({ address: account }), client.getCode({ address: forwarder }),
        client.readContract({ address: request.address, abi: TRUSTED_FORWARDER_ABI, functionName: 'isTrustedForwarder', args: [forwarder] }),
        client.readContract({ address: forwarder, abi: erc2771ForwarderAbi, functionName: 'nonces', args: [account] }),
      ])
      if ((code && code !== '0x' && !isEip7702DelegatedEoaRuntime(code)) || !forwarderCode || forwarderCode === '0x' || !trusted) {
        throw new Error(`Cannot prepare ${chainName(chainId)}: ${code && code !== '0x' && !isEip7702DelegatedEoaRuntime(code) ? 'this contract wallet cannot sign Relayr requests' : !forwarderCode || forwarderCode === '0x' ? 'the Relayr forwarder is not deployed' : 'the project deployer does not trust the Relayr forwarder'}.`)
      }
      if (journal.retryNonces?.[chainId] !== undefined && nonce !== BigInt(journal.retryNonces[chainId])) {
        throw new Error('An earlier launch authorization may have executed. Check its original destination before signing again.')
      }
      const data = launchData(request)
      const estimate = await estimateLaunch(client, account, request, creationFee)
      const prepared = await prepareForwardedTx({ chainId: chainId as JBChainId, target: request.address,
        data, value: request.value, gas: gasWithHeadroom(estimate + (current.input.multisigs?.length ? 200_000n : 0n)), abi: request.abi,
        functionName: request.functionName, args: request.args, label: `Launch on ${chainName(chainId)}` }, account, nonce)
      authorizations.push({ chainId, nonce, prepared })
    }
    if (authorizations.length) {
      await requireTransactionReview({
        kind: 'authorization', title: 'Create your project',
        description: ['Review the FUND launch across your selected chains. Sign once per chain, then choose one Relayr payment to cover creation.', multisigReview(current.input.multisigs)].filter(Boolean).join('\n\n'),
        confirmLabel: 'Continue to wallet',
        calls: authorizations.flatMap(item => [
          ...multisigDeploymentCalls(current.input.multisigs ?? []).map(call => ({ chainId: item.chainId, to: call.target, data: call.callData, value: call.value,
            abi: SAFE_CREATE_ABI, functionName: 'createProxyWithNonce',
            // The review shows the arguments these exact bytes carry.
            args: decodeFunctionData({ abi: SAFE_CREATE_ABI, data: call.callData }).args,
            label: 'Create project multisig', contractName: 'Safe Proxy Factory' })),
          ...item.prepared.review.calls,
        ]),
        authorization: { type: 'EIP-712 launch authorizations', requests: authorizations.map(item => item.prepared.review.authorization) },
      })
    }
    for (const { chainId, nonce, prepared } of authorizations) {
      requireAccount()
      assertAuthorizationAvailable(remaining)
      onProgress(`Sign the launch authorization for ${chainName(chainId)}.`)
      status(chainId, { phase: 'signing' })
      const entry = await prepared.sign()
      const signedRequest = relayrForwardRequest(entry)
      if (!signedRequest) throw new Error('Invalid launch authorization.')
      journal.signed.push({ chainId, entry: bundleMultisigLaunch(entry, current.input.multisigs), nonce: nonce.toString(), deadline: signedRequest.deadline })
      persist()
      status(chainId, { phase: 'authorized' })
    }
    try {
      await verifySigned()
    } catch (error) {
      // Ruling R114: while a published request can still run, the launch signs again only at the saved nonces, never
      // later ones, and says until when otherwise.
      if (heldUntil !== null && !(error instanceof LaunchSignaturesNeedRefresh)) {
        throw new Error(relayrHeldMessage(heldUntil), { cause: error })
      }
      if (error instanceof LaunchSignaturesNeedRefresh) {
        // No payment has been attempted here. Old and new authorizations retain the SAME
        // per-chain nonce, so even previously published signatures cannot create duplicates.
        const retryNonces = { ...journal.retryNonces }
        for (const signed of journal.signed) {
          const nonce = await publicClient(signed.chainId as JBChainId).readContract({
            address: forwarderFor(signed.chainId), abi: erc2771ForwarderAbi, functionName: 'nonces', args: [account],
          })
          if (nonce !== BigInt(signed.nonce)) throw new Error('An earlier launch authorization may have executed. Check its original bundle.')
          retryNonces[signed.chainId] = signed.nonce
        }
        current.relayr = { account, phase: 'signing', signed: [], records: [],
          retryNonces, ...(journal.published ? { published: true, superseded: [...(journal.superseded ?? []), ...journal.signed] } : {}) }
        persist()
      }
      throw error
    }
    const requestQuote = async () => {
      assertAuthorizationAvailable(remaining)
      journal!.phase = 'quoting'
      journal!.published = true
      delete journal!.abandonable
      delete journal!.quote
      delete journal!.paymentChainId
      delete journal!.paymentDeadline
      delete current.paymentChainId
      persist() // exact signed entries are durable BEFORE publishing them to Relayr
      onProgress('Getting payment options for all selected chains.')
      journal!.quote = await relayrPostBundle(journal!.signed.map(item => item.entry))
      journal!.phase = 'quoted'
      persist()
    }
    const destinations = journal.signed.map(item => item.chainId)
    let payment: RelayrPayment | undefined
    if (journal.phase === 'payment-reverted') {
      // A quote that was paid before is paid again with exactly the option it used, and only when the SDK's retry rule
      // clears it.
      requireQuoteBindings()
      payment = relayrRetryOption(journal.payments, journal.quote?.payment_info)
    } else {
      if (!journal.quote) await requestQuote()
      requireQuoteBindings()
      let payments = relayrPaymentOptions(journal.quote!, destinations)
      if (!payments.length) {
        // An unfunded quote can be refreshed using exactly the same signed calls.
        // Its returned funding options must be explicitly reviewed again.
        await requestQuote()
        requireQuoteBindings()
        payments = relayrPaymentOptions(journal.quote!, destinations)
      }
      if (!payments.length) throw new Error('Relayr returned no usable payment options for this launch. Retry to request a new quote; nothing was paid.')
      onProgress('Choose where to pay for the launch.')
      const selectedChainId = await requireFundingChainSelection(payments.map(option => ({ chainId: option.chain, label: relayrPaymentLabel(option) })), startChainId)
      payment = payments.find(option => option.chain === selectedChainId)
      if (!payment) throw new Error('The selected funding chain is not available in this quote. No payment was sent.')
    }
    const paymentChainId = payment.chain
    requireAccount()
    requireQuoteBindings()
    // The chooser has no time limit. An expired offer must never reach the
    // wallet; retry refreshes it and asks for another explicit funding choice.
    const details = relayrPaymentDetails(payment, { bundleUuid: journal.quote!.bundle_uuid, destinationChainIds: destinations })
    if (details.chainId !== paymentChainId) {
      throw new Error('The launch funding option changed. Review the quote again.')
    }
    journal.paymentChainId = paymentChainId
    current.paymentChainId = paymentChainId
    journal.paymentDeadline = details.deadline.toString()
    persist()
    onProgress(`Approve one payment on ${chainName(paymentChainId)} to launch on every selected chain.`)
    /** The wallet holds the payment and has returned no hash for it. */
    let sending = false
    try {
      ;({ hash: journal.paymentHash } = await relayrPay({
        payment, account, bundleUuid: journal.quote!.bundle_uuid, destinationChainIds: destinations,
        sent: journal.payments ?? [],
        reverify: verifySigned,
        onSending: () => {
          journal!.phase = 'payment-signing'
          // The wallet's payment has no hash yet, even when an earlier one reverted.
          delete journal!.paymentHash
          persist() // reload during the wallet prompt cannot silently pay again
          sending = true
        },
        onSent: payments => {
          sending = false
          journal!.payments = payments
          journal!.paymentHash = payments[payments.length - 1].hash
          journal!.phase = 'submitted'
          persist()
        },
      }))
    } catch (error) {
      const outcome = relayrPaymentAttemptOutcome(error, { sending, paid: !!journal.payments?.length })
      if (outcome === 'reverted') journal.phase = 'payment-reverted'
      if (outcome === 'unpaid') {
        journal.phase = 'quoted'
        delete journal.paymentChainId
        delete journal.paymentDeadline
        delete current.paymentChainId
      }
      if (outcome) persist()
      throw error
    }
    journal.phase = 'executing'
    persist()
    onProgress('Payment confirmed. Checking each destination launch onchain.')
    try {
      journal.records = await relayrPoll(journal.quote!.bundle_uuid, journal.signed.length, records => {
        journal!.records = records
        persist()
      })
    } catch { /* Reconcile exact receipts even when the provider calls the bundle failed. */ }
    persist()
    if (!(await reconcile())) {
      throw new Error('Some destination launches are unfinished. Resume this launch to check them; confirmed projects are kept.')
    }
  }
}
