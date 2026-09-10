import { jbControllerAbi, jbSplitsAbi, type JBChainId } from '@bananapus/nana-sdk-core'
import { RESERVED_TOKEN_SPLIT_GROUP_ID, v6Address } from '@bananapus/nana-sdk-core/v6'
import { decodeEventLog, decodeFunctionData, encodeFunctionData, isAddressEqual, parseAbi, type Address, type ContractFunctionReturnType, type PublicClient, type TransactionReceipt } from 'viem'
import { readIncomeProjectState, type IncomeProjectState } from './income-state'

type ReservedSplits = ContractFunctionReturnType<typeof jbSplitsAbi, 'view', 'splitsOf'>
export type IncomeReservedSnapshot = {
  chainId: JBChainId; projectId: bigint; blockNumber: bigint; blockHash: `0x${string}`
  controller: Address; owner: Address; tokenAddress: Address | null; rulesetId: bigint
  pending: bigint; splits: ReservedSplits
}
const safeAbi = parseAbi([
  'function execTransaction(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,bytes signatures) returns (bool success)',
  'event ExecutionSuccess(bytes32 txHash,uint256 payment)',
])

/** The SDK has no convenience builder for this permissionless controller call. */
export function buildSendIncomeReservedTokensTx(chainId: JBChainId, projectId: bigint) {
  if (projectId <= 0n || projectId >= 1n << 256n) throw new Error('A positive INCOME project ID is required.')
  return { chainId, address: v6Address('JBController', chainId), abi: jbControllerAbi, functionName: 'sendReservedTokensToSplitsOf', args: [projectId] as const } as const
}

/** Current recipients and pending issuance are read at the same canonical block. */
export async function readIncomeReservedTokens(client: PublicClient, input: { chainId: JBChainId; projectId: bigint }): Promise<IncomeReservedSnapshot> {
  const state = await readIncomeProjectState(client, input)
  const splits = await client.readContract({ address: v6Address('JBSplits', input.chainId), abi: jbSplitsAbi, functionName: 'splitsOf', args: [input.projectId, BigInt(state.ruleset.id), RESERVED_TOKEN_SPLIT_GROUP_ID], blockNumber: state.blockNumber })
  if (splits.some(split => !Number.isInteger(split.percent) || split.percent < 0) || splits.reduce((total, split) => total + split.percent, 0) > 1_000_000_000) throw new Error('The reserved INCOME splits are inconsistent.')
  const block = await client.getBlock({ blockNumber: state.blockNumber })
  if (block.hash !== state.blockHash) throw new Error('The chain changed while reading reserved INCOME. Refresh and try again.')
  return { chainId: state.chainId, projectId: state.projectId, blockNumber: state.blockNumber, blockHash: state.blockHash, controller: state.controller, owner: state.owner, tokenAddress: state.tokenAddress, rulesetId: BigInt(state.ruleset.id), pending: state.pendingReservedTokens, splits }
}

function sameSplits(a: ReservedSplits, b: ReservedSplits) {
  return a.length === b.length && a.every((split, index) => {
    const other = b[index]
    return split.percent === other.percent && split.projectId === other.projectId && split.preferAddToBalance === other.preferAddToBalance && split.lockedUntil === other.lockedUntil && isAddressEqual(split.beneficiary, other.beneficiary) && isAddressEqual(split.hook, other.hook)
  })
}
export function assertIncomeReservedProject(snapshot: IncomeReservedSnapshot, state: IncomeProjectState) {
  if (snapshot.chainId !== state.chainId || snapshot.projectId !== state.projectId || !isAddressEqual(snapshot.controller, state.controller) || snapshot.tokenAddress?.toLowerCase() !== state.tokenAddress?.toLowerCase()) throw new Error('The INCOME project contracts changed. Refresh before distributing tokens.')
}
export function assertSameIncomeReservedTokens(reviewed: IncomeReservedSnapshot, latest: IncomeReservedSnapshot) {
  if (latest.blockNumber < reviewed.blockNumber || latest.chainId !== reviewed.chainId || latest.projectId !== reviewed.projectId || !isAddressEqual(latest.controller, reviewed.controller) || !isAddressEqual(latest.owner, reviewed.owner) || latest.tokenAddress?.toLowerCase() !== reviewed.tokenAddress?.toLowerCase() || latest.rulesetId !== reviewed.rulesetId || latest.pending !== reviewed.pending || !sameSplits(latest.splits, reviewed.splits)) throw new Error('The reserved INCOME amount or recipients changed during review. Review the refreshed distribution.')
  if (latest.pending <= 0n) throw new Error('There is no reserved INCOME to distribute.')
}

/** A successful outer Safe receipt does not establish delivery by its inner call. */
export async function verifyIncomeReservedReceipt(client: PublicClient, reviewed: IncomeReservedSnapshot, account: Address, receipt: TransactionReceipt) {
  if (receipt.status !== 'success' || receipt.blockNumber <= reviewed.blockNumber) throw new Error('The receipt does not prove a new successful reserved INCOME transaction.')
  if (await client.getChainId() !== reviewed.chainId) throw new Error('The receipt RPC returned a different chain.')
  const request = buildSendIncomeReservedTokensTx(reviewed.chainId, reviewed.projectId)
  const [block, transaction] = await Promise.all([client.getBlock({ blockNumber: receipt.blockNumber }), client.getTransaction({ hash: receipt.transactionHash })])
  if (block.hash?.toLowerCase() !== receipt.blockHash.toLowerCase() || transaction.hash.toLowerCase() !== receipt.transactionHash.toLowerCase() || transaction.blockNumber !== receipt.blockNumber || transaction.blockHash?.toLowerCase() !== receipt.blockHash.toLowerCase()) throw new Error('The reserved INCOME receipt is no longer a matching canonical execution.')
  const data = encodeFunctionData(request)
  if (transaction.to && isAddressEqual(transaction.to, account)) {
    const decoded = decodeFunctionData({ abi: safeAbi, data: transaction.input })
    const [to, value, innerData, operation] = decoded.args
    if (!isAddressEqual(to, request.address) || value !== 0n || innerData.toLowerCase() !== data.toLowerCase() || operation !== 0) throw new Error('The Safe executed a different reserved INCOME call.')
    if (!receipt.logs.some(log => {
      if (!isAddressEqual(log.address, account)) return false
      try { return decodeEventLog({ abi: safeAbi, eventName: 'ExecutionSuccess', data: log.data, topics: log.topics }).eventName === 'ExecutionSuccess' } catch { return false }
    })) throw new Error('The receipt does not prove successful execution by the Safe.')
  } else if (!transaction.to || !isAddressEqual(transaction.to, request.address) || !isAddressEqual(transaction.from, account) || transaction.value !== 0n || transaction.input.toLowerCase() !== data.toLowerCase()) throw new Error('The mined transaction differs from the reviewed reserved INCOME call.')

  const events = receipt.logs.filter(log => isAddressEqual(log.address, request.address)).flatMap(log => {
    try { return [decodeEventLog({ abi: jbControllerAbi, data: log.data, topics: log.topics })] } catch { return [] }
  })
  const summary = events.filter(event => event.eventName === 'SendReservedTokensToSplits' && event.args.projectId === reviewed.projectId && isAddressEqual(event.args.caller, account))
  if (summary.length !== 1 || summary[0].eventName !== 'SendReservedTokensToSplits' || summary[0].args.tokenCount <= 0n) throw new Error('The receipt does not prove exactly one reserved INCOME distribution.')
  const result = summary[0].args
  const recipients = events.filter(event => event.eventName === 'SendReservedTokensToSplit' && event.args.projectId === reviewed.projectId && isAddressEqual(event.args.caller, account))
  const actualSplits = recipients.flatMap(event => event.eventName === 'SendReservedTokensToSplit' ? [event.args.split] : [])
  if (result.rulesetId !== reviewed.rulesetId || !isAddressEqual(result.owner, reviewed.owner) || !sameSplits(reviewed.splits, actualSplits)) throw new Error('The transaction executed with different reserved INCOME recipients. Inspect the transaction before continuing.')
  let distributed = 0n
  for (const event of recipients) {
    if (event.eventName !== 'SendReservedTokensToSplit') continue
    if (event.args.rulesetId !== reviewed.rulesetId || event.args.groupId !== RESERVED_TOKEN_SPLIT_GROUP_ID || event.args.tokenCount !== result.tokenCount * BigInt(event.args.split.percent) / 1_000_000_000n) throw new Error('The receipt contains inconsistent reserved INCOME split amounts.')
    distributed += event.args.tokenCount
  }
  if (distributed + result.leftoverAmount !== result.tokenCount) throw new Error('The reserved INCOME receipt totals do not reconcile.')
  return {
    tokenCount: result.tokenCount,
    hookFailures: events.filter(event => event.eventName === 'SplitHookReverted' && event.args.projectId === reviewed.projectId).length,
    projectFallbacks: events.filter(event => event.eventName === 'ReservedDistributionReverted' && event.args.projectId === reviewed.projectId).length,
  }
}
