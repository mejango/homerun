import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getAddress, keccak256, stringToHex, toHex, zeroAddress, zeroHash, type Address, type Hex, type PublicClient } from 'viem'
import type { JBChainId } from '@bananapus/nana-sdk-core'
import {
  buildFundGlobalManifest, canonicalSnapshotJson, FUND_GLOBAL_MANIFEST_SCHEMA,
  fundGlobalManifestHash, fundGlobalSourceSetHash,
  globalIncomeSnapshotParameters, parseFundGlobalManifest, serializeFundGlobalManifest,
  verifyFundGlobalManifestHistory, type FundGlobalManifest,
} from '../src/lib/fund-global-manifest'
import { readFundGlobalSnapshot, type FundGlobalEntitlement, type FundGlobalSnapshot } from '../src/lib/fund-global-snapshot'
import type { FundOwnershipForGlobalSnapshot } from '../src/lib/fund-snapshot'

vi.mock('../src/lib/fund-global-snapshot', () => ({ readFundGlobalSnapshot: vi.fn() }))
const TOTAL = 500_000n * 10n ** 18n
const addr = (id: number): Address => getAddress(toHex(id, { size: 20 }))
const hash = (id: number): Hex => toHex(id, { size: 32 })
const helper = addr(200), salt = hash(201), owner = addr(202), alice = addr(1), bob = addr(2)
const options = { helper, launchSalt: salt }
const ipfs = 'ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi'

function row(chainId: JBChainId, beneficiary: Address, live: bigint, pending = 0n): FundGlobalEntitlement {
  const projectId = chainId === 1 ? 7n : 99n
  return {
    claimChainId: chainId, beneficiary, liveFundBalance: live, pendingFundBalance: pending, fundBalance: live + pending,
    sources: [
      ...(live ? [{ kind: 'live-balance' as const, chainId, projectId, amount: live }] : []),
      ...(pending ? [{ kind: 'pending-bridge' as const, chainId: 1 as const, projectId: 7n, amount: pending, sourceSucker: addr(10) }] : []),
    ],
  }
}
function snapshot(rows = [row(1, alice, 50n), row(10, alice, 25n, 25n)]): FundGlobalSnapshot {
  const graph: FundGlobalSnapshot['graph'] = {
    cuts: [{ chainId: 1, blockNumber: 100n, blockHash: hash(100), blockTimestamp: 1000n }, { chainId: 10, blockNumber: 200n, blockHash: hash(200), blockTimestamp: 1001n }],
    projects: [{ chainId: 1, projectId: 7n, owner, controller: addr(30), historicalSuckers: [addr(10)] }, { chainId: 10, projectId: 99n, owner, controller: addr(30), historicalSuckers: [addr(11)] }],
    lanes: [{ sourceChainId: 1, sourceProjectId: 7n, sourceSucker: addr(10), destinationChainId: 10, destinationProjectId: 99n, destinationSucker: addr(11) }],
  }
  const projects: FundOwnershipForGlobalSnapshot[] = graph.projects.map((project, index) => {
    const holders = rows.filter(entry => entry.claimChainId === project.chainId && entry.liveFundBalance > 0n).map(entry => ({ holder: entry.beneficiary, balance: entry.liveFundBalance, creditBalance: entry.liveFundBalance, erc20Balance: 0n }))
    const supply = holders.reduce((sum, holder) => sum + holder.balance, 0n)
    return {
      ...project, historicalSuckers: [...project.historicalSuckers], ...graph.cuts[index], creationBlockNumber: 1n, creationTransactionHash: hash(300 + index),
      tokenAddress: null, totalFundSupply: supply, totalCreditSupply: supply, totalErc20Supply: 0n, holders,
      evidence: { projects: addr(31), tokens: addr(32), controller: project.controller, suckerRegistry: addr(33), eventCounts: { Mint: holders.length, ClaimTokens: 0, TransferCredits: 0 }, candidateCount: holders.length, bridgePolicy: 'historical-graph-required' },
    }
  })
  const liveFundSupply = rows.reduce((sum, entry) => sum + entry.liveFundBalance, 0n)
  const pendingFundSupply = rows.reduce((sum, entry) => sum + entry.pendingFundBalance, 0n)
  return {
    kind: 'homerun-global-fund-entitlements', version: 1, root: { chainId: 1, projectId: 7n },
    claimPolicy: 'live-chain-and-pending-bridge-destination', historyAttestation: 'complete-canonical-rpc-log-history-required',
    graph, projects, bridges: [], entitlements: rows, totals: { liveFundSupply, pendingFundSupply, globalFundSupply: liveFundSupply + pendingFundSupply },
  }
}
function manifest(rows?: FundGlobalEntitlement[]) { return buildFundGlobalManifest(snapshot(rows), options) }
function holder(value: FundGlobalManifest, chainId: number, beneficiary: Address) { return value.allocations.find(allocation => allocation.chainId === chainId)!.holders.find(row => row.beneficiary === beneficiary) }
function asMutableJson(value: FundGlobalManifest) { return JSON.parse(JSON.stringify(value)) as FundGlobalManifest }

beforeEach(() => { vi.mocked(readFundGlobalSnapshot).mockReset() })

describe('global initial INCOME allocation', () => {
  it('allocates one global 500,000 supply while preserving identical wallet addresses on different chains', () => {
    const value = manifest()
    expect(value.schema).toBe(FUND_GLOBAL_MANIFEST_SCHEMA)
    expect(value.totalIncomeAmount).toBe(TOTAL.toString())
    expect(value.allocations.map(local => [local.chainId, local.fundProjectId, local.incomeAmount])).toEqual([[1, '7', (TOTAL / 2n).toString()], [10, '99', (TOTAL / 2n).toString()]])
    expect(value.allocations.flatMap(local => local.holders).reduce((sum, row) => sum + BigInt(row.incomeAmount), 0n)).toBe(TOTAL)
    expect(holder(value, 1, alice)).toMatchObject({ beneficiary: alice, incomeAmount: (TOTAL / 2n).toString() })
    expect(holder(value, 10, alice)).toMatchObject({ beneficiary: alice, incomeAmount: (TOTAL / 2n).toString(), liveFundBalance: '25', pendingFundBalance: '25', fundBalance: '50' })
    expect(Object.keys(value.allocations[1].holders[0]).sort()).toEqual(['beneficiary', 'fundBalance', 'incomeAmount', 'liveFundBalance', 'pendingFundBalance'])
  })

  it('assigns rounding atoms once to the lowest numeric chain then lowest hexadecimal address', () => {
    const value = manifest([row(10, alice, 1n), row(1, bob, 1n), row(1, alice, 1n)])
    expect(value.allocations.map(local => local.chainId)).toEqual([1, 10])
    expect(value.allocations[0].holders.map(holder => [holder.beneficiary, BigInt(holder.incomeAmount)])).toEqual([[alice, TOTAL / 3n + 2n], [bob, TOTAL / 3n]])
    expect(BigInt(value.allocations[1].holders[0].incomeAmount)).toBe(TOTAL / 3n)
    expect(value.allocations.flatMap(local => local.holders).reduce((sum, holder) => sum + BigInt(holder.incomeAmount), 0n)).toBe(TOTAL)
  })

  it('represents a source chain with no remaining entitlements using an empty zero allocation', () => {
    const value = manifest([row(10, alice, 0n, 100n)])
    expect(value.allocations[0]).toMatchObject({ chainId: 1, incomeAmount: '0', holders: [] })
    expect(value.allocations[1]).toMatchObject({ incomeAmount: TOTAL.toString() })
    expect(value.allocations[1].holders).toHaveLength(1)
    expect(holder(value, 1, alice)).toBeUndefined()
    expect(parseFundGlobalManifest(JSON.parse(serializeFundGlobalManifest(value)))).toEqual(value)
  })

  it('keeps a dust-only destination holder listed under a zero local allocation', () => {
    const value = manifest([row(1, alice, TOTAL * 2n), row(10, bob, 1n)])
    expect(value.allocations[0].incomeAmount).toBe(TOTAL.toString())
    expect(value.allocations[1]).toMatchObject({ incomeAmount: '0' })
    expect(value.allocations[1].holders).toEqual([{ beneficiary: bob, fundBalance: '1', liveFundBalance: '1', pendingFundBalance: '0', incomeAmount: '0' }])
    expect(parseFundGlobalManifest(JSON.parse(serializeFundGlobalManifest(value)))).toEqual(value)
  })

  it('includes zero-address rights in global supply and lists their allocation for the owner to settle', () => {
    const value = manifest([row(1, zeroAddress, 1n), row(1, alice, 1n), row(10, bob, 1n)])
    expect(value.allocations[0].holders[0]).toMatchObject({ beneficiary: zeroAddress, fundBalance: '1', incomeAmount: (TOTAL / 3n + 2n).toString() })
    expect(value.totalFundSupply).toBe('3')
    expect(value.allocations.flatMap(local => local.holders).reduce((sum, row) => sum + BigInt(row.incomeAmount), 0n)).toBe(TOTAL)
  })

  it('retains more than 200 holders across chains and round-trips them exactly', () => {
    const rows = Array.from({ length: 257 }, (_, index) => row(index % 2 === 0 ? 1 : 10, addr(index + 1), BigInt(index + 1)))
    const value = manifest(rows)
    expect(value.allocations.reduce((sum, local) => sum + local.holders.length, 0)).toBe(257)
    expect(value.allocations.flatMap(local => local.holders).reduce((sum, row) => sum + BigInt(row.incomeAmount), 0n)).toBe(TOTAL)
    expect(parseFundGlobalManifest(JSON.parse(serializeFundGlobalManifest(value)))).toEqual(value)
  })

  it('keeps the same address on different chains as distinct rows on their own chain', () => {
    const value = manifest([row(1, alice, 2n), row(1, bob, 1n), row(10, alice, 2n)])
    expect(value.allocations[0].holders.map(row => row.beneficiary)).toEqual([alice, bob])
    expect(value.allocations[1].holders.map(row => row.beneficiary)).toEqual([alice])
    expect(holder(value, 10, bob)).toBeUndefined()
    expect(holder(value, 1, addr(900))).toBeUndefined()
  })
})

type Fraction = { numerator: bigint; denominator: bigint }
type WeightedEntitlement = FundGlobalEntitlement & { fundWeight: Fraction; liveFundWeight: Fraction }
function fraction(numerator: bigint, denominator: bigint): Fraction {
  let a = numerator, b = denominator
  while (b) { const remainder = a % b; a = b; b = remainder }
  return { numerator: numerator / a, denominator: denominator / a }
}
function weightedRow(beneficiary: Address, weight: Fraction, projection: bigint, pending = 0n, chainId: JBChainId = 1): WeightedEntitlement {
  return { ...row(chainId, beneficiary, projection, pending), liveFundWeight: weight, fundWeight: fraction(weight.numerator + pending * weight.denominator, weight.denominator) }
}
function fractionalSnapshot(): FundGlobalSnapshot {
  return snapshot(Array.from({ length: 100 }, (_, index) => weightedRow(addr(index + 1), { numerator: 1n, denominator: 100n }, index === 0 ? 1n : 0n)))
}

describe('exact fractional FUND custody weights', () => {
  it('gives all 100 SHARE holders their initial INCOME when one FUND wei backs the custody balance', () => {
    const source = fractionalSnapshot(), value = buildFundGlobalManifest(source, options), local = value.allocations[0]
    expect(value.totalFundSupply).toBe('1')
    expect(local.holders).toHaveLength(100)
    expect(local.holders.every(holder => BigInt(holder.incomeAmount) === TOTAL / 100n)).toBe(true)
    expect(local.holders.map(holder => holder.fundBalance)).toEqual(['1', ...Array<string>(99).fill('0')])
    expect(local.holders.every(holder => JSON.stringify(holder.fundWeight) === JSON.stringify({ numerator: '1', denominator: '100' }))).toBe(true)
    expect(local.holders.reduce((sum, holder) => sum + BigInt(holder.incomeAmount), 0n)).toBe(TOTAL)
    expect(value.allocations[1]).toMatchObject({ incomeAmount: '0', holders: [] })
  })

  it('lists a positive INCOME allocation for an entitled holder whose integer FUND projection is zero', () => {
    const value = buildFundGlobalManifest(fractionalSnapshot(), options)
    expect(holder(value, 1, bob)).toMatchObject({ beneficiary: bob, fundBalance: '0', incomeAmount: (TOTAL / 100n).toString(), fundWeight: { numerator: '1', denominator: '100' } })
  })

  it('preserves nested custody precision beyond uint256 without rounding FUND before INCOME', () => {
    const nestedDenominator = ((1n << 160n) - 7n) * ((1n << 160n) - 47n)
    const rows = [weightedRow(alice, fraction(1n, 5n), 1n), weightedRow(bob, fraction(2n * (nestedDenominator - 1n), 5n * nestedDenominator), 0n), weightedRow(addr(3), fraction(2n * (nestedDenominator + 1n), 5n * nestedDenominator), 0n)]
    const value = buildFundGlobalManifest(snapshot(rows), options), holders = value.allocations[0].holders
    expect(rows[1].fundWeight.denominator).toBeGreaterThan(1n << 256n)
    expect(holders.map(holder => BigInt(holder.incomeAmount))).toEqual([TOTAL / 5n + 1n, TOTAL * 2n / 5n - 1n, TOTAL * 2n / 5n])
    expect(holders.reduce((sum, holder) => sum + BigInt(holder.incomeAmount), 0n)).toBe(TOTAL)
    expect(holders[1].fundWeight).toEqual({ numerator: rows[1].fundWeight.numerator.toString(), denominator: rows[1].fundWeight.denominator.toString() })
    expect(parseFundGlobalManifest(JSON.parse(serializeFundGlobalManifest(value)))).toEqual(value)
  })

  it('reconciles exact live weights with integer pending bridge entitlements and raw FUND projections', () => {
    const rows = [weightedRow(alice, fraction(1n, 3n), 1n, 3n, 10), weightedRow(bob, fraction(2n, 3n), 0n, 0n, 10)]
    const source = snapshot(rows), value = buildFundGlobalManifest(source, options), holders = value.allocations[1].holders
    expect(source.totals).toEqual({ liveFundSupply: 1n, pendingFundSupply: 3n, globalFundSupply: 4n })
    expect(holders.reduce((sum, holder) => sum + BigInt(holder.liveFundBalance), 0n)).toBe(1n)
    expect(holders.reduce((sum, holder) => sum + BigInt(holder.pendingFundBalance), 0n)).toBe(3n)
    expect(holders.reduce((sum, holder) => sum + BigInt(holder.fundBalance), 0n)).toBe(4n)
    expect(holders.map(holder => BigInt(holder.incomeAmount))).toEqual([TOTAL - TOTAL / 6n, TOTAL / 6n])
    expect(holders.map(holder => holder.fundWeight)).toEqual([{ numerator: '10', denominator: '3' }, { numerator: '2', denominator: '3' }])
  })

  it('replays serialized fractional history without changing the manifest hash or allocations', async () => {
    const source = fractionalSnapshot(), value = buildFundGlobalManifest(source, options), serialized = serializeFundGlobalManifest(value)
    const restored = parseFundGlobalManifest(JSON.parse(serialized))
    expect(serializeFundGlobalManifest(restored)).toBe(serialized)
    expect(fundGlobalManifestHash(restored)).toBe(fundGlobalManifestHash(value))
    vi.mocked(readFundGlobalSnapshot).mockResolvedValue(source)
    expect(await verifyFundGlobalManifestHistory(new Map(), restored)).toEqual(value)
    expect(restored.allocations[0].holders).toEqual(value.allocations[0].holders)
  })

  it.each([
    ['zero numerator', (holder: WeightedEntitlement) => { holder.fundWeight = { numerator: 0n, denominator: 1n } }],
    ['zero denominator', (holder: WeightedEntitlement) => { holder.liveFundWeight.denominator = 0n }],
    ['negative numerator', (holder: WeightedEntitlement) => { holder.fundWeight.numerator = -1n }],
    ['negative denominator', (holder: WeightedEntitlement) => { holder.fundWeight.denominator = -100n }],
    ['unreduced ratio', (holder: WeightedEntitlement) => { holder.fundWeight = { numerator: 2n, denominator: 200n } }],
    ['inconsistent decomposition', (holder: WeightedEntitlement) => { holder.fundWeight = { numerator: 1n, denominator: 50n } }],
    ['missing denominator', (holder: WeightedEntitlement) => { holder.fundWeight = { numerator: 1n } as Fraction }],
    ['noncanonical integer', (holder: WeightedEntitlement) => { holder.fundWeight = { numerator: '01', denominator: '100' } as unknown as Fraction }],
  ] as const)('rejects invalid rational ownership: %s', (_label, change) => {
    const source = fractionalSnapshot()
    change(source.entitlements[0] as WeightedEntitlement)
    expect(() => buildFundGlobalManifest(source, options)).toThrow()
  })

  it('rejects exact global weights that do not reconcile even when integer display totals do', () => {
    const source = fractionalSnapshot(), holder = source.entitlements[0] as WeightedEntitlement
    holder.liveFundWeight = { numerator: 1n, denominator: 50n }; holder.fundWeight = { ...holder.liveFundWeight }
    expect(source.entitlements.reduce((sum, entry) => sum + entry.fundBalance, 0n)).toBe(1n)
    expect(() => buildFundGlobalManifest(source, options)).toThrow('global supplies')
  })

  it('rejects weights moved across claim chains even when the global rational total is conserved', () => {
    const source = snapshot([weightedRow(alice, fraction(1n, 3n), 1n, 0n, 1), weightedRow(bob, fraction(2n, 3n), 0n, 0n, 10)])
    expect(source.totals.globalFundSupply).toBe(1n)
    expect(() => buildFundGlobalManifest(source, options)).toThrow('claim chain')
  })

  it('rejects a changed raw projection total and a noncanonical redistribution of projection remainder', () => {
    const inflated = fractionalSnapshot(); inflated.entitlements[1].liveFundBalance = 1n; inflated.entitlements[1].fundBalance = 1n
    expect(() => buildFundGlobalManifest(inflated, options)).toThrow()
    const shifted = fractionalSnapshot(); shifted.entitlements[0].liveFundBalance = 0n; shifted.entitlements[0].fundBalance = 0n; shifted.entitlements[1].liveFundBalance = 1n; shifted.entitlements[1].fundBalance = 1n
    expect(() => buildFundGlobalManifest(shifted, options)).toThrow()
  })

  it('rejects edited fractional metadata even when its integer FUND projection is unchanged', () => {
    const value = asMutableJson(buildFundGlobalManifest(fractionalSnapshot(), options))
    value.allocations[0].holders[1].fundWeight = { numerator: '1', denominator: '99' }
    expect(() => parseFundGlobalManifest(value)).toThrow()
  })

  it('keeps ordinary integer holder manifests free of redundant rational fields', () => {
    expect(manifest().allocations.flatMap(local => local.holders).every(holder => !('fundWeight' in holder))).toBe(true)
  })
})

describe('canonical commitments', () => {
  it('normalizes bigint and hexadecimal case while sorting serialized keys by ASCII, including integer-like keys', () => {
    const value = { z: undefined, a: { '2': 2n, '10': 10n }, Z: '0xABCD', A: [false, null, 'ordinary Text'] }
    expect(canonicalSnapshotJson(value)).toEqual({ A: [false, null, 'ordinary Text'], Z: '0xabcd', a: { '10': '10', '2': '2' } })
    const expected = '{\n  "A": [\n    false,\n    null,\n    "ordinary Text"\n  ],\n  "Z": "0xabcd",\n  "a": {\n    "10": "10",\n    "2": "2"\n  }\n}\n'
    expect(fundGlobalSourceSetHash(value)).toBe(keccak256(stringToHex(expected)))
  })

  it('round-trips normalized manifest bytes and canonicalizes equivalent address/hash casing', () => {
    const value = manifest()
    const parsed = JSON.parse(serializeFundGlobalManifest(value))
    parsed.helper = value.helper.toLowerCase()
    parsed.launchSalt = `0x${value.launchSalt.slice(2).toUpperCase()}`
    expect(parseFundGlobalManifest(parsed)).toEqual(value)
    expect(serializeFundGlobalManifest(parseFundGlobalManifest(parsed))).toBe(serializeFundGlobalManifest(value))
    expect(fundGlobalManifestHash(parsed)).toBe(fundGlobalManifestHash(value))
  })

  it('commits source provenance even when a changed timestamp would leave proportional amounts unchanged', () => {
    const first = snapshot(), changed = snapshot()
    changed.graph.cuts = changed.graph.cuts.map((cut, index) => ({ ...cut, blockTimestamp: cut.blockTimestamp + BigInt(index + 1) }))
    const a = buildFundGlobalManifest(first, options), b = buildFundGlobalManifest(changed, options)
    expect(a.allocations.map(local => local.incomeAmount)).toEqual(b.allocations.map(local => local.incomeAmount))
    expect(a.sourceSetHash).not.toBe(b.sourceSetHash)
    expect(fundGlobalManifestHash(a)).not.toBe(fundGlobalManifestHash(b))
  })

  it.each([NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1])('rejects unsafe JSON numeric values: %s', value => {
    expect(() => canonicalSnapshotJson({ amount: value })).toThrow('safe integers')
  })

  it('rejects excessive nesting instead of risking a recursive parsing failure', () => {
    let value: unknown = null
    for (let depth = 0; depth < 66; depth++) value = { value }
    expect(() => canonicalSnapshotJson(value)).toThrow('nested too deeply')
  })

  it('exports local allocations without multiplying the initial supply by the number of chains', () => {
    const value = manifest()
    const parameters = globalIncomeSnapshotParameters(value, ipfs)
    expect(parameters.sourceSetHash).toBe(value.sourceSetHash)
    expect(parameters.totalFundSupply).toBe(100n)
    expect(parameters.manifestHash).toBe(fundGlobalManifestHash(value))
    expect(parameters.allocations.reduce((sum, local) => sum + local.incomeAmount, 0n)).toBe(TOTAL)
    expect(parameters.allocations.map(local => local.fundProjectId)).toEqual([7n, 99n])
    expect(Object.keys(parameters.allocations[0]).sort()).toEqual(['chainId', 'fundProjectId', 'incomeAmount', 'snapshotBlockHash', 'snapshotBlockNumber'])
    expect(() => globalIncomeSnapshotParameters(value, 'https://untrusted.example/manifest')).toThrow('IPFS')
  })
})

describe('fail-closed global manifest validation', () => {
  it.each([
    ['schema', (value: FundGlobalManifest) => { (value as unknown as Record<string, unknown>).schema = 'homerun.initial-income.global-snapshot.v2' }],
    ['chain', (value: FundGlobalManifest) => { value.allocations[0].chainId = 8453 }],
    ['local cap', (value: FundGlobalManifest) => { value.allocations[0].incomeAmount = TOTAL.toString() }],
    ['holder amount', (value: FundGlobalManifest) => { value.allocations[0].holders[0].incomeAmount = '1' }],
    ['holder beneficiary', (value: FundGlobalManifest) => { value.allocations[0].holders[0].beneficiary = bob }],
    ['source commitment', (value: FundGlobalManifest) => { value.sourceSetHash = hash(3) }],
    ['source evidence', (value: FundGlobalManifest) => { (value.snapshot as Record<string, unknown>).bridges = [{ fabricated: true }] }],
    ['global cap', (value: FundGlobalManifest) => { value.totalIncomeAmount = (TOTAL * 2n).toString() }],
    ['foreign field', (value: FundGlobalManifest) => { (value as unknown as Record<string, unknown>).admin = bob }],
    ['missing chain', (value: FundGlobalManifest) => { value.allocations.pop() }],
  ] as const)('rejects altered %s without silently rebuilding a new allocation', (_label, change) => {
    const value = asMutableJson(manifest())
    change(value)
    expect(() => parseFundGlobalManifest(value)).toThrow()
  })

  it.each([
    ['duplicate holder', (value: FundGlobalSnapshot) => { value.entitlements.push(value.entitlements[0]) }],
    ['foreign holder chain', (value: FundGlobalSnapshot) => { value.entitlements[0].claimChainId = 8453 }],
    ['holder decomposition', (value: FundGlobalSnapshot) => { value.entitlements[0].pendingFundBalance = 1n }],
    ['supply total', (value: FundGlobalSnapshot) => { value.totals.globalFundSupply = 101n }],
    ['negative balance', (value: FundGlobalSnapshot) => { value.entitlements[0].liveFundBalance = -1n }],
    ['empty holders', (value: FundGlobalSnapshot) => { value.entitlements = [] }],
    ['duplicate cut', (value: FundGlobalSnapshot) => { value.graph.cuts = [value.graph.cuts[0], value.graph.cuts[0]] }],
    ['missing cut', (value: FundGlobalSnapshot) => { value.graph.cuts = value.graph.cuts.slice(1) }],
    ['zero cut hash', (value: FundGlobalSnapshot) => { value.graph.cuts = value.graph.cuts.map(cut => ({ ...cut, blockHash: zeroHash })) }],
    ['foreign root', (value: FundGlobalSnapshot) => { value.root.projectId = 800n }],
    ['duplicate chain project', (value: FundGlobalSnapshot) => { value.graph.projects = [value.graph.projects[0], value.graph.projects[0]] }],
    ['uint256 overflow', (value: FundGlobalSnapshot) => { value.entitlements[0].fundBalance = 1n << 256n }],
  ] as const)('rejects malformed source description: %s', (_label, change) => {
    const value = snapshot()
    change(value)
    expect(() => buildFundGlobalManifest(value, options)).toThrow()
  })
})

describe('independent historical reconstruction', () => {
  it('re-reads every fixed source cut and actual remote project ID before accepting the manifest', async () => {
    const source = snapshot(), value = buildFundGlobalManifest(source, options)
    const clients = new Map<number, PublicClient>([[1, {} as PublicClient], [10, {} as PublicClient]])
    const controller = new AbortController(), progress = vi.fn()
    vi.mocked(readFundGlobalSnapshot).mockResolvedValue(source)
    expect(await verifyFundGlobalManifestHistory(clients, value, { signal: controller.signal, onProgress: progress })).toEqual(value)
    expect(readFundGlobalSnapshot).toHaveBeenCalledWith(expect.objectContaining({ clients, root: { chainId: 1, projectId: 7n }, cuts: new Map([[1, { blockNumber: 100n, blockHash: hash(100) }], [10, { blockNumber: 200n, blockHash: hash(200) }]]), creationBlocks: new Map([['1:7', 1n], ['10:99', 1n]]), signal: controller.signal, onProgress: progress }))
  })

  it('rejects changed ownership even when the reported global denominator stays equal', async () => {
    const value = manifest(), changed = snapshot([row(1, alice, 40n), row(10, alice, 35n, 25n)])
    vi.mocked(readFundGlobalSnapshot).mockResolvedValue(changed)
    await expect(verifyFundGlobalManifestHistory(new Map(), value)).rejects.toThrow('independently reconstructed global FUND history')
  })

  it('rejects altered source provenance despite unchanged beneficiaries and allocations', async () => {
    const value = manifest(), changed = snapshot()
    changed.projects[0].creationTransactionHash = hash(999)
    vi.mocked(readFundGlobalSnapshot).mockResolvedValue(changed)
    await expect(verifyFundGlobalManifestHistory(new Map(), value)).rejects.toThrow('independently reconstructed global FUND history')
  })

  it('propagates missing-history, reorg, and causal-cut failures without returning a partial allocation', async () => {
    vi.mocked(readFundGlobalSnapshot).mockRejectedValue(new Error('A finalized source block changed'))
    await expect(verifyFundGlobalManifestHistory(new Map(), manifest())).rejects.toThrow('finalized source block changed')
    expect(readFundGlobalSnapshot).toHaveBeenCalledTimes(1)
  })
})
