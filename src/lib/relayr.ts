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
  RELAYR_UUID_RE,
  RelayrProofError,
  bindRelayrQuote,
  relayrBundleRequest,
  relayrDestinationHash,
  relayrPaymentDetails,
  relayrProgress,
  relayrRecordChain,
  relayrStateIsSuccess,
  requireRelayrPaymentRuntime,
  requireRelayrRetry,
  sentRelayrPayment,
  simulateRelayrPayment,
  verifyRelayrPayment,
  type RelayrPayment,
  type RelayrSentPayment,
} from '@bananapus/nana-sdk-core/review/relayr'
import {
  encodeFunctionData,
  isAddress,
  isHash,
  keccak256,
  stringToHex,
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
  connectedWallet as connectedWalletCore,
  publicClient,
} from '@/lib/wallet-core'

const RELAYR_QUOTE_TIMEOUT_MS = 45_000
const RELAYR_STATUS_REQUEST_TIMEOUT_MS = 15_000
/** Consecutive 404s that prove the uuid was never Relayr's, not a blip. */
const RELAYR_NOT_FOUND_ATTEMPTS = 3

export type RelayrEntry = {
  chain: number
  target: Address
  data: Hex
  value: string
  virtual_nonce?: number
}

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

/** Stable storage key for a particular set of authority calls. */
export function relayrCallsScope(calls: RelayrCall[]): string {
  const stableCalls = calls.map(call => [
    Number(call.chainId),
    call.target.toLowerCase(),
    call.data.toLowerCase(),
    (call.value ?? 0n).toString(),
  ])

  return `authority:${keccak256(stringToHex(JSON.stringify(stableCalls)))}`
}

type RelayrTransactionStatus = {
  state?: string
  data?: {
    hash?: Hex
    transaction?: { hash?: Hex }
  }
}

export type RelayrTransactionRecord = {
  chain?: number
  tx_uuid?: string
  request?: RelayrEntry
  status?: RelayrTransactionStatus
}

export type RelayrVerifiedDestination = {
  chainId: number
  receipt: TransactionReceipt
}

/** A posted transaction and the quoted ID whose record carries its exact request. */
export type RelayrTransactionBinding = {
  txUuid: string
  chain: number
  entry: RelayrEntry
}

export type RelayrQuote = {
  bundle_uuid: string
  payment_info: RelayrPayment[]
  /** Relayr's record for each posted transaction, in posted order. */
  transactions?: RelayrTransactionRecord[]
  /** Client-authenticated quote ordering; never accepted from status alone. */
  expectedTransactions?: RelayrTransactionBinding[]
}

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
 * The Relayr payment has a real transaction hash, but its receipt could not be
 * read. This is an unknown submitted outcome, never a failed/no-op outcome.
 */
export class RelayrPaymentSubmittedError extends Error {
  readonly name = 'RelayrPaymentSubmittedError'

  constructor(
    readonly hash: Hex,
    readonly chainId: number,
  ) {
    super(
      `Relayr payment ${hash} was submitted on chain ${chainId}, but confirmation is not available yet. Do not pay again; resume the saved bundle instead.`,
    )
  }
}

export class RelayrPaymentSendingError extends Error {
  readonly name = 'RelayrPaymentSendingError'
  constructor() {
    super('Your wallet may have sent the Relayr payment without returning its hash. Check the saved bundle and wallet activity; do not pay again.')
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
      throw new RelayrHttpTimeoutError('Relayr did not respond in time.')
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
  const activeAccount = getAccount(wagmiConfig).address
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
      'Your signature authorizes Relayr to submit this exact destination call onchain. The Raw view includes the full ERC-2771 request. The separate Relayr payment is reviewed before it is sent.',
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
    const currentNonce = await client.readContract({ address: forwarder, abi: erc2771ForwarderAbi, functionName: 'nonces', args: [expectedAccount] })
    if (currentNonce !== nonce || request.deadline <= Math.floor(Date.now() / 1000) + 120) throw new Error('The launch authorization changed or expired. Review it again.')
    const { wallet, account } = await connectedWallet(call.chainId)
    if (account.toLowerCase() !== expectedAccount.toLowerCase()) {
      throw new Error('Connected account changed. Review the cross-chain request again.')
    }
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

export async function buildForwardedTx(call: RelayrCall, expectedAccount: Address, expectedNonce?: bigint): Promise<RelayrEntry> {
  const prepared = await prepareForwardedTx(call, expectedAccount, expectedNonce)
  await requireTransactionReview(prepared.review)
  return prepared.sign()
}

const RELAYR_MAX_UINT256 = (1n << 256n) - 1n
const RELAYR_NO_PROOF =
  'This saved Relayr bundle lacks exact destination proof. Keep it pending and verify the original transactions; do not pay again.'
const RELAYR_NOT_IDENTIFIED =
  'Relayr has not identified every exact destination transaction. Keep checking the original bundle; do not pay again.'
const RELAYR_UNBOUND_STATUS =
  "Relayr's status names a transaction this quote did not bind. Keep the original bundle pending; do not pay again."
const RELAYR_MISMATCHED_CALL =
  "Relayr's destination call does not match the signed request. Keep the original bundle pending; do not pay again."
const RELAYR_SHARED_HASH =
  'Relayr reported one destination transaction for two signed calls. Keep the original bundle pending; do not pay again.'

function uuidOf(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const uuid = value.toLowerCase()
  return RELAYR_UUID_RE.test(uuid) ? uuid : null
}

/** A uint256 given as decimal or 0x-hex digits, a safe integer or a bigint. */
function uint256(value: unknown): bigint | null {
  let parsed: bigint
  if (typeof value === 'bigint') parsed = value
  else if (typeof value === 'number' && Number.isSafeInteger(value)) parsed = BigInt(value)
  else if (typeof value === 'string' && /^(?:0x[0-9a-f]+|\d+)$/iu.test(value)) parsed = BigInt(value)
  else return null
  return parsed >= 0n && parsed <= RELAYR_MAX_UINT256 ? parsed : null
}

function isHexBytes(value: unknown): value is Hex {
  return typeof value === 'string' && /^0x(?:[0-9a-f]{2})*$/iu.test(value)
}

function isAddressLike(value: unknown): value is Address {
  return typeof value === 'string' && isAddress(value, { strict: false })
}

type ReadEntry = { chain: number; target: Address; data: Hex; value: bigint }

function readEntry(entry: unknown): ReadEntry | null {
  if (!entry || typeof entry !== 'object') return null
  const { chain, target, data, value } = entry as Record<string, unknown>
  const amount = uint256(value)
  return typeof chain === 'number' && Number.isSafeInteger(chain) && chain > 0 &&
    isAddressLike(target) && isHexBytes(data) && amount !== null
    ? { chain, target, data, value: amount }
    : null
}

/**
 * Whether a record's request is the posted call: the same chain, target,
 * calldata and value, and the same virtual nonce (always when `nonce` is
 * 'required', else only when both carry one). Relayr echoes U256 values in
 * hex, so values compare as numbers.
 */
function isRequestFor(request: unknown, entry: RelayrEntry, nonce: 'required' | 'when-present'): boolean {
  const read = readEntry(request)
  const expected = readEntry(entry)
  if (!read || !expected) return false
  const quoted = (request as { virtual_nonce?: unknown }).virtual_nonce
  return read.chain === expected.chain &&
    read.target.toLowerCase() === expected.target.toLowerCase() &&
    read.data.toLowerCase() === expected.data.toLowerCase() &&
    read.value === expected.value &&
    (nonce === 'required'
      ? quoted === entry.virtual_nonce
      : typeof quoted !== 'number' || typeof entry.virtual_nonce !== 'number' || quoted === entry.virtual_nonce)
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
        'Relayr did not return a quote in time. Nothing was paid; it is safe to try again.',
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
  onSending?: () => void
  /** Save every payment sent for the quote, again when this one is mined under another hash. */
  onSent?: (payments: RelayrSentPayment[]) => void
}): Promise<{ hash: Hex; payments: RelayrSentPayment[] }> {
  assertNoViewAs()
  // A Safe pays through its own execution, which no proof can read as this payment.
  if (isSafeConnection(wagmiConfig)) {
    throw new Error('Pay for relayed transactions from an ordinary wallet. Nothing was sent.')
  }
  if (sent.length >= MAX_RELAYR_SENT_PAYMENTS) {
    throw new Error('This Relayr quote was paid too many times to pay again. Keep it pending; do not pay again.')
  }
  const reviewed = relayrPaymentDetails(payment, { bundleUuid, destinationChainIds })
  const readReviewed = () => {
    const current = relayrPaymentDetails(payment, { bundleUuid, destinationChainIds })
    if (current.chainId !== reviewed.chainId || current.amount !== reviewed.amount || current.calldata !== reviewed.calldata) {
      throw new Error('The Relayr payment changed. Review the original funding choice again.')
    }
    return current
  }
  await reverify?.()
  const chainId = reviewed.chainId as JBChainId
  const client = publicClient(chainId)
  await requireRelayrPaymentRuntime(client)

  await requireTransactionReview({
    title: 'Review Relayr payment',
    description:
      'This payment funds the Relayr bundle. Review its exact chain, destination, native value, and calldata before opening your wallet.',
    confirmLabel: 'Agree & pay Relayr',
    calls: [
      {
        chainId,
        from: expectedAccount,
        to: reviewed.target,
        value: reviewed.amount,
        gas: RELAYR_PAYMENT_GAS,
        data: reviewed.calldata,
        label: 'Pay for relayed transactions',
        contractName: 'Relayr prepaid payment',
      },
    ],
  })

  readReviewed()
  await reverify?.()
  const { wallet, account } = await connectedWallet(chainId)
  if (account.toLowerCase() !== expectedAccount.toLowerCase()) {
    throw new Error('Connected account changed. Review the Relayr payment again.')
  }
  await requireRelayrPaymentRuntime(client)
  await simulateRelayrPayment(client, { from: account, payment: reviewed })
  const live = getAccount(wagmiConfig).address
  if (!live || live.toLowerCase() !== expectedAccount.toLowerCase()) {
    throw new Error('Connected account changed. Review the Relayr payment again.')
  }
  // Review and wallet preparation are open-ended. Re-authenticate the exact
  // quote immediately before the fixed-gas write.
  const details = readReviewed()
  await reverify?.()
  if (sent.length) await requireRelayrRetry(relayrChainClient, { payments: sent, from: account, bundleUuid: details.bundleUuid })
  onSending?.()
  let hash: Hex
  try {
    hash = await wallet.sendTransaction({
      account,
      to: details.target,
      value: details.amount,
      data: details.calldata,
      gas: RELAYR_PAYMENT_GAS,
    })
  } catch (error) {
    if (isDefiniteWalletRejection(error)) throw error
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
            `Relayr cannot find bundle ${uuid}. Its payment and destination outcomes remain unresolved. Check the original bundle; do not pay again.`,
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
        `Relayr is still processing paid bundle ${uuid}. Do not submit this action again; check the original bundle later.`,
        'RELAYR_TIMEOUT',
        uuid,
        lastRecords,
        true,
      )
    }
    await new Promise(resolve => setTimeout(resolve, intervalMs))
  }
}

/**
 * The record Relayr's status holds for each binding, in binding order, or why
 * the status names none. The status names them only as a whole: its records
 * are exactly the quote's IDs, once each; each binding has exactly one record
 * on its chain that carries its exact request (a record without one pairs by
 * its ID); and no two records report one hash. A hash is only a pointer, so a
 * record without one still names its call. Receipts prove the calls.
 */
export function relayrDestinationRecords(
  records: readonly RelayrTransactionRecord[],
  bindings: readonly RelayrTransactionBinding[],
): { records: RelayrTransactionRecord[]; refusal: string | null } {
  const refused = (refusal: string) => ({ records: [], refusal })
  const ids = bindings.map(binding => uuidOf(binding?.txUuid))
  if (
    !bindings.length ||
    ids.some(id => id === null) ||
    new Set(ids).size !== bindings.length ||
    bindings.some(binding => readEntry(binding.entry)?.chain !== binding.chain)
  ) {
    return refused(RELAYR_NO_PROOF)
  }
  const quoted = new Set(ids)
  const recordIds = records.map(record => uuidOf(record?.tx_uuid))
  if (records.length !== bindings.length) return refused(RELAYR_NOT_IDENTIFIED)
  if (
    recordIds.some(id => id === null || !quoted.has(id)) ||
    new Set(recordIds).size !== records.length
  ) {
    return refused(RELAYR_UNBOUND_STATUS)
  }
  const destinations: RelayrTransactionRecord[] = []
  for (const [index, binding] of bindings.entries()) {
    const matches = records.filter((record, recordIndex) =>
      relayrRecordChain(record) === binding.chain &&
      (record.request !== undefined && record.request !== null
        ? isRequestFor(record.request, binding.entry, 'when-present')
        : recordIds[recordIndex] === ids[index]))
    if (matches.length !== 1) return refused(RELAYR_MISMATCHED_CALL)
    destinations.push(matches[0])
  }
  const hashes = destinations.flatMap(record => relayrDestinationHash(record) ?? [])
  if (new Set(hashes.map(hash => hash.toLowerCase())).size !== hashes.length) {
    return refused(RELAYR_SHARED_HASH)
  }
  return { records: destinations, refusal: null }
}

