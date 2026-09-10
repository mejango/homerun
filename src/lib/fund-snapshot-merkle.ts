import {
  concatHex, encodeAbiParameters, getAddress, isAddress, keccak256, stringToHex,
  zeroAddress, zeroHash, type Address, type Hex,
} from 'viem'

export type FundDistributionDomain = {
  destinationChainId: number | bigint
  helper: Address
  fundProjectId: bigint
  snapshotBlockNumber: bigint
  snapshotBlockHash: Hex
  totalFundSupply: bigint
  launchSalt: Hex
}

export type FundSnapshotEntry = {
  index: bigint
  beneficiary: Address
  fundBalance: bigint
  incomeAmount: bigint
}

const UINT256_MAX = (1n << 256n) - 1n
/** Matches the claim contract. There is no 200-holder limit. */
const MAX_PROOF_LENGTH = 160
const DISTRIBUTION_TYPE_HASH = keccak256(stringToHex(
  'HomerunInitialIncome(uint256 chainId,address deployer,uint256 fundProjectId,uint256 snapshotBlockNumber,bytes32 snapshotBlockHash,uint256 totalFundSupply,bytes32 salt)',
))

function checkedUint256(value: bigint, label: string, positive = false): bigint {
  if (typeof value !== 'bigint' || value < (positive ? 1n : 0n) || value > UINT256_MAX) {
    throw new Error(`${label} must be ${positive ? 'a positive' : 'an unsigned'} uint256.`)
  }
  return value
}

function checkedHash(value: Hex, label: string): Hex {
  if (typeof value !== 'string' || !/^0x[\da-fA-F]{64}$/.test(value) || value.toLowerCase() === zeroHash) {
    throw new Error(`${label} must be a nonzero bytes32 hash.`)
  }
  return value.toLowerCase() as Hex
}

function checkedAddress(value: Address, label: string, allowZero = false): Address {
  if (typeof value !== 'string' || !isAddress(value) || (!allowZero && value.toLowerCase() === zeroAddress)) {
    throw new Error(`A valid ${allowZero ? '' : 'nonzero '}${label} address is required.`)
  }
  return getAddress(value)
}

/** Binds the allocation to one helper, FUND snapshot, destination chain and launch. */
export function buildFundDistributionId(input: FundDistributionDomain): Hex {
  const chainId = typeof input.destinationChainId === 'number'
    ? (Number.isSafeInteger(input.destinationChainId) ? BigInt(input.destinationChainId) : -1n)
    : input.destinationChainId
  return keccak256(encodeAbiParameters(
    [
      { type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }, { type: 'uint256' },
      { type: 'uint256' }, { type: 'bytes32' }, { type: 'uint256' }, { type: 'bytes32' },
    ],
    [
      DISTRIBUTION_TYPE_HASH,
      checkedUint256(chainId, 'Destination chain', true),
      checkedAddress(input.helper, 'deployment helper'),
      checkedUint256(input.fundProjectId, 'FUND project ID', true),
      checkedUint256(input.snapshotBlockNumber, 'Snapshot block number', true),
      checkedHash(input.snapshotBlockHash, 'Snapshot block hash'),
      checkedUint256(input.totalFundSupply, 'Total FUND supply', true),
      checkedHash(input.launchSalt, 'Launch salt'),
    ],
  ))
}

/** OpenZeppelin StandardMerkleTree's double-hashed, ABI-encoded leaf. */
export function fundSnapshotLeaf(distributionId: Hex, entry: FundSnapshotEntry): Hex {
  return keccak256(keccak256(encodeAbiParameters(
    [
      { type: 'bytes32' }, { type: 'uint256' }, { type: 'address' },
      { type: 'uint256' }, { type: 'uint256' },
    ],
    [
      checkedHash(distributionId, 'Distribution ID'),
      checkedUint256(entry.index, 'Snapshot index'),
      // JBTokens permits credit transfers to zero. Preserve that entitlement in
      // the complete snapshot even though nobody can claim it from the vault.
      checkedAddress(entry.beneficiary, 'beneficiary', true),
      // A fractional beneficial position may project to zero whole FUND atoms.
      // Exact ownership weights live in the committed global source manifest.
      checkedUint256(entry.fundBalance, 'FUND balance'),
      checkedUint256(entry.incomeAmount, 'INCOME allocation'),
    ],
  )))
}

/** Both inputs are canonical lowercase bytes32 hashes at this point. */
function hashPair(a: Hex, b: Hex): Hex {
  return keccak256(concatHex(a < b ? [a, b] : [b, a]))
}

/**
 * Exact OpenZeppelin StandardMerkleTree topology: sort leaf hashes, then fill a
 * complete binary tree from its final slot backwards. In particular, odd-sized
 * trees do not duplicate or promote a leaf as an extra level.
 *
 * proofs[i] always belongs to entries[i], regardless of leaf sorting. This
 * utility checks encoding and uniqueness; the manifest verifier must also
 * validate snapshot completeness, allocation totals and indexes < leafCount.
 */
export function buildFundMerkleTree(distributionId: Hex, entries: readonly FundSnapshotEntry[]): {
  root: Hex
  proofs: Hex[][]
} {
  checkedHash(distributionId, 'Distribution ID')
  if (!Array.isArray(entries) || entries.length === 0) throw new Error('A nonempty FUND snapshot is required.')
  const seenIndexes = new Set<bigint>()
  const seenBeneficiaries = new Set<string>()
  const leaves = entries.map((entry, position) => {
    const hash = fundSnapshotLeaf(distributionId, entry)
    const beneficiary = entry.beneficiary.toLowerCase()
    if (seenIndexes.has(entry.index)) throw new Error('Duplicate snapshot index.')
    if (seenBeneficiaries.has(beneficiary)) throw new Error('Duplicate FUND beneficiary.')
    seenIndexes.add(entry.index)
    seenBeneficiaries.add(beneficiary)
    return { hash, position }
  }).sort((a, b) => a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0)

  const tree = new Array<Hex>(2 * leaves.length - 1)
  const treeIndexes = new Array<number>(leaves.length)
  for (const [index, leaf] of leaves.entries()) {
    const treeIndex = tree.length - index - 1
    tree[treeIndex] = leaf.hash
    treeIndexes[leaf.position] = treeIndex
  }
  for (let index = leaves.length - 2; index >= 0; index--) {
    tree[index] = hashPair(tree[2 * index + 1], tree[2 * index + 2])
  }

  const proofs = treeIndexes.map(treeIndex => {
    const proof: Hex[] = []
    while (treeIndex > 0) {
      proof.push(tree[treeIndex % 2 === 0 ? treeIndex - 1 : treeIndex + 1])
      treeIndex = Math.floor((treeIndex - 1) / 2)
    }
    if (proof.length > MAX_PROOF_LENGTH) throw new Error('The snapshot proof exceeds the claim contract limit.')
    return proof
  })
  return { root: tree[0], proofs }
}

/** Fail closed for malformed or tampered imported proofs, including uint256 overflow. */
export function verifyFundMerkleProof(
  distributionId: Hex,
  entry: FundSnapshotEntry,
  proof: readonly Hex[],
  root: Hex,
): boolean {
  try {
    const expectedRoot = checkedHash(root, 'Merkle root')
    if (!Array.isArray(proof) || proof.length > MAX_PROOF_LENGTH) return false
    let hash = fundSnapshotLeaf(distributionId, entry)
    for (const sibling of proof) hash = hashPair(hash, checkedHash(sibling, 'Proof sibling'))
    return hash === expectedRoot
  } catch {
    return false
  }
}
