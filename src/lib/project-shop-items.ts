import { cidV0ToBytes32, jb721TiersHookAbi } from '@bananapus/nana-sdk-core'
import { TIER_UNLIMITED_SUPPLY } from '@bananapus/nana-sdk-core/v6'
import { getAddress, isHex, keccak256, stringToHex, zeroAddress, type ContractFunctionArgs, type Hex } from 'viem'
import { validateDemoShopItem, type DemoShopItem } from '@/lib/demo-shop'
import { jbCenterIpfs, type JBCenterIpfsClient } from '@/lib/jbcenter-ipfs'

export type ProjectShopPricing = { currency: number; decimals: number }
export type PinnedProjectShopItem = { draft: DemoShopItem; encodedIpfsUri: Hex }
export type ProjectShopTierConfig = ContractFunctionArgs<typeof jb721TiersHookAbi, 'nonpayable', 'adjustTiers'>[0][number]
export const MAX_PROJECT_SHOP_ITEMS = 50
const MAX_PRICE = (1n << 104n) - 1n
const MAX_CATEGORY = 0xffffff
const TOTAL_PERCENT = 1_000_000_000n

function validPricing(pricing: ProjectShopPricing): boolean {
  return Number.isInteger(pricing.currency) && pricing.currency > 0 && pricing.currency <= 0xffffffff
    && Number.isInteger(pricing.decimals) && pricing.decimals >= 0 && pricing.decimals <= 255
}

/** Unlike parseUnits, this never silently rounds excessive decimal places. */
function decimalUnits(value: string, decimals: number): bigint | null {
  const text = value.trim()
  if (text.length > 100 || !/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(text)) return null
  const [whole, fraction = ''] = text.split('.')
  if (fraction.length > decimals) return null
  return BigInt(whole || '0') * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0') || '0')
}

/** Shared item rules, with precision taken from the existing shop's on-chain pricing. */
export function validateProjectShopItem(item: DemoShopItem, pricing: ProjectShopPricing): Record<string, string> {
  const errors = validateDemoShopItem(item, pricing.currency === 1 ? 'ETH' : 'USD', pricing.decimals)
  if (!validPricing(pricing)) {
    errors.price = 'This shop has invalid pricing settings.'
    return errors
  }
  const price = typeof item.price === 'string' && item.price.length <= 100 ? decimalUnits(item.price, pricing.decimals) : null
  if (price === null || price <= 0n || price > MAX_PRICE) errors.price = `Enter a positive price with at most ${pricing.decimals} decimal places that fits the shop's price limit.`
  const category = typeof item.category === 'string' ? item.category.trim() : ''
  if (category && /^\d+$/.test(category) && BigInt(category) > BigInt(MAX_CATEGORY)) errors.category = 'Use a category number between 0 and 16,777,215, or a category name.'
  return errors
}

function snapshotItems(items: readonly DemoShopItem[], pricing: ProjectShopPricing): DemoShopItem[] {
  if (!validPricing(pricing)) throw new Error('This shop has invalid pricing settings.')
  if (!Array.isArray(items) || items.length === 0 || items.length > MAX_PROJECT_SHOP_ITEMS) throw new Error(`Add between 1 and ${MAX_PROJECT_SHOP_ITEMS} items at a time.`)
  const ids = new Set<string>()
  return items.map((item: DemoShopItem, index: number) => {
    if (!item || typeof item !== 'object') throw new Error(`Item ${index + 1} is invalid.`)
    const errors = validateProjectShopItem(item, pricing)
    if (Object.keys(errors).length) throw new Error(`Item ${index + 1}: ${Object.values(errors).join(' ')}`)
    if (ids.has(item.id)) throw new Error('Each item needs a different identifier.')
    ids.add(item.id)
    // Capture every reviewed value, including nested form objects, before any upload awaits.
    return {
      id: item.id, name: item.name, description: item.description, price: item.price,
      supply: item.supply, category: item.category, discountPct: item.discountPct,
      reserveN: item.reserveN, reserveBeneficiary: item.reserveBeneficiary, votingUnits: item.votingUnits,
      allowOwnerMint: item.allowOwnerMint, transfersPausable: item.transfersPausable,
      cantBeRemoved: item.cantBeRemoved, allowCredits: item.allowCredits,
      ownerCanEditDiscount: item.ownerCanEditDiscount,
      media: item.media ? { url: item.media.url, type: item.media.type, name: item.media.name } : null,
      splits: item.splits.map(split => ({ id: split.id, kind: split.kind, recipient: split.recipient, projectId: split.projectId, beneficiary: split.beneficiary, percent: split.percent })),
    }
  })
}

function categoryIds(items: readonly DemoShopItem[], known: Readonly<Record<string, number>> = {}): Map<string, number> {
  const ids = new Map<string, number>()
  const labels = new Map<number, string>()
  for (const [rawLabel, id] of Object.entries(known)) {
    const label = rawLabel.trim()
    if (!label || !Number.isInteger(id) || id < 0 || id > MAX_CATEGORY) throw new Error('The existing shop categories are invalid.')
    if ((labels.has(id) && labels.get(id) !== label) || (ids.has(label) && ids.get(label) !== id)) throw new Error('Two category names share a category number. Choose another category name.')
    ids.set(label, id)
    labels.set(id, label)
  }
  for (const item of items) {
    const label = item.category.trim()
    if (!label || ids.has(label)) continue
    const numeric = /^\d+$/.test(label)
    // Labels have the same category across independently added batches. Zero stays uncategorized.
    const id = numeric ? Number(label) : Number(BigInt(keccak256(stringToHex(label))) % BigInt(MAX_CATEGORY)) + 1
    const existing = labels.get(id)
    // A numeric category explicitly selects an existing on-chain group.
    if (existing && existing !== label && !numeric) throw new Error('Two category names share a category number. Choose another category name.')
    ids.set(label, id)
    if (!existing) labels.set(id, label)
  }
  return ids
}

/** Publish only after all reviewed items are valid. HTTPS media remains a reference, without fetching it. */
export async function pinProjectShopItems(
  items: readonly DemoShopItem[],
  pricing: ProjectShopPricing,
  onStatus?: (status: string) => void,
  ipfs: Pick<JBCenterIpfsClient, 'pinMedia' | 'pinJson'> = jbCenterIpfs,
): Promise<PinnedProjectShopItem[]> {
  const drafts = snapshotItems(items, pricing)
  categoryIds(drafts)
  const pinned: PinnedProjectShopItem[] = []
  for (const [index, draft] of drafts.entries()) {
    let mediaUri = draft.media?.url
    if (draft.media && mediaUri?.startsWith('data:')) {
      onStatus?.(`Uploading media for item ${index + 1} of ${drafts.length}…`)
      const bytes = Uint8Array.from(atob(mediaUri.slice(mediaUri.indexOf(',') + 1)), character => character.charCodeAt(0))
      const pin = await ipfs.pinMedia(new File([bytes], draft.media.name || 'media', { type: draft.media.type }))
      // Both media and metadata must be immutable, representable IPFS pins.
      cidV0ToBytes32(pin.cid)
      mediaUri = `ipfs://${pin.cid}`
    }
    onStatus?.(`Saving item ${index + 1} of ${drafts.length}…`)
    const metadata: Record<string, unknown> = {
      name: draft.name.trim(),
      description: draft.description.trim(),
      ...(draft.category.trim() ? { categoryName: draft.category.trim() } : {}),
      ...(mediaUri ? {
        [draft.media!.type.startsWith('image/') ? 'image' : 'animation_url']: mediaUri,
        mediaType: draft.media!.type,
      } : {}),
    }
    const pin = await ipfs.pinJson(metadata)
    pinned.push({ draft, encodedIpfsUri: cidV0ToBytes32(pin.cid) })
  }
  return pinned
}

function saleSplits(item: DemoShopItem): Pick<ProjectShopTierConfig, 'splitPercent' | 'splits'> {
  const weights = item.splits.map(split => decimalUnits(split.percent, 7)!)
  const total = weights.reduce((sum, value) => sum + value, 0n)
  if (total === 0n) return { splitPercent: 0, splits: [] }
  const shares = weights.map(weight => weight * TOTAL_PERCENT / total)
  const remainders = weights.map((weight, index) => ({ index, remainder: weight * TOTAL_PERCENT % total }))
    .sort((a, b) => a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1)
  const remaining = Number(TOTAL_PERCENT - shares.reduce((sum, share) => sum + share, 0n))
  for (let index = 0; index < remaining; index++) shares[remainders[index].index]++
  return {
    splitPercent: Number(total),
    splits: item.splits.map((split, index) => ({
      percent: Number(shares[index]),
      projectId: split.kind === 'project' ? BigInt(split.projectId.trim().replace(/^#/, '')) : 0n,
      beneficiary: getAddress((split.kind === 'project' ? split.beneficiary : split.recipient).trim()),
      preferAddToBalance: false, lockedUntil: 0, hook: zeroAddress,
    })),
  }
}

/** Encode the actual stock hook ABI, preserving existing shop precision and category ordering. */
export function buildProjectShopTierConfigs(
  pinned: readonly PinnedProjectShopItem[],
  pricing: ProjectShopPricing,
  knownCategories?: Readonly<Record<string, number>>,
): ProjectShopTierConfig[] {
  if (pinned.length === 0) {
    if (!validPricing(pricing)) throw new Error('This shop has invalid pricing settings.')
    return []
  }
  const drafts = snapshotItems(pinned.map(item => item.draft), pricing)
  const categories = categoryIds(drafts, knownCategories)
  return drafts.map((item, index): ProjectShopTierConfig => {
    const encodedIpfsUri = pinned[index].encodedIpfsUri
    if (!isHex(encodedIpfsUri) || encodedIpfsUri.length !== 66 || /^0x0+$/.test(encodedIpfsUri)) throw new Error('Each item needs valid pinned metadata before publishing.')
    const discount = item.discountPct.trim().replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '')
    return {
      price: decimalUnits(item.price, pricing.decimals)!,
      initialSupply: item.supply.trim() ? Number(item.supply.trim()) : TIER_UNLIMITED_SUPPLY,
      votingUnits: item.votingUnits.trim() ? Number(item.votingUnits.trim()) : 0,
      reserveFrequency: item.reserveN.trim() ? Number(item.reserveN.trim()) : 0,
      reserveBeneficiary: item.reserveN.trim() ? getAddress(item.reserveBeneficiary.trim()) : zeroAddress,
      encodedIpfsUri, category: categories.get(item.category.trim()) ?? 0,
      discountPercent: discount ? Number(decimalUnits(discount, 1)! / 5n) : 0,
      flags: {
        allowOwnerMint: item.allowOwnerMint, useReserveBeneficiaryAsDefault: false,
        // The editor's empty value means zero votes. Without this flag the
        // contract would instead assign the item's full price as voting units.
        transfersPausable: item.transfersPausable, useVotingUnits: true,
        cantBeRemoved: item.cantBeRemoved, cantIncreaseDiscountPercent: !item.ownerCanEditDiscount,
        cantBuyWithCredits: !item.allowCredits,
      },
      ...saleSplits(item),
    }
  }).sort((a, b) => a.category - b.category)
}
