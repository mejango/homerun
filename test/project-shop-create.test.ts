import assert from 'node:assert/strict'
import { test } from 'vitest'
import { decodeFunctionData, encodeFunctionData, getAddress, zeroAddress, zeroHash, type Hex } from 'viem'
import { USDC_ADDRESSES, jb721TiersHookProjectDeployerAbi } from '@bananapus/nana-sdk-core'
import { v6Address, type JBRulesetConfig } from '@bananapus/nana-sdk-core/v6'
import { initialFundRuleset } from '../src/lib/fund-contracts'
import type { FundProjectState } from '../src/lib/fund-state'
import { assertFirstProjectShopConfiguration, buildCreateProjectShopRequest, type FirstProjectShopTier } from '../src/lib/project-shop-create'

const owner = '0x1111111111111111111111111111111111111111' as const
const salt = `0x${'12'.repeat(32)}` as Hex
const tier: FirstProjectShopTier = {
  price: 25_000_000n, initialSupply: 10, votingUnits: 0, reserveFrequency: 0, reserveBeneficiary: zeroAddress,
  encodedIpfsUri: `0x${'34'.repeat(32)}`, category: 0, discountPercent: 0, splitPercent: 0, splits: [],
  flags: { allowOwnerMint: false, useReserveBeneficiaryAsDefault: false, transfersPausable: false, useVotingUnits: false, cantBeRemoved: false, cantIncreaseDiscountPercent: false, cantBuyWithCredits: false },
}

function state(configuration = initialFundRuleset()): FundProjectState {
  return {
    chainId: 8453, projectId: 7n, blockNumber: 100n, blockHash: salt, blockTimestamp: 1_800_000_000n,
    owner, operator: owner, account: owner, controller: v6Address('JBController', 8453), supportedController: true, knownOwnerWrapper: true,
    terminals: [v6Address('JBMultiTerminal', 8453)], supportedTerminals: true,
    ruleset: { cycleNumber: 1, id: 1, basedOnId: 0, start: 1_700_000_000, duration: 0, weight: configuration.weight, weightCutPercent: 0, approvalHook: zeroAddress, metadata: 0n },
    metadata: configuration.metadata, upcoming: null, queued: null, hasPendingRuleset: false, projectUri: 'ipfs://metadata', tokenAddress: null,
    tokenSymbol: 'FUND', tokenDecimals: 18, totalSupply: 0n, totalCreditSupply: 0n, pendingReservedTokens: 0n, totalSupplyWithReservedTokens: 0n,
    creditBalance: 0n, erc20Balance: 0n, totalBalance: 0n,
    accountingContexts: [{ token: USDC_ADDRESSES[8453], decimals: 6, currency: 2, terminal: v6Address('JBMultiTerminal', 8453), primaryTerminal: v6Address('JBMultiTerminal', 8453), isPrimary: true, balance: 0n, surplus: 0n, symbol: 'USDC', payoutLimits: [], surplusAllowances: [] }],
    permissions: { queueRulesets: true, mintTokens: true, useAllowance: true, sendPayouts: true, deployErc20: true, setProjectUri: true, manageAllowlist: true },
    linkedPeers: [], linkedChainIds: [8453], linkedProjects: [{ chainId: 8453, projectId: 7n }], issues: [],
    rulesetSnapshot: { chainId: 8453, projectId: 7n, blockNumber: 100n, controller: v6Address('JBController', 8453), currentRulesetId: 1n, upcomingRulesetId: 0n, linkedChainIds: [8453], configuration },
  }
}
function input(configuration = initialFundRuleset()) {
  return { chainId: 8453, projectId: 7n, configuration, tiers: [tier], projectUri: 'ipfs://metadata', salt }
}

test('first shop queues exactly one preserved FUND ruleset with a USD shop and initial items', () => {
  const configuration = initialFundRuleset(1_700_000_000)
  configuration.metadata.metadata = 65
  configuration.metadata.holdFees = true
  configuration.splitGroups = [{ groupId: 1n, splits: [{ percent: 1_000_000_000, projectId: 0n, beneficiary: owner, preferAddToBalance: false, lockedUntil: 1_800_000_001, hook: zeroAddress }] }]
  configuration.fundAccessLimitGroups = [{ terminal: getAddress(v6Address('JBMultiTerminal', 8453)), token: USDC_ADDRESSES[8453], payoutLimits: [{ currency: 2, amount: 0n }], surplusAllowances: [] }]
  const before = structuredClone(configuration)
  assert.equal(assertFirstProjectShopConfiguration(state(configuration)), configuration)
  const request = buildCreateProjectShopRequest(input(configuration))
  assert.equal(request.address, v6Address('JB721TiersHookProjectDeployer', 8453))
  assert.equal(request.value, undefined)
  const data = encodeFunctionData({ abi: request.abi, functionName: request.functionName, args: request.args })
  const decoded = decodeFunctionData({ abi: jb721TiersHookProjectDeployerAbi, data })
  assert.equal(decoded.functionName, 'queueRulesetsOf')
  if (decoded.functionName !== 'queueRulesetsOf') throw new Error('Unexpected function')
  const [projectId, hook, queue, controller, actualSalt] = decoded.args
  assert.equal(projectId, 7n)
  assert.equal(controller.toLowerCase(), v6Address('JBController', 8453).toLowerCase())
  assert.equal(actualSalt, salt)
  assert.equal(hook.name, 'Project #7 shop')
  assert.equal(hook.symbol, 'SHOP')
  assert.equal(hook.contractUri, 'ipfs://metadata')
  assert.equal(hook.baseUri, 'ipfs://')
  assert.equal(hook.tokenUriResolver, zeroAddress)
  assert.deepEqual(hook.tiersConfig, { tiers: [tier], currency: 2, decimals: 6 })
  assert.deepEqual(hook.flags, { noNewTiersWithReserves: false, noNewTiersWithVotes: false, noNewTiersWithOwnerMinting: false, preventOverspending: false, issueTokensForSplits: true })
  assert.equal(queue.projectId, 7n)
  assert.equal(queue.rulesetConfigurations.length, 1)
  const actual = queue.rulesetConfigurations[0]
  assert.equal(actual.mustStartAtOrAfter, 0)
  assert.equal(actual.metadata.useDataHookForCashOut, false)
  assert.equal(actual.metadata.metadata, 65)
  assert.equal('dataHook' in actual.metadata, false)
  assert.equal('useDataHookForPay' in actual.metadata, false)
  assert.deepEqual({ ...actual, mustStartAtOrAfter: configuration.mustStartAtOrAfter, metadata: { ...actual.metadata, dataHook: zeroAddress, useDataHookForPay: false } }, configuration)
  assert.deepEqual(configuration, before)
})

test('first shop rejects existing hooks, timed rulesets, incomplete metadata and withdrawal budgets', () => {
  const variants: JBRulesetConfig[] = [
    { ...initialFundRuleset(), duration: 1 },
    { ...initialFundRuleset(), weightCutPercent: 1 },
    { ...initialFundRuleset(), approvalHook: owner },
    { ...initialFundRuleset(), metadata: { ...initialFundRuleset().metadata, dataHook: owner } },
    { ...initialFundRuleset(), metadata: { ...initialFundRuleset().metadata, useDataHookForPay: true } },
    { ...initialFundRuleset(), metadata: { ...initialFundRuleset().metadata, useDataHookForCashOut: true } },
    { ...initialFundRuleset(), metadata: {} } as JBRulesetConfig,
    ...['payoutLimits', 'surplusAllowances'].map(key => ({ ...initialFundRuleset(), fundAccessLimitGroups: [{ terminal: v6Address('JBMultiTerminal', 8453), token: USDC_ADDRESSES[8453], payoutLimits: [], surplusAllowances: [], [key]: [{ amount: 1n, currency: 2 }] }] })),
  ]
  for (const configuration of variants) {
    assert.throws(() => assertFirstProjectShopConfiguration(state(configuration)))
    assert.throws(() => buildCreateProjectShopRequest(input(configuration)))
  }
  const missing = state()
  missing.rulesetSnapshot.configuration = null
  assert.throws(() => assertFirstProjectShopConfiguration(missing), /complete current ruleset/)
})

test('first shop rejects unsupported, linked, pending and inconsistent project snapshots', () => {
  const variants: Partial<FundProjectState>[] = [
    { chainId: 999 as FundProjectState['chainId'] }, { controller: owner }, { supportedController: false }, { knownOwnerWrapper: false },
    { supportedTerminals: false }, { accountingContexts: [] }, { linkedChainIds: [8453, 10] }, { linkedChainIds: [] },
    { linkedPeers: [{ chainId: 10, suckerAddress: owner, localSuckerAddress: owner }] }, { hasPendingRuleset: true },
    { projectId: 0n }, { projectId: 1n << 64n }, { blockNumber: 0n },
    { rulesetSnapshot: { ...state().rulesetSnapshot, upcomingRulesetId: 2n } },
    { rulesetSnapshot: { ...state().rulesetSnapshot, linkedChainIds: [8453, 10] } },
    { rulesetSnapshot: { ...state().rulesetSnapshot, currentRulesetId: 2n } },
    { rulesetSnapshot: { ...state().rulesetSnapshot, blockNumber: 99n } },
    { rulesetSnapshot: { ...state().rulesetSnapshot, projectId: 8n } },
  ]
  for (const change of variants) assert.throws(() => assertFirstProjectShopConfiguration({ ...state(), ...change }))
})

test('create shop requires items, valid chain/project and a stable nonzero salt', () => {
  for (const change of [{ tiers: [] }, { chainId: 999 }, { projectId: 0n }, { projectId: 1n << 64n }, { salt: zeroHash }, { salt: '0x12' as Hex }, { name: 'x'.repeat(161) }]) {
    assert.throws(() => buildCreateProjectShopRequest({ ...input(), ...change }))
  }
  const named = buildCreateProjectShopRequest({ ...input(), name: '  Founder Haus shop  ' })
  assert.equal((named.args[1] as { name: string }).name, 'Founder Haus shop')
})
