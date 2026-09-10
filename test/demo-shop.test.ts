import { describe, expect, it, vi } from 'vitest'
import { zeroAddress } from 'viem'
import {
  MAX_DEMO_SHOP_MEDIA_BYTES, MAX_DEMO_SHOP_STORAGE_LENGTH,
  demoShopPrice, demoShopStorageKey, newDemoShopItem, parseDemoShopStorage,
  validateDemoShopItem, type DemoShopCurrency, type DemoShopItem, type DemoShopSplit,
} from '../src/lib/demo-shop'

const WALLET = '0x1111111111111111111111111111111111111111'
const item = (overrides: Partial<DemoShopItem> = {}): DemoShopItem => ({ ...newDemoShopItem(), name: 'A week at Founder Haus', price: '125', ...overrides })
const split = (overrides: Partial<DemoShopSplit> = {}): DemoShopSplit => ({ id: 'split', kind: 'address', recipient: WALLET, projectId: '', beneficiary: '', percent: '25', ...overrides })
const serialize = (items: unknown[], currency: DemoShopCurrency = 'USD') => JSON.stringify({ version: 1, currency, items })

describe('demo item rules mirror the stock shop', () => {
  it('starts with reference flags and distinct item identifiers', () => {
    const draft = newDemoShopItem()
    expect(draft).toMatchObject({ name: '', price: '', supply: '', media: null, category: '', splits: [], reserveN: '', votingUnits: '', allowCredits: true, ownerCanEditDiscount: true, allowOwnerMint: false, transfersPausable: false, cantBeRemoved: false })
    expect(newDemoShopItem().id).not.toBe(draft.id)
    expect(validateDemoShopItem(draft, 'USD')).toHaveProperty('name')
    expect(validateDemoShopItem(draft, 'USD')).toHaveProperty('price')
  })
  it('provides distinct browser identifiers without randomUUID', () => {
    const randomUUID = vi.spyOn(globalThis.crypto, 'randomUUID').mockImplementation(undefined as never)
    try { expect(newDemoShopItem().id).not.toBe(newDemoShopItem().id) }
    finally { randomUUID.mockRestore() }
  })
  it.each(['0', '-1', '1e3', 'Infinity', '0x10', '1,000', '+1', '0.0000001'])('rejects invalid USD price %s', price => {
    expect(validateDemoShopItem(item({ price }), 'USD')).toHaveProperty('price')
  })
  it('validates exact precision and the contract uint104 price bound', () => {
    expect(validateDemoShopItem(item({ price: '0.000001' }), 'USD')).toEqual({})
    expect(validateDemoShopItem(item({ price: '0.000000000000000001' }), 'ETH')).toEqual({})
    expect(validateDemoShopItem(item({ price: '0.0000000000000000001' }), 'ETH')).toHaveProperty('price')
    expect(validateDemoShopItem(item({ price: '20282409603651670423947251.286015' }), 'USD')).toEqual({})
    expect(validateDemoShopItem(item({ price: '20282409603651670423947251.286016' }), 'USD')).toHaveProperty('price')
  })
  it('accepts unlimited inventory, boundaries, and zero voting units', () => {
    expect(validateDemoShopItem(item(), 'USD')).toEqual({})
    expect(validateDemoShopItem(item({ supply: '999999998', votingUnits: '4294967295' }), 'USD')).toEqual({})
    expect(validateDemoShopItem(item({ supply: '1', votingUnits: '0' }), 'USD')).toEqual({})
    for (const supply of ['0', '999999999', '1.5', '1e2']) expect(validateDemoShopItem(item({ supply }), 'USD')).toHaveProperty('supply')
    for (const votingUnits of ['-1', '4294967296', '1e3', '1.5']) expect(validateDemoShopItem(item({ votingUnits }), 'USD')).toHaveProperty('votingUnits')
  })
  it('checks reserve frequency, beneficiary, and minimum finite inventory together', () => {
    for (const reserveN of ['1', '65535']) expect(validateDemoShopItem(item({ supply: '2', reserveN, reserveBeneficiary: WALLET }), 'USD')).toEqual({})
    expect(validateDemoShopItem(item({ reserveN: '2', reserveBeneficiary: WALLET }), 'USD')).toEqual({})
    expect(validateDemoShopItem(item({ supply: '01', reserveN: '2', reserveBeneficiary: WALLET }), 'USD')).toHaveProperty('supply')
    for (const reserveN of ['0', '65536', '2.5', '1e2']) expect(validateDemoShopItem(item({ reserveN, reserveBeneficiary: WALLET }), 'USD')).toHaveProperty('reserveN')
    for (const reserveBeneficiary of ['', zeroAddress, 'founder.eth']) expect(validateDemoShopItem(item({ reserveN: '2', reserveBeneficiary }), 'USD')).toHaveProperty('reserveBeneficiary')
  })
  it('requires exactly representable half-percent discounts', () => {
    for (const discountPct of ['', '0', '.5', '99.5', '100', '100.00', '.500', '.000']) expect(validateDemoShopItem(item({ discountPct }), 'USD')).toEqual({})
    for (const discountPct of ['0.1', '99.9', '100.5', '-.5', '5e1', '.']) expect(validateDemoShopItem(item({ discountPct }), 'USD')).toHaveProperty('discountPct')
  })
  it('prices with the contract rounding rule instead of floating point or rounding a reduced price', () => {
    expect(demoShopPrice(item({ price: '100', discountPct: '10' }), 'USD')).toBe('90 USD')
    expect(demoShopPrice(item({ price: '0.000001', discountPct: '50' }), 'USD')).toBe('0.000001 USD')
    expect(demoShopPrice(item({ price: '1.234567', discountPct: '.5' }), 'USD')).toBe('1.228395 USD')
    expect(demoShopPrice(item({ price: '0.000000000000000003', discountPct: '50' }), 'ETH')).toBe('0.000000000000000002 ETH')
    expect(demoShopPrice(item({ discountPct: '100' }), 'USD')).toBe('0 USD')
    expect(demoShopPrice(item({ price: '1e3' }), 'USD')).toBe('—')
    expect(demoShopPrice(item({ discountPct: '10.1' }), 'USD')).toBe('—')
  })
  it('supports wallet and project sale recipients using exact contract percentage precision', () => {
    expect(validateDemoShopItem(item({ splits: [split({ percent: '33.3333333' }), split({ id: 'project', kind: 'project', projectId: '#12', beneficiary: WALLET, percent: '66.6666667' })] }), 'USD')).toEqual({})
    expect(validateDemoShopItem(item({ splits: [split({ percent: '100' }), split({ id: 'overflow', percent: '.0000001' })] }), 'USD')).toHaveProperty('splits')
    for (const bad of [split({ recipient: zeroAddress }), split({ percent: '1e1' }), split({ percent: '0' }), split({ percent: '.00000001' }), split({ kind: 'project', projectId: '#1', beneficiary: '' }), split({ kind: 'project', projectId: '#0', beneficiary: WALLET })]) {
      expect(validateDemoShopItem(item({ splits: [bad] }), 'USD')).toHaveProperty('splits')
    }
    expect(validateDemoShopItem(item({ splits: [split(), split()] }), 'USD')).toHaveProperty('splits')
  })
})

describe('bounded local demo shop persistence', () => {
  it('round-trips settings and media without storing unknown executable or prototype fields', () => {
    const savedItem = item({ media: { name: 'photo.jpg', type: 'image/jpeg', url: 'https://example.com/photo.jpg' }, splits: [split()] })
    const raw = JSON.stringify({ version: 1, currency: 'USD', ignored: true, items: [{ ...savedItem, injected: true, media: { ...savedItem.media, onerror: 'bad()' }, splits: [{ ...split(), ignored: true }] }] })
    expect(parseDemoShopStorage(raw)).toEqual({ currency: 'USD', items: [savedItem] })
    expect(parseDemoShopStorage(serialize([], 'ETH'))).toEqual({ currency: 'ETH', items: [] })
    expect(demoShopStorageKey('founderhaus')).not.toBe(demoShopStorageKey('other'))
    expect(demoShopStorageKey('a:b')).toBe('homerun:demo-shop:v1:a%3Ab')
  })
  it.each([null, '', '{broken', 'null', '[]', '{"version":2,"currency":"USD","items":[]}', '{"version":1,"currency":"EUR","items":[]}', '{"version":1,"currency":"USD","items":{}}'])('rejects unsupported or malformed storage %s', raw => {
    expect(parseDemoShopStorage(raw)).toBeNull()
  })
  it('rejects malformed fields, duplicate identities and invalid item data as one unit', () => {
    const savedItem = item()
    for (const bad of [{ ...savedItem, name: 1 }, { ...savedItem, allowCredits: 'true' }, { ...savedItem, media: {} }, { ...savedItem, media: [] }, { ...savedItem, splits: [{ ...split(), percent: null }] }, { ...savedItem, price: '1e3' }, { ...savedItem, description: 'x'.repeat(10001) }]) {
      expect(parseDemoShopStorage(serialize([savedItem, bad]))).toBeNull()
    }
    expect(parseDemoShopStorage(serialize([savedItem, savedItem]))).toBeNull()
    expect(parseDemoShopStorage(serialize(Array.from({ length: 101 }, () => item())))).toBeNull()
    expect(parseDemoShopStorage(' '.repeat(MAX_DEMO_SHOP_STORAGE_LENGTH + 1))).toBeNull()
  })
  it('accepts supported local media and rejects active, temporary, malformed or oversize sources', () => {
    for (const type of ['image/png', 'video/mp4', 'audio/mpeg', 'application/pdf', 'text/plain']) {
      const media = { type, name: 'media', url: `data:${type};base64,SGVsbG8=` }
      expect(parseDemoShopStorage(serialize([item({ media })]))).not.toBeNull()
    }
    for (const url of ['javascript:alert(1)', 'blob:https://example.com/test', 'http://example.com/a', '//example.com/a', 'https://user:pass@example.com/a', 'https://example.com/a\n', 'data:image/png;base64,=AAA', 'data:image/png;base64,AB=C', 'data:image/png;base64,QQ', 'data:text/html;base64,SGVsbG8=', `data:image/png;base64,${'A'.repeat(Math.ceil(MAX_DEMO_SHOP_MEDIA_BYTES / 3) * 4 + 4)}`]) {
      expect(validateDemoShopItem(item({ media: { name: 'media', type: 'image/png', url } }), 'USD')).toHaveProperty('media')
    }
    expect(validateDemoShopItem(item({ media: { name: 'page', type: 'text/html', url: 'https://example.com/' } }), 'USD')).toHaveProperty('media')
  })
})
