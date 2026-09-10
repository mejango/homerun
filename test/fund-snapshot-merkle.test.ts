import assert from 'node:assert/strict'
import { test } from 'vitest'
import { concatHex, keccak256, toHex, zeroAddress, zeroHash, type Address, type Hex } from 'viem'
import {
  buildFundDistributionId, buildFundMerkleTree, fundSnapshotLeaf, verifyFundMerkleProof,
  type FundDistributionDomain, type FundSnapshotEntry,
} from '../src/lib/fund-snapshot-merkle'

const maxUint256 = (1n << 256n) - 1n
const bytes32 = (byte: string) => `0x${byte.repeat(32)}` as Hex
const address = (value: bigint) => toHex(value, { size: 20 }) as Address
const domain: FundDistributionDomain = {
  destinationChainId: 8453n,
  helper: '0x1111111111111111111111111111111111111111',
  fundProjectId: 7n,
  snapshotBlockNumber: 123456n,
  snapshotBlockHash: bytes32('ab'),
  totalFundSupply: 1000000n,
  launchSalt: bytes32('cd'),
}
const distributionId = '0xa2d3cbc29e141d32d37885075972f0606bbbec9a27e012df35bb0fc36873d0de' as const
const entries: readonly FundSnapshotEntry[] = [
  { index: 7n, beneficiary: address(1n), fundBalance: 123n, incomeAmount: 17n },
  { index: 2n, beneficiary: address(2n), fundBalance: 456n, incomeAmount: 0n },
  { index: 10n, beneficiary: address(3n), fundBalance: 789n, incomeAmount: 333n },
  { index: 3n, beneficiary: address(4n), fundBalance: 1n << 96n, incomeAmount: 1n << 100n },
  { index: 9n, beneficiary: zeroAddress, fundBalance: 1n, incomeAmount: 1n },
]

// Generated using @openzeppelin/merkle-tree 1.0.5 StandardMerkleTree.of(values,
// ['bytes32', 'uint256', 'address', 'uint256', 'uint256']). Static fixtures keep
// the reference implementation independent without requiring a sibling repo.
const canonicalRoot = '0x8c5aa0fafb8c0ace14845906240cb13806bc340ed04749c0b06d76b283acbc69' as const
const canonicalProofs: Hex[][] = [
  [
    '0xa1f2ebac76d166a0753320c5f50333a0963989b2d58a352cf217f012c1ff7bf2',
    '0xc6b6125fe2c846b896c7ae6153096ca903692c684c8aba6f251fc4ea9265f6c6',
  ],
  [
    '0x73539bffb0e657154e8f3b72f6b6afabf4337c858a36418f290892b3d3f4ca90',
    '0xeb2e8ffa97d2bcd7ce55e6abf3b8067fa4568d613cedf748aa501eae54cadec6',
  ],
  [
    '0x66fba48e38a37f369329bf759dedbce69e59c21ccfb854473a05d9d4ddd60bd9',
    '0xe0cf5b87d3e15d249ea3204efb946df29afa6950703500cd700353574caea7a8',
    '0xeb2e8ffa97d2bcd7ce55e6abf3b8067fa4568d613cedf748aa501eae54cadec6',
  ],
  [
    '0x7d66a3ebb37af729777b4e70193250473b41e6f24dd6dd284892e5b4b95d2387',
    '0xc6b6125fe2c846b896c7ae6153096ca903692c684c8aba6f251fc4ea9265f6c6',
  ],
  [
    '0x27c9281d58817103f21414b8e61308aeb792a700f88682a2bdb2d287bd4511fa',
    '0xe0cf5b87d3e15d249ea3204efb946df29afa6950703500cd700353574caea7a8',
    '0xeb2e8ffa97d2bcd7ce55e6abf3b8067fa4568d613cedf748aa501eae54cadec6',
  ],
]

// These helpers concatenate ABI words directly, independently of the source's
// encodeAbiParameters schema. In particular, addresses occupy a full word.
const word = (value: bigint) => toHex(value, { size: 32 })
const addressWord = (value: Address) => `0x${value.slice(2).padStart(64, '0')}` as Hex

test('distribution domain matches manual Solidity ABI encoding and its fixed hash', () => {
  const typeHash = keccak256(toHex('HomerunInitialIncome(uint256 chainId,address deployer,uint256 fundProjectId,uint256 snapshotBlockNumber,bytes32 snapshotBlockHash,uint256 totalFundSupply,bytes32 salt)'))
  assert.equal(typeHash, '0x26676a0e430bc5412e9d7cf23621563fbe72e28fef6ddf2b6afde2f3245042a4')
  const encoded = concatHex([
    typeHash, word(8453n), addressWord(domain.helper), word(domain.fundProjectId),
    word(domain.snapshotBlockNumber), domain.snapshotBlockHash, word(domain.totalFundSupply), domain.launchSalt,
  ])
  assert.equal(keccak256(encoded), distributionId)
  assert.equal(buildFundDistributionId(domain), distributionId)
  assert.equal(buildFundDistributionId({ ...domain, destinationChainId: 8453 }), distributionId)
})

test('every distribution domain field prevents replay against another campaign or snapshot', () => {
  const changes: Partial<FundDistributionDomain>[] = [
    { destinationChainId: 1n }, { helper: address(99n) }, { fundProjectId: 8n },
    { snapshotBlockNumber: 123457n }, { snapshotBlockHash: bytes32('ac') },
    { totalFundSupply: 1000001n }, { launchSalt: bytes32('ce') },
  ]
  const ids = changes.map(change => buildFundDistributionId({ ...domain, ...change }))
  assert.equal(new Set([distributionId, ...ids]).size, changes.length + 1)
  for (const id of ids) {
    assert.equal(verifyFundMerkleProof(id, entries[0], canonicalProofs[0], canonicalRoot), false)
  }
})

test('leaf uses a double hash of ABI encoded domain, index, beneficiary, FUND and INCOME', () => {
  const entry = entries[0]
  const encoded = concatHex([
    distributionId, word(entry.index), addressWord(entry.beneficiary), word(entry.fundBalance), word(entry.incomeAmount),
  ])
  const inner = keccak256(encoded)
  const expected = keccak256(inner)
  assert.equal(expected, '0x7d66a3ebb37af729777b4e70193250473b41e6f24dd6dd284892e5b4b95d2387')
  assert.equal(fundSnapshotLeaf(distributionId, entry), expected)
  assert.notEqual(expected, inner)
  const packed = concatHex([
    distributionId, word(entry.index), entry.beneficiary, word(entry.fundBalance), word(entry.incomeAmount),
  ])
  assert.notEqual(expected, keccak256(keccak256(packed)))
})

test('root and every odd-tree proof match genuine OpenZeppelin fixtures in caller entry order', () => {
  const tree = buildFundMerkleTree(distributionId, entries)
  assert.equal(tree.root, canonicalRoot)
  assert.deepEqual(tree.proofs, canonicalProofs)
  for (const [index, entry] of entries.entries()) {
    assert.equal(verifyFundMerkleProof(distributionId, entry, canonicalProofs[index], canonicalRoot), true)
  }
  assert.deepEqual(tree.proofs.map(proof => proof.length), [2, 2, 3, 2, 3])
})

test('globally sorted leaves give the same root under arbitrary input permutations', () => {
  const shuffled = [entries[4], entries[1], entries[3], entries[0], entries[2]]
  const frozen = Object.freeze(shuffled.map(entry => Object.freeze({ ...entry })))
  const tree = buildFundMerkleTree(distributionId, frozen)
  assert.equal(tree.root, canonicalRoot)
  for (const [index, entry] of frozen.entries()) {
    assert.deepEqual(tree.proofs[index], canonicalProofs[entries.indexOf(shuffled[index])])
    assert.equal(verifyFundMerkleProof(distributionId, entry, tree.proofs[index], tree.root), true)
  }
})

const sizeFixtures = [
  [1, '0x2fa94d296d9b3318a181961f248bb64af908e24bca0862592d25d9a58a20f262'],
  [2, '0xc84465ff692d5575b39cfdf5cc3bde63fc2993c07ec0beb70ef61d5e8eeba86e'],
  [3, '0x47308ed03f472e7ea44378d5363de7f1c2996cc22dec5a379a7b36a515c3fbc3'],
  [5, '0x342fae23a15f9b8ff6e878a1818e30e66450c81e298ac7a00be613a14187fa29'],
  [17, '0xce9aefb304a604807a44808371474f81812b0638fe993d297d66561f9d71297a'],
  [257, '0x003e201946fcf125b80e90797666af745a89d7439acfe4c31de11a56d12aaed3'],
] as const

for (const [size, expectedRoot] of sizeFixtures) {
  test(`${size} recipients match the OpenZeppelin root with no 200-holder launch limit`, () => {
    const recipients = Array.from({ length: size }, (_, index) => ({
      index: BigInt(index), beneficiary: address(BigInt(index)), fundBalance: BigInt(index + 1), incomeAmount: BigInt(index % 7),
    }))
    const tree = buildFundMerkleTree(distributionId, recipients)
    assert.equal(tree.root, expectedRoot)
    assert.equal(tree.proofs.length, size)
    for (const [index, entry] of recipients.entries()) {
      assert.equal(verifyFundMerkleProof(distributionId, entry, tree.proofs[index], tree.root), true)
    }
    if (size === 1) assert.deepEqual(tree.proofs, [[]])
  })
}

test('each leaf field and the root are authenticated, including a zero-INCOME entitlement', () => {
  for (const [index, entry] of entries.entries()) {
    const mutations: FundSnapshotEntry[] = [
      { ...entry, index: entry.index + 1n }, { ...entry, beneficiary: address(100n) },
      { ...entry, fundBalance: entry.fundBalance + 1n }, { ...entry, incomeAmount: entry.incomeAmount + 1n },
    ]
    for (const mutation of mutations) {
      assert.equal(verifyFundMerkleProof(distributionId, mutation, canonicalProofs[index], canonicalRoot), false)
    }
    assert.equal(verifyFundMerkleProof(distributionId, entry, canonicalProofs[index], bytes32('ff')), false)
  }
})

test('proof verification rejects missing, reordered, substituted and appended siblings', () => {
  for (const [index, proof] of canonicalProofs.entries()) {
    const entry = entries[index]
    for (let sibling = 0; sibling < proof.length; sibling++) {
      assert.equal(verifyFundMerkleProof(distributionId, entry, proof.filter((_, i) => i !== sibling), canonicalRoot), false)
      const substituted = proof.map((hash, i) => i === sibling ? bytes32('fe') : hash)
      assert.equal(verifyFundMerkleProof(distributionId, entry, substituted, canonicalRoot), false)
    }
    assert.equal(verifyFundMerkleProof(distributionId, entry, [...proof].reverse(), canonicalRoot), false)
    assert.equal(verifyFundMerkleProof(distributionId, entry, [...proof, bytes32('aa')], canonicalRoot), false)
    assert.equal(verifyFundMerkleProof(distributionId, entry, [], canonicalRoot), false)
  }
})

test('zero-address FUND credits and zero-INCOME leaves are retained, and uint256 bounds are exact', () => {
  const entry = { index: maxUint256, beneficiary: zeroAddress, fundBalance: maxUint256, incomeAmount: 0n }
  const tree = buildFundMerkleTree(distributionId, [entry])
  assert.equal(tree.root, fundSnapshotLeaf(distributionId, entry))
  assert.equal(verifyFundMerkleProof(distributionId, entry, [], tree.root), true)
  const largestIncome = { ...entry, incomeAmount: maxUint256 }
  assert.equal(verifyFundMerkleProof(distributionId, largestIncome, [], fundSnapshotLeaf(distributionId, largestIncome)), true)
  assert.doesNotThrow(() => buildFundDistributionId({
    ...domain, destinationChainId: maxUint256, fundProjectId: maxUint256,
    snapshotBlockNumber: maxUint256, totalFundSupply: maxUint256,
  }))
})

test('duplicate indexes and beneficiary addresses cannot create ambiguous claim leaves', () => {
  assert.throws(() => buildFundMerkleTree(distributionId, [entries[0], { ...entries[1], index: entries[0].index }]))
  assert.throws(() => buildFundMerkleTree(distributionId, [entries[0], { ...entries[1], beneficiary: entries[0].beneficiary }]))
  const beneficiary = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as const
  assert.throws(() => buildFundMerkleTree(distributionId, [
    { ...entries[0], beneficiary }, { ...entries[1], beneficiary: `0x${beneficiary.slice(2).toUpperCase()}` },
  ]))
  assert.throws(() => buildFundMerkleTree(distributionId, [
    { ...entries[0], beneficiary: zeroAddress }, { ...entries[1], beneficiary: zeroAddress },
  ]))
  assert.throws(() => buildFundMerkleTree(distributionId, []))
})

test('domain construction rejects malformed identifiers and numeric values instead of coercing them', () => {
  const badHashes = [zeroHash, '0x', '0x12', `0x${'gg'.repeat(32)}`, bytes32('ab').slice(2), `${bytes32('ab')}00`, null, undefined]
  for (const key of ['snapshotBlockHash', 'launchSalt'] as const) {
    for (const value of badHashes) assert.throws(() => buildFundDistributionId({ ...domain, [key]: value } as FundDistributionDomain))
  }
  for (const helper of [zeroAddress, '0x1234', `0x${'gg'.repeat(20)}`, null, undefined]) {
    assert.throws(() => buildFundDistributionId({ ...domain, helper } as FundDistributionDomain))
  }
  const badIntegers = [0n, -1n, maxUint256 + 1n, 1.5, NaN, Infinity, '1', null, undefined]
  for (const key of ['fundProjectId', 'snapshotBlockNumber', 'totalFundSupply'] as const) {
    for (const value of [...badIntegers, 1]) {
      assert.throws(() => buildFundDistributionId({ ...domain, [key]: value } as FundDistributionDomain))
    }
  }
  for (const value of [...badIntegers, 0, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => buildFundDistributionId({ ...domain, destinationChainId: value } as FundDistributionDomain))
  }
})

test('leaf constructors throw and verifiers fail closed for invalid runtime entry fields', () => {
  const base = entries[0]
  const malformed: unknown[] = [null, undefined, {}, [], { ...base, beneficiary: null }, { ...base, beneficiary: '0x1234' }]
  for (const key of ['index', 'fundBalance', 'incomeAmount'] as const) {
    for (const value of [-1n, maxUint256 + 1n, 1, 1.5, NaN, Infinity, '1', null, undefined]) {
      malformed.push({ ...base, [key]: value })
    }
  }
  for (const value of malformed) {
    const entry = value as FundSnapshotEntry
    assert.throws(() => fundSnapshotLeaf(distributionId, entry))
    assert.throws(() => buildFundMerkleTree(distributionId, [entry]))
    assert.equal(verifyFundMerkleProof(distributionId, entry, canonicalProofs[0], canonicalRoot), false)
  }
})

test('invalid domains, roots, siblings and oversized proofs fail closed without throwing', () => {
  const invalidHashes = [zeroHash, '0x', '0x12', `0x${'zz'.repeat(32)}`, `${canonicalRoot}00`, null, undefined]
  for (const value of invalidHashes) {
    assert.throws(() => fundSnapshotLeaf(value as Hex, entries[0]))
    assert.throws(() => buildFundMerkleTree(value as Hex, entries))
    assert.equal(verifyFundMerkleProof(value as Hex, entries[0], canonicalProofs[0], canonicalRoot), false)
    assert.equal(verifyFundMerkleProof(distributionId, entries[0], canonicalProofs[0], value as Hex), false)
    assert.equal(verifyFundMerkleProof(distributionId, entries[0], [value as Hex], canonicalRoot), false)
  }
  for (const proof of [null, undefined, {}, canonicalRoot, [undefined], new Array(161).fill(bytes32('aa'))]) {
    assert.equal(verifyFundMerkleProof(distributionId, entries[0], proof as readonly Hex[], canonicalRoot), false)
  }
})

test('the proof-depth bound rejects a cryptographically valid 161-level path but permits 160', () => {
  const entry = entries[0]
  const proof: Hex[] = []
  let root = fundSnapshotLeaf(distributionId, entry)
  for (let depth = 1; depth <= 161; depth++) {
    const sibling = keccak256(word(BigInt(depth)))
    proof.push(sibling)
    root = keccak256(concatHex(root < sibling ? [root, sibling] : [sibling, root]))
    if (depth === 160) assert.equal(verifyFundMerkleProof(distributionId, entry, proof, root), true)
  }
  assert.equal(verifyFundMerkleProof(distributionId, entry, proof, root), false)
})
