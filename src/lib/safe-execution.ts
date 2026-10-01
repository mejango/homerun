import { getAddress, isAddress, type Address, type Hex } from 'viem'

/**
 * What a receipt proves about one Safe transaction:
 *
 * - `success`: the Safe logged ExecutionSuccess for it;
 * - `failed`: the Safe ran it and its call failed (ExecutionFailure). A Safe
 *   signed with a nonzero safeTxGas or gasPrice logs this instead of reverting,
 *   so the receipt itself reads success. The nonce is spent;
 * - `reverted`: the outer transaction reverted, so the Safe ran nothing;
 * - `unproven`: no exact event for it, more than one, or a malformed one.
 *
 * The same function as `safeExecutionResult` in @bananapus/nana-sdk-core's
 * `/safe-service` from 2.18, with its review's rules: a refund does not void an
 * execution's proof, and only this transaction's own event decides.
 */
export type SafeExecutionResult =
  | { status: 'success' }
  | { status: 'failed' }
  | { status: 'reverted' }
  | { status: 'unproven'; reason: string }

/** `ExecutionSuccess(bytes32,uint256)` and `ExecutionFailure(bytes32,uint256)`, the same in Safe 1.3 and 1.4. */
const EXECUTION_SUCCESS_TOPIC = '0x442e715f626346e8c54381002da614f62bee8d27386535b2521ec8540898556e'
const EXECUTION_FAILURE_TOPIC = '0x23428b18acfb3ea64b08dc0c1d296ea9c09702c09083ca5272e64d115b687d23'

/** `txHash` is null when the event is too malformed to say which transaction it is for. */
type SafeExecutionEvent = { failed: boolean; txHash: string | null; malformed: boolean }

function isBytes32(value: unknown): value is Hex {
  return typeof value === 'string' && /^0x[0-9a-f]{64}$/iu.test(value)
}

/**
 * A Safe execution event in the Safe 1.4 layout (txHash indexed, the payment
 * the data word) or the Safe 1.3 layout (txHash then the payment in data).
 * The payment is a refund to the executor and says nothing about the result.
 * Null for another event.
 */
function safeExecutionEvent(log: { topics?: unknown; data?: unknown }): SafeExecutionEvent | null {
  const topics = Array.isArray(log.topics) ? log.topics : []
  const topic = typeof topics[0] === 'string' ? topics[0].toLowerCase() : ''
  if (topic !== EXECUTION_SUCCESS_TOPIC && topic !== EXECUTION_FAILURE_TOPIC) return null
  const failed = topic === EXECUTION_FAILURE_TOPIC
  const data = typeof log.data === 'string' ? log.data.toLowerCase() : ''
  if (topics.length === 2) {
    const txHash = isBytes32(topics[1]) ? topics[1].toLowerCase() : null
    return { failed, txHash, malformed: !txHash || !/^0x[\da-f]{64}$/.test(data) }
  }
  if (topics.length === 1) {
    const txHash = /^0x[\da-f]{64}/.test(data) ? data.slice(0, 66) : null
    return { failed, txHash, malformed: !/^0x[\da-f]{128}$/.test(data) }
  }
  return { failed, txHash: null, malformed: true }
}

/**
 * What `receipt` proves about the Safe transaction `hash` on `safe`. `hash` is
 * what the wallet returned: the safeTxHash, or, when Safe{Wallet} executed the
 * proposal at once, the execution's own transaction hash. Then the receipt
 * must carry exactly one execution event of `safe`, whatever its hash.
 * Otherwise exactly one event for `hash`: another proposal's event, in the
 * same batch or not, is skipped and never decides. An event that may be this
 * transaction's but is malformed leaves the result unproven.
 */
export function safeExecutionResult(
  receipt: { status?: unknown; transactionHash?: unknown; logs?: readonly unknown[] },
  safe: Address,
  hash: Hex,
): SafeExecutionResult {
  if (typeof safe !== 'string' || !isAddress(safe)) throw new Error(`Invalid Safe address: ${String(safe)}.`)
  const address = getAddress(safe).toLowerCase()
  if (!isBytes32(hash)) throw new Error(`Invalid Safe transaction hash: ${String(hash)}.`)
  if (receipt?.status === 'reverted') return { status: 'reverted' }
  const unproven = (reason: string): SafeExecutionResult => ({ status: 'unproven', reason })
  if (receipt?.status !== 'success' || !Array.isArray(receipt.logs)) {
    return unproven(`The receipt has no success status and logs to prove ${hash} on Safe ${safe}.`)
  }
  const atOnce = typeof receipt.transactionHash === 'string' && receipt.transactionHash.toLowerCase() === hash.toLowerCase()
  const subject = atOnce ? `transaction ${hash}` : `Safe transaction ${hash}`
  const events: SafeExecutionEvent[] = []
  for (const log of receipt.logs as { address?: unknown; topics?: unknown; data?: unknown }[]) {
    if (typeof log?.address !== 'string' || log.address.toLowerCase() !== address) continue
    const event = safeExecutionEvent(log)
    // Another proposal's event never decides; one that cannot be read may be this one's.
    if (!event || (!atOnce && event.txHash !== null && event.txHash !== hash.toLowerCase())) continue
    if (event.malformed) {
      return unproven(`Safe ${safe} logged a malformed ${event.failed ? 'ExecutionFailure' : 'ExecutionSuccess'} event that may be for ${subject}.`)
    }
    events.push(event)
  }
  if (events.length === 0) {
    return unproven(`The receipt has no ExecutionSuccess or ExecutionFailure from Safe ${safe} for ${subject}.`)
  }
  if (events.length > 1) {
    return unproven(`Safe ${safe} logged ${events.length} execution results (${events.map(event => (event.failed ? 'ExecutionFailure' : 'ExecutionSuccess')).join(', ')}) for ${subject}, so the receipt proves none of them.`)
  }
  return events[0].failed ? { status: 'failed' } : { status: 'success' }
}
