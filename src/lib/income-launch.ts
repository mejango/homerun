import { jbProjectsAbi, revDeployerAbi, MappableAsset, parseSuckerDeployerConfig, USDC_ADDRESSES, type JBChainId } from '@bananapus/nana-sdk-core'
import { v6Address } from '@bananapus/nana-sdk-core/v6'
import { encodeAbiParameters, getAddress, isAddress, isAddressEqual, keccak256, parseAbiParameters, zeroAddress, zeroHash, type Address, type Hex, type PublicClient } from 'viem'
import { type FundTransaction } from './fund-contracts'
import { readFundProjectState, type FundProjectState } from './fund-state'
import { readInitialIncomeAllocation } from './income-allocation-state'
import { getFundGlobalClaim, fundGlobalManifestHash, globalIncomeSnapshotParameters, parseFundGlobalManifest, verifyFundGlobalManifestHistory, type FundGlobalManifest, type GlobalIncomeAllocation } from './fund-global-manifest'
import { homerunIncomeDeployerAbi, incomeDistributorAbi, INCOME_QUARTER_SECONDS, INCOME_INITIAL_ISSUANCE, INCOME_CUT_PERCENT, registeredIncomeDeployer, registeredIncomeDistributor } from './income-contracts'
import { registeredStickyContract, stickyDeployerAbi } from './sticky-contracts'
import { readStickyProjectState, type StickyProjectState } from './sticky-state'

export function incomeLaunchBlockers(state: FundProjectState): string[] {
  const blockers: string[] = []
  if (!registeredIncomeDeployer(state.chainId)) blockers.push('The atomic INCOME launch contract has not been verified and registered on this network.')
  if (!registeredIncomeDistributor(state.chainId)) blockers.push('The FUND reward distributor has not been verified and registered on this network.')
  if (!registeredStickyContract(state.chainId, 'JBStickyDeployer')) blockers.push('The FUND Sticky contracts have not been verified and registered on this network.')
  return [...blockers, ...closedFundIncomeBlockers(state)]
}

/** Shared prerequisite for the initial allocation and its subsequent stock Sticky setup. */
export function closedFundIncomeBlockers(state: FundProjectState): string[] {
  const blockers: string[] = []
  if (!state.supportedController || !state.knownOwnerWrapper) blockers.push('This FUND uses an unsupported owner or controller.')
  if (!state.tokenAddress) blockers.push('Deploy the FUND ERC-20 before configuring ongoing holder rewards.')
  if (!state.metadata.pausePay || state.metadata.cashOutTaxRate !== 10_000 || state.metadata.allowOwnerMinting || state.pendingReservedTokens !== 0n) blockers.push('Finish the successful raise, including offchain contributions and the owner allocation, then close minting before launching INCOME.')
  const vanillaHook = isAddressEqual(state.metadata.dataHook, zeroAddress) && !state.metadata.useDataHookForPay && !state.metadata.useDataHookForCashOut
  const hooks = state.rulesetSnapshot?.omnichainHooks
  const canonicalOmnichainHook = isAddressEqual(state.metadata.dataHook, v6Address('JBOmnichainDeployer', state.chainId)) && hooks &&
    isAddressEqual(hooks.dataHook, zeroAddress) && !hooks.useDataHookForPay && !hooks.useDataHookForCashOut && !hooks.tiered721UseDataHookForCashOut && !hooks.tiered721HasTiers
  if ((!vanillaHook && !canonicalOmnichainHook) || state.hasPendingRuleset) blockers.push('The initial INCOME launcher requires a closed FUND with no custom hooks or pending rulesets.')
  return blockers
}

export async function readIncomeLaunchBinding(client: PublicClient, chainId: JBChainId, fundProjectId: bigint): Promise<bigint | null> {
  const deployer = registeredIncomeDeployer(chainId)
  if (!deployer) return null
  if (await client.getChainId() !== chainId) throw new Error('The RPC returned a different chain.')
  const block = await client.getBlock({ blockTag: 'latest' })
  if (block.number === null || !block.hash) throw new Error('A confirmed snapshot block is required.')
  await verifyIncomeLaunchWiring(client, chainId, block.number)
  const [id, vault] = await Promise.all([
    client.readContract({ address: deployer, abi: homerunIncomeDeployerAbi, functionName: 'incomeProjectIdOf', args: [fundProjectId], blockNumber: block.number }),
    client.readContract({ address: deployer, abi: homerunIncomeDeployerAbi, functionName: 'initialAllocationVaultOf', args: [fundProjectId], blockNumber: block.number }),
  ])
  if (id === (1n << 256n) - 1n) throw new Error('The INCOME launch is still in progress.')
  if ((id === 0n) !== isAddressEqual(vault, zeroAddress)) throw new Error('The INCOME allocation binding is incomplete.')
  const sameBlock = await client.getBlock({ blockNumber: block.number })
  if (sameBlock.hash !== block.hash) throw new Error('The chain reorganized during the INCOME read. Refresh and try again.')
  return id === 0n ? null : id
}

export async function verifyIncomeLaunchWiring(client: PublicClient, chainId: JBChainId, blockNumber: bigint) {
  const deployer = registeredIncomeDeployer(chainId)
  const distributor = registeredIncomeDistributor(chainId)
  const stickyDeployer = registeredStickyContract(chainId, 'JBStickyDeployer')
  if (!deployer || !distributor || !stickyDeployer) throw new Error('Verified INCOME launch, Sticky, and reward deployments are required.')
  const expected = {
    CONTROLLER: v6Address('JBController', chainId), DIRECTORY: v6Address('JBDirectory', chainId),
    PROJECTS: v6Address('JBProjects', chainId), TOKENS: v6Address('JBTokens', chainId),
    REV_DEPLOYER: v6Address('REVDeployer', chainId), REV_OWNER: v6Address('REVOwner', chainId),
    SUCKER_REGISTRY: v6Address('JBSuckerRegistry', chainId), TOKEN_DISTRIBUTOR: distributor, USDC: USDC_ADDRESSES[chainId],
    STICKY_DEPLOYER: stickyDeployer, OMNICHAIN_DEPLOYER: v6Address('JBOmnichainDeployer', chainId),
  } as const
  const [code, ...readings] = await Promise.all([
    client.getCode({ address: deployer, blockNumber }),
    ...Object.keys(expected).map(key => client.readContract({ address: deployer, abi: homerunIncomeDeployerAbi, functionName: key as keyof typeof expected, blockNumber })),
  ])
  if (!code || code === '0x') throw new Error('The registered INCOME launcher has no deployed code.')
  for (const [index, target] of Object.values(expected).entries()) if (!isAddressEqual(readings[index] as Address, target)) throw new Error('The INCOME launcher does not match its verified protocol deployment.')
  const [roundDuration, vestingRounds, claimDuration, revOwner, revLoans, startingTimestamp, observedBlock] = await Promise.all([
    client.readContract({ address: distributor, abi: incomeDistributorAbi, functionName: 'ROUND_DURATION', blockNumber }),
    client.readContract({ address: distributor, abi: incomeDistributorAbi, functionName: 'VESTING_ROUNDS', blockNumber }),
    client.readContract({ address: distributor, abi: incomeDistributorAbi, functionName: 'CLAIM_DURATION', blockNumber }),
    client.readContract({ address: distributor, abi: incomeDistributorAbi, functionName: 'REV_OWNER', blockNumber }),
    client.readContract({ address: distributor, abi: incomeDistributorAbi, functionName: 'REV_LOANS', blockNumber }),
    client.readContract({ address: distributor, abi: incomeDistributorAbi, functionName: 'STARTING_TIMESTAMP', blockNumber }),
    client.getBlock({ blockNumber }),
  ])
  if (roundDuration !== 604_800n || vestingRounds !== 4n || claimDuration !== 94_608_000) throw new Error('The reward distributor must use the reviewed stock Sticky policy: weekly rounds, four vesting rounds, and a three-year claim window.')
  if (!isAddressEqual(revOwner, zeroAddress) || !isAddressEqual(revLoans, zeroAddress) || startingTimestamp <= 0n || startingTimestamp > observedBlock.timestamp) throw new Error('New INCOME launches require the stock distributor with borrowing against uncollected rewards disabled and a valid starting timestamp.')
  return deployer
}

/** New launches require the separate incentive recipient selector; old bindings remain readable. */
export async function assertIncomeLaunchVersion(client: PublicClient, chainId: JBChainId, blockNumber: bigint): Promise<void> {
  const deployer = registeredIncomeDeployer(chainId)
  let version: bigint | undefined
  if (deployer) {
    try { version = await client.readContract({ address: deployer, abi: homerunIncomeDeployerAbi, functionName: 'LAUNCH_VERSION', blockNumber }) }
    catch { /* Legacy launchers do not expose a compatible version. */ }
  }
  if (version !== 2n) throw new Error(`Chain ${chainId}: A verified launcher supporting separate Owner and Operator wallets is required before launching INCOME.`)
}

export type InitialIncomeSnapshot = ReturnType<typeof globalIncomeSnapshotParameters>

export type PreparedIncomeLaunch = {
  request: FundTransaction
  fund: FundProjectState
  sticky: StickyProjectState
  manifest: FundGlobalManifest
  snapshot: InitialIncomeSnapshot
  localAllocation: GlobalIncomeAllocation
  manifestHash: Hex
  configurationSalt: Hex
  expectedConfigurationHash: Hex
  startsAtOrAfter: number
  creationFee: bigint
}

/** Exact Solidity commitment used by the helper, independent of local Sticky routing. */
export function incomeConfigurationSalt(snapshot: InitialIncomeSnapshot, launchSalt: Hex): Hex {
  const allocationHash = keccak256(encodeAbiParameters(parseAbiParameters('(uint32 chainId,uint256 fundProjectId,uint256 snapshotBlockNumber,bytes32 snapshotBlockHash,bytes32 merkleRoot,uint256 leafCount,uint104 incomeAmount)[]'), [snapshot.allocations]))
  return keccak256(encodeAbiParameters(parseAbiParameters('bytes32,bytes32,uint256,bytes32,bytes32'), [launchSalt, snapshot.sourceSetHash, snapshot.totalFundSupply, snapshot.manifestHash, allocationHash]))
}

/** REVDeployer._makeRulesetConfigurations: exact nested ABI encoding, including every global premint. */
export function incomeConfigurationHash(input: {
  name: string; configurationSalt: Hex; startsAtOrAfter: number; operatorBps: number; fundHolderBps: number;
  helper: Address; snapshot: InitialIncomeSnapshot;
}): Hex {
  let encoded = encodeAbiParameters(parseAbiParameters('uint32,bool,string,string,bytes32'), [2, false, input.name.trim(), 'INCOME', input.configurationSalt])
  for (const stage of [0, 1]) {
    encoded = encodeAbiParameters(parseAbiParameters('bytes,uint256,uint16,uint112,uint32,uint32,uint16,uint16'), [
      encoded, BigInt(input.startsAtOrAfter + stage * INCOME_QUARTER_SECONDS * 8), input.operatorBps + input.fundHolderBps,
      stage === 0 ? INCOME_INITIAL_ISSUANCE : 1n, stage === 0 ? INCOME_QUARTER_SECONDS : 0,
      stage === 0 ? INCOME_CUT_PERCENT : 0, 0, 4,
    ])
    if (stage === 0) for (const allocation of input.snapshot.allocations) if (allocation.incomeAmount !== 0n) {
      encoded = encodeAbiParameters(parseAbiParameters('bytes,uint32,address,uint104'), [encoded, allocation.chainId, input.helper, allocation.incomeAmount])
    }
  }
  return keccak256(encoded)
}

/**
 * Reproduces every finalized source chain, including pending bridge rights, before constructing a local launch.
 * Stock revnets deploy asynchronously. Each local allocation is fully minted before local activity; the canonical
 * bridge reports remote supply asynchronously. No global readiness oracle or temporary custom permission is added.
 */
export async function prepareIncomeLaunch(client: PublicClient, input: {
  chainId: JBChainId; fundProjectId: bigint; account: Address; operator?: Address; manifest: unknown; manifestUri: string;
  stickyProjectId: bigint; name: string; projectUri: string; salt: Hex; operatorBps: number; fundHolderBps: number;
  startsAtOrAfter: number; clients?: ReadonlyMap<number, PublicClient>;
}): Promise<PreparedIncomeLaunch> {
  const ipfsUri = /^ipfs:\/\/[^\s/?#]+(?:\/[^\s]*)?$/
  // Legacy frozen plans omitted a separate recipient and awarded incentives to each local owner.
  const operator = input.operator ?? input.account
  if (!isAddress(operator) || isAddressEqual(operator, zeroAddress)) throw new Error('A valid operator wallet is required for the token incentives.')
  if (!input.name.trim() || input.name.length > 160 || !ipfsUri.test(input.projectUri)) throw new Error('A project name and published INCOME metadata URI are required.')
  if (!ipfsUri.test(input.manifestUri)) throw new Error('Publish the complete snapshot manifest to IPFS before preparing INCOME.')
  if (!/^0x[\da-fA-F]{64}$/.test(input.salt) || input.salt === zeroHash) throw new Error('A nonzero deployment salt is required.')
  if (typeof input.stickyProjectId !== 'bigint' || input.stickyProjectId <= 0n || input.stickyProjectId >= 1n << 256n) throw new Error('A verified FUND Sticky project is required.')
  if (![input.operatorBps, input.fundHolderBps].every(value => Number.isInteger(value) && value >= 0) || input.fundHolderBps === 0 || input.operatorBps + input.fundHolderBps > 10_000) throw new Error('INCOME allocation must include FUND holders and total no more than 100%.')
  if (!Number.isSafeInteger(input.startsAtOrAfter) || input.startsAtOrAfter <= 0 || input.startsAtOrAfter + INCOME_QUARTER_SECONDS * 8 >= 2 ** 48) throw new Error('Use the same reviewed absolute INCOME start time on every chain.')
  const parsed = parseFundGlobalManifest(input.manifest)
  const deployer = registeredIncomeDeployer(input.chainId)
  const localAllocation = parsed.allocations.find(entry => entry.chainId === input.chainId && BigInt(entry.fundProjectId) === input.fundProjectId)
  if (!deployer || !localAllocation || !isAddressEqual(parsed.helper, deployer) || parsed.launchSalt.toLowerCase() !== input.salt.toLowerCase()) throw new Error('The snapshot belongs to a different FUND, chain, launcher, or launch salt.')
  const clients = new Map(input.clients ?? [[input.chainId, client]])
  // The selected chain always uses the explicit connected read client, never an accidental stale map entry.
  clients.set(input.chainId, client)
  for (const allocation of parsed.allocations) {
    const source = clients.get(allocation.chainId)
    const registered = registeredIncomeDeployer(allocation.chainId)
    if (!source) throw new Error(`A verified RPC client is required for source chain ${allocation.chainId}.`)
    if (!registered || !isAddressEqual(registered, deployer)) throw new Error('Every claim chain must register the same deterministic INCOME helper address.')
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
    const [protocolHash, existing, existingVault, block, acceptedUsdc] = await Promise.all([
      source.readContract({ address: deployer, abi: homerunIncomeDeployerAbi, functionName: 'PROTOCOL_CONFIG_HASH', ...at }),
      source.readContract({ address: deployer, abi: homerunIncomeDeployerAbi, functionName: 'incomeProjectIdOf', args: [BigInt(allocation.fundProjectId)], ...at }),
      source.readContract({ address: deployer, abi: homerunIncomeDeployerAbi, functionName: 'initialAllocationVaultOf', args: [BigInt(allocation.fundProjectId)], ...at }),
      source.getBlock(at),
      Promise.all(manifest.allocations.map(entry => source.readContract({ address: deployer, abi: homerunIncomeDeployerAbi, functionName: 'usdcOf', args: [entry.chainId], ...at }))),
    ])
    if (protocolHash === zeroHash || acceptedUsdc.some((actual, i) => !isAddressEqual(actual, USDC_ADDRESSES[manifest.allocations[i].chainId]))) throw new Error('The helper does not support the complete reviewed chain and USDC deployment profile.')
    if ((existing === 0n) !== isAddressEqual(existingVault, zeroAddress) || existing === (1n << 256n) - 1n) throw new Error('An INCOME launch has an incomplete or pending onchain binding.')
    if (BigInt(input.startsAtOrAfter) > block.timestamp) throw new Error('The shared INCOME stage must have started before its initial allocation can be minted atomically.')
    if (allocation.chainId === input.chainId && existing !== 0n) throw new Error('This FUND already has an INCOME launch recorded by the verified launcher.')
    // A completed peer may already be distributing asset-sale proceeds or burning FUND. Its frozen
    // initial rights remain authoritative; only projects still awaiting launch must remain closed raises.
    if (existing === 0n) {
      await assertIncomeLaunchVersion(source, allocation.chainId, fund.blockNumber)
      const blockers = incomeLaunchBlockers(fund)
      if (blockers.length) throw new Error(`Chain ${allocation.chainId}: ${blockers.join(' ')}`)
    }
    if (allocation.chainId !== input.chainId && existing !== 0n) {
      const initialAllocation = await readInitialIncomeAllocation(source, { chainId: allocation.chainId, incomeProjectId: existing, fundProjectId: BigInt(allocation.fundProjectId) })
      if (!initialAllocation || initialAllocation.blockNumber < fund.blockNumber || !isAddressEqual(initialAllocation.vault, existingVault) || initialAllocation.manifestUri !== input.manifestUri) throw new Error('An existing linked INCOME has no verified initial vault for the original published manifest.')
      getFundGlobalClaim(manifest, initialAllocation, zeroAddress)
      const actualConfigurationHash = await source.readContract({ address: v6Address('REVDeployer', allocation.chainId), abi: revDeployerAbi, functionName: 'hashedEncodedConfigurationOf', args: [existing], ...at })
      if (actualConfigurationHash !== expectedConfigurationHash) throw new Error('An existing linked INCOME uses a different start time, name, economics, or global allocation. Restore its original launch plan.')
      // Stock identity deliberately excludes splits: each chain's Owner may update any recipient or split
      // percentage after launch. Those changes do not alter the frozen initial plan for unlaunched chains.
    }
    return { allocation, source, fund, protocolHash }
  }))
  if (observations.some(entry => entry.protocolHash !== observations[0].protocolHash)) throw new Error('The helpers were deployed with different cross-chain protocol profiles.')
  const fund = observations.find(entry => entry.allocation.chainId === input.chainId)!.fund
  if (!isAddressEqual(fund.owner, input.account)) throw new Error('The FUND owner must launch INCOME.')
  const sticky = await readStickyProjectState(client, { chainId: input.chainId, fundProjectId: input.fundProjectId, stickyProjectId: input.stickyProjectId, account: input.account })
  const stickyDeployer = registeredStickyContract(input.chainId, 'JBStickyDeployer')!
  const sourceBlockNumber = BigInt(localAllocation.snapshotBlockNumber)
  const historicalStickyCode = await client.getCode({ address: stickyDeployer, blockNumber: sourceBlockNumber })
  const [preSnapshotStakeToken, creationFee, actualConfigurationSalt] = await Promise.all([
    historicalStickyCode && historicalStickyCode !== '0x' ? client.readContract({ address: stickyDeployer, abi: stickyDeployerAbi, functionName: 'stakedTokenOf', args: [input.stickyProjectId], blockNumber: sourceBlockNumber }) : Promise.resolve(zeroAddress),
    client.readContract({ address: v6Address('JBProjects', input.chainId), abi: jbProjectsAbi, functionName: 'creationFee', blockNumber: fund.blockNumber }),
    client.readContract({ address: deployer, abi: homerunIncomeDeployerAbi, functionName: 'configurationSaltFor', args: [snapshot, input.salt], blockNumber: fund.blockNumber }),
  ])
  if (!isAddressEqual(preSnapshotStakeToken, zeroAddress)) throw new Error('Take the initial ownership snapshot before creating the managed Sticky project. Existing custody requires a separately verified beneficial-owner allocation.')
  if (actualConfigurationSalt !== configurationSalt) throw new Error('The helper uses a different global allocation commitment.')
  const suckerConfiguration = parseSuckerDeployerConfig(input.chainId, manifest.allocations.map(entry => entry.chainId), [MappableAsset.USDC], { version: 6, bridge: 'ccip', salt: input.salt })
  await Promise.all(observations.map(async ({ source, fund: observedFund, allocation }) => {
    const [sameBlock, sameSnapshot] = await Promise.all([source.getBlock({ blockNumber: observedFund.blockNumber }), source.getBlock({ blockNumber: BigInt(allocation.snapshotBlockNumber) })])
    if (sameBlock.hash !== observedFund.blockHash || sameSnapshot.hash !== allocation.snapshotBlockHash) throw new Error('A source chain reorganized during launch preparation. Refresh and try again.')
  }))
  return {
    fund, sticky, manifest, snapshot, localAllocation, manifestHash, configurationSalt, expectedConfigurationHash, startsAtOrAfter: input.startsAtOrAfter, creationFee,
    request: {
      chainId: input.chainId, address: deployer, abi: homerunIncomeDeployerAbi, functionName: 'deployIncome',
      args: [input.fundProjectId, snapshot, { name: input.name.trim(), ticker: 'INCOME', uri: input.projectUri, salt: input.salt }, input.operatorBps, input.fundHolderBps, input.stickyProjectId, input.startsAtOrAfter, suckerConfiguration, getAddress(operator)], value: creationFee,
    },
  }
}
