'use client'

import { getAccount } from '@wagmi/core'
import {
  JBCoreContracts,
  erc2771ForwarderAbi,
  jbContractAddress,
  type JBChainId,
} from '@bananapus/nana-sdk-core'
import {
  encodeFunctionData,
  formatEther,
  isAddress,
  isAddressEqual,
  keccak256,
  stringToHex,
  type Abi,
  type Address,
  type Hex,
  type TransactionReceipt,
} from 'viem'
import { wagmiConfig } from '@/providers/Providers'
import { SUPPORTED_CHAINS } from '@/lib/chains'
import { requireTransactionReview, type TransactionReviewRequest } from '@/lib/transaction-review'
import { assertNoViewAs } from '@/lib/viewAs'
import { relayrSupportsChain, relayrSupportsChains, relayrPaymentChains } from '@/lib/relayr-chains'
import {
  isSafeConnection,
  SAFE_NONCE_GUIDANCE,
  waitForSafeExecutionHash,
} from '@/lib/safe-connector'
import {
  connectedWallet as connectedWalletCore,
  publicClient,
} from '@/lib/wallet-core'

const RELAYR_API = 'https://api.relayr.ba5ed.com'
const RELAYR_QUOTE_TIMEOUT_MS = 45_000
const RELAYR_STATUS_REQUEST_TIMEOUT_MS = 15_000
/** Consecutive 404s that prove the uuid was never Relayr's, not a blip. */
const RELAYR_NOT_FOUND_ATTEMPTS = 3

/**
 * Relayr's immutable prepaid-native payment endpoint. A quote is untrusted
 * HTTP input, so accepting an arbitrary target and calldata here would turn
 * the quote service into a wallet transaction oracle.
 */
export const RELAYR_PAYMENT_ADDRESS =
  '0x1c05f7841379d4393574c0ffa17908ec40ffd97d' as Address
export const RELAYR_PAYMENT_SELECTOR = '0x103903a7'
export const RELAYR_PAYMENT_CODE_HASH =
  '0x6006b5acadb4cd60aa5c00cb844c34563e182dff83d4f4ff4fde226f7df16fa6' as Hex
export const RELAYR_NATIVE_TOKEN =
  '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' as Address
export const TRUSTED_FORWARDER_ABI = [{ type: 'function', name: 'isTrustedForwarder', stateMutability: 'view',
  inputs: [{ name: 'forwarder', type: 'address' }], outputs: [{ type: 'bool' }] }] as const
const RELAYR_PAYMENT_GAS = 150_000n
const RELAYR_PAYMENT_CODE_MAX_BYTES = 2_048
const RELAYR_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u

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

export type RelayrPayment = {
  chain: number
  amount: string
  calldata: Hex
  target: Address
  token?: Address
  payment_deadline?: number | string
}

export type RelayrPaymentDetails = {
  chainId: JBChainId
  target: Address
  amount: bigint
  calldata: Hex
  bundleUuid: string
  deadline: bigint
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

export type RelayrQuote = {
  bundle_uuid: string
  payment_info: RelayrPayment[]
  transactions?: RelayrTransactionRecord[]
  /** Client-authenticated quote ordering; never accepted from status alone. */
  expectedTransactions?: {
    txUuid: string
    chain: number
    entry: RelayrEntry
  }[]
}

type RelayrProgressSummary = { confirmed: number; failed: number; pending: number; total: number }
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

class RelayrPaymentRevertedError extends Error {
  readonly name = 'RelayrPaymentRevertedError'
  constructor() { super('Relayr payment reverted onchain.') }
}

/** Only an explicit wallet rejection proves that this send did not happen. */
export function relayrErrorIsDefiniteNoSubmission(error: unknown): boolean {
  let current = error
  for (let depth = 0; depth < 8 && current && typeof current === 'object'; depth++) {
    const item = current as { code?: unknown; name?: unknown; cause?: unknown }
    if (item.code === 4001 || item.name === 'UserRejectedRequestError') return true
    current = item.cause
  }
  return false
}

export function relayrStateIsSuccess(state?: string): boolean {
  const normalized = state?.trim().toLowerCase()
  return normalized === 'success' || normalized === 'completed'
}

export function relayrStateIsFailed(state?: string): boolean {
  return state?.trim().toLowerCase() === 'failed'
}

export function relayrProgress(
  records: RelayrTransactionRecord[],
  expectedCount = records.length,
): RelayrProgressSummary {
  const total = Math.max(expectedCount, records.length)
  const confirmed = records.filter(record =>
    relayrStateIsSuccess(record.status?.state),
  ).length
  const failed = records.filter(record =>
    relayrStateIsFailed(record.status?.state),
  ).length

  return {
    confirmed,
    failed,
    pending: Math.max(total - confirmed - failed, 0),
    total,
  }
}

/**
 * How long a signed ERC-2771 ForwardRequest stays valid. The forwarder rejects the request
 * after this, and pending sessions persist in localStorage indefinitely — so a bundle resumed
 * days later fails at the forwarder with the payment already made. {@link relayrSessionExpired}
 * lets the resume UI say so instead of offering a retry that cannot succeed.
 */
const FORWARDER_DEADLINE_SECONDS = 47 * 60 * 60

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

const FORWARD_REQUEST_TYPES = {
  ForwardRequest: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'gas', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint48' },
    { name: 'data', type: 'bytes' },
  ],
} as const

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
    deadline: Math.floor(Date.now() / 1000) + FORWARDER_DEADLINE_SECONDS,
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

export async function relayrPostBundle(
  transactions: RelayrEntry[],
): Promise<RelayrQuote> {
  if (!relayrSupportsChains([...new Set(transactions.map(transaction => transaction.chain))])) {
    throw new Error('Choose supported destinations from one network family: mainnets or testnets.')
  }
  const nextNonce = new Map<number, number>()
  const ordered = transactions.map(transaction => {
    const nonce = nextNonce.get(transaction.chain) ?? 0
    nextNonce.set(transaction.chain, nonce + 1)
    return { ...transaction, virtual_nonce: nonce }
  })
  let response: Response
  try {
    response = await relayrFetch(
      `${RELAYR_API}/v1/bundle/prepaid`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          transactions: ordered,
          virtual_nonce_mode: 'ChainIndependent',
        }),
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
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(
      `Relayr HTTP ${response.status}${detail ? `: ${detail.slice(0, 240)}` : ''}`,
    )
  }
  const body = (await response.json()) as Partial<RelayrQuote> & {
    tx_uuids?: unknown
    txn_uuids?: unknown
  }
  const bundleUuid = String(body.bundle_uuid ?? '').toLowerCase()
  if (!RELAYR_UUID_RE.test(bundleUuid)) {
    throw new Error('Relayr returned no valid bundle ID. Nothing was paid.')
  }
  const currentIds = Array.isArray(body.tx_uuids) ? body.tx_uuids : null
  const legacyIds = Array.isArray(body.txn_uuids) ? body.txn_uuids : null
  if (
    currentIds &&
    legacyIds &&
    JSON.stringify(currentIds) !== JSON.stringify(legacyIds)
  ) {
    throw new Error('Relayr returned conflicting transaction IDs. Nothing was paid.')
  }
  const rawIds = currentIds ?? legacyIds
  const txUuids = Array.isArray(rawIds)
    ? rawIds.map(value => String(value).toLowerCase())
    : []
  if (
    txUuids.length !== ordered.length ||
    txUuids.some(uuid => !RELAYR_UUID_RE.test(uuid)) ||
    new Set(txUuids).size !== ordered.length ||
    !Array.isArray(body.payment_info)
  ) {
    throw new Error(
      'Relayr did not bind every quoted transaction to a unique ID. Nothing was paid.',
    )
  }
  return {
    bundle_uuid: bundleUuid,
    payment_info: body.payment_info,
    transactions: Array.isArray(body.transactions) ? body.transactions : [],
    expectedTransactions: ordered.map((entry, index) => ({
      txUuid: txUuids[index],
      chain: entry.chain,
      entry,
    })),
  }
}

function relayrDeadlineSeconds(value: unknown): number | null {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    return value
  }
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    const numeric = Number(value)
    if (Number.isSafeInteger(numeric) && numeric >= 0) return numeric
  }
  const milliseconds = typeof value === 'string' ? Date.parse(value) : Number.NaN
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return null
  return Math.floor(milliseconds / 1_000)
}

/** Authenticate every field in Relayr's payment quote against its bundle. */
export function relayrPaymentDetails(
  payment: RelayrPayment,
  expectedBundleUuid: string,
  nowSeconds = Math.floor(Date.now() / 1_000),
): RelayrPaymentDetails {
  const chainId = Number(payment?.chain) as JBChainId
  if (
    !Number.isSafeInteger(chainId) ||
    !relayrSupportsChain(chainId) ||
    !SUPPORTED_CHAINS.some(chain => chain.id === chainId)
  ) {
    throw new Error('Relayr returned an unsupported payment chain.')
  }
  if (
    !payment ||
    !isAddress(payment.target) ||
    !isAddressEqual(payment.target, RELAYR_PAYMENT_ADDRESS)
  ) {
    throw new Error('Relayr returned an unrecognized payment contract.')
  }
  if (
    !payment.token ||
    !isAddress(payment.token) ||
    !isAddressEqual(payment.token, RELAYR_NATIVE_TOKEN)
  ) {
    throw new Error('Relayr returned an unsupported payment token.')
  }

  let amount: bigint
  try {
    amount = BigInt(payment.amount)
  } catch {
    throw new Error('Relayr returned an invalid payment amount.')
  }
  if (amount < 0n) throw new Error('Relayr returned an invalid payment amount.')

  const bundleUuid = String(expectedBundleUuid ?? '').toLowerCase()
  if (!RELAYR_UUID_RE.test(bundleUuid)) {
    throw new Error('Relayr returned an invalid bundle ID.')
  }

  const calldata = String(payment.calldata ?? '').toLowerCase()
  // selector + ABI word(bytes16, right-padded) + ABI word(uint40)
  if (!/^0x[0-9a-f]{136}$/.test(calldata)) {
    throw new Error('Relayr returned invalid payment calldata.')
  }
  if (calldata.slice(0, 10) !== RELAYR_PAYMENT_SELECTOR) {
    throw new Error('Relayr returned an unrecognized payment function.')
  }
  const compactUuid = bundleUuid.replaceAll('-', '')
  if (calldata.slice(10, 74) !== `${compactUuid}${'0'.repeat(32)}`) {
    throw new Error('Relayr payment calldata does not match this bundle.')
  }

  let deadline: bigint
  try {
    deadline = BigInt(`0x${calldata.slice(74, 138)}`)
  } catch {
    throw new Error('Relayr returned invalid payment calldata.')
  }
  if (deadline > 0xffffffffffn) {
    throw new Error('Relayr returned an invalid payment deadline.')
  }
  const quotedDeadline = relayrDeadlineSeconds(payment.payment_deadline)
  if (quotedDeadline === null || BigInt(quotedDeadline) !== deadline) {
    throw new Error('Relayr payment calldata does not match the quote deadline.')
  }
  if (deadline <= BigInt(nowSeconds + 15)) {
    throw new Error('This Relayr quote expired. Review the action again for a new quote.')
  }

  return {
    chainId,
    target: RELAYR_PAYMENT_ADDRESS,
    amount,
    calldata: calldata as Hex,
    bundleUuid,
    deadline,
  }
}

async function requireRelayrPaymentRuntime(
  client: ReturnType<typeof publicClient>,
): Promise<void> {
  const code = await client.request({
    method: 'eth_getCode',
    params: [RELAYR_PAYMENT_ADDRESS, 'latest'],
  })
  if (
    typeof code !== 'string' ||
    !/^0x(?:[0-9a-fA-F]{2})+$/.test(code) ||
    (code.length - 2) / 2 > RELAYR_PAYMENT_CODE_MAX_BYTES
  ) {
    throw new Error('Could not authenticate the Relayr payment contract.')
  }
  if (keccak256(code) !== RELAYR_PAYMENT_CODE_HASH) {
    throw new Error('Relayr payment contract code is not recognized.')
  }
}

async function simulateRelayrPayment(
  client: ReturnType<typeof publicClient>,
  account: Address,
  details: RelayrPaymentDetails,
): Promise<void> {
  const result = await client.request({
    method: 'eth_call',
    params: [
      {
        from: account,
        to: details.target,
        value: `0x${details.amount.toString(16)}`,
        data: details.calldata,
        gas: `0x${RELAYR_PAYMENT_GAS.toString(16)}`,
      },
      'latest',
    ],
  })
  if (result !== '0x') {
    throw new Error('Relayr payment simulation returned an unexpected result.')
  }
}

export function relayrPaymentLabel(payment: RelayrPayment): string {
  const chain = SUPPORTED_CHAINS.find(item => item.id === Number(payment.chain))
  const amount = formatEther(BigInt(payment.amount))
  return `${chain?.name ?? `Chain ${payment.chain}`} — ~${amount} ETH`
}

/** Invalid provider options never reach the funding picker or amount sorter. */
export function relayrPaymentOptions(quote: RelayrQuote, destinationChainIds: readonly number[]): RelayrPayment[] {
  const allowed = relayrPaymentChains([...new Set(destinationChainIds)])
  const options = quote.payment_info.filter(payment => {
    try { return allowed.includes(relayrPaymentDetails(payment, quote.bundle_uuid).chainId) } catch { return false }
  })
  const chains = new Set<number>()
  return options.filter(payment => {
    if (chains.has(payment.chain)) return false
    chains.add(payment.chain)
    return true
  })
}

export async function relayrPay(
  payment: RelayrPayment,
  expectedAccount: Address,
  expectedBundleUuid: string,
  destinationChainIds: readonly number[],
  onSubmitted?: (hash: Hex) => void,
  reverify?: () => Promise<void>,
  onSending?: () => void,
): Promise<Hex> {
  assertNoViewAs()
  const fundingChains = relayrPaymentChains([...new Set(destinationChainIds)])
  const readBoundPayment = () => {
    const current = relayrPaymentDetails(payment, expectedBundleUuid)
    if (!fundingChains.includes(current.chainId)) {
      throw new Error('Choose a supported Relayr funding chain in the same network family as these destinations.')
    }
    return current
  }
  let details = readBoundPayment()
  const reviewed = details
  await reverify?.()
  const chainId = details.chainId
  const client = publicClient(chainId)
  await requireRelayrPaymentRuntime(client)

  await requireTransactionReview({
    title: 'Review Relayr payment',
    description:
      'This payment funds the Relayr bundle. Review its exact chain, destination, native value, and calldata before opening your wallet.' +
      (isSafeConnection(wagmiConfig) ? ` ${SAFE_NONCE_GUIDANCE}` : ''),
    confirmLabel: isSafeConnection(wagmiConfig)
      ? 'Agree & continue to Safe'
      : 'Agree & pay Relayr',
    calls: [
      {
        chainId,
        from: expectedAccount,
        to: details.target,
        value: details.amount,
        data: details.calldata,
        label: 'Pay for relayed transactions',
        contractName: 'Relayr prepaid payment',
      },
    ],
  })

  details = readBoundPayment()
  if (details.chainId !== reviewed.chainId || details.amount !== reviewed.amount || details.calldata !== reviewed.calldata) {
    throw new Error('The Relayr payment changed. Review the original funding choice again.')
  }
  await reverify?.()
  const { wallet, account } = await connectedWallet(chainId)
  if (account.toLowerCase() !== expectedAccount.toLowerCase()) {
    throw new Error('Connected account changed. Review the Relayr payment again.')
  }
  await requireRelayrPaymentRuntime(client)
  await simulateRelayrPayment(client, account, details)
  const live = getAccount(wagmiConfig).address
  if (!live || live.toLowerCase() !== expectedAccount.toLowerCase()) {
    throw new Error('Connected account changed. Review the Relayr payment again.')
  }
  // Review and wallet preparation are open-ended. Re-authenticate the exact
  // quote immediately before the fixed-gas write.
  details = readBoundPayment()
  if (details.chainId !== reviewed.chainId || details.amount !== reviewed.amount || details.calldata !== reviewed.calldata) {
    throw new Error('The Relayr payment changed. Review the original funding choice again.')
  }
  await reverify?.()
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
    if (relayrErrorIsDefiniteNoSubmission(error)) throw error
    throw new RelayrPaymentSendingError()
  }
  const submittedHash = hash
  try {
    onSubmitted?.(submittedHash)
    if (isSafeConnection(wagmiConfig)) {
      hash = await waitForSafeExecutionHash(chainId, submittedHash)
    }
  } catch {
    // Once the wallet returns a hash, callback/storage or Safe execution-hash
    // tracking failures are uncertain submitted outcomes, never permission to
    // quote and pay this bundle again.
    throw new RelayrPaymentSubmittedError(submittedHash, chainId)
  }
  let receipt
  try {
    receipt = await client.waitForTransactionReceipt({ hash })
  } catch {
    throw new RelayrPaymentSubmittedError(hash, chainId)
  }
  if (receipt.status !== 'success') throw new RelayrPaymentRevertedError()
  return hash
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
      const response = await relayrFetch(
        `${RELAYR_API}/v1/bundle/${uuid}`,
        undefined,
        Math.min(RELAYR_STATUS_REQUEST_TIMEOUT_MS, Math.max(timeoutMs - elapsed, 1)),
      )
      if (response.status === 404) {
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
      if (response.ok) {
        const body = (await response.json()) as {
          transactions?: RelayrTransactionRecord[]
        }
        const records = body.transactions ?? []
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

export function relayrDestinationHash(
  record: RelayrTransactionRecord,
): Hex | null {
  return record.status?.data?.hash ?? record.status?.data?.transaction?.hash ?? null
}

/** Relayr's live status schema nests the destination chain under request. */
export function relayrRecordChain(
  record: RelayrTransactionRecord,
): number | null {
  const chain = record.request?.chain ?? record.chain
  return Number.isSafeInteger(chain) && Number(chain) > 0 ? Number(chain) : null
}

