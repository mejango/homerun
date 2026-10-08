'use client'

import { getAccount } from '@wagmi/core'
import {
  JBCoreContracts,
  erc2771ForwarderAbi,
  jbContractAddress,
  type JBChainId,
} from '@bananapus/nana-sdk-core'
import { isDefiniteWalletRejection } from '@bananapus/nana-sdk-core/review'
import {
  FORWARD_REQUEST_TYPES,
  MAX_RELAYR_SENT_PAYMENTS,
  RELAYR_API,
  RELAYR_FORWARDER_DEADLINE_SECONDS,
  RELAYR_PAYMENT_GAS,
  RelayrProofError,
  RelayrPaymentNotSentError,
  bindRelayrQuote,
  relayrDestinationRecords as boundDestinationRecords,
  relayrBundleRequest,
  relayrPaymentDetails,
  relayrProgress,
  relayrStateIsSuccess,
  relayrWalletPaymentError,
  requireRelayrPaymentRuntime,
  requireRelayrRetry,
  sentRelayrPayment,
  simulateRelayrPayment,
  verifyRelayrPayment,
  type RelayrEntry,
  type RelayrQuote as SDKRelayrQuote,
  type RelayrTransactionRecord,
  type RelayrTransactionBinding,
  type RelayrPayment,
  type RelayrSentPayment,
} from '@bananapus/nana-sdk-core/review/relayr'
import {
  encodeFunctionData,
  isHash,
  type Abi,
  type Address,
  type Hex,
  type TransactionReceipt,
} from 'viem'
import { wagmiConfig } from '@/providers/Providers'
import { SUPPORTED_CHAINS } from '@/lib/chains'
import { fundingChainLabel, requireTransactionReview, type TransactionReviewRequest } from '@/lib/transaction-review'
import { assertNoViewAs } from '@/lib/viewAs'
import { isSafeConnection } from '@/lib/safe-connector'
import {
  assertReviewedWallet,
  connectedWallet as connectedWalletCore,
  publicClient,
} from '@/lib/wallet-core'

const RELAYR_QUOTE_TIMEOUT_MS = 45_000
const RELAYR_STATUS_REQUEST_TIMEOUT_MS = 15_000
/** Consecutive 404s that prove the uuid was never Relayr's, not a blip. */
const RELAYR_NOT_FOUND_ATTEMPTS = 3

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

/** Older saved launches may lack quote bindings; recovery must keep them unresolved. */
export type RelayrQuote = Omit<SDKRelayrQuote, 'transactions' | 'expectedTransactions'> &
  Partial<Pick<SDKRelayrQuote, 'transactions' | 'expectedTransactions'>>

export type RelayrExecutionErrorCode =
  | 'RELAYR_FAILED'
  | 'RELAYR_TIMEOUT'
  | 'RELAYR_NOT_FOUND'

export class RelayrExecutionError extends Error {
  readonly name = 'RelayrExecutionError'

  constructor(
    message: string,
    readonly code: RelayrExecutionErrorCode,
    readonly bundleUuid: string,
    readonly records: RelayrTransactionRecord[],
    readonly retryable: boolean,
  ) {
    super(message)
  }
}

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

export class RelayrPaymentSendingError extends Error {
  readonly name = 'RelayrPaymentSendingError'
  constructor() {
    super('Your wallet may have sent the payment without returning its hash. Check the saved bundle and wallet activity; do not pay again.')
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

/**
 * The line a launch shows while one of its old requests can still run: until
 * `until` (seconds), or, once the clock is past it, until a finalized block is.
 */
export function relayrHeldMessage(until: number, nowMs = Date.now()): string {
  return until * 1_000 > nowMs
    ? `This launch's earlier signature can still run until ${new Date(until * 1_000).toLocaleString()}. Try again after that.`
    : "This launch's earlier signature may still run. Try again in a few minutes."
}

class RelayrHttpTimeoutError extends Error {
  readonly name = 'RelayrHttpTimeoutError'
}

async function relayrFetch(
  url: string,
  init: RequestInit | undefined,
  timeoutMs: number,
): Promise<Response> {
  try {
    return await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(Math.max(1, timeoutMs)),
    })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'TimeoutError') {
      throw new RelayrHttpTimeoutError('The transaction service did not respond in time.')
    }
    throw error
  }
}

function connectedWallet(chainId: JBChainId) {
  return connectedWalletCore(chainId, {
    requireUnchanged: true,
    changedError: 'Connected account changed. Review the cross-chain request again.',
  })
}

/** A relayed call must preserve the real sender through the canonical forwarder. */
export async function prepareForwardedTx(
  call: RelayrCall,
  expectedAccount: Address,
  expectedNonce?: bigint,
): Promise<{ review: TransactionReviewRequest; sign: () => Promise<RelayrEntry> }> {
  const forwarder = jbContractAddress['6'][JBCoreContracts.ERC2771Forwarder][
    call.chainId
  ] as Address | undefined
  if (!forwarder) throw new Error(`No ERC-2771 forwarder on chain ${call.chainId}.`)

  const client = publicClient(call.chainId)
  const preparedWallet = getAccount(wagmiConfig)
  const activeAccount = preparedWallet.address
  if (!activeAccount || activeAccount.toLowerCase() !== expectedAccount.toLowerCase()) {
    throw new Error('Connected account changed. Review the cross-chain request again.')
  }

  const [domain, nonce] = await Promise.all([
    client.readContract({
      address: forwarder,
      abi: erc2771ForwarderAbi,
      functionName: 'eip712Domain',
    }),
    client.readContract({
      address: forwarder,
      abi: erc2771ForwarderAbi,
      functionName: 'nonces',
      args: [expectedAccount],
    }),
  ])
  if (expectedNonce !== undefined && nonce !== expectedNonce) {
    throw new Error('The previous relay authorization may have executed. Check its original bundle before signing again.')
  }

  const value = call.value ?? 0n
  const request = {
    from: expectedAccount,
    to: call.target,
    value,
    gas: call.gas ?? 500_000n,
    nonce,
    deadline: Math.floor(Date.now() / 1000) + RELAYR_FORWARDER_DEADLINE_SECONDS,
    data: call.data,
  }
  const typedDomain = {
    name: domain[1],
    version: domain[2],
    chainId: BigInt(call.chainId),
    verifyingContract: forwarder,
  } as const
  const review: TransactionReviewRequest = {
    kind: 'authorization',
    title: 'Review relayed transaction',
    description:
      'Your signature authorizes this exact destination call onchain. The Raw view includes the full ERC-2771 request. The separate payment is reviewed before it is sent.',
    confirmLabel: 'Agree & sign relay request',
    authorization: {
      type: 'EIP-712 ForwardRequest',
      domain: typedDomain,
      primaryType: 'ForwardRequest',
      message: request,
    },
    calls: [
      {
        chainId: call.chainId,
        from: expectedAccount,
        to: call.target,
        value,
        gas: request.gas,
        data: call.data,
        label: call.label ?? 'Relayed Juicebox transaction',
        abi: call.abi,
        functionName: call.functionName,
        args: call.args,
        contractName: call.contractName,
      },
    ],
  }
  return { review, sign: async () => {
    const { wallet } = await connectedWallet(call.chainId)
    const currentNonce = await client.readContract({ address: forwarder, abi: erc2771ForwarderAbi, functionName: 'nonces', args: [expectedAccount] })
    if (currentNonce !== nonce || request.deadline <= Math.floor(Date.now() / 1000) + 120) throw new Error('The launch authorization changed or expired. Review it again.')
    assertReviewedWallet({ account: expectedAccount, connectorUid: preparedWallet.connector?.uid, chainId: call.chainId, safe: false }, 'Connected wallet changed. Review the cross-chain request again.')
    const signature = await wallet.signTypedData({
      account: expectedAccount,
      domain: typedDomain,
      types: FORWARD_REQUEST_TYPES,
      primaryType: 'ForwardRequest',
      message: request,
    })
  
    const live = getAccount(wagmiConfig).address
    if (!live || live.toLowerCase() !== expectedAccount.toLowerCase()) {
      throw new Error('Connected account changed. Review the cross-chain request again.')
    }
  
    return {
      chain: call.chainId,
      target: forwarder,
      data: encodeFunctionData({
        abi: erc2771ForwarderAbi,
        functionName: 'execute',
        args: [{
          from: request.from,
          to: request.to,
          value: request.value,
          gas: request.gas,
          deadline: request.deadline,
          data: request.data,
          signature,
        }],
      }),
      value: value.toString(),
    }
  } }
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
    response = await relayrFetch(
      `${RELAYR_API}/v1/bundle/prepaid`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      },
      RELAYR_QUOTE_TIMEOUT_MS,
    )
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
 * Review, simulate and send one payment for a quote from the account it was
 * reviewed for, then prove it from the chain with the SDK. The option is read
 * through relayrPaymentDetails before the review, after it and right before
 * sending, and must not change in between. A quote that was paid before is
 * paid again only when the SDK's retry rule (requireRelayrRetry) clears every
 * payment `sent` for it, right before the wallet opens. Resolves with the hash
 * the payment was mined under and every payment sent for the quote.
 */
export async function relayrPay({
  payment,
  account: expectedAccount,
  bundleUuid,
  destinationChainIds,
  sent = [],
  reverify,
  onSending,
  onSent,
}: {
  /** One of the quote's payment options, as Relayr returned it. */
  payment: RelayrPayment
  /** The account the payment was reviewed for. */
  account: Address
  bundleUuid: string
  destinationChainIds: readonly number[]
  /** Every payment this session already sent for the quote, each under the hash it was mined. */
  sent?: readonly RelayrSentPayment[]
  /** Re-prove the bundle's calls before the review, after it and right before sending. */
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
  const reviewedConnectorUid = getAccount(wagmiConfig).connector?.uid
  const reviewed = relayrPaymentDetails(payment, { bundleUuid, destinationChainIds })
  const readReviewed = () => {
    const current = relayrPaymentDetails(payment, { bundleUuid, destinationChainIds })
    if (current.chainId !== reviewed.chainId || current.amount !== reviewed.amount || current.calldata !== reviewed.calldata) {
      throw new Error('The payment changed. Review the original funding choice again.')
    }
    return current
  }
  await reverify?.()
  const chainId = reviewed.chainId as JBChainId
  const client = publicClient(chainId)
  await requireRelayrPaymentRuntime(client)

  await requireTransactionReview({
    title: 'Review payment',
    description:
      'This payment covers your transactions. Review its exact chain, destination, native value, and calldata before opening your wallet.',
    confirmLabel: 'Pay',
    calls: [
      {
        chainId,
        from: expectedAccount,
        to: reviewed.target,
        value: reviewed.amount,
        gas: RELAYR_PAYMENT_GAS,
        data: reviewed.calldata,
        label: 'Pay for relayed transactions',
        contractName: 'Transaction payment',
      },
    ],
  })

  readReviewed()
  await reverify?.()
  const { wallet, account } = await connectedWallet(chainId)
  if (account.toLowerCase() !== expectedAccount.toLowerCase()) {
    throw new Error('Connected account changed. Review the payment again.')
  }
  await requireRelayrPaymentRuntime(client)
  await simulateRelayrPayment(client, { from: account, payment: reviewed })
  const live = getAccount(wagmiConfig).address
  if (!live || live.toLowerCase() !== expectedAccount.toLowerCase()) {
    throw new Error('Connected account changed. Review the payment again.')
  }
  // Review and wallet preparation are open-ended. Re-authenticate the exact
  // quote immediately before the fixed-gas write.
  const details = readReviewed()
  await reverify?.()
  if (sent.length) await requireRelayrRetry(relayrChainClient, { payments: sent, from: account, bundleUuid: details.bundleUuid })
  // Every asynchronous proof above may outlive the connected wallet. The
  // captured wallet client cannot authorize a changed live account or chain.
  const assertReadyToSend = () => {
    assertReviewedWallet({ account: expectedAccount, connectorUid: reviewedConnectorUid, chainId, safe: false }, 'Connected wallet changed. Review the payment again.')
    readReviewed()
  }
  assertReadyToSend()
  await onSending?.()
  try {
    assertReadyToSend()
  } catch (error) {
    // The durable marker may have awaited storage. This refusal is known to
    // precede wallet invocation, so the SDK can restore its prior unpaid state.
    throw new RelayrPaymentNotSentError(error)
  }
  let hash: Hex
  try {
    hash = await wallet.sendTransaction({
      account,
      chain: SUPPORTED_CHAINS.find(chain => chain.id === chainId)!,
      to: details.target,
      value: details.amount,
      data: details.calldata,
      gas: RELAYR_PAYMENT_GAS,
    })
  } catch (error) {
    const walletError = relayrWalletPaymentError(error)
    if (isDefiniteWalletRejection(walletError)) throw walletError
    throw new RelayrPaymentSendingError()
  }
  // Once the wallet returns a hash, a storage, receipt or proof failure is an
  // uncertain submitted outcome, never permission to quote and pay again.
  let payments = [...sent, sentRelayrPayment(details, hash)]
  try {
    onSent?.(payments)
  } catch {
    throw new RelayrPaymentSubmittedError(hash, chainId)
  }
  let receipt: TransactionReceipt
  try {
    receipt = await client.waitForTransactionReceipt({ hash })
  } catch {
    throw new RelayrPaymentSubmittedError(hash, chainId)
  }
  // A wallet that sped the payment up mined it under another hash; that
  // transaction is the payment to prove and to remember.
  const mined = receipt.transactionHash
  if (typeof mined !== 'string' || !isHash(mined)) throw new RelayrPaymentSubmittedError(hash, chainId)
  if (mined.toLowerCase() !== hash.toLowerCase()) {
    payments = [...sent, sentRelayrPayment(details, mined)]
    try {
      onSent?.(payments)
    } catch {
      throw new RelayrPaymentSubmittedError(mined, chainId)
    }
  }
  try {
    await verifyRelayrPayment(client, { hash: mined, from: account, payment: details })
  } catch (error) {
    // A proof error is final: the payment reverted, or the mined transaction is another one.
    if (error instanceof RelayrProofError) throw error
    throw new RelayrPaymentSubmittedError(mined, chainId)
  }
  return { hash: mined, payments }
}

type RelayrBundleRead = { paymentReceived: unknown; records: RelayrTransactionRecord[] }

/**
 * One read of Relayr's bundle for relayrPoll, never from a cache: a cached
 * answer could hide a payment or a destination result. Resolves with what
 * Relayr reports when the answer names exactly this bundle, null when it does
 * not, and 'not-found' on a 404, which relayrPoll counts and the SDK's
 * readRelayrBundle reads as any other failed read. Throws while Relayr is
 * unreachable.
 */
async function readRelayrBundle(
  uuid: string,
  timeoutMs = RELAYR_STATUS_REQUEST_TIMEOUT_MS,
): Promise<RelayrBundleRead | 'not-found' | null> {
  const response = await relayrFetch(`${RELAYR_API}/v1/bundle/${uuid}`, { cache: 'no-store' }, timeoutMs)
  if (response.status === 404) return 'not-found'
  if (!response.ok) return null
  const { bundle_uuid: echoed, transactions, payment_received: paymentReceived } =
    ((await response.json()) ?? {}) as { bundle_uuid?: unknown; transactions?: unknown; payment_received?: unknown }
  return typeof echoed === 'string' && echoed.toLowerCase() === uuid.toLowerCase() && Array.isArray(transactions)
    ? { paymentReceived, records: transactions as RelayrTransactionRecord[] }
    : null
}

export async function relayrPoll(
  uuid: string,
  expectedCount: number,
  onUpdate?: (records: RelayrTransactionRecord[]) => void,
  intervalMs = 2_500,
  timeoutMs = 5 * 60_000,
): Promise<RelayrTransactionRecord[]> {
  if (!Number.isSafeInteger(expectedCount) || expectedCount < 1) {
    throw new Error('Relayr polling requires the exact destination count.')
  }
  const started = Date.now()
  let lastRecords: RelayrTransactionRecord[] = []
  // A bundle Relayr never had 404s forever. Reporting that as the "still
  // processing, do not submit again" timeout tells the user to wait on
  // something that does not exist.
  let consecutiveNotFound = 0
  for (;;) {
    try {
      const elapsed = Date.now() - started
      const read = await readRelayrBundle(uuid, Math.min(RELAYR_STATUS_REQUEST_TIMEOUT_MS, Math.max(timeoutMs - elapsed, 1)))
      if (read === 'not-found') {
        consecutiveNotFound += 1
        if (consecutiveNotFound >= RELAYR_NOT_FOUND_ATTEMPTS) {
          throw new RelayrExecutionError(
            `The original bundle could not be found: ${uuid}. Its payment and destination outcomes remain unresolved. Check the original bundle; do not pay again.`,
            'RELAYR_NOT_FOUND',
            uuid,
            lastRecords,
            false,
          )
        }
      } else {
        consecutiveNotFound = 0
      }
      const records = read && read !== 'not-found' ? read.records : null
      if (records) {
        lastRecords = records
        onUpdate?.(records)
        if (
          records.length === expectedCount &&
          records.every(record => relayrStateIsSuccess(record.status?.state))
        ) {
          return records
        }
        const progress = relayrProgress(records)
        if (progress.failed) {
          throw new RelayrExecutionError(
            `Could not execute on ${progress.failed} chain${progress.failed === 1 ? '' : 's'}.`,
            'RELAYR_FAILED',
            uuid,
            records,
            false,
          )
        }
      }
    } catch (error) {
      if (error instanceof RelayrExecutionError) throw error
    }
    if (Date.now() - started > timeoutMs) {
      throw new RelayrExecutionError(
        `Transactions are still processing for paid bundle ${uuid}. Do not submit this action again; check the original bundle later.`,
        'RELAYR_TIMEOUT',
        uuid,
        lastRecords,
        true,
      )
    }
    await new Promise(resolve => setTimeout(resolve, intervalMs))
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
