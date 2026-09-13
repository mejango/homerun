import { describe, expect, it, vi } from 'vitest'
import { bytes32ToCidV0, jb721TiersHookAbi } from '@bananapus/nana-sdk-core'
import { decodeFunctionData, encodeFunctionData, formatUnits, zeroAddress, type Hex } from 'viem'
import { MAX_DEMO_SHOP_MEDIA_BYTES, newDemoShopItem, type DemoShopItem, type DemoShopSplit } from '../src/lib/demo-shop'
import type { JBCenterIpfsClient } from '../src/lib/jbcenter-ipfs'
import { buildProjectShopTierConfigs, pinProjectShopItems, validateProjectShopItem, type PinnedProjectShopItem } from '../src/lib/project-shop-items'

const WALLET = '0x1111111111111111111111111111111111111111'
const BENEFICIARY = '0x2222222222222222222222222222222222222222'
const DIGEST: Hex = `0x${'11'.repeat(32)}`
const CID = bytes32ToCidV0(DIGEST)!
const USD6 = { currency: 2, decimals: 6 }
const USD18 = { currency: 2, decimals: 18 }
const item = (overrides: Partial<DemoShopItem> = {}): DemoShopItem => ({ ...newDemoShopItem(), name: 'A stay', price: '125', ...overrides })
const split = (overrides: Partial<DemoShopSplit> = {}): DemoShopSplit => ({ id: 'split', kind: 'address', recipient: WALLET, projectId: '', beneficiary: '', percent: '25', ...overrides })
const pinned = (draft: DemoShopItem): PinnedProjectShopItem => ({ draft, encodedIpfsUri: DIGEST })
const localMedia = { name: 'poster.png', type: 'image/png', url: 'data:image/png;base64,YWJjZA==' }
function client() {
  return {
    pinMedia: vi.fn<JBCenterIpfsClient['pinMedia']>().mockResolvedValue({ cid: CID }),
    pinJson: vi.fn<JBCenterIpfsClient['pinJson']>().mockResolvedValue({ cid: CID }),
  }
}

describe('live shop metadata publishing', () => {
  it('pins local media and metadata separately, preserving the reviewed draft', async () => {
    const ipfs = client()
    const status = vi.fn()
    const draft = item({ name: ' A stay ', description: ' Welcome. ', category: ' Stays ', media: localMedia })
    const result = await pinProjectShopItems([draft], USD6, status, ipfs)
    const mediaFile = ipfs.pinMedia.mock.calls[0][0]
    expect({ name: mediaFile.name, type: mediaFile.type, size: mediaFile.size }).toEqual({ name: 'poster.png', type: 'image/png', size: 4 })
    expect(ipfs.pinJson).toHaveBeenCalledWith({ name: 'A stay', description: 'Welcome.', categoryName: 'Stays', image: `ipfs://${CID}`, mediaType: 'image/png' })
    expect(result).toEqual([{ draft, encodedIpfsUri: DIGEST }])
    expect(result[0].draft).not.toBe(draft)
    expect(status.mock.calls.flat()).toEqual(['Uploading media for item 1 of 1…', 'Saving item 1 of 1…'])
    expect(fetch).not.toHaveBeenCalled()
  })

  it('keeps HTTPS media as a reference without fetching or uploading it', async () => {
    const ipfs = client()
    const media = { name: 'film.mp4', type: 'video/mp4', url: 'https://example.com/film.mp4' }
    await pinProjectShopItems([item({ media })], USD6, undefined, ipfs)
    expect(ipfs.pinMedia).not.toHaveBeenCalled()
    expect(ipfs.pinJson).toHaveBeenCalledWith({ name: 'A stay', description: '', animation_url: media.url, mediaType: media.type })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('captures all items and nested recipients before the first upload yields', async () => {
    const ipfs = client()
    let resolveUpload!: (pin: { cid: string }) => void
    ipfs.pinMedia.mockImplementationOnce(() => new Promise(resolve => { resolveUpload = resolve }))
    const first = item({ media: { ...localMedia }, splits: [split()] })
    const second = item({ name: 'Second item' })
    const drafts = [first, second]
    const pending = pinProjectShopItems(drafts, USD6, undefined, ipfs)
    first.name = 'Changed'
    first.media!.url = 'https://example.com/replaced.png'
    first.splits[0].recipient = BENEFICIARY
    second.price = '999'
    drafts.pop()
    resolveUpload({ cid: CID })
    const result = await pending
    expect(result).toHaveLength(2)
    expect(result[0].draft.name).toBe('A stay')
    expect(result[0].draft.media).toEqual(localMedia)
    expect(result[0].draft.splits[0].recipient).toBe(WALLET)
    expect(result[1].draft.price).toBe('125')
    expect(ipfs.pinJson).toHaveBeenCalledTimes(2)
  })

  it('validates the entire batch before any media or JSON upload', async () => {
    const ipfs = client()
    for (const invalid of [item({ price: '0.0000001' }), item({ reserveN: '2' }), item({ splits: [split({ percent: '101' })] }), item({ category: '16777216' })]) {
      await expect(pinProjectShopItems([item({ media: localMedia }), invalid], USD6, undefined, ipfs)).rejects.toThrow('Item 2:')
    }
    expect(ipfs.pinMedia).not.toHaveBeenCalled()
    expect(ipfs.pinJson).not.toHaveBeenCalled()
  })

  it('rejects unsafe or oversized media before uploading the first item', async () => {
    const ipfs = client()
    for (const url of ['javascript:alert(1)', 'http://example.com/photo', 'data:image/png;base64,AB=C', `data:image/png;base64,${'A'.repeat(Math.ceil(MAX_DEMO_SHOP_MEDIA_BYTES / 3) * 4 + 4)}`]) {
      await expect(pinProjectShopItems([item({ media: localMedia }), item({ media: { ...localMedia, url } })], USD6, undefined, ipfs)).rejects.toThrow('supported local file up to 2 MB')
    }
    expect(ipfs.pinMedia).not.toHaveBeenCalled()
    expect(ipfs.pinJson).not.toHaveBeenCalled()
  })

  it('bounds batches and rejects repeated identifiers before publishing', async () => {
    const ipfs = client()
    const duplicate = item()
    for (const drafts of [[], Array.from({ length: 51 }, () => item()), [duplicate, duplicate]]) {
      await expect(pinProjectShopItems(drafts, USD6, undefined, ipfs)).rejects.toThrow()
    }
    expect(ipfs.pinJson).not.toHaveBeenCalled()
    await expect(pinProjectShopItems(Array.from({ length: 50 }, () => item()), USD6, undefined, ipfs)).resolves.toHaveLength(50)
  })

  it('stops on failed media or malformed metadata pins, without continuing the batch', async () => {
    const ipfs = client()
    ipfs.pinMedia.mockRejectedValueOnce(new Error('Upload failed'))
    await expect(pinProjectShopItems([item({ media: localMedia }), item()], USD6, undefined, ipfs)).rejects.toThrow('Upload failed')
    expect(ipfs.pinJson).not.toHaveBeenCalled()
    ipfs.pinJson.mockResolvedValueOnce({ cid: 'not-a-cid' })
    await expect(pinProjectShopItems([item(), item()], USD6, undefined, ipfs)).rejects.toThrow()
    expect(ipfs.pinJson).toHaveBeenCalledOnce()
  })
})

describe('stock hook item encoding', () => {
  it('uses the existing shop decimals exactly, including 18-decimal USD', () => {
    const draft = item({ price: '1.123456789123456789' })
    expect(validateProjectShopItem(draft, USD18)).toEqual({})
    expect(buildProjectShopTierConfigs([pinned(draft)], USD18)[0].price).toBe(1_123_456_789_123_456_789n)
    expect(validateProjectShopItem(draft, USD6)).toHaveProperty('price')
    expect(validateProjectShopItem(item({ price: '1.1234567891234567890' }), USD18)).toHaveProperty('price')
    expect(validateProjectShopItem(item({ price: '1.0' }), { currency: 2, decimals: 0 })).toHaveProperty('price')
  })

  it('rejects prices above uint104, scientific notation, and invalid pricing', () => {
    expect(validateProjectShopItem(item({ price: formatUnits((1n << 104n) - 1n, 18) }), USD18)).toEqual({})
    for (const price of [formatUnits(1n << 104n, 18), '1e2', '-1', '0', 'Infinity', '0.0000000000000000001']) {
      expect(validateProjectShopItem(item({ price }), USD18)).toHaveProperty('price')
    }
    for (const pricing of [{ currency: 0, decimals: 6 }, { currency: 0x100000000, decimals: 6 }, { currency: 2, decimals: -1 }, { currency: 2, decimals: 256 }, { currency: 2, decimals: 1.5 }]) {
      expect(() => buildProjectShopTierConfigs([pinned(item())], pricing)).toThrow('invalid pricing')
    }
  })

  it('encodes all tier fields and flags using the actual ABI', () => {
    const tiers = buildProjectShopTierConfigs([pinned(item({
      supply: '2', votingUnits: '0', reserveN: '65535', reserveBeneficiary: WALLET, discountPct: '99.500',
      category: '12', allowOwnerMint: true, transfersPausable: true, cantBeRemoved: true,
      allowCredits: false, ownerCanEditDiscount: false,
    }))], USD6)
    expect(tiers[0]).toEqual({
      price: 125_000_000n, initialSupply: 2, votingUnits: 0, reserveFrequency: 65535,
      reserveBeneficiary: WALLET, encodedIpfsUri: DIGEST, category: 12, discountPercent: 199,
      flags: { allowOwnerMint: true, useReserveBeneficiaryAsDefault: false, transfersPausable: true,
        useVotingUnits: true, cantBeRemoved: true, cantIncreaseDiscountPercent: true, cantBuyWithCredits: true },
      splitPercent: 0, splits: [],
    })
    const encoded = encodeFunctionData({ abi: jb721TiersHookAbi, functionName: 'adjustTiers', args: [tiers, []] })
    expect(decodeFunctionData({ abi: jb721TiersHookAbi, data: encoded })).toEqual({ functionName: 'adjustTiers', args: [tiers, []] })
  })

  it('uses unlimited inventory and leaves the hook-wide reserve beneficiary unchanged', () => {
    const [tier] = buildProjectShopTierConfigs([pinned(item({ reserveBeneficiary: WALLET }))], USD6)
    expect(tier).toMatchObject({ initialSupply: 999_999_999, reserveFrequency: 0, reserveBeneficiary: zeroAddress, votingUnits: 0,
      flags: { useReserveBeneficiaryAsDefault: false, useVotingUnits: true, cantBuyWithCredits: false, cantIncreaseDiscountPercent: false } })
  })

  it('supports removal-only transactions without adding tiers', () => {
    expect(buildProjectShopTierConfigs([], USD6)).toEqual([])
  })

  it('normalizes partial sale percentages exactly and assigns every final rounding unit', () => {
    const [tier] = buildProjectShopTierConfigs([pinned(item({ splits: [
      split({ percent: '10' }),
      split({ id: 'second', percent: '10', recipient: BENEFICIARY }),
      split({ id: 'project', kind: 'project', projectId: '#12', beneficiary: BENEFICIARY, percent: '10' }),
    ] }))], USD6)
    expect(tier.splitPercent).toBe(300_000_000)
    expect(tier.splits.map(split => split.percent)).toEqual([333_333_334, 333_333_333, 333_333_333])
    expect(tier.splits.reduce((sum, split) => sum + split.percent, 0)).toBe(1_000_000_000)
    expect(tier.splits[2]).toEqual({ percent: 333_333_333, projectId: 12n, beneficiary: BENEFICIARY, preferAddToBalance: false, lockedUntil: 0, hook: zeroAddress })
    expect(tier.splits[0].projectId).toBe(0n)
  })

  it('preserves the smallest percentage units and full-sale allocation without floating point', () => {
    const [tier] = buildProjectShopTierConfigs([pinned(item({ splits: [split({ percent: '.0000001' }), split({ id: 'large', percent: '99.9999999' })] }))], USD6)
    expect(tier.splitPercent).toBe(1_000_000_000)
    expect(tier.splits.map(split => split.percent)).toEqual([1, 999_999_999])
    const [partial] = buildProjectShopTierConfigs([pinned(item({ splits: [split({ percent: '.0000001' })] }))], USD6)
    expect(partial.splitPercent).toBe(1)
    expect(partial.splits[0].percent).toBe(1_000_000_000)
  })

  it('keeps named categories stable across batches and sorts tiers as required by the store', () => {
    const stays = item({ category: 'Stays' })
    const meals = item({ category: 'Meals' })
    const alone = buildProjectShopTierConfigs([pinned(stays)], USD6)[0]
    const combined = buildProjectShopTierConfigs([pinned(meals), pinned(stays), pinned(item())], USD6)
    expect(alone.category).toBeGreaterThan(0)
    expect(alone.category).toBeLessThanOrEqual(0xffffff)
    expect(combined.find(tier => tier.category === alone.category)).toEqual(alone)
    expect(combined.map(tier => tier.category)).toEqual([...combined.map(tier => tier.category)].sort((a, b) => a - b))
    expect(buildProjectShopTierConfigs([pinned(stays)], USD6, { Stays: 7 })[0].category).toBe(7)
    expect(buildProjectShopTierConfigs([pinned(item({ category: '0' }))], USD6)[0].category).toBe(0)
    expect(buildProjectShopTierConfigs([pinned(item({ category: '16777215' }))], USD6)[0].category).toBe(0xffffff)
  })

  it('rejects category collisions against known labels and invalid pins', () => {
    const stays = item({ category: 'Stays' })
    const category = buildProjectShopTierConfigs([pinned(stays)], USD6)[0].category
    expect(() => buildProjectShopTierConfigs([pinned(stays)], USD6, { Other: category })).toThrow('Two category names')
    for (const known of [{ Stays: -1 }, { Stays: 0x1000000 }, { Stays: 2, Meals: 2 }]) {
      expect(() => buildProjectShopTierConfigs([pinned(stays)], USD6, known)).toThrow()
    }
    for (const encodedIpfsUri of ['0x1234', `0x${'00'.repeat(32)}`, `0x${'zz'.repeat(32)}`] as Hex[]) {
      expect(() => buildProjectShopTierConfigs([{ draft: stays, encodedIpfsUri }], USD6)).toThrow('valid pinned metadata')
    }
  })
})
