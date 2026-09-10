import { describe, expect, it, vi } from 'vitest'
import { v6Address } from '@bananapus/nana-sdk-core/v6'
import { getAddress, padHex, toHex, zeroAddress, zeroHash, type Address, type Hex, type PublicClient } from 'viem'
import { readFundGlobalSnapshotGraph } from '../src/lib/fund-global-snapshot-graph'

const ROOT = { chainId: 8453, projectId: 7n }
const OWNER = '0x1111111111111111111111111111111111111111' as const
const REMOTE_OWNER = '0x2222222222222222222222222222222222222222' as const
const SOURCE = address(101)
const DESTINATION = address(201)
const OLD_SOURCE = address(102)
const OLD_DESTINATION = address(202)
const THIRD_SOURCE = address(203)
const THIRD_DESTINATION = address(301)
const REORG_HASH = `0x${'ff'.repeat(32)}` as Hex

function address(value: number): Address { return getAddress(padHex(toHex(value), { size: 20 })) }
function hash(chainId: number, blockNumber: bigint): Hex {
  return padHex(toHex(BigInt(chainId) * 1_000_000n + blockNumber), { size: 32 })
}
function timestamp(chainId: number, blockNumber: bigint): bigint {
  return 1_800_000_000n + BigInt(chainId) + blockNumber
}

type ChainId = 1 | 10 | 8453
type Project = { owner: Address; controller: Address; historicalSuckers: Address[] }
type Sucker = { projectId: bigint; peer: Hex; peerChainId: bigint }
type ContractRead = { address: Address; functionName: string; args?: readonly unknown[]; blockNumber?: bigint }
type BlockRead = { blockTag?: string; blockNumber?: bigint }
type CodeRead = { address: Address; blockNumber?: bigint }

/** Each endpoint has its own finalized head; all unmodeled or unpinned reads fail. */
function fixture(options: { singleChain?: boolean; thirdChain?: boolean } = {}) {
  const data = new Map<ChainId, {
    endpointChainId: number
    finalized: bigint
    pinned: bigint
    projects: Map<bigint, Project>
    suckers: Map<string, Sucker>
    unregistered: Set<string>
    emptyCode: Set<string>
    reorg: boolean
    failRead?: string
    onRead?: (request: ContractRead) => void
  }>()
  function addChain(chainId: ChainId, projectId: bigint, historicalSuckers: Address[], owner: Address = OWNER) {
    data.set(chainId, {
      endpointChainId: chainId, finalized: BigInt(chainId) + 1000n, pinned: BigInt(chainId) + 1000n,
      projects: new Map([[projectId, { owner, controller: v6Address('JBController', chainId), historicalSuckers }]]),
      suckers: new Map(), unregistered: new Set(), emptyCode: new Set(), reorg: false,
    })
  }
  function addSucker(chainId: ChainId, local: Address, projectId: bigint, peerChainId: ChainId, remote: Address) {
    data.get(chainId)!.suckers.set(local.toLowerCase(), { projectId, peerChainId: BigInt(peerChainId), peer: padHex(remote, { size: 32 }) })
  }
  addChain(8453, 7n, options.singleChain ? [] : [SOURCE, OLD_SOURCE])
  if (!options.singleChain) {
    addChain(10, 19n, [DESTINATION, OLD_DESTINATION], REMOTE_OWNER)
    addSucker(8453, SOURCE, 7n, 10, DESTINATION)
    addSucker(8453, OLD_SOURCE, 7n, 10, OLD_DESTINATION)
    addSucker(10, DESTINATION, 19n, 8453, SOURCE)
    addSucker(10, OLD_DESTINATION, 19n, 8453, OLD_SOURCE)
  }
  if (options.thirdChain) {
    data.get(10)!.projects.get(19n)!.historicalSuckers.push(THIRD_SOURCE)
    addChain(1, 31n, [THIRD_DESTINATION])
    addSucker(10, THIRD_SOURCE, 19n, 1, THIRD_DESTINATION)
    addSucker(1, THIRD_DESTINATION, 31n, 10, THIRD_SOURCE)
  }
  const calls = new Map<ChainId, {
    getChainId: ReturnType<typeof vi.fn>
    getBlock: ReturnType<typeof vi.fn>
    getCode: ReturnType<typeof vi.fn>
    readContract: ReturnType<typeof vi.fn>
  }>()
  const clients = new Map<number, PublicClient>()
  for (const [chainId, state] of data) {
    const readContract = vi.fn(async (request: ContractRead): Promise<unknown> => {
      expect(request.blockNumber).toBe(state.pinned)
      state.onRead?.(request)
      if (state.failRead === request.functionName) throw new Error(`RPC unavailable: ${request.functionName}`)
      const target = request.address.toLowerCase()
      if (target === v6Address('JBProjects', chainId).toLowerCase() && request.functionName === 'ownerOf') {
        expect(request.args).toHaveLength(1)
        const project = state.projects.get(request.args![0] as bigint)
        if (!project) throw new Error('Project does not exist')
        return project.owner
      }
      if (target === v6Address('JBDirectory', chainId).toLowerCase() && request.functionName === 'controllerOf') {
        expect(request.args).toHaveLength(1)
        const project = state.projects.get(request.args![0] as bigint)
        if (!project) throw new Error('Project does not exist')
        return project.controller
      }
      if (target === v6Address('JBSuckerRegistry', chainId).toLowerCase()) {
        if (request.functionName === 'allSuckersOf') {
          expect(request.args).toHaveLength(1)
          const project = state.projects.get(request.args![0] as bigint)
          if (!project) throw new Error('Project does not exist')
          return project.historicalSuckers
        }
        if (request.functionName === 'isSuckerOf') {
          expect(request.args).toHaveLength(2)
          const [projectId, sucker] = request.args as [bigint, Address]
          return !state.unregistered.has(sucker.toLowerCase())
            && state.suckers.get(sucker.toLowerCase())?.projectId === projectId
        }
      }
      const sucker = state.suckers.get(target)
      if (sucker && ['projectId', 'peer', 'peerChainId'].includes(request.functionName)) {
        expect(request.args ?? []).toEqual([])
        return sucker[request.functionName as keyof Sucker]
      }
      // In particular, suckerPairsOf/state would discard deprecated bridge history.
      throw new Error(`Unexpected RPC read on ${chainId}: ${request.address}.${request.functionName}`)
    })
    const getBlock = vi.fn(async (request: BlockRead) => {
      if (request.blockTag === 'finalized') {
        expect(request.blockNumber).toBeUndefined()
        return { number: state.finalized, hash: hash(chainId, state.finalized), timestamp: timestamp(chainId, state.finalized) }
      }
      expect(request.blockTag).toBeUndefined()
      expect(request.blockNumber).toBe(state.pinned)
      return { number: state.pinned, hash: state.reorg && readContract.mock.calls.length > 0 ? REORG_HASH : hash(chainId, state.pinned),
        timestamp: timestamp(chainId, state.pinned) }
    })
    const getCode = vi.fn(async (request: CodeRead) => {
      expect(request.blockNumber).toBe(state.pinned)
      const target = request.address.toLowerCase()
      const known = state.suckers.has(target) || ['JBProjects', 'JBDirectory', 'JBSuckerRegistry', 'JBController']
        .some(name => v6Address(name as 'JBProjects', chainId).toLowerCase() === target)
      expect(known).toBe(true)
      return state.emptyCode.has(target) ? '0x' : '0x60006000'
    })
    const getChainId = vi.fn(async () => state.endpointChainId)
    calls.set(chainId, { getBlock, getCode, getChainId, readContract })
    clients.set(chainId, { chain: { id: chainId }, getChainId, getBlock, getCode, readContract } as unknown as PublicClient)
  }
  return { data, calls, clients }
}

describe('readFundGlobalSnapshotGraph', () => {
  it('pins an unbridged project to its finalized head and reads canonical ownership and controller', async () => {
    const f = fixture({ singleChain: true })
    const graph = await readFundGlobalSnapshotGraph({ root: ROOT, clients: f.clients })
    const blockNumber = f.data.get(8453)!.finalized
    expect(graph.cuts).toEqual([{ chainId: 8453, blockNumber, blockHash: hash(8453, blockNumber), blockTimestamp: timestamp(8453, blockNumber) }])
    expect(graph.projects).toEqual([expect.objectContaining({ ...ROOT, owner: OWNER,
      controller: getAddress(v6Address('JBController', 8453)), historicalSuckers: [] })])
    expect(graph.lanes).toEqual([])
    expect(f.calls.get(8453)!.getChainId).toHaveBeenCalled()
    expect(f.calls.get(8453)!.getBlock.mock.calls.at(-1)).toEqual([{ blockNumber }])
  })

  it('includes every historical lane, preserves different remote IDs/owners and closes reciprocal cycles once', async () => {
    const f = fixture()
    const graph = await readFundGlobalSnapshotGraph({ root: ROOT, clients: f.clients })
    expect(graph.projects).toHaveLength(2)
    expect(graph.projects).toEqual(expect.arrayContaining([
      expect.objectContaining({ chainId: 8453, projectId: 7n, owner: OWNER, historicalSuckers: [SOURCE, OLD_SOURCE] }),
      expect.objectContaining({ chainId: 10, projectId: 19n, owner: REMOTE_OWNER, historicalSuckers: [DESTINATION, OLD_DESTINATION] }),
    ]))
    expect(graph.lanes).toHaveLength(4)
    expect(graph.lanes).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceChainId: 8453, sourceProjectId: 7n, sourceSucker: OLD_SOURCE,
        destinationChainId: 10, destinationProjectId: 19n, destinationSucker: OLD_DESTINATION }),
      expect.objectContaining({ sourceChainId: 10, sourceProjectId: 19n, sourceSucker: OLD_DESTINATION,
        destinationChainId: 8453, destinationProjectId: 7n, destinationSucker: OLD_SOURCE }),
    ]))
    for (const [chainId, state] of f.data) {
      expect(graph.cuts).toContainEqual({ chainId, blockNumber: state.pinned, blockHash: hash(chainId, state.pinned), blockTimestamp: timestamp(chainId, state.pinned) })
      const calls = f.calls.get(chainId)!
      expect(calls.readContract.mock.calls.some(([request]) => request.functionName === 'state' || request.functionName === 'suckerPairsOf')).toBe(false)
      for (const sucker of state.suckers.keys()) {
        expect(calls.getCode.mock.calls.some(([request]) => request.address.toLowerCase() === sucker)).toBe(true)
        expect(calls.readContract.mock.calls.some(([request]) => request.functionName === 'isSuckerOf'
          && request.args?.[1].toLowerCase() === sucker)).toBe(true)
      }
      expect(calls.getBlock.mock.calls.at(-1)).toEqual([{ blockNumber: state.pinned }])
    }
  })

  it('traverses a project reachable only through a remote historical registry', async () => {
    const f = fixture({ thirdChain: true })
    const graph = await readFundGlobalSnapshotGraph({ root: ROOT, clients: f.clients })
    expect(graph.projects).toHaveLength(3)
    expect(graph.projects).toContainEqual(expect.objectContaining({ chainId: 1, projectId: 31n }))
    expect(graph.lanes).toHaveLength(6)
    expect(graph.lanes).toContainEqual(expect.objectContaining({ sourceChainId: 10, sourceProjectId: 19n,
      sourceSucker: THIRD_SOURCE, destinationChainId: 1, destinationProjectId: 31n, destinationSucker: THIRD_DESTINATION }))
  })

  it('retains five graph projects when project IDs repeat across chains and several projects share a chain', async () => {
    const f = fixture()
    const links = [
      { sourceChainId: 10, sourceProjectId: 19n, sourceSucker: address(401),
        destinationChainId: 8453, destinationProjectId: 19n, destinationSucker: address(402) },
      { sourceChainId: 8453, sourceProjectId: 19n, sourceSucker: address(403),
        destinationChainId: 10, destinationProjectId: 7n, destinationSucker: address(404) },
      { sourceChainId: 10, sourceProjectId: 7n, sourceSucker: address(405),
        destinationChainId: 8453, destinationProjectId: 31n, destinationSucker: address(406) },
    ] as const
    for (const link of links) {
      for (const [chainId, projectId, sucker, peerChainId, peer] of [
        [link.sourceChainId, link.sourceProjectId, link.sourceSucker, link.destinationChainId, link.destinationSucker],
        [link.destinationChainId, link.destinationProjectId, link.destinationSucker, link.sourceChainId, link.sourceSucker],
      ] as const) {
        const state = f.data.get(chainId)!
        if (!state.projects.has(projectId)) state.projects.set(projectId, {
          owner: chainId === 8453 ? OWNER : REMOTE_OWNER, controller: v6Address('JBController', chainId), historicalSuckers: [],
        })
        state.projects.get(projectId)!.historicalSuckers.push(sucker)
        state.suckers.set(sucker.toLowerCase(), { projectId, peerChainId: BigInt(peerChainId), peer: padHex(peer, { size: 32 }) })
      }
    }
    const graph = await readFundGlobalSnapshotGraph({ root: ROOT, clients: f.clients })
    expect(graph.projects.map(project => `${project.chainId}:${project.projectId}`).sort()).toEqual([
      '10:19', '10:7', '8453:19', '8453:31', '8453:7',
    ])
    expect(graph.lanes).toHaveLength(10)
    for (const link of links) {
      expect(graph.lanes).toContainEqual(expect.objectContaining(link))
      expect(graph.lanes).toContainEqual(expect.objectContaining({
        sourceChainId: link.destinationChainId, sourceProjectId: link.destinationProjectId, sourceSucker: link.destinationSucker,
        destinationChainId: link.sourceChainId, destinationProjectId: link.sourceProjectId, destinationSucker: link.sourceSucker,
      }))
    }
    expect(graph.cuts).toHaveLength(2)
    for (const [chainId, state] of f.data) {
      const calls = f.calls.get(chainId)!
      expect(calls.getChainId).toHaveBeenCalledTimes(1)
      for (const projectId of state.projects.keys()) {
        expect(calls.readContract.mock.calls.filter(([request]) => request.functionName === 'ownerOf'
          && request.args?.[0] === projectId)).toHaveLength(1)
      }
    }
  })

  it('uses explicit per-chain cuts, including expected hashes, without replacing them with finalized heads', async () => {
    const f = fixture()
    const cuts = new Map([...f.data].map(([chainId, state]) => {
      state.pinned = state.finalized - 25n
      return [chainId, { blockNumber: state.pinned, blockHash: hash(chainId, state.pinned) }] as const
    }))
    const graph = await readFundGlobalSnapshotGraph({ root: ROOT, clients: f.clients, cuts })
    for (const [chainId, cut] of cuts) expect(graph.cuts).toContainEqual({ chainId, ...cut, blockTimestamp: timestamp(chainId, cut.blockNumber) })
  })

  it('fills only unspecified chain cuts from that endpoint’s finalized head', async () => {
    const f = fixture()
    const rootState = f.data.get(8453)!
    rootState.pinned -= 30n
    const graph = await readFundGlobalSnapshotGraph({ root: ROOT, clients: f.clients,
      cuts: new Map([[8453, { blockNumber: rootState.pinned }]]) })
    expect(graph.cuts.find(cut => cut.chainId === 8453)?.blockNumber).toBe(rootState.pinned)
    expect(graph.cuts.find(cut => cut.chainId === 10)?.blockNumber).toBe(f.data.get(10)!.finalized)
  })

  it('rejects a caller-supplied cut beyond finality', async () => {
    const f = fixture({ singleChain: true })
    const state = f.data.get(8453)!
    state.pinned = state.finalized + 1n
    await expect(readFundGlobalSnapshotGraph({ root: ROOT, clients: f.clients,
      cuts: new Map([[8453, { blockNumber: state.pinned }]]) })).rejects.toThrow(/final|block|cut/i)
  })

  it('rejects a supplied block hash that disagrees with the pinned RPC block', async () => {
    const f = fixture({ singleChain: true })
    await expect(readFundGlobalSnapshotGraph({ root: ROOT, clients: f.clients,
      cuts: new Map([[8453, { blockNumber: f.data.get(8453)!.pinned, blockHash: REORG_HASH }]]) })).rejects.toThrow(/hash|block|changed|cut/i)
  })

  it('rejects an explicit cut at finalized height when its hash changes between the two RPC reads', async () => {
    const f = fixture({ singleChain: true })
    const state = f.data.get(8453)!
    const calls = f.calls.get(8453)!
    calls.getBlock.mockImplementation(async (request: BlockRead) => {
      if (request.blockTag !== 'finalized') expect(request.blockNumber).toBe(state.finalized)
      return { number: state.finalized, timestamp: timestamp(8453, state.finalized),
        hash: request.blockTag === 'finalized' ? hash(8453, state.finalized) : REORG_HASH }
    })
    await expect(readFundGlobalSnapshotGraph({ root: ROOT, clients: f.clients,
      cuts: new Map([[8453, { blockNumber: state.finalized }]]) })).rejects.toThrow(/final|hash|block|changed/i)
    expect(calls.getBlock.mock.calls).toEqual([[{ blockTag: 'finalized' }], [{ blockNumber: state.finalized }]])
    expect(calls.readContract).not.toHaveBeenCalled()
  })

  it.each([8453, 10] as const)('requires an RPC client for every discovered chain (%s)', async chainId => {
    const f = fixture()
    f.clients.delete(chainId)
    await expect(readFundGlobalSnapshotGraph({ root: ROOT, clients: f.clients })).rejects.toThrow(/RPC|client|chain/i)
  })

  it.each([8453, 10] as const)('validates the actual RPC network on chain %s', async chainId => {
    const f = fixture()
    f.data.get(chainId)!.endpointChainId = 1
    await expect(readFundGlobalSnapshotGraph({ root: ROOT, clients: f.clients })).rejects.toThrow(/chain|network|RPC/i)
  })

  it.each([8453, 10] as const)('rejects foreign controllers on chain %s', async chainId => {
    const f = fixture()
    f.data.get(chainId)!.projects.values().next().value!.controller = OWNER
    await expect(readFundGlobalSnapshotGraph({ root: ROOT, clients: f.clients })).rejects.toThrow(/controller|canonical|supported/i)
  })

  it.each([[8453, SOURCE], [10, DESTINATION]] as const)('requires canonical registry membership for chain %s sucker %s', async (chainId, sucker) => {
    const f = fixture()
    f.data.get(chainId)!.unregistered.add(sucker.toLowerCase())
    await expect(readFundGlobalSnapshotGraph({ root: ROOT, clients: f.clients })).rejects.toThrow(/registered|registry|sucker/i)
  })

  it.each([[8453, OLD_SOURCE], [10, OLD_DESTINATION]] as const)('requires deployed code for historical chain %s sucker %s', async (chainId, sucker) => {
    const f = fixture()
    f.data.get(chainId)!.emptyCode.add(sucker.toLowerCase())
    await expect(readFundGlobalSnapshotGraph({ root: ROOT, clients: f.clients })).rejects.toThrow(/code|deploy|sucker/i)
  })

  it('rejects a source sucker that identifies a different local project', async () => {
    const f = fixture()
    f.data.get(8453)!.suckers.get(SOURCE.toLowerCase())!.projectId = 8n
    await expect(readFundGlobalSnapshotGraph({ root: ROOT, clients: f.clients })).rejects.toThrow(/project|registered|sucker/i)
  })

  it('rejects a reciprocal peer pointing at another source sucker', async () => {
    const f = fixture()
    f.data.get(10)!.suckers.get(DESTINATION.toLowerCase())!.peer = padHex(OLD_SOURCE, { size: 32 })
    await expect(readFundGlobalSnapshotGraph({ root: ROOT, clients: f.clients })).rejects.toThrow(/peer|reciprocal|sucker|link/i)
  })

  it('rejects a reciprocal peer naming the wrong source chain', async () => {
    const f = fixture()
    f.data.get(10)!.suckers.get(DESTINATION.toLowerCase())!.peerChainId = 1n
    await expect(readFundGlobalSnapshotGraph({ root: ROOT, clients: f.clients })).rejects.toThrow(/peer|reciprocal|chain|link/i)
  })

  it('requires the reciprocal sucker to appear in the destination historical project registry', async () => {
    const f = fixture()
    f.data.get(10)!.projects.get(19n)!.historicalSuckers = [OLD_DESTINATION]
    await expect(readFundGlobalSnapshotGraph({ root: ROOT, clients: f.clients })).rejects.toThrow(/registry|historical|reciprocal|sucker/i)
  })

  it('rejects duplicate historical registry entries instead of counting an outbox twice', async () => {
    const f = fixture()
    f.data.get(8453)!.projects.get(7n)!.historicalSuckers.push(SOURCE)
    await expect(readFundGlobalSnapshotGraph({ root: ROOT, clients: f.clients })).rejects.toThrow(/duplicate|sucker/i)
  })

  it('rejects a bridge that points to its own chain', async () => {
    const f = fixture()
    f.data.get(8453)!.suckers.get(SOURCE.toLowerCase())!.peerChainId = 8453n
    await expect(readFundGlobalSnapshotGraph({ root: ROOT, clients: f.clients })).rejects.toThrow(/chain|bridge/i)
  })

  it('rejects a remote sucker that has no valid project identity', async () => {
    const f = fixture()
    f.data.get(10)!.suckers.get(DESTINATION.toLowerCase())!.projectId = 0n
    await expect(readFundGlobalSnapshotGraph({ root: ROOT, clients: f.clients })).rejects.toThrow(/project|invalid/i)
  })

  it.each([zeroHash, SOURCE as Hex, `0x${'ff'.repeat(12)}${DESTINATION.slice(2)}` as Hex])('rejects an invalid or non-EVM bytes32 peer %s', async peer => {
    const f = fixture()
    f.data.get(8453)!.suckers.get(SOURCE.toLowerCase())!.peer = peer
    await expect(readFundGlobalSnapshotGraph({ root: ROOT, clients: f.clients })).rejects.toThrow(/peer|address|EVM|bytes|sucker/i)
  })

  it.each([31337n, BigInt(Number.MAX_SAFE_INTEGER) + 1n])('rejects unsupported or unsafe peer chain IDs %s', async peerChainId => {
    const f = fixture()
    f.data.get(8453)!.suckers.get(SOURCE.toLowerCase())!.peerChainId = peerChainId
    await expect(readFundGlobalSnapshotGraph({ root: ROOT, clients: f.clients })).rejects.toThrow(/chain|supported|safe/i)
  })

  it.each([8453, 10] as const)('rechecks chain %s block hash after completing the graph', async chainId => {
    const f = fixture()
    f.data.get(chainId)!.reorg = true
    await expect(readFundGlobalSnapshotGraph({ root: ROOT, clients: f.clients })).rejects.toThrow(/reorg|changed|hash|block/i)
  })

  it('propagates historical registry RPC failures without returning a partial graph', async () => {
    const f = fixture()
    f.data.get(10)!.failRead = 'allSuckersOf'
    await expect(readFundGlobalSnapshotGraph({ root: ROOT, clients: f.clients })).rejects.toThrow(/RPC unavailable/)
  })

  it('rejects an endpoint that has no finalized block hash', async () => {
    const f = fixture({ singleChain: true })
    const state = f.data.get(8453)!
    f.calls.get(8453)!.getBlock.mockResolvedValueOnce({ number: state.finalized, hash: null, timestamp: 1_800_000_000n })
    await expect(readFundGlobalSnapshotGraph({ root: ROOT, clients: f.clients })).rejects.toThrow(/final|block|hash/i)
  })

  it('honors cancellation before making RPC reads', async () => {
    const f = fixture()
    const controller = new AbortController()
    controller.abort()
    await expect(readFundGlobalSnapshotGraph({ root: ROOT, clients: f.clients, signal: controller.signal })).rejects.toThrow(/abort|cancel/i)
    for (const calls of f.calls.values()) expect(calls.getChainId).not.toHaveBeenCalled()
  })

  it('honors cancellation while traversing a remote project', async () => {
    const f = fixture()
    const controller = new AbortController()
    f.data.get(10)!.onRead = () => controller.abort()
    await expect(readFundGlobalSnapshotGraph({ root: ROOT, clients: f.clients, signal: controller.signal })).rejects.toThrow(/abort|cancel/i)
  })

  it.each([0n, -1n])('rejects an invalid root project ID %s', async projectId => {
    const f = fixture()
    await expect(readFundGlobalSnapshotGraph({ root: { ...ROOT, projectId }, clients: f.clients })).rejects.toThrow(/project|positive|invalid/i)
  })

  it('rejects a nonexistent owner even when the endpoint supplies a canonical controller', async () => {
    const f = fixture({ singleChain: true })
    f.data.get(8453)!.projects.get(7n)!.owner = zeroAddress
    await expect(readFundGlobalSnapshotGraph({ root: ROOT, clients: f.clients })).rejects.toThrow(/owner|address|project/i)
  })
})
