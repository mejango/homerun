import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getAddress, zeroAddress, type Hex, type PublicClient } from 'viem'
import { v6Address } from '@bananapus/nana-sdk-core/v6'
import { readFundGlobalSnapshot, allocateFundGlobalInitialIncome } from '../src/lib/fund-global-snapshot'
import { readFundGlobalSnapshotGraph, type FundGlobalSnapshotGraph } from '../src/lib/fund-global-snapshot-graph'
import { readFundGlobalSnapshotBridgeLane } from '../src/lib/fund-global-snapshot-bridges'
import { readFundOwnershipForGlobalSnapshot, type FundOwnershipForGlobalSnapshot } from '../src/lib/fund-snapshot'

vi.mock('../src/lib/fund-global-snapshot-graph', () => ({ readFundGlobalSnapshotGraph: vi.fn() }))
vi.mock('../src/lib/fund-global-snapshot-bridges', () => ({ readFundGlobalSnapshotBridgeLane: vi.fn() }))
vi.mock('../src/lib/fund-snapshot', () => ({ readFundOwnershipForGlobalSnapshot: vi.fn() }))

const addr = (n: number) => getAddress(`0x${n.toString(16).padStart(40, '0')}`)
const alice = addr(1), owner = addr(2), sourceSucker = addr(3), destinationSucker = addr(4)
const hash1 = `0x${'11'.repeat(32)}` as Hex, hash10 = `0x${'22'.repeat(32)}` as Hex
const TOTAL = 500_000n * 10n ** 18n
type Bridge = Awaited<ReturnType<typeof readFundGlobalSnapshotBridgeLane>>
let graph: FundGlobalSnapshotGraph
let locals: FundOwnershipForGlobalSnapshot[]
let lane: Bridge
let clients: Map<number, PublicClient>

function local(chainId: 1 | 10, projectId: bigint, amount: bigint): FundOwnershipForGlobalSnapshot {
  return {
    chainId, projectId, blockNumber: chainId === 1 ? 100n : 200n, blockHash: chainId === 1 ? hash1 : hash10,
    creationBlockNumber: 50n, owner, totalFundSupply: amount,
    holders: amount === 0n ? [] : [{ holder: alice, balance: amount, creditBalance: amount, erc20Balance: 0n }],
    historicalSuckers: [chainId === 1 ? sourceSucker : destinationSucker],
    evidence: { controller: v6Address('JBController', chainId), bridgePolicy: 'historical-graph-required' },
  } as FundOwnershipForGlobalSnapshot
}

function input() { return { root: { chainId: 1, projectId: 7n }, clients } }

beforeEach(() => {
  graph = {
    cuts: [{ chainId: 1, blockNumber: 100n, blockHash: hash1, blockTimestamp: 1000n }, { chainId: 10, blockNumber: 200n, blockHash: hash10, blockTimestamp: 1001n }],
    projects: [
      { chainId: 1, projectId: 7n, owner, controller: v6Address('JBController', 1), historicalSuckers: [sourceSucker] },
      { chainId: 10, projectId: 99n, owner, controller: v6Address('JBController', 10), historicalSuckers: [destinationSucker] },
    ],
    lanes: [{ sourceChainId: 1, sourceProjectId: 7n, sourceSucker, destinationChainId: 10, destinationProjectId: 99n, destinationSucker }],
  }
  locals = [local(1, 7n, 50n), local(10, 99n, 25n)]
  lane = {
    ...graph.lanes[0], sourceBlockNumber: 100n, sourceBlockHash: hash1, destinationBlockNumber: 200n, destinationBlockHash: hash10,
    entitlements: [{ chainId: 10, projectId: 99n, beneficiary: alice, balance: 25n }], trees: [],
    totals: { preparedFund: 40n, claimedFund: 10n, emergencyExitedFund: 5n, pendingFund: 25n },
    evidence: { sourceCreationBlockNumber: 50n, destinationCreationBlockNumber: 50n, eventCounts: {}, rpcCompleteHistoryAttestation: true, historyPolicy: 'canonical-rpc-history-with-pinned-tree-and-settlement-checks', emergencyExitPolicy: 'aggregate-by-source-token-and-low-20-byte-beneficiary' },
  }
  clients = new Map(graph.cuts.map(cut => [cut.chainId, {
    getChainId: vi.fn(async () => cut.chainId),
    getBlock: vi.fn(async () => ({ number: cut.blockNumber, hash: cut.blockHash })),
  } as unknown as PublicClient]))
  vi.mocked(readFundGlobalSnapshotGraph).mockReset().mockImplementation(async () => graph)
  vi.mocked(readFundOwnershipForGlobalSnapshot).mockReset().mockImplementation(async (_client, value) => {
    const result = locals.find(project => project.chainId === value.chainId && project.projectId === value.projectId)
    if (!result) throw new Error('Missing local fixture')
    return result
  })
  vi.mocked(readFundGlobalSnapshotBridgeLane).mockReset().mockImplementation(async () => lane)
})

describe('global FUND entitlement conservation', () => {
  it('uses real remote project IDs and adds only unsettled bridge FUND to live balances', async () => {
    const result = await readFundGlobalSnapshot(input())
    expect(result.totals).toEqual({ liveFundSupply: 75n, pendingFundSupply: 25n, globalFundSupply: 100n })
    expect(result.entitlements.map(row => [row.claimChainId, row.beneficiary, row.liveFundBalance, row.pendingFundBalance])).toEqual([[1, alice, 50n, 0n], [10, alice, 25n, 25n]])
    expect(vi.mocked(readFundOwnershipForGlobalSnapshot).mock.calls.map(([, value]) => [value.chainId, value.projectId, value.snapshotBlockNumber])).toEqual([[1, 7n, 100n], [10, 99n, 200n]])
    expect(vi.mocked(readFundGlobalSnapshotBridgeLane).mock.calls[0][0]).toMatchObject({ sourceProjectId: 7n, destinationProjectId: 99n, sourceBlockNumber: 100n, destinationBlockNumber: 200n })
    expect(result.historyAttestation).toBe('complete-canonical-rpc-log-history-required')
  })

  it('preserves identical smart-wallet addresses as two distinct claim-chain identities', async () => {
    const result = allocateFundGlobalInitialIncome(await readFundGlobalSnapshot(input()))
    expect(result.allocations.map(row => [row.claimChainId, row.beneficiary, row.incomeAmount])).toEqual([[1, alice, TOTAL / 2n], [10, alice, TOTAL / 2n]])
    expect(result.chains).toEqual([{ chainId: 1, incomeAmount: TOTAL / 2n }, { chainId: 10, incomeAmount: TOTAL / 2n }])
    expect(result.totalIncomeAmount).toBe(TOTAL)
  })

  it('includes FUND whose entire supply is currently burned and awaiting destination claims', async () => {
    locals = [local(1, 7n, 0n), local(10, 99n, 0n)]
    lane.totals = { preparedFund: 100n, claimedFund: 0n, emergencyExitedFund: 0n, pendingFund: 100n }
    lane.entitlements[0].balance = 100n
    const result = await readFundGlobalSnapshot(input())
    expect(result.totals).toEqual({ liveFundSupply: 0n, pendingFundSupply: 100n, globalFundSupply: 100n })
    expect(allocateFundGlobalInitialIncome(result).chains).toEqual([{ chainId: 1, incomeAmount: 0n }, { chainId: 10, incomeAmount: TOTAL }])
  })

  it('does not add already claimed or source-emergency-restored tokens for a second time', async () => {
    lane.totals = { preparedFund: 40n, claimedFund: 35n, emergencyExitedFund: 5n, pendingFund: 0n }
    lane.entitlements = []
    const result = await readFundGlobalSnapshot(input())
    expect(result.totals.globalFundSupply).toBe(75n)
    expect(result.entitlements.every(row => row.pendingFundBalance === 0n)).toBe(true)
  })

  it('retains zero-address rights in the denominator without creating a claim', async () => {
    locals[0].holders[0].holder = zeroAddress
    const result = allocateFundGlobalInitialIncome(await readFundGlobalSnapshot(input()))
    expect(result.allocations[0]).toMatchObject({ beneficiary: zeroAddress, fundBalance: 50n, incomeAmount: TOTAL / 2n, claimable: false })
    expect(result.allocations.reduce((sum, row) => sum + row.incomeAmount, 0n)).toBe(TOTAL)
  })

  it.each([
    () => { locals[0].blockHash = hash10 }, () => { locals[0].owner = alice },
    () => { locals[0].historicalSuckers = [] }, () => { locals[0].totalFundSupply = 51n },
    () => { lane.destinationProjectId = 100n }, () => { lane.entitlements[0].chainId = 1 },
    () => { lane.totals.claimedFund = 11n }, () => { lane.entitlements[0].balance = -1n },
    () => { lane.sourceBlockHash = hash10 }, () => { lane.destinationBlockNumber = 201n },
    () => { lane.evidence.rpcCompleteHistoryAttestation = false as true },
  ])('rejects inconsistent graph, holder, or bridge evidence %#', async change => {
    change()
    await expect(readFundGlobalSnapshot(input())).rejects.toThrow()
  })

  it('reports an unready causal cut without automatically waiting or inventing missing bridge ownership', async () => {
    vi.mocked(readFundGlobalSnapshotBridgeLane).mockRejectedValue(new Error('Destination inbox root is outside the finalized source prefix'))
    await expect(readFundGlobalSnapshot(input())).rejects.toThrow('finalized source prefix')
    expect(readFundGlobalSnapshotBridgeLane).toHaveBeenCalledOnce()
  })

  it('refuses a changed finalized source block after all ownership reads', async () => {
    vi.mocked(clients.get(1)!.getBlock).mockResolvedValue({ number: 100n, hash: hash10 } as never)
    await expect(readFundGlobalSnapshot(input())).rejects.toThrow('finalized source block changed')
  })

  it('requires clients for every discovered chain and never invents a remote endpoint', async () => {
    clients.delete(10)
    await expect(readFundGlobalSnapshot(input())).rejects.toThrow('client and cut')
  })

  it('cancels without a partial ownership result', async () => {
    const controller = new AbortController(); controller.abort()
    await expect(readFundGlobalSnapshot({ ...input(), signal: controller.signal })).rejects.toThrow('cancelled')
    expect(readFundGlobalSnapshotGraph).not.toHaveBeenCalled()
  })

  it('rejects duplicate chain-bound rows and allocates deterministic rounding dust only once globally', async () => {
    const result = await readFundGlobalSnapshot(input())
    result.entitlements[0].liveFundBalance = 1n; result.entitlements[0].fundBalance = 1n
    result.entitlements[1].liveFundBalance = 1n; result.entitlements[1].pendingFundBalance = 0n; result.entitlements[1].fundBalance = 1n
    result.entitlements.push({ ...result.entitlements[1], beneficiary: addr(9) })
    for (const row of result.entitlements) { delete row.fundWeight; delete row.liveFundWeight }
    result.totals = { liveFundSupply: 3n, pendingFundSupply: 0n, globalFundSupply: 3n }
    const allocation = allocateFundGlobalInitialIncome(result)
    expect(allocation.allocations.map(row => row.incomeAmount)).toEqual([TOTAL / 3n + 2n, TOTAL / 3n, TOTAL / 3n])
    result.entitlements[2].beneficiary = alice
    expect(() => allocateFundGlobalInitialIncome(result)).toThrow('duplicate')
  })

  it('rejects allocation chains absent from the historical graph and inconsistent supply subtotals', async () => {
    const result = await readFundGlobalSnapshot(input())
    result.totals.liveFundSupply += 1n
    expect(() => allocateFundGlobalInitialIncome(result)).toThrow('components')
    result.totals.liveFundSupply -= 1n
    result.entitlements[0].claimChainId = 8453
    expect(() => allocateFundGlobalInitialIncome(result)).toThrow('chain-bound')
  })

  it('uses exact custody weights for INCOME even when most holders project to zero FUND atoms', async () => {
    locals = [local(1, 7n, 1n), local(10, 99n, 0n)]
    locals[0].beneficialHolders = Array.from({ length: 100 }, (_, index) => ({ holder: addr(index + 1000), balance: index === 0 ? 1n : 0n, weight: { numerator: 1n, denominator: 100n } }))
    lane.entitlements = []; lane.totals = { preparedFund: 0n, claimedFund: 0n, emergencyExitedFund: 0n, pendingFund: 0n }
    const result = await readFundGlobalSnapshot(input())
    expect(result.entitlements).toHaveLength(100)
    expect(result.entitlements.filter(row => row.fundBalance === 0n)).toHaveLength(99)
    const allocation = allocateFundGlobalInitialIncome(result)
    expect(allocation.allocations.every(row => row.incomeAmount === TOTAL / 100n && row.claimable)).toBe(true)
  })
})
