import { jbDirectoryAbi, jbPermissionsAbi, jbProjectsAbi, revOwnerAbi, type JBChainId } from '@bananapus/nana-sdk-core'
import { buildSetPermissionsTx, JBPermissionCatalogV6, JBPermissionIdsV6, v6Address } from '@bananapus/nana-sdk-core/v6'
import { encodeFunctionData, getAddress, isAddress, isAddressEqual, zeroAddress, type Address, type Hex, type PublicClient } from 'viem'
import type { TxRequest } from '@/hooks/useSafeTx'

const ROOT = 1n << BigInt(JBPermissionIdsV6.ROOT)
const LABELS: Record<string, string> = {
  ROOT: 'All project permissions (ROOT)', QUEUE_RULESETS: 'Schedule project rulesets', LAUNCH_RULESETS: 'Launch initial rulesets',
  CASH_OUT_TOKENS: 'Cash out tokens', SEND_PAYOUTS: 'Send payouts', MIGRATE_TERMINAL: 'Migrate a payment terminal',
  SET_PROJECT_URI: 'Edit project details', DEPLOY_ERC20: 'Deploy the project token', SET_TOKEN: 'Replace the project token',
  MINT_TOKENS: 'Mint project tokens', BURN_TOKENS: 'Burn tokens', CLAIM_TOKENS: 'Claim token credits', TRANSFER_CREDITS: 'Transfer token credits',
  SET_CONTROLLER: 'Change the project controller', SET_TERMINALS: 'Replace payment terminals', ADD_TERMINALS: 'Add payment terminals',
  SET_PRIMARY_TERMINAL: 'Change the primary terminal', USE_ALLOWANCE: 'Withdraw treasury allowance', SET_SPLIT_GROUPS: 'Edit payout and reserved token splits',
  ADD_PRICE_FEED: 'Add a currency price feed', ADD_ACCOUNTING_CONTEXTS: 'Add accepted currencies', SET_TOKEN_METADATA: 'Edit token name and symbol',
  SIGN_FOR_ERC20: 'Sign for the project token', ADJUST_721_TIERS: 'Add or remove shop items', SET_721_METADATA: 'Edit shop metadata',
  MINT_721: 'Mint shop NFTs', SET_721_DISCOUNT_PERCENT: 'Edit shop discounts', SET_BUYBACK_TWAP: 'Edit buyback price window',
  SET_BUYBACK_POOL: 'Choose a buyback pool', SET_BUYBACK_HOOK: 'Change the buyback hook', SET_ROUTER_TERMINAL: 'Configure payment routing',
  MAP_SUCKER_TOKEN: 'Map bridge tokens', DEPLOY_SUCKERS: 'Deploy project bridges', SET_SUCKER_PEER: 'Configure a bridge peer',
  SUCKER_SAFETY: 'Manage bridge safety', SET_SUCKER_DEPRECATION: 'Retire a project bridge', OPEN_LOAN: 'Open a loan',
  REALLOCATE_LOAN: 'Reallocate a loan', REPAY_LOAN: 'Repay a loan',
}
export const PROJECT_PERMISSION_CATALOG = JBPermissionCatalogV6.map(entry => ({ ...entry, label: LABELS[entry.key] ?? entry.key }))
const KNOWN = new Set<number>(PROJECT_PERMISSION_CATALOG.map(entry => entry.id))

export type ProjectAuthorityState = {
  chainId: JBChainId; projectId: bigint; account: Address | null; owner: Address; controller: Address
  kind: 'project' | 'revnet'; blockNumber: bigint; blockHash: Hex
  isOwner: boolean; isRevnetOperator: boolean; canTransfer: boolean; canManagePermissions: boolean
  /** Permissions belong to the NFT owner's table, not to token holders or economic recipients. */
  accountPermissions: bigint; accountGlobalPermissions: bigint
  operator: Address | null; operatorPermissions: bigint; operatorGlobalPermissions: bigint
  identity: string
}

export function projectAuthorityAddress(value: string, label = 'wallet'): Address {
  const trimmed = value.trim()
  if (!isAddress(trimmed) || isAddressEqual(trimmed, zeroAddress)) throw new Error(`Enter a valid, nonzero ${label} address.`)
  return getAddress(trimmed)
}

export function projectPermissionIds(bitmap: bigint): number[] {
  if (typeof bitmap !== 'bigint' || bitmap < 0n || bitmap >= 1n << 256n || (bitmap & 1n) !== 0n) throw new Error('The permission bitmap is invalid or contains reserved permission 0.')
  return Array.from({ length: 255 }, (_, index) => index + 1).filter(id => (bitmap & 1n << BigInt(id)) !== 0n)
}

export function unknownProjectPermissionIds(bitmap: bigint): number[] { return projectPermissionIds(bitmap).filter(id => !KNOWN.has(id)) }

/** Replace only the understood IDs. Future permission bits always survive an edit. */
export function mergeProjectPermissionIds(bitmap: bigint, selected: readonly number[]): number[] {
  if (new Set(selected).size !== selected.length || selected.some(id => !KNOWN.has(id))) throw new Error('Choose known project permissions without duplicates.')
  return [...selected, ...unknownProjectPermissionIds(bitmap)].sort((a, b) => a - b)
}

export async function readProjectAuthority(client: PublicClient, input: { chainId: JBChainId; projectId: bigint; account?: Address | null; operator?: Address | null }): Promise<ProjectAuthorityState> {
  const { chainId, projectId } = input
  if (typeof projectId !== 'bigint' || projectId <= 0n || projectId >= 1n << 64n) throw new Error('Choose a valid project. Global permission editing is not supported here.')
  const account = input.account ? projectAuthorityAddress(input.account) : null
  const operator = input.operator ? projectAuthorityAddress(input.operator, 'delegate') : null
  if ((client.chain && client.chain.id !== chainId) || await client.getChainId() !== chainId) throw new Error('The RPC is connected to another chain.')
  const block = await client.getBlock({ blockTag: 'latest' })
  if (block.number === null || !block.hash) throw new Error('The RPC did not return a mined block.')
  const at = { blockNumber: block.number }
  const projects = v6Address('JBProjects', chainId), permissions = v6Address('JBPermissions', chainId)
  const [owner, controller] = await Promise.all([
    client.readContract({ address: projects, abi: jbProjectsAbi, functionName: 'ownerOf', args: [projectId], ...at }),
    client.readContract({ address: v6Address('JBDirectory', chainId), abi: jbDirectoryAbi, functionName: 'controllerOf', args: [projectId], ...at }),
  ])
  projectAuthorityAddress(owner, 'project owner')
  if (!isAddressEqual(controller, v6Address('JBController', chainId))) throw new Error('This project uses an unsupported controller.')
  const kind: ProjectAuthorityState['kind'] = isAddressEqual(owner, v6Address('REVOwner', chainId)) ? 'revnet' : 'project'
  // These launch helpers transfer the NFT to its intended owner atomically. Never treat a stranded helper-owned NFT as a wallet project.
  if (kind === 'project' && ['JBOmnichainDeployer', 'JB721TiersHookProjectDeployer'].some(name => isAddressEqual(owner, v6Address(name as 'JBOmnichainDeployer', chainId)))) throw new Error('The project NFT is held by a deployment contract and cannot be transferred through this editor.')
  const readBitmap = async (target: Address | null, scope: bigint) => {
    if (!target) return 0n
    const bitmap = await client.readContract({ address: permissions, abi: jbPermissionsAbi, functionName: 'permissionsOf', args: [target, owner, scope], ...at })
    projectPermissionIds(bitmap)
    return bitmap
  }
  const [accountPermissions, accountGlobalPermissions, operatorPermissions, operatorGlobalPermissions, approved, approvedForAll, isRevnetOperator] = await Promise.all([
    readBitmap(account, projectId), readBitmap(account, 0n), readBitmap(operator, projectId), readBitmap(operator, 0n),
    account && kind === 'project' ? client.readContract({ address: projects, abi: jbProjectsAbi, functionName: 'getApproved', args: [projectId], ...at }) : zeroAddress,
    account && kind === 'project' ? client.readContract({ address: projects, abi: jbProjectsAbi, functionName: 'isApprovedForAll', args: [owner, account], ...at }) : false,
    account && kind === 'revnet' ? client.readContract({ address: owner, abi: revOwnerAbi, functionName: 'isOperatorOf', args: [projectId, account], ...at }) : false,
  ])
  if (kind === 'revnet') {
    const [ownerController, ownerProjects, ownerPermissions] = await Promise.all([
      client.readContract({ address: owner, abi: revOwnerAbi, functionName: 'CONTROLLER', ...at }),
      client.readContract({ address: owner, abi: revOwnerAbi, functionName: 'PROJECTS', ...at }),
      client.readContract({ address: owner, abi: revOwnerAbi, functionName: 'PERMISSIONS', ...at }),
    ])
    if (!isAddressEqual(ownerController, controller) || !isAddressEqual(ownerProjects, projects) || !isAddressEqual(ownerPermissions, permissions)) throw new Error('The revnet ownership contracts do not match this chain’s registered contracts.')
  }
  const isOwner = !!account && isAddressEqual(account, owner)
  const canTransfer = !!account && (kind === 'revnet' ? isRevnetOperator : isOwner || isAddressEqual(account, approved) || approvedForAll)
  const canManagePermissions = !!account && (isOwner || ((accountPermissions | accountGlobalPermissions) & ROOT) !== 0n)
  const facts = { chainId, projectId, account, owner, controller, kind, isOwner, isRevnetOperator, canTransfer, canManagePermissions, accountPermissions, accountGlobalPermissions, operator, operatorPermissions, operatorGlobalPermissions }
  const identity = JSON.stringify(facts, (_key, value) => typeof value === 'bigint' ? value.toString() : typeof value === 'string' && value.startsWith('0x') ? value.toLowerCase() : value)
  if ((await client.getBlock({ blockNumber: block.number })).hash !== block.hash) throw new Error('The chain changed during the authority read. Refresh and try again.')
  return { ...facts, blockNumber: block.number, blockHash: block.hash, identity }
}

export function buildProjectOwnershipTx(state: ProjectAuthorityState, recipientValue: string): TxRequest {
  const recipient = projectAuthorityAddress(recipientValue, 'new owner')
  if (!state.account || !state.canTransfer) throw new Error('This account cannot change project ownership or the revnet control wallet.')
  if (isAddressEqual(recipient, state.kind === 'revnet' ? state.account : state.owner)) throw new Error('Choose a different owner wallet.')
  if (state.kind === 'revnet') {
    if (!state.isRevnetOperator || !state.operator || !isAddressEqual(state.operator, recipient)) throw new Error('Read the new control wallet’s permissions before reviewing this change.')
    return { chainId: state.chainId, address: v6Address('REVOwner', state.chainId), abi: revOwnerAbi, functionName: 'setOperatorOf', args: [state.projectId, recipient], label: 'Change INCOME control wallet' }
  }
  return { chainId: state.chainId, address: v6Address('JBProjects', state.chainId), abi: jbProjectsAbi, functionName: 'safeTransferFrom', args: [state.owner, recipient, state.projectId], label: 'Transfer project ownership' }
}

export function buildProjectPermissionsTx(state: ProjectAuthorityState, selected: readonly number[]): TxRequest {
  if (!state.account || !state.canManagePermissions || !state.operator) throw new Error('Connect the Owner or a delegate with ROOT to edit project permissions.')
  if (isAddressEqual(state.operator, state.owner)) throw new Error('The project owner already has owner authority. Choose a delegate wallet.')
  const permissionIds = mergeProjectPermissionIds(state.operatorPermissions, selected)
  if (!state.isOwner && permissionIds.includes(JBPermissionIdsV6.ROOT)) throw new Error('Only the project owner can grant or retain ROOT in a permission update. Remove ROOT from this update or connect the owner.')
  if (permissionIds.join(',') === projectPermissionIds(state.operatorPermissions).join(',')) throw new Error('Change at least one project permission.')
  return { ...buildSetPermissionsTx({ chainId: state.chainId, account: state.owner, operator: state.operator, projectId: state.projectId, permissionIds }), label: 'Update project permissions' }
}

export async function reverifyProjectAuthority(client: PublicClient, reviewed: ProjectAuthorityState, request: TxRequest, build: (state: ProjectAuthorityState) => TxRequest): Promise<void> {
  const latest = await readProjectAuthority(client, reviewed)
  if (latest.blockNumber < reviewed.blockNumber || latest.identity !== reviewed.identity) throw new Error('Project ownership or permissions changed after review. Refresh and review the change again.')
  const ancestor = await client.getBlock({ blockNumber: reviewed.blockNumber })
  if (ancestor.number !== reviewed.blockNumber || ancestor.hash?.toLowerCase() !== reviewed.blockHash.toLowerCase() ||
    (latest.blockNumber === reviewed.blockNumber && latest.blockHash.toLowerCase() !== reviewed.blockHash.toLowerCase())) throw new Error('The block used to review project ownership or permissions changed. Refresh and review the change again.')
  const expected = build(latest)
  if (request.chainId !== expected.chainId || !isAddressEqual(request.address, expected.address) || (request.value ?? 0n) !== (expected.value ?? 0n) || encodeFunctionData(request) !== encodeFunctionData(expected)) throw new Error('The reviewed project transaction no longer matches the verified change.')
}
