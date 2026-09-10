/** Historical FUND identities at a finalized block vector, including deprecated bridges. */
import {
  SUPPORTED_CHAINS,
  jbDirectoryAbi,
  jbProjectsAbi,
  jbSuckerRegistryAbi,
  type JBChainId,
} from '@bananapus/nana-sdk-core'
import { jbSuckerV6ViewAbi, v6Address } from '@bananapus/nana-sdk-core/v6'
import { getAddress, isAddressEqual, zeroAddress, zeroHash, type Address, type Hex, type PublicClient } from 'viem'

export type FundGlobalSnapshotCut = {
  chainId: JBChainId
  blockNumber: bigint
  blockHash: Hex
  blockTimestamp: bigint
}

export type FundGlobalSnapshotProject = {
  chainId: JBChainId
  projectId: bigint
  /** Report each actual NFT owner; equal addresses across chains do not imply equal wallet control. */
  owner: Address
  controller: Address
  historicalSuckers: readonly Address[]
}

export type FundGlobalSnapshotLane = {
  sourceChainId: JBChainId
  sourceProjectId: bigint
  sourceSucker: Address
  destinationChainId: JBChainId
  destinationProjectId: bigint
  destinationSucker: Address
}

export type FundGlobalSnapshotGraph = {
  cuts: readonly FundGlobalSnapshotCut[]
  projects: readonly FundGlobalSnapshotProject[]
  /** Both directions are retained. Each source sucker has its own outbox history. */
  lanes: readonly FundGlobalSnapshotLane[]
}

export type FundGlobalSnapshotGraphInput = {
  root: { chainId: number; projectId: bigint }
  /** Only supplied clients are used. No guessed RPC URLs or fallback networks. */
  clients: ReadonlyMap<number, PublicClient>
  /** An explicit historical cut must still be finalized on that chain. Unused entries have no effect. */
  cuts?: ReadonlyMap<number, { blockNumber: bigint; blockHash?: Hex }>
  signal?: AbortSignal
}

// Resource ceilings fail explicitly; they never return a truncated graph.
const MAX_PROJECTS = 64
const MAX_LANES = 1024

type ChainContext = {
  client: PublicClient
  cut: FundGlobalSnapshotCut
  projects: Address
  directory: Address
  controller: Address
  registry: Address
}

type SuckerIdentity = {
  projectId: bigint
  peer: Address
  peerChainId: JBChainId
}

function supportedChainId(value: number): JBChainId {
  if (!Number.isSafeInteger(value) || !Object.hasOwn(SUPPORTED_CHAINS, value)) {
    throw new Error(`The FUND snapshot has an unsupported chain ID: ${value}.`)
  }
  return value as JBChainId
}

function projectIdIsValid(value: bigint): boolean {
  return typeof value === 'bigint' && value > 0n && value < (1n << 256n)
}

function address(value: Address, label: string): Address {
  const result = getAddress(value)
  if (isAddressEqual(result, zeroAddress)) throw new Error(`${label} cannot be the zero address.`)
  return result
}

function peerAddress(value: Hex): Address {
  if (!/^0x0{24}[\da-f]{40}$/i.test(value)) {
    throw new Error('A historical FUND bridge has a noncanonical remote peer address.')
  }
  return address(`0x${value.slice(-40)}`, 'The historical FUND bridge peer')
}

function validBlockHash(value: Hex | null): value is Hex {
  return !!value && /^0x[\da-f]{64}$/i.test(value) && value.toLowerCase() !== zeroHash
}

function compareProjects(a: { chainId: number; projectId: bigint }, b: { chainId: number; projectId: bigint }): number {
  return a.chainId - b.chainId || (a.projectId < b.projectId ? -1 : a.projectId > b.projectId ? 1 : 0)
}

/**
 * Discovers the complete reciprocal graph exposed by the canonical registries
 * at the selected blocks. Registry membership proves a sucker was created by
 * a registry-approved deployer, including when that sucker is now deprecated.
 *
 * This verifies project and bridge identity, not a cross-chain accounting cut:
 * callers must also reconcile every included destination claim against its
 * source preparation before using this block vector for holder allocations.
 * FUND closure policy and beneficial holder balances are checked separately.
 */
export async function readFundGlobalSnapshotGraph(input: FundGlobalSnapshotGraphInput): Promise<FundGlobalSnapshotGraph> {
  const { clients, signal } = input
  const contexts = new Map<JBChainId, ChainContext>()
  const projectById = new Map<string, FundGlobalSnapshotProject>()
  const suckerByAddress = new Map<string, SuckerIdentity>()
  const queue: FundGlobalSnapshotProject[] = []
  const lanes: FundGlobalSnapshotLane[] = []

  function checkCancelled(): void {
    if (signal?.aborted) throw new Error('The global FUND snapshot was cancelled.')
  }

  async function context(chainIdInput: number): Promise<ChainContext> {
    checkCancelled()
    const chainId = supportedChainId(chainIdInput)
    const cached = contexts.get(chainId)
    if (cached) return cached
    const client = clients.get(chainId)
    if (!client) throw new Error(`The historical FUND graph requires a supplied RPC client for chain ${chainId}.`)
    if (client.chain && client.chain.id !== chainId) throw new Error(`The RPC client for chain ${chainId} is configured for a different chain.`)
    if (await client.getChainId() !== chainId) throw new Error(`The RPC endpoint for chain ${chainId} returned a different chain.`)
    checkCancelled()

    // Resolve every address from the installed Nana SDK deployment registry.
    const projects = v6Address('JBProjects', chainId)
    const directory = v6Address('JBDirectory', chainId)
    const controller = v6Address('JBController', chainId)
    const registry = v6Address('JBSuckerRegistry', chainId)
    const finalized = await client.getBlock({ blockTag: 'finalized' })
    checkCancelled()
    if (typeof finalized.number !== 'bigint' || finalized.number < 0n || !validBlockHash(finalized.hash)) {
      throw new Error(`The RPC did not return a finalized snapshot block on chain ${chainId}.`)
    }
    const explicitCut = input.cuts?.get(chainId)
    if (explicitCut && (typeof explicitCut.blockNumber !== 'bigint' || explicitCut.blockNumber < 0n || explicitCut.blockNumber > finalized.number)) {
      throw new Error(`The explicit FUND snapshot block on chain ${chainId} must be at or before its finalized block.`)
    }
    if (explicitCut?.blockHash !== undefined && !validBlockHash(explicitCut.blockHash)) {
      throw new Error(`The explicit FUND snapshot block hash on chain ${chainId} is invalid.`)
    }
    const block = explicitCut ? await client.getBlock({ blockNumber: explicitCut.blockNumber }) : finalized
    checkCancelled()
    if (typeof block.number !== 'bigint' || block.number < 0n || !validBlockHash(block.hash) ||
      typeof block.timestamp !== 'bigint' || block.timestamp < 0n ||
      (explicitCut && block.number !== explicitCut.blockNumber)) {
      throw new Error(`The RPC did not return the requested mined snapshot block on chain ${chainId}.`)
    }
    if (explicitCut?.blockHash && block.hash.toLowerCase() !== explicitCut.blockHash.toLowerCase()) {
      throw new Error(`The explicit FUND snapshot block hash changed on chain ${chainId}.`)
    }
    if (block.number === finalized.number && block.hash.toLowerCase() !== finalized.hash.toLowerCase()) {
      throw new Error(`The finalized FUND snapshot block changed on chain ${chainId}.`)
    }
    const result: ChainContext = { client, projects, directory, controller, registry,
      cut: { chainId, blockNumber: block.number, blockHash: block.hash, blockTimestamp: block.timestamp } }
    contexts.set(chainId, result)
    return result
  }

  async function loadProject(chainIdInput: number, projectId: bigint): Promise<FundGlobalSnapshotProject> {
    checkCancelled()
    if (!projectIdIsValid(projectId)) throw new Error('The global FUND snapshot requires a positive uint256 project ID.')
    const ctx = await context(chainIdInput)
    const chainId = ctx.cut.chainId
    const key = `${chainId}:${projectId}`
    const cached = projectById.get(key)
    if (cached) return cached
    if (projectById.size >= MAX_PROJECTS) throw new Error(`The historical FUND graph exceeds the ${MAX_PROJECTS}-project snapshot read limit.`)
    const at = { blockNumber: ctx.cut.blockNumber }
    const [ownerValue, controllerValue, allSuckers] = await Promise.all([
      ctx.client.readContract({ address: ctx.projects, abi: jbProjectsAbi, functionName: 'ownerOf', args: [projectId], ...at }),
      ctx.client.readContract({ address: ctx.directory, abi: jbDirectoryAbi, functionName: 'controllerOf', args: [projectId], ...at }),
      ctx.client.readContract({ address: ctx.registry, abi: jbSuckerRegistryAbi, functionName: 'allSuckersOf', args: [projectId], ...at }),
    ])
    checkCancelled()
    const owner = address(ownerValue, `The FUND owner on chain ${chainId}`)
    const controller = address(controllerValue, `The FUND controller on chain ${chainId}`)
    if (!isAddressEqual(controller, ctx.controller)) throw new Error(`FUND project ${chainId}:${projectId} uses a different controller from the canonical V6 controller.`)
    if (allSuckers.length > MAX_LANES) throw new Error(`The historical FUND graph exceeds the ${MAX_LANES}-lane snapshot read limit.`)
    const historicalSuckers = allSuckers.map(sucker => address(sucker, 'A historical FUND sucker'))
    if (new Set(historicalSuckers.map(sucker => sucker.toLowerCase())).size !== historicalSuckers.length) {
      throw new Error('The canonical registry returned duplicate historical FUND suckers.')
    }
    historicalSuckers.sort((a, b) => a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : 0)
    const project = { chainId, projectId, owner, controller, historicalSuckers }
    projectById.set(key, project)
    queue.push(project)
    return project
  }

  async function loadSucker(chainId: JBChainId, sucker: Address): Promise<SuckerIdentity> {
    checkCancelled()
    const key = `${chainId}:${sucker.toLowerCase()}`
    const cached = suckerByAddress.get(key)
    if (cached) return cached
    if (suckerByAddress.size >= MAX_LANES) throw new Error(`The historical FUND graph exceeds the ${MAX_LANES}-lane snapshot read limit.`)
    const ctx = await context(chainId)
    const at = { blockNumber: ctx.cut.blockNumber }
    const code = await ctx.client.getCode({ address: sucker, ...at })
    checkCancelled()
    if (!code || code === '0x') throw new Error(`Historical FUND sucker ${sucker} is not deployed at the snapshot cut on chain ${chainId}.`)
    const [projectId, peerValue, peerChainIdValue] = await Promise.all([
      ctx.client.readContract({ address: sucker, abi: jbSuckerV6ViewAbi, functionName: 'projectId', ...at }),
      ctx.client.readContract({ address: sucker, abi: jbSuckerV6ViewAbi, functionName: 'peer', ...at }),
      ctx.client.readContract({ address: sucker, abi: jbSuckerV6ViewAbi, functionName: 'peerChainId', ...at }),
    ])
    checkCancelled()
    if (!projectIdIsValid(projectId)) throw new Error('A historical FUND sucker returned an invalid project ID.')
    if (typeof peerChainIdValue !== 'bigint' || peerChainIdValue <= 0n || peerChainIdValue > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error('A historical FUND sucker returned an unsupported remote chain ID.')
    }
    const peerChainId = supportedChainId(Number(peerChainIdValue))
    if (peerChainId === chainId) throw new Error('A historical FUND bridge must point to a different chain.')
    const peer = peerAddress(peerValue)
    const registered = await ctx.client.readContract({ address: ctx.registry, abi: jbSuckerRegistryAbi,
      functionName: 'isSuckerOf', args: [projectId, sucker], ...at })
    checkCancelled()
    if (registered !== true) throw new Error(`Historical FUND sucker ${sucker} is not registered for project ${chainId}:${projectId} in the canonical registry.`)
    const result = { projectId, peer, peerChainId }
    suckerByAddress.set(key, result)
    return result
  }

  checkCancelled()
  await loadProject(input.root.chainId, input.root.projectId)
  for (let index = 0; index < queue.length; index++) {
    const project = queue[index]
    for (const sourceSucker of project.historicalSuckers) {
      checkCancelled()
      const source = await loadSucker(project.chainId, sourceSucker)
      if (source.projectId !== project.projectId) throw new Error('A historical FUND sucker belongs to a different project than its registry entry.')
      const destination = await loadSucker(source.peerChainId, source.peer)
      if (destination.peerChainId !== project.chainId || !isAddressEqual(destination.peer, sourceSucker)) {
        throw new Error('The historical FUND bridge is not reciprocally peered at the selected snapshot cuts.')
      }
      const remoteProject = await loadProject(source.peerChainId, destination.projectId)
      if (!remoteProject.historicalSuckers.some(sucker => isAddressEqual(sucker, source.peer))) {
        throw new Error('The historical FUND bridge peer is missing from its canonical project registry at the snapshot cut.')
      }
      if (lanes.length >= MAX_LANES) throw new Error(`The historical FUND graph exceeds the ${MAX_LANES}-lane snapshot read limit.`)
      lanes.push({ sourceChainId: project.chainId, sourceProjectId: project.projectId, sourceSucker,
        destinationChainId: source.peerChainId, destinationProjectId: destination.projectId, destinationSucker: source.peer })
    }
  }

  // Revalidate the entire vector after all graph reads, not only the root block.
  await Promise.all([...contexts.values()].map(async ctx => {
    checkCancelled()
    const block = await ctx.client.getBlock({ blockNumber: ctx.cut.blockNumber })
    checkCancelled()
    if (block.number !== ctx.cut.blockNumber || !validBlockHash(block.hash) || block.hash.toLowerCase() !== ctx.cut.blockHash.toLowerCase()) {
      throw new Error(`The FUND snapshot block changed on chain ${ctx.cut.chainId}; restart the global snapshot.`)
    }
  }))
  checkCancelled()
  return {
    cuts: [...contexts.values()].map(ctx => ctx.cut).sort((a, b) => a.chainId - b.chainId),
    projects: [...projectById.values()].sort(compareProjects),
    lanes: lanes.sort((a, b) => compareProjects({ chainId: a.sourceChainId, projectId: a.sourceProjectId },
      { chainId: b.sourceChainId, projectId: b.sourceProjectId }) || (a.sourceSucker.toLowerCase() < b.sourceSucker.toLowerCase() ? -1 : a.sourceSucker.toLowerCase() > b.sourceSucker.toLowerCase() ? 1 : 0)),
  }
}
