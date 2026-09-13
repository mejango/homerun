import { jbControllerAbi, jbDirectoryAbi, jbMultiTerminalAbi, jbPermissionsAbi, jbProjectsAbi, jbSplitsAbi, NATIVE_TOKEN, revOwnerAbi, USDC_ADDRESSES, type JBChainId } from '@bananapus/nana-sdk-core'
import { buildSetSplitGroupsTx, JBPermissionIdsV6, payoutSplitGroupId, RESERVED_TOKEN_SPLIT_GROUP_ID, v6Address } from '@bananapus/nana-sdk-core/v6'
import { getAddress, isAddress, isAddressEqual, zeroAddress, type Address, type ContractFunctionReturnType, type Hex, type PublicClient } from 'viem'

export type ProjectSplit = ContractFunctionReturnType<typeof jbSplitsAbi, 'view', 'splitsOf'>[number]
export type ProjectSplitGroup = { groupId: bigint; label: string; kind: 'reserved' | 'payout'; splits: readonly ProjectSplit[]; fallback: readonly ProjectSplit[] }
export type ProjectSplitStage = { rulesetId: bigint; start: bigint; isCurrent: boolean; reservedPercent: number; groups: ProjectSplitGroup[] }
export type ProjectSplitsSnapshot = {
  chainId: JBChainId; projectId: bigint; phase: 'fund' | 'income'; blockNumber: bigint; blockHash: Hex; blockTimestamp: bigint
  owner: Address; controller: Address; account: Address | null; canEdit: boolean; currentRulesetId: bigint; stages: ProjectSplitStage[]
}
export type ProjectSplitDraft = { sourceIndex?: number; percent: string; recipient: 'wallet' | 'project'; beneficiary: string; projectId: string; preferAddToBalance: boolean; lockedUntil: string }
export const RESERVED_TOKEN_BURN_ADDRESS = '0x000000000000000000000000000000000000dEaD' as Address
export function isReservedTokenBurn(split: ProjectSplit, kind: ProjectSplitGroup['kind']): boolean { return kind === 'reserved' && split.projectId === 0n && isAddressEqual(split.hook, zeroAddress) && isAddressEqual(split.beneficiary, RESERVED_TOKEN_BURN_ADDRESS) }

export function formatSplitPercent(percent: number): string {
  if (!Number.isInteger(percent) || percent < 0 || percent > 1_000_000_000) throw new Error('Invalid split percentage.')
  const integer = Math.floor(percent / 10_000_000)
  const fraction = (percent % 10_000_000).toString().padStart(7, '0').replace(/0+$/, '')
  return `${integer}${fraction ? `.${fraction}` : ''}`
}
export function parseSplitPercent(value: string): number {
  if (!/^\d+(?:\.\d{1,7})?$/.test(value.trim())) throw new Error('Use a percentage with at most seven decimal places.')
  const [whole, fraction = ''] = value.trim().split('.')
  const units = BigInt(whole) * 10_000_000n + BigInt(fraction.padEnd(7, '0'))
  if (units <= 0n || units > 1_000_000_000n) throw new Error('Each split must be greater than 0% and at most 100%.')
  return Number(units)
}
function sameSplit(a: ProjectSplit, b: ProjectSplit, allowLongerLock = false): boolean {
  return a.percent === b.percent && a.projectId === b.projectId && a.preferAddToBalance === b.preferAddToBalance &&
    isAddressEqual(a.beneficiary, b.beneficiary) && isAddressEqual(a.hook, b.hook) &&
    (allowLongerLock ? b.lockedUntil >= a.lockedUntil : b.lockedUntil === a.lockedUntil)
}
export function sameProjectSplits(a: readonly ProjectSplit[], b: readonly ProjectSplit[]): boolean { return a.length === b.length && a.every((split, index) => sameSplit(split, b[index])) }
function validSplits(splits: readonly ProjectSplit[]) {
  if (splits.length > 64 || splits.some(split => !Number.isInteger(split.percent) || split.percent <= 0 || split.percent > 1_000_000_000) || splits.reduce((total, split) => total + split.percent, 0) > 1_000_000_000) throw new Error('The split table is invalid or exceeds the supported 64 recipients.')
}
export function projectSplitDrafts(group: ProjectSplitGroup): ProjectSplitDraft[] {
  return group.splits.map((split, sourceIndex) => ({ sourceIndex, percent: formatSplitPercent(split.percent), recipient: split.projectId ? 'project' : 'wallet', beneficiary: split.beneficiary, projectId: split.projectId ? split.projectId.toString() : '', preferAddToBalance: split.preferAddToBalance, lockedUntil: split.lockedUntil ? split.lockedUntil.toString() : '' }))
}

/** Read effective groups and their explicit fallback from one canonical block. No ruleset is queued by this editor. */
export async function readProjectSplitsSnapshot(client: PublicClient, input: { chainId: JBChainId; projectId: bigint; phase: 'fund' | 'income'; account?: Address }): Promise<ProjectSplitsSnapshot> {
  if (input.projectId <= 0n || input.projectId >= 1n << 256n || await client.getChainId() !== input.chainId) throw new Error('The project or RPC chain is invalid.')
  const block = await client.getBlock({ blockTag: 'latest' })
  if (block.number === null || !block.hash) throw new Error('A mined block is required to read project splits.')
  const at = { blockNumber: block.number }
  const controller = v6Address('JBController', input.chainId)
  const [owner, activeController, [current, currentMetadata], [latest, latestMetadata]] = await Promise.all([
    client.readContract({ address: v6Address('JBProjects', input.chainId), abi: jbProjectsAbi, functionName: 'ownerOf', args: [input.projectId], ...at }),
    client.readContract({ address: v6Address('JBDirectory', input.chainId), abi: jbDirectoryAbi, functionName: 'controllerOf', args: [input.projectId], ...at }),
    client.readContract({ address: controller, abi: jbControllerAbi, functionName: 'currentRulesetOf', args: [input.projectId], ...at }),
    client.readContract({ address: controller, abi: jbControllerAbi, functionName: 'latestQueuedRulesetOf', args: [input.projectId], ...at }),
  ])
  if (isAddressEqual(owner, zeroAddress) || !isAddressEqual(activeController, controller) || !current.id) throw new Error('This project does not use an active verified V6 controller.')
  const revOwner = v6Address('REVOwner', input.chainId)
  const isIncome = isAddressEqual(owner, revOwner)
  if (isIncome !== (input.phase === 'income')) throw new Error('The project phase or ownership changed. Refresh the project.')
  if (isIncome) {
    const ownerController = await client.readContract({ address: revOwner, abi: revOwnerAbi, functionName: 'CONTROLLER', ...at })
    if (!isAddressEqual(ownerController, controller)) throw new Error('The INCOME Owner uses an unsupported controller.')
  }
  function verifyMetadata(metadata: typeof currentMetadata) {
    if (isIncome && (!isAddressEqual(metadata.dataHook, revOwner) || !metadata.useDataHookForPay || !metadata.useDataHookForCashOut)) throw new Error('An INCOME stage is not governed by the verified revnet.')
  }
  verifyMetadata(currentMetadata); verifyMetadata(latestMetadata)
  const canEdit = !!input.account && (isAddressEqual(input.account, owner) || await client.readContract({ address: v6Address('JBPermissions', input.chainId), abi: jbPermissionsAbi, functionName: 'hasPermission', args: [input.account, owner, input.projectId, BigInt(JBPermissionIdsV6.SET_SPLIT_GROUPS), true, true], ...at }))
  const selected = [{ ruleset: current, metadata: currentMetadata }]
  const seen = new Set<number>()
  let cursor = latest; let cursorMetadata = latestMetadata
  while (cursor.id !== current.id) {
    if (!cursor.id || seen.has(cursor.id) || seen.size >= 32 || BigInt(cursor.start) <= block.timestamp) throw new Error('The queued stage schedule could not be verified. Refresh before editing splits.')
    seen.add(cursor.id); verifyMetadata(cursorMetadata); selected.push({ ruleset: cursor, metadata: cursorMetadata })
    const [previous, metadata] = await client.readContract({ address: controller, abi: jbControllerAbi, functionName: 'getRulesetOf', args: [input.projectId, BigInt(cursor.basedOnId)], ...at })
    if (previous.id !== cursor.basedOnId) throw new Error('The queued stage ancestry is inconsistent.')
    cursor = previous; cursorMetadata = metadata
  }
  const groups: Pick<ProjectSplitGroup, 'groupId' | 'kind' | 'label'>[] = [{ groupId: RESERVED_TOKEN_SPLIT_GROUP_ID, kind: 'reserved', label: 'Reserved tokens' }]
  if (!isIncome) {
    const terminal = v6Address('JBMultiTerminal', input.chainId)
    const terminals = await client.readContract({ address: v6Address('JBDirectory', input.chainId), abi: jbDirectoryAbi, functionName: 'terminalsOf', args: [input.projectId], ...at })
    if (terminals.some(address => isAddressEqual(address, terminal))) {
      const contexts = await client.readContract({ address: terminal, abi: jbMultiTerminalAbi, functionName: 'accountingContextsOf', args: [input.projectId], ...at })
      if (contexts.length > 32) throw new Error('This project has more payment currencies than this editor supports.')
      for (const context of contexts) {
        const groupId = payoutSplitGroupId(context.token)
        if (!groups.some(group => group.groupId === groupId)) groups.push({ groupId, kind: 'payout', label: isAddressEqual(context.token, NATIVE_TOKEN) ? 'ETH payouts' : isAddressEqual(context.token, USDC_ADDRESSES[input.chainId]) ? 'USDC payouts' : `Token payouts (${context.token})` })
      }
    }
  }
  const fallbacks = await Promise.all(groups.map(group => client.readContract({ address: v6Address('JBSplits', input.chainId), abi: jbSplitsAbi, functionName: 'splitsOf', args: [input.projectId, 0n, group.groupId], ...at })))
  fallbacks.forEach(validSplits)
  const stages = await Promise.all(selected.sort((a, b) => a.ruleset.start - b.ruleset.start).map(async ({ ruleset, metadata }) => ({
    rulesetId: BigInt(ruleset.id), start: BigInt(ruleset.start), isCurrent: ruleset.id === current.id, reservedPercent: metadata.reservedPercent,
    groups: await Promise.all(groups.map(async (group, index) => {
      const splits = await client.readContract({ address: v6Address('JBSplits', input.chainId), abi: jbSplitsAbi, functionName: 'splitsOf', args: [input.projectId, BigInt(ruleset.id), group.groupId], ...at })
      validSplits(splits)
      return { ...group, splits, fallback: fallbacks[index] }
    })),
  })))
  const canonical = await client.getBlock({ blockNumber: block.number })
  if (canonical.hash !== block.hash) throw new Error('The chain changed while reading project splits. Refresh and try again.')
  return { ...input, blockNumber: block.number, blockHash: block.hash, blockTimestamp: block.timestamp, account: input.account ?? null, owner, controller, canEdit, currentRulesetId: BigInt(current.id), stages }
}

export function buildProjectSplitsTx(snapshot: ProjectSplitsSnapshot, rulesetId: bigint, groupId: bigint, drafts: readonly ProjectSplitDraft[], options: { allowHookChanges?: boolean; allowBurn?: boolean } = {}) {
  if (!snapshot.account || !snapshot.canEdit) throw new Error('Connect the Owner or a wallet with permission to edit split groups.')
  const stage = snapshot.stages.find(stage => stage.rulesetId === rulesetId)
  const group = stage?.groups.find(group => group.groupId === groupId)
  if (!stage || !group || !rulesetId) throw new Error('Choose a current or queued stage and one of its verified split groups.')
  if (drafts.length > 64) throw new Error('A split group supports up to 64 recipients in this editor.')
  if (!drafts.length && group.fallback.length) throw new Error('Clearing this group would activate its default recipients. Keep at least one recipient to replace this stage’s splits explicitly.')
  const sourceIndexes = new Set<number>()
  const splits = drafts.map((draft): ProjectSplit => {
    if (draft.sourceIndex !== undefined && (!Number.isInteger(draft.sourceIndex) || draft.sourceIndex < 0 || !group.splits[draft.sourceIndex] || sourceIndexes.has(draft.sourceIndex))) throw new Error('A split row no longer matches the reviewed recipients.')
    if (draft.sourceIndex !== undefined) sourceIndexes.add(draft.sourceIndex)
    const existing = draft.sourceIndex === undefined ? undefined : group.splits[draft.sourceIndex]
    const hook = existing?.hook ?? zeroAddress
    const hooked = !isAddressEqual(hook, zeroAddress)
    const percent = parseSplitPercent(draft.percent)
    if (draft.recipient !== 'wallet' && draft.recipient !== 'project') throw new Error('Choose a wallet or project recipient.')
    if (!isAddress(draft.beneficiary)) throw new Error('Each recipient needs a valid wallet address.')
    const beneficiary = getAddress(draft.beneficiary)
    if (draft.recipient === 'project' && !/^\d+$/.test(draft.projectId)) throw new Error('Enter a positive recipient project ID.')
    const projectId = draft.recipient === 'project' ? BigInt(draft.projectId) : 0n
    if (projectId < 0n || projectId >= 1n << 64n || (draft.recipient === 'project' && projectId === 0n)) throw new Error('The recipient project ID must fit in a positive uint64.')
    if (!hooked && isAddressEqual(beneficiary, zeroAddress) && (!existing || !isAddressEqual(existing.beneficiary, zeroAddress) || existing.projectId !== projectId)) throw new Error('Use a nonzero recipient wallet. A zero beneficiary would pay the transaction caller.')
    if (!hooked && group.kind === 'reserved' && projectId === snapshot.projectId) throw new Error('Reserved tokens cannot be routed back to their own project.')
    if (draft.lockedUntil && !/^\d+$/.test(draft.lockedUntil)) throw new Error('The lock must be a whole Unix timestamp, or blank for no lock.')
    const lock = BigInt(draft.lockedUntil || '0')
    if (lock < 0n || lock >= 1n << 48n) throw new Error('The split lock exceeds the supported timestamp range.')
    const split = { percent, projectId, beneficiary, hook, preferAddToBalance: draft.preferAddToBalance, lockedUntil: Number(lock) }
    if (hooked && existing && (existing.projectId !== projectId || !isAddressEqual(existing.beneficiary, beneficiary) || existing.preferAddToBalance !== split.preferAddToBalance)) throw new Error('Existing hook routing is preserved. Its wallet, project and payment preference cannot be edited here.')
    if (group.kind === 'reserved' && split.preferAddToBalance !== (existing?.preferAddToBalance ?? false)) throw new Error('The add-to-balance preference applies to payouts. Reserved token distributions use the recipient project’s payment flow.')
    return split
  })
  validSplits(splits)
  // Keep effective inherited locks too: splitsOf does not expose whether a table
  // is stored locally or inherited. This conservative rule never bypasses a lock.
  const effective = splits.length ? splits : group.fallback
  const burnedPercent = (entries: readonly ProjectSplit[]) => entries.reduce((total, split) => total + (isReservedTokenBurn(split, group.kind) ? split.percent : 0), 0)
  if (!options.allowBurn && burnedPercent(effective) > burnedPercent(group.splits)) throw new Error('Confirm burning reserved tokens before increasing the share sent to the burn address. These tokens are destroyed instead of being received by a wallet.')
  for (const locked of group.splits.filter(split => BigInt(split.lockedUntil) > snapshot.blockTimestamp)) {
    const required = group.splits.filter(split => BigInt(split.lockedUntil) > snapshot.blockTimestamp && sameSplit(locked, split, true)).length
    const included = effective.filter(split => sameSplit(locked, split, true)).length
    if (included < required) throw new Error('Preserve every locked split, including its percentage, recipient and routing. Only its lock can be extended until it expires.')
  }
  const hooked = group.splits.filter(split => !isAddressEqual(split.hook, zeroAddress))
  if (!options.allowHookChanges && hooked.some(split => effective.filter(next => sameSplit(split, next)).length < hooked.filter(previous => sameSplit(split, previous)).length)) throw new Error('Confirm changes to existing hook allocations before changing or removing them. These may route FUND rewards or Sticky distributions.')
  if (sameProjectSplits(group.splits, effective)) throw new Error('The split recipients have not changed.')
  return buildSetSplitGroupsTx({ chainId: snapshot.chainId, projectId: snapshot.projectId, rulesetId, splitGroups: [{ groupId, splits }] })
}

export function assertSameProjectSplitsSnapshot(reviewed: ProjectSplitsSnapshot, latest: ProjectSplitsSnapshot, rulesetId: bigint, groupId: bigint) {
  const oldStage = reviewed.stages.find(stage => stage.rulesetId === rulesetId)
  const newStage = latest.stages.find(stage => stage.rulesetId === rulesetId)
  const oldGroup = oldStage?.groups.find(group => group.groupId === groupId)
  const newGroup = newStage?.groups.find(group => group.groupId === groupId)
  if (latest.blockNumber < reviewed.blockNumber || (latest.blockNumber === reviewed.blockNumber && latest.blockHash !== reviewed.blockHash) || latest.chainId !== reviewed.chainId || latest.projectId !== reviewed.projectId || latest.phase !== reviewed.phase || !latest.canEdit || !latest.account || !reviewed.account || !isAddressEqual(latest.account, reviewed.account) || !isAddressEqual(latest.owner, reviewed.owner) || !isAddressEqual(latest.controller, reviewed.controller) || latest.currentRulesetId !== reviewed.currentRulesetId || latest.stages.length !== reviewed.stages.length || latest.stages.some((stage, index) => stage.rulesetId !== reviewed.stages[index].rulesetId || stage.start !== reviewed.stages[index].start || stage.reservedPercent !== reviewed.stages[index].reservedPercent) || !oldStage || !newStage || !oldGroup || !newGroup || !sameProjectSplits(oldGroup.splits, newGroup.splits) || !sameProjectSplits(oldGroup.fallback, newGroup.fallback)) throw new Error('Project ownership, permissions, stages or selected split recipients changed during review. Review the refreshed splits.')
}
