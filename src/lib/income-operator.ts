import { jbControllerAbi, jbSplitsAbi, type JBChainId } from '@bananapus/nana-sdk-core'
import { buildSetSplitGroupsTx, RESERVED_TOKEN_SPLIT_GROUP_ID, v6Address } from '@bananapus/nana-sdk-core/v6'
import { decodeEventLog, decodeFunctionData, encodeFunctionData, getAddress, isAddress, isAddressEqual, parseAbi, zeroAddress, type Address, type ContractFunctionReturnType, type Hex, type PublicClient, type TransactionReceipt } from 'viem'
import { readIncomeProjectState } from './income-state'

type Splits = ContractFunctionReturnType<typeof jbSplitsAbi, 'view', 'splitsOf'>
export type IncomeOperatorStage = { rulesetId: bigint; start: bigint; isCurrent: boolean; splits: Splits; operatorIndex: number | null }
export type IncomeOperatorSnapshot = {
  chainId: JBChainId; projectId: bigint; blockNumber: bigint; blockHash: Hex; blockTimestamp: bigint
  controller: Address; owner: Address; account: Address | null; isOwner: boolean
  currentRulesetId: bigint; stages: IncomeOperatorStage[]
}
const safeAbi = parseAbi([
  'function execTransaction(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,bytes signatures) returns (bool success)',
  'event ExecutionSuccess(bytes32 txHash,uint256 payment)',
])

function sameSplits(a: Splits, b: Splits) {
  return a.length === b.length && a.every((split, index) => {
    const other = b[index]
    return split.percent === other.percent && split.projectId === other.projectId && split.preferAddToBalance === other.preferAddToBalance && split.lockedUntil === other.lockedUntil && isAddressEqual(split.beneficiary, other.beneficiary) && isAddressEqual(split.hook, other.hook)
  })
}

/** Authority and every remaining split namespace come from one canonical block, never project metadata. */
export async function readIncomeOperatorSnapshot(client: PublicClient, input: { chainId: JBChainId; projectId: bigint; account?: Address }): Promise<IncomeOperatorSnapshot> {
  const state = await readIncomeProjectState(client, input)
  const at = { blockNumber: state.blockNumber }
  const [latest, latestMetadata] = await client.readContract({ address: state.controller, abi: jbControllerAbi, functionName: 'latestQueuedRulesetOf', args: [input.projectId], ...at })
  if (!isAddressEqual(latestMetadata.dataHook, state.owner) || !latestMetadata.useDataHookForPay || !latestMetadata.useDataHookForCashOut) throw new Error('The latest INCOME stage is not governed by the verified revnet.')
  const currentRulesetId = BigInt(state.ruleset.id)
  const rulesets = [state.ruleset]
  const seen = new Set<bigint>()
  let cursor = latest
  // Walk the queue rather than updating only the nearest future stage. Changing
  // namespace 0 would leave these concrete stage recipients untouched.
  while (BigInt(cursor.id) !== currentRulesetId) {
    const id = BigInt(cursor.id)
    if (!id || seen.has(id) || seen.size >= 32 || BigInt(cursor.start) <= state.blockTimestamp) throw new Error('The INCOME stage schedule could not be verified.')
    seen.add(id); rulesets.push(cursor)
    const [previous, metadata] = await client.readContract({ address: state.controller, abi: jbControllerAbi, functionName: 'getRulesetOf', args: [input.projectId, BigInt(cursor.basedOnId)], ...at })
    if (BigInt(previous.id) !== BigInt(cursor.basedOnId) || !isAddressEqual(metadata.dataHook, state.owner) || !metadata.useDataHookForPay || !metadata.useDataHookForCashOut) throw new Error('The INCOME stage schedule changed or is not governed by the verified revnet.')
    cursor = previous
  }
  const stages = await Promise.all(rulesets.sort((a, b) => Number(BigInt(a.start) - BigInt(b.start))).map(async ruleset => {
    const rulesetId = BigInt(ruleset.id)
    const splits = await client.readContract({ address: v6Address('JBSplits', input.chainId), abi: jbSplitsAbi, functionName: 'splitsOf', args: [input.projectId, rulesetId, RESERVED_TOKEN_SPLIT_GROUP_ID], ...at })
    if (splits.some(split => !Number.isInteger(split.percent) || split.percent <= 0) || splits.reduce((sum, split) => sum + split.percent, 0) > 1_000_000_000) throw new Error('The INCOME split percentages are inconsistent.')
    const direct = splits.flatMap((split, index) => split.projectId === 0n && isAddressEqual(split.hook, zeroAddress) && !isAddressEqual(split.beneficiary, zeroAddress) ? [index] : [])
    if (direct.length > 1) throw new Error('This INCOME stage has multiple direct recipients. Its Operator cannot be identified safely.')
    return { rulesetId, start: BigInt(ruleset.start), isCurrent: rulesetId === currentRulesetId, splits, operatorIndex: direct[0] ?? null }
  }))
  const block = await client.getBlock({ blockNumber: state.blockNumber })
  if (block.hash !== state.blockHash) throw new Error('The chain changed while reading the INCOME Operator. Refresh and try again.')
  return { chainId: state.chainId, projectId: state.projectId, blockNumber: state.blockNumber, blockHash: state.blockHash, blockTimestamp: state.blockTimestamp, controller: state.controller, owner: state.owner, account: input.account ?? null, isOwner: !!input.account && state.isOperator, currentRulesetId, stages }
}

export function buildIncomeOperatorTx(snapshot: IncomeOperatorSnapshot, rulesetId: bigint, recipient: string) {
  if (!snapshot.isOwner || !snapshot.account) throw new Error('Connect the current Owner wallet to change the INCOME Operator.')
  if (!isAddress(recipient) || isAddressEqual(recipient, zeroAddress)) throw new Error('Enter a valid, nonzero Operator wallet address.')
  const stage = snapshot.stages.find(item => item.rulesetId === rulesetId)
  if (!stage || stage.operatorIndex === null) throw new Error('This INCOME stage has no Operator token split to change.')
  const existing = stage.splits[stage.operatorIndex]
  if (BigInt(existing.lockedUntil) > snapshot.blockTimestamp) throw new Error('This existing INCOME Operator split is locked onchain and cannot be changed before its lock expires.')
  const beneficiary = getAddress(recipient)
  if (isAddressEqual(existing.beneficiary, beneficiary)) throw new Error('This stage already pays that Operator wallet.')
  const splits = stage.splits.map((split, index) => index === stage.operatorIndex ? { ...split, beneficiary } : { ...split })
  return buildSetSplitGroupsTx({ chainId: snapshot.chainId, projectId: snapshot.projectId, rulesetId, splitGroups: [{ groupId: RESERVED_TOKEN_SPLIT_GROUP_ID, splits }] })
}

export function assertSameIncomeOperatorSnapshot(reviewed: IncomeOperatorSnapshot, latest: IncomeOperatorSnapshot) {
  if (latest.blockNumber === reviewed.blockNumber && latest.blockHash.toLowerCase() !== reviewed.blockHash.toLowerCase()) throw new Error('The chain changed during review. Review the refreshed INCOME Operator change.')
  if (!latest.isOwner || !latest.account || !reviewed.account || !isAddressEqual(latest.account, reviewed.account) || latest.blockNumber < reviewed.blockNumber || latest.chainId !== reviewed.chainId || latest.projectId !== reviewed.projectId || !isAddressEqual(latest.controller, reviewed.controller) || !isAddressEqual(latest.owner, reviewed.owner) || latest.currentRulesetId !== reviewed.currentRulesetId || latest.stages.length !== reviewed.stages.length || latest.stages.some((stage, index) => {
    const previous = reviewed.stages[index]
    return stage.rulesetId !== previous.rulesetId || stage.start !== previous.start || stage.isCurrent !== previous.isCurrent || stage.operatorIndex !== previous.operatorIndex || !sameSplits(stage.splits, previous.splits)
  })) throw new Error('The Owner, INCOME schedule, or split recipients changed during review. Review the refreshed change.')
}

/** A Safe proposal or successful outer transaction alone does not prove the split was changed. */
export async function verifyIncomeOperatorReceipt(client: PublicClient, snapshot: IncomeOperatorSnapshot, rulesetId: bigint, recipient: string, account: Address, receipt: TransactionReceipt) {
  if (!snapshot.account || !isAddressEqual(account, snapshot.account)) throw new Error('The receipt account differs from the reviewed Owner.')
  if (receipt.status !== 'success' || receipt.blockNumber <= snapshot.blockNumber) throw new Error('The receipt does not prove a new successful INCOME Operator change.')
  if (await client.getChainId() !== snapshot.chainId) throw new Error('The receipt RPC returned a different chain.')
  const request = buildIncomeOperatorTx(snapshot, rulesetId, recipient)
  const [block, transaction] = await Promise.all([client.getBlock({ blockNumber: receipt.blockNumber }), client.getTransaction({ hash: receipt.transactionHash })])
  if (block.hash?.toLowerCase() !== receipt.blockHash.toLowerCase() || transaction.hash.toLowerCase() !== receipt.transactionHash.toLowerCase() || transaction.blockNumber !== receipt.blockNumber || transaction.blockHash?.toLowerCase() !== receipt.blockHash.toLowerCase()) throw new Error('The INCOME Operator receipt is no longer a matching canonical execution.')
  const data = encodeFunctionData(request)
  if (transaction.to && isAddressEqual(transaction.to, account)) {
    const decoded = decodeFunctionData({ abi: safeAbi, data: transaction.input })
    const [to, value, innerData, operation] = decoded.args
    if (!isAddressEqual(to, request.address) || value !== 0n || innerData.toLowerCase() !== data.toLowerCase() || operation !== 0) throw new Error('The Safe executed a different INCOME Operator change.')
    if (!receipt.logs.some(log => {
      if (!isAddressEqual(log.address, account)) return false
      try { return decodeEventLog({ abi: safeAbi, eventName: 'ExecutionSuccess', data: log.data, topics: log.topics }).eventName === 'ExecutionSuccess' } catch { return false }
    })) throw new Error('The receipt does not prove successful execution by the Safe.')
  } else if (!transaction.to || !isAddressEqual(transaction.to, request.address) || !isAddressEqual(transaction.from, account) || transaction.value !== 0n || transaction.input.toLowerCase() !== data.toLowerCase()) throw new Error('The mined transaction differs from the reviewed INCOME Operator change.')
  const events = receipt.logs.filter(log => isAddressEqual(log.address, v6Address('JBSplits', snapshot.chainId))).flatMap(log => {
    try { return [decodeEventLog({ abi: jbSplitsAbi, eventName: 'SetSplit', data: log.data, topics: log.topics })] } catch { return [] }
  }).filter(event => event.args.projectId === snapshot.projectId && event.args.rulesetId === rulesetId && event.args.groupId === RESERVED_TOKEN_SPLIT_GROUP_ID)
  if (events.some(event => !isAddressEqual(event.args.caller, snapshot.controller)) || !sameSplits(request.args[2][0].splits, events.map(event => event.args.split))) throw new Error('The receipt does not prove the exact INCOME Operator change and preserved split recipients.')
  return { rulesetId, recipient: getAddress(recipient) }
}
