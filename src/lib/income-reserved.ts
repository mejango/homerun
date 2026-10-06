import { jbControllerAbi, jbSplitsAbi, type JBChainId } from '@bananapus/nana-sdk-core'
import { RESERVED_TOKEN_SPLIT_GROUP_ID, v6Address, verifyReservedDistributionReceipt } from '@bananapus/nana-sdk-core/v6'
import { decodeFunctionData, encodeFunctionData, isAddressEqual, type Address, type ContractFunctionReturnType, type PublicClient, type TransactionReceipt } from 'viem'
import { readIncomeProjectState, type IncomeProjectState } from './income-state'
import { sameProjectSplits } from './project-splits-edit'
import { requireSafeExecutionSuccess, SAFE_EXEC_ABI } from '@bananapus/nana-sdk-core/safe-service'

type ReservedSplits = ContractFunctionReturnType<typeof jbSplitsAbi, 'view', 'splitsOf'>
export type IncomeReservedSnapshot = {
  chainId: JBChainId; projectId: bigint; blockNumber: bigint; blockHash: `0x${string}`
  controller: Address; owner: Address; tokenAddress: Address | null; rulesetId: bigint; cycleNumber: bigint
  pending: bigint; splits: ReservedSplits
}

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
  return { chainId: state.chainId, projectId: state.projectId, blockNumber: state.blockNumber, blockHash: state.blockHash, controller: state.controller, owner: state.owner, tokenAddress: state.tokenAddress, rulesetId: BigInt(state.ruleset.id), cycleNumber: BigInt(state.ruleset.cycleNumber), pending: state.pendingReservedTokens, splits }
}

export function assertIncomeReservedProject(snapshot: IncomeReservedSnapshot, state: IncomeProjectState) {
  if (snapshot.chainId !== state.chainId || snapshot.projectId !== state.projectId || !isAddressEqual(snapshot.controller, state.controller) || snapshot.tokenAddress?.toLowerCase() !== state.tokenAddress?.toLowerCase()) throw new Error('The INCOME project contracts changed. Refresh before distributing tokens.')
}
export function assertSameIncomeReservedTokens(reviewed: IncomeReservedSnapshot, latest: IncomeReservedSnapshot) {
  if (latest.blockNumber < reviewed.blockNumber || latest.chainId !== reviewed.chainId || latest.projectId !== reviewed.projectId || !isAddressEqual(latest.controller, reviewed.controller) || !isAddressEqual(latest.owner, reviewed.owner) || latest.tokenAddress?.toLowerCase() !== reviewed.tokenAddress?.toLowerCase() || latest.rulesetId !== reviewed.rulesetId || latest.cycleNumber !== reviewed.cycleNumber || latest.pending !== reviewed.pending || !sameProjectSplits(latest.splits, reviewed.splits)) throw new Error('The reserved INCOME amount or recipients changed during review. Review the refreshed distribution.')
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
    const decoded = decodeFunctionData({ abi: SAFE_EXEC_ABI, data: transaction.input })
    if (decoded.functionName !== 'execTransaction') throw new Error('The Safe executed a different reserved INCOME call.')
    const [to, value, innerData, operation] = decoded.args
    if (!isAddressEqual(to, request.address) || value !== 0n || innerData.toLowerCase() !== data.toLowerCase() || operation !== 0) throw new Error('The Safe executed a different reserved INCOME call.')
    // This transaction is the Safe's one execTransaction, so the receipt must hold its one ExecutionSuccess.
    requireSafeExecutionSuccess(receipt, account, receipt.transactionHash)
  } else if (!transaction.to || !isAddressEqual(transaction.to, request.address) || !isAddressEqual(transaction.from, account) || transaction.value !== 0n || transaction.input.toLowerCase() !== data.toLowerCase()) throw new Error('The mined transaction differs from the reviewed reserved INCOME call.')

  // Reserves accrue until the distribution runs, and a Safe can execute it days after the review, so the receipt may
  // distribute more than was reviewed. Any count at or above the reviewed one confirms, with every reviewed split's
  // share, the owner's leftover and the burns checked against the count distributed, and that count is returned; a
  // smaller count (another distribution ran first), another ruleset or cycle, or a failed recipient is refused.
  return verifyReservedDistributionReceipt(receipt, {
    controller: request.address, tokens: v6Address('JBTokens', reviewed.chainId), projectId: reviewed.projectId,
    rulesetId: reviewed.rulesetId, cycleNumber: reviewed.cycleNumber, owner: reviewed.owner, caller: account,
    tokenCount: reviewed.pending, splits: reviewed.splits,
  })
}
