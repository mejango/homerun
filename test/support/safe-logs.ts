import { encodeAbiParameters, toEventSelector, type Hex } from 'viem'

const SUCCESS = toEventSelector('ExecutionSuccess(bytes32,uint256)')
const FAILURE = toEventSelector('ExecutionFailure(bytes32,uint256)')

/**
 * A Safe's execution event for `txHash`, as Safe 1.4.1 logs it (txHash indexed,
 * payment the only data word) or as Safe 1.3 does (both in data). The SDK
 * creates 1.4.1 Safes.
 */
export function safeExecutionLog(
  safe: string,
  txHash: Hex,
  { failed = false, version = '1.4.1' }: { failed?: boolean; version?: '1.3' | '1.4.1' } = {},
): { address: string; topics: Hex[]; data: Hex } {
  const topic = failed ? FAILURE : SUCCESS
  return version === '1.4.1'
    ? { address: safe, topics: [topic, txHash], data: encodeAbiParameters([{ type: 'uint256' }], [0n]) }
    : { address: safe, topics: [topic], data: encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint256' }], [txHash, 0n]) }
}
