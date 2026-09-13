import { jbControllerAbi, jbDirectoryAbi, jbProjectsAbi, jbSplitsAbi, revOwnerAbi, type JBChainId } from '@bananapus/nana-sdk-core'
import { RESERVED_TOKEN_SPLIT_GROUP_ID, v6Address } from '@bananapus/nana-sdk-core/v6'
import { getAddress, isAddressEqual, zeroAddress, type Address, type Hex, type PublicClient } from 'viem'

export const PROJECT_OPERATOR_PROFILE_QUERY = 'project-operator-profile'
export const OPERATOR_BURN_ADDRESS = '0x000000000000000000000000000000000000dEaD' as Address

/** Direct zero recipients use the distributor's caller; the dead address burns reserved tokens. */
export function isOperatorWallet(address: Address) {
  return !isAddressEqual(address, zeroAddress) && !isAddressEqual(address, OPERATOR_BURN_ADDRESS)
}

export type CurrentProjectOperator = {
  chainId: JBChainId
  incomeProjectId: bigint
  blockNumber: bigint
  blockHash: Hex
  rulesetId: bigint
  reservedPercent: number
  /** Direct wallet recipients only. Project routes and split hooks are not people. */
  recipients: { address: Address; percent: number }[]
}

/** Read the currently active incentive recipients, independently of controller authority or URI profiles. */
export async function readCurrentProjectOperator(client: PublicClient, { chainId, incomeProjectId, minimumBlockNumber }: { chainId: JBChainId; incomeProjectId: bigint; minimumBlockNumber?: bigint }): Promise<CurrentProjectOperator> {
  if (incomeProjectId <= 0n || incomeProjectId >= 1n << 256n) throw new Error('A positive INCOME project ID is required.')
  if ((client.chain && client.chain.id !== chainId) || await client.getChainId() !== chainId) throw new Error('The RPC returned a different chain.')
  const controller = v6Address('JBController', chainId)
  const owner = v6Address('REVOwner', chainId)
  const block = await client.getBlock({ blockTag: 'latest' })
  if (block.number === null || !block.hash) throw new Error('The RPC did not return a mined block.')
  if (minimumBlockNumber !== undefined && block.number < minimumBlockNumber) throw new Error('The RPC has not caught up with the confirmed Operator update.')
  const at = { blockNumber: block.number }
  const [projectOwner, activeController, ownerController, [ruleset, metadata]] = await Promise.all([
    client.readContract({ address: v6Address('JBProjects', chainId), abi: jbProjectsAbi, functionName: 'ownerOf', args: [incomeProjectId], ...at }),
    client.readContract({ address: v6Address('JBDirectory', chainId), abi: jbDirectoryAbi, functionName: 'controllerOf', args: [incomeProjectId], ...at }),
    client.readContract({ address: owner, abi: revOwnerAbi, functionName: 'CONTROLLER', ...at }),
    client.readContract({ address: controller, abi: jbControllerAbi, functionName: 'currentRulesetOf', args: [incomeProjectId], ...at }),
  ])
  if (!isAddressEqual(projectOwner, owner) || !isAddressEqual(activeController, controller) || !isAddressEqual(ownerController, controller) || !isAddressEqual(metadata.dataHook, owner) || !metadata.useDataHookForPay || !metadata.useDataHookForCashOut) throw new Error('The current INCOME stage is not governed by the registered revnet contracts.')
  const rulesetId = BigInt(ruleset.id)
  if (rulesetId <= 0n || BigInt(ruleset.start) > block.timestamp || !Number.isInteger(metadata.reservedPercent) || metadata.reservedPercent < 0 || metadata.reservedPercent > 10_000) throw new Error('The current INCOME stage could not be verified.')
  const splits = await client.readContract({ address: v6Address('JBSplits', chainId), abi: jbSplitsAbi, functionName: 'splitsOf', args: [incomeProjectId, rulesetId, RESERVED_TOKEN_SPLIT_GROUP_ID], ...at })
  if (splits.some(split => !Number.isInteger(split.percent) || split.percent <= 0) || splits.reduce((sum, split) => sum + split.percent, 0) > 1_000_000_000) throw new Error('The current INCOME split percentages are inconsistent.')
  const recipients = new Map<Address, number>()
  // A zero reserve rate has no active incentive recipient, even if old rows remain in the namespace.
  if (metadata.reservedPercent > 0) for (const split of splits) {
    if (split.projectId !== 0n || !isAddressEqual(split.hook, zeroAddress) || !isOperatorWallet(split.beneficiary)) continue
    const address = getAddress(split.beneficiary)
    recipients.set(address, (recipients.get(address) ?? 0) + split.percent)
  }
  const canonical = await client.getBlock({ blockNumber: block.number })
  if (canonical.hash?.toLowerCase() !== block.hash.toLowerCase()) throw new Error('The chain changed while reading the current Operator. Refresh and try again.')
  return { chainId, incomeProjectId, blockNumber: block.number, blockHash: block.hash, rulesetId, reservedPercent: metadata.reservedPercent, recipients: Array.from(recipients, ([address, percent]) => ({ address, percent })) }
}
