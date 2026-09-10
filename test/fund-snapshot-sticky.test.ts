import { describe, expect, it, vi } from 'vitest'
import { v6Address } from '@bananapus/nana-sdk-core/v6'
import { getAddress, isAddressEqual, toHex, zeroAddress, type Address, type PublicClient } from 'viem'
import { resolveFundStickyCustody, type StickyCustodyHistoryRequest, type StickyCustodyLog } from '../src/lib/fund-snapshot-sticky'
import type { FundSnapshotHolder } from '../src/lib/fund-snapshot'

const addr = (n: number): Address => getAddress(toHex(n, { size: 20 }))
const factory = addr(100), hook = addr(101), rootToken = addr(102), alice = addr(1), bob = addr(2), carol = addr(3)
const terminal = v6Address('JBMultiTerminal', 1), tokens = v6Address('JBTokens', 1), directory = v6Address('JBDirectory', 1), projects = v6Address('JBProjects', 1), controller = v6Address('JBController', 1), store = v6Address('JBTerminalStore', 1)
const block = 2000n
type Row = { holder: Address; balance: bigint }
type Pool = { id: bigint; token: Address; underlying: Address; feed: Address; backing: bigint; orphaned: bigint; supply: bigint; holders: Row[]; tax: bigint; soulbound: boolean; credits?: bigint }
const pool = (id: number, backing: bigint, holders: Row[], underlying = rootToken): Pool => ({ id: BigInt(id), token: addr(200 + id), underlying, feed: addr(300 + id), backing, orphaned: 0n, supply: holders.reduce((sum, row) => sum + row.balance, 0n), holders, tax: 0n, soulbound: true })
const raw = (holder: Address, balance: bigint, credits = 0n): FundSnapshotHolder => ({ holder, balance, erc20Balance: balance - credits, creditBalance: credits })
function fixture(pools: Pool[], rootHolders = [raw(terminal, pools.filter(row => row.underlying === rootToken).reduce((sum, row) => sum + row.backing, 0n))]) {
  const byId = (id: unknown) => { const result = pools.find(row => row.id === id); if (!result) throw new Error('Unknown fixture pool'); return result }
  const readContract = vi.fn(async (request: { address: Address; functionName: string; args?: readonly unknown[]; blockNumber?: bigint }) => {
    expect(request.blockNumber).toBe(block)
    const { address, functionName: fn, args = [] } = request
    if (address === factory) {
      if (fn === 'HOOK') return hook
      const value = byId(args[0]); if (fn === 'stakedTokenOf') return value.underlying; if (fn === 'cashOutTaxRateOf') return value.tax; if (fn === 'priceFeedOf') return value.feed
    }
    if (address === hook) {
      if (fn === 'DEPLOYER') return factory; if (fn === 'DIRECTORY') return directory
      const value = byId(args[0]); if (fn === 'tokenOf') return value.token; if (fn === 'orphanedBalanceOf') return value.orphaned
      if (fn === 'stakedBalanceOf') return value.holders.find(row => isAddressEqual(row.holder, args[1] as Address))?.balance ?? 0n
    }
    if (address === projects && fn === 'ownerOf') return factory
    if (address === directory) { if (fn === 'controllerOf') return controller; if (fn === 'primaryTerminalOf') return terminal }
    if (address === tokens) {
      const value = byId(args[fn === 'creditBalanceOf' || fn === 'totalBalanceOf' ? 1 : 0])
      if (fn === 'tokenOf') return value.token
      if (fn === 'totalCreditSupplyOf') return value.credits ?? 0n
      if (fn === 'totalSupplyOf') return value.supply + (value.credits ?? 0n)
      if (fn === 'creditBalanceOf') return 0n
      if (fn === 'totalBalanceOf') return value.holders.find(row => isAddressEqual(row.holder, args[0] as Address))?.balance ?? 0n
    }
    if (address === store && fn === 'balanceOf') return byId(args[1]).backing
    if (address === terminal) {
      const value = byId(args[0])
      if (fn === 'accountingContextForTokenOf') return { token: value.underlying, decimals: 18, currency: 102 }
      if (fn === 'currentSurplusOf') { expect(args).toEqual([value.id, [value.underlying], 18n, 102n]); return value.backing }
    }
    const share = pools.find(row => row.token === address)
    if (share) {
      if (fn === 'HOOK') return hook; if (fn === 'TOKENS') return tokens; if (fn === 'PROJECT_ID') return share.id; if (fn === 'SOULBOUND') return share.soulbound
      if (fn === 'totalSupply') return share.supply
      if (fn === 'balanceOf') return share.holders.find(row => isAddressEqual(row.holder, args[0] as Address))?.balance ?? 0n
    }
    const feed = pools.find(row => row.feed === address)
    if (feed) {
      if (fn === 'DECIMALS') return 18; if (fn === 'CURRENCY') return 102; if (fn === 'HOOK') return hook; if (fn === 'TERMINAL') return terminal
      if (fn === 'TOKEN') return feed.token; if (fn === 'PROJECT_ID') return feed.id; if (fn === 'UNDERLYING_TOKEN') return feed.underlying
    }
    throw new Error(`Unexpected fixture read ${fn}`)
  })
  function log(value: Pool, logIndex: number, args: Record<string, unknown>): StickyCustodyLog { return { address: factory, blockNumber: 100n + value.id, blockHash: toHex(100n + value.id, { size: 32 }), transactionHash: toHex(500n + value.id, { size: 32 }), logIndex, args } }
  const readHistory = vi.fn(async (request: StickyCustodyHistoryRequest) => {
    if (request.event.name === 'DeploySticky') return pools.filter(value => value.underlying === request.indexedArgs?.stakedToken).map(value => log(value, 0, { projectId: value.id, stakedToken: value.underlying, token: value.token, cashOutTaxRate: value.tax, soulbound: value.soulbound }))
    if (request.event.name === 'Transfer') { const value = pools.find(row => row.token === request.address)!; return value.holders.map((row, i) => ({ ...log(value, i + 1, { from: zeroAddress, to: row.holder, value: row.balance }), address: value.token })) }
    return []
  })
  const client = { readContract, getCode: vi.fn(async () => '0x6000') } as unknown as PublicClient
  const input = { chainId: 1 as const, blockNumber: block, factory, rootToken, rootCreationBlockNumber: 1n, holders: rootHolders, logBlockWindow: 2000n, readHistory }
  return { client, readContract, readHistory, input, run: () => resolveFundStickyCustody(client, input) }
}

describe('canonical Sticky principal look-through', () => {
  it('resolves permissionlessly staked FUND dust instead of blocking every holder’s snapshot', async () => {
    const rpc = fixture([pool(1, 1n, [{ holder: bob, balance: 1n }])], [raw(alice, 99n, 50n), raw(terminal, 1n)])
    const result = await rpc.run()
    expect(result.holders).toMatchObject([{ holder: alice, balance: 99n }, { holder: bob, balance: 1n }])
    expect(result.custody.pools[0]).toMatchObject({ backing: 1n, shareOwnedBacking: 1n, totalShareSupply: 1n, totalShareCreditSupply: 0n })
  })

  it('subtracts each canonical ledger only once and preserves terminal credits and direct donations', async () => {
    const rpc = fixture([pool(1, 40n, [{ holder: alice, balance: 2n }]), pool(2, 60n, [{ holder: bob, balance: 1n }])], [raw(terminal, 110n, 3n)])
    const result = await rpc.run()
    expect(result.holders).toMatchObject([{ holder: alice, balance: 40n }, { holder: bob, balance: 60n }, { holder: getAddress(terminal), balance: 10n }].sort((a, b) => a.holder.toLowerCase() < b.holder.toLowerCase() ? -1 : 1))
    expect(result.holders.reduce((sum, row) => sum + row.balance, 0n)).toBe(110n)
  })

  it('retains orphaned backing at the terminal rather than assigning it to subsequent SHARE owners', async () => {
    const active = pool(1, 100n, [{ holder: alice, balance: 10n }]); active.orphaned = 25n
    const empty = pool(2, 50n, []); empty.orphaned = 70n
    const result = await fixture([active, empty]).run()
    expect(result.holders.find(row => row.holder === alice)?.balance).toBe(75n)
    expect(result.holders.find(row => isAddressEqual(row.holder, terminal))?.balance).toBe(75n)
    expect(result.custody.pools.map(row => [row.orphanedBacking, row.shareOwnedBacking])).toEqual([[25n, 75n], [50n, 0n]])
  })

  it.each([0n, 5000n, 10000n])('allocates gross share-owned backing, including retained taxes/donations, with fixed tax %s recorded', async tax => {
    const value = pool(1, 103n, [{ holder: alice, balance: 1n }, { holder: bob, balance: 2n }]); value.tax = tax
    const result = await fixture([value]).run()
    expect(result.holders).toMatchObject([{ holder: alice, balance: 35n }, { holder: bob, balance: 68n }])
    expect(result.custody.pools[0].cashOutTaxRate).toBe(tax)
  })

  it('follows nested canonical pools without mistaking the shared terminal for a graph cycle', async () => {
    const parent = pool(1, 100n, [{ holder: alice, balance: 50n }, { holder: terminal, balance: 50n }])
    parent.soulbound = false
    const child = pool(2, 40n, [{ holder: bob, balance: 3n }, { holder: carol, balance: 1n }], parent.token)
    const result = await fixture([parent, child]).run()
    expect(result.holders.find(row => row.holder === alice)?.balance).toBe(50n)
    expect(result.holders.find(row => row.holder === bob)?.balance).toBe(30n)
    expect(result.holders.find(row => row.holder === carol)?.balance).toBe(10n)
    expect(result.holders.find(row => isAddressEqual(row.holder, terminal))?.balance).toBe(10n)
    expect(result.custody.pools.map(row => row.projectId)).toEqual([1n, 2n])
  })

  it('does not use delegation or staking age to exclude inactive SHARE holders', async () => {
    const rpc = fixture([pool(1, 100n, [{ holder: alice, balance: 1n }, { holder: bob, balance: 1n }])])
    expect((await rpc.run()).holders).toHaveLength(2)
    expect(rpc.readContract.mock.calls.some(([value]) => /votes|delegate|tranche/i.test(value.functionName))).toBe(false)
  })

  it('keeps unrelated contract holders as their original identities', async () => {
    const wallet = addr(500)
    const result = await fixture([], [raw(wallet, 100n)]).run()
    expect(result.holders).toMatchObject([{ holder: wallet, balance: 100n }])
    expect(result.custody.pools).toEqual([])
  })

  it('rejects credits that cannot exist in a canonical atomically attached SHARE pool', async () => {
    const value = pool(1, 1n, [{ holder: alice, balance: 1n }]); value.credits = 1n
    await expect(fixture([value]).run()).rejects.toThrow('SHARE accounting')
  })

  it.each(['token', 'owner', 'feed', 'hook-balance', 'backing', 'orphan'] as const)('rejects inconsistent canonical custody identity/accounting: %s', async mode => {
    const value = pool(1, 100n, [{ holder: alice, balance: 1n }]); if (mode === 'orphan') value.orphaned = 101n
    const rpc = fixture([value], [raw(terminal, mode === 'backing' ? 99n : 100n)])
    const original = rpc.readContract.getMockImplementation()!
    rpc.readContract.mockImplementation(async request => {
      if (mode === 'token' && request.address === tokens && request.functionName === 'tokenOf') return rootToken
      if (mode === 'owner' && request.functionName === 'ownerOf') return alice
      if (mode === 'feed' && request.functionName === 'UNDERLYING_TOKEN') return value.token
      if (mode === 'hook-balance' && request.functionName === 'stakedBalanceOf') return 0n
      return original(request)
    })
    await expect(rpc.run()).rejects.toThrow()
  })

  it('fails closed for truncated holder history or cyclic pool identities', async () => {
    const value = pool(1, 100n, [{ holder: alice, balance: 1n }]); value.supply = 2n
    await expect(fixture([value]).run()).rejects.toThrow('complete SHARE supply')
    value.supply = 1n; value.token = rootToken
    await expect(fixture([value]).run()).rejects.toThrow('cyclic')
  })

  it('supports cancellation before any incomplete custody result is returned', async () => {
    const rpc = fixture([]), cancelled = new AbortController(); cancelled.abort()
    await expect(resolveFundStickyCustody(rpc.client, { ...rpc.input, signal: cancelled.signal })).rejects.toThrow('cancelled')
  })

  it('retains every fractional owner when one FUND atom backs 100 independent SHARE holders', async () => {
    const holders = Array.from({ length: 100 }, (_, index) => ({ holder: addr(index + 1000), balance: 1n }))
    const result = await fixture([pool(1, 1n, holders)]).run()
    expect(result.holders).toHaveLength(100)
    expect(result.holders.map(row => row.balance)).toEqual([1n, ...Array.from({ length: 99 }, () => 0n)])
    expect(result.holders.every(row => row.weight.numerator === 1n && row.weight.denominator === 100n)).toBe(true)
  })

  it('never rounds tiny nested SHARE units before converting their large FUND backing', async () => {
    const parent = pool(1, 10n ** 18n, [{ holder: terminal, balance: 1n }])
    parent.soulbound = false
    const child = pool(2, 1n, [{ holder: alice, balance: 1n }, { holder: bob, balance: 1n }], parent.token)
    const result = await fixture([parent, child]).run()
    expect(result.holders).toMatchObject([{ holder: alice, balance: 5n * 10n ** 17n }, { holder: bob, balance: 5n * 10n ** 17n }])
    expect(result.custody.pools[1].allocatedUnderlying.map(row => row.weight)).toEqual([{ numerator: 1n, denominator: 2n }, { numerator: 1n, denominator: 2n }])
  })
})
