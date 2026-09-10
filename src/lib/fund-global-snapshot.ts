/**
 * Read-only global FUND entitlement reconstruction. This does not enable an
 * INCOME deployment and must not be passed to the single-chain claim manifest.
 */
import { getAddress, isAddressEqual, zeroAddress, type Address, type PublicClient } from 'viem'
import type { JBChainId } from '@bananapus/nana-sdk-core'
import { INITIAL_INCOME_SUPPLY } from './income-contracts'
import { readFundOwnershipForGlobalSnapshot, type FundOwnershipForGlobalSnapshot } from './fund-snapshot'
import { readFundGlobalSnapshotGraph, type FundGlobalSnapshotGraph } from './fund-global-snapshot-graph'
import { readFundGlobalSnapshotBridgeLane } from './fund-global-snapshot-bridges'
import { ownershipWeight, addOwnershipWeights, sumOwnershipWeights, type FundOwnershipWeight } from './fund-ownership-weight'

type GraphInput = Parameters<typeof readFundGlobalSnapshotGraph>[0]
type BridgeSnapshot = Awaited<ReturnType<typeof readFundGlobalSnapshotBridgeLane>>

export type FundGlobalEntitlementSource = {
  kind: 'live-balance' | 'pending-bridge'
  chainId: JBChainId
  projectId: bigint
  amount: bigint
  weight?: FundOwnershipWeight
  /** Present only for an outgoing bridge entitlement. */
  sourceSucker?: Address
}

export type FundGlobalEntitlement = {
  /** Contract-wallet identities remain on their original or intended destination chain. */
  claimChainId: JBChainId
  beneficiary: Address
  liveFundBalance: bigint
  pendingFundBalance: bigint
  fundBalance: bigint
  /** Exact backing ratios are used for INCOME; integer balances remain conserved display projections. */
  liveFundWeight?: FundOwnershipWeight
  fundWeight?: FundOwnershipWeight
  sources: FundGlobalEntitlementSource[]
}

export type FundGlobalSnapshot = {
  kind: 'homerun-global-fund-entitlements'
  version: 1
  root: { chainId: number; projectId: bigint }
  claimPolicy: 'live-chain-and-pending-bridge-destination'
  /** Outbox roots authenticate discovered trees, not the absence of an omitted entire token tree. */
  historyAttestation: 'complete-canonical-rpc-log-history-required'
  graph: FundGlobalSnapshotGraph
  projects: FundOwnershipForGlobalSnapshot[]
  bridges: BridgeSnapshot[]
  entitlements: FundGlobalEntitlement[]
  totals: { liveFundSupply: bigint; pendingFundSupply: bigint; globalFundSupply: bigint }
}

export type FundGlobalSnapshotInput = GraphInput & {
  /** Keys are `${chainId}:${projectId}`; every hint needs an exact canonical Create event. */
  creationBlocks?: ReadonlyMap<string, bigint>
  logBlockWindow?: bigint
  logResponseLimit?: number
  onProgress?: (progress: { stage: 'graph' | 'holders' | 'bridges' | 'complete'; completed: number; total: number }) => void
}

function projectKey(chainId: number, projectId: bigint): string { return `${chainId}:${projectId}` }
function sameSet(left: readonly Address[], right: readonly Address[]): boolean {
  const values = new Set(left.map(value => value.toLowerCase()))
  return values.size === left.length && left.length === right.length && right.every(value => values.has(value.toLowerCase()))
}
function cancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('The global FUND snapshot was cancelled.')
}

async function inBatches<T, R>(values: readonly T[], run: (value: T, index: number) => Promise<R>, signal?: AbortSignal): Promise<R[]> {
  const results: R[] = []
  for (let offset = 0; offset < values.length; offset += 2) {
    cancelled(signal)
    const batch = await Promise.allSettled(values.slice(offset, offset + 2).map((value, index) => run(value, offset + index)))
    for (const result of batch) {
      if (result.status === 'rejected') throw result.reason
      results.push(result.value)
    }
  }
  return results
}

/**
 * Finalized causal cuts fail with a concrete error when the source prefix does
 * not yet contain an included destination claim/root. No waiting, guessed
 * remote supplies, automatic execution or silent partial graph is permitted.
 */
export async function readFundGlobalSnapshot(input: FundGlobalSnapshotInput): Promise<FundGlobalSnapshot> {
  cancelled(input.signal)
  input.onProgress?.({ stage: 'graph', completed: 0, total: 1 })
  const graph = await readFundGlobalSnapshotGraph(input)
  const cuts = new Map(graph.cuts.map(cut => [cut.chainId as number, cut]))
  const localByKey = new Map<string, FundOwnershipForGlobalSnapshot>()
  input.onProgress?.({ stage: 'graph', completed: 1, total: 1 })
  const projects = await inBatches(graph.projects, async (project, index) => {
    const client = input.clients.get(project.chainId)
    const cut = cuts.get(project.chainId)
    if (!client || !cut) throw new Error('The complete finalized project graph requires a client and cut for every chain.')
    const local = await readFundOwnershipForGlobalSnapshot(client, {
      chainId: project.chainId, projectId: project.projectId, snapshotBlockNumber: cut.blockNumber,
      creationBlockNumber: input.creationBlocks?.get(projectKey(project.chainId, project.projectId)),
      logBlockWindow: input.logBlockWindow, logResponseLimit: input.logResponseLimit, signal: input.signal,
    })
    if (local.chainId !== project.chainId || local.projectId !== project.projectId || local.blockNumber !== cut.blockNumber || local.blockHash.toLowerCase() !== cut.blockHash.toLowerCase() || !isAddressEqual(local.owner, project.owner) || !isAddressEqual(local.evidence.controller, project.controller) || !sameSet(local.historicalSuckers, project.historicalSuckers)) throw new Error('A local FUND ownership snapshot differs from its verified historical graph.')
    if (local.evidence.bridgePolicy !== 'historical-graph-required') throw new Error('Global FUND components must explicitly require historical bridge reconciliation.')
    localByKey.set(projectKey(project.chainId, project.projectId), local)
    input.onProgress?.({ stage: 'holders', completed: index + 1, total: graph.projects.length })
    return local
  }, input.signal)

  const bridges = await inBatches(graph.lanes, async (lane, index) => {
    const source = localByKey.get(projectKey(lane.sourceChainId, lane.sourceProjectId))
    const destination = localByKey.get(projectKey(lane.destinationChainId, lane.destinationProjectId))
    const sourceClient = input.clients.get(lane.sourceChainId)
    const destinationClient = input.clients.get(lane.destinationChainId)
    if (!source || !destination || !sourceClient || !destinationClient) throw new Error('A historical bridge endpoint is missing from the complete ownership snapshot.')
    const bridge = await readFundGlobalSnapshotBridgeLane({
      sourceClient, destinationClient,
      sourceChainId: lane.sourceChainId, destinationChainId: lane.destinationChainId,
      sourceProjectId: lane.sourceProjectId, destinationProjectId: lane.destinationProjectId,
      sourceSucker: lane.sourceSucker, destinationSucker: lane.destinationSucker,
      sourceBlockNumber: source.blockNumber, sourceBlockHash: source.blockHash,
      destinationBlockNumber: destination.blockNumber, destinationBlockHash: destination.blockHash,
      sourceCreationBlockNumber: source.creationBlockNumber, destinationCreationBlockNumber: destination.creationBlockNumber,
      logBlockWindow: input.logBlockWindow, logResponseLimit: input.logResponseLimit, signal: input.signal,
    })
    if (bridge.sourceChainId !== lane.sourceChainId || bridge.destinationChainId !== lane.destinationChainId || bridge.sourceProjectId !== lane.sourceProjectId || bridge.destinationProjectId !== lane.destinationProjectId || !isAddressEqual(bridge.sourceSucker, lane.sourceSucker) || !isAddressEqual(bridge.destinationSucker, lane.destinationSucker)) throw new Error('Bridge entitlement evidence does not belong to the verified project graph.')
    if (bridge.sourceBlockNumber !== source.blockNumber || bridge.destinationBlockNumber !== destination.blockNumber || bridge.sourceBlockHash.toLowerCase() !== source.blockHash.toLowerCase() || bridge.destinationBlockHash.toLowerCase() !== destination.blockHash.toLowerCase()) throw new Error('Bridge entitlement evidence uses different blocks from its holder snapshots.')
    if (!bridge.evidence.rpcCompleteHistoryAttestation || bridge.evidence.historyPolicy !== 'canonical-rpc-history-with-pinned-tree-and-settlement-checks') throw new Error('Every global bridge requires complete canonical history and pinned settlement checks.')
    input.onProgress?.({ stage: 'bridges', completed: index + 1, total: graph.lanes.length })
    return bridge
  }, input.signal)

  const rows = new Map<string, FundGlobalEntitlement>()
  function add(chainId: JBChainId, beneficiary: Address, amount: bigint, source: FundGlobalEntitlementSource, exactWeight = ownershipWeight(amount)) {
    if (amount < 0n) throw new Error('A global FUND entitlement cannot be negative.')
    const weight = ownershipWeight(exactWeight.numerator, exactWeight.denominator)
    if (weight.numerator === 0n) { if (amount !== 0n) throw new Error('A positive FUND balance cannot have zero ownership weight.'); return }
    const normalized = getAddress(beneficiary)
    const key = `${chainId}:${normalized.toLowerCase()}`
    let row = rows.get(key)
    if (!row) {
      row = { claimChainId: chainId, beneficiary: normalized, liveFundBalance: 0n, pendingFundBalance: 0n, fundBalance: 0n, liveFundWeight: ownershipWeight(0n), fundWeight: ownershipWeight(0n), sources: [] }
      rows.set(key, row)
    }
    row.fundBalance += amount
    row.fundWeight = addOwnershipWeights(row.fundWeight!, weight)
    if (source.kind === 'live-balance') { row.liveFundBalance += amount; row.liveFundWeight = addOwnershipWeights(row.liveFundWeight!, weight) }
    else row.pendingFundBalance += amount
    row.sources.push({ ...source, weight })
  }
  let liveFundSupply = 0n
  let pendingFundSupply = 0n
  for (const project of projects) {
    if (project.holders.reduce((sum, holder) => sum + holder.balance, 0n) !== project.totalFundSupply) throw new Error('A local FUND supply does not reconcile with its complete holders.')
    liveFundSupply += project.totalFundSupply
    if (project.stickyCustody && !project.beneficialHolders) throw new Error('Canonical Sticky custody requires its complete beneficial ownership decomposition.')
    const beneficial = project.beneficialHolders ?? project.holders.map(holder => ({ holder: holder.holder, balance: holder.balance, weight: ownershipWeight(holder.balance) }))
    const beneficialWeight = sumOwnershipWeights(beneficial.map(holder => holder.weight))
    if (beneficial.reduce((sum, holder) => sum + holder.balance, 0n) !== project.totalFundSupply || beneficialWeight.numerator !== project.totalFundSupply * beneficialWeight.denominator) throw new Error('Resolved canonical Sticky ownership does not conserve FUND supply.')
    for (const holder of beneficial) add(project.chainId, holder.holder, holder.balance, { kind: 'live-balance', chainId: project.chainId, projectId: project.projectId, amount: holder.balance }, holder.weight)
  }
  for (const bridge of bridges) {
    const total = bridge.entitlements.reduce((sum, row) => sum + row.balance, 0n)
    if (total < 0n || total !== bridge.totals.pendingFund || bridge.totals.preparedFund - bridge.totals.claimedFund - bridge.totals.emergencyExitedFund !== total) throw new Error('Bridge settlements do not reconcile with pending FUND entitlements.')
    pendingFundSupply += total
    for (const row of bridge.entitlements) {
      if (row.chainId !== bridge.destinationChainId || row.projectId !== bridge.destinationProjectId) throw new Error('An unsettled bridge entitlement must stay on its intended destination chain.')
      add(row.chainId as JBChainId, row.beneficiary, row.balance, { kind: 'pending-bridge', chainId: bridge.sourceChainId as JBChainId, projectId: bridge.sourceProjectId, sourceSucker: bridge.sourceSucker, amount: row.balance })
    }
  }
  const globalFundSupply = liveFundSupply + pendingFundSupply
  const entitlements = [...rows.values()].sort((left, right) => left.claimChainId - right.claimChainId || (left.beneficiary.toLowerCase() < right.beneficiary.toLowerCase() ? -1 : left.beneficiary.toLowerCase() > right.beneficiary.toLowerCase() ? 1 : 0))
  if (globalFundSupply <= 0n || entitlements.reduce((sum, row) => sum + row.fundBalance, 0n) !== globalFundSupply) throw new Error('The complete global FUND entitlement denominator is empty or inconsistent.')
  const exactGlobal = sumOwnershipWeights(entitlements.map(row => row.fundWeight!))
  if (exactGlobal.numerator !== globalFundSupply * exactGlobal.denominator) throw new Error('Exact global FUND ownership weights do not conserve the supply.')
  cancelled(input.signal)
  await inBatches(graph.cuts, async cut => {
    const client: PublicClient | undefined = input.clients.get(cut.chainId)
    if (!client) throw new Error('A finalized source chain is no longer available.')
    const [chainId, block] = await Promise.all([client.getChainId(), client.getBlock({ blockNumber: cut.blockNumber })])
    if (chainId !== cut.chainId || block.number !== cut.blockNumber || !block.hash || block.hash.toLowerCase() !== cut.blockHash.toLowerCase()) throw new Error('A finalized source block changed during the global FUND snapshot. No allocation was generated.')
  }, input.signal)
  input.onProgress?.({ stage: 'complete', completed: entitlements.length, total: entitlements.length })
  return {
    kind: 'homerun-global-fund-entitlements', version: 1, root: { ...input.root },
    claimPolicy: 'live-chain-and-pending-bridge-destination', historyAttestation: 'complete-canonical-rpc-log-history-required',
    graph, projects, bridges, entitlements, totals: { liveFundSupply, pendingFundSupply, globalFundSupply },
  }
}

/** One global 500,000-token allocation; this does not create or fund any vault. */
export function allocateFundGlobalInitialIncome(snapshot: FundGlobalSnapshot): {
  totalIncomeAmount: bigint
  allocations: { claimChainId: JBChainId; beneficiary: Address; fundBalance: bigint; incomeAmount: bigint; claimable: boolean }[]
  chains: { chainId: JBChainId; incomeAmount: bigint }[]
} {
  if (snapshot.kind !== 'homerun-global-fund-entitlements' || snapshot.version !== 1 || snapshot.claimPolicy !== 'live-chain-and-pending-bridge-destination' || snapshot.historyAttestation !== 'complete-canonical-rpc-log-history-required') throw new Error('A verified global FUND entitlement snapshot is required.')
  const total = snapshot.totals.globalFundSupply
  if (total <= 0n || !snapshot.entitlements.length || snapshot.entitlements.reduce((sum, row) => sum + row.fundBalance, 0n) !== total) throw new Error('The global allocation does not cover its entire FUND denominator.')
  if (snapshot.totals.liveFundSupply < 0n || snapshot.totals.pendingFundSupply < 0n || snapshot.totals.liveFundSupply + snapshot.totals.pendingFundSupply !== total || snapshot.entitlements.reduce((sum, row) => sum + row.liveFundBalance, 0n) !== snapshot.totals.liveFundSupply || snapshot.entitlements.reduce((sum, row) => sum + row.pendingFundBalance, 0n) !== snapshot.totals.pendingFundSupply) throw new Error('The global allocation supply components are inconsistent.')
  // Keep zero-allocation chains in the deployment plan: a linked project may
  // currently have all of its tokens in transit or represented on another chain.
  const chainAmounts = new Map<JBChainId, bigint>()
  for (const cut of snapshot.graph.cuts) {
    if (!Number.isSafeInteger(cut.chainId) || cut.chainId <= 0 || chainAmounts.has(cut.chainId)) throw new Error('The global allocation has an invalid or duplicate source chain.')
    chainAmounts.set(cut.chainId, 0n)
  }
  const seen = new Set<string>()
  const rows = [...snapshot.entitlements].sort((left, right) => left.claimChainId - right.claimChainId || (left.beneficiary.toLowerCase() < right.beneficiary.toLowerCase() ? -1 : left.beneficiary.toLowerCase() > right.beneficiary.toLowerCase() ? 1 : 0))
  const allocations = rows.map(row => {
    const beneficiary = getAddress(row.beneficiary)
    const key = `${row.claimChainId}:${beneficiary}`
    const liveWeight = row.liveFundWeight ?? ownershipWeight(row.liveFundBalance)
    const weight = row.fundWeight ?? ownershipWeight(row.fundBalance)
    const expectedWeight = addOwnershipWeights(liveWeight, ownershipWeight(row.pendingFundBalance))
    if (!chainAmounts.has(row.claimChainId) || seen.has(key) || row.fundBalance < 0n || weight.numerator <= 0n || row.liveFundBalance < 0n || row.pendingFundBalance < 0n || row.liveFundBalance + row.pendingFundBalance !== row.fundBalance || weight.numerator * expectedWeight.denominator !== expectedWeight.numerator * weight.denominator) throw new Error('The global allocation contains a duplicate or invalid chain-bound holder.')
    seen.add(key)
    return { claimChainId: row.claimChainId, beneficiary, fundBalance: row.fundBalance, incomeAmount: INITIAL_INCOME_SUPPLY * weight.numerator / (total * weight.denominator), claimable: false }
  })
  const exactGlobal = sumOwnershipWeights(rows.map(row => row.fundWeight ?? ownershipWeight(row.fundBalance)))
  if (exactGlobal.numerator !== total * exactGlobal.denominator) throw new Error('The global allocation weights do not conserve their entire FUND denominator.')
  allocations[0].incomeAmount += INITIAL_INCOME_SUPPLY - allocations.reduce((sum, row) => sum + row.incomeAmount, 0n)
  for (const allocation of allocations) {
    allocation.claimable = !isAddressEqual(allocation.beneficiary, zeroAddress) && allocation.incomeAmount > 0n
    chainAmounts.set(allocation.claimChainId, (chainAmounts.get(allocation.claimChainId) ?? 0n) + allocation.incomeAmount)
  }
  const chains = [...chainAmounts].map(([chainId, incomeAmount]) => ({ chainId, incomeAmount })).sort((left, right) => left.chainId - right.chainId)
  if (chains.reduce((sum, row) => sum + row.incomeAmount, 0n) !== INITIAL_INCOME_SUPPLY) throw new Error('The chain allocations must total exactly 500,000 INCOME globally.')
  return { totalIncomeAmount: INITIAL_INCOME_SUPPLY, allocations, chains }
}
