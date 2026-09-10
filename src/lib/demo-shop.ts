import { effectiveTierPrice } from '@bananapus/nana-sdk-core/v6'
import { formatUnits, isAddress, zeroAddress } from 'viem'

/** Local shop previews share the stock JB721 item limits, without creating a shop. */
export type DemoShopCurrency = 'USD' | 'ETH'
export type DemoShopSplit = {
  id: string
  kind: 'address' | 'project'
  recipient: string
  projectId: string
  beneficiary: string
  percent: string
}
export type DemoShopItem = {
  id: string
  name: string
  description: string
  price: string
  /** Empty means unlimited inventory. */
  supply: string
  media: { url: string; type: string; name: string } | null
  category: string
  discountPct: string
  reserveN: string
  reserveBeneficiary: string
  votingUnits: string
  allowOwnerMint: boolean
  transfersPausable: boolean
  cantBeRemoved: boolean
  allowCredits: boolean
  ownerCanEditDiscount: boolean
  splits: DemoShopSplit[]
}

export const MAX_DEMO_SHOP_STORAGE_LENGTH = 4 * 1024 * 1024
export const MAX_DEMO_SHOP_MEDIA_BYTES = 2 * 1024 * 1024
const MAX_ITEMS = 100
const MAX_SPLITS = 50
const MAX_PRICE = (1n << 104n) - 1n
const stringLimits = {
  id: 100, name: 200, description: 10_000, price: 100, supply: 100,
  category: 100, discountPct: 100, reserveN: 100, reserveBeneficiary: 100,
  votingUnits: 100,
} as const
const flags = ['allowOwnerMint', 'transfersPausable', 'cantBeRemoved', 'allowCredits', 'ownerCanEditDiscount'] as const
let fallbackId = 0

export function newDemoShopItem(): DemoShopItem {
  return {
    id: globalThis.crypto?.randomUUID?.() ?? `demo-${Date.now()}-${++fallbackId}-${Math.random().toString(36).slice(2)}`,
    name: '', description: '', price: '', supply: '', media: null, category: '',
    discountPct: '', reserveN: '', reserveBeneficiary: '', votingUnits: '',
    allowOwnerMint: false, transfersPausable: false, cantBeRemoved: false,
    allowCredits: true, ownerCanEditDiscount: true, splits: [],
  }
}

function decimalUnits(raw: string, decimals: number): bigint | null {
  const value = raw.trim()
  if (value.length > 100 || !/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(value)) return null
  const [whole, fraction = ''] = value.split('.')
  if (fraction.length > decimals) return null
  return BigInt(whole || '0') * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0') || '0')
}

function integerInRange(value: string, minimum: bigint, maximum: bigint): boolean {
  const trimmed = value.trim()
  return trimmed.length <= 100 && /^\d+$/.test(trimmed) && BigInt(trimmed) >= minimum && BigInt(trimmed) <= maximum
}

function wallet(value: string): boolean {
  return isAddress(value.trim()) && value.trim().toLowerCase() !== zeroAddress
}

function discountUnits(value: string): bigint | null {
  if (!value.trim()) return 0n
  if (!/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(value.trim())) return null
  const normalized = value.trim().replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '')
  const tenths = decimalUnits(normalized || '0', 1)
  return tenths !== null && tenths <= 1000n && tenths % 5n === 0n ? tenths / 5n : null
}

function supportedMediaType(type: string): boolean {
  return /^(?:image|video|audio)\/[a-z0-9.+-]+$/.test(type)
    || ['application/pdf', 'text/plain', 'text/markdown', 'text/csv'].includes(type)
}

function mediaOk(media: DemoShopItem['media']): boolean {
  if (media === null) return true
  if (!media || typeof media !== 'object' || typeof media.url !== 'string'
    || typeof media.type !== 'string' || typeof media.name !== 'string'
    || media.type.length > 100 || media.name.length > 255 || !supportedMediaType(media.type)) return false
  if (media.url.startsWith('data:')) {
    const comma = media.url.indexOf(',')
    if (comma < 0 || comma > 150) return false
    const header = media.url.slice(0, comma)
    if (header !== `data:${media.type};base64` && header !== `data:${media.type};charset=utf-8;base64`) return false
    const payload = media.url.slice(comma + 1)
    if (!payload.length || payload.length > Math.ceil(MAX_DEMO_SHOP_MEDIA_BYTES / 3) * 4
      || payload.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(payload)) return false
    const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0
    return !payload.slice(0, payload.length - padding).includes('=')
      && payload.length / 4 * 3 - padding <= MAX_DEMO_SHOP_MEDIA_BYTES
  }
  if (media.url.length > 4096 || /[\u0000-\u0020\u007f]/.test(media.url)) return false
  try {
    const url = new URL(media.url)
    return url.protocol === 'https:' && !url.username && !url.password
  } catch { return false }
}

export function validateDemoShopItem(item: DemoShopItem, currency: DemoShopCurrency): Record<string, string> {
  const errors: Record<string, string> = {}
  for (const [field, limit] of Object.entries(stringLimits)) {
    const value = item[field as keyof typeof stringLimits]
    if (typeof value !== 'string' || value.length > limit) errors[field] = `Use at most ${limit} characters.`
  }
  if (Object.keys(errors).length) return errors
  if (!item.id.trim()) errors.id = 'This item needs an identifier.'
  if (!item.name.trim()) errors.name = 'Enter an item name.'
  const price = decimalUnits(item.price, currency === 'ETH' ? 18 : 6)
  if (price === null || price <= 0n || price > MAX_PRICE) errors.price = `Enter a positive ${currency} price with at most ${currency === 'ETH' ? 18 : 6} decimal places.`
  if (item.supply.trim() && !integerInRange(item.supply, 1n, 999_999_998n)) errors.supply = 'Use 1–999,999,998 items, or leave empty for unlimited.'
  if (discountUnits(item.discountPct) === null) errors.discountPct = 'Use 0–100%, in 0.5% steps.'
  if (item.reserveN.trim()) {
    if (!integerInRange(item.reserveN, 1n, 65_535n)) errors.reserveN = 'Reserve 1 of every 1–65,535 items.'
    if (!wallet(item.reserveBeneficiary)) errors.reserveBeneficiary = 'Enter a nonzero wallet address for reserved items.'
    if (integerInRange(item.supply, 1n, 1n)) errors.supply = 'Reserved inventory needs at least 2 items, or unlimited supply.'
  }
  if (item.votingUnits.trim() && !integerInRange(item.votingUnits, 0n, 4_294_967_295n)) errors.votingUnits = 'Use 0–4,294,967,295 voting units.'
  if (!mediaOk(item.media)) errors.media = 'Use HTTPS media or a supported local file up to 2 MB.'
  for (const flag of flags) if (typeof item[flag] !== 'boolean') errors[flag] = 'Choose whether this setting is enabled.'
  if (!Array.isArray(item.splits) || item.splits.length > MAX_SPLITS) {
    errors.splits = 'Use at most 50 sale recipients.'
  } else {
    let total = 0n
    const ids = new Set<string>()
    for (const split of item.splits) {
      if (!split || typeof split !== 'object'
        || ['id', 'recipient', 'projectId', 'beneficiary', 'percent'].some(field => typeof split[field as keyof DemoShopSplit] !== 'string' || split[field as keyof DemoShopSplit].length > 100)
        || !split.id.trim() || ids.has(split.id)) { errors.splits = 'Finish each sale recipient.'; break }
      ids.add(split.id)
      const percent = decimalUnits(split.percent, 7)
      const targetOk = split.kind === 'address' ? wallet(split.recipient)
        : split.kind === 'project' && /^#?\d{1,10}$/.test(split.projectId.trim())
          && BigInt(split.projectId.trim().replace('#', '')) > 0n && wallet(split.beneficiary)
      if (percent === null || percent <= 0n || percent > 1_000_000_000n || !targetOk) {
        errors.splits = 'Each recipient needs a valid destination and a positive percentage with at most 7 decimal places.'; break
      }
      total += percent
    }
    if (total > 1_000_000_000n) errors.splits = 'Sale recipient percentages cannot exceed 100%.'
  }
  return errors
}

/** Same smallest-unit rounding as the stock JB721TiersHookStore. */
export function demoShopPrice(item: DemoShopItem, currency: DemoShopCurrency): string {
  const decimals = currency === 'ETH' ? 18 : 6
  const price = decimalUnits(item.price, decimals)
  const discount = discountUnits(item.discountPct)
  if (price === null || price <= 0n || price > MAX_PRICE || discount === null) return '—'
  return `${formatUnits(effectiveTierPrice(price, Number(discount)), decimals)} ${currency}`
}

export function demoShopStorageKey(projectKey: string): string {
  return `homerun:demo-shop:v1:${encodeURIComponent(projectKey)}`
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Do not trust localStorage. Accept one bounded, valid version and copy known fields only. */
export function parseDemoShopStorage(raw: string | null): { currency: DemoShopCurrency; items: DemoShopItem[] } | null {
  if (!raw || raw.length > MAX_DEMO_SHOP_STORAGE_LENGTH) return null
  try {
    const saved: unknown = JSON.parse(raw)
    if (!record(saved) || saved.version !== 1 || (saved.currency !== 'USD' && saved.currency !== 'ETH')
      || !Array.isArray(saved.items) || saved.items.length > MAX_ITEMS) return null
    const items: DemoShopItem[] = []
    const ids = new Set<string>()
    for (const candidate of saved.items) {
      if (!record(candidate) || Object.entries(stringLimits).some(([key, max]) => typeof candidate[key] !== 'string' || candidate[key].length > max)
        || flags.some(flag => typeof candidate[flag] !== 'boolean') || !Array.isArray(candidate.splits) || candidate.splits.length > MAX_SPLITS) return null
      const media = candidate.media
      if (media !== null && (!record(media) || ['url', 'type', 'name'].some(key => typeof media[key] !== 'string'))) return null
      if (candidate.splits.some(split => !record(split) || !['address', 'project'].includes(String(split.kind))
        || ['id', 'recipient', 'projectId', 'beneficiary', 'percent'].some(key => typeof split[key] !== 'string'))) return null
      const source = candidate as unknown as DemoShopItem
      const item: DemoShopItem = {
        id: source.id, name: source.name, description: source.description, price: source.price,
        supply: source.supply, category: source.category, discountPct: source.discountPct,
        reserveN: source.reserveN, reserveBeneficiary: source.reserveBeneficiary, votingUnits: source.votingUnits,
        allowOwnerMint: source.allowOwnerMint, transfersPausable: source.transfersPausable,
        cantBeRemoved: source.cantBeRemoved, allowCredits: source.allowCredits, ownerCanEditDiscount: source.ownerCanEditDiscount,
        media: source.media ? { url: source.media.url, type: source.media.type, name: source.media.name } : null,
        splits: source.splits.map(split => ({ id: split.id, kind: split.kind, recipient: split.recipient, projectId: split.projectId, beneficiary: split.beneficiary, percent: split.percent })),
      }
      if (ids.has(item.id) || Object.keys(validateDemoShopItem(item, saved.currency)).length) return null
      ids.add(item.id)
      items.push(item)
    }
    return { currency: saved.currency, items }
  } catch { return null }
}
