/** Canonical Sticky custody, decomposed into its underlying token's units at one block. */
import { jbDirectoryAbi, jbMultiTerminalAbi, jbProjectsAbi, jbTerminalStoreAbi, jbTokensAbi, type JBChainId } from '@bananapus/nana-sdk-core'
import { v6Address } from '@bananapus/nana-sdk-core/v6'
import { erc20Abi, getAbiItem, getAddress, isAddressEqual, parseAbi, zeroAddress, type AbiEvent, type Address, type Hex, type PublicClient } from 'viem'
import type { FundSnapshotHolder } from './fund-snapshot'
import { addOwnershipWeights, multiplyOwnershipWeight, ownershipWeight, sumOwnershipWeights, type FundOwnershipWeight } from './fund-ownership-weight'

export type StickyOwnershipHolder = { holder: Address; balance: bigint; weight: FundOwnershipWeight }
export type StickyCustodyLog = { address: Address; blockNumber: bigint; blockHash: Hex; transactionHash: Hex; logIndex: number; args: Record<string, unknown> }
export type StickyCustodyHistoryRequest = { address: Address; event: AbiEvent; projectId?: bigint; indexedArgs?: Record<string, unknown>; fromBlock: bigint; toBlock: bigint }
export type StickyCustodyPool = {
  projectId: bigint; underlyingToken: Address; shareToken: Address; creationBlockNumber: bigint; creationTransactionHash: Hex
  terminal: Address; hook: Address; priceFeed: Address; cashOutTaxRate: bigint; soulbound: boolean
  backing: bigint; recordedOrphanedBacking: bigint; orphanedBacking: bigint; shareOwnedBacking: bigint
  totalShareSupply: bigint; totalShareCreditSupply: bigint
  holders: FundSnapshotHolder[]; beneficialShareHolders: StickyOwnershipHolder[]; allocatedUnderlying: StickyOwnershipHolder[]
  eventCounts: Record<string, number>; candidateCount: number
}
export type FundStickyCustody = {
  policy: 'canonical-sticky-exact-ratios-recursive; orphaned-backing-remains-terminal; integer-projection-remainder-to-lowest-address'
  factory: Address; terminal: Address; pools: StickyCustodyPool[]
}

const factoryAbi = parseAbi([
  'event DeploySticky(uint256 indexed projectId,address indexed stakedToken,address token,uint256 cashOutTaxRate,bool soulbound,address caller)',
  'function HOOK() view returns (address)', 'function stakedTokenOf(uint256) view returns (address)',
  'function cashOutTaxRateOf(uint256) view returns (uint256)', 'function priceFeedOf(uint256) view returns (address)',
])
const hookAbi = parseAbi([
  'function DEPLOYER() view returns (address)', 'function DIRECTORY() view returns (address)',
  'function tokenOf(uint256) view returns (address)', 'function orphanedBalanceOf(uint256) view returns (uint256)',
  'function stakedBalanceOf(uint256,address) view returns (uint256)',
])
const shareAbi = [...erc20Abi, ...parseAbi([
  'function HOOK() view returns (address)', 'function TOKENS() view returns (address)',
  'function PROJECT_ID() view returns (uint256)', 'function SOULBOUND() view returns (bool)',
])] as const
const feedAbi = parseAbi([
  'function DECIMALS() view returns (uint8)', 'function CURRENCY() view returns (uint32)',
  'function HOOK() view returns (address)', 'function TERMINAL() view returns (address)',
  'function TOKEN() view returns (address)', 'function PROJECT_ID() view returns (uint256)', 'function UNDERLYING_TOKEN() view returns (address)',
])
const compareAddress = (left: Address, right: Address) => left.toLowerCase() < right.toLowerCase() ? -1 : left.toLowerCase() > right.toLowerCase() ? 1 : 0
/** Integer balances are a conserved display projection; allocation uses weight. */
function projectBalances(weights: ReadonlyMap<string, FundOwnershipWeight>, expectedTotal: bigint): StickyOwnershipHolder[] {
  const rows = [...weights].filter(([, weight]) => weight.numerator > 0n).map(([holder, weight]) => ({ holder: getAddress(holder), balance: weight.numerator / weight.denominator, weight })).sort((left, right) => compareAddress(left.holder, right.holder))
  const total = sumOwnershipWeights(rows.map(row => row.weight))
  if (total.numerator !== expectedTotal * total.denominator) throw new Error('Exact Sticky ownership does not conserve its underlying token.')
  if (rows.length) rows[0].balance += expectedTotal - rows.reduce((sum, row) => sum + row.balance, 0n)
  return rows
}
function uint(value: unknown, label: string): bigint {
  if (typeof value !== 'bigint' || value < 0n || value >= 1n << 256n) throw new Error(`Invalid ${label} in canonical Sticky custody.`)
  return value
}
function address(value: unknown): Address { return getAddress(value as Address) }

/**
 * The caller authenticates the registered factory and pins/rechecks the block.
 * Only canonical Sticky principal is expanded. Other contract addresses retain
 * their actual holder identity; this is not an adapter for arbitrary wrappers,
 * distributor rounds or reward pockets. Orphaned and donated terminal balances
 * remain with the terminal, not with later shareholders. Gross backing weights
 * are ownership-allocation policy, not nonlinear taxed redemption quotes.
 */
export async function resolveFundStickyCustody(client: PublicClient, input: {
  chainId: JBChainId; blockNumber: bigint; factory: Address; rootToken: Address; rootCreationBlockNumber: bigint
  holders: readonly FundSnapshotHolder[]; logBlockWindow: bigint; signal?: AbortSignal
  readHistory: (request: StickyCustodyHistoryRequest) => Promise<StickyCustodyLog[]>
}): Promise<{ holders: StickyOwnershipHolder[]; custody: FundStickyCustody }> {
  const terminal = v6Address('JBMultiTerminal', input.chainId), tokens = v6Address('JBTokens', input.chainId)
  const directory = v6Address('JBDirectory', input.chainId), projects = v6Address('JBProjects', input.chainId)
  const controller = v6Address('JBController', input.chainId), store = v6Address('JBTerminalStore', input.chainId)
  const at = { blockNumber: input.blockNumber }, pools: StickyCustodyPool[] = [], active = new Set<string>(), seenPools = new Set<bigint>()
  function abort() { if (input.signal?.aborted) throw new Error('The Sticky ownership snapshot was cancelled.') }
  abort()
  const hook = await client.readContract({ address: input.factory, abi: factoryAbi, functionName: 'HOOK', ...at })
  const [hookFactory, hookDirectory, hookCode] = await Promise.all([
    client.readContract({ address: hook, abi: hookAbi, functionName: 'DEPLOYER', ...at }),
    client.readContract({ address: hook, abi: hookAbi, functionName: 'DIRECTORY', ...at }), client.getCode({ address: hook, ...at }),
  ])
  if (!hookCode || hookCode === '0x' || !isAddressEqual(hookFactory, input.factory) || !isAddressEqual(hookDirectory, directory)) throw new Error('The canonical Sticky custody hook is not bound to its factory and directory.')

  async function scan(request: Omit<StickyCustodyHistoryRequest, 'fromBlock' | 'toBlock'>, fromBlock: bigint) {
    const result: StickyCustodyLog[] = []
    for (let start = fromBlock; start <= input.blockNumber; start += input.logBlockWindow) {
      abort()
      const end = start + input.logBlockWindow - 1n
      result.push(...await input.readHistory({ ...request, fromBlock: start, toBlock: end < input.blockNumber ? end : input.blockNumber }))
    }
    const seen = new Set<string>()
    for (const log of result) {
      const key = `${log.blockNumber}:${log.logIndex}`
      if (seen.has(key)) throw new Error('The canonical Sticky custody history repeats an event.')
      seen.add(key)
    }
    return result.sort((left, right) => left.blockNumber === right.blockNumber ? left.logIndex - right.logIndex : left.blockNumber < right.blockNumber ? -1 : 1)
  }

  async function poolHolders(projectId: bigint, token: Address, creation: bigint, total: bigint) {
    const candidates = new Map<string, Address>(), eventCounts: Record<string, number> = {}, eventPositions = new Set<string>()
    const sources = [
      { name: 'Mint', emitter: tokens, event: getAbiItem({ abi: jbTokensAbi, name: 'Mint' }), fields: ['holder'], projectId },
      { name: 'Burn', emitter: tokens, event: getAbiItem({ abi: jbTokensAbi, name: 'Burn' }), fields: ['holder'], projectId },
      { name: 'ClaimTokens', emitter: tokens, event: getAbiItem({ abi: jbTokensAbi, name: 'ClaimTokens' }), fields: ['holder', 'beneficiary'], projectId },
      { name: 'TransferCredits', emitter: tokens, event: getAbiItem({ abi: jbTokensAbi, name: 'TransferCredits' }), fields: ['holder', 'recipient'], projectId },
      { name: 'Transfer', emitter: token, event: getAbiItem({ abi: erc20Abi, name: 'Transfer' }), fields: ['from', 'to'] },
    ]
    for (const source of sources) {
      const logs = await scan({ address: source.emitter, event: source.event, projectId: source.projectId }, creation)
      eventCounts[source.name] = logs.length
      for (const log of logs) {
        const position = `${log.blockNumber}:${log.logIndex}`
        if (eventPositions.has(position)) throw new Error('The Sticky holder history contains conflicting event positions.')
        eventPositions.add(position)
        for (const field of source.fields) { const holder = address(log.args[field]); candidates.set(holder.toLowerCase(), holder) }
      }
    }
    const addresses = [...candidates.values()].sort(compareAddress), holders: FundSnapshotHolder[] = []
    for (let start = 0; start < addresses.length; start += 16) {
      abort()
      const batch = await Promise.all(addresses.slice(start, start + 16).map(async holder => {
        const [creditBalance, erc20Balance, balance, staked] = await Promise.all([
          client.readContract({ address: tokens, abi: jbTokensAbi, functionName: 'creditBalanceOf', args: [holder, projectId], ...at }),
          client.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [holder], ...at }),
          client.readContract({ address: tokens, abi: jbTokensAbi, functionName: 'totalBalanceOf', args: [holder, projectId], ...at }),
          client.readContract({ address: hook, abi: hookAbi, functionName: 'stakedBalanceOf', args: [projectId, holder], ...at }),
        ])
        // The factory attaches SHARE atomically before any mint. Its immutable
        // hook denominator is ERC20 supply; unexplained core credits are not a
        // valid canonical pool and must never dilute real SHARE owners.
        if (creditBalance !== 0n || erc20Balance !== balance || staked !== balance) throw new Error('Canonical Sticky SHARE balances disagree with their core or hook accounting.')
        return { holder, creditBalance, erc20Balance, balance }
      }))
      holders.push(...batch.filter(row => row.balance > 0n))
    }
    if (holders.reduce((sum, row) => sum + row.balance, 0n) !== total) throw new Error('Canonical Sticky history does not cover the complete SHARE supply.')
    return { holders, eventCounts, candidateCount: candidates.size }
  }

  async function resolve(token: Address, rawHolders: readonly FundSnapshotHolder[], creationBlock: bigint): Promise<StickyOwnershipHolder[]> {
    abort()
    const key = token.toLowerCase()
    if (active.has(key)) throw new Error('The canonical Sticky custody graph contains a cycle.')
    active.add(key)
    try {
      const balances = new Map(rawHolders.map(row => [row.holder.toLowerCase(), ownershipWeight(row.balance)]))
      const terminalRow = rawHolders.find(row => isAddressEqual(row.holder, terminal))
      let accountedBacking = 0n
      const events = await scan({ address: input.factory, event: getAbiItem({ abi: factoryAbi, name: 'DeploySticky' }), indexedArgs: { stakedToken: token } }, creationBlock)
      for (const event of events) {
        abort()
        const projectId = uint(event.args.projectId, 'pool ID'), shareToken = address(event.args.token)
        if (projectId === 0n || seenPools.has(projectId) || isAddressEqual(shareToken, zeroAddress) || active.has(shareToken.toLowerCase())) throw new Error('The canonical Sticky custody graph contains a duplicate or cyclic pool.')
        seenPools.add(projectId)
        const [underlying, tax, feed, actualToken, owner, actualController, primaryTerminal, shareHook, shareTokens, shareProject, soulbound, shareSupply, creditSupply, coreSupply, hookToken, recordedOrphanedBacking, backing, context, code] = await Promise.all([
          client.readContract({ address: input.factory, abi: factoryAbi, functionName: 'stakedTokenOf', args: [projectId], ...at }),
          client.readContract({ address: input.factory, abi: factoryAbi, functionName: 'cashOutTaxRateOf', args: [projectId], ...at }),
          client.readContract({ address: input.factory, abi: factoryAbi, functionName: 'priceFeedOf', args: [projectId], ...at }),
          client.readContract({ address: tokens, abi: jbTokensAbi, functionName: 'tokenOf', args: [projectId], ...at }),
          client.readContract({ address: projects, abi: jbProjectsAbi, functionName: 'ownerOf', args: [projectId], ...at }),
          client.readContract({ address: directory, abi: jbDirectoryAbi, functionName: 'controllerOf', args: [projectId], ...at }),
          client.readContract({ address: directory, abi: jbDirectoryAbi, functionName: 'primaryTerminalOf', args: [projectId, token], ...at }),
          client.readContract({ address: shareToken, abi: shareAbi, functionName: 'HOOK', ...at }),
          client.readContract({ address: shareToken, abi: shareAbi, functionName: 'TOKENS', ...at }),
          client.readContract({ address: shareToken, abi: shareAbi, functionName: 'PROJECT_ID', ...at }),
          client.readContract({ address: shareToken, abi: shareAbi, functionName: 'SOULBOUND', ...at }),
          client.readContract({ address: shareToken, abi: erc20Abi, functionName: 'totalSupply', ...at }),
          client.readContract({ address: tokens, abi: jbTokensAbi, functionName: 'totalCreditSupplyOf', args: [projectId], ...at }),
          client.readContract({ address: tokens, abi: jbTokensAbi, functionName: 'totalSupplyOf', args: [projectId], ...at }),
          client.readContract({ address: hook, abi: hookAbi, functionName: 'tokenOf', args: [projectId], ...at }),
          client.readContract({ address: hook, abi: hookAbi, functionName: 'orphanedBalanceOf', args: [projectId], ...at }),
          client.readContract({ address: store, abi: jbTerminalStoreAbi, functionName: 'balanceOf', args: [terminal, projectId, token], ...at }),
          client.readContract({ address: terminal, abi: jbMultiTerminalAbi, functionName: 'accountingContextForTokenOf', args: [projectId, token], ...at }),
          client.getCode({ address: shareToken, ...at }),
        ])
        if (!code || code === '0x' || !isAddressEqual(underlying, token) || !isAddressEqual(actualToken, shareToken) || !isAddressEqual(owner, input.factory) || !isAddressEqual(actualController, controller) || !isAddressEqual(primaryTerminal, terminal) || !isAddressEqual(shareHook, hook) || !isAddressEqual(shareTokens, tokens) || shareProject !== projectId || !isAddressEqual(hookToken, shareToken) || soulbound !== event.args.soulbound || tax !== event.args.cashOutTaxRate || creditSupply !== 0n || shareSupply !== coreSupply) throw new Error('A discovered Sticky pool does not match its immutable canonical creation and SHARE accounting.')
        const [feedDecimals, feedCurrency, feedHook, feedTerminal, feedToken, feedProject, feedUnderlying, surplus] = await Promise.all([
          client.readContract({ address: feed, abi: feedAbi, functionName: 'DECIMALS', ...at }),
          client.readContract({ address: feed, abi: feedAbi, functionName: 'CURRENCY', ...at }),
          client.readContract({ address: feed, abi: feedAbi, functionName: 'HOOK', ...at }),
          client.readContract({ address: feed, abi: feedAbi, functionName: 'TERMINAL', ...at }),
          client.readContract({ address: feed, abi: feedAbi, functionName: 'TOKEN', ...at }),
          client.readContract({ address: feed, abi: feedAbi, functionName: 'PROJECT_ID', ...at }),
          client.readContract({ address: feed, abi: feedAbi, functionName: 'UNDERLYING_TOKEN', ...at }),
          client.readContract({ address: terminal, abi: jbMultiTerminalAbi, functionName: 'currentSurplusOf', args: [projectId, [token], BigInt(context.decimals), BigInt(context.currency)], ...at }),
        ])
        if (!isAddressEqual(context.token, token) || feedDecimals !== context.decimals || feedCurrency !== context.currency || !isAddressEqual(feedHook, hook) || !isAddressEqual(feedTerminal, terminal) || !isAddressEqual(feedToken, shareToken) || !isAddressEqual(feedUnderlying, token) || feedProject !== projectId || surplus !== backing || (shareSupply > 0n && recordedOrphanedBacking > backing)) throw new Error('The canonical Sticky pool backing or cached price-feed identity is inconsistent.')
        accountedBacking += backing
        if (accountedBacking > (terminalRow?.erc20Balance ?? 0n)) throw new Error('Canonical Sticky pool ledgers exceed the shared terminal’s actual underlying-token balance.')
        const orphanedBacking = shareSupply === 0n ? backing : recordedOrphanedBacking
        const shareOwnedBacking = backing - orphanedBacking
        const measured = await poolHolders(projectId, shareToken, event.blockNumber, shareSupply)
        const beneficialShareHolders = await resolve(shareToken, measured.holders, event.blockNumber)
        const allocatedWeights = new Map(beneficialShareHolders.map(row => [row.holder.toLowerCase(), multiplyOwnershipWeight(row.weight, shareOwnedBacking, shareSupply)]))
        const allocatedUnderlying = projectBalances(allocatedWeights, shareOwnedBacking)
        if (shareOwnedBacking > 0n && !allocatedUnderlying.length) throw new Error('Sticky backing has no reconstructable beneficial owners.')
        const previous = balances.get(terminal.toLowerCase()) ?? ownershipWeight(0n)
        balances.set(terminal.toLowerCase(), ownershipWeight(previous.numerator - shareOwnedBacking * previous.denominator, previous.denominator))
        for (const row of allocatedUnderlying) balances.set(row.holder.toLowerCase(), addOwnershipWeights(balances.get(row.holder.toLowerCase()) ?? ownershipWeight(0n), row.weight))
        pools.push({ projectId, underlyingToken: token, shareToken, creationBlockNumber: event.blockNumber, creationTransactionHash: event.transactionHash, terminal, hook, priceFeed: feed, cashOutTaxRate: tax, soulbound, backing, recordedOrphanedBacking, orphanedBacking, shareOwnedBacking, totalShareSupply: shareSupply, totalShareCreditSupply: creditSupply, ...measured, beneficialShareHolders, allocatedUnderlying })
      }
      return projectBalances(balances, rawHolders.reduce((sum, row) => sum + row.balance, 0n))
    } finally { active.delete(key) }
  }
  const holders = await resolve(input.rootToken, input.holders, input.rootCreationBlockNumber)
  pools.sort((left, right) => left.projectId < right.projectId ? -1 : left.projectId > right.projectId ? 1 : 0)
  return { holders, custody: { policy: 'canonical-sticky-exact-ratios-recursive; orphaned-backing-remains-terminal; integer-projection-remainder-to-lowest-address', factory: input.factory, terminal, pools } }
}
