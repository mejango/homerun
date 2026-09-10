/** Chain-preserving, operator-attested initial INCOME allocations. */
import type { JBChainId } from '@bananapus/nana-sdk-core'
import { encodeAbiParameters, getAddress, isAddress, isAddressEqual, keccak256, stringToHex, zeroAddress, zeroHash, type Address, type Hex, type PublicClient } from 'viem'
import { INITIAL_INCOME_SUPPLY } from './income-contracts'
import { readFundGlobalSnapshot, type FundGlobalSnapshot, type FundGlobalSnapshotInput } from './fund-global-snapshot'
import { buildFundMerkleTree, type FundSnapshotEntry } from './fund-snapshot-merkle'
import { ownershipWeight, addOwnershipWeights, sumOwnershipWeights } from './fund-ownership-weight'

export type SnapshotJson = null | boolean | number | string | SnapshotJson[] | { [key: string]: SnapshotJson }
export const FUND_GLOBAL_MANIFEST_SCHEMA = 'homerun.initial-income.global-snapshot.v2'
const TYPE_HASH = keccak256(stringToHex('HomerunInitialIncome(uint256 chainId,address deployer,uint256 fundProjectId,bytes32 sourceSetHash,uint256 totalFundSupply,bytes32 salt)'))
const UINT256_LIMIT = 1n << 256n

export type GlobalIncomeAllocation = {
  chainId: JBChainId
  fundProjectId: string
  snapshotBlockNumber: string
  snapshotBlockHash: Hex
  merkleRoot: Hex
  leafCount: string
  incomeAmount: string
  distributionId: Hex
  holders: { index: string; beneficiary: Address; fundBalance: string; liveFundBalance: string; pendingFundBalance: string; fundWeight?: { numerator: string; denominator: string }; incomeAmount: string; claimable: boolean; proof: Hex[] }[]
}
export type FundGlobalManifest = {
  schema: typeof FUND_GLOBAL_MANIFEST_SCHEMA
  attestation: 'operator-proposed-root; complete-canonical-rpc-history-required'
  allocationPolicy: 'global-floor-pro-rata; remainder-to-lowest-chain-and-address; preserve-claim-chain'
  helper: Address
  launchSalt: Hex
  sourceSetHash: Hex
  totalFundSupply: string
  totalIncomeAmount: string
  snapshot: SnapshotJson
  allocations: GlobalIncomeAllocation[]
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid ${label}.`)
  return value as Record<string, unknown>
}
function uint(value: unknown, label: string, positive = false): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)$/.test(value) || value.length > 78) throw new Error(`Invalid ${label}.`)
  const parsed = BigInt(value)
  if (parsed >= UINT256_LIMIT || (positive && parsed === 0n)) throw new Error(`Invalid ${label}.`)
  return parsed
}
function chain(value: unknown): JBChainId {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0 || value > 0xffff_ffff) throw new Error('Invalid allocation chain ID.')
  return value as JBChainId
}
function address(value: unknown, label: string, allowZero = false): Address {
  if (typeof value !== 'string' || !isAddress(value) || (!allowZero && isAddressEqual(value, zeroAddress))) throw new Error(`Invalid ${label} address.`)
  return getAddress(value)
}
function hash(value: unknown, label: string, allowZero = false): Hex {
  if (typeof value !== 'string' || !/^0x[\da-fA-F]{64}$/.test(value) || (!allowZero && value.toLowerCase() === zeroHash)) throw new Error(`Invalid ${label} hash.`)
  return value.toLowerCase() as Hex
}
function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`Invalid ${label}.`)
  return value
}
function ordered(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0 }
function exactWeight(value: unknown, fallback: bigint) {
  if (value === undefined) return ownershipWeight(fallback)
  const raw = record(value, 'exact FUND ownership weight')
  const integer = (part: unknown): bigint => {
    if (typeof part !== 'string' || part.length > 32_768 || !/^(0|[1-9]\d*)$/.test(part)) throw new Error('Invalid exact FUND ownership weight.')
    return BigInt(part)
  }
  if (Object.keys(raw).length !== 2) throw new Error('Invalid exact FUND ownership weight.')
  const numerator = integer(raw.numerator), denominator = integer(raw.denominator)
  if (denominator === 0n) throw new Error('An exact FUND ownership denominator must be positive.')
  const result = ownershipWeight(numerator, denominator)
  if (result.numerator !== numerator || result.denominator !== denominator) throw new Error('Exact FUND ownership weights must be reduced fractions.')
  return result
}
function equalWeight(left: ReturnType<typeof ownershipWeight>, right: ReturnType<typeof ownershipWeight>): boolean {
  return left.numerator === right.numerator && left.denominator === right.denominator
}

/** Stable UTF-8 serialization: bigint amounts are decimal strings, keys use ASCII ordering. */
export function canonicalSnapshotJson(value: unknown, depth = 0): SnapshotJson {
  if (depth > 64) throw new Error('The snapshot report is nested too deeply.')
  if (typeof value === 'bigint') return value.toString()
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'string') return /^0x[\da-fA-F]*$/.test(value) ? value.toLowerCase() : value
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error('Snapshot numbers must be safe integers; use strings for large amounts.')
    return value
  }
  if (Array.isArray(value)) return value.map(entry => canonicalSnapshotJson(entry, depth + 1))
  const source = record(value, 'snapshot JSON value')
  return Object.fromEntries(Object.keys(source).sort(ordered).filter(key => source[key] !== undefined).map(key => [key, canonicalSnapshotJson(source[key], depth + 1)]))
}
function canonicalText(value: unknown): string {
  function render(node: SnapshotJson, depth: number): string {
    if (node === null || typeof node !== 'object') return JSON.stringify(node)
    const indent = '  '.repeat(depth), next = `${indent}  `
    if (Array.isArray(node)) return node.length ? `[\n${node.map(entry => `${next}${render(entry, depth + 1)}`).join(',\n')}\n${indent}]` : '[]'
    const keys = Object.keys(node).sort(ordered)
    return keys.length ? `{\n${keys.map(key => `${next}${JSON.stringify(key)}: ${render(node[key], depth + 1)}`).join(',\n')}\n${indent}}` : '{}'
  }
  return `${render(canonicalSnapshotJson(value), 0)}\n`
}
export function fundGlobalSourceSetHash(snapshot: unknown): Hex { return keccak256(stringToHex(canonicalText(snapshot))) }

export function buildFundGlobalDistributionId(input: {
  chainId: number; helper: Address; fundProjectId: bigint; sourceSetHash: Hex; totalFundSupply: bigint; launchSalt: Hex
}): Hex {
  return keccak256(encodeAbiParameters(
    [{ type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }, { type: 'uint256' }, { type: 'bytes32' }, { type: 'uint256' }, { type: 'bytes32' }],
    [TYPE_HASH, BigInt(chain(input.chainId)), address(input.helper, 'helper'), uint(input.fundProjectId.toString(), 'FUND ID', true), hash(input.sourceSetHash, 'source set'), uint(input.totalFundSupply.toString(), 'global FUND supply', true), hash(input.launchSalt, 'launch salt')],
  ))
}

/** Internal consistency is distinct from reproducing historical ownership using the RPC. */
function reportDescription(value: unknown) {
  const report = record(value, 'global snapshot report')
  if (report.kind !== 'homerun-global-fund-entitlements' || report.version !== 1 || report.claimPolicy !== 'live-chain-and-pending-bridge-destination' || report.historyAttestation !== 'complete-canonical-rpc-log-history-required') throw new Error('Unsupported global ownership report.')
  const graph = record(report.graph, 'historical project graph')
  const cuts = array(graph.cuts, 'finalized source blocks').map(raw => {
    const cut = record(raw, 'source block')
    return { chainId: chain(cut.chainId), blockNumber: uint(cut.blockNumber, 'source block', true), blockHash: hash(cut.blockHash, 'source block'), blockTimestamp: uint(cut.blockTimestamp, 'source time') }
  }).sort((a, b) => a.chainId - b.chainId)
  if (!cuts.length || new Set(cuts.map(cut => cut.chainId)).size !== cuts.length) throw new Error('The source block vector is empty or duplicated.')
  const projects = array(graph.projects, 'FUND projects').map(raw => {
    const project = record(raw, 'FUND project')
    return { chainId: chain(project.chainId), projectId: uint(project.projectId, 'FUND ID', true), owner: address(project.owner, 'FUND owner') }
  }).sort((a, b) => a.chainId - b.chainId)
  if (projects.length !== cuts.length || projects.some((project, index) => project.chainId !== cuts[index].chainId)) throw new Error('The initial INCOME composition requires exactly one FUND project on each source chain.')
  const root = record(report.root, 'snapshot root project')
  const rootChain = chain(root.chainId), rootId = uint(root.projectId, 'root FUND ID', true)
  if (!projects.some(project => project.chainId === rootChain && project.projectId === rootId)) throw new Error('The snapshot root is outside the project graph.')
  const totals = record(report.totals, 'global supply totals')
  const liveSupply = uint(totals.liveFundSupply, 'live FUND supply'), pendingSupply = uint(totals.pendingFundSupply, 'pending FUND supply'), totalFundSupply = uint(totals.globalFundSupply, 'global FUND supply', true)
  if (liveSupply + pendingSupply !== totalFundSupply) throw new Error('Live and pending FUND do not reconcile with global supply.')
  const seen = new Set<string>()
  const holders = array(report.entitlements, 'chain-bound holders').map(raw => {
    const row = record(raw, 'FUND entitlement')
    const claimChainId = chain(row.claimChainId), beneficiary = address(row.beneficiary, 'beneficiary', true)
    const liveFundBalance = uint(row.liveFundBalance, 'live holder balance'), pendingFundBalance = uint(row.pendingFundBalance, 'pending holder balance'), fundBalance = uint(row.fundBalance, 'holder balance')
    const liveFundWeight = exactWeight(row.liveFundWeight, liveFundBalance), fundWeight = exactWeight(row.fundWeight, fundBalance)
    const key = `${claimChainId}:${beneficiary.toLowerCase()}`
    if (seen.has(key) || !projects.some(project => project.chainId === claimChainId) || liveFundBalance + pendingFundBalance !== fundBalance
      || fundWeight.numerator === 0n || !equalWeight(fundWeight, addOwnershipWeights(liveFundWeight, ownershipWeight(pendingFundBalance)))) throw new Error('The snapshot contains a duplicated, inconsistent, or foreign-chain entitlement or ownership weight.')
    seen.add(key)
    return { claimChainId, beneficiary, liveFundBalance, pendingFundBalance, fundBalance, liveFundWeight, fundWeight }
  }).sort((a, b) => a.claimChainId - b.claimChainId || ordered(a.beneficiary.toLowerCase(), b.beneficiary.toLowerCase()))
  if (!holders.length || holders.reduce((sum, row) => sum + row.liveFundBalance, 0n) !== liveSupply || holders.reduce((sum, row) => sum + row.pendingFundBalance, 0n) !== pendingSupply) throw new Error('All chain-bound holders must reconcile with the live and pending supplies.')
  if (!equalWeight(sumOwnershipWeights(holders.map(row => row.liveFundWeight)), ownershipWeight(liveSupply))
    || !equalWeight(sumOwnershipWeights(holders.map(row => row.fundWeight)), ownershipWeight(totalFundSupply))) throw new Error('Exact FUND ownership weights do not reconcile with the global supplies.')
  for (const project of projects) {
    const local = holders.filter(row => row.claimChainId === project.chainId)
    const localSupply = local.reduce((sum, row) => sum + row.liveFundBalance, 0n)
    if (!equalWeight(sumOwnershipWeights(local.map(row => row.liveFundWeight)), ownershipWeight(localSupply))) throw new Error('Exact FUND ownership weights do not reconcile on their claim chain.')
    const whole = local.map(row => row.liveFundWeight.numerator / row.liveFundWeight.denominator)
    const remainder = localSupply - whole.reduce((sum, balance) => sum + balance, 0n)
    const firstLive = local.findIndex(row => row.liveFundWeight.numerator > 0n)
    if (remainder < 0n || (remainder > 0n && firstLive < 0)) throw new Error('Invalid whole-atom FUND ownership projection.')
    if (firstLive >= 0) whole[firstLive] += remainder
    if (local.some((row, index) => row.liveFundBalance !== whole[index])) throw new Error('The whole-atom FUND projection must follow its exact ownership weights.')
  }
  return { cuts, projects, holders, totalFundSupply, root: { chainId: rootChain, projectId: rootId } }
}

function buildFromReport(snapshot: SnapshotJson, input: { helper: Address; launchSalt: Hex }): FundGlobalManifest {
  const helper = address(input.helper, 'helper'), launchSalt = hash(input.launchSalt, 'launch salt')
  const { cuts, projects, holders, totalFundSupply } = reportDescription(snapshot)
  const sourceSetHash = fundGlobalSourceSetHash(snapshot)
  const amounts = holders.map(holder => INITIAL_INCOME_SUPPLY * holder.fundWeight.numerator / (holder.fundWeight.denominator * totalFundSupply))
  amounts[0] += INITIAL_INCOME_SUPPLY - amounts.reduce((sum, amount) => sum + amount, 0n)
  const allocations = projects.map((project, position): GlobalIncomeAllocation => {
    const distributionId = buildFundGlobalDistributionId({ chainId: project.chainId, helper, fundProjectId: project.projectId, sourceSetHash, totalFundSupply, launchSalt })
    const rows = holders.map((holder, index) => ({ ...holder, incomeAmount: amounts[index] })).filter(holder => holder.claimChainId === project.chainId)
    const entries: FundSnapshotEntry[] = rows.map((holder, index) => ({ index: BigInt(index), beneficiary: holder.beneficiary, fundBalance: holder.fundBalance, incomeAmount: holder.incomeAmount }))
    const tree = entries.length ? buildFundMerkleTree(distributionId, entries) : { root: zeroHash, proofs: [] as Hex[][] }
    const cut = cuts[position]
    return {
      chainId: project.chainId, fundProjectId: project.projectId.toString(), snapshotBlockNumber: cut.blockNumber.toString(), snapshotBlockHash: cut.blockHash,
      merkleRoot: tree.root, leafCount: entries.length.toString(), incomeAmount: amounts.filter((_, index) => holders[index].claimChainId === project.chainId).reduce((sum, amount) => sum + amount, 0n).toString(), distributionId,
      holders: entries.map((entry, index) => ({ index: entry.index.toString(), beneficiary: entry.beneficiary, fundBalance: entry.fundBalance.toString(), liveFundBalance: rows[index].liveFundBalance.toString(), pendingFundBalance: rows[index].pendingFundBalance.toString(),
        ...(!equalWeight(rows[index].fundWeight, ownershipWeight(entry.fundBalance)) ? { fundWeight: { numerator: rows[index].fundWeight.numerator.toString(), denominator: rows[index].fundWeight.denominator.toString() } } : {}),
        incomeAmount: entry.incomeAmount.toString(), claimable: entry.incomeAmount > 0n && !isAddressEqual(entry.beneficiary, zeroAddress), proof: tree.proofs[index] })),
    }
  })
  if (allocations.reduce((sum, allocation) => sum + BigInt(allocation.incomeAmount), 0n) !== INITIAL_INCOME_SUPPLY) throw new Error('The initial allocations must total exactly 500,000 INCOME across all chains.')
  return { schema: FUND_GLOBAL_MANIFEST_SCHEMA, attestation: 'operator-proposed-root; complete-canonical-rpc-history-required', allocationPolicy: 'global-floor-pro-rata; remainder-to-lowest-chain-and-address; preserve-claim-chain', helper, launchSalt, sourceSetHash, totalFundSupply: totalFundSupply.toString(), totalIncomeAmount: INITIAL_INCOME_SUPPLY.toString(), snapshot, allocations }
}

export function buildFundGlobalManifest(snapshot: FundGlobalSnapshot, input: { helper: Address; launchSalt: Hex }): FundGlobalManifest {
  return buildFromReport(canonicalSnapshotJson(snapshot), input)
}

/** Verifies the committed report, deterministic global amounts, per-chain roots and every proof. */
export function parseFundGlobalManifest(value: unknown): FundGlobalManifest {
  const raw = record(value, 'global INCOME manifest')
  if (raw.schema !== FUND_GLOBAL_MANIFEST_SCHEMA) throw new Error('Unsupported initial INCOME manifest version.')
  const rebuilt = buildFromReport(canonicalSnapshotJson(raw.snapshot), { helper: address(raw.helper, 'helper'), launchSalt: hash(raw.launchSalt, 'launch salt') })
  if (canonicalText(raw) !== canonicalText(rebuilt)) throw new Error('The global manifest does not match its complete deterministic allocations and commitments.')
  return rebuilt
}
export function serializeFundGlobalManifest(manifest: FundGlobalManifest): string { return canonicalText(parseFundGlobalManifest(manifest)) }
export function fundGlobalManifestHash(manifest: FundGlobalManifest): Hex { return keccak256(stringToHex(serializeFundGlobalManifest(manifest))) }

export function globalIncomeSnapshotParameters(manifest: FundGlobalManifest, manifestUri: string) {
  const verified = parseFundGlobalManifest(manifest)
  if (!/^ipfs:\/\/[^\s/?#]+(?:\/[^\s]*)?$/.test(manifestUri)) throw new Error('Publish the complete global snapshot to IPFS first.')
  return {
    sourceSetHash: verified.sourceSetHash, totalFundSupply: BigInt(verified.totalFundSupply), manifestHash: fundGlobalManifestHash(verified), manifestUri,
    allocations: verified.allocations.map(allocation => ({ chainId: allocation.chainId, fundProjectId: BigInt(allocation.fundProjectId), snapshotBlockNumber: BigInt(allocation.snapshotBlockNumber), snapshotBlockHash: allocation.snapshotBlockHash, merkleRoot: allocation.merkleRoot, leafCount: BigInt(allocation.leafCount), incomeAmount: BigInt(allocation.incomeAmount) })),
  }
}

export type FundGlobalClaimBinding = {
  chainId: number; deployer: Address; fundProjectId: bigint; snapshotBlockNumber: bigint; snapshotBlockHash: Hex
  sourceSetHash: Hex; totalFundSupply: bigint; launchSalt: Hex; merkleRoot: Hex; leafCount: bigint
  manifestHash: Hex; distributionId: Hex; initialIncomeSupply: bigint; localInitialIncomeSupply: bigint
}
export function getFundGlobalClaim(value: unknown, binding: FundGlobalClaimBinding, beneficiary: Address) {
  const manifest = parseFundGlobalManifest(value)
  const allocation = manifest.allocations.find(entry => entry.chainId === binding.chainId && BigInt(entry.fundProjectId) === binding.fundProjectId)
  if (!allocation || !isAddressEqual(manifest.helper, binding.deployer) || manifest.sourceSetHash !== binding.sourceSetHash.toLowerCase() || manifest.launchSalt !== binding.launchSalt.toLowerCase()
    || BigInt(manifest.totalFundSupply) !== binding.totalFundSupply || BigInt(allocation.snapshotBlockNumber) !== binding.snapshotBlockNumber || allocation.snapshotBlockHash !== binding.snapshotBlockHash.toLowerCase()
    || allocation.merkleRoot !== binding.merkleRoot.toLowerCase() || BigInt(allocation.leafCount) !== binding.leafCount || allocation.distributionId !== binding.distributionId.toLowerCase()
    || BigInt(allocation.incomeAmount) !== binding.localInitialIncomeSupply || binding.initialIncomeSupply !== INITIAL_INCOME_SUPPLY || fundGlobalManifestHash(manifest) !== binding.manifestHash.toLowerCase()) throw new Error('The global manifest does not match the verified initial INCOME vault on this chain.')
  const normalized = address(beneficiary, 'claim beneficiary', true)
  const entry = allocation.holders.find(holder => isAddressEqual(holder.beneficiary, normalized))
  return { manifest, allocation, claim: entry?.claimable ? { index: BigInt(entry.index), beneficiary: entry.beneficiary, fundBalance: BigInt(entry.fundBalance), incomeAmount: BigInt(entry.incomeAmount), proof: [...entry.proof] } : null }
}

/** Reproduce every chain's finalized history before proposing an immutable root. */
export async function verifyFundGlobalManifestHistory(clients: ReadonlyMap<number, PublicClient>, value: unknown, options: Pick<FundGlobalSnapshotInput, 'signal' | 'logBlockWindow' | 'logResponseLimit' | 'onProgress'> = {}): Promise<FundGlobalManifest> {
  const manifest = parseFundGlobalManifest(value)
  const descriptor = reportDescription(manifest.snapshot)
  const report = record(manifest.snapshot, 'snapshot')
  const creationBlocks = new Map(array(report.projects, 'source ownership reports').map(raw => {
    const local = record(raw, 'source ownership report')
    return [`${chain(local.chainId)}:${uint(local.projectId, 'FUND ID', true)}`, uint(local.creationBlockNumber, 'creation block')] as const
  }))
  const current = await readFundGlobalSnapshot({ ...options, clients, root: descriptor.root, cuts: new Map(descriptor.cuts.map(cut => [cut.chainId, { blockNumber: cut.blockNumber, blockHash: cut.blockHash }])), creationBlocks })
  const verified = buildFundGlobalManifest(current, { helper: manifest.helper, launchSalt: manifest.launchSalt })
  if (fundGlobalManifestHash(verified) !== fundGlobalManifestHash(manifest)) throw new Error('The manifest differs from independently reconstructed global FUND history.')
  return verified
}
