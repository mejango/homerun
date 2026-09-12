import { MappableAsset, parseSuckerDeployerConfig, type JBChainId } from '@bananapus/nana-sdk-core'
import { toHex, type Address, type Hex } from 'viem'
import { buildFundGlobalManifest, fundGlobalManifestHash, globalIncomeSnapshotParameters, type FundGlobalManifest } from '../../src/lib/fund-global-manifest'
import type { FundGlobalSnapshot } from '../../src/lib/fund-global-snapshot'
import type { FundProjectState } from '../../src/lib/fund-state'
import { homerunIncomeDeployerAbi } from '../../src/lib/income-contracts'
import type { IncomeGlobalLaunchDraft } from '../../src/lib/income-global-launch-draft'
import type { PreparedIncomeLaunch, prepareIncomeLaunch } from '../../src/lib/income-launch'

export const OWNER = '0x1111111111111111111111111111111111111111' as Address
export const HELPER = '0x2222222222222222222222222222222222222222' as Address
export const TOKEN = '0x3333333333333333333333333333333333333333' as Address
export const VAULT = '0x4444444444444444444444444444444444444444' as Address
export const BLOCK_HASH = toHex(987n, { size: 32 }), TX_HASH = toHex(988n, { size: 32 }), SALT = toHex(989n, { size: 32 })
export const CHAIN_IDS = [1, 10, 8453, 42161] as const
export const FUND_IDS = [5n, 6n, 7n, 8n]
export function globalSnapshot(): FundGlobalSnapshot {
  const balances = [25n, 25n, 50n, 0n]
  const graph = { cuts: CHAIN_IDS.map((chainId, index) => ({ chainId, blockNumber: BigInt(80 + index), blockHash: BLOCK_HASH, blockTimestamp: 900n })), projects: CHAIN_IDS.map((chainId, index) => ({ chainId, projectId: FUND_IDS[index], owner: OWNER, controller: HELPER, historicalSuckers: [] as Address[] })), lanes: [] }
  const projects = graph.projects.map((project, index) => ({ ...project, ...graph.cuts[index], creationBlockNumber: 1n, creationTransactionHash: TX_HASH, tokenAddress: TOKEN, totalFundSupply: balances[index], totalCreditSupply: balances[index], totalErc20Supply: 0n, holders: balances[index] ? [{ holder: OWNER, balance: balances[index], creditBalance: balances[index], erc20Balance: 0n }] : [], evidence: { projects: HELPER, tokens: TOKEN, controller: HELPER, suckerRegistry: HELPER, eventCounts: { Mint: balances[index] ? 1 : 0 }, candidateCount: balances[index] ? 1 : 0, bridgePolicy: 'historical-graph-required' as const } }))
  const entitlements = graph.projects.flatMap((project, index) => balances[index] ? [{ claimChainId: project.chainId, beneficiary: OWNER, liveFundBalance: balances[index], pendingFundBalance: 0n, fundBalance: balances[index], sources: [{ kind: 'live-balance' as const, chainId: project.chainId, projectId: project.projectId, amount: balances[index] }] }] : [])
  return { kind: 'homerun-global-fund-entitlements', version: 1, root: { chainId: 8453, projectId: 7n }, claimPolicy: 'live-chain-and-pending-bridge-destination', historyAttestation: 'complete-canonical-rpc-log-history-required', graph, projects, bridges: [], entitlements, totals: { liveFundSupply: 100n, pendingFundSupply: 0n, globalFundSupply: 100n } }
}
export function globalManifest() { return buildFundGlobalManifest(globalSnapshot(), { helper: HELPER, launchSalt: SALT }) }
export function globalDraft(manifest = globalManifest()): IncomeGlobalLaunchDraft { return { version: 1, root: { chainId: 8453, projectId: '7' }, helper: HELPER, manifestUri: 'ipfs://global-snapshot', manifestHash: fundGlobalManifestHash(manifest), sourceSetHash: manifest.sourceSetHash, launchSalt: manifest.launchSalt, name: 'Homerun INCOME', metadataUri: 'ipfs://global-metadata', startsAtOrAfter: 1000, operatorBps: 7000, fundHolderBps: 1000, chains: manifest.allocations.map(local => ({ chainId: local.chainId, fundProjectId: local.fundProjectId, initialIncomeAmount: local.incomeAmount })) } }
export function fundState(chainId: number): FundProjectState { const index = CHAIN_IDS.indexOf(chainId as typeof CHAIN_IDS[number]); return { chainId, projectId: FUND_IDS[index], blockNumber: 200n, blockHash: BLOCK_HASH, blockTimestamp: 1200n, owner: OWNER, account: OWNER, tokenAddress: TOKEN, tokenDecimals: 18, totalSupply: index === 3 ? 0n : 50n, supportedController: true, supportedTerminals: true, knownOwnerWrapper: true, linkedChainIds: [...CHAIN_IDS], linkedPeers: [], pendingReservedTokens: 0n, metadata: { pausePay: true, cashOutTaxRate: 10000, allowOwnerMinting: false, dataHook: '0x0000000000000000000000000000000000000000', useDataHookForPay: false, useDataHookForCashOut: false } } as unknown as FundProjectState }
export function launchInput(draft = globalDraft(), chainId: JBChainId = 8453, manifest = globalManifest()): Parameters<typeof prepareIncomeLaunch>[1] { const local = draft.chains.find(entry => entry.chainId === chainId)!; return { chainId, fundProjectId: BigInt(local.fundProjectId), account: OWNER, operator: draft.operator, manifest, manifestUri: draft.manifestUri, stickyProjectId: BigInt(local.stickyProjectId ?? '90'), name: draft.name, projectUri: draft.metadataUri, salt: draft.launchSalt, operatorBps: draft.operatorBps, fundHolderBps: draft.fundHolderBps, startsAtOrAfter: draft.startsAtOrAfter } }
export function launchPlan(input: Parameters<typeof prepareIncomeLaunch>[1]): PreparedIncomeLaunch {
  const manifest = input.manifest as FundGlobalManifest, snapshot = globalIncomeSnapshotParameters(manifest, input.manifestUri), localAllocation = manifest.allocations.find(entry => entry.chainId === input.chainId)!
  return { fund: fundState(input.chainId), sticky: {} as never, manifest, snapshot, localAllocation, manifestHash: fundGlobalManifestHash(manifest), creationFee: 1n, startsAtOrAfter: input.startsAtOrAfter, configurationSalt: SALT, expectedConfigurationHash: SALT,
    request: { chainId: input.chainId, address: HELPER, abi: homerunIncomeDeployerAbi, functionName: 'deployIncome', args: [input.fundProjectId, snapshot, { name: input.name, ticker: 'INCOME', uri: input.projectUri, salt: input.salt }, input.operatorBps, input.fundHolderBps, input.stickyProjectId, input.startsAtOrAfter, parseSuckerDeployerConfig(input.chainId, manifest.allocations.map(local => local.chainId), [MappableAsset.USDC], { version: 6, bridge: 'ccip', salt: input.salt }), input.operator ?? input.account], value: 1n } }
}
export function hashFor(chainId: number): Hex { return toHex(BigInt(100_000 + chainId), { size: 32 }) }
