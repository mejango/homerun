/** Portable, deterministically reproducible initial-INCOME allocation. */
import { getAddress, isAddress, isAddressEqual, isHex, keccak256, stringToHex, zeroAddress, zeroHash, type Address, type Hex, type PublicClient } from 'viem'
import type { JBChainId } from '@bananapus/nana-sdk-core'
import { INITIAL_INCOME_SUPPLY } from './income-contracts'
import { buildFundDistributionId, buildFundMerkleTree, type FundSnapshotEntry } from './fund-snapshot-merkle'
import { readFundOwnershipSnapshot, type FundOwnershipSnapshot, type FundSnapshotHolder, type FundSnapshotInput } from './fund-snapshot'
import type { InitialIncomeAllocationState } from './income-allocation-state'

export const FUND_SNAPSHOT_MANIFEST_SCHEMA = 'homerun.initial-income.snapshot.v1'

export type FundSnapshotManifest = {
  schema: typeof FUND_SNAPSHOT_MANIFEST_SCHEMA
  attestation: 'operator-proposed-root; historical balances require independent verification'
  allocationPolicy: 'floor-pro-rata; remainder-to-lowest-address; include-zero-address-and-zero-allocation'
  distributionId: Hex
  merkleRoot: Hex
  totalIncomeAmount: string
  leafCount: number
  destinationChainId: number
  helper: Address
  launchSalt: Hex
  snapshot: {
    chainId: number
    projectId: string
    blockNumber: string
    blockHash: Hex
    blockTimestamp: string
    creationBlockNumber: string
    creationTransactionHash: Hex
    owner: Address
    tokenAddress: Address | null
    totalFundSupply: string
    totalCreditSupply: string
    totalErc20Supply: string
    evidence: FundOwnershipSnapshot['evidence']
  }
  holders: {
    index: string
    beneficiary: Address
    fundBalance: string
    creditBalance: string
    erc20Balance: string
    incomeAmount: string
    /** False only when the recipient has no key (zero) or rounds to zero. */
    claimable: boolean
    proof: Hex[]
  }[]
}

function uint(value: unknown, label: string, positive = false): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value) || value.length > 78) throw new Error(`Invalid ${label} integer.`)
  const result = BigInt(value)
  if (result >= 1n << 256n || (positive && result === 0n)) throw new Error(`Invalid ${label} integer.`)
  return result
}

function address(value: unknown, label: string): Address {
  if (typeof value !== 'string' || !isAddress(value)) throw new Error(`Invalid ${label} address.`)
  return getAddress(value)
}

function hash(value: unknown, label: string): Hex {
  if (typeof value !== 'string' || !isHex(value, { strict: true }) || value.length !== 66 || value.toLowerCase() === zeroHash) throw new Error(`Invalid ${label} hash.`)
  return value.toLowerCase() as Hex
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`Invalid ${label}.`)
  return value as Record<string, unknown>
}

function chain(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) throw new Error('Invalid snapshot chain ID.')
  return value
}

/** There is deliberately no holder cap. A transaction later proves one leaf. */
export function buildFundSnapshotManifest(snapshot: FundOwnershipSnapshot, input: {
  destinationChainId: number
  helper: Address
  launchSalt: Hex
}): FundSnapshotManifest {
  if (input.destinationChainId !== snapshot.chainId) throw new Error('A cross-chain initial allocation requires a verified global snapshot, including every unsettled bridge claim.')
  if (!snapshot.holders.length || snapshot.totalFundSupply <= 0n || snapshot.evidence.bridgePolicy !== 'no-historical-suckers') throw new Error('A complete single-chain FUND ownership snapshot is required.')
  if (snapshot.tokenAddress && isAddressEqual(snapshot.tokenAddress, zeroAddress)) throw new Error('An absent FUND ERC-20 must be recorded as null.')
  const seen = new Set<string>()
  const holders = snapshot.holders.map(holder => {
    const normalized = address(holder.holder, 'holder')
    if (seen.has(normalized)) throw new Error('Duplicate FUND holder in the snapshot.')
    seen.add(normalized)
    if (holder.balance <= 0n || holder.creditBalance < 0n || holder.erc20Balance < 0n || holder.creditBalance + holder.erc20Balance !== holder.balance || (isAddressEqual(normalized, zeroAddress) && holder.erc20Balance !== 0n)) throw new Error('Snapshot holder balances do not reconcile.')
    return { ...holder, holder: normalized }
  }).sort((left, right) => left.holder.toLowerCase() < right.holder.toLowerCase() ? -1 : left.holder.toLowerCase() > right.holder.toLowerCase() ? 1 : 0)
  if (holders.reduce((sum, holder) => sum + holder.balance, 0n) !== snapshot.totalFundSupply || holders.reduce((sum, holder) => sum + holder.creditBalance, 0n) !== snapshot.totalCreditSupply || holders.reduce((sum, holder) => sum + holder.erc20Balance, 0n) !== snapshot.totalErc20Supply || snapshot.totalCreditSupply + snapshot.totalErc20Supply !== snapshot.totalFundSupply) throw new Error('The manifest must cover all FUND supply, including credits and zero-address balances.')
  const distributionId = buildFundDistributionId({
    destinationChainId: input.destinationChainId, helper: input.helper, fundProjectId: snapshot.projectId,
    snapshotBlockNumber: snapshot.blockNumber, snapshotBlockHash: snapshot.blockHash,
    totalFundSupply: snapshot.totalFundSupply, launchSalt: input.launchSalt,
  })
  const entries: FundSnapshotEntry[] = holders.map((holder, index) => ({
    index: BigInt(index), beneficiary: holder.holder, fundBalance: holder.balance,
    incomeAmount: INITIAL_INCOME_SUPPLY * holder.balance / snapshot.totalFundSupply,
  }))
  entries[0].incomeAmount += INITIAL_INCOME_SUPPLY - entries.reduce((sum, entry) => sum + entry.incomeAmount, 0n)
  if (entries.reduce((sum, entry) => sum + entry.incomeAmount, 0n) !== INITIAL_INCOME_SUPPLY) throw new Error('The initial INCOME allocation does not conserve 500,000 tokens.')
  const tree = buildFundMerkleTree(distributionId, entries)
  return {
    schema: FUND_SNAPSHOT_MANIFEST_SCHEMA,
    attestation: 'operator-proposed-root; historical balances require independent verification',
    allocationPolicy: 'floor-pro-rata; remainder-to-lowest-address; include-zero-address-and-zero-allocation',
    distributionId, merkleRoot: tree.root, totalIncomeAmount: INITIAL_INCOME_SUPPLY.toString(), leafCount: entries.length,
    destinationChainId: input.destinationChainId, helper: getAddress(input.helper), launchSalt: input.launchSalt.toLowerCase() as Hex,
    snapshot: {
      chainId: snapshot.chainId, projectId: snapshot.projectId.toString(), blockNumber: snapshot.blockNumber.toString(),
      blockHash: snapshot.blockHash.toLowerCase() as Hex, blockTimestamp: snapshot.blockTimestamp.toString(),
      creationBlockNumber: snapshot.creationBlockNumber.toString(), creationTransactionHash: snapshot.creationTransactionHash.toLowerCase() as Hex,
      owner: getAddress(snapshot.owner), tokenAddress: snapshot.tokenAddress ? getAddress(snapshot.tokenAddress) : null,
      totalFundSupply: snapshot.totalFundSupply.toString(), totalCreditSupply: snapshot.totalCreditSupply.toString(), totalErc20Supply: snapshot.totalErc20Supply.toString(),
      evidence: {
        ...snapshot.evidence, projects: getAddress(snapshot.evidence.projects), tokens: getAddress(snapshot.evidence.tokens),
        controller: getAddress(snapshot.evidence.controller), suckerRegistry: getAddress(snapshot.evidence.suckerRegistry),
        eventCounts: Object.fromEntries(Object.entries(snapshot.evidence.eventCounts).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)),
      },
    },
    holders: entries.map((entry, index) => ({
      index: entry.index.toString(), beneficiary: entry.beneficiary, fundBalance: entry.fundBalance.toString(),
      creditBalance: holders[index].creditBalance.toString(), erc20Balance: holders[index].erc20Balance.toString(),
      incomeAmount: entry.incomeAmount.toString(), claimable: !isAddressEqual(entry.beneficiary, zeroAddress) && entry.incomeAmount > 0n,
      proof: tree.proofs[index],
    })),
  }
}

/**
 * Validates a downloaded manifest's domain, balances, rounding, root and every
 * proof. This proves internal consistency only; use verifyFundSnapshotHistory
 * to independently reproduce the historical ownership from the canonical RPC.
 */
export function parseFundSnapshotManifest(value: unknown): FundSnapshotManifest {
  const manifest = object(value, 'FUND snapshot manifest')
  if (manifest.schema !== FUND_SNAPSHOT_MANIFEST_SCHEMA || !Array.isArray(manifest.holders) || !manifest.holders.length) throw new Error('Unsupported or empty FUND snapshot manifest.')
  const source = object(manifest.snapshot, 'snapshot descriptor')
  const evidence = object(source.evidence, 'snapshot evidence')
  if (evidence.bridgePolicy !== 'no-historical-suckers') throw new Error('Unverified multichain snapshot evidence.')
  const eventCounts: Record<string, number> = {}
  for (const [name, count] of Object.entries(object(evidence.eventCounts, 'event counts'))) {
    if (!['Mint', 'Burn', 'ClaimTokens', 'TransferCredits', 'DeployERC20', 'Transfer', 'DeploySticky'].includes(name) || typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) throw new Error('Invalid snapshot event count.')
    eventCounts[name] = count
  }
  if (typeof evidence.candidateCount !== 'number' || !Number.isSafeInteger(evidence.candidateCount) || evidence.candidateCount < manifest.holders.length) throw new Error('Invalid snapshot candidate count.')
  const holders: FundSnapshotHolder[] = manifest.holders.map((raw, index) => {
    const holder = object(raw, 'snapshot holder')
    if (uint(holder.index, 'holder index') !== BigInt(index)) throw new Error('Snapshot leaf indices must be sequential.')
    return { holder: address(holder.beneficiary, 'holder'), balance: uint(holder.fundBalance, 'FUND balance', true), creditBalance: uint(holder.creditBalance, 'credit balance'), erc20Balance: uint(holder.erc20Balance, 'ERC-20 balance') }
  })
  const snapshot: FundOwnershipSnapshot = {
    chainId: chain(source.chainId) as JBChainId, projectId: uint(source.projectId, 'project ID', true),
    blockNumber: uint(source.blockNumber, 'snapshot block', true), blockHash: hash(source.blockHash, 'snapshot block'), blockTimestamp: uint(source.blockTimestamp, 'snapshot timestamp'),
    creationBlockNumber: uint(source.creationBlockNumber, 'creation block'), creationTransactionHash: hash(source.creationTransactionHash, 'creation transaction'),
    owner: address(source.owner, 'owner'), tokenAddress: source.tokenAddress === null ? null : address(source.tokenAddress, 'token'),
    totalFundSupply: uint(source.totalFundSupply, 'FUND supply', true), totalCreditSupply: uint(source.totalCreditSupply, 'credit supply'), totalErc20Supply: uint(source.totalErc20Supply, 'ERC-20 supply'), holders,
    evidence: { projects: address(evidence.projects, 'projects'), tokens: address(evidence.tokens, 'tokens'), controller: address(evidence.controller, 'controller'), suckerRegistry: address(evidence.suckerRegistry, 'sucker registry'), eventCounts, candidateCount: evidence.candidateCount, bridgePolicy: 'no-historical-suckers' },
  }
  if (snapshot.creationBlockNumber > snapshot.blockNumber || isAddressEqual(snapshot.owner, zeroAddress) || (snapshot.tokenAddress === null && snapshot.totalErc20Supply !== 0n)) throw new Error('The snapshot descriptor is inconsistent.')
  const rebuilt = buildFundSnapshotManifest(snapshot, { destinationChainId: chain(manifest.destinationChainId), helper: address(manifest.helper, 'helper'), launchSalt: hash(manifest.launchSalt, 'launch salt') })
  if (manifest.attestation !== rebuilt.attestation || manifest.allocationPolicy !== rebuilt.allocationPolicy || manifest.leafCount !== rebuilt.leafCount || manifest.totalIncomeAmount !== rebuilt.totalIncomeAmount || hash(manifest.distributionId, 'distribution ID') !== rebuilt.distributionId || hash(manifest.merkleRoot, 'Merkle root') !== rebuilt.merkleRoot) throw new Error('The manifest domain, total allocation, or Merkle root is inconsistent.')
  for (let index = 0; index < rebuilt.holders.length; index++) {
    const actual = object(manifest.holders[index], 'snapshot holder')
    const expected = rebuilt.holders[index]
    if (!isAddressEqual(address(actual.beneficiary, 'holder'), expected.beneficiary) || actual.incomeAmount !== expected.incomeAmount || actual.fundBalance !== expected.fundBalance || actual.creditBalance !== expected.creditBalance || actual.erc20Balance !== expected.erc20Balance || actual.claimable !== expected.claimable || !Array.isArray(actual.proof) || actual.proof.length !== expected.proof.length || actual.proof.some((sibling, position) => hash(sibling, 'proof sibling') !== expected.proof[position])) throw new Error('A snapshot allocation or proof does not match the complete deterministic distribution.')
  }
  return rebuilt
}

/** These exact UTF-8 bytes can be pinned as an application/json IPFS file. */
export function serializeFundSnapshotManifest(manifest: FundSnapshotManifest): string {
  return `${JSON.stringify(parseFundSnapshotManifest(manifest), null, 2)}\n`
}

export function fundSnapshotManifestHash(manifest: FundSnapshotManifest): Hex {
  return keccak256(stringToHex(serializeFundSnapshotManifest(manifest)))
}

export type FundSnapshotClaim = {
  index: bigint
  beneficiary: Address
  fundBalance: bigint
  incomeAmount: bigint
  proof: Hex[]
}

export type FundSnapshotClaimBinding = Pick<InitialIncomeAllocationState,
  'chainId' | 'deployer' | 'fundProjectId' | 'snapshotBlockNumber' | 'snapshotBlockHash' |
  'totalFundSupply' | 'launchSalt' | 'merkleRoot' | 'leafCount' | 'manifestHash' | 'distributionId' | 'initialIncomeSupply'
>

/**
 * Extract a claim only after checking every immutable vault commitment. A
 * missing account or zero allocation is not a transaction. Claim status and
 * funding are separate fresh onchain reads owned by the transaction caller.
 */
export function getFundSnapshotClaim(value: unknown, binding: FundSnapshotClaimBinding, beneficiary: Address): {
  manifest: FundSnapshotManifest
  claim: FundSnapshotClaim | null
} {
  const manifest = parseFundSnapshotManifest(value)
  const holder = address(beneficiary, 'claim beneficiary')
  if (manifest.destinationChainId !== binding.chainId || manifest.snapshot.chainId !== binding.chainId || !isAddressEqual(manifest.helper, binding.deployer) ||
    BigInt(manifest.snapshot.projectId) !== binding.fundProjectId || BigInt(manifest.snapshot.blockNumber) !== binding.snapshotBlockNumber || manifest.snapshot.blockHash !== hash(binding.snapshotBlockHash, 'vault snapshot block') ||
    BigInt(manifest.snapshot.totalFundSupply) !== binding.totalFundSupply || manifest.launchSalt !== hash(binding.launchSalt, 'vault launch salt') ||
    manifest.merkleRoot !== hash(binding.merkleRoot, 'vault Merkle root') || BigInt(manifest.leafCount) !== binding.leafCount || manifest.distributionId !== hash(binding.distributionId, 'vault distribution ID') ||
    binding.initialIncomeSupply !== INITIAL_INCOME_SUPPLY || fundSnapshotManifestHash(manifest) !== hash(binding.manifestHash, 'vault manifest')) throw new Error('The manifest does not match the verified initial INCOME vault commitments.')
  const entry = manifest.holders.find(candidate => isAddressEqual(candidate.beneficiary, holder))
  if (!entry?.claimable) return { manifest, claim: null }
  return {
    manifest,
    claim: { index: BigInt(entry.index), beneficiary: entry.beneficiary, fundBalance: BigInt(entry.fundBalance), incomeAmount: BigInt(entry.incomeAmount), proof: [...entry.proof] },
  }
}

/** Independently reconstruct the same pinned ownership, not an indexer promise. */
export async function verifyFundSnapshotHistory(client: PublicClient, value: unknown, options: Pick<FundSnapshotInput, 'signal' | 'onProgress' | 'logBlockWindow' | 'logResponseLimit'> = {}): Promise<FundSnapshotManifest> {
  const manifest = parseFundSnapshotManifest(value)
  const snapshot = await readFundOwnershipSnapshot(client, {
    ...options, chainId: manifest.snapshot.chainId as JBChainId, projectId: BigInt(manifest.snapshot.projectId),
    snapshotBlockNumber: BigInt(manifest.snapshot.blockNumber), creationBlockNumber: BigInt(manifest.snapshot.creationBlockNumber),
  })
  const verified = buildFundSnapshotManifest(snapshot, { destinationChainId: manifest.destinationChainId, helper: manifest.helper, launchSalt: manifest.launchSalt })
  // The published manifest hash also commits to credit/ERC-20 decomposition,
  // provenance and timestamp. Matching the Merkle root alone does not verify
  // those fields; reject any difference instead of silently replacing metadata.
  if (fundSnapshotManifestHash(verified) !== fundSnapshotManifestHash(manifest)) throw new Error('The manifest does not match independently reconstructed canonical FUND ownership.')
  return verified
}
