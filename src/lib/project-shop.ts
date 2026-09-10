import { jbDirectoryAbi, jbProjectsAbi, type JBChainId } from '@bananapus/nana-sdk-core'
import { BASE_CURRENCY_ETH, BASE_CURRENCY_USD, effectiveTierPrice, getProject721Shop, TIER_UNLIMITED_SUPPLY, v6Address, type Project721Shop, type Project721Tier } from '@bananapus/nana-sdk-core/v6'
import { formatUnits, isAddress, isAddressEqual, zeroAddress, type Address, type PublicClient } from 'viem'
import { bendystraw } from '@/lib/bendystraw'
import { displayChainSlug } from '@/lib/chainDisplay'

const INVENTORY_LIMIT = 200
export const SHOP_CUSTOMER_PAGE_SIZE = 50

export type ProjectShopState = Project721Shop & {
  blockNumber: bigint
  truncated: boolean
  checkoutUrl: string
}

/** Read-only inventory. Checkout stays with the reference site's existing NFT cart. */
export async function readProjectShop(client: PublicClient, { chainId, projectId }: { chainId: JBChainId; projectId: bigint }): Promise<ProjectShopState | null> {
  if (projectId <= 0n || projectId >= 1n << 256n) throw new Error('A positive project ID is required.')
  if ((client.chain && client.chain.id !== chainId) || await client.getChainId() !== chainId) throw new Error('The shop RPC is connected to a different chain.')
  const blockNumber = await client.getBlockNumber()
  const snapshot = {
    ...client,
    readContract: (args: Parameters<PublicClient['readContract']>[0]) => client.readContract({ ...args, blockNumber }),
  } as PublicClient
  const [owner, controller] = await Promise.all([
    snapshot.readContract({ address: v6Address('JBProjects', chainId), abi: jbProjectsAbi, functionName: 'ownerOf', args: [projectId] }),
    snapshot.readContract({ address: v6Address('JBDirectory', chainId), abi: jbDirectoryAbi, functionName: 'controllerOf', args: [projectId] }),
  ])
  if (!isAddressEqual(controller, v6Address('JBController', chainId))) throw new Error('This shop is not attached to the registered V6 controller.')
  const shop = await getProject721Shop(snapshot, {
    chainId, projectId, isRevnet: isAddressEqual(owner, v6Address('REVOwner', chainId)), tierLimit: INVENTORY_LIMIT + 1,
  })
  // The SDK returns null only after an authoritative no-hook / non-721 read.
  // Transport errors propagate so they cannot become a false empty shop.
  if (!shop) return null
  if ([shop.hook, shop.store, shop.metadataIdTarget].some(address => isAddressEqual(address, zeroAddress))) throw new Error('The shop returned an invalid contract address.')
  if (!Number.isInteger(shop.pricing.decimals) || shop.pricing.decimals < 0 || shop.pricing.decimals > 255) throw new Error('The shop returned invalid pricing decimals.')
  if (new Set(shop.tiers.map(tier => tier.id)).size !== shop.tiers.length) throw new Error('The shop returned repeated inventory items.')
  return {
    ...shop, blockNumber, tiers: shop.tiers.slice(0, INVENTORY_LIMIT), truncated: shop.tiers.length > INVENTORY_LIMIT,
    checkoutUrl: `https://juicebox.money/${displayChainSlug(chainId) ?? chainId}:${projectId}#shop`,
  }
}

export function shopTierPrice(tier: Project721Tier, pricing: Project721Shop['pricing']): string {
  const symbol = pricing.currency === BASE_CURRENCY_ETH ? 'ETH' : pricing.currency === BASE_CURRENCY_USD ? 'USD' : `currency #${pricing.currency}`
  return `${formatUnits(effectiveTierPrice(tier.price, tier.discountPercent), pricing.decimals)} ${symbol}`
}

export function shopTierAvailability(tier: Project721Tier): string {
  if (tier.remainingSupply === 0) return 'Sold out'
  if (tier.initialSupply === TIER_UNLIMITED_SUPPLY) return 'Unlimited supply'
  return `${tier.remainingSupply.toLocaleString('en-US')} of ${tier.initialSupply.toLocaleString('en-US')} remaining`
}

/** Resolver-provided names are plain text, never rendered as HTML or remote markup. */
export function shopTierName(tier: Project721Tier): string {
  try {
    const prefix = 'data:application/json,'
    const base64Prefix = 'data:application/json;base64,'
    const uri = tier.resolvedUri
    if (uri.length > 100_000) return `Item #${tier.id}`
    const json = uri.startsWith(prefix) ? decodeURIComponent(uri.slice(prefix.length))
      : uri.startsWith(base64Prefix) ? atob(uri.slice(base64Prefix.length)) : null
    const name: unknown = json ? JSON.parse(json).name : null
    return typeof name === 'string' && name.trim() ? name.trim().slice(0, 160) : `Item #${tier.id}`
  } catch { return `Item #${tier.id}` }
}

export type ShopCustomerItem = {
  chainId: number; projectId: number; createdAt: number; mintTx: string
  tokenId: string; owner: Address; tierId: number; hook: { address: Address }
}

/** These are indexed NFT owners, never authority for transfers or redemption. */
export async function readShopCustomers({ chainId, projectId, hook, owner, offset = 0 }: {
  chainId: JBChainId; projectId: bigint; hook: Address; owner?: Address; offset?: number
}): Promise<{ items: ShopCustomerItem[]; totalCount: number; nextOffset: number | null; skipped: number }> {
  const id = Number(projectId)
  if (projectId <= 0n || !Number.isSafeInteger(id) || id > 2_147_483_647) throw new Error('This project ID is outside the indexer’s supported range.')
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 2_147_483_647) throw new Error('Invalid customer page.')
  if (!isAddress(hook) || (owner && !isAddress(owner))) throw new Error('A valid shop or account address is required.')
  const where = { chainId, projectId: id, version: 6, ...(owner ? { owner: owner.toLowerCase() } : {}) }
  const result = await bendystraw<{ nfts: { items: ShopCustomerItem[]; totalCount: number } }>(
    `query HomerunShopCustomers($where: nftFilter!, $limit: Int!, $offset: Int!) {
      nfts(where: $where, orderBy: "createdAt", orderDirection: "desc", limit: $limit, offset: $offset) {
        totalCount
        items { chainId projectId createdAt mintTx tokenId owner tierId hook { address } }
      }
    }`,
    { where, limit: SHOP_CUSTOMER_PAGE_SIZE, offset }, { chainId, policy: 'live' },
  )
  const { items: rows, totalCount } = result.nfts
  if (!Number.isSafeInteger(totalCount) || totalCount < 0 || rows.length > SHOP_CUSTOMER_PAGE_SIZE) throw new Error('The indexer returned an invalid customer page.')
  const items = rows.filter(row => row.chainId === chainId && row.projectId === id && isAddress(row.owner) && !isAddressEqual(row.owner, zeroAddress)
    && row.hook?.address && isAddress(row.hook.address) && isAddressEqual(row.hook.address, hook)
    && (!owner || isAddressEqual(row.owner, owner)) && /^\d+$/.test(String(row.tokenId)) && Number.isSafeInteger(row.tierId) && row.tierId > 0)
  const next = offset + rows.length
  return { items, totalCount, skipped: rows.length - items.length, nextOffset: rows.length > 0 && next < totalCount ? next : null }
}
