/**
 * One directed, historical stock V6 sucker lane at an explicit two-chain cut.
 * The graph reader must separately authenticate both suckers through canonical
 * registry/deployer history. These checks establish reciprocal identity, dense
 * outbox history, causal message inclusion, and exactly-once FUND accounting.
 *
 * RPC history remains an explicit offchain attestation: V6 has no enumerable
 * commitment to every terminal-token tree ever used by a sucker. A provider
 * silently omitting an entire tree cannot be disproved by its remaining logs.
 */
import {
  insertToSuckerOutboxEvent, jbSuckerV6ViewAbi, SUCKER_EMPTY_TREE_ROOT,
  SUCKER_MERKLE_DEPTH, suckerHashPair, suckerLeafHash, suckerZeroHashes,
} from '@bananapus/nana-sdk-core/v6'
import {
  getAbiItem, getAddress, isAddress, isAddressEqual, padHex, parseAbi, zeroHash,
  type AbiEvent, type Address, type Hex, type PublicClient,
} from 'viem'

const settlementAbi = parseAbi([
  'event EmergencyExit(address indexed beneficiary,address indexed token,uint256 terminalTokenAmount,uint256 projectTokenCount,address caller)',
  'event Claimed(bytes32 beneficiary,address token,uint256 projectTokenCount,uint256 terminalTokenAmount,uint256 index,bytes32 metadata,address caller)',
  'event NewInboxTreeRoot(address indexed token,uint64 nonce,bytes32 root,address caller)',
  'event RootToRemote(bytes32 indexed root,address indexed token,uint256 index,uint64 nonce,address caller)',
])

export type FundGlobalSnapshotBridgeProgress = {
  stage: 'history' | 'trees' | 'complete'
  completed: bigint
  total: bigint
  sourceChainId: number
  destinationChainId: number
}

export type FundGlobalSnapshotBridgeInput = {
  sourceClient: PublicClient
  destinationClient: PublicClient
  sourceChainId: number
  destinationChainId: number
  sourceProjectId: bigint
  destinationProjectId: bigint
  sourceSucker: Address
  destinationSucker: Address
  sourceBlockNumber: bigint
  sourceBlockHash: Hex
  destinationBlockNumber: bigint
  destinationBlockHash: Hex
  sourceCreationBlockNumber: bigint
  destinationCreationBlockNumber: bigint
  logBlockWindow?: bigint
  logResponseLimit?: number
  signal?: AbortSignal
  onProgress?: (progress: FundGlobalSnapshotBridgeProgress) => void
}

export type FundBridgeLogEvidence = {
  blockNumber: bigint
  blockHash: Hex
  transactionHash: Hex
  logIndex: number
}

export type FundGlobalSnapshotBridgeLeaf = FundBridgeLogEvidence & {
  index: bigint
  /** Exact committed bytes32. EVM minting truncates this to the low 20 bytes. */
  beneficiary: Hex
  evmBeneficiary: Address
  projectTokenCount: bigint
  terminalTokenAmount: bigint
  metadata: Hex
  hash: Hex
  root: Hex
  executionHash: Hex
  /** EmergencyExit does not identify an index, so it is reconciled in aggregate. */
  state: 'claimed' | 'delivered' | 'sent' | 'unsent'
  claim: FundBridgeLogEvidence | null
}

export type FundGlobalSnapshotBridgeEmergencyExit = FundBridgeLogEvidence & {
  beneficiary: Address
  projectTokenCount: bigint
  terminalTokenAmount: bigint
}

export type FundGlobalSnapshotBridgeTotals = {
  preparedFund: bigint
  claimedFund: bigint
  emergencyExitedFund: bigint
  pendingFund: bigint
}

export type FundGlobalSnapshotBridgeTree = FundGlobalSnapshotBridgeTotals & {
  sourceToken: Address
  destinationToken: Address
  remoteToken: Hex
  leafCount: bigint
  sourceRoot: Hex
  sourceBranch: readonly Hex[]
  destinationRoot: Hex
  sourceNonce: bigint
  destinationNonce: bigint
  sentCount: bigint
  deliveredCount: bigint
  outboxBalance: bigint
  leaves: FundGlobalSnapshotBridgeLeaf[]
  emergencyExits: FundGlobalSnapshotBridgeEmergencyExit[]
  sentRoots: (FundBridgeLogEvidence & { nonce: bigint; root: Hex; count: bigint })[]
  receivedRoots: (FundBridgeLogEvidence & { nonce: bigint; root: Hex; count: bigint })[]
}

export type FundGlobalSnapshotBridgeLane = Pick<FundGlobalSnapshotBridgeInput,
  'sourceChainId' | 'destinationChainId' | 'sourceProjectId' | 'destinationProjectId' |
  'sourceSucker' | 'destinationSucker' | 'sourceBlockNumber' | 'sourceBlockHash' |
  'destinationBlockNumber' | 'destinationBlockHash'> & {
  entitlements: { chainId: number; projectId: bigint; beneficiary: Address; balance: bigint }[]
  trees: FundGlobalSnapshotBridgeTree[]
  totals: FundGlobalSnapshotBridgeTotals
  evidence: {
    sourceCreationBlockNumber: bigint
    destinationCreationBlockNumber: bigint
    eventCounts: Record<string, number>
    rpcCompleteHistoryAttestation: true
    historyPolicy: 'canonical-rpc-history-with-pinned-tree-and-settlement-checks'
    emergencyExitPolicy: 'aggregate-by-source-token-and-low-20-byte-beneficiary'
  }
}

type HistoryLog = FundBridgeLogEvidence & { address: Address; args: Record<string, unknown> }
const zeroTotals = (): FundGlobalSnapshotBridgeTotals => ({ preparedFund: 0n, claimedFund: 0n, emergencyExitedFund: 0n, pendingFund: 0n })
const sameHex = (left: Hex, right: Hex) => left.toLowerCase() === right.toLowerCase()

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('The global FUND bridge snapshot was cancelled.')
}

function uint(value: unknown, label: string, bits = 256): bigint {
  if (typeof value !== 'bigint' || value < 0n || value >= 1n << BigInt(bits)) throw new Error(`Invalid ${label} in FUND bridge evidence.`)
  return value
}

function hash(value: unknown, label: string): Hex {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error(`Invalid ${label} in FUND bridge evidence.`)
  return value.toLowerCase() as Hex
}

function address(value: unknown, label: string): Address {
  if (typeof value !== 'string' || !isAddress(value, { strict: false })) throw new Error(`Invalid ${label} in FUND bridge evidence.`)
  return getAddress(value)
}

/** Matches JBSucker._toAddress, including nonzero upper bytes and address zero. */
function beneficiaryAddress(value: Hex): Address {
  return getAddress(`0x${value.slice(-40)}`)
}

function evidence(log: HistoryLog): FundBridgeLogEvidence {
  return { blockNumber: log.blockNumber, blockHash: log.blockHash, transactionHash: log.transactionHash, logIndex: log.logIndex }
}

function precedes(left: FundBridgeLogEvidence, right: FundBridgeLogEvidence): boolean {
  return left.blockNumber < right.blockNumber || (left.blockNumber === right.blockNumber && left.logIndex < right.logIndex)
}

async function all<T>(promises: Promise<T>[]): Promise<T[]> {
  const results = await Promise.allSettled(promises)
  return results.map(result => {
    if (result.status === 'rejected') throw result.reason
    return result.value
  })
}

async function logsInRange(client: PublicClient, input: {
  address: Address; event: AbiEvent; fromBlock: bigint; toBlock: bigint; limit: number; signal?: AbortSignal
}): Promise<HistoryLog[]> {
  checkAbort(input.signal)
  let rawLogs: Awaited<ReturnType<PublicClient['getLogs']>>
  try {
    rawLogs = await client.getLogs({ address: input.address, event: input.event, fromBlock: input.fromBlock, toBlock: input.toBlock, strict: true })
  } catch (reason) {
    checkAbort(input.signal)
    if (input.fromBlock === input.toBlock) throw new Error(`Complete ${input.event.name} bridge history could not be read at block ${input.fromBlock}.`, { cause: reason })
    const middle = (input.fromBlock + input.toBlock) / 2n
    const left = await logsInRange(client, { ...input, toBlock: middle })
    const right = await logsInRange(client, { ...input, fromBlock: middle + 1n })
    return [...left, ...right]
  }
  checkAbort(input.signal)
  if (rawLogs.length >= input.limit) {
    if (input.fromBlock === input.toBlock) throw new Error(`The RPC may have truncated ${input.event.name} bridge history in one block. Complete log responses are required.`)
    const middle = (input.fromBlock + input.toBlock) / 2n
    const left = await logsInRange(client, { ...input, toBlock: middle })
    const right = await logsInRange(client, { ...input, fromBlock: middle + 1n })
    return [...left, ...right]
  }
  return rawLogs.map(raw => {
    const log = raw as unknown as HistoryLog & { removed?: boolean; eventName?: string }
    if (log.removed || !isAddressEqual(address(log.address, 'log emitter'), input.address) ||
      typeof log.blockNumber !== 'bigint' || log.blockNumber < input.fromBlock || log.blockNumber > input.toBlock ||
      !Number.isSafeInteger(log.logIndex) || log.logIndex < 0 || !log.args ||
      (log.eventName !== undefined && log.eventName !== input.event.name)) throw new Error('The RPC returned inconsistent FUND bridge history.')
    return { ...log, blockHash: hash(log.blockHash, 'log block hash'), transactionHash: hash(log.transactionHash, 'log transaction hash') }
  })
}

async function scanHistory(client: PublicClient, input: {
  address: Address; event: AbiEvent; fromBlock: bigint; toBlock: bigint; window: bigint; limit: number; signal?: AbortSignal
}): Promise<HistoryLog[]> {
  const logs: HistoryLog[] = []
  for (let fromBlock = input.fromBlock; fromBlock <= input.toBlock; fromBlock += input.window) {
    const end = fromBlock + input.window - 1n
    logs.push(...await logsInRange(client, { ...input, fromBlock, toBlock: end < input.toBlock ? end : input.toBlock }))
  }
  logs.sort((left, right) => left.blockNumber === right.blockNumber ? left.logIndex - right.logIndex : left.blockNumber < right.blockNumber ? -1 : 1)
  return logs
}

function assertConsistentLogs(groups: HistoryLog[][], snapshotBlockNumber: bigint, snapshotBlockHash: Hex): void {
  const positions = new Set<string>()
  const blocks = new Map<bigint, Hex>([[snapshotBlockNumber, snapshotBlockHash]])
  for (const log of groups.flat()) {
    const position = `${log.blockNumber}:${log.logIndex}`
    if (positions.has(position)) throw new Error('The RPC returned duplicate FUND bridge log positions.')
    positions.add(position)
    const previousHash = blocks.get(log.blockNumber)
    if (previousHash && !sameHex(previousHash, log.blockHash)) throw new Error('The RPC returned conflicting FUND bridge block hashes.')
    blocks.set(log.blockNumber, log.blockHash)
  }
}

function groupByToken(logs: HistoryLog[]): Map<string, HistoryLog[]> {
  const groups = new Map<string, HistoryLog[]>()
  for (const log of logs) {
    const token = address(log.args.token, 'terminal token').toLowerCase()
    const group = groups.get(token)
    if (group) group.push(log)
    else groups.set(token, [log])
  }
  return groups
}

function treeRoot(branch: readonly Hex[], count: bigint): Hex {
  const zeros = suckerZeroHashes()
  let node: Hex = zeroHash
  for (let depth = 0; depth < SUCKER_MERKLE_DEPTH; depth++) {
    node = (count & (1n << BigInt(depth))) !== 0n ? suckerHashPair(branch[depth], node) : suckerHashPair(node, zeros[depth])
  }
  return node
}

function insertTree(branch: Hex[], count: bigint, leaf: Hex): Hex {
  let size = count
  let node = leaf
  for (let depth = 0; depth < SUCKER_MERKLE_DEPTH; depth++) {
    if ((size & 1n) !== 0n) {
      branch[depth] = node
      return treeRoot(branch, count)
    }
    node = suckerHashPair(branch[depth], node)
    size >>= 1n
  }
  throw new Error('The FUND bridge outbox exceeds the stock V6 Merkle tree capacity.')
}

function addBalance(balances: Map<string, bigint>, beneficiary: Address, amount: bigint): void {
  const key = beneficiary.toLowerCase()
  balances.set(key, (balances.get(key) ?? 0n) + amount)
}

async function verifyCut(input: FundGlobalSnapshotBridgeInput): Promise<void> {
  const requests = [
    { client: input.sourceClient, chainId: input.sourceChainId, blockNumber: input.sourceBlockNumber, blockHash: input.sourceBlockHash },
    { client: input.destinationClient, chainId: input.destinationChainId, blockNumber: input.destinationBlockNumber, blockHash: input.destinationBlockHash },
  ]
  await all(requests.map(async request => {
    const [chain, block] = await Promise.all([
      request.client.getChainId(), request.client.getBlock({ blockNumber: request.blockNumber }),
    ])
    if (chain !== request.chainId) throw new Error('The RPC returned a different FUND bridge chain.')
    if (block.number !== request.blockNumber || !block.hash || !sameHex(block.hash, request.blockHash)) throw new Error('The FUND bridge snapshot block changed or is unavailable. Select a new finalized cross-chain cut.')
  }))
  checkAbort(input.signal)
}

async function verifyIdentity(input: FundGlobalSnapshotBridgeInput): Promise<void> {
  const sides = [
    { client: input.sourceClient, sucker: input.sourceSucker, projectId: input.sourceProjectId, chain: input.destinationChainId, peer: input.destinationSucker, blockNumber: input.sourceBlockNumber },
    { client: input.destinationClient, sucker: input.destinationSucker, projectId: input.destinationProjectId, chain: input.sourceChainId, peer: input.sourceSucker, blockNumber: input.destinationBlockNumber },
  ]
  await all(sides.map(async side => {
    const contract = { address: side.sucker, abi: jbSuckerV6ViewAbi, blockNumber: side.blockNumber }
    const [projectId, peerChain, peer] = await Promise.all([
      side.client.readContract({ ...contract, functionName: 'projectId' }),
      side.client.readContract({ ...contract, functionName: 'peerChainId' }),
      side.client.readContract({ ...contract, functionName: 'peer' }),
    ])
    if (projectId !== side.projectId || peerChain !== BigInt(side.chain) || !sameHex(hash(peer, 'peer'), padHex(side.peer, { size: 32 }))) throw new Error('The FUND bridge lane does not have reciprocal project, chain, and peer identity at the snapshot.')
  }))
  checkAbort(input.signal)
}

/** No partial entitlement result is returned after any incomplete or inconsistent read. */
export async function readFundGlobalSnapshotBridgeLane(input: FundGlobalSnapshotBridgeInput): Promise<FundGlobalSnapshotBridgeLane> {
  checkAbort(input.signal)
  for (const chainId of [input.sourceChainId, input.destinationChainId]) if (!Number.isSafeInteger(chainId) || chainId <= 0) throw new Error('A positive safe EVM chain ID is required for the FUND bridge snapshot.')
  if (input.sourceChainId === input.destinationChainId) throw new Error('A FUND bridge must connect distinct chains.')
  for (const projectId of [input.sourceProjectId, input.destinationProjectId]) if (uint(projectId, 'project ID') === 0n) throw new Error('A positive FUND project ID is required.')
  for (const side of ['source', 'destination'] as const) {
    address(input[`${side}Sucker`], 'sucker')
    hash(input[`${side}BlockHash`], 'snapshot block hash')
    const block = uint(input[`${side}BlockNumber`], 'snapshot block')
    if (uint(input[`${side}CreationBlockNumber`], 'creation block') > block) throw new Error('The FUND creation block is after its bridge snapshot.')
  }
  const window = input.logBlockWindow ?? 2_000n
  const limit = input.logResponseLimit ?? 1_000
  if (typeof window !== 'bigint' || window <= 0n || window > 100_000n || !Number.isSafeInteger(limit) || limit < 2) throw new Error('Invalid FUND bridge log pagination settings.')
  await verifyCut(input)
  await verifyIdentity(input)
  const progress = (stage: FundGlobalSnapshotBridgeProgress['stage'], completed: bigint, total: bigint) => input.onProgress?.({ stage, completed, total, sourceChainId: input.sourceChainId, destinationChainId: input.destinationChainId })
  progress('history', 0n, 5n)
  const scans = [
    { source: true, event: insertToSuckerOutboxEvent },
    { source: true, event: getAbiItem({ abi: settlementAbi, name: 'EmergencyExit' }) },
    { source: true, event: getAbiItem({ abi: settlementAbi, name: 'RootToRemote' }) },
    { source: false, event: getAbiItem({ abi: settlementAbi, name: 'Claimed' }) },
    { source: false, event: getAbiItem({ abi: settlementAbi, name: 'NewInboxTreeRoot' }) },
  ]
  let completedScans = 0n
  const [insertions, exits, sends, claims, receipts] = await all(scans.map(async scan => {
    const logs = await scanHistory(scan.source ? input.sourceClient : input.destinationClient, {
      address: scan.source ? input.sourceSucker : input.destinationSucker, event: scan.event,
      fromBlock: scan.source ? input.sourceCreationBlockNumber : input.destinationCreationBlockNumber,
      toBlock: scan.source ? input.sourceBlockNumber : input.destinationBlockNumber, window, limit, signal: input.signal,
    })
    progress('history', ++completedScans, 5n)
    return logs
  }))
  assertConsistentLogs([insertions, exits, sends], input.sourceBlockNumber, input.sourceBlockHash)
  assertConsistentLogs([claims, receipts], input.destinationBlockNumber, input.destinationBlockHash)
  const insertionsByToken = groupByToken(insertions)
  const exitsByToken = groupByToken(exits)
  const sendsByToken = groupByToken(sends)
  const claimsByToken = groupByToken(claims)
  const receiptsByToken = groupByToken(receipts)
  for (const token of new Set([...exitsByToken.keys(), ...sendsByToken.keys()])) if (!insertionsByToken.has(token)) throw new Error('A FUND bridge settlement has no source token-tree history; the RPC history is incomplete.')
  const trees: FundGlobalSnapshotBridgeTree[] = []
  const destinationTokens = new Set<string>()
  const entitlements = new Map<string, bigint>()
  for (const [sourceTokenKey, sourceLogs] of [...insertionsByToken.entries()].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)) {
    checkAbort(input.signal)
    progress('trees', BigInt(trees.length), BigInt(insertionsByToken.size))
    const sourceToken = getAddress(sourceTokenKey)
    const sourceContract = { address: input.sourceSucker, abi: jbSuckerV6ViewAbi, blockNumber: input.sourceBlockNumber }
    const [outbox, mapping] = await Promise.all([
      input.sourceClient.readContract({ ...sourceContract, functionName: 'outboxOf', args: [sourceToken] }),
      input.sourceClient.readContract({ ...sourceContract, functionName: 'remoteTokenFor', args: [sourceToken] }),
    ])
    const leafCount = uint(outbox.tree.count, 'outbox count', 32)
    if (leafCount !== BigInt(sourceLogs.length) || leafCount === 0n) throw new Error('The FUND bridge outbox count does not match complete dense insertion history.')
    const remoteToken = hash(mapping.addr, 'remote token mapping')
    if (sameHex(remoteToken, zeroHash)) throw new Error('The FUND bridge lost the immutable remote token mapping for a nonempty outbox.')
    const destinationToken = beneficiaryAddress(remoteToken)
    const destinationTokenKey = destinationToken.toLowerCase()
    if (destinationTokens.has(destinationTokenKey)) throw new Error('Two FUND source token trees collide with the same EVM destination inbox.')
    destinationTokens.add(destinationTokenKey)
    const branch: Hex[] = Array.from({ length: SUCKER_MERKLE_DEPTH }, () => zeroHash)
    const leaves: FundGlobalSnapshotBridgeLeaf[] = []
    const roots = new Map<Hex, bigint>([[SUCKER_EMPTY_TREE_ROOT, 0n]])
    for (const log of sourceLogs) {
      if (leaves.length > 0 && leaves.length % 256 === 0) {
        // Large permissionless campaigns must remain cancellable without a
        // holder cap. Yield the browser event loop during Merkle rebuilding.
        await new Promise<void>(resolve => setTimeout(resolve, 0))
        checkAbort(input.signal)
      }
      const index = uint(log.args.index, 'outbox leaf index', 32)
      if (index !== BigInt(leaves.length)) throw new Error('The FUND bridge outbox insertion indexes are missing, duplicated, or out of order.')
      const beneficiary = hash(log.args.beneficiary, 'leaf beneficiary')
      const projectTokenCount = uint(log.args.projectTokenCount, 'leaf FUND amount', 128)
      const terminalTokenAmount = uint(log.args.terminalTokenAmount, 'leaf terminal amount', 128)
      const metadata = hash(log.args.metadata, 'leaf metadata')
      const leafHash = suckerLeafHash({ projectTokenCount, terminalTokenAmount, beneficiary, metadata })
      if (!sameHex(leafHash, hash(log.args.hashed, 'leaf hash'))) throw new Error('The FUND bridge leaf preimage does not match its committed hash.')
      const root = insertTree(branch, index + 1n, leafHash)
      if (!sameHex(root, hash(log.args.root, 'insertion root'))) throw new Error('The FUND bridge insertion root does not match the reconstructed Merkle prefix.')
      roots.set(root, index + 1n)
      leaves.push({ ...evidence(log), index, beneficiary, evmBeneficiary: beneficiaryAddress(beneficiary), projectTokenCount, terminalTokenAmount, metadata, hash: leafHash, root, executionHash: zeroHash, state: 'unsent', claim: null })
    }
    if (outbox.tree.branch.length !== SUCKER_MERKLE_DEPTH || outbox.tree.branch.some((value, index) => !sameHex(hash(value, 'outbox branch'), branch[index]))) throw new Error('The FUND bridge stored Merkle branches disagree with complete insertion history.')
    const sourceRoot = treeRoot(branch, leafCount)
    const sentCount = uint(outbox.numberOfClaimsSent, 'sent claim count', 192)
    const sourceNonce = uint(outbox.nonce, 'outbox nonce', 64)
    const outboxBalance = uint(outbox.balance, 'outbox balance')
    if (sentCount > leafCount) throw new Error('The FUND bridge sent count exceeds its outbox.')
    const sentRoots: FundGlobalSnapshotBridgeTree['sentRoots'] = []
    const sentRootsByNonce = new Map<bigint, FundGlobalSnapshotBridgeTree['sentRoots'][number]>()
    for (const log of sendsByToken.get(sourceTokenKey) ?? []) {
      const nonce = uint(log.args.nonce, 'sent root nonce', 64)
      const count = uint(log.args.index, 'sent root index', 32) + 1n
      const root = hash(log.args.root, 'sent root')
      if (nonce !== BigInt(sentRoots.length) + 1n || count > leafCount || roots.get(root) !== count || (sentRoots.length && count < sentRoots[sentRoots.length - 1].count) || !precedes(leaves[Number(count - 1n)], log)) throw new Error('The FUND bridge source root history is incomplete or inconsistent with its outbox prefixes.')
      const sentRoot = { ...evidence(log), nonce, root, count }
      sentRoots.push(sentRoot)
      sentRootsByNonce.set(nonce, sentRoot)
    }
    const lastSend = sentRoots.at(-1)
    if (sourceNonce !== (lastSend?.nonce ?? 0n) || sentCount !== (lastSend?.count ?? 0n)) throw new Error('The FUND bridge sent-root history does not match its pinned outbox nonce and count.')
    const destinationContract = { address: input.destinationSucker, abi: jbSuckerV6ViewAbi, blockNumber: input.destinationBlockNumber }
    const inbox = await input.destinationClient.readContract({ ...destinationContract, functionName: 'inboxOf', args: [destinationToken] })
    const destinationNonce = uint(inbox.nonce, 'inbox nonce', 64)
    const destinationRoot = hash(inbox.root, 'inbox root')
    const receivedRoots: FundGlobalSnapshotBridgeTree['receivedRoots'] = []
    for (const log of receiptsByToken.get(destinationTokenKey) ?? []) {
      const nonce = uint(log.args.nonce, 'received root nonce', 64)
      const root = hash(log.args.root, 'received root')
      const send = sentRootsByNonce.get(nonce)
      if (!send || !sameHex(send.root, root) || nonce <= (receivedRoots.at(-1)?.nonce ?? 0n)) throw new Error('The destination inbox contains a root outside the source snapshot. Select a causally consistent cross-chain cut.')
      receivedRoots.push({ ...evidence(log), nonce, root, count: send.count })
    }
    const lastReceived = receivedRoots.at(-1)
    if (destinationNonce !== (lastReceived?.nonce ?? 0n) || !sameHex(destinationRoot, lastReceived?.root ?? zeroHash)) throw new Error('The FUND destination inbox does not match complete received-root history.')
    const deliveredCount = lastReceived?.count ?? 0n
    const claimsByIndex = new Map<bigint, HistoryLog>()
    let receivedBeforeClaim = 0
    let deliveredBeforeClaim = 0n
    for (const log of claimsByToken.get(destinationTokenKey) ?? []) {
      while (receivedBeforeClaim < receivedRoots.length && precedes(receivedRoots[receivedBeforeClaim], log)) {
        deliveredBeforeClaim = receivedRoots[receivedBeforeClaim++].count
      }
      const index = uint(log.args.index, 'claimed leaf index', 32)
      const leaf = leaves[Number(index)]
      if (!leaf) throw new Error('A destination FUND claim is outside the source snapshot. Select a causally consistent cross-chain cut.')
      if (claimsByIndex.has(index)) throw new Error('The destination FUND history repeats a successful claim index.')
      const claimHash = suckerLeafHash({
        projectTokenCount: uint(log.args.projectTokenCount, 'claimed FUND amount'), terminalTokenAmount: uint(log.args.terminalTokenAmount, 'claimed terminal amount'),
        beneficiary: hash(log.args.beneficiary, 'claim beneficiary'), metadata: hash(log.args.metadata, 'claim metadata'),
      })
      if (!sameHex(claimHash, leaf.hash) || deliveredBeforeClaim <= index) throw new Error('A destination FUND claim has no matching source leaf and previously received prefix root.')
      claimsByIndex.set(index, log)
    }
    // Bound independent historical eth_calls without imposing a holder/leaf cap.
    for (let start = 0; start < leaves.length; start += 16) {
      checkAbort(input.signal)
      await all(leaves.slice(start, start + 16).map(async leaf => {
        const executed = hash(await input.destinationClient.readContract({ ...destinationContract, functionName: 'executedLeafHashOf', args: [destinationToken, leaf.index] }), 'executed leaf hash')
        const claim = claimsByIndex.get(leaf.index)
        if ((claim && !sameHex(executed, leaf.hash)) || (!claim && !sameHex(executed, zeroHash))) throw new Error('The destination FUND executed-leaf mapping disagrees with complete successful claim history.')
        leaf.executionHash = executed
        leaf.claim = claim ? evidence(claim) : null
        leaf.state = claim ? 'claimed' : leaf.index < deliveredCount ? 'delivered' : leaf.index < sentCount ? 'sent' : 'unsent'
      }))
    }
    const unsentFund = new Map<string, bigint>()
    const unsentTerminal = new Map<string, bigint>()
    const pendingByBeneficiary = new Map<string, bigint>()
    const totals = zeroTotals()
    let remainingOutbox = 0n
    for (const leaf of leaves) {
      totals.preparedFund += leaf.projectTokenCount
      if (leaf.state === 'claimed') totals.claimedFund += leaf.projectTokenCount
      else addBalance(pendingByBeneficiary, leaf.evmBeneficiary, leaf.projectTokenCount)
      if (leaf.index >= sentCount) {
        addBalance(unsentFund, leaf.evmBeneficiary, leaf.projectTokenCount)
        addBalance(unsentTerminal, leaf.evmBeneficiary, leaf.terminalTokenAmount)
        remainingOutbox += leaf.terminalTokenAmount
      }
    }
    const emergencyExits: FundGlobalSnapshotBridgeEmergencyExit[] = []
    const fundBeforeExit = new Map<string, bigint>()
    const terminalBeforeExit = new Map<string, bigint>()
    let insertedBeforeExit = 0
    for (const log of exitsByToken.get(sourceTokenKey) ?? []) {
      while (insertedBeforeExit < leaves.length && precedes(leaves[insertedBeforeExit], log)) {
        const leaf = leaves[insertedBeforeExit++]
        if (leaf.index >= sentCount) {
          addBalance(fundBeforeExit, leaf.evmBeneficiary, leaf.projectTokenCount)
          addBalance(terminalBeforeExit, leaf.evmBeneficiary, leaf.terminalTokenAmount)
        }
      }
      const beneficiary = address(log.args.beneficiary, 'emergency exit beneficiary')
      const key = beneficiary.toLowerCase()
      const projectTokenCount = uint(log.args.projectTokenCount, 'emergency exit FUND amount')
      const terminalTokenAmount = uint(log.args.terminalTokenAmount, 'emergency exit terminal amount')
      // Exit indices are not emitted. Aggregate only provably unsent balances;
      // never invent an individual exited leaf when repeated preimages exist.
      const availableFund = fundBeforeExit.get(key) ?? 0n
      const availableTerminal = terminalBeforeExit.get(key) ?? 0n
      if (projectTokenCount > availableFund || terminalTokenAmount > availableTerminal || projectTokenCount > (unsentFund.get(key) ?? 0n) || terminalTokenAmount > (unsentTerminal.get(key) ?? 0n)) throw new Error('The FUND emergency exits exceed the beneficiary’s unsent source entitlement or double-count a destination claim.')
      addBalance(unsentFund, beneficiary, -projectTokenCount)
      addBalance(unsentTerminal, beneficiary, -terminalTokenAmount)
      addBalance(fundBeforeExit, beneficiary, -projectTokenCount)
      addBalance(terminalBeforeExit, beneficiary, -terminalTokenAmount)
      addBalance(pendingByBeneficiary, beneficiary, -projectTokenCount)
      remainingOutbox -= terminalTokenAmount
      totals.emergencyExitedFund += projectTokenCount
      emergencyExits.push({ ...evidence(log), beneficiary, projectTokenCount, terminalTokenAmount })
    }
    if (remainingOutbox !== outboxBalance) throw new Error('The FUND outbox balance disagrees with unsent leaves minus source emergency exits; complete history is required.')
    totals.pendingFund = totals.preparedFund - totals.claimedFund - totals.emergencyExitedFund
    if (totals.pendingFund < 0n || [...pendingByBeneficiary.values()].some(balance => balance < 0n) || [...pendingByBeneficiary.values()].reduce((sum, balance) => sum + balance, 0n) !== totals.pendingFund) throw new Error('The FUND bridge entitlement reconciliation is negative or incomplete.')
    for (const [beneficiary, balance] of pendingByBeneficiary) addBalance(entitlements, getAddress(beneficiary), balance)
    trees.push({ sourceToken, destinationToken, remoteToken, leafCount, sourceRoot, sourceBranch: branch, destinationRoot, sourceNonce, destinationNonce, sentCount, deliveredCount, outboxBalance, leaves, emergencyExits, sentRoots, receivedRoots, ...totals })
  }
  for (const token of new Set([...claimsByToken.keys(), ...receiptsByToken.keys()])) if (!destinationTokens.has(token)) throw new Error('The destination has a FUND claim or inbox root for a token tree absent from the source snapshot. The cross-chain cut or RPC history is incomplete.')
  await verifyCut(input)
  const totals = trees.reduce((sum, tree) => ({ preparedFund: sum.preparedFund + tree.preparedFund, claimedFund: sum.claimedFund + tree.claimedFund, emergencyExitedFund: sum.emergencyExitedFund + tree.emergencyExitedFund, pendingFund: sum.pendingFund + tree.pendingFund }), zeroTotals())
  progress('complete', BigInt(trees.length), BigInt(trees.length))
  return {
    sourceChainId: input.sourceChainId, destinationChainId: input.destinationChainId,
    sourceProjectId: input.sourceProjectId, destinationProjectId: input.destinationProjectId,
    sourceSucker: getAddress(input.sourceSucker), destinationSucker: getAddress(input.destinationSucker),
    sourceBlockNumber: input.sourceBlockNumber, sourceBlockHash: input.sourceBlockHash,
    destinationBlockNumber: input.destinationBlockNumber, destinationBlockHash: input.destinationBlockHash,
    entitlements: [...entitlements.entries()].filter(([, balance]) => balance > 0n).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([beneficiary, balance]) => ({ chainId: input.destinationChainId, projectId: input.destinationProjectId, beneficiary: getAddress(beneficiary), balance })),
    trees, totals,
    evidence: {
      sourceCreationBlockNumber: input.sourceCreationBlockNumber, destinationCreationBlockNumber: input.destinationCreationBlockNumber,
      eventCounts: { InsertToOutboxTree: insertions.length, EmergencyExit: exits.length, RootToRemote: sends.length, Claimed: claims.length, NewInboxTreeRoot: receipts.length },
      rpcCompleteHistoryAttestation: true, historyPolicy: 'canonical-rpc-history-with-pinned-tree-and-settlement-checks',
      emergencyExitPolicy: 'aggregate-by-source-token-and-low-20-byte-beneficiary',
    },
  }
}
