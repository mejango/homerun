import assert from 'node:assert/strict'
import { test, vi } from 'vitest'
import { suckerBranchRoot, suckerHashPair, suckerLeafHash, suckerLeafProof } from '@bananapus/nana-sdk-core/v6'
import { padHex, zeroAddress, zeroHash, type Address, type Hex, type PublicClient } from 'viem'
import { readFundGlobalSnapshotBridgeLane } from '../src/lib/fund-global-snapshot-bridges'

const sourceSucker = '0x1111111111111111111111111111111111111111' as const
const destinationSucker = '0x2222222222222222222222222222222222222222' as const
const alice = '0x3333333333333333333333333333333333333333' as const
const bob = '0x4444444444444444444444444444444444444444' as const
const carol = '0x5555555555555555555555555555555555555555' as const
const sourceToken = '0x6666666666666666666666666666666666666666' as const
const destinationToken = '0x7777777777777777777777777777777777777777' as const
const secondSourceToken = '0x8888888888888888888888888888888888888888' as const
const secondDestinationToken = '0x9999999999999999999999999999999999999999' as const
const sourceHash = `0x${'ab'.repeat(32)}` as Hex
const destinationHash = `0x${'cd'.repeat(32)}` as Hex
const corruptHash = `0x${'ef'.repeat(32)}` as Hex

type Leaf = { beneficiary: Hex; index: bigint; projectTokenCount: bigint; terminalTokenAmount: bigint; metadata: Hex }
type EventName = 'InsertToOutboxTree' | 'RootToRemote' | 'EmergencyExit' | 'NewInboxTreeRoot' | 'Claimed'
type EventLog = {
  address: Address; eventName: EventName; args: Record<string, unknown>; blockNumber: bigint; blockHash: Hex;
  transactionHash: Hex; transactionIndex: number; logIndex: number; removed: boolean
}
type LogRequest = { address: Address; event: { name: EventName }; fromBlock: bigint; toBlock: bigint; args?: unknown }
type ReadRequest = { address: Address; functionName: string; args?: readonly unknown[]; blockNumber?: bigint }
type Tree = ReturnType<typeof treeFixture>

function leaf(index: number, beneficiary: Address | Hex, amount: bigint): Leaf {
  return { index: BigInt(index), beneficiary: padHex(beneficiary, { size: 32 }), projectTokenCount: amount,
    terminalTokenAmount: amount * 1_000n, metadata: zeroHash }
}

function treeFixture(input: {
  sourceToken?: Address; destinationToken?: Address; leaves?: Leaf[];
  sends?: number[]; deliveries?: number[]; claimed?: number[];
  emergencies?: { beneficiary: Address; projectTokenCount: bigint; terminalTokenAmount?: bigint }[];
} = {}) {
  const leaves = input.leaves ?? [leaf(0, alice, 10n), leaf(1, bob, 20n), leaf(2, alice, 30n), leaf(3, carol, 40n), leaf(4, carol, 5n)]
  const hashes = leaves.map(suckerLeafHash)
  const roots = hashes.map((hash, index) => suckerBranchRoot(hash, suckerLeafProof(hashes.slice(0, index + 1), index), index))
  // Match MerkleLib's stored incremental branch, including slots retained after a carry.
  const branch: Hex[] = Array.from({ length: 32 }, () => zeroHash)
  for (let index = 0; index < hashes.length; index++) {
    let size = index + 1
    let node = hashes[index]
    for (let depth = 0; depth < 32; depth++) {
      if (size & 1) { branch[depth] = node; break }
      node = suckerHashPair(branch[depth], node)
      size >>= 1
    }
  }
  const sends = input.sends ?? [2, 3]
  const deliveries = input.deliveries ?? [1]
  const claimed = input.claimed ?? [0]
  const emergencies = input.emergencies ?? [{ beneficiary: carol, projectTokenCount: 40n }]
  const sentCount = sends.at(-1) ?? 0
  const outbox = {
    nonce: BigInt(sends.length), numberOfClaimsSent: BigInt(sentCount),
    balance: leaves.slice(sentCount).reduce((sum, item) => sum + item.terminalTokenAmount, 0n)
      - emergencies.reduce((sum, item) => sum + (item.terminalTokenAmount ?? item.projectTokenCount * 1_000n), 0n),
    tree: { count: BigInt(leaves.length), branch },
  }
  const nonce = deliveries.at(-1) ?? 0
  const inbox = { nonce: BigInt(nonce), root: nonce ? roots[sends[nonce - 1] - 1] : zeroHash }
  return { sourceToken: input.sourceToken ?? sourceToken, destinationToken: input.destinationToken ?? destinationToken,
    leaves, hashes, roots, sends, deliveries, claimed, emergencies, outbox, inbox,
    mapping: { enabled: false, emergencyHatch: true, minGas: 200_000, addr: padHex(input.destinationToken ?? destinationToken, { size: 32 }) } }
}

function fixture(trees: Tree[] = [treeFixture()]) {
  const sourceLogs: EventLog[] = []
  const destinationLogs: EventLog[] = []
  let nextLog = 0
  function log(side: 'source' | 'destination', eventName: EventName, args: Record<string, unknown>, blockNumber: bigint) {
    const index = nextLog++
    const entry: EventLog = { address: side === 'source' ? sourceSucker : destinationSucker, eventName, args, blockNumber,
      blockHash: side === 'source' ? sourceHash : destinationHash,
      transactionHash: padHex(`0x${(index + 1).toString(16)}`, { size: 32 }), transactionIndex: index, logIndex: index, removed: false }
    ;(side === 'source' ? sourceLogs : destinationLogs).push(entry)
    return entry
  }
  for (const tree of trees) {
    tree.leaves.forEach((item, index) => log('source', 'InsertToOutboxTree', {
      ...item, token: tree.sourceToken, hashed: tree.hashes[index], root: tree.roots[index], caller: alice,
    }, BigInt((index + 1) * 10)))
    tree.sends.forEach((count, index) => log('source', 'RootToRemote', {
      token: tree.sourceToken, index: BigInt(count - 1), nonce: BigInt(index + 1), root: tree.roots[count - 1], caller: alice,
    }, BigInt(count * 10 + 1 + index)))
    tree.deliveries.forEach((nonce, index) => log('destination', 'NewInboxTreeRoot', {
      token: tree.destinationToken, nonce: BigInt(nonce), root: tree.roots[tree.sends[nonce - 1] - 1], caller: alice,
    }, BigInt(60 + index * 10)))
    tree.claimed.forEach((index, order) => log('destination', 'Claimed', {
      ...tree.leaves[index], token: tree.destinationToken, caller: alice,
    }, BigInt(80 + order)))
    tree.emergencies.forEach((item, index) => log('source', 'EmergencyExit', {
      ...item, terminalTokenAmount: item.terminalTokenAmount ?? item.projectTokenCount * 1_000n, token: tree.sourceToken, caller: alice,
    }, BigInt(70 + index)))
  }
  const readOverride = new Map<string, unknown>()
  const executionOverrides = new Map<string, Hex>()
  const blockHashes = { source: sourceHash, destination: destinationHash }
  const chainIds = { source: 8453, destination: 10 }
  const sourceRead = vi.fn((request: ReadRequest) => read('source', request))
  const destinationRead = vi.fn((request: ReadRequest) => read('destination', request))
  async function read(side: 'source' | 'destination', request: ReadRequest): Promise<unknown> {
    assert.equal(request.blockNumber, side === 'source' ? 100n : 200n, 'every contract read must be pinned')
    assert.equal(request.address.toLowerCase(), side === 'source' ? sourceSucker : destinationSucker)
    const overrideKey = `${side}:${request.functionName}`
    if (readOverride.has(overrideKey)) return readOverride.get(overrideKey)
    if (request.functionName === 'projectId') return side === 'source' ? 7n : 19n
    if (request.functionName === 'peerChainId') return side === 'source' ? 10n : 8453n
    if (request.functionName === 'peer') return padHex(side === 'source' ? destinationSucker : sourceSucker, { size: 32 })
    const token = String(request.args?.[0]).toLowerCase()
    const tree = trees.find(item => (side === 'source' ? item.sourceToken : item.destinationToken).toLowerCase() === token)
    assert.ok(tree, `Unknown ${side} tree: ${request.functionName} ${token}`)
    if (request.functionName === 'outboxOf') return tree.outbox
    if (request.functionName === 'inboxOf') return tree.inbox
    if (request.functionName === 'remoteTokenFor') return side === 'source' ? tree.mapping : { ...tree.mapping, addr: padHex(tree.sourceToken, { size: 32 }) }
    if (request.functionName === 'executedLeafHashOf') {
      const index = Number(request.args?.[1])
      return executionOverrides.get(`${token}:${index}`) ?? (tree.claimed.includes(index) ? tree.hashes[index] : zeroHash)
    }
    throw new Error(`Unexpected ${side} RPC read: ${request.functionName}`)
  }
  let interceptLogs: ((side: 'source' | 'destination', request: LogRequest, logs: EventLog[]) => EventLog[] | Promise<EventLog[]>) | undefined
  async function logs(side: 'source' | 'destination', request: LogRequest) {
    assert.equal(request.address.toLowerCase(), side === 'source' ? sourceSucker : destinationSucker)
    assert.equal(request.args, undefined, 'all beneficiaries and token trees must be scanned')
    assert.ok(request.fromBlock >= 1n)
    assert.ok(request.toBlock <= (side === 'source' ? 100n : 200n))
    const result = (side === 'source' ? sourceLogs : destinationLogs).filter(item => item.eventName === request.event.name
      && item.blockNumber >= request.fromBlock && item.blockNumber <= request.toBlock)
    return interceptLogs ? interceptLogs(side, request, result) : result
  }
  const sourceGetLogs = vi.fn((request: LogRequest) => logs('source', request))
  const destinationGetLogs = vi.fn((request: LogRequest) => logs('destination', request))
  const sourceGetBlock = vi.fn(async ({ blockNumber }: { blockNumber: bigint }) => {
    assert.equal(blockNumber, 100n)
    return { number: 100n, hash: blockHashes.source }
  })
  const destinationGetBlock = vi.fn(async ({ blockNumber }: { blockNumber: bigint }) => {
    assert.equal(blockNumber, 200n)
    return { number: 200n, hash: blockHashes.destination }
  })
  const sourceClient = { getChainId: vi.fn(async () => chainIds.source), readContract: sourceRead, getLogs: sourceGetLogs, getBlock: sourceGetBlock } as unknown as PublicClient
  const destinationClient = { getChainId: vi.fn(async () => chainIds.destination), readContract: destinationRead, getLogs: destinationGetLogs, getBlock: destinationGetBlock } as unknown as PublicClient
  const input = { sourceClient, destinationClient, sourceChainId: 8453 as const, destinationChainId: 10 as const,
    sourceProjectId: 7n, destinationProjectId: 19n, sourceSucker, destinationSucker,
    sourceBlockNumber: 100n, sourceBlockHash: sourceHash, destinationBlockNumber: 200n, destinationBlockHash: destinationHash,
    sourceCreationBlockNumber: 1n, destinationCreationBlockNumber: 1n }
  return { input, trees, sourceLogs, destinationLogs, sourceRead, destinationRead, sourceGetLogs, destinationGetLogs,
    sourceGetBlock, destinationGetBlock, blockHashes, chainIds, readOverride, executionOverrides, log,
    intercept(fn: NonNullable<typeof interceptLogs>) { interceptLogs = fn } }
}

test('counts claimed, delivered, sent and unsent FUND without counting emergency exits twice', async () => {
  const f = fixture()
  const result = await readFundGlobalSnapshotBridgeLane(f.input)
  assert.deepEqual(result.totals, { preparedFund: 105n, claimedFund: 10n, emergencyExitedFund: 40n, pendingFund: 55n })
  assert.deepEqual(result.entitlements, [
    { chainId: 10, projectId: 19n, beneficiary: alice, balance: 30n },
    { chainId: 10, projectId: 19n, beneficiary: bob, balance: 20n },
    { chainId: 10, projectId: 19n, beneficiary: carol, balance: 5n },
  ])
  const tree = result.trees[0]
  assert.equal(tree.sourceRoot, f.trees[0].roots.at(-1))
  assert.equal(tree.destinationRoot, f.trees[0].roots[1])
  assert.equal(tree.leafCount, 5n)
  assert.equal(tree.sentCount, 3n)
  assert.equal(tree.deliveredCount, 2n)
  assert.deepEqual(tree.leaves.map(item => item.state), ['claimed', 'delivered', 'sent', 'unsent', 'unsent'])
  assert.equal(tree.leaves[0].executionHash, f.trees[0].hashes[0])
  assert.equal(tree.leaves[1].executionHash, zeroHash)
  assert.equal(tree.emergencyExits.length, 1)
  assert.ok(result.evidence)
})

test('independently reconstructs every historical terminal-token tree and merges beneficiary entitlements', async () => {
  const second = treeFixture({ sourceToken: secondSourceToken, destinationToken: secondDestinationToken,
    leaves: [leaf(0, alice, 7n), leaf(1, bob, 3n)], sends: [], deliveries: [], claimed: [], emergencies: [] })
  const f = fixture([treeFixture(), second])
  const result = await readFundGlobalSnapshotBridgeLane(f.input)
  assert.equal(result.trees.length, 2)
  assert.equal(result.totals.pendingFund, 65n)
  assert.equal(result.entitlements.find(item => item.beneficiary === alice)?.balance, 37n)
  assert.equal(result.entitlements.find(item => item.beneficiary === bob)?.balance, 23n)
})

test('retains high-bit beneficiary hashes while aggregating their actual low-20-byte EVM recipients', async () => {
  const highAlice = `0x${'fe'.repeat(12)}${alice.slice(2)}` as Hex
  const highZero = `0x${'12'.repeat(12)}${'00'.repeat(20)}` as Hex
  const f = fixture([treeFixture({ leaves: [leaf(0, alice, 1n), leaf(1, highAlice, 2n), leaf(2, highZero, 3n)],
    sends: [], deliveries: [], claimed: [], emergencies: [] })])
  const result = await readFundGlobalSnapshotBridgeLane(f.input)
  assert.equal(result.trees[0].leaves[1].beneficiary, highAlice)
  assert.equal(result.trees[0].leaves[2].beneficiary, highZero)
  assert.equal(result.entitlements.find(item => item.beneficiary === alice)?.balance, 3n)
  assert.equal(result.entitlements.find(item => item.beneficiary === zeroAddress)?.balance, 3n)
  assert.equal(result.totals.pendingFund, 6n)
})

test('a never-used historical lane produces no adjustments', async () => {
  const f = fixture([])
  const result = await readFundGlobalSnapshotBridgeLane(f.input)
  assert.deepEqual(result.entitlements, [])
  assert.deepEqual(result.trees, [])
  assert.equal(result.totals.pendingFund, 0n)
})

test('fully claimed and fully emergency-exited trees contribute no pending entitlement', async () => {
  const claimed = treeFixture({ leaves: [leaf(0, alice, 7n)], sends: [1], deliveries: [1], claimed: [0], emergencies: [] })
  const exited = treeFixture({ sourceToken: secondSourceToken, destinationToken: secondDestinationToken,
    leaves: [leaf(0, bob, 3n)], sends: [], deliveries: [], claimed: [], emergencies: [{ beneficiary: bob, projectTokenCount: 3n }] })
  const result = await readFundGlobalSnapshotBridgeLane(fixture([claimed, exited]).input)
  assert.deepEqual(result.entitlements, [])
  assert.deepEqual(result.totals, { preparedFund: 10n, claimedFund: 7n, emergencyExitedFund: 3n, pendingFund: 0n })
})

test('retains FUND entitlement when its preparation recovered zero terminal tokens', async () => {
  const f = fixture([treeFixture({ leaves: [{ ...leaf(0, alice, 3n), terminalTokenAmount: 0n }],
    sends: [], deliveries: [], claimed: [], emergencies: [] })])
  const result = await readFundGlobalSnapshotBridgeLane(f.input)
  assert.equal(result.totals.pendingFund, 3n)
  assert.equal(result.trees[0].outboxBalance, 0n)
  assert.deepEqual(result.entitlements, [{ chainId: 10, projectId: 19n, beneficiary: alice, balance: 3n }])
})

test('does not aggregate distinct source trees into one normalized destination inbox', async () => {
  const second = treeFixture({ sourceToken: secondSourceToken, destinationToken: secondDestinationToken,
    leaves: [leaf(0, alice, 7n)], sends: [], deliveries: [], claimed: [], emergencies: [] })
  second.mapping.addr = `0x${'ff'.repeat(12)}${destinationToken.slice(2)}`
  await assert.rejects(() => readFundGlobalSnapshotBridgeLane(fixture([treeFixture(), second]).input))
})

test('rejects an omitted leaf even when later inserts and the outbox still exist', async () => {
  const f = fixture()
  f.sourceLogs.splice(f.sourceLogs.findIndex(item => item.eventName === 'InsertToOutboxTree' && item.args.index === 1n), 1)
  await assert.rejects(() => readFundGlobalSnapshotBridgeLane(f.input))
})

test('rejects duplicate leaf indices even if the duplicate has a different log identity', async () => {
  const f = fixture()
  f.log('source', 'InsertToOutboxTree', { ...f.sourceLogs[0].args }, 11n)
  await assert.rejects(() => readFundGlobalSnapshotBridgeLane(f.input))
})

for (const field of ['hashed', 'root', 'beneficiary', 'metadata', 'projectTokenCount', 'terminalTokenAmount'] as const) {
  test(`rejects insert ${field} inconsistent with the committed tree`, async () => {
    const f = fixture()
    f.sourceLogs[0].args[field] = field === 'projectTokenCount' || field === 'terminalTokenAmount' ? 999n : corruptHash
    await assert.rejects(() => readFundGlobalSnapshotBridgeLane(f.input))
  })
}

test('rejects outbox count inconsistent with dense events', async () => {
  const f = fixture()
  f.trees[0].outbox.tree.count += 1n
  await assert.rejects(() => readFundGlobalSnapshotBridgeLane(f.input))
})

test('rejects corruption in an active stored branch', async () => {
  const f = fixture()
  f.trees[0].outbox.tree.branch[2] = corruptHash
  await assert.rejects(() => readFundGlobalSnapshotBridgeLane(f.input))
})

test('rejects corruption in a stale branch slot, not only the current root', async () => {
  const f = fixture()
  // Count five only reads branch bits zero and two to compute its root.
  f.trees[0].outbox.tree.branch[1] = corruptHash
  await assert.rejects(() => readFundGlobalSnapshotBridgeLane(f.input))
})

test('rejects a destination claim outside the included source snapshot', async () => {
  const f = fixture()
  f.log('destination', 'Claimed', { ...leaf(9, alice, 99n), token: destinationToken, caller: alice }, 90n)
  await assert.rejects(() => readFundGlobalSnapshotBridgeLane(f.input))
})

test('rejects a destination tree with no included source tree', async () => {
  const f = fixture()
  f.log('destination', 'Claimed', { ...leaf(0, alice, 99n), token: secondDestinationToken, caller: alice }, 90n)
  await assert.rejects(() => readFundGlobalSnapshotBridgeLane(f.input))
})

test('rejects omitted destination claim logs even when the leaf execution hash proves settlement', async () => {
  const f = fixture()
  f.destinationLogs.splice(f.destinationLogs.findIndex(item => item.eventName === 'Claimed'), 1)
  await assert.rejects(() => readFundGlobalSnapshotBridgeLane(f.input))
})

test('rejects claim events whose pinned execution is absent or has another hash', async () => {
  for (const hash of [zeroHash, corruptHash]) {
    const f = fixture()
    f.executionOverrides.set(`${destinationToken}:0`, hash)
    await assert.rejects(() => readFundGlobalSnapshotBridgeLane(f.input))
  }
})

test('rejects altered or duplicated destination claims', async () => {
  const changed = fixture()
  changed.destinationLogs.find(item => item.eventName === 'Claimed')!.args.projectTokenCount = 11n
  await assert.rejects(() => readFundGlobalSnapshotBridgeLane(changed.input))
  const duplicate = fixture()
  duplicate.log('destination', 'Claimed', { ...duplicate.destinationLogs.find(item => item.eventName === 'Claimed')!.args }, 99n)
  await assert.rejects(() => readFundGlobalSnapshotBridgeLane(duplicate.input))
})

test('rejects a claim that appears before its first received root in destination event order', async () => {
  const f = fixture()
  f.destinationLogs.find(item => item.eventName === 'Claimed')!.blockNumber = 59n
  await assert.rejects(() => readFundGlobalSnapshotBridgeLane(f.input))
})

test('accepts a historical delivered root used for claims before a later inbox root arrives', async () => {
  const f = fixture([treeFixture({ sends: [2, 3], deliveries: [1, 2] })])
  const result = await readFundGlobalSnapshotBridgeLane(f.input)
  assert.equal(result.trees[0].deliveredCount, 3n)
  assert.equal(result.totals.claimedFund, 10n)
  assert.equal(result.totals.pendingFund, 55n)
})

test('accepts skipped destination nonces when a newer included source root arrived first', async () => {
  const f = fixture([treeFixture({ sends: [1, 2, 3], deliveries: [3] })])
  const result = await readFundGlobalSnapshotBridgeLane(f.input)
  assert.equal(result.trees[0].deliveredCount, 3n)
})

test('accepts resending an unchanged root under a later source nonce', async () => {
  const f = fixture([treeFixture({ sends: [2, 2, 3], deliveries: [1, 2] })])
  const result = await readFundGlobalSnapshotBridgeLane(f.input)
  assert.equal(result.trees[0].sentCount, 3n)
  assert.equal(result.trees[0].deliveredCount, 2n)
})

test('rejects an inbox root whose source send is outside the snapshot', async () => {
  const f = fixture()
  f.sourceLogs.splice(f.sourceLogs.findIndex(item => item.eventName === 'RootToRemote' && item.args.nonce === 1n), 1)
  await assert.rejects(() => readFundGlobalSnapshotBridgeLane(f.input))
})

test('rejects a source send with an uncommitted root or an out-of-range prefix', async () => {
  for (const change of [{ root: corruptHash }, { index: 999n }]) {
    const f = fixture()
    Object.assign(f.sourceLogs.find(item => item.eventName === 'RootToRemote')!.args, change)
    await assert.rejects(() => readFundGlobalSnapshotBridgeLane(f.input))
  }
})

test('rejects a source send before its last included leaf was prepared', async () => {
  const f = fixture()
  f.sourceLogs.find(item => item.eventName === 'RootToRemote')!.blockNumber = 19n
  await assert.rejects(() => readFundGlobalSnapshotBridgeLane(f.input))
})

test('rejects source nonce or sent-count storage inconsistent with send history', async () => {
  for (const change of [{ nonce: 3n }, { numberOfClaimsSent: 4n }]) {
    const f = fixture()
    Object.assign(f.trees[0].outbox, change)
    await assert.rejects(() => readFundGlobalSnapshotBridgeLane(f.input))
  }
})

test('rejects inbox storage inconsistent with accepted root history', async () => {
  for (const change of [{ nonce: 2n }, { root: corruptHash }]) {
    const f = fixture()
    Object.assign(f.trees[0].inbox, change)
    await assert.rejects(() => readFundGlobalSnapshotBridgeLane(f.input))
  }
})

test('rejects an emergency exit exceeding that beneficiary’s unclaimed preparation', async () => {
  const f = fixture()
  f.sourceLogs.find(item => item.eventName === 'EmergencyExit')!.args.projectTokenCount = 46n
  await assert.rejects(() => readFundGlobalSnapshotBridgeLane(f.input))
})

test('rejects emergency settlement of already-sent leaves even when the beneficiary has enough total preparations', async () => {
  const f = fixture()
  Object.assign(f.sourceLogs.find(item => item.eventName === 'EmergencyExit')!.args, { beneficiary: alice, projectTokenCount: 30n, terminalTokenAmount: 30_000n })
  await assert.rejects(() => readFundGlobalSnapshotBridgeLane(f.input))
})

test('rejects duplicated emergency exits that would subtract the same beneficiary’s unsent balance twice', async () => {
  const f = fixture()
  f.log('source', 'EmergencyExit', { ...f.sourceLogs.find(item => item.eventName === 'EmergencyExit')!.args }, 75n)
  await assert.rejects(() => readFundGlobalSnapshotBridgeLane(f.input))
})

test('rejects emergency exits before the beneficiary prepared their available leaves', async () => {
  const f = fixture()
  f.sourceLogs.find(item => item.eventName === 'EmergencyExit')!.blockNumber = 39n
  await assert.rejects(() => readFundGlobalSnapshotBridgeLane(f.input))
})

test('rejects missing emergency-exit history when the pinned outbox proves funds have left', async () => {
  const f = fixture()
  f.sourceLogs.splice(f.sourceLogs.findIndex(item => item.eventName === 'EmergencyExit'), 1)
  await assert.rejects(() => readFundGlobalSnapshotBridgeLane(f.input))
})

test('normalizes high-bit preparation recipients for emergency-exit subtraction', async () => {
  const highCarol = `0x${'ab'.repeat(12)}${carol.slice(2)}` as Hex
  const f = fixture([treeFixture({ leaves: [leaf(0, highCarol, 8n), leaf(1, carol, 2n)], sends: [], deliveries: [], claimed: [],
    emergencies: [{ beneficiary: carol, projectTokenCount: 8n }] })])
  const result = await readFundGlobalSnapshotBridgeLane(f.input)
  assert.equal(result.totals.pendingFund, 2n)
  assert.deepEqual(result.entitlements, [{ chainId: 10, projectId: 19n, beneficiary: carol, balance: 2n }])
})

test('scans complete bounded block windows without token or beneficiary filters', async () => {
  const f = fixture()
  const onProgress = vi.fn()
  await readFundGlobalSnapshotBridgeLane({ ...f.input, logBlockWindow: 17n, onProgress })
  for (const [calls, through, names] of [
    [f.sourceGetLogs.mock.calls, 100n, ['InsertToOutboxTree', 'EmergencyExit', 'RootToRemote']],
    [f.destinationGetLogs.mock.calls, 200n, ['Claimed', 'NewInboxTreeRoot']],
  ] as const) {
    for (const name of names) {
      const windows = calls.map(([request]) => request).filter(request => request.event.name === name)
      assert.equal(windows[0].fromBlock, 1n)
      assert.equal(windows.at(-1)!.toBlock, through)
      windows.forEach((window, index) => {
        assert.ok(window.toBlock - window.fromBlock < 17n)
        if (index) assert.equal(window.fromBlock, windows[index - 1].toBlock + 1n)
      })
    }
  }
  assert.ok(onProgress.mock.calls.length > 0)
})

test('bisects provider range errors and still reconstructs the complete tree', async () => {
  const f = fixture()
  f.intercept((_side, request, logs) => {
    if (request.toBlock - request.fromBlock > 20n) throw new Error('eth_getLogs block range exceeds maximum')
    return logs
  })
  const result = await readFundGlobalSnapshotBridgeLane({ ...f.input, logBlockWindow: 100n })
  assert.equal(result.totals.pendingFund, 55n)
  assert.ok(f.sourceGetLogs.mock.calls.some(([request]) => request.toBlock - request.fromBlock <= 20n))
})

test('bisects a saturated response instead of trusting a provider’s silent result cap', async () => {
  const f = fixture()
  f.intercept((_side, _request, logs) => logs.slice(0, 2))
  const result = await readFundGlobalSnapshotBridgeLane({ ...f.input, logResponseLimit: 2, logBlockWindow: 100n })
  assert.equal(result.totals.pendingFund, 55n)
  assert.ok(f.sourceGetLogs.mock.calls.length > 3)
})

test('fails closed when one block alone saturates the configured response limit', async () => {
  const f = fixture()
  f.sourceLogs.filter(item => item.eventName === 'InsertToOutboxTree').forEach(item => { item.blockNumber = 10n })
  f.intercept((_side, _request, logs) => logs.slice(0, 2))
  await assert.rejects(() => readFundGlobalSnapshotBridgeLane({ ...f.input, logResponseLimit: 2, logBlockWindow: 100n }))
})

test('propagates unavailable historical log errors when even the minimum range fails', async () => {
  const f = fixture()
  f.intercept(() => { throw new Error('historical logs unavailable') })
  await assert.rejects(() => readFundGlobalSnapshotBridgeLane({ ...f.input, logBlockWindow: 100n }))
})

test('rejects removed, wrong-contract, and out-of-range logs returned by the provider', async () => {
  for (const change of [{ removed: true }, { address: destinationSucker }, { blockNumber: 101n }]) {
    const f = fixture()
    f.intercept((side, request, logs) => side === 'source' && request.event.name === 'InsertToOutboxTree'
      ? [{ ...f.sourceLogs[0], ...change }, ...logs.slice(1)] : logs)
    await assert.rejects(() => readFundGlobalSnapshotBridgeLane(f.input))
  }
})

test('rejects cross-event duplicate positions instead of treating them as two independent records', async () => {
  const f = fixture()
  const insertion = f.sourceLogs.find(item => item.eventName === 'InsertToOutboxTree')!
  Object.assign(f.sourceLogs.find(item => item.eventName === 'EmergencyExit')!, {
    blockNumber: insertion.blockNumber, logIndex: insertion.logIndex,
  })
  await assert.rejects(() => readFundGlobalSnapshotBridgeLane(f.input))
})

test('rejects conflicting block hashes between different event categories in the same block', async () => {
  const f = fixture()
  const insertion = f.sourceLogs.find(item => item.eventName === 'InsertToOutboxTree')!
  Object.assign(f.sourceLogs.find(item => item.eventName === 'RootToRemote')!, {
    blockNumber: insertion.blockNumber, blockHash: corruptHash,
  })
  await assert.rejects(() => readFundGlobalSnapshotBridgeLane(f.input))
})

test('rejects chain ID mismatches on either RPC', async () => {
  for (const side of ['source', 'destination'] as const) {
    const f = fixture()
    f.chainIds[side] = 1
    await assert.rejects(() => readFundGlobalSnapshotBridgeLane(f.input))
  }
})

for (const side of ['source', 'destination'] as const) {
  for (const [functionName, value] of [['projectId', 999n], ['peerChainId', 1n], ['peer', padHex(alice, { size: 32 })]] as const) {
    test(`rejects ${side} ${functionName} identity mismatch`, async () => {
      const f = fixture()
      f.readOverride.set(`${side}:${functionName}`, value)
      await assert.rejects(() => readFundGlobalSnapshotBridgeLane(f.input))
    })
  }
  test(`rejects a ${side} snapshot hash mismatch`, async () => {
    const f = fixture()
    f.blockHashes[side] = corruptHash
    await assert.rejects(() => readFundGlobalSnapshotBridgeLane(f.input))
  })
  test(`rechecks the ${side} block hash after reading the history`, async () => {
    const f = fixture()
    f.intercept((_side, _request, logs) => { f.blockHashes[side] = corruptHash; return logs })
    await assert.rejects(() => readFundGlobalSnapshotBridgeLane(f.input))
  })
}

test('honors an already-aborted request before any RPC history work', async () => {
  const f = fixture()
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(() => readFundGlobalSnapshotBridgeLane({ ...f.input, signal: controller.signal }))
  assert.equal(f.sourceGetLogs.mock.calls.length, 0)
  assert.equal(f.destinationGetLogs.mock.calls.length, 0)
})

test('honors cancellation during a paginated history scan', async () => {
  const f = fixture()
  const controller = new AbortController()
  f.intercept((_side, _request, logs) => { controller.abort(); return logs })
  await assert.rejects(() => readFundGlobalSnapshotBridgeLane({ ...f.input, signal: controller.signal, logBlockWindow: 10n }))
})
