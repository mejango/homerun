import { beforeEach, describe, expect, it, vi } from 'vitest'
import { v6Address, TIER_UNLIMITED_SUPPLY, type Project721Shop, type Project721Tier } from '@bananapus/nana-sdk-core/v6'
import { zeroAddress, type Address, type PublicClient } from 'viem'

const mocks = vi.hoisted(() => ({ readShop: vi.fn(), query: vi.fn() }))
vi.mock('@bananapus/nana-sdk-core/v6', async () => ({ ...await vi.importActual('@bananapus/nana-sdk-core/v6'), getProject721Shop: mocks.readShop }))
vi.mock('../src/lib/bendystraw', () => ({ bendystraw: mocks.query }))
import { readProjectShop, readShopCustomers, shopTierAvailability, shopTierName, shopTierPrice } from '../src/lib/project-shop'

const HOOK = '0x1111111111111111111111111111111111111111' as Address
const STORE = '0x2222222222222222222222222222222222222222' as Address
const OWNER = '0x3333333333333333333333333333333333333333' as Address
const OTHER = '0x4444444444444444444444444444444444444444' as Address
function tier(overrides: Partial<Project721Tier> = {}): Project721Tier {
  return { id: 1, price: 100_000_000n, remainingSupply: 8, initialSupply: 10, votingUnits: 0n, reserveFrequency: 0, category: 0, discountPercent: 20, encodedIpfsUri: `0x${'0'.repeat(64)}`, resolvedUri: '', ...overrides }
}
function shop(overrides: Partial<Project721Shop> = {}): Project721Shop {
  return { hook: HOOK, store: STORE, metadataIdTarget: OTHER, pricing: { currency: 2, decimals: 6 }, tiers: [tier()], ...overrides }
}
function fixture(owner: Address = OWNER) {
  const readContract = vi.fn(async ({ functionName }: { functionName: string }) => functionName === 'ownerOf' ? owner : v6Address('JBController', 1))
  const rpc = { getChainId: vi.fn(async () => 1), getBlockNumber: vi.fn(async () => 100n), readContract }
  return { rpc, client: rpc as unknown as PublicClient }
}
function row(overrides: Record<string, unknown> = {}) {
  return { chainId: 1, projectId: 7, createdAt: 10, mintTx: `0x${'a'.repeat(64)}`, tokenId: '1000000001', owner: OWNER, tierId: 1, hook: { address: HOOK }, ...overrides }
}
beforeEach(() => { mocks.readShop.mockReset(); mocks.query.mockReset(); mocks.readShop.mockResolvedValue(shop()) })

describe('verified project shop reads', () => {
  it('reads the SDK shop at one block and resolves project ownership instead of trusting its token label', async () => {
    const f = fixture()
    const data = await readProjectShop(f.client, { chainId: 1, projectId: 7n })
    expect(data).toMatchObject({ hook: HOOK, blockNumber: 100n, truncated: false, checkoutUrl: 'https://juicebox.money/eth:7#shop' })
    expect(mocks.readShop).toHaveBeenCalledWith(expect.anything(), { chainId: 1, projectId: 7n, isRevnet: false, tierLimit: 201 })
    const snapshot = mocks.readShop.mock.calls[0][0] as PublicClient
    await snapshot.readContract({ address: HOOK, abi: [], functionName: 'test' })
    expect(f.rpc.readContract).toHaveBeenLastCalledWith(expect.objectContaining({ blockNumber: 100n }))
    const revnet = fixture(v6Address('REVOwner', 1))
    await readProjectShop(revnet.client, { chainId: 1, projectId: 7n })
    expect(mocks.readShop).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ isRevnet: true }))
  })
  it('reports authoritative absence but propagates RPC failures', async () => {
    const { client } = fixture()
    mocks.readShop.mockResolvedValueOnce(null)
    expect(await readProjectShop(client, { chainId: 1, projectId: 7n })).toBeNull()
    mocks.readShop.mockRejectedValueOnce(new Error('RPC timeout'))
    await expect(readProjectShop(client, { chainId: 1, projectId: 7n })).rejects.toThrow('RPC timeout')
  })
  it('rejects wrong chains and controllers before reading a shop', async () => {
    const f = fixture()
    f.rpc.getChainId.mockResolvedValueOnce(10)
    await expect(readProjectShop(f.client, { chainId: 1, projectId: 7n })).rejects.toThrow('different chain')
    f.rpc.readContract.mockResolvedValue(OTHER)
    await expect(readProjectShop(f.client, { chainId: 1, projectId: 7n })).rejects.toThrow('registered V6 controller')
    expect(mocks.readShop).not.toHaveBeenCalled()
  })
  it('makes the inventory limit explicit and rejects invalid identities or duplicates', async () => {
    const { client } = fixture()
    mocks.readShop.mockResolvedValueOnce(shop({ tiers: Array.from({ length: 201 }, (_, i) => tier({ id: i + 1 })) }))
    const data = await readProjectShop(client, { chainId: 1, projectId: 7n })
    expect(data?.tiers).toHaveLength(200)
    expect(data?.truncated).toBe(true)
    mocks.readShop.mockResolvedValueOnce(shop({ hook: zeroAddress }))
    await expect(readProjectShop(client, { chainId: 1, projectId: 7n })).rejects.toThrow('invalid contract')
    mocks.readShop.mockResolvedValueOnce(shop({ tiers: [tier(), tier()] }))
    await expect(readProjectShop(client, { chainId: 1, projectId: 7n })).rejects.toThrow('repeated inventory')
  })
})

describe('shop item display', () => {
  it('uses the contract discount denominator and exact currency decimals', () => {
    expect(shopTierPrice(tier(), { currency: 2, decimals: 6 })).toBe('90 USD')
    expect(shopTierPrice(tier({ price: 10n, discountPercent: 0 }), { currency: 1, decimals: 18 })).toBe('0.00000000000000001 ETH')
    expect(shopTierPrice(tier(), { currency: 123, decimals: 6 })).toBe('90 currency #123')
  })
  it('distinguishes sold out, finite and unlimited stock', () => {
    expect(shopTierAvailability(tier())).toBe('8 of 10 remaining')
    expect(shopTierAvailability(tier({ remainingSupply: 0 }))).toBe('Sold out')
    expect(shopTierAvailability(tier({ initialSupply: TIER_UNLIMITED_SUPPLY }))).toBe('Unlimited supply')
  })
  it('accepts plain names only from valid inline JSON without fetching remote content', () => {
    expect(shopTierName(tier({ resolvedUri: 'data:application/json,%7B%22name%22%3A%22Stay%22%7D' }))).toBe('Stay')
    expect(shopTierName(tier({ resolvedUri: `data:application/json;base64,${btoa('{"name":"Stay"}')}` }))).toBe('Stay')
    expect(shopTierName(tier({ resolvedUri: 'https://example.com/arbitrary.json' }))).toBe('Item #1')
    expect(shopTierName(tier({ resolvedUri: 'data:application/json,null' }))).toBe('Item #1')
  })
})

describe('indexed shop customers', () => {
  it('scopes V6 rows and filters wrong deployments, hooks, owners and burned items at the boundary', async () => {
    mocks.query.mockResolvedValueOnce({ nfts: { totalCount: 7, items: [row(), row({ chainId: 10 }), row({ projectId: 8 }), row({ hook: { address: OTHER } }), row({ owner: zeroAddress }), row({ owner: OTHER }), row({ hook: null })] } })
    const result = await readShopCustomers({ chainId: 1, projectId: 7n, hook: HOOK, owner: OWNER })
    expect(result.items).toEqual([row()])
    expect(result.skipped).toBe(6)
    expect(result.nextOffset).toBeNull()
    expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining('query HomerunShopCustomers'), { where: { chainId: 1, projectId: 7, version: 6, owner: OWNER }, limit: 50, offset: 0 }, { chainId: 1, policy: 'live' })
  })
  it('paginates by raw records so omitted collections cannot hide later customers', async () => {
    mocks.query.mockResolvedValueOnce({ nfts: { totalCount: 101, items: Array.from({ length: 50 }, (_, i) => row({ tokenId: String(i), hook: { address: OTHER } })) } })
    const result = await readShopCustomers({ chainId: 1, projectId: 7n, hook: HOOK })
    expect(result.items).toHaveLength(0)
    expect(result.nextOffset).toBe(50)
  })
  it('preserves indexer failures and rejects unsafe range requests', async () => {
    mocks.query.mockRejectedValueOnce(new Error('Indexer unavailable'))
    await expect(readShopCustomers({ chainId: 1, projectId: 7n, hook: HOOK })).rejects.toThrow('Indexer unavailable')
    await expect(readShopCustomers({ chainId: 1, projectId: 2n ** 100n, hook: HOOK })).rejects.toThrow('supported range')
    await expect(readShopCustomers({ chainId: 1, projectId: 7n, hook: HOOK, offset: -1 })).rejects.toThrow('Invalid customer page')
  })
})
