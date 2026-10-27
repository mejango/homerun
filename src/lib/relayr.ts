'use client'

import {
  JBCoreContracts,
  erc2771ForwarderAbi,
  jbV6ContractAddress,
  type JBChainId,
} from '@bananapus/nana-sdk-core'
import type { ReviewedCall, ReviewedPlan } from '@bananapus/nana-sdk-core/review'
import {
  MAX_RELAYR_SENT_PAYMENTS,
  RELAYR_API,
  RELAYR_REQUEST_RUN_MARGIN_SECONDS,
  relayrForwarderDeadline,
  RelayrProofError,
  bindRelayrQuote,
  readRelayrBundle,
  relayrDestinationRecords as boundDestinationRecords,
  relayrBundleRequest,
  relayrPaymentDetails,
  requireRelayrRetry,
  sentRelayrPayment,
  verifyRelayrPayment,
  type RelayrBundle,
  type RelayrEntry,
  type RelayrQuote as SDKRelayrQuote,
  type RelayrTransactionRecord,
  type RelayrTransactionBinding,
  type RelayrPayment,
  type RelayrSentPayment,
} from '@bananapus/nana-sdk-core/review/relayr'
import { encodeFunctionData, type Abi, type Address, type Hex } from 'viem'
import { wagmiConfig } from '@/providers/Providers'
import { SUPPORTED_CHAINS } from '@/lib/chains'
import { fundingChainLabel } from '@/lib/transaction-review'
import { assertNoViewAs } from '@/lib/viewAs'
import { isSafeConnection } from '@/lib/safe-connector'
import { publicClient } from '@/lib/wallet-core'
import { reviewedSendDeps } from '@/lib/reviewed-send-deps'

const RELAYR_QUOTE_TIMEOUT_MS = 45_000
/**
 * Signatures are refreshed once less than this is left: a quote's payment window (about ten minutes,
 * with room to open the wallet) plus the SDK's run margin, so a quote keeps a payable option.
 */
export const RELAYR_SIGNATURE_REFRESH_SECONDS = 15 * 60 + RELAYR_REQUEST_RUN_MARGIN_SECONDS

/** Core's relayed signing, payment and polling, out of every page's first load. */
const loadRelayrEngine = () => import(/* webpackExports: ["signReviewed", "payRelayrReviewed", "pollRelayrBundle", "ReviewedCallRevertedError"] */ '@bananapus/nana-sdk-core/review')

export type { RelayrEntry, RelayrTransactionRecord, RelayrTransactionBinding } from '@bananapus/nana-sdk-core/review/relayr'

export type RelayrCall = {
  chainId: JBChainId
  target: Address
  data: Hex
  value?: bigint
  gas?: bigint
  label?: string
  abi?: Abi
  functionName?: string
  args?: readonly unknown[]
  contractName?: string
}

/** A relayed call as one review shows it (core's `reviewPlan`): the request its signer sends through the forwarder. */
export type RelayrPlanCall = ReviewedCall & { from: Address }

/** Older saved launches may lack quote bindings; recovery must keep them unresolved. */
export type RelayrQuote = Omit<SDKRelayrQuote, 'transactions' | 'expectedTransactions'> &
  Partial<Pick<SDKRelayrQuote, 'transactions' | 'expectedTransactions'>>

/**
 * The payment has a real transaction hash, but its receipt could not be
 * read. This is an unknown submitted outcome, never a failed/no-op outcome.
 */
export class RelayrPaymentSubmittedError extends Error {
  readonly name = 'RelayrPaymentSubmittedError'

  constructor(
    readonly hash: Hex,
    readonly chainId: number,
  ) {
    super(
      `Payment ${hash} was submitted on chain ${chainId}, but confirmation is not available yet. Do not pay again; resume the saved bundle instead.`,
    )
  }
}

/**
 * The client the SDK's Relayr rules read a chain through: the session rules'
 * finalized blocks (relayrRequestStates and relayrRequestsDead), the release
 * of a reverted quote (revertedRelayrQuote), the retry rule
 * (requireRelayrRetry) and the proof of a saved payment
 * (proveSavedRelayrPayment). None while the chain has no client here, which
 * those rules read as unknown.
 */
export function relayrChainClient(chainId: number): ReturnType<typeof publicClient> | undefined {
  try {
    return publicClient(chainId as JBChainId)
  } catch {
    return undefined
  }
}

function forwarderOf(chainId: number): Address {
  const forwarder = jbV6ContractAddress[JBCoreContracts.ERC2771Forwarder][chainId as JBChainId] as Address | undefined
  if (!forwarder) throw new Error(`No ERC-2771 forwarder on chain ${chainId}.`)
  return forwarder
}

/**
 * A relayed call through the canonical forwarder, keeping its real sender: `review` is the call one
 * review shows (core's `reviewPlan`), and `sign` has core sign that exact ERC-2771 request under the plan,
 * with no prompt of its own. The forwarder nonce is read now and must still be it, and the request
 * still far from its deadline, when the wallet signs.
 */
export async function prepareForwardedTx(
  call: RelayrCall,
  expectedAccount: Address,
  expectedNonce?: bigint,
): Promise<{ review: RelayrPlanCall; sign: (plan: ReviewedPlan) => Promise<RelayrEntry> }> {
  const forwarder = forwarderOf(call.chainId)
  const client = publicClient(call.chainId)
  const readNonce = () => client.readContract({ address: forwarder, abi: erc2771ForwarderAbi, functionName: 'nonces', args: [expectedAccount] })
  const nonce = await readNonce()
  if (expectedNonce !== undefined && nonce !== expectedNonce) {
    throw new Error('The previous relay authorization may have executed. Check its original bundle before signing again.')
  }
  const value = call.value ?? 0n
  const request = { from: expectedAccount, to: call.target, value, gas: call.gas ?? 500_000n, nonce, deadline: relayrForwarderDeadline(), data: call.data }
  const requireFresh = () => {
    if (request.deadline <= Math.floor(Date.now() / 1000) + RELAYR_SIGNATURE_REFRESH_SECONDS) throw new Error('The launch authorization changed or expired. Review it again.')
  }
  return {
    review: {
      chainId: call.chainId, from: expectedAccount, to: call.target, data: call.data, value, gas: request.gas,
      label: call.label ?? 'Relayed Juicebox transaction', abi: call.abi, functionName: call.functionName, args: call.args, contractName: call.contractName,
    },
    sign: async plan => {
      if ((await readNonce()) !== nonce) throw new Error('The launch authorization changed or expired. Review it again.')
      requireFresh()
      const { signReviewed } = await loadRelayrEngine()
      const [signature] = await signReviewed([{ kind: 'forward-request', chainId: call.chainId, request }], {
        account: expectedAccount, plan, reverify: async () => requireFresh(),
      }, { adapter: reviewedSendDeps.adapter })
      return {
        chain: call.chainId,
        target: forwarder,
        data: encodeFunctionData({
          abi: erc2771ForwarderAbi,
          functionName: 'execute',
          args: [{ from: request.from, to: request.to, value: request.value, gas: request.gas, deadline: request.deadline, data: request.data, signature }],
        }),
        value: value.toString(),
      }
    },
  }
}

class RelayrHttpTimeoutError extends Error {
  readonly name = 'RelayrHttpTimeoutError'
}

/**
 * Post the signed calls and bind Relayr's quote to them with the SDK: each call
 * takes the one quoted ID whose record carries its exact request, and the
 * bundle's records are exactly the quoted IDs. Throws, with nothing paid,
 * otherwise.
 */
export async function relayrPostBundle(
  transactions: RelayrEntry[],
): Promise<RelayrQuote> {
  const request = relayrBundleRequest(transactions)
  let response: Response
  try {
    response = await fetch(`${RELAYR_API}/v1/bundle/prepaid`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(RELAYR_QUOTE_TIMEOUT_MS),
    }).catch(error => {
      throw error instanceof DOMException && error.name === 'TimeoutError' ? new RelayrHttpTimeoutError() : error
    })
  } catch (error) {
    if (error instanceof RelayrHttpTimeoutError) {
      throw new Error(
        'The quote did not arrive in time. Nothing was paid. Resume the saved launch to check its authorizations before trying again.',
      )
    }
    throw error
  }
  return bindRelayrQuote(response, request)
}

export function relayrPaymentLabel(payment: RelayrPayment): string {
  const chain = SUPPORTED_CHAINS.find(item => item.id === Number(payment.chain))
  return fundingChainLabel(chain?.name ?? `Chain ${payment.chain}`, BigInt(payment.amount))
}

/**
 * Pays one option of a quote through core's `payRelayrReviewed`, which reviews it (or spends the
 * plan's fee bound for `planned`'s round, with no prompt), simulates, holds, sends and proves it.
 * This adds the launch journal's own rules: `reverify` and the option are rechecked right before the
 * wallet opens, and a quote paid before (`sent`) is paid again only when the SDK's retry rule clears
 * every earlier payment. Resolves with the hash the payment mined under and every payment sent for
 * the quote.
 */
export async function relayrPay({
  payment,
  account,
  quote,
  destinationChainIds,
  sent = [],
  planned,
  reverify,
  onSending,
  onSent,
}: {
  /** One of the quote's payment options, as Relayr returned it. */
  payment: RelayrPayment
  /** The account the payment was reviewed for. */
  account: Address
  quote: SDKRelayrQuote
  destinationChainIds: readonly number[]
  /** Every payment this session already sent for the quote, each under the hash it was mined. */
  sent?: readonly RelayrSentPayment[]
  /** The plan whose review showed this quote's round and its fee bound: a first payment within it is not asked again. */
  planned?: { plan: ReviewedPlan; round: string }
  /** Re-prove the bundle's calls before the payment and right before the wallet opens. */
  reverify?: () => Promise<void>
  /** Save the payment attempt before the wallet opens. */
  onSending?: () => unknown | Promise<unknown>
  /** Save every payment sent for the quote, again when this one is mined under another hash. */
  onSent?: (payments: RelayrSentPayment[]) => void
}): Promise<{ hash: Hex; payments: RelayrSentPayment[] }> {
  assertNoViewAs()
  // A Safe pays through its own execution, which no proof can read as this payment.
  if (isSafeConnection(wagmiConfig)) {
    throw new Error('Pay for relayed transactions from an ordinary wallet. Nothing was sent.')
  }
  if (sent.length >= MAX_RELAYR_SENT_PAYMENTS) {
    throw new Error('This quote was paid too many times to pay again. Keep it pending; do not pay again.')
  }
  const bundleUuid = quote.bundle_uuid
  const details = relayrPaymentDetails(payment, { bundleUuid, destinationChainIds })
  const readReviewed = () => {
    const current = relayrPaymentDetails(payment, { bundleUuid, destinationChainIds })
    if (current.chainId !== details.chainId || current.amount !== details.amount || current.calldata !== details.calldata) {
      throw new Error('The payment changed. Review the original funding choice again.')
    }
  }
  await reverify?.()
  const { payRelayrReviewed, ReviewedCallRevertedError } = await loadRelayrEngine()
  let payments = [...sent]
  let hash: Hex | undefined
  try {
    await payRelayrReviewed(quote, details.chainId, {
      account,
      ...(planned && !sent.length ? { plan: planned.plan, relayrRound: planned.round } : {}),
      onSending: async () => {
        assertNoViewAs()
        readReviewed()
        await reverify?.()
        if (sent.length) await requireRelayrRetry(relayrChainClient, { payments: sent, from: account, bundleUuid })
        await onSending?.()
      },
      onSent: async submitted => {
        hash = submitted
        // Once the wallet returns a hash, a storage, receipt or proof failure is an
        // uncertain submitted outcome, never permission to quote and pay again.
        payments = [...sent, sentRelayrPayment(details, submitted)]
        try {
          onSent?.(payments)
        } catch {
          throw new RelayrPaymentSubmittedError(submitted, details.chainId)
        }
      },
    }, reviewedSendDeps)
  } catch (error) {
    if (!hash) throw error
    if (error instanceof RelayrPaymentSubmittedError || error instanceof RelayrProofError) throw error
    // A reverted payment is proven as such: the proof decides a reverted quote's retry.
    if (error instanceof ReviewedCallRevertedError) {
      await verifyRelayrPayment(publicClient(details.chainId as JBChainId), { hash: error.hash, from: account, payment: details })
        .catch(proof => { if (proof instanceof RelayrProofError) throw proof })
    }
    throw new RelayrPaymentSubmittedError(hash, details.chainId)
  }
  return { hash: payments[payments.length - 1].hash, payments }
}

const recordsOf = (bundle: RelayrBundle | null) =>
  Array.isArray(bundle?.transactions) ? bundle.transactions as RelayrTransactionRecord[] : null

/**
 * Relayr's records of a bundle once every destination reports success, or, when that stops (Relayr
 * failed one, the wait ran out, Relayr is unreachable), its records as last read; null when none can be
 * read. Relayr's word only points at hashes: the caller proves each destination onchain.
 */
export async function relayrRecords(uuid: string, expectedCount: number, { timeoutMs, onRecords }: {
  timeoutMs?: number
  /** Each read's records as they arrive, so a reload keeps every hash already seen. */
  onRecords?: (records: RelayrTransactionRecord[]) => void
} = {}): Promise<RelayrTransactionRecord[] | null> {
  const { pollRelayrBundle } = await loadRelayrEngine()
  /** The bundle as the poll last read it: a poll that stops on a failed chain still saw the others' hashes. */
  let last: RelayrBundle | null = null
  const watched: typeof fetch = async (...args) => {
    const response = await fetch(...args)
    try {
      const bundle = await response.clone().json() as RelayrBundle
      if (String(bundle?.bundle_uuid).toLowerCase() === uuid.toLowerCase()) {
        last = bundle
        const records = recordsOf(bundle)
        if (records?.length) onRecords?.(records)
      }
    } catch { /* The poll reports the unreadable answer, and the caller's journal its own failure. */ }
    return response
  }
  try {
    return recordsOf(await pollRelayrBundle(uuid, expectedCount, { fetch: watched, ...(timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {}) }))
  } catch {
    return recordsOf(last) ?? recordsOf(await readRelayrBundle(uuid).catch(() => null))
  }
}

/** Preserve a readable recovery refusal while the SDK owns record binding. */
export function relayrDestinationRecords(
  records: readonly RelayrTransactionRecord[],
  bindings: readonly RelayrTransactionBinding[],
): { records: RelayrTransactionRecord[]; refusal: string | null } {
  try {
    return { records: boundDestinationRecords({ records, bindings }), refusal: null }
  } catch (error) {
    return { records: [], refusal: error instanceof Error ? error.message : 'The destination transactions could not be verified. Keep the original bundle pending.' }
  }
}
