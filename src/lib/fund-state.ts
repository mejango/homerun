/** Live V6 state. Browser drafts and indexer records are never transaction authority. */
import {
  NATIVE_TOKEN,
  USDC_ADDRESSES,
  jb721TiersHookAbi,
  jb721TiersHookStoreAbi,
  jbContractAddress,
  jbControllerAbi,
  jbDirectoryAbi,
  jbFundAccessLimitsAbi,
  jbMultiTerminalAbi,
  jbOmnichainDeployerAbi,
  jbPermissionsAbi,
  jbProjectsAbi,
  jbSplitsAbi,
  jbSuckerRegistryAbi,
  jbTerminalStoreAbi,
  jbTokensAbi,
  type JBChainId,
} from '@bananapus/nana-sdk-core'
import {
  JBPermissionIdsV6,
  RESERVED_TOKEN_SPLIT_GROUP_ID,
  payoutSplitGroupId,
  jbSuckerV6ViewAbi,
  v6Address,
  type JBRuleset,
  type JBRulesetConfig,
  type JBRulesetMetadata,
  type JBRulesetWithMetadata,
} from '@bananapus/nana-sdk-core/v6'
import {
  erc20Abi,
  getAddress,
  isAddressEqual,
  zeroAddress,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem'
import type { FundRulesetSnapshot } from './fund-contracts'

export type FundAccountingContext = {
  token: Address
  decimals: number
  currency: number
  terminal: Address
  primaryTerminal: Address
  isPrimary: boolean
  balance: bigint
  /** Terminal-local surplus in this context's currency and decimals. */
  surplus: bigint
  symbol: string
  payoutLimits: JBRulesetConfig['fundAccessLimitGroups'][number]['payoutLimits']
  surplusAllowances: JBRulesetConfig['fundAccessLimitGroups'][number]['surplusAllowances']
}

export type FundLinkedPeer = {
  chainId: number
  /** The remote sucker; its projectId must be read on the remote chain. */
  suckerAddress: Address
  localSuckerAddress: Address
}

export type FundProjectPermissions = {
  queueRulesets: boolean
  mintTokens: boolean
  useAllowance: boolean
  sendPayouts: boolean
  deployErc20: boolean
  setProjectUri: boolean
}

export type FundProjectState = {
  chainId: JBChainId
  projectId: bigint
  blockNumber: bigint
  blockHash: Hex
  blockTimestamp: bigint
  /** This is the actual JBProjects NFT owner, including a Safe contract. */
  owner: Address
  /** FUND has no separate REVOwner operator; this is the NFT owner. */
  operator: Address
  account: Address | null
  controller: Address
  supportedController: boolean
  /** False for REVOwner: revnet governance must never be treated as FUND ownership. */
  knownOwnerWrapper: boolean
  terminals: readonly Address[]
  supportedTerminals: boolean
  ruleset: JBRuleset
  metadata: JBRulesetMetadata
  upcoming: JBRulesetWithMetadata | null
  queued: (JBRulesetWithMetadata & { approvalStatus: number }) | null
  hasPendingRuleset: boolean
  projectUri: string
  tokenAddress: Address | null
  tokenSymbol: string
  tokenDecimals: number
  totalSupply: bigint
  totalCreditSupply: bigint
  pendingReservedTokens: bigint
  totalSupplyWithReservedTokens: bigint
  creditBalance: bigint
  erc20Balance: bigint
  totalBalance: bigint
  accountingContexts: FundAccountingContext[]
  permissions: FundProjectPermissions
  linkedPeers: FundLinkedPeer[]
  linkedChainIds: readonly number[]
  /** Only self is known locally. Never assume matching project IDs across chains. */
  linkedProjects: readonly { chainId: number; projectId: bigint }[]
  rulesetSnapshot: FundRulesetSnapshot
  issues: readonly string[]
}

const PERMISSIONS = {
  queueRulesets: JBPermissionIdsV6.QUEUE_RULESETS,
  mintTokens: JBPermissionIdsV6.MINT_TOKENS,
  useAllowance: JBPermissionIdsV6.USE_ALLOWANCE,
  sendPayouts: JBPermissionIdsV6.SEND_PAYOUTS,
  deployErc20: JBPermissionIdsV6.DEPLOY_ERC20,
  setProjectUri: JBPermissionIdsV6.SET_PROJECT_URI,
} as const

function nonzero(address: Address): boolean {
  return !isAddressEqual(address, zeroAddress)
}

function boundedCount(length: number, maximum: number, label: string): void {
  if (length > maximum) throw new Error(`${label} exceeds the supported read limit; use the full Juicebox interface.`)
}

function remoteAddress(value: Hex): Address {
  if (!/^0x0{24}[\da-f]{40}$/i.test(value)) throw new Error('The FUND bridge names an unsupported remote address.')
  const address = getAddress(`0x${value.slice(-40)}`)
  if (!nonzero(address)) throw new Error('The FUND bridge has no remote peer address.')
  return address
}

/**
 * A completed read is an internally consistent observation at one block, not a
 * promise that rules will still match after a wallet prompt. Refresh immediately
 * before simulation/submission and use the transaction runtime's revalidation.
 * Any required RPC failure rejects the entire read; optional symbol/URI failures
 * cannot turn a missing balance or permission into a plausible zero/true value.
 */
export async function readFundProjectState(
  client: PublicClient,
  { chainId, projectId, account }: { chainId: number; projectId: bigint; account?: Address },
): Promise<FundProjectState> {
  if (!Number.isSafeInteger(chainId) || chainId <= 0 || projectId <= 0n || projectId >= 1n << 256n) {
    throw new Error('A supported chain and positive project ID are required.')
  }
  if (client.chain && client.chain.id !== chainId) throw new Error('The RPC client is connected to a different chain.')
  if (await client.getChainId() !== chainId) throw new Error('The RPC endpoint returned a different chain.')
  const chain = chainId as JBChainId
  const projects = v6Address('JBProjects', chain)
  const directory = v6Address('JBDirectory', chain)
  const canonicalController = v6Address('JBController', chain)
  const canonicalTerminal = v6Address('JBMultiTerminal', chain)
  const routerRegistry = v6Address('JBRouterTerminalRegistry', chain)
  const tokens = v6Address('JBTokens', chain)
  const terminalStore = v6Address('JBTerminalStore', chain)
  const accessLimits = v6Address('JBFundAccessLimits', chain)
  const splits = v6Address('JBSplits', chain)
  const permissionsAddress = v6Address('JBPermissions', chain)
  const omnichain = v6Address('JBOmnichainDeployer', chain)
  const suckerRegistry = v6Address('JBSuckerRegistry', chain)
  const block = await client.getBlock({ blockTag: 'latest' })
  if (block.number === null || !block.hash) throw new Error('The RPC did not return a mined snapshot block.')
  const blockNumber = block.number
  const at = { blockNumber }
  const issues: string[] = []

  const [owner, controller, terminals, current, upcomingResult, queuedResult, token, totalSupply,
    totalCreditSupply, pendingReservedTokens, totalSupplyWithReservedTokens, peers] = await Promise.all([
    client.readContract({ address: projects, abi: jbProjectsAbi, functionName: 'ownerOf', args: [projectId], ...at }),
    client.readContract({ address: directory, abi: jbDirectoryAbi, functionName: 'controllerOf', args: [projectId], ...at }),
    client.readContract({ address: directory, abi: jbDirectoryAbi, functionName: 'terminalsOf', args: [projectId], ...at }),
    client.readContract({ address: canonicalController, abi: jbControllerAbi, functionName: 'currentRulesetOf', args: [projectId], ...at }),
    client.readContract({ address: canonicalController, abi: jbControllerAbi, functionName: 'upcomingRulesetOf', args: [projectId], ...at }),
    client.readContract({ address: canonicalController, abi: jbControllerAbi, functionName: 'latestQueuedRulesetOf', args: [projectId], ...at }),
    client.readContract({ address: tokens, abi: jbTokensAbi, functionName: 'tokenOf', args: [projectId], ...at }),
    client.readContract({ address: tokens, abi: jbTokensAbi, functionName: 'totalSupplyOf', args: [projectId], ...at }),
    client.readContract({ address: tokens, abi: jbTokensAbi, functionName: 'totalCreditSupplyOf', args: [projectId], ...at }),
    client.readContract({ address: canonicalController, abi: jbControllerAbi, functionName: 'pendingReservedTokenBalanceOf', args: [projectId], ...at }),
    client.readContract({ address: canonicalController, abi: jbControllerAbi, functionName: 'totalTokenSupplyWithReservedTokensOf', args: [projectId], ...at }),
    client.readContract({ address: suckerRegistry, abi: jbSuckerRegistryAbi, functionName: 'suckerPairsOf', args: [projectId], ...at }),
  ])
  if (!nonzero(owner)) throw new Error('The project has no owner.')
  boundedCount(terminals.length, 16, 'Payment terminal count')
  boundedCount(peers.length, 32, 'Bridge peer count')
  const supportedController = isAddressEqual(controller, canonicalController)
  if (!supportedController) issues.push('This project uses a different controller. FUND transactions are unavailable.')
  // The SDK's standard terminal configuration also registers the router
  // registry. It forwards payments and its currentSurplusOf is always zero;
  // its discovery contexts describe the downstream router, not a second
  // treasury. Read balances, effective payout groups and limits only from the
  // actual MultiTerminal below, without duplicating forwarding contexts.
  const supportedTerminals = terminals.some(terminal => isAddressEqual(terminal, canonicalTerminal)) &&
    terminals.every(terminal => isAddressEqual(terminal, canonicalTerminal) || isAddressEqual(terminal, routerRegistry))
  if (!supportedTerminals) issues.push('This project has unsupported or missing payment terminals.')
  const revOwner = (jbContractAddress['6'] as Record<string, Record<number, Address | undefined>>).REVOwner?.[chainId]
  const knownOwnerWrapper = !revOwner || !isAddressEqual(owner, revOwner)
  if (!knownOwnerWrapper) issues.push('This is a revnet. Its limited operator permissions are different from FUND ownership.')
  const [ruleset, metadata] = current
  const upcoming = upcomingResult[0].id === 0 ? null : { ruleset: upcomingResult[0], metadata: upcomingResult[1] }
  const queued = queuedResult[0].id === 0 ? null : { ruleset: queuedResult[0], metadata: queuedResult[1], approvalStatus: queuedResult[2] }
  const hasPendingRuleset = [upcoming?.ruleset, queued?.ruleset].some(next => next && next.id !== ruleset.id)
  if (ruleset.id === 0) issues.push('The first ruleset has not started.')
  if (hasPendingRuleset) issues.push('Another ruleset is already queued. Review it before changing the rules.')
  if (ruleset.duration !== 0 || ruleset.weightCutPercent !== 0 || nonzero(ruleset.approvalHook)) {
    issues.push('This project has scheduled or approval-controlled rules. Use the full Juicebox ruleset editor.')
  }

  const linkedPeers = peers.map(peer => {
    if (peer.remoteChainId > BigInt(Number.MAX_SAFE_INTEGER) || peer.remoteChainId <= 0n) throw new Error('Unsupported bridge chain ID.')
    const remoteChainId = Number(peer.remoteChainId)
    // Fail closed when the installed SDK cannot identify the peer deployment.
    v6Address('JBProjects', remoteChainId as JBChainId)
    return { chainId: remoteChainId, suckerAddress: remoteAddress(peer.remote), localSuckerAddress: peer.local }
  })
  const linkedChainIds = [...new Set([chainId, ...linkedPeers.map(peer => peer.chainId)])].sort((a, b) => a - b)
  let omnichainHooks: FundRulesetSnapshot['omnichainHooks']
  let supportedHook = !nonzero(metadata.dataHook) && !metadata.useDataHookForPay && !metadata.useDataHookForCashOut
  if (isAddressEqual(metadata.dataHook, omnichain)) {
    const [extraHook, tieredHook] = await Promise.all([
      client.readContract({ address: omnichain, abi: jbOmnichainDeployerAbi, functionName: 'extraDataHookOf', args: [projectId, BigInt(ruleset.id)], ...at }),
      client.readContract({ address: omnichain, abi: jbOmnichainDeployerAbi, functionName: 'tiered721HookOf', args: [projectId, BigInt(ruleset.id)], ...at }),
    ])
    let tiered721HasTiers = false
    if (nonzero(tieredHook[0])) {
      const [store, hookProjectId, scope, hookOwner] = await Promise.all([
        client.readContract({ address: tieredHook[0], abi: jb721TiersHookAbi, functionName: 'STORE', ...at }),
        client.readContract({ address: tieredHook[0], abi: jb721TiersHookAbi, functionName: 'projectId', ...at }),
        client.readContract({ address: tieredHook[0], abi: jb721TiersHookAbi, functionName: 'jbOwner', ...at }),
        client.readContract({ address: tieredHook[0], abi: jb721TiersHookAbi, functionName: 'owner', ...at }),
      ])
      if (!isAddressEqual(store, v6Address('JB721TiersHookStore', chain)) || hookProjectId !== projectId ||
        scope[1] !== projectId || !isAddressEqual(hookOwner, owner)) {
        throw new Error('The NFT hook is not scoped to this project and its current owner.')
      }
      const maxTierId = await client.readContract({ address: store, abi: jb721TiersHookStoreAbi, functionName: 'maxTierIdOf', args: [tieredHook[0]], ...at })
      tiered721HasTiers = maxTierId !== 0n
    }
    omnichainHooks = { ...extraHook, tiered721Hook: tieredHook[0], tiered721UseDataHookForCashOut: tieredHook[1], tiered721HasTiers }
    supportedHook = !nonzero(extraHook.dataHook) && !extraHook.useDataHookForPay && !extraHook.useDataHookForCashOut && !tieredHook[1] && !tiered721HasTiers
  }
  if (!supportedHook) issues.push('Custom payment or cash-out hooks need the full Juicebox ruleset editor.')

  const rawContexts = terminals.some(terminal => isAddressEqual(terminal, canonicalTerminal))
    ? await client.readContract({ address: canonicalTerminal, abi: jbMultiTerminalAbi, functionName: 'accountingContextsOf', args: [projectId], ...at })
    : []
  boundedCount(rawContexts.length, 32, 'Accounting token count')
  if (new Set(rawContexts.map(context => context.token.toLowerCase())).size !== rawContexts.length) throw new Error('The terminal returned duplicate accounting contexts.')
  const accountingContexts = await Promise.all(rawContexts.map(async context => {
    const [primaryTerminal, balance, surplus, payoutLimits, surplusAllowances] = await Promise.all([
      client.readContract({ address: directory, abi: jbDirectoryAbi, functionName: 'primaryTerminalOf', args: [projectId, context.token], ...at }),
      client.readContract({ address: terminalStore, abi: jbTerminalStoreAbi, functionName: 'balanceOf', args: [canonicalTerminal, projectId, context.token], ...at }),
      client.readContract({ address: canonicalTerminal, abi: jbMultiTerminalAbi, functionName: 'currentSurplusOf', args: [projectId, [context.token], BigInt(context.decimals), BigInt(context.currency)], ...at }),
      client.readContract({ address: accessLimits, abi: jbFundAccessLimitsAbi, functionName: 'payoutLimitsOf', args: [projectId, BigInt(ruleset.id), canonicalTerminal, context.token], ...at }),
      client.readContract({ address: accessLimits, abi: jbFundAccessLimitsAbi, functionName: 'surplusAllowancesOf', args: [projectId, BigInt(ruleset.id), canonicalTerminal, context.token], ...at }),
    ])
    boundedCount(payoutLimits.length, 32, 'Payout currency count')
    boundedCount(surplusAllowances.length, 32, 'Allowance currency count')
    const native = isAddressEqual(context.token, NATIVE_TOKEN)
    const usdc = USDC_ADDRESSES[chain] && isAddressEqual(context.token, USDC_ADDRESSES[chain])
    const symbol = native ? 'ETH' : usdc ? 'USDC' : await client.readContract({ address: context.token, abi: erc20Abi, functionName: 'symbol', ...at }).catch(() => 'Token')
    return { ...context, terminal: canonicalTerminal, primaryTerminal, isPrimary: isAddressEqual(primaryTerminal, canonicalTerminal), balance, surplus, symbol, payoutLimits, surplusAllowances }
  }))

  // With a vanilla core (or its verified empty omnichain wrapper), these are
  // all effective groups: reserved tokens and one payout group per accepted
  // token. Unknown custom hooks are excluded above because they may consume
  // additional groups. splitsOf also resolves ruleset-0 fallback recipients.
  let configuration: JBRulesetConfig | null = null
  if (supportedController && supportedTerminals && supportedHook && rawContexts.length > 0 && ruleset.id !== 0) {
    const groupIds = [...new Set([RESERVED_TOKEN_SPLIT_GROUP_ID, ...rawContexts.map(context => payoutSplitGroupId(context.token))])]
    const splitGroups = await Promise.all(groupIds.map(async groupId => {
      const groupSplits = await client.readContract({ address: splits, abi: jbSplitsAbi, functionName: 'splitsOf', args: [projectId, BigInt(ruleset.id), groupId], ...at })
      boundedCount(groupSplits.length, 64, 'Split recipient count')
      return { groupId, splits: groupSplits }
    }))
    configuration = {
      mustStartAtOrAfter: ruleset.start,
      duration: ruleset.duration,
      weight: ruleset.weight,
      weightCutPercent: ruleset.weightCutPercent,
      approvalHook: ruleset.approvalHook,
      metadata,
      splitGroups,
      fundAccessLimitGroups: accountingContexts
        .filter(context => context.payoutLimits.length > 0 || context.surplusAllowances.length > 0)
        .map(context => ({ terminal: context.terminal, token: context.token, payoutLimits: context.payoutLimits, surplusAllowances: context.surplusAllowances })),
    }
  }
  const tokenAddress = nonzero(token) ? token : null
  const [tokenSymbol, tokenDecimals, projectUri, creditBalance, erc20Balance, totalBalance] = await Promise.all([
    tokenAddress ? client.readContract({ address: tokenAddress, abi: erc20Abi, functionName: 'symbol', ...at }).catch(() => 'FUND') : 'FUND',
    tokenAddress ? client.readContract({ address: tokenAddress, abi: erc20Abi, functionName: 'decimals', ...at }) : 18,
    client.readContract({ address: canonicalController, abi: jbControllerAbi, functionName: 'uriOf', args: [projectId], ...at }).catch(() => ''),
    account ? client.readContract({ address: tokens, abi: jbTokensAbi, functionName: 'creditBalanceOf', args: [account, projectId], ...at }) : 0n,
    account && tokenAddress ? client.readContract({ address: tokenAddress, abi: erc20Abi, functionName: 'balanceOf', args: [account], ...at }) : 0n,
    account ? client.readContract({ address: tokens, abi: jbTokensAbi, functionName: 'totalBalanceOf', args: [account, projectId], ...at }) : 0n,
  ])
  if (creditBalance + erc20Balance !== totalBalance || totalSupply + pendingReservedTokens !== totalSupplyWithReservedTokens) {
    throw new Error('The RPC returned inconsistent project token accounting.')
  }
  const permissions = Object.fromEntries(await Promise.all(Object.entries(PERMISSIONS).map(async ([key, id]) => {
    const allowed = account && supportedController && knownOwnerWrapper
      ? isAddressEqual(account, owner) || await client.readContract({ address: permissionsAddress, abi: jbPermissionsAbi, functionName: 'hasPermission', args: [account, owner, projectId, BigInt(id), true, true], ...at })
      : false
    return [key, Boolean(allowed)]
  }))) as FundProjectPermissions
  const rulesetSnapshot: FundRulesetSnapshot = {
    chainId, projectId, blockNumber, controller, currentRulesetId: BigInt(ruleset.id),
    upcomingRulesetId: hasPendingRuleset ? BigInt(queued?.ruleset.id !== ruleset.id ? queued?.ruleset.id ?? upcoming?.ruleset.id ?? 0 : upcoming?.ruleset.id ?? 0) : 0n,
    accountingContexts: accountingContexts.map(({ terminal, token, currency, decimals }) => ({ terminal, token, currency, decimals })),
    configuration, linkedChainIds, ...(omnichainHooks ? { omnichainHooks } : {}),
  }
  // A reorg during the fan-out invalidates the snapshot instead of combining
  // calls from competing blocks with the same height.
  const finalBlock = await client.getBlock({ blockNumber })
  if (finalBlock.hash !== block.hash) throw new Error('The chain changed during the project read. Refresh and try again.')
  return {
    chainId: chain, projectId, blockNumber, blockHash: block.hash, blockTimestamp: block.timestamp,
    owner, operator: owner, account: account ?? null, controller, supportedController, knownOwnerWrapper,
    terminals, supportedTerminals, ruleset, metadata, upcoming, queued, hasPendingRuleset,
    projectUri, tokenAddress, tokenSymbol, tokenDecimals, totalSupply, totalCreditSupply,
    pendingReservedTokens, totalSupplyWithReservedTokens, creditBalance, erc20Balance, totalBalance,
    accountingContexts, permissions, linkedPeers, linkedChainIds,
    linkedProjects: [{ chainId, projectId }], rulesetSnapshot, issues,
  }
}

/** Conservative common guard; action-specific permissions and amounts still apply. */
export function assertFundStateForWrite(state: FundProjectState, account?: Address): void {
  if (!state.supportedController || !state.knownOwnerWrapper || !state.supportedTerminals) {
    throw new Error('This project configuration is not supported by FUND transactions.')
  }
  if (state.ruleset.id === 0) throw new Error('The first ruleset has not started.')
  if (account && (!state.account || !isAddressEqual(account, state.account))) throw new Error('Reconnect the wallet and refresh its project balances.')
}

/**
 * Resolve IDs from registered reciprocal sucker pairs, never URL parameters,
 * local draft data, or an assumption that project IDs match between chains.
 * Each chain has its own pinned block; an omnichain transaction must still
 * refresh all of these observations before it is signed.
 */
export async function readLinkedFundProjects(
  clientForChainId: (chainId: JBChainId) => PublicClient | Promise<PublicClient>,
  state: FundProjectState,
): Promise<FundProjectState[]> {
  const states = new Map<number, FundProjectState>([[state.chainId, state]])
  const expanded = new Set<number>()
  while (expanded.size < states.size) {
    const current = [...states.values()].find(candidate => !expanded.has(candidate.chainId))!
    expanded.add(current.chainId)
    for (const peer of current.linkedPeers) {
      const remoteClient = await clientForChainId(peer.chainId as JBChainId)
      if (await remoteClient.getChainId() !== peer.chainId) throw new Error('The remote FUND RPC returned a different chain.')
      let remoteState = states.get(peer.chainId)
      if (!remoteState) {
        const remoteBlock = await remoteClient.getBlock({ blockTag: 'latest' })
        if (remoteBlock.number === null) throw new Error('The remote chain did not return a mined block.')
        const remoteProjectId = await remoteClient.readContract({
          address: peer.suckerAddress, abi: jbSuckerV6ViewAbi, functionName: 'projectId', blockNumber: remoteBlock.number,
        })
        if (remoteProjectId <= 0n) throw new Error('The remote bridge has no project.')
        remoteState = await readFundProjectState(remoteClient, {
          chainId: peer.chainId, projectId: remoteProjectId, ...(state.account ? { account: state.account } : {}),
        })
        states.set(peer.chainId, remoteState)
        boundedCount(states.size, 8, 'Linked chain count')
      }
      const [remoteProjectId, remotePeer, remotePeerChainId] = await Promise.all([
        remoteClient.readContract({ address: peer.suckerAddress, abi: jbSuckerV6ViewAbi, functionName: 'projectId', blockNumber: remoteState.blockNumber }),
        remoteClient.readContract({ address: peer.suckerAddress, abi: jbSuckerV6ViewAbi, functionName: 'peer', blockNumber: remoteState.blockNumber }),
        remoteClient.readContract({ address: peer.suckerAddress, abi: jbSuckerV6ViewAbi, functionName: 'peerChainId', blockNumber: remoteState.blockNumber }),
      ])
      const reciprocal = remoteState.linkedPeers.some(candidate => candidate.chainId === current.chainId &&
        isAddressEqual(candidate.localSuckerAddress, peer.suckerAddress) &&
        isAddressEqual(candidate.suckerAddress, peer.localSuckerAddress))
      if (remoteProjectId !== remoteState.projectId || remotePeerChainId !== BigInt(current.chainId) ||
        !isAddressEqual(remoteAddress(remotePeer), peer.localSuckerAddress) || !reciprocal) {
        throw new Error('The linked project could not prove its reciprocal registered bridge. No project rules have been changed.')
      }
      const block = await remoteClient.getBlock({ blockNumber: remoteState.blockNumber })
      if (block.hash !== remoteState.blockHash) throw new Error('The remote chain changed during the project read.')
    }
  }
  const result = [...states.values()].sort((left, right) => left.chainId - right.chainId)
  const linkedProjects = result.map(project => ({ chainId: project.chainId, projectId: project.projectId }))
  // Preserve each state's own onchain membership. The operator builder rejects
  // inconsistent peer sets instead of silently broadening any project's scope.
  return result.map(project => ({ ...project, linkedProjects }))
}
