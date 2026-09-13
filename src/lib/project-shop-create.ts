import { jb721TiersHookProjectDeployerAbi, type JBChainId } from '@bananapus/nana-sdk-core'
import { BASE_CURRENCY_USD, buildRulesetMetadata, v6Address, type JBRulesetConfig } from '@bananapus/nana-sdk-core/v6'
import { isAddressEqual, zeroAddress, zeroHash, type ContractFunctionArgs, type Hex } from 'viem'
import type { TxRequest } from '../hooks/useSafeTx'
import { FUND_CHAIN_IDS } from './fund-contracts'
import type { FundProjectState } from './fund-state'

type CreateShopArgs = ContractFunctionArgs<typeof jb721TiersHookProjectDeployerAbi, 'nonpayable', 'queueRulesetsOf'>
export type FirstProjectShopTier = CreateShopArgs[1]['tiersConfig']['tiers'][number]

function assertConfiguration(configuration: JBRulesetConfig | null): asserts configuration is JBRulesetConfig {
  if (!configuration || !Array.isArray(configuration.splitGroups) || !Array.isArray(configuration.fundAccessLimitGroups)) {
    throw new Error('Read the complete current ruleset, splits and fund access limits before creating a shop.')
  }
  const expectedKeys = Object.keys(buildRulesetMetadata())
  if (!configuration.metadata || Object.keys(configuration.metadata).length !== expectedKeys.length || expectedKeys.some(key => !(key in configuration.metadata))) {
    throw new Error('The current ruleset metadata is incomplete or unsupported.')
  }
  if (!isAddressEqual(configuration.metadata.dataHook, zeroAddress) || configuration.metadata.useDataHookForPay || configuration.metadata.useDataHookForCashOut) {
    throw new Error('This project already has a payment or cash-out hook. Add items to its existing shop or use the full Juicebox ruleset editor.')
  }
  if (configuration.duration !== 0 || configuration.weightCutPercent !== 0 || !isAddressEqual(configuration.approvalHook, zeroAddress)) {
    throw new Error('Creating this shop would change a timed or approval-controlled ruleset. Use the full Juicebox ruleset editor.')
  }
  if (configuration.fundAccessLimitGroups.some(group => [...group.payoutLimits, ...group.surplusAllowances].some(limit => limit.amount !== 0n))) {
    throw new Error('Creating this shop would reset the current payout or allowance budget. Use the full Juicebox ruleset editor.')
  }
}

/** Require a complete onchain snapshot before replacing a vanilla FUND ruleset's empty data hook. */
export function assertFirstProjectShopConfiguration(state: FundProjectState): JBRulesetConfig {
  if (!(FUND_CHAIN_IDS as readonly number[]).includes(state.chainId)) throw new Error('Shop creation is not supported on this network.')
  if (!state.supportedController || !isAddressEqual(state.controller, v6Address('JBController', state.chainId))) {
    throw new Error('This project uses an unsupported controller. Use the full Juicebox ruleset editor.')
  }
  if (!state.knownOwnerWrapper) throw new Error('Create items through this project’s existing operator-managed shop.')
  if (!state.supportedTerminals || state.accountingContexts.length === 0) throw new Error('Read this project’s supported payment terminals before creating a shop.')
  const snapshot = state.rulesetSnapshot
  if (state.linkedPeers.length !== 0 || state.linkedChainIds.length !== 1 || state.linkedChainIds[0] !== state.chainId ||
    snapshot.linkedChainIds.length !== 1 || snapshot.linkedChainIds[0] !== state.chainId) {
    throw new Error('Linked FUND projects must use their existing omnichain shop.')
  }
  if (state.projectId <= 0n || state.projectId >= 1n << 64n || state.blockNumber <= 0n || state.ruleset.id === 0) {
    throw new Error('Read a mined, active project ruleset before creating a shop.')
  }
  if (snapshot.chainId !== state.chainId || snapshot.projectId !== state.projectId || snapshot.blockNumber !== state.blockNumber ||
    snapshot.currentRulesetId !== BigInt(state.ruleset.id) || !isAddressEqual(snapshot.controller, state.controller)) {
    throw new Error('The project configuration changed. Refresh it before creating a shop.')
  }
  if (state.hasPendingRuleset || (snapshot.upcomingRulesetId !== 0n && snapshot.upcomingRulesetId !== snapshot.currentRulesetId)) {
    throw new Error('Review the already queued ruleset before creating a shop.')
  }
  assertConfiguration(snapshot.configuration)
  return snapshot.configuration
}

/** The deployer must have QUEUE_RULESETS permission before this request can execute. */
export function buildCreateProjectShopRequest(input: {
  chainId: number
  projectId: bigint
  configuration: JBRulesetConfig
  tiers: readonly FirstProjectShopTier[]
  projectUri: string
  name?: string
  salt: Hex
}): TxRequest {
  if (!(FUND_CHAIN_IDS as readonly number[]).includes(input.chainId)) throw new Error('Shop creation is not supported on this network.')
  if (input.projectId <= 0n || input.projectId >= 1n << 64n) throw new Error('A valid project ID is required to create a shop.')
  if (!/^0x[\da-fA-F]{64}$/.test(input.salt) || input.salt.toLowerCase() === zeroHash) throw new Error('A nonzero bytes32 shop deployment salt is required.')
  if (input.tiers.length === 0) throw new Error('Add at least one item before creating a shop.')
  assertConfiguration(input.configuration)
  const chainId = input.chainId as JBChainId
  const name = input.name?.trim() || `Project #${input.projectId} shop`
  if (name.length > 160) throw new Error('Use at most 160 characters for the shop name.')
  // ProjectDeployer supplies these two fields for the hook it deploys. Every
  // other metadata field, split and zero-budget group stays as read onchain.
  const metadata = { ...input.configuration.metadata }
  const { dataHook, useDataHookForPay, ...payHookMetadata } = metadata
  void dataHook
  void useDataHookForPay
  const args: CreateShopArgs = [
    input.projectId,
    {
      name,
      symbol: 'SHOP',
      baseUri: 'ipfs://',
      tokenUriResolver: zeroAddress,
      contractUri: input.projectUri,
      tiersConfig: { tiers: input.tiers, currency: BASE_CURRENCY_USD, decimals: 6 },
      flags: {
        noNewTiersWithReserves: false,
        noNewTiersWithVotes: false,
        noNewTiersWithOwnerMinting: false,
        preventOverspending: false,
        issueTokensForSplits: true,
      },
    },
    { projectId: input.projectId, rulesetConfigurations: [{ ...input.configuration, mustStartAtOrAfter: 0, metadata: payHookMetadata }], memo: 'Create project shop' },
    v6Address('JBController', chainId),
    input.salt,
  ]
  return { chainId, address: v6Address('JB721TiersHookProjectDeployer', chainId), abi: jb721TiersHookProjectDeployerAbi, functionName: 'queueRulesetsOf', args, label: 'Create shop and add items' }
}
