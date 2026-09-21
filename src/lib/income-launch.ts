import { jbProjectsAbi, revDeployerAbi, MappableAsset, parseSuckerDeployerConfig, USDC_ADDRESSES, type JBChainId } from '@bananapus/nana-sdk-core'
import { v6Address } from '@bananapus/nana-sdk-core/v6'
import { encodeAbiParameters, isAddressEqual, keccak256, parseAbiParameters, zeroAddress, zeroHash, type Address, type Hex, type PublicClient } from 'viem'
import { type FundTransaction } from './fund-contracts'
import { readFundProjectState, type FundProjectState } from './fund-state'
import { assertInitialIncomeAllocation, readInitialIncomeAllocation } from './income-initial-allocation'
import { fundGlobalManifestHash, globalIncomeSnapshotParameters, parseFundGlobalManifest, verifyFundGlobalManifestHistory, type FundGlobalManifest, type GlobalIncomeAllocation } from './fund-global-manifest'
import { homerunDeployerAbi, INCOME_QUARTER_SECONDS, INCOME_INITIAL_ISSUANCE, INCOME_CUT_PERCENT, INCOME_CASH_OUT_TAX_RATE, registeredAllowlistHook, registeredHomerunDeployer } from './income-contracts'
import { isVerifiedProject721Hook } from './fund-hooks'

export function incomeLaunchBlockers(state: FundProjectState): string[] {
  const blockers: string[] = []
  if (!registeredHomerunDeployer(state.chainId)) blockers.push('The Homerun deployer has not been verified and registered on this network.')
  return [...blockers, ...closedFundIncomeBlockers(state)]
}

/** Shared prerequisite for the initial allocation. */
export function closedFundIncomeBlockers(state: FundProjectState): string[] {
  const blockers: string[] = []
  if (!state.supportedController || !state.knownOwnerWrapper) blockers.push('This FUND uses an unsupported owner or controller.')
  if (!state.tokenAddress) blockers.push('This FUND has no ERC-20; it was not launched by the Homerun deployer.')
  if (!state.metadata.pausePay || state.metadata.cashOutTaxRate !== 10_000 || state.metadata.allowOwnerMinting || state.pendingReservedTokens !== 0n) blockers.push('Finish the successful raise, including offchain contributions and the owner allocation, then close minting before launching INCOME.')
  const vanillaHook = isAddressEqual(state.metadata.dataHook, zeroAddress) && !state.metadata.useDataHookForPay && !state.metadata.useDataHookForCashOut
  const hooks = state.rulesetSnapshot?.omnichainHooks
  const stockShop = state.rulesetSnapshot?.stock721Hook
  const canonicalDirectHook = !state.metadata.useDataHookForCashOut && isVerifiedProject721Hook(stockShop, state.metadata.dataHook)
  const allowlistHook = registeredAllowlistHook(state.chainId)
  const allowlistExtra = !!hooks && !!allowlistHook && isAddressEqual(hooks.dataHook, allowlistHook) && hooks.useDataHookForPay
  const canonicalOmnichainHook = isAddressEqual(state.metadata.dataHook, v6Address('JBOmnichainDeployer', state.chainId)) && hooks &&
    (allowlistExtra || isAddressEqual(hooks.dataHook, zeroAddress) && !hooks.useDataHookForPay) && !hooks.useDataHookForCashOut && !hooks.tiered721UseDataHookForCashOut &&
    (isAddressEqual(hooks.tiered721Hook, zeroAddress) || isVerifiedProject721Hook(stockShop, hooks.tiered721Hook))
  if ((!vanillaHook && !canonicalDirectHook && !canonicalOmnichainHook) || state.hasPendingRuleset) blockers.push('The initial INCOME launcher requires a closed FUND with no custom hooks or pending rulesets.')
  return blockers
}

export async function readIncomeLaunchBinding(client: PublicClient, chainId: JBChainId, fundProjectId: bigint): Promise<bigint | null> {
  const deployer = registeredHomerunDeployer(chainId)
  if (!deployer) return null
  if (await client.getChainId() !== chainId) throw new Error('The RPC returned a different chain.')
  const block = await client.getBlock({ blockTag: 'latest' })
  if (block.number === null || !block.hash) throw new Error('A confirmed snapshot block is required.')
  await verifyIncomeLaunchWiring(client, chainId, block.number)
  const id = await client.readContract({ address: deployer, abi: homerunDeployerAbi, functionName: 'incomeProjectIdOf', args: [fundProjectId], blockNumber: block.number })
  const sameBlock = await client.getBlock({ blockNumber: block.number })
  if (sameBlock.hash !== block.hash) throw new Error('The chain reorganized during the INCOME read. Refresh and try again.')
  return id === 0n ? null : id
}

export async function verifyIncomeLaunchWiring(client: PublicClient, chainId: JBChainId, blockNumber: bigint) {
  const deployer = registeredHomerunDeployer(chainId), allowlistHook = registeredAllowlistHook(chainId)
  if (!deployer || !allowlistHook) throw new Error('Verified Homerun deployer and allowlist hook registrations are required.')
  const expected = {
    CONTROLLER: v6Address('JBController', chainId), PROJECTS: v6Address('JBProjects', chainId),
    TOKENS: v6Address('JBTokens', chainId), REV_DEPLOYER: v6Address('REVDeployer', chainId),
    REV_OWNER: v6Address('REVOwner', chainId), USDC: USDC_ADDRESSES[chainId],
    OMNICHAIN_DEPLOYER: v6Address('JBOmnichainDeployer', chainId), TERMINAL: v6Address('JBMultiTerminal', chainId),
    ROUTER_TERMINAL_REGISTRY: v6Address('JBRouterTerminalRegistry', chainId), ALLOWLIST_HOOK: allowlistHook,
  } as const
  const [code, ...readings] = await Promise.all([
    client.getCode({ address: deployer, blockNumber }),
    ...Object.keys(expected).map(key => client.readContract({ address: deployer, abi: homerunDeployerAbi, functionName: key as keyof typeof expected, blockNumber })),
  ])
  if (!code || code === '0x') throw new Error('The registered Homerun deployer has no deployed code.')
  for (const [index, target] of Object.values(expected).entries()) if (!isAddressEqual(readings[index] as Address, target)) throw new Error('The Homerun deployer does not match its verified protocol deployment.')
  return deployer
}

export type InitialIncomeSnapshot = ReturnType<typeof globalIncomeSnapshotParameters>

export type PreparedIncomeLaunch = {
  request: FundTransaction
  fund: FundProjectState
  manifest: FundGlobalManifest
  snapshot: InitialIncomeSnapshot
  localAllocation: GlobalIncomeAllocation
  manifestHash: Hex
  configurationSalt: Hex
  expectedConfigurationHash: Hex
  startsAtOrAfter: number
  creationFee: bigint
}

/** Exact Solidity commitment used by the helper. */
export function incomeConfigurationSalt(snapshot: InitialIncomeSnapshot, launchSalt: Hex): Hex {
  const allocationHash = keccak256(encodeAbiParameters(parseAbiParameters('(uint32 chainId,uint256 fundProjectId,uint256 snapshotBlockNumber,bytes32 snapshotBlockHash,uint104 incomeAmount)[]'), [snapshot.allocations]))
  return keccak256(encodeAbiParameters(parseAbiParameters('bytes32,bytes32,uint256,bytes32,bytes32'), [launchSalt, snapshot.sourceSetHash, snapshot.totalFundSupply, snapshot.manifestHash, allocationHash]))
}

/** REVDeployer._makeRulesetConfigurations: exact nested ABI encoding of the single stage, including every chain's auto-issuance to the helper. */
export function incomeConfigurationHash(input: {
  name: string; ticker: string; configurationSalt: Hex; startsAtOrAfter: number; reservedBps: number;
  helper: Address; snapshot: InitialIncomeSnapshot;
}): Hex {
  let encoded = encodeAbiParameters(parseAbiParameters('uint32,bool,string,string,bytes32'), [2, false, input.name.trim(), input.ticker.trim(), input.configurationSalt])
  encoded = encodeAbiParameters(parseAbiParameters('bytes,uint256,uint16,uint112,uint32,uint32,uint16,uint16'), [
    encoded, BigInt(input.startsAtOrAfter), input.reservedBps, INCOME_INITIAL_ISSUANCE, INCOME_QUARTER_SECONDS, INCOME_CUT_PERCENT, INCOME_CASH_OUT_TAX_RATE, 4,
  ])
  for (const allocation of input.snapshot.allocations) if (allocation.incomeAmount !== 0n) {
    encoded = encodeAbiParameters(parseAbiParameters('bytes,uint32,address,uint104'), [encoded, allocation.chainId, input.helper, allocation.incomeAmount])
  }
  return keccak256(encoded)
}

/**
 * Reproduces every finalized source chain, including pending bridge rights, before constructing a local launch.
 * Stock revnets deploy asynchronously. Each chain records its allocation as an auto-issuance to the helper, paid to the FUND owner on mint; the
 * canonical bridge reports remote supply asynchronously. No global readiness oracle or temporary custom permission is added.
 */
/** How far ahead of the chain clock a new INCOME draft starts its shared stage. */
export const INCOME_START_LEAD_SECONDS = 10 * 60

export async function prepareIncomeLaunch(client: PublicClient, input: {
  chainId: JBChainId; fundProjectId: bigint; account: Address; manifest: unknown; manifestUri: string;
  name: string; ticker: string; projectUri: string; salt: Hex; reservedBps: number;
  startsAtOrAfter: number; clients?: ReadonlyMap<number, PublicClient>;
}): Promise<PreparedIncomeLaunch> {
  const ipfsUri = /^ipfs:\/\/[^\s/?#]+(?:\/[^\s]*)?$/
  if (!input.name.trim() || input.name.length > 160 || !input.ticker.trim() || input.ticker.length > 32 || !ipfsUri.test(input.projectUri)) throw new Error('A project name, ticker and published INCOME metadata URI are required.')
  if (!ipfsUri.test(input.manifestUri)) throw new Error('Publish the complete snapshot manifest to IPFS before preparing INCOME.')
  if (!/^0x[\da-fA-F]{64}$/.test(input.salt) || input.salt === zeroHash) throw new Error('A nonzero deployment salt is required.')
  if (!Number.isInteger(input.reservedBps) || input.reservedBps < 0 || input.reservedBps > 10_000) throw new Error('Reserve between 0% and 100% of new INCOME.')
  if (!Number.isSafeInteger(input.startsAtOrAfter) || input.startsAtOrAfter <= 0 || input.startsAtOrAfter >= 2 ** 48) throw new Error('Use the same reviewed absolute INCOME start time on every chain.')
  const parsed = parseFundGlobalManifest(input.manifest)
  const deployer = registeredHomerunDeployer(input.chainId)
  const localAllocation = parsed.allocations.find(entry => entry.chainId === input.chainId && BigInt(entry.fundProjectId) === input.fundProjectId)
  if (!deployer || !localAllocation || !isAddressEqual(parsed.helper, deployer) || parsed.launchSalt.toLowerCase() !== input.salt.toLowerCase()) throw new Error('The snapshot belongs to a different FUND, chain, launcher, or launch salt.')
  const clients = new Map(input.clients ?? [[input.chainId, client]])
  // The selected chain always uses the explicit connected read client, never an accidental stale map entry.
  clients.set(input.chainId, client)
  for (const allocation of parsed.allocations) {
    const source = clients.get(allocation.chainId)
    const registered = registeredHomerunDeployer(allocation.chainId)
    if (!source) throw new Error(`A verified RPC client is required for source chain ${allocation.chainId}.`)
    if (!registered || !isAddressEqual(registered, deployer)) throw new Error('Every snapshot chain must register the same deterministic INCOME helper address.')
    if (await source.getChainId() !== allocation.chainId) throw new Error('A source RPC returned a different chain.')
    const finalized = await source.getBlock({ blockTag: 'finalized' })
    if (finalized.number === null || !finalized.hash || BigInt(allocation.snapshotBlockNumber) > finalized.number) throw new Error('Every ownership snapshot must be finalized before launch.')
  }
  const manifest = await verifyFundGlobalManifestHistory(clients, parsed)
  const snapshot = globalIncomeSnapshotParameters(manifest, input.manifestUri)
  const manifestHash = fundGlobalManifestHash(manifest)
  const configurationSalt = incomeConfigurationSalt(snapshot, input.salt)
  const expectedConfigurationHash = incomeConfigurationHash({ ...input, configurationSalt, helper: deployer, snapshot })
  const observations = await Promise.all(manifest.allocations.map(async allocation => {
    const source = clients.get(allocation.chainId)!
    const fund = await readFundProjectState(source, { chainId: allocation.chainId, projectId: BigInt(allocation.fundProjectId), account: allocation.chainId === input.chainId ? input.account : undefined })
    if (fund.chainId !== allocation.chainId || fund.projectId !== BigInt(allocation.fundProjectId) || !fund.supportedController || !fund.knownOwnerWrapper || !fund.tokenAddress) throw new Error(`Chain ${allocation.chainId}: The FUND no longer has its supported project, controller, owner, or token identity.`)
    if (BigInt(allocation.snapshotBlockNumber) >= fund.blockNumber) throw new Error('The ownership snapshot must precede the current confirmed block.')
    await verifyIncomeLaunchWiring(source, allocation.chainId, fund.blockNumber)
    const at = { blockNumber: fund.blockNumber }
    const [existing, acceptedUsdc] = await Promise.all([
      source.readContract({ address: deployer, abi: homerunDeployerAbi, functionName: 'incomeProjectIdOf', args: [BigInt(allocation.fundProjectId)], ...at }),
      Promise.all(manifest.allocations.map(entry => source.readContract({ address: deployer, abi: homerunDeployerAbi, functionName: 'usdcOf', args: [entry.chainId], ...at }))),
    ])
    if (acceptedUsdc.some((actual, i) => !isAddressEqual(actual, USDC_ADDRESSES[manifest.allocations[i].chainId]))) throw new Error('The helper does not support the complete reviewed chain and USDC deployment profile.')
    if (allocation.chainId === input.chainId && existing !== 0n) throw new Error('This FUND already has an INCOME launch recorded by the verified launcher.')
    // A completed peer may already be distributing asset-sale proceeds or burning FUND. Its frozen
    // initial rights remain authoritative; only projects still awaiting launch must remain closed raises.
    if (existing === 0n) {
      const blockers = incomeLaunchBlockers(fund)
      if (blockers.length) throw new Error(`Chain ${allocation.chainId}: ${blockers.join(' ')}`)
    }
    if (allocation.chainId !== input.chainId && existing !== 0n) {
      // The ruleset hash commits the manifest and every chain's allocation to the helper; the auto-issuance read shows
      // whether this peer's share is still pending in full or already minted.
      const [initialAllocation, actualConfigurationHash] = await Promise.all([
        readInitialIncomeAllocation(source, { chainId: allocation.chainId, incomeProjectId: existing, fundProjectId: BigInt(allocation.fundProjectId), blockNumber: fund.blockNumber }),
        source.readContract({ address: v6Address('REVDeployer', allocation.chainId), abi: revDeployerAbi, functionName: 'hashedEncodedConfigurationOf', args: [existing], ...at }),
      ])
      if (actualConfigurationHash !== expectedConfigurationHash) throw new Error('An existing linked INCOME uses a different start time, name, economics, or global allocation. Restore its original launch plan.')
      assertInitialIncomeAllocation(initialAllocation, BigInt(allocation.incomeAmount))
      // Stock identity deliberately excludes splits: each chain's Owner may update any recipient or split
      // percentage after launch. Those changes do not alter the frozen initial plan for unlaunched chains.
    }
    return { allocation, source, fund }
  }))
  const fund = observations.find(entry => entry.allocation.chainId === input.chainId)!.fund
  if (!isAddressEqual(fund.owner, input.account)) throw new Error('The FUND owner must launch INCOME.')
  const [creationFee, actualConfigurationSalt] = await Promise.all([
    client.readContract({ address: v6Address('JBProjects', input.chainId), abi: jbProjectsAbi, functionName: 'creationFee', blockNumber: fund.blockNumber }),
    client.readContract({ address: deployer, abi: homerunDeployerAbi, functionName: 'configurationSaltFor', args: [snapshot, input.salt], blockNumber: fund.blockNumber }),
  ])
  if (actualConfigurationSalt !== configurationSalt) throw new Error('The helper uses a different global allocation commitment.')
  const suckerConfiguration = parseSuckerDeployerConfig(input.chainId, manifest.allocations.map(entry => entry.chainId), [MappableAsset.USDC], { version: 6, bridge: 'ccip', salt: input.salt })
  await Promise.all(observations.map(async ({ source, fund: observedFund, allocation }) => {
    const [sameBlock, sameSnapshot] = await Promise.all([source.getBlock({ blockNumber: observedFund.blockNumber }), source.getBlock({ blockNumber: BigInt(allocation.snapshotBlockNumber) })])
    if (sameBlock.hash !== observedFund.blockHash || sameSnapshot.hash !== allocation.snapshotBlockHash) throw new Error('A source chain reorganized during launch preparation. Refresh and try again.')
  }))
  return {
    fund, manifest, snapshot, localAllocation, manifestHash, configurationSalt, expectedConfigurationHash, startsAtOrAfter: input.startsAtOrAfter, creationFee,
    request: {
      chainId: input.chainId, address: deployer, abi: homerunDeployerAbi, functionName: 'deployIncome',
      args: [input.fundProjectId, snapshot, { name: input.name.trim(), ticker: input.ticker.trim(), uri: input.projectUri, salt: input.salt }, input.reservedBps, input.startsAtOrAfter, suckerConfiguration], value: creationFee,
    },
  }
}
