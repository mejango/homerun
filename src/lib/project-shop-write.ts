import { jb721TiersHookAbi, jb721TiersHookStoreAbi, jbControllerAbi, jbDirectoryAbi, jbPermissionsAbi, jbProjectsAbi, type JBChainId } from '@bananapus/nana-sdk-core'
import { BASE_CURRENCY_ETH, BASE_CURRENCY_USD, buildSetPermissionsTx, decodePermissionBitmap, getProject721Shop, JBPermissionIdsV6, v6Address, type JBRulesetConfig, type Project721Shop } from '@bananapus/nana-sdk-core/v6'
import { encodeFunctionData, isAddress, isAddressEqual, keccak256, toHex, zeroAddress, type Address, type ContractFunctionReturnType, type Hex, type PublicClient } from 'viem'
import type { TxRequest } from '@/hooks/useSafeTx'
import type { DemoShopCurrency, DemoShopItem } from './demo-shop'
import { readFundProjectState } from './fund-state'
import { readVerifiedProject721Hook } from './fund-hooks'
import { assertFirstProjectShopConfiguration, buildCreateProjectShopRequest } from './project-shop-create'
import { buildProjectShopTierConfigs, pinProjectShopItems, type PinnedProjectShopItem } from './project-shop-items'

type ShopFlags = ContractFunctionReturnType<typeof jb721TiersHookStoreAbi, 'view', 'flagsOf'>
type ShopTier = ContractFunctionReturnType<typeof jb721TiersHookStoreAbi, 'view', 'tierOf'>
type RequestKind = 'grant' | 'create' | 'adjust' | 'restore'
const QUEUE_BIT = 1n << BigInt(JBPermissionIdsV6.QUEUE_RULESETS)
const MAX_PLAN_LENGTH = 6 * 1024 * 1024

export type ProjectShopWriteState = {
  chainId: JBChainId
  projectId: bigint
  account: Address
  owner: Address
  controller: Address
  hookOwner: Address | null
  shop: Project721Shop | null
  blockNumber: bigint
  mode: 'existing' | 'create'
  pricing: { currency: number; decimals: number }
  currency: DemoShopCurrency | null
  symbol: string
  canAdd: boolean
  canRemove: boolean
  blockedReason: string | null
  flags: ShopFlags | null
  maxTierId: bigint
  rulesetId: number
  /** The hook/owner/configuration identity, excluding balances and sales. */
  identity: string
  create: {
    configuration: JBRulesetConfig | null
    projectUri: string
    deployerCanQueue: boolean
    deployerPermissions: bigint
    canManagePermissions: boolean
  } | null
}

export type PreparedProjectShopWrite = {
  version: 1
  snapshot: ProjectShopWriteState
  pinned: PinnedProjectShopItem[]
  removeTierIds: number[]
  /** Removal snapshots exclude remaining supply, so ordinary sales cannot block signing. */
  removalIdentity: string
  salt: Hex
  requests: TxRequest[]
  requestKinds: RequestKind[]
  notice: string
}

function stable(value: unknown): string {
  return JSON.stringify(value, (_key, entry) => typeof entry === 'bigint' ? { $bigint: entry.toString() } : entry)
}

function positiveProject(projectId: bigint): void {
  if (typeof projectId !== 'bigint' || projectId <= 0n || projectId >= 1n << 64n) throw new Error('A positive project ID within uint64 is required.')
}

async function permission(client: PublicClient, chainId: JBChainId, operator: Address, owner: Address, projectId: bigint, id: number): Promise<boolean> {
  return isAddressEqual(operator, owner) || client.readContract({ address: v6Address('JBPermissions', chainId), abi: jbPermissionsAbi, functionName: 'hasPermission', args: [operator, owner, projectId, BigInt(id), true, true] })
}

function currencyOf(pricing: Project721Shop['pricing']): DemoShopCurrency | null {
  return pricing.currency === BASE_CURRENCY_USD ? 'USD' : pricing.currency === BASE_CURRENCY_ETH ? 'ETH' : null
}

/** Every decision uses one mined block, including hook resolution and permissions. */
export async function readProjectShopWriteState(client: PublicClient, input: { chainId: JBChainId; projectId: bigint; account: Address }): Promise<ProjectShopWriteState> {
  const { chainId, projectId, account } = input
  positiveProject(projectId)
  if (!isAddress(account) || isAddressEqual(account, zeroAddress)) throw new Error('Connect the account that manages this shop.')
  if ((client.chain && client.chain.id !== chainId) || await client.getChainId() !== chainId) throw new Error('The shop RPC is connected to another chain.')
  const block = await client.getBlock({ blockTag: 'latest' })
  if (block.number === null || !block.hash) throw new Error('The shop RPC did not return a mined block.')
  const snapshot = {
    ...client,
    readContract: (args: Parameters<PublicClient['readContract']>[0]) => client.readContract({ ...args, blockNumber: block.number! }),
    getBlock: (args: Parameters<PublicClient['getBlock']>[0]) => args && 'blockNumber' in args ? client.getBlock(args) : Promise.resolve(block),
  } as PublicClient
  const [owner, controller, current] = await Promise.all([
    snapshot.readContract({ address: v6Address('JBProjects', chainId), abi: jbProjectsAbi, functionName: 'ownerOf', args: [projectId] }),
    snapshot.readContract({ address: v6Address('JBDirectory', chainId), abi: jbDirectoryAbi, functionName: 'controllerOf', args: [projectId] }),
    snapshot.readContract({ address: v6Address('JBController', chainId), abi: jbControllerAbi, functionName: 'currentRulesetOf', args: [projectId] }),
  ])
  if (isAddressEqual(owner, zeroAddress) || !isAddressEqual(controller, v6Address('JBController', chainId))) throw new Error('This project is not managed by the registered V6 controller.')
  const isRevnet = isAddressEqual(owner, v6Address('REVOwner', chainId))
  const shop = await getProject721Shop(snapshot, { chainId, projectId, isRevnet, tierLimit: 201 })
  let hookOwner: Address | null = null, flags: ShopFlags | null = null, maxTierId = 0n
  let canAdd = false, canRemove = false, blockedReason: string | null = null
  let create: ProjectShopWriteState['create'] = null
  const pricing = shop?.pricing ?? { currency: BASE_CURRENCY_USD, decimals: 6 }
  const currency = currencyOf(pricing)
  if (!Number.isInteger(pricing.decimals) || pricing.decimals < 0 || pricing.decimals > 255) blockedReason = 'This shop uses pricing precision unsupported by this editor.'
  if (!currency) blockedReason = 'This shop uses a custom pricing currency. Manage its items through Juicebox.'
  if (shop) {
    if (!isAddressEqual(shop.store, v6Address('JB721TiersHookStore', chainId)) || isAddressEqual(shop.hook, zeroAddress) || isAddressEqual(shop.metadataIdTarget, zeroAddress)) throw new Error('This shop does not use the registered V6 inventory store.')
    await readVerifiedProject721Hook(snapshot, { chainId, projectId, owner, hook: shop.hook, blockNumber: block.number, ownership: isRevnet ? 'address' : 'project' })
    const [actualOwner, hookProjectId, hookFlags, maximum] = await Promise.all([
      snapshot.readContract({ address: shop.hook, abi: jb721TiersHookAbi, functionName: 'owner' }),
      snapshot.readContract({ address: shop.hook, abi: jb721TiersHookAbi, functionName: 'projectId' }),
      snapshot.readContract({ address: shop.store, abi: jb721TiersHookStoreAbi, functionName: 'flagsOf', args: [shop.hook] }),
      snapshot.readContract({ address: shop.store, abi: jb721TiersHookStoreAbi, functionName: 'maxTierIdOf', args: [shop.hook] }),
    ])
    if (hookProjectId !== projectId || isAddressEqual(actualOwner, zeroAddress)) throw new Error('The shop belongs to a different project or has no owner.')
    hookOwner = actualOwner; flags = hookFlags; maxTierId = maximum
    const canAdjust = await permission(snapshot, chainId, account, hookOwner, projectId, JBPermissionIdsV6.ADJUST_721_TIERS)
    canAdd = canAdjust && !blockedReason
    canRemove = canAdjust
    if (!canAdjust) blockedReason = 'This account does not have permission to manage this shop’s items.'
  } else if (isRevnet) {
    blockedReason = 'This INCOME project has no shop hook. Its fixed launch configuration cannot attach a shop afterward.'
  } else {
    const fund = await readFundProjectState(snapshot, input)
    const deployer = v6Address('JB721TiersHookProjectDeployer', chainId)
    const [deployerCanQueue, deployerPermissions, canManagePermissions] = await Promise.all([
      permission(snapshot, chainId, deployer, owner, projectId, JBPermissionIdsV6.QUEUE_RULESETS),
      snapshot.readContract({ address: v6Address('JBPermissions', chainId), abi: jbPermissionsAbi, functionName: 'permissionsOf', args: [deployer, owner, projectId] }),
      permission(snapshot, chainId, account, owner, projectId, JBPermissionIdsV6.ROOT),
    ])
    let configuration: JBRulesetConfig | null = null
    try { configuration = assertFirstProjectShopConfiguration(fund) } catch (error) { blockedReason = error instanceof Error ? error.message : 'This project cannot attach a shop.' }
    if (!fund.permissions.queueRulesets) blockedReason = 'This account does not have permission to attach a shop through a new project ruleset.'
    else if (!deployerCanQueue && !canManagePermissions) blockedReason = 'The project owner must first authorize the shop deployer to queue this project’s ruleset.'
    canAdd = !!configuration && fund.permissions.queueRulesets && (deployerCanQueue || canManagePermissions) && !blockedReason
    create = { configuration, projectUri: fund.projectUri, deployerCanQueue, deployerPermissions, canManagePermissions }
  }
  const identity = stable({ chainId, projectId, owner: owner.toLowerCase(), controller: controller.toLowerCase(), hookOwner: hookOwner?.toLowerCase(), hook: shop?.hook.toLowerCase(), store: shop?.store.toLowerCase(), metadataIdTarget: shop?.metadataIdTarget.toLowerCase(), pricing, flags, maxTierId, current, configuration: create?.configuration, projectUri: create?.projectUri })
  const finalBlock = await client.getBlock({ blockNumber: block.number })
  if (finalBlock.hash !== block.hash) throw new Error('The chain changed during the shop read. Refresh and try again.')
  return { chainId, projectId, account, owner, controller, hookOwner, shop, blockNumber: block.number, mode: shop ? 'existing' : 'create', pricing, currency, symbol: currency ?? `currency #${pricing.currency}`, canAdd, canRemove, blockedReason, flags, maxTierId, rulesetId: current[0].id, identity, create }
}

function validateRemovalIds(ids: readonly number[]): void {
  if (!Array.isArray(ids) || ids.length > 50 || new Set(ids).size !== ids.length || ids.some(id => !Number.isSafeInteger(id) || id < 1 || id > 65_535)) throw new Error('Choose at most 50 distinct, valid shop items to remove.')
}

async function readRemovalIdentity(client: PublicClient, state: ProjectShopWriteState, ids: readonly number[]): Promise<string> {
  validateRemovalIds(ids)
  if (!ids.length) return '[]'
  if (!state.shop || !state.canRemove) throw new Error('This account cannot remove shop items.')
  const { shop } = state
  const tiers = await Promise.all(ids.map(async id => {
    const [tier, removed] = await Promise.all([
      client.readContract({ address: shop.store, abi: jb721TiersHookStoreAbi, functionName: 'tierOf', args: [shop.hook, BigInt(id), false], blockNumber: state.blockNumber }),
      client.readContract({ address: shop.store, abi: jb721TiersHookStoreAbi, functionName: 'isTierRemoved', args: [shop.hook, BigInt(id)], blockNumber: state.blockNumber }),
    ])
    if (tier.id !== id || tier.initialSupply === 0 || removed) throw new Error(`Item #${id} is no longer available to remove.`)
    if (tier.flags.cantBeRemoved) throw new Error(`Item #${id} is permanently locked and cannot be removed or replaced.`)
    const { remainingSupply: _remainingSupply, resolvedUri: _resolvedUri, ...configuration } = tier
    void _remainingSupply; void _resolvedUri
    return configuration
  }))
  return stable(tiers)
}

function checkFlags(state: ProjectShopWriteState, pinned: PinnedProjectShopItem[]): void {
  const tiers = buildProjectShopTierConfigs(pinned, state.pricing)
  if (state.maxTierId + BigInt(tiers.length) > 65_535n) throw new Error('This shop has reached the supported item limit.')
  for (const tier of tiers) {
    if (state.flags?.noNewTiersWithReserves && tier.reserveFrequency !== 0) throw new Error('This shop permanently disallows new items with reserved inventory.')
    if (state.flags?.noNewTiersWithVotes && (tier.flags.useVotingUnits ? tier.votingUnits !== 0 : tier.price !== 0n)) throw new Error('This shop permanently disallows new items with voting units.')
    if (state.flags?.noNewTiersWithOwnerMinting && tier.flags.allowOwnerMint) throw new Error('This shop permanently disallows new items with owner minting.')
  }
}

function materialize(plan: Omit<PreparedProjectShopWrite, 'requests' | 'requestKinds' | 'notice'>): PreparedProjectShopWrite {
  const { snapshot: state, pinned, removeTierIds } = plan
  positiveProject(state.projectId)
  validateRemovalIds(removeTierIds)
  if (!isAddress(state.account) || !isAddress(state.owner) || !/^0x[\da-f]{64}$/i.test(plan.salt)) throw new Error('The saved shop update has an invalid identity.')
  if (!pinned.length && !removeTierIds.length) throw new Error('Add or remove an item first.')
  checkFlags(state, pinned)
  const tiers = buildProjectShopTierConfigs(pinned, state.pricing)
  if (state.shop) {
    if ((pinned.length && !state.canAdd) || (removeTierIds.length && !state.canRemove)) throw new Error(state.blockedReason ?? 'This account cannot manage this shop.')
    if (!isAddress(state.shop.hook)) throw new Error('The saved shop address is invalid.')
    return { ...plan, requestKinds: ['adjust'], requests: [{ chainId: state.chainId, address: state.shop.hook, abi: jb721TiersHookAbi, functionName: 'adjustTiers', args: [tiers, removeTierIds.map(BigInt)], label: removeTierIds.length ? (pinned.length ? 'Replace shop items' : 'Remove shop items') : 'Add shop items' }], notice: removeTierIds.length ? 'Removed items stop accepting new purchases. Previously issued NFTs remain valid. Replacement items receive new IDs and the new inventory quantity you entered.' : `Add these items to the existing ${state.symbol} shop.` }
  }
  if (!state.canAdd || !state.create?.configuration || removeTierIds.length || !pinned.length) throw new Error(state.blockedReason ?? 'This project cannot create a shop.')
  if (!state.create.deployerCanQueue && (state.create.deployerPermissions & QUEUE_BIT) !== 0n) throw new Error('The saved shop authorization contradicts its previous permissions. Review the deployer’s actual permissions before continuing.')
  const requests: TxRequest[] = [], requestKinds: RequestKind[] = []
  const deployer = v6Address('JB721TiersHookProjectDeployer', state.chainId)
  const permissions = (bitmap: bigint, label: string): TxRequest => ({ ...buildSetPermissionsTx({ chainId: state.chainId, account: state.owner, operator: deployer, projectId: state.projectId, permissionIds: decodePermissionBitmap(bitmap, { includeUnknown: true }) }), label })
  if (!state.create.deployerCanQueue) {
    if (!state.create.canManagePermissions) throw new Error('The owner must authorize the shop deployer first.')
    requests.push(permissions(state.create.deployerPermissions | QUEUE_BIT, 'Authorize shop creation for this project')); requestKinds.push('grant')
  }
  requests.push(buildCreateProjectShopRequest({ chainId: state.chainId, projectId: state.projectId, configuration: state.create.configuration, tiers, projectUri: state.create.projectUri, salt: plan.salt })); requestKinds.push('create')
  if (!state.create.deployerCanQueue) { requests.push(permissions(state.create.deployerPermissions, 'Restore the shop deployer’s previous permissions')); requestKinds.push('restore') }
  return { ...plan, requests, requestKinds, notice: `Create this project’s USD shop and first items in one transaction, attaching it through a new ruleset with the existing project terms.${requestKinds.includes('grant') ? ' First authorize the shop deployer for this project, then restore its previous permissions after creation. Complete all three steps.' : ''}` }
}

/** Pin only after fresh authority/configuration checks; callers review the returned exact calls. */
export async function prepareProjectShopWrite(client: PublicClient, input: { snapshot: ProjectShopWriteState; items?: readonly DemoShopItem[]; removeTierIds?: readonly number[]; onStatus?: (message: string) => void }): Promise<PreparedProjectShopWrite> {
  const original = input.snapshot
  const state = await readProjectShopWriteState(client, original)
  if (state.identity !== original.identity) throw new Error('The shop changed. Reopen the editor and review its current settings.')
  const items = structuredClone(input.items ?? [])
  const removeTierIds = [...(input.removeTierIds ?? [])]
  if (items.length && !state.canAdd) throw new Error(state.blockedReason ?? 'This account cannot add items.')
  const removalIdentity = await readRemovalIdentity(client, state, removeTierIds)
  // Validate global immutable flags before uploading anything.
  checkFlags(state, items.map(draft => ({ draft, encodedIpfsUri: `0x${'1'.repeat(64)}` as Hex })))
  const pinned = items.length ? await pinProjectShopItems(items, state.pricing, input.onStatus) : []
  const random = new Uint8Array(32)
  globalThis.crypto.getRandomValues(random)
  return materialize({ version: 1, snapshot: state, pinned, removeTierIds, removalIdentity, salt: keccak256(toHex(random)) })
}

/** Rebuild canonical calldata; never use a saved ABI, target, or arbitrary request. */
export function projectShopWriteRequest(plan: PreparedProjectShopWrite, requestIndex: number): TxRequest {
  if (!Number.isInteger(requestIndex) || requestIndex < 0) throw new Error('Invalid shop transaction step.')
  const request = materialize(plan).requests[requestIndex]
  if (!request) throw new Error('The shop transaction step is missing.')
  return request
}

export async function reverifyProjectShopWrite(client: PublicClient, plan: PreparedProjectShopWrite, account: Address, requestIndex = 0, reviewedRequest?: TxRequest): Promise<void> {
  const state = plan.snapshot
  if (!isAddressEqual(account, state.account)) throw new Error('The shop review belongs to another account.')
  if (await client.getChainId() !== state.chainId) throw new Error('The shop RPC is connected to another chain.')
  const canonical = projectShopWriteRequest(plan, requestIndex)
  if (reviewedRequest && (reviewedRequest.chainId !== canonical.chainId || !isAddressEqual(reviewedRequest.address, canonical.address) || (reviewedRequest.value ?? 0n) !== 0n || encodeFunctionData(reviewedRequest) !== encodeFunctionData(canonical))) throw new Error('The transaction differs from the reviewed shop update.')
  const kind = materialize(plan).requestKinds[requestIndex]
  if (kind === 'restore') {
    const owner = await client.readContract({ address: v6Address('JBProjects', state.chainId), abi: jbProjectsAbi, functionName: 'ownerOf', args: [state.projectId] })
    if (!isAddressEqual(owner, state.owner) || !await permission(client, state.chainId, account, owner, state.projectId, JBPermissionIdsV6.ROOT)) throw new Error('Project ownership or permission-management authority changed. Review the remaining shop-deployer permission in the owner account.')
  } else {
    const fresh = await readProjectShopWriteState(client, state)
    if (fresh.identity !== state.identity || (plan.pinned.length && !fresh.canAdd) || (plan.removeTierIds.length && !fresh.canRemove)) throw new Error('The shop, project terms, or permissions changed since review. Review again before signing.')
    if (await readRemovalIdentity(client, fresh, plan.removeTierIds) !== plan.removalIdentity) throw new Error('An item being removed changed since review. Review again.')
    // A persisted identity string is not evidence that its adjacent fields are
    // authentic. Rebuild the call from fresh chain facts as well, keeping only
    // the original temporary-grant sequence so its step indices stay stable.
    const authoritativeState = { ...fresh, create: fresh.create && state.create ? {
      ...fresh.create, deployerCanQueue: state.create.deployerCanQueue,
      deployerPermissions: state.create.deployerPermissions,
    } : fresh.create }
    const rebuilt = projectShopWriteRequest({ ...plan, snapshot: authoritativeState }, requestIndex)
    if (!isAddressEqual(rebuilt.address, canonical.address) || encodeFunctionData(rebuilt) !== encodeFunctionData(canonical)) throw new Error('Saved shop settings differ from the current project. Reopen the review before signing.')
  }
  if (state.create && !state.create.deployerCanQueue) {
    const bitmap = await client.readContract({ address: v6Address('JBPermissions', state.chainId), abi: jbPermissionsAbi, functionName: 'permissionsOf', args: [v6Address('JB721TiersHookProjectDeployer', state.chainId), state.owner, state.projectId] })
    const expected = kind === 'grant' ? state.create.deployerPermissions : state.create.deployerPermissions | QUEUE_BIT
    if (bitmap !== expected) throw new Error('The shop deployer’s permissions changed. Stop and review them; this update will not overwrite other permission changes.')
  }
}

/** The transaction journal stores facts; executable requests are reconstructed. */
export function serializeProjectShopWrite(plan: PreparedProjectShopWrite): string {
  const { requests: _requests, requestKinds: _kinds, notice: _notice, ...facts } = materialize(plan)
  void _requests; void _kinds; void _notice
  const raw = stable(facts)
  if (raw.length > MAX_PLAN_LENGTH) throw new Error('This shop update is too large to save safely. Use fewer items.')
  return raw
}

/** Untrusted local data can recover a review, never authorize a transaction. */
export function parseProjectShopWrite(raw: string | null): PreparedProjectShopWrite | null {
  if (!raw || raw.length > MAX_PLAN_LENGTH) return null
  try {
    const facts = JSON.parse(raw, (_key, value: unknown) => {
      if (value && typeof value === 'object' && !Array.isArray(value) && '$bigint' in value) {
        const record = value as { $bigint: unknown }
        if (Object.keys(value).length !== 1 || typeof record.$bigint !== 'string' || !/^\d{1,78}$/.test(record.$bigint)) throw new Error('Invalid saved integer.')
        return BigInt(record.$bigint)
      }
      return value
    }) as Omit<PreparedProjectShopWrite, 'requests' | 'requestKinds' | 'notice'>
    if (facts.version !== 1 || typeof facts.snapshot.identity !== 'string' || facts.snapshot.identity.length > 500_000 || typeof facts.removalIdentity !== 'string' || !Array.isArray(facts.pinned) || facts.pinned.length > 50 || facts.snapshot.create && (typeof facts.snapshot.create.deployerPermissions !== 'bigint' || facts.snapshot.create.deployerPermissions < 0n || facts.snapshot.create.deployerPermissions >= 1n << 256n)) return null
    return materialize(facts)
  } catch { return null }
}

export type { ShopTier as ProjectShopWritableTier }
