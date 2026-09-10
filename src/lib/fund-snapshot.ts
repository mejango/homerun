/**
 * Reconstruct every candidate from canonical history, then measure ownership at
 * one block. Indexers and user-supplied addresses can add candidates, never
 * replace history or prove completeness. This is an offchain attestation, not
 * an onchain proof of historical balances.
 */
import {
  jb721TiersHookAbi, jb721TiersHookStoreAbi, jbContractAddress, jbControllerAbi, jbDirectoryAbi, jbOmnichainDeployerAbi,
  jbProjectsAbi, jbSuckerRegistryAbi, jbTerminalStoreAbi, jbTokensAbi,
  type JBChainId,
} from '@bananapus/nana-sdk-core'
import { jbSuckerV6ViewAbi, v6Address } from '@bananapus/nana-sdk-core/v6'
import {
  erc20Abi, formatUnits, getAbiItem, getAddress, isAddress, isAddressEqual, keccak256, parseAbi, zeroAddress,
  type AbiEvent, type Address, type Hex, type PublicClient,
} from 'viem'
import { resolveFundStickyCustody, type FundStickyCustody, type StickyOwnershipHolder } from './fund-snapshot-sticky'
import { ownershipWeight } from './fund-ownership-weight'

export type FundSnapshotHolder = {
  holder: Address
  balance: bigint
  creditBalance: bigint
  erc20Balance: bigint
}

export type FundOwnershipSnapshot = {
  chainId: JBChainId
  projectId: bigint
  blockNumber: bigint
  blockHash: Hex
  blockTimestamp: bigint
  creationBlockNumber: bigint
  creationTransactionHash: Hex
  owner: Address
  tokenAddress: Address | null
  totalFundSupply: bigint
  totalCreditSupply: bigint
  totalErc20Supply: bigint
  holders: FundSnapshotHolder[]
  evidence: {
    projects: Address
    tokens: Address
    controller: Address
    suckerRegistry: Address
    eventCounts: Record<string, number>
    candidateCount: number
    bridgePolicy: 'no-historical-suckers'
  }
}

/** A component observation, deliberately rejected by the single-chain manifest builder. */
export type FundOwnershipForGlobalSnapshot = Omit<FundOwnershipSnapshot, 'evidence'> & {
  historicalSuckers: Address[]
  /** Integer balances are a presentation projection; exact weights include nested SHARE fractions. */
  beneficialHolders?: StickyOwnershipHolder[]
  stickyCustody?: FundStickyCustody
  evidence: Omit<FundOwnershipSnapshot['evidence'], 'bridgePolicy'> & {
    bridgePolicy: 'historical-graph-required'
  }
}

export type FundSnapshotProgress = {
  stage: 'creation' | 'history' | 'balances' | 'complete'
  completed: bigint
  total: bigint
  candidates: number
}

export type FundSnapshotInput = {
  chainId: JBChainId
  projectId: bigint
  snapshotBlockNumber?: bigint
  /** A hint is accepted only when the canonical Create event proves it. */
  creationBlockNumber?: bigint
  candidateHints?: readonly Address[]
  /** Small block windows work with providers that restrict eth_getLogs. */
  logBlockWindow?: bigint
  /** A full response is bisected; a saturated single block fails closed. */
  logResponseLimit?: number
  signal?: AbortSignal
  onProgress?: (progress: FundSnapshotProgress) => void
}

type HistoryLog = {
  address: Address
  blockNumber: bigint
  blockHash: Hex
  transactionHash: Hex
  logIndex: number
  args: Record<string, unknown>
}

/** Exact canonical JBStickyDeployer source interface; used only for custody discovery. */
const snapshotStickyAbi = parseAbi([
  'event DeploySticky(uint256 indexed projectId,address indexed stakedToken,address token,uint256 cashOutTaxRate,bool soulbound,address caller)',
  'function CONTROLLER() view returns (address)', 'function TERMINAL() view returns (address)',
  'function TOKENS() view returns (address)', 'function stakedTokenOf(uint256 projectId) view returns (address)',
])

export class FundSnapshotCustodyError extends Error {
  readonly code = 'UNRESOLVED_STICKY_CUSTODY'
  constructor(readonly positions: readonly { chainId: number; projectId: bigint; terminal: Address; backing: bigint }[]) {
    super(`The snapshot includes FUND held for Sticky stakers: ${positions.map(position => `project ${position.projectId} on chain ${position.chainId} holds ${formatUnits(position.backing, 18)} FUND`).join('; ')}. Their underlying ownership must be resolved before publishing an initial INCOME allocation; it cannot be assigned to the shared terminal.`)
  }
}

export class FundSnapshotBridgeError extends Error {
  readonly code = 'UNRESOLVED_MULTICHAIN_ENTITLEMENTS'
  readonly unresolvedClaims = 'Historical burn, destination-claim and source emergency-exit leaves have not been reconciled.'
  constructor(readonly bridges: readonly { localSucker: Address; peerChainId: bigint | null; peer: Hex | null }[]) {
    super(`This FUND has historical bridges: ${bridges.map(bridge => `${bridge.localSucker}${bridge.peerChainId === null ? '' : ` to chain ${bridge.peerChainId}`}`).join('; ')}. A complete multichain snapshot must include every live balance plus every unsettled burned-FUND claim exactly once. Destination claims and source emergency exits have not been reconciled; bridge balances and remote supply estimates cannot prove that no claims remain.`)
  }
}

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('The FUND snapshot was cancelled.')
}

function canonicalAddress(value: unknown, label: string): Address {
  if (typeof value !== 'string' || !isAddress(value)) throw new Error(`The ${label} address is invalid.`)
  return getAddress(value)
}

/** No partial result is returned when a provider refuses or truncates a range. */
async function historyLogs(client: PublicClient, input: {
  address: Address; event: AbiEvent; projectId?: bigint; fromBlock: bigint; toBlock: bigint;
  indexedArgs?: Record<string, unknown>;
  limit: number; signal?: AbortSignal;
}): Promise<HistoryLog[]> {
  checkAbort(input.signal)
  let logs: Awaited<ReturnType<typeof client.getLogs>>
  try {
    logs = await client.getLogs({
      address: input.address, event: input.event,
      ...((input.indexedArgs || input.projectId !== undefined) ? { args: { ...input.indexedArgs, ...(input.projectId === undefined ? {} : { projectId: input.projectId }) } } : {}),
      fromBlock: input.fromBlock, toBlock: input.toBlock, strict: true,
    })
  } catch (reason) {
    checkAbort(input.signal)
    if (input.fromBlock === input.toBlock) throw new Error(`Canonical ${input.event.name} history could not be read at block ${input.fromBlock}.`, { cause: reason })
    const middle = (input.fromBlock + input.toBlock) / 2n
    const left = await historyLogs(client, { ...input, toBlock: middle })
    const right = await historyLogs(client, { ...input, fromBlock: middle + 1n })
    return [...left, ...right]
  }
  if (logs.length >= input.limit) {
    if (input.fromBlock === input.toBlock) throw new Error(`The provider may have truncated ${input.event.name} history in a single block. Use a provider with complete log responses.`)
    const middle = (input.fromBlock + input.toBlock) / 2n
    const left = await historyLogs(client, { ...input, toBlock: middle })
    const right = await historyLogs(client, { ...input, fromBlock: middle + 1n })
    return [...left, ...right]
  }
  const result: HistoryLog[] = []
  for (const raw of logs) {
    const log = raw as unknown as HistoryLog & { removed?: boolean }
    if (log.removed || !isAddressEqual(log.address, input.address) || log.blockNumber === null || log.blockNumber < input.fromBlock || log.blockNumber > input.toBlock || !log.blockHash || !log.transactionHash || log.logIndex === null || !log.args) throw new Error('The RPC returned inconsistent FUND history.')
    if (input.projectId !== undefined && log.args.projectId !== input.projectId) throw new Error('The RPC returned history for a different FUND project.')
    for (const [key, value] of Object.entries(input.indexedArgs ?? {})) if (String(log.args[key]).toLowerCase() !== String(value).toLowerCase()) throw new Error('The RPC returned unrelated indexed snapshot history.')
    result.push(log)
  }
  return result
}

async function locateCreation(client: PublicClient, input: FundSnapshotInput, snapshotBlock: bigint, projects: Address) {
  const event = getAbiItem({ abi: jbProjectsAbi, name: 'Create' })
  let creationBlock = input.creationBlockNumber
  if (creationBlock === undefined) {
    // Project IDs are monotonically assigned by the canonical JBProjects. This
    // avoids trusting an indexer's first event or scanning millions of blocks.
    let low = 0n
    let high = snapshotBlock
    while (low < high) {
      checkAbort(input.signal)
      const middle = (low + high) / 2n
      const code = await client.getCode({ address: projects, blockNumber: middle })
      const count = !code || code === '0x' ? 0n : await client.readContract({ address: projects, abi: jbProjectsAbi, functionName: 'count', blockNumber: middle })
      if (count >= input.projectId) high = middle
      else low = middle + 1n
    }
    creationBlock = low
  }
  if (creationBlock < 0n || creationBlock > snapshotBlock) throw new Error('The project creation block is outside the snapshot history.')
  const events = await historyLogs(client, { address: projects, event, projectId: input.projectId, fromBlock: creationBlock, toBlock: creationBlock, limit: input.logResponseLimit ?? 1_000, signal: input.signal })
  if (events.length !== 1) throw new Error('The canonical project creation event could not be verified.')
  return { blockNumber: creationBlock, transactionHash: events[0].transactionHash }
}

/**
 * Single-chain only. Deprecated bridges still contain claimable burned FUND;
 * an empty active-peer list does not establish absence of bridge entitlements.
 * Every historical sucker therefore blocks this generator, even at zero balance.
 */
export async function readFundOwnershipSnapshot(client: PublicClient, input: FundSnapshotInput): Promise<FundOwnershipSnapshot> {
  return await readFundSnapshotCore(client, input, false) as FundOwnershipSnapshot
}

/**
 * Read-only building block for a verified global graph. A zero local supply is
 * allowed because all its FUND may currently be burned into bridge claims.
 * This result alone cannot authorize or describe a complete allocation.
 */
export async function readFundOwnershipForGlobalSnapshot(client: PublicClient, input: FundSnapshotInput): Promise<FundOwnershipForGlobalSnapshot> {
  return await readFundSnapshotCore(client, input, true) as FundOwnershipForGlobalSnapshot
}

async function readFundSnapshotCore(client: PublicClient, input: FundSnapshotInput, globalComponent: boolean): Promise<FundOwnershipSnapshot | FundOwnershipForGlobalSnapshot> {
  checkAbort(input.signal)
  if (!Number.isSafeInteger(input.chainId) || input.chainId <= 0 || input.projectId <= 0n || input.projectId >= 1n << 256n) throw new Error('A supported chain and positive FUND project ID are required.')
  const window = input.logBlockWindow ?? 2_000n
  const limit = input.logResponseLimit ?? 1_000
  if (window <= 0n || window > 100_000n || !Number.isSafeInteger(limit) || limit < 2) throw new Error('Invalid snapshot log pagination settings.')
  if (await client.getChainId() !== input.chainId) throw new Error('The RPC returned a different snapshot chain.')
  const projects = v6Address('JBProjects', input.chainId)
  const tokens = v6Address('JBTokens', input.chainId)
  const controller = v6Address('JBController', input.chainId)
  const directory = v6Address('JBDirectory', input.chainId)
  const suckerRegistry = v6Address('JBSuckerRegistry', input.chainId)
  // Publication must default to finalized ownership. Providers that cannot
  // serve this tag fail explicitly; never silently fall back to an unstable head.
  const block = await client.getBlock(input.snapshotBlockNumber === undefined ? { blockTag: 'finalized' } : { blockNumber: input.snapshotBlockNumber }).catch(reason => {
    throw new Error(input.snapshotBlockNumber === undefined ? 'The RPC could not provide a finalized snapshot block. Use a provider that supports finalized historical reads.' : 'The requested historical snapshot block could not be read.', { cause: reason })
  })
  if (block.number === null || block.number <= 0n || !block.hash || (input.snapshotBlockNumber !== undefined && block.number !== input.snapshotBlockNumber)) throw new Error('A mined snapshot block is required.')
  const at = { blockNumber: block.number }
  const [owner, actualController, token, totalFundSupply, totalCreditSupply, pendingReserved, current, upcoming, queued, allSuckers] = await Promise.all([
    client.readContract({ address: projects, abi: jbProjectsAbi, functionName: 'ownerOf', args: [input.projectId], ...at }),
    client.readContract({ address: directory, abi: jbDirectoryAbi, functionName: 'controllerOf', args: [input.projectId], ...at }),
    client.readContract({ address: tokens, abi: jbTokensAbi, functionName: 'tokenOf', args: [input.projectId], ...at }),
    client.readContract({ address: tokens, abi: jbTokensAbi, functionName: 'totalSupplyOf', args: [input.projectId], ...at }),
    client.readContract({ address: tokens, abi: jbTokensAbi, functionName: 'totalCreditSupplyOf', args: [input.projectId], ...at }),
    client.readContract({ address: controller, abi: jbControllerAbi, functionName: 'pendingReservedTokenBalanceOf', args: [input.projectId], ...at }),
    client.readContract({ address: controller, abi: jbControllerAbi, functionName: 'currentRulesetOf', args: [input.projectId], ...at }),
    client.readContract({ address: controller, abi: jbControllerAbi, functionName: 'upcomingRulesetOf', args: [input.projectId], ...at }),
    client.readContract({ address: controller, abi: jbControllerAbi, functionName: 'latestQueuedRulesetOf', args: [input.projectId], ...at }),
    client.readContract({ address: suckerRegistry, abi: jbSuckerRegistryAbi, functionName: 'allSuckersOf', args: [input.projectId], ...at }),
  ])
  if (!isAddressEqual(actualController, controller) || isAddressEqual(owner, zeroAddress)) throw new Error('The FUND controller or owner is unsupported.')
  if (allSuckers.length && !globalComponent) {
    const bridges = await Promise.all(allSuckers.map(async localSucker => {
      // These optional reads explain the blocker, never weaken it. Historical
      // entries remain blocked even when deprecated peers can no longer answer.
      const [remoteChain, remotePeer] = await Promise.allSettled([
        client.readContract({ address: localSucker, abi: jbSuckerV6ViewAbi, functionName: 'peerChainId', ...at }),
        client.readContract({ address: localSucker, abi: jbSuckerV6ViewAbi, functionName: 'peer', ...at }),
      ])
      return { localSucker, peerChainId: remoteChain.status === 'fulfilled' ? remoteChain.value : null, peer: remotePeer.status === 'fulfilled' ? remotePeer.value : null }
    }))
    throw new FundSnapshotBridgeError(bridges)
  }
  const [ruleset, metadata] = current
  if (ruleset.id === 0 || !metadata.pausePay || metadata.allowOwnerMinting || metadata.cashOutTaxRate !== 10_000 || pendingReserved !== 0n) throw new Error('The snapshot requires a closed FUND with minting finished and no pending reserved tokens.')
  let supportedHook = isAddressEqual(metadata.dataHook, zeroAddress) && !metadata.useDataHookForPay && !metadata.useDataHookForCashOut
  const omnichain = v6Address('JBOmnichainDeployer', input.chainId)
  if (globalComponent && isAddressEqual(metadata.dataHook, omnichain)) {
    const [extra, tiered] = await Promise.all([
      client.readContract({ address: omnichain, abi: jbOmnichainDeployerAbi, functionName: 'extraDataHookOf', args: [input.projectId, BigInt(ruleset.id)], ...at }),
      client.readContract({ address: omnichain, abi: jbOmnichainDeployerAbi, functionName: 'tiered721HookOf', args: [input.projectId, BigInt(ruleset.id)], ...at }),
    ])
    supportedHook = isAddressEqual(extra.dataHook, zeroAddress) && !extra.useDataHookForPay && !extra.useDataHookForCashOut && !tiered[1]
    if (supportedHook && !isAddressEqual(tiered[0], zeroAddress)) {
      const [store, hookProjectId, scope, hookOwner] = await Promise.all([
        client.readContract({ address: tiered[0], abi: jb721TiersHookAbi, functionName: 'STORE', ...at }),
        client.readContract({ address: tiered[0], abi: jb721TiersHookAbi, functionName: 'projectId', ...at }),
        client.readContract({ address: tiered[0], abi: jb721TiersHookAbi, functionName: 'jbOwner', ...at }),
        client.readContract({ address: tiered[0], abi: jb721TiersHookAbi, functionName: 'owner', ...at }),
      ])
      if (!isAddressEqual(store, v6Address('JB721TiersHookStore', input.chainId)) || hookProjectId !== input.projectId || scope[1] !== input.projectId || !isAddressEqual(hookOwner, owner)) throw new Error('The omnichain NFT hook is not scoped to this FUND and owner.')
      const maximumTier = await client.readContract({ address: store, abi: jb721TiersHookStoreAbi, functionName: 'maxTierIdOf', args: [tiered[0]], ...at })
      supportedHook = maximumTier === 0n
    }
  }
  if (ruleset.duration !== 0 || ruleset.weightCutPercent !== 0 || !isAddressEqual(ruleset.approvalHook, zeroAddress) || !supportedHook || [upcoming[0], queued[0]].some(next => next.id !== 0 && next.id !== ruleset.id)) throw new Error('The FUND has custom hooks, scheduled rules, or pending rulesets that prevent a final ownership snapshot.')
  if (totalFundSupply < 0n || (!globalComponent && totalFundSupply === 0n) || totalCreditSupply > totalFundSupply) throw new Error('The FUND supply cannot support an ownership snapshot.')
  const tokenAddress = isAddressEqual(token, zeroAddress) ? null : getAddress(token)
  let totalErc20Supply = 0n
  if (tokenAddress) {
    const [implementation, code, tokenSupply] = await Promise.all([
      client.readContract({ address: tokens, abi: jbTokensAbi, functionName: 'TOKEN', ...at }),
      client.getCode({ address: tokenAddress, ...at }),
      client.readContract({ address: tokenAddress, abi: erc20Abi, functionName: 'totalSupply', ...at }),
    ])
    const expectedCode = `0x363d3d373d3d3d363d73${implementation.slice(2)}5af43d82803e903d91602b57fd5bf3` as Hex
    if (!code || keccak256(code) !== keccak256(expectedCode)) throw new Error('Only canonical core FUND ERC-20 clones can be reconstructed from this history.')
    totalErc20Supply = tokenSupply
  }
  if (totalCreditSupply + totalErc20Supply !== totalFundSupply) throw new Error('The FUND credit and ERC-20 supplies do not reconcile.')
  input.onProgress?.({ stage: 'creation', completed: 0n, total: 1n, candidates: 0 })
  const creation = await locateCreation(client, input, block.number, projects)
  const registeredSticky = (jbContractAddress['6'] as Record<string, Partial<Record<JBChainId, Address>>>).JBStickyDeployer?.[input.chainId]
  let stickyDeployer: Address | null = null
  const terminal = v6Address('JBMultiTerminal', input.chainId)
  if (tokenAddress && registeredSticky && isAddress(registeredSticky) && !isAddressEqual(registeredSticky, zeroAddress)) {
    const code = await client.getCode({ address: registeredSticky, ...at })
    if (code && code !== '0x') {
      const [stickyController, stickyTerminal, stickyTokens] = await Promise.all([
        client.readContract({ address: registeredSticky, abi: snapshotStickyAbi, functionName: 'CONTROLLER', ...at }),
        client.readContract({ address: registeredSticky, abi: snapshotStickyAbi, functionName: 'TERMINAL', ...at }),
        client.readContract({ address: registeredSticky, abi: snapshotStickyAbi, functionName: 'TOKENS', ...at }),
      ])
      if (!isAddressEqual(stickyController, controller) || !isAddressEqual(stickyTerminal, terminal) || !isAddressEqual(stickyTokens, tokens)) throw new Error('The registered Sticky factory does not match canonical FUND custody contracts.')
      stickyDeployer = getAddress(registeredSticky)
    }
  }
  const candidates = new Set<Address>()
  const eventCounts: Record<string, number> = {}
  const sources = [
    { name: 'Mint', event: getAbiItem({ abi: jbTokensAbi, name: 'Mint' }), address: tokens, fields: ['holder'] },
    { name: 'Burn', event: getAbiItem({ abi: jbTokensAbi, name: 'Burn' }), address: tokens, fields: ['holder'] },
    { name: 'ClaimTokens', event: getAbiItem({ abi: jbTokensAbi, name: 'ClaimTokens' }), address: tokens, fields: ['holder', 'beneficiary'] },
    { name: 'TransferCredits', event: getAbiItem({ abi: jbTokensAbi, name: 'TransferCredits' }), address: tokens, fields: ['holder', 'recipient'] },
    { name: 'DeployERC20', event: getAbiItem({ abi: jbTokensAbi, name: 'DeployERC20' }), address: tokens, fields: [] },
    ...(tokenAddress ? [{ name: 'Transfer', event: getAbiItem({ abi: erc20Abi, name: 'Transfer' }), address: tokenAddress, fields: ['from', 'to'] }] : []),
    ...(stickyDeployer ? [{ name: 'DeploySticky', event: getAbiItem({ abi: snapshotStickyAbi, name: 'DeploySticky' }), address: stickyDeployer, fields: [] }] : []),
  ]
  let canonicalTokenDeployment = tokenAddress === null
  const stickyProjects = new Set<bigint>()
  const seen = new Set<string>()
  for (let start = creation.blockNumber; start <= block.number; start += window) {
    checkAbort(input.signal)
    const end = start + window - 1n < block.number ? start + window - 1n : block.number
    for (const source of sources) {
      const logs = await historyLogs(client, { address: source.address, event: source.event, projectId: ['Transfer', 'DeploySticky'].includes(source.name) ? undefined : input.projectId, indexedArgs: source.name === 'DeploySticky' ? { stakedToken: tokenAddress } : undefined, fromBlock: start, toBlock: end, limit, signal: input.signal })
      for (const log of logs) {
        const identity = `${log.transactionHash}:${log.logIndex}`
        if (seen.has(identity)) throw new Error('The RPC returned duplicate FUND history entries.')
        seen.add(identity)
        eventCounts[source.name] = (eventCounts[source.name] ?? 0) + 1
        if (source.name === 'DeployERC20' && tokenAddress && isAddressEqual(canonicalAddress(log.args.token, 'deployed token'), tokenAddress)) canonicalTokenDeployment = true
        if (source.name === 'DeploySticky') {
          if (typeof log.args.projectId !== 'bigint' || log.args.projectId <= 0n) throw new Error('The canonical Sticky project ID is invalid.')
          stickyProjects.add(log.args.projectId)
        }
        for (const field of source.fields) candidates.add(canonicalAddress(log.args[field], field))
      }
    }
    input.onProgress?.({ stage: 'history', completed: end - creation.blockNumber + 1n, total: block.number - creation.blockNumber + 1n, candidates: candidates.size })
  }
  if (!canonicalTokenDeployment) throw new Error('The canonical FUND ERC-20 deployment event is missing. An externally attached token is unsupported.')
  // A raw transfer to the shared terminal is not proof of staking: treating
  // every such donation as custody would recreate the dust launch denial of
  // service. Only canonical factory projects with positive accounted backing
  // establish unresolved beneficial ownership here.
  const custody: { chainId: number; projectId: bigint; terminal: Address; backing: bigint }[] = []
  if (stickyDeployer && tokenAddress) for (const projectId of stickyProjects) {
    checkAbort(input.signal)
    const [underlying, backing] = await Promise.all([
      client.readContract({ address: stickyDeployer, abi: snapshotStickyAbi, functionName: 'stakedTokenOf', args: [projectId], ...at }),
      client.readContract({ address: v6Address('JBTerminalStore', input.chainId), abi: jbTerminalStoreAbi, functionName: 'balanceOf', args: [terminal, projectId, tokenAddress], ...at }),
    ])
    if (!isAddressEqual(underlying, tokenAddress)) throw new Error('Sticky custody history does not match the factory’s immutable underlying token.')
    if (backing > 0n) custody.push({ chainId: input.chainId, projectId, terminal, backing })
  }
  if (custody.length && !globalComponent) throw new FundSnapshotCustodyError(custody)
  const canonicalCandidateCount = candidates.size
  // Discovery hints do not alter the committed canonical-history statistics.
  // A zero-balance hint must not change otherwise identical manifests.
  for (const hint of input.candidateHints ?? []) candidates.add(canonicalAddress(hint, 'candidate'))
  // The zero address can own core credits. Keep it: dropping it would corrupt
  // the denominator and let one zero-address transfer block all distributions.
  const addresses = [...candidates].sort((left, right) => left.toLowerCase() < right.toLowerCase() ? -1 : left.toLowerCase() > right.toLowerCase() ? 1 : 0)
  const holders: FundSnapshotHolder[] = []
  for (let offset = 0; offset < addresses.length; offset += 16) {
    checkAbort(input.signal)
    const balances = await Promise.all(addresses.slice(offset, offset + 16).map(async holder => {
      const [creditBalance, erc20Balance, balance] = await Promise.all([
        client.readContract({ address: tokens, abi: jbTokensAbi, functionName: 'creditBalanceOf', args: [holder, input.projectId], ...at }),
        tokenAddress ? client.readContract({ address: tokenAddress, abi: erc20Abi, functionName: 'balanceOf', args: [holder], ...at }) : Promise.resolve(0n),
        client.readContract({ address: tokens, abi: jbTokensAbi, functionName: 'totalBalanceOf', args: [holder, input.projectId], ...at }),
      ])
      if (creditBalance + erc20Balance !== balance) throw new Error('A FUND holder balance did not reconcile at the snapshot block.')
      return { holder, balance, creditBalance, erc20Balance }
    }))
    holders.push(...balances.filter(holder => holder.balance > 0n))
    input.onProgress?.({ stage: 'balances', completed: BigInt(Math.min(offset + 16, addresses.length)), total: BigInt(addresses.length), candidates: candidates.size })
  }
  if (holders.reduce((sum, holder) => sum + holder.balance, 0n) !== totalFundSupply || holders.reduce((sum, holder) => sum + holder.creditBalance, 0n) !== totalCreditSupply || holders.reduce((sum, holder) => sum + holder.erc20Balance, 0n) !== totalErc20Supply) throw new Error('FUND ownership history is incomplete: discovered balances do not cover the entire credit and ERC-20 supply. No distribution was generated.')
  checkAbort(input.signal)
  const resolved = globalComponent && custody.length && stickyDeployer && tokenAddress
    ? await resolveFundStickyCustody(client, {
      chainId: input.chainId, blockNumber: block.number, factory: stickyDeployer, rootToken: tokenAddress,
      rootCreationBlockNumber: creation.blockNumber, holders, logBlockWindow: window, signal: input.signal,
      readHistory: request => historyLogs(client, { ...request, limit, signal: input.signal }),
    }) : null
  const sameBlock = await client.getBlock({ blockNumber: block.number })
  if (sameBlock.number !== block.number || sameBlock.hash !== block.hash) throw new Error('The chain reorganized during the FUND snapshot. Start again from a finalized block.')
  input.onProgress?.({ stage: 'complete', completed: BigInt(holders.length), total: BigInt(holders.length), candidates: candidates.size })
  const result = {
    chainId: input.chainId, projectId: input.projectId, blockNumber: block.number, blockHash: block.hash,
    blockTimestamp: block.timestamp, creationBlockNumber: creation.blockNumber, creationTransactionHash: creation.transactionHash,
    owner, tokenAddress, totalFundSupply, totalCreditSupply, totalErc20Supply, holders,
  }
  const evidence = { projects, tokens, controller, suckerRegistry, eventCounts, candidateCount: canonicalCandidateCount }
  if (globalComponent) return { ...result, historicalSuckers: [...allSuckers], beneficialHolders: resolved?.holders ?? holders.map(row => ({ holder: row.holder, balance: row.balance, weight: ownershipWeight(row.balance) })), ...(resolved ? { stickyCustody: resolved.custody } : {}), evidence: { ...evidence, bridgePolicy: 'historical-graph-required' } }
  return { ...result, evidence: { ...evidence, bridgePolicy: 'no-historical-suckers' } }
}
