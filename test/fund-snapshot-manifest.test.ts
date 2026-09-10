import assert from 'node:assert/strict'
import { beforeEach, test, vi } from 'vitest'
import { v6Address } from '@bananapus/nana-sdk-core/v6'
import { getAddress, keccak256, stringToHex, toHex, zeroAddress, zeroHash, type Address, type Hex, type PublicClient } from 'viem'
import {
  buildFundSnapshotManifest, fundSnapshotManifestHash, parseFundSnapshotManifest,
  serializeFundSnapshotManifest, verifyFundSnapshotHistory, getFundSnapshotClaim, type FundSnapshotManifest, type FundSnapshotClaimBinding,
} from '../src/lib/fund-snapshot-manifest'
import { buildFundDistributionId, verifyFundMerkleProof } from '../src/lib/fund-snapshot-merkle'
import { readFundOwnershipSnapshot, type FundOwnershipSnapshot, type FundSnapshotHolder } from '../src/lib/fund-snapshot'

vi.mock('../src/lib/fund-snapshot', () => ({ readFundOwnershipSnapshot: vi.fn() }))

const INITIAL_INCOME = 500_000n * 10n ** 18n
const UINT256_MAX = (1n << 256n) - 1n
const addr = (value: bigint): Address => getAddress(toHex(value, { size: 20 }))
const hash = (value: bigint): Hex => toHex(value, { size: 32 })
const owner = addr(100n)
const token = addr(101n)
const input = { destinationChainId: 8453, helper: addr(102n), launchSalt: hash(103n) }

function holder(id: bigint, creditBalance: bigint, erc20Balance = 0n): FundSnapshotHolder {
  return { holder: addr(id), creditBalance, erc20Balance, balance: creditBalance + erc20Balance }
}

function snapshot(holders = [holder(30n, 1n), holder(10n, 0n, 1n), holder(20n, 1n)]): FundOwnershipSnapshot {
  const totalCreditSupply = holders.reduce((sum, entry) => sum + entry.creditBalance, 0n)
  const totalErc20Supply = holders.reduce((sum, entry) => sum + entry.erc20Balance, 0n)
  return {
    chainId: 8453, projectId: 7n, blockNumber: 1000n, blockHash: hash(104n), blockTimestamp: 1_700_000_000n,
    creationBlockNumber: 100n, creationTransactionHash: hash(105n), owner, tokenAddress: token,
    totalFundSupply: totalCreditSupply + totalErc20Supply, totalCreditSupply, totalErc20Supply,
    holders: holders.map(entry => ({ ...entry })),
    evidence: {
      projects: getAddress(v6Address('JBProjects', 8453)), tokens: getAddress(v6Address('JBTokens', 8453)),
      controller: getAddress(v6Address('JBController', 8453)), suckerRegistry: getAddress(v6Address('JBSuckerRegistry', 8453)),
      eventCounts: { Transfer: 1, Mint: holders.length, TransferCredits: 0, ClaimTokens: 1, Burn: 0, DeployERC20: 1 },
      candidateCount: holders.length, bridgePolicy: 'no-historical-suckers',
    },
  }
}

function manifest() { return buildFundSnapshotManifest(snapshot(), input) }

function tampered(change: (value: FundSnapshotManifest) => void): FundSnapshotManifest {
  const result = manifest()
  change(result)
  return result
}

function shiftOneCreditToErc20(value: FundSnapshotManifest): void {
  const entry = value.holders.find(candidate => BigInt(candidate.creditBalance) > 0n)!
  entry.creditBalance = (BigInt(entry.creditBalance) - 1n).toString()
  entry.erc20Balance = (BigInt(entry.erc20Balance) + 1n).toString()
  value.snapshot.totalCreditSupply = (BigInt(value.snapshot.totalCreditSupply) - 1n).toString()
  value.snapshot.totalErc20Supply = (BigInt(value.snapshot.totalErc20Supply) + 1n).toString()
}

beforeEach(() => { vi.mocked(readFundOwnershipSnapshot).mockReset() })

test('deterministic allocation conserves exactly 500,000 INCOME and gives atom dust to the lowest address', () => {
  const source = snapshot()
  const original = structuredClone(source)
  const result = buildFundSnapshotManifest(source, input)
  assert.deepEqual(source, original)
  assert.equal(result.totalIncomeAmount, INITIAL_INCOME.toString())
  assert.equal(result.holders.reduce((sum, entry) => sum + BigInt(entry.incomeAmount), 0n), INITIAL_INCOME)
  assert.deepEqual(result.holders.map(entry => entry.beneficiary), [addr(10n), addr(20n), addr(30n)])
  assert.deepEqual(result.holders.map(entry => entry.index), ['0', '1', '2'])
  assert.deepEqual(result.holders.map(entry => BigInt(entry.incomeAmount)), [INITIAL_INCOME / 3n + 2n, INITIAL_INCOME / 3n, INITIAL_INCOME / 3n])
  assert.deepEqual(result.holders.map(entry => entry.claimable), [true, true, true])
  assert.equal(result.distributionId, buildFundDistributionId({
    ...input, fundProjectId: source.projectId, snapshotBlockNumber: source.blockNumber,
    snapshotBlockHash: source.blockHash, totalFundSupply: source.totalFundSupply,
  }))
  for (const entry of result.holders) {
    assert.equal(verifyFundMerkleProof(result.distributionId, {
      index: BigInt(entry.index), beneficiary: entry.beneficiary,
      fundBalance: BigInt(entry.fundBalance), incomeAmount: BigInt(entry.incomeAmount),
    }, entry.proof, result.merkleRoot), true)
  }
})

test('input order and event-count insertion order do not change the serialized manifest', () => {
  const source = snapshot()
  const reordered = { ...source, holders: [...source.holders].reverse(), evidence: { ...source.evidence, eventCounts: Object.fromEntries(Object.entries(source.evidence.eventCounts).reverse()) } }
  const first = buildFundSnapshotManifest(source, input)
  const second = buildFundSnapshotManifest(reordered, input)
  assert.equal(serializeFundSnapshotManifest(first), serializeFundSnapshotManifest(second))
  assert.equal(fundSnapshotManifestHash(first), fundSnapshotManifestHash(second))
})

test('equivalent address casing and hexadecimal casing normalize to the same committed bytes', () => {
  const canonical = manifest()
  const equivalent = structuredClone(canonical)
  for (const key of ['projects', 'tokens', 'controller', 'suckerRegistry'] as const) {
    equivalent.snapshot.evidence[key] = equivalent.snapshot.evidence[key].toLowerCase() as Address
  }
  equivalent.snapshot.blockHash = `0x${equivalent.snapshot.blockHash.slice(2).toUpperCase()}`
  equivalent.merkleRoot = `0x${equivalent.merkleRoot.slice(2).toUpperCase()}`
  equivalent.distributionId = `0x${equivalent.distributionId.slice(2).toUpperCase()}`
  assert.deepEqual(parseFundSnapshotManifest(equivalent), canonical)
  assert.equal(serializeFundSnapshotManifest(equivalent), serializeFundSnapshotManifest(canonical))
  assert.equal(fundSnapshotManifestHash(equivalent), fundSnapshotManifestHash(canonical))
})

test('257 holders retain every allocation and proof without recreating the 200-holder limit', () => {
  const source = snapshot(Array.from({ length: 257 }, (_, index) => holder(BigInt(index + 1), BigInt(index + 1))))
  const result = buildFundSnapshotManifest(source, input)
  assert.equal(result.leafCount, 257)
  assert.equal(result.holders.length, 257)
  assert.equal(result.holders.reduce((sum, entry) => sum + BigInt(entry.fundBalance), 0n), source.totalFundSupply)
  assert.equal(result.holders.reduce((sum, entry) => sum + BigInt(entry.incomeAmount), 0n), INITIAL_INCOME)
  assert.deepEqual(parseFundSnapshotManifest(result), result)
  for (const entry of result.holders) {
    assert.equal(verifyFundMerkleProof(result.distributionId, {
      index: BigInt(entry.index), beneficiary: entry.beneficiary,
      fundBalance: BigInt(entry.fundBalance), incomeAmount: BigInt(entry.incomeAmount),
    }, entry.proof, result.merkleRoot), true)
  }
})

test('positive zero-address credits and tiny zero-INCOME entitlements remain in the complete manifest', () => {
  const result = buildFundSnapshotManifest(snapshot([holder(2n, 2n * INITIAL_INCOME), holder(0n, 1n), holder(1n, 1n)]), input)
  const [zero, tiny, large] = result.holders
  assert.equal(zero.beneficiary, zeroAddress)
  assert.equal(zero.creditBalance, '1')
  assert.equal(zero.erc20Balance, '0')
  assert.equal(zero.incomeAmount, '1')
  assert.equal(zero.claimable, false)
  assert.equal(tiny.fundBalance, '1')
  assert.equal(tiny.incomeAmount, '0')
  assert.equal(tiny.claimable, false)
  assert.equal(large.incomeAmount, (INITIAL_INCOME - 1n).toString())
  assert.equal(large.claimable, true)
  assert.equal(result.leafCount, 3)
  assert.deepEqual(parseFundSnapshotManifest(result), result)
})

test('credit-only projects serialize a null token and exact uint256 values without losing precision', () => {
  const source = snapshot([holder(1n, UINT256_MAX)])
  source.projectId = UINT256_MAX
  source.tokenAddress = null
  const result = buildFundSnapshotManifest(source, input)
  assert.equal(result.snapshot.projectId, UINT256_MAX.toString())
  assert.equal(result.snapshot.totalFundSupply, UINT256_MAX.toString())
  assert.equal(result.snapshot.totalErc20Supply, '0')
  assert.equal(result.snapshot.tokenAddress, null)
  assert.equal(result.holders[0].incomeAmount, INITIAL_INCOME.toString())
  assert.deepEqual(parseFundSnapshotManifest(JSON.parse(serializeFundSnapshotManifest(result))), result)
})

test('builders reject incomplete supply, conflicting balances, duplicate holders and unsupported bridge scope', () => {
  const changes: ((value: FundOwnershipSnapshot) => void)[] = [
    value => { value.holders = [] },
    value => { value.holders.pop() },
    value => { value.holders[0].balance = 0n },
    value => { value.holders[0].creditBalance = -1n },
    value => { value.holders[0].erc20Balance = -1n },
    value => { value.holders[0].balance += 1n },
    value => { value.totalFundSupply += 1n },
    value => { value.totalCreditSupply += 1n; value.totalErc20Supply -= 1n },
    value => { value.totalCreditSupply = -1n },
    value => { value.holders[1].holder = value.holders[0].holder },
    value => { value.evidence.bridgePolicy = 'active-peers-only' as FundOwnershipSnapshot['evidence']['bridgePolicy'] },
  ]
  for (const change of changes) {
    const source = snapshot()
    change(source)
    assert.throws(() => buildFundSnapshotManifest(source, input))
  }
  assert.throws(() => buildFundSnapshotManifest(snapshot(), { ...input, destinationChainId: 10 }), /cross-chain/)
  assert.throws(() => buildFundSnapshotManifest(snapshot([holder(1n, UINT256_MAX + 1n)]), input))
})

test('changing any committed launch or snapshot domain cannot replay the original root', () => {
  const changes: ((value: FundSnapshotManifest) => void)[] = [
    value => { value.destinationChainId = 10 },
    value => { value.helper = addr(200n) },
    value => { value.launchSalt = hash(201n) },
    value => { value.snapshot.projectId = '8' },
    value => { value.snapshot.chainId = 10 },
    value => { value.snapshot.blockNumber = '1001' },
    value => { value.snapshot.blockHash = hash(202n) },
    value => { value.snapshot.totalFundSupply = '4' },
    value => { value.distributionId = hash(203n) },
    value => { value.merkleRoot = hash(204n) },
  ]
  for (const change of changes) assert.throws(() => parseFundSnapshotManifest(tampered(change)))
})

test('allocation, proof, claimed eligibility, leaf count and advertised total are checked independently', () => {
  const changes: ((value: FundSnapshotManifest) => void)[] = [
    value => { value.holders[0].incomeAmount = (BigInt(value.holders[0].incomeAmount) + 1n).toString(); value.holders[1].incomeAmount = (BigInt(value.holders[1].incomeAmount) - 1n).toString() },
    value => { value.holders[0].fundBalance = '2' },
    value => { value.holders[0].claimable = false },
    value => { value.holders[0].proof[0] = hash(205n) },
    value => { value.holders[0].proof.pop() },
    value => { value.holders[0].proof.push(hash(206n)) },
    value => { value.holders[0].proof = value.holders[1].proof },
    value => { value.leafCount += 1 },
    value => { value.totalIncomeAmount = (INITIAL_INCOME + 1n).toString() },
    value => { value.holders.pop() },
  ]
  for (const change of changes) assert.throws(() => parseFundSnapshotManifest(tampered(change)))
})

test('parser requires unique sorted beneficiaries and sequential indexes', () => {
  const changes: ((value: FundSnapshotManifest) => void)[] = [
    value => { value.holders[1].index = value.holders[0].index },
    value => { value.holders[1].index = '5' },
    value => { value.holders[1].beneficiary = value.holders[0].beneficiary },
    value => { value.holders.reverse() },
    value => { value.holders.reverse(); value.holders.forEach((entry, index) => { entry.index = index.toString() }) },
  ]
  for (const change of changes) assert.throws(() => parseFundSnapshotManifest(tampered(change)))
})

test('credit and ERC20 balances must each reconcile with their advertised supplies', () => {
  const changes: ((value: FundSnapshotManifest) => void)[] = [
    value => { value.snapshot.totalCreditSupply = '3'; value.snapshot.totalErc20Supply = '0' },
    value => { value.holders[0].erc20Balance = '0' },
    value => { value.holders[1].creditBalance = '0' },
    value => { value.holders[0].creditBalance = '1' },
    value => { value.snapshot.tokenAddress = null },
  ]
  for (const change of changes) assert.throws(() => parseFundSnapshotManifest(tampered(change)))
})

test('zero token addresses and positive zero-address ERC20 holdings cannot describe canonical ownership', () => {
  assert.throws(() => parseFundSnapshotManifest(tampered(value => { value.snapshot.tokenAddress = zeroAddress })))
  const result = buildFundSnapshotManifest(snapshot([holder(0n, 1n), holder(1n, 1n, 1n)]), input)
  result.holders[0].creditBalance = '0'
  result.holders[0].erc20Balance = '1'
  result.snapshot.totalCreditSupply = '1'
  result.snapshot.totalErc20Supply = '2'
  assert.throws(() => parseFundSnapshotManifest(result))
})

test('schema, attestation and allocation policy cannot be replaced with stronger unsupported claims', () => {
  for (const change of [
    { schema: 'homerun.initial-income.snapshot.v0' },
    { attestation: 'balances cryptographically proven onchain' },
    { allocationPolicy: 'operator picks the rounding recipient' },
  ]) assert.throws(() => parseFundSnapshotManifest({ ...manifest(), ...change }))
  for (const value of [null, undefined, [], {}, 'not a manifest']) assert.throws(() => parseFundSnapshotManifest(value))
})

test('metadata must contain valid creation history, addresses, hashes and bounded evidence counts', () => {
  const changes: ((value: FundSnapshotManifest) => void)[] = [
    value => { value.snapshot.creationBlockNumber = '1001' },
    value => { value.snapshot.owner = zeroAddress },
    value => { value.snapshot.creationTransactionHash = zeroHash },
    value => { value.snapshot.creationTransactionHash = `0x${'gg'.repeat(32)}` },
    value => { value.snapshot.blockHash = `0x${'zz'.repeat(32)}` },
    value => { value.snapshot.evidence.candidateCount = 2 },
    value => { value.snapshot.evidence.candidateCount = Number.MAX_SAFE_INTEGER + 1 },
    value => { value.snapshot.evidence.eventCounts.Transfer = -1 },
    value => { value.snapshot.evidence.eventCounts.Transfer = 1.5 },
    value => { value.snapshot.evidence.eventCounts.Transfer = Number.MAX_SAFE_INTEGER + 1 },
    value => { value.snapshot.evidence.eventCounts.UnknownEvent = 1 },
    value => { value.snapshot.evidence.tokens = '0x1234' },
  ]
  for (const change of changes) assert.throws(() => parseFundSnapshotManifest(tampered(change)))
})

test('numeric strings reject coercion, alternate encodings and uint256 overflow', () => {
  const invalid = ['-1', '01', '+1', '1.0', '1e3', ' 1', '', (UINT256_MAX + 1n).toString(), '9'.repeat(79), 1, null, undefined]
  for (const value of invalid) {
    for (const key of ['projectId', 'blockNumber', 'blockTimestamp', 'creationBlockNumber', 'totalFundSupply', 'totalCreditSupply', 'totalErc20Supply']) {
      const candidate = manifest()
      Reflect.set(candidate.snapshot, key, value)
      assert.throws(() => parseFundSnapshotManifest(candidate))
    }
    for (const key of ['index', 'fundBalance', 'creditBalance', 'erc20Balance', 'incomeAmount']) {
      const candidate = manifest()
      Reflect.set(candidate.holders[0], key, value)
      assert.throws(() => parseFundSnapshotManifest(candidate))
    }
  }
  for (const value of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, '8453']) {
    assert.throws(() => parseFundSnapshotManifest({ ...manifest(), destinationChainId: value }))
  }
})

test('canonical UTF-8 serialization round-trips and its hash commits the exact published bytes', () => {
  const source = manifest()
  const serialized = serializeFundSnapshotManifest(source)
  assert.equal(serialized, `${JSON.stringify(source, null, 2)}\n`)
  assert.deepEqual(parseFundSnapshotManifest(JSON.parse(serialized)), source)
  assert.equal(serializeFundSnapshotManifest(parseFundSnapshotManifest(JSON.parse(serialized))), serialized)
  assert.equal(fundSnapshotManifestHash(source), keccak256(stringToHex(serialized)))
  assert.notEqual(fundSnapshotManifestHash(source), keccak256(stringToHex(serialized.trimEnd())))
  const internallyConsistentChange = tampered(value => { value.snapshot.blockTimestamp = '1700000001' })
  assert.notEqual(fundSnapshotManifestHash(source), fundSnapshotManifestHash(internallyConsistentChange))
  assert.equal(source.merkleRoot, internallyConsistentChange.merkleRoot)
})

test('history verification pins the declared project and blocks, passes controls through and reproduces the manifest', async () => {
  const source = snapshot()
  const expected = buildFundSnapshotManifest(source, input)
  vi.mocked(readFundOwnershipSnapshot).mockResolvedValue(source)
  const client = {} as PublicClient
  const signal = new AbortController().signal
  const onProgress = vi.fn()
  const options = { signal, onProgress, logBlockWindow: 50n, logResponseLimit: 100 }
  assert.deepEqual(await verifyFundSnapshotHistory(client, expected, options), expected)
  assert.deepEqual(vi.mocked(readFundOwnershipSnapshot).mock.calls, [[client, {
    ...options, chainId: 8453, projectId: 7n, snapshotBlockNumber: 1000n, creationBlockNumber: 100n,
  }]])
})

test('history verification rejects internally valid allocations for different canonical holder balances', async () => {
  const source = snapshot([holder(30n, 2n), holder(10n, 0n, 1n)])
  const verified = buildFundSnapshotManifest(source, input)
  assert.equal(verified.distributionId, manifest().distributionId)
  assert.notEqual(verified.merkleRoot, manifest().merkleRoot)
  vi.mocked(readFundOwnershipSnapshot).mockResolvedValue(source)
  await assert.rejects(verifyFundSnapshotHistory({} as PublicClient, manifest()), /canonical FUND ownership/)
})

test('history verification rejects a reorg, different creation event, owner or token', async () => {
  const changes: ((value: FundOwnershipSnapshot) => void)[] = [
    value => { value.blockHash = hash(210n) },
    value => { value.creationTransactionHash = hash(211n) },
    value => { value.owner = addr(212n) },
    value => { value.tokenAddress = addr(213n) },
  ]
  for (const change of changes) {
    const source = snapshot()
    change(source)
    vi.mocked(readFundOwnershipSnapshot).mockResolvedValue(source)
    await assert.rejects(verifyFundSnapshotHistory({} as PublicClient, manifest()))
  }
})

test('history verification rejects a changed credit/ERC20 split even when total balances and the root match', async () => {
  const candidate = tampered(shiftOneCreditToErc20)
  const original = manifest()
  assert.deepEqual(parseFundSnapshotManifest(candidate), candidate)
  assert.equal(candidate.merkleRoot, original.merkleRoot)
  assert.notEqual(fundSnapshotManifestHash(candidate), fundSnapshotManifestHash(original))
  vi.mocked(readFundOwnershipSnapshot).mockResolvedValue(snapshot())
  await assert.rejects(verifyFundSnapshotHistory({} as PublicClient, candidate))
})

test('history verification rejects forged timestamps, canonical-contract evidence and event counts', async () => {
  const changes: ((value: FundSnapshotManifest) => void)[] = [
    value => { value.snapshot.blockTimestamp = '1700000001' },
    value => { value.snapshot.evidence.projects = addr(220n) },
    value => { value.snapshot.evidence.tokens = addr(221n) },
    value => { value.snapshot.evidence.controller = addr(222n) },
    value => { value.snapshot.evidence.suckerRegistry = addr(223n) },
    value => { value.snapshot.evidence.eventCounts.Mint += 1 },
  ]
  for (const change of changes) {
    const candidate = tampered(change)
    assert.equal(candidate.merkleRoot, manifest().merkleRoot)
    vi.mocked(readFundOwnershipSnapshot).mockResolvedValue(snapshot())
    await assert.rejects(verifyFundSnapshotHistory({} as PublicClient, candidate))
  }
})

test('invalid manifests fail before history reads, and RPC/reorg errors never become verification success', async () => {
  await assert.rejects(verifyFundSnapshotHistory({} as PublicClient, tampered(value => { value.merkleRoot = hash(230n) })))
  assert.equal(vi.mocked(readFundOwnershipSnapshot).mock.calls.length, 0)
  const failure = new Error('The pinned block changed while reconstructing FUND history.')
  vi.mocked(readFundOwnershipSnapshot).mockRejectedValue(failure)
  await assert.rejects(verifyFundSnapshotHistory({} as PublicClient, manifest()), error => error === failure)
})

function bindingFor(value: FundSnapshotManifest): FundSnapshotClaimBinding {
  return {
    chainId: 8453, deployer: value.helper, fundProjectId: BigInt(value.snapshot.projectId),
    snapshotBlockNumber: BigInt(value.snapshot.blockNumber), snapshotBlockHash: value.snapshot.blockHash,
    totalFundSupply: BigInt(value.snapshot.totalFundSupply), launchSalt: value.launchSalt,
    merkleRoot: value.merkleRoot, leafCount: BigInt(value.leafCount), manifestHash: fundSnapshotManifestHash(value),
    distributionId: value.distributionId, initialIncomeSupply: INITIAL_INCOME,
  }
}

test('claim extraction matches all immutable vault commitments and returns exact integer calldata', () => {
  const value = manifest()
  const result = getFundSnapshotClaim(value, bindingFor(value), addr(20n))
  assert.deepEqual(result.manifest, value)
  assert.deepEqual(result.claim, {
    index: 1n, beneficiary: addr(20n), fundBalance: 1n,
    incomeAmount: INITIAL_INCOME / 3n, proof: value.holders[1].proof,
  })
  assert.equal(getFundSnapshotClaim(value, bindingFor(value), addr(900n)).claim, null)
})

test('zero-address entitlements and zero-rounded allocations remain visible but are not offered as claims', () => {
  const value = buildFundSnapshotManifest(snapshot([holder(0n, UINT256_MAX - 1n), holder(1n, 1n)]), input)
  assert.equal(value.holders.length, 2)
  assert.equal(value.holders[0].incomeAmount, INITIAL_INCOME.toString())
  assert.equal(value.holders[1].incomeAmount, '0')
  assert.equal(getFundSnapshotClaim(value, bindingFor(value), zeroAddress).claim, null)
  assert.equal(getFundSnapshotClaim(value, bindingFor(value), addr(1n)).claim, null)
})

test('claim extraction rejects replay or mismatch in every committed immutable field', () => {
  const value = manifest()
  const changes: Partial<FundSnapshotClaimBinding>[] = [
    { chainId: 1 }, { deployer: addr(999n) }, { fundProjectId: 9n }, { snapshotBlockNumber: 1001n },
    { snapshotBlockHash: hash(990n) }, { totalFundSupply: 4n }, { launchSalt: hash(991n) },
    { merkleRoot: hash(992n) }, { leafCount: 4n }, { manifestHash: hash(993n) },
    { distributionId: hash(994n) }, { initialIncomeSupply: INITIAL_INCOME - 1n },
  ]
  for (const change of changes) assert.throws(() => getFundSnapshotClaim(value, { ...bindingFor(value), ...change }, addr(20n)), /vault commitments/)
})
