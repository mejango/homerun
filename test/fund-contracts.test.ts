import assert from 'node:assert/strict'
import { test } from 'vitest'
import { decodeFunctionData, encodeFunctionData, zeroAddress, zeroHash, type Hex } from 'viem'
import { NATIVE_TOKEN, USDC_ADDRESSES } from '@bananapus/nana-sdk-core'
import { tokenCurrencyId, v6Address, type JBRulesetConfig } from '@bananapus/nana-sdk-core/v6'
import {
  buildFundLaunch, initialFundRuleset, parseAmount, parsePercent,
  buildFundRulesetChange, ownerMintAmount, offchainFundAmount, buildFundMint,
  buildFundReturn, buildFundPay, buildFundApproval, buildFundCashOut,
  buildFundClaimCredits, buildFundDeployErc20, buildFundTransferCredits,
  FUND_WEIGHT, type FundLaunchInput, type FundRulesetSnapshot, type FundTransaction,
} from '../src/lib/fund-contracts'

const owner = '0x1111111111111111111111111111111111111111' as const
const beneficiary = '0x2222222222222222222222222222222222222222' as const
const salt = `0x${'12'.repeat(32)}` as Hex
const input: FundLaunchInput = {
  owner, sender: owner, chainIds: [8453], projectUri: 'ipfs://bafkreihomerunmetadata',
  salt, mustStartAtOrAfter: 1_800_000_000, creationFees: { 8453: 1_234n, 10: 2_345n },
}
function snapshot(configuration = initialFundRuleset()): FundRulesetSnapshot {
  return { chainId: 8453, projectId: 7n, blockNumber: 100n, controller: v6Address('JBController', 8453),
    currentRulesetId: 1n, upcomingRulesetId: 0n, configuration, linkedChainIds: [8453] }
}
function decode(request: FundTransaction) {
  return decodeFunctionData({ abi: request.abi, data: encodeFunctionData({ abi: request.abi, functionName: request.functionName, args: request.args }) })
}
const terminal = { chainId: 8453, projectId: 7n, terminal: v6Address('JBMultiTerminal', 8453), token: USDC_ADDRESSES[8453] }

test('decimal parsing is exact, never rounds excess precision or accepts scientific notation', () => {
  assert.equal(parseAmount('9007199254740993.123456', 6), 9007199254740993123456n)
  assert.equal(parseAmount('0.000000000000000001', 18), 1n)
  for (const value of ['1e9', '-1', 'NaN', '1,000', '0.0000001', 'Infinity', '.2', '01', '1.']) {
    assert.throws(() => parseAmount(value, 6), value)
  }
  assert.equal(parsePercent('20.25'), 2025)
  assert.throws(() => parsePercent('100.01'))
  assert.throws(() => parseAmount((1n << 256n).toString(), 0))
})

test('single-chain launch encodes only vanilla FUND with current creation fee and zero owner withdrawals', () => {
  const { requests: [request], review } = buildFundLaunch(input)
  assert.equal(request.address, v6Address('JBController', 8453))
  assert.equal(request.value, 1234n)
  assert.equal(review.incomeDeployed, false)
  assert.equal(review.ownerMinting, false)
  assert.equal(review.ownerCanQueueRulesets, true)
  assert.equal(review.tokensInitially, 'Juicebox credits')
  const args = decode(request).args as readonly unknown[]
  assert.equal(args[0], owner)
  const rulesets = args[2] as JBRulesetConfig[]
  assert.equal(rulesets.length, 1)
  assert.equal(rulesets[0].weight, FUND_WEIGHT)
  assert.equal(rulesets[0].metadata.cashOutTaxRate, 1000)
  assert.equal(rulesets[0].metadata.baseCurrency, 2)
  assert.equal(rulesets[0].metadata.allowOwnerMinting, false)
  assert.equal(rulesets[0].metadata.dataHook, zeroAddress)
  assert.deepEqual(rulesets[0].fundAccessLimitGroups, [])
  assert.deepEqual(rulesets[0].splitGroups, [])
  const terminals = args[3] as { accountingContextsToAccept: { token: string; decimals: number; currency: number }[] }[]
  assert.equal(terminals[0].accountingContextsToAccept[0].token.toLowerCase(), USDC_ADDRESSES[8453].toLowerCase())
  assert.equal(terminals[0].accountingContextsToAccept[0].decimals, 6)
  assert.equal(terminals[0].accountingContextsToAccept[0].currency, tokenCurrencyId(USDC_ADDRESSES[8453]))
})

test('linked launches use omnichain deployer, paired USDC bridges, shared rules and per-chain fees', () => {
  const { requests, review } = buildFundLaunch({ ...input, chainIds: [8453, 10] })
  assert.equal(review.linked, true)
  assert.equal(requests.length, 2)
  assert.equal(requests[0].address, v6Address('JBOmnichainDeployer', 8453))
  assert.equal(requests[1].address, v6Address('JBOmnichainDeployer', 10))
  assert.equal(requests[1].value, 2345n)
  const [first, second] = requests.map(request => decode(request).args as readonly unknown[])
  assert.deepEqual(first[2], second[2])
  for (const args of [first, second]) {
    const bridges = args[5] as { salt: string; deployerConfigurations: { mappings: unknown[] }[] }
    assert.equal(bridges.salt, salt)
    assert.ok(bridges.deployerConfigurations.length > 0)
    assert.ok(bridges.deployerConfigurations.every(bridge => bridge.mappings.length > 0))
  }
})

test('launch rejects missing fees, unsupported/mixed chains, missing pins and nondeterministic linked starts', () => {
  for (const change of [
    { creationFees: {} }, { chainIds: [999] }, { chainIds: [] }, { chainIds: [8453, 8453] },
    { chainIds: [8453, 84532] }, { owner: zeroAddress }, { projectUri: 'https://example.com/draft' },
    { salt: zeroHash }, { chainIds: [8453, 10], mustStartAtOrAfter: 0 },
  ]) assert.throws(() => buildFundLaunch({ ...input, ...change }))
})

test('ruleset changes preserve full configuration and pause only changes pausePay', () => {
  const original = initialFundRuleset()
  original.metadata.holdFees = true
  original.metadata.metadata = 64
  original.splitGroups = [{ groupId: 1n, splits: [{ percent: 1_000_000_000, projectId: 0n, beneficiary, preferAddToBalance: false, lockedUntil: 0, hook: zeroAddress }] }]
  original.fundAccessLimitGroups = [{ terminal: terminal.terminal, token: terminal.token, payoutLimits: [], surplusAllowances: [] }]
  const { requests: [request], configurations: [next] } = buildFundRulesetChange({ snapshots: [snapshot(original)], action: 'pause', mustStartAtOrAfter: 10 })
  assert.equal(next.metadata.pausePay, true)
  assert.equal(next.metadata.holdFees, true)
  assert.equal(next.metadata.metadata, 64)
  assert.deepEqual(next.fundAccessLimitGroups, original.fundAccessLimitGroups)
  assert.deepEqual(next.splitGroups, original.splitGroups)
  assert.equal(original.metadata.pausePay, false)
  assert.equal(decode(request).functionName, 'queueRulesetsOf')
})

test('failure and sale refunds enable zero-tax cashout, stop issuance and clear withdrawal limits', () => {
  const current = initialFundRuleset()
  current.fundAccessLimitGroups = [{ terminal: terminal.terminal, token: terminal.token, payoutLimits: [{ amount: 1n, currency: 2 }], surplusAllowances: [{ amount: 2n, currency: 2 }] }]
  for (const action of ['failure-refunds', 'asset-sale-refunds'] as const) {
    const { configurations: [next] } = buildFundRulesetChange({ snapshots: [snapshot(current)], action, mustStartAtOrAfter: 10 })
    assert.equal(next.metadata.cashOutTaxRate, 0)
    assert.equal(next.metadata.pausePay, true)
    assert.equal(next.metadata.allowOwnerMinting, false)
    assert.deepEqual(next.fundAccessLimitGroups, [])
  }
})

test('unknown/incomplete, pending, timed and custom-hook configurations are rejected', () => {
  const base = snapshot()
  const variants = [
    { ...base, configuration: null }, { ...base, controller: beneficiary }, { ...base, upcomingRulesetId: 2n },
    { ...base, configuration: { ...initialFundRuleset(), duration: 1 } },
    { ...base, configuration: { ...initialFundRuleset(), metadata: { ...initialFundRuleset().metadata, dataHook: beneficiary } } },
    { ...base, configuration: { ...initialFundRuleset(), metadata: {} } as JBRulesetConfig },
    { ...base, linkedChainIds: [8453, 10] },
  ]
  for (const value of variants) assert.throws(() => buildFundRulesetChange({ snapshots: [value], action: 'pause', mustStartAtOrAfter: 10 }))
})

test('canonical omnichain wrapper is verified, unwrapped and queued on every peer', () => {
  const make = (chainId: 8453 | 10): FundRulesetSnapshot => {
    const config = initialFundRuleset()
    config.metadata.dataHook = v6Address('JBOmnichainDeployer', chainId)
    config.metadata.useDataHookForPay = true
    config.metadata.useDataHookForCashOut = true
    return { ...snapshot(config), chainId, controller: v6Address('JBController', chainId), linkedChainIds: [8453, 10],
      omnichainHooks: { dataHook: zeroAddress, tiered721Hook: beneficiary, useDataHookForPay: false, useDataHookForCashOut: false, tiered721UseDataHookForCashOut: false, tiered721HasTiers: false } }
  }
  const snapshots = [make(8453), make(10)]
  const { requests, configurations } = buildFundRulesetChange({ snapshots, action: 'pause', mustStartAtOrAfter: 100 })
  assert.equal(requests.length, 2)
  assert.deepEqual(configurations[0], configurations[1])
  assert.equal(configurations[0].metadata.dataHook, zeroAddress)
  assert.equal(configurations[0].metadata.useDataHookForPay, false)
  requests.forEach(request => {
    assert.equal(request.address, v6Address('JBOmnichainDeployer', request.chainId as 8453 | 10))
    assert.equal(decode(request).functionName, 'queueRulesetsOf')
  })
  assert.throws(() => buildFundRulesetChange({ snapshots: [{ ...snapshots[0], omnichainHooks: undefined }, snapshots[1]], action: 'pause', mustStartAtOrAfter: 100 }))
  assert.throws(() => buildFundRulesetChange({ snapshots: [{ ...snapshots[0], omnichainHooks: { ...snapshots[0].omnichainHooks!, dataHook: beneficiary } }, snapshots[1]], action: 'pause', mustStartAtOrAfter: 100 }))
  assert.throws(() => buildFundRulesetChange({ snapshots: [{ ...snapshots[0], omnichainHooks: { ...snapshots[0].omnichainHooks!, tiered721HasTiers: true } }, snapshots[1]], action: 'pause', mustStartAtOrAfter: 100 }))
})

test('success minting requires confirmed closed rules then can be revoked', () => {
  assert.throws(() => buildFundMint({ snapshot: snapshot(), beneficiary, tokenCount: 1n, kind: 'offchain-contribution' }))
  assert.throws(() => buildFundRulesetChange({ snapshots: [snapshot()], action: 'enable-success-minting', mustStartAtOrAfter: 1 }))
  const closed = buildFundRulesetChange({ snapshots: [snapshot()], action: 'close', mustStartAtOrAfter: 1 }).configurations[0]
  const enabled = buildFundRulesetChange({ snapshots: [snapshot(closed)], action: 'enable-success-minting', mustStartAtOrAfter: 2 }).configurations[0]
  const tx = buildFundMint({ snapshot: snapshot(enabled), beneficiary, tokenCount: offchainFundAmount('100.50'), kind: 'offchain-contribution' })
  assert.equal(decode(tx).functionName, 'mintTokensOf')
  assert.equal(tx.args[1], 1_005_000n * 10n ** 18n)
  assert.equal(tx.args[4], false)
  const finished = buildFundRulesetChange({ snapshots: [snapshot(enabled)], action: 'finish-success-minting', mustStartAtOrAfter: 3 }).configurations[0]
  assert.equal(finished.metadata.allowOwnerMinting, false)
})

test('operator issuance computes post-mint ownership including preexisting operator balance', () => {
  const supply = 500_000n * 10n ** 18n
  assert.equal(ownerMintAmount(supply, 0n, 2000), 125_000n * 10n ** 18n)
  const existing = 50_000n * 10n ** 18n
  const minted = ownerMintAmount(supply, existing, 2000)
  assert.equal((existing + minted) * 10_000n, (supply + minted) * 2000n)
  assert.equal(ownerMintAmount(supply, 150_000n * 10n ** 18n, 2000), 0n)
  assert.throws(() => ownerMintAmount(supply, 0n, 10_000))
  assert.throws(() => ownerMintAmount(supply, supply + 1n, 2000))
  assert.equal(ownerMintAmount(1n, 0n, 3333), 0n)
})

test('returns and sale deposits use addToBalance, with exact token approvals and never mint FUND', () => {
  const tx = buildFundReturn({ ...terminal, amount: 5_000_000n, reason: 'refunds', shouldReturnHeldFees: true })
  assert.equal(decode(tx).functionName, 'addToBalanceOf')
  assert.equal(tx.value, 0n)
  assert.equal(tx.args[3], true)
  const approval = buildFundApproval({ ...terminal, amount: 5_000_000n })!
  assert.equal((decode(approval).args![0] as string).toLowerCase(), terminal.terminal.toLowerCase())
  assert.equal(decode(approval).args![1], 5_000_000n)
  const native = { ...terminal, token: NATIVE_TOKEN }
  assert.equal(buildFundApproval({ ...native, amount: 100n }), null)
  assert.equal(buildFundReturn({ ...native, amount: 100n, reason: 'asset-sale', shouldReturnHeldFees: false }).value, 100n)
})

test('holder calls encode minimum protection, claims require deployed ERC20 and transfers need no staking', () => {
  const pay = buildFundPay({ ...terminal, amount: 1_000_000n, minReturnedTokens: 9900n * 10n ** 18n, beneficiary })
  assert.equal(decode(pay).functionName, 'pay')
  assert.throws(() => buildFundPay({ ...terminal, amount: 1n, minReturnedTokens: 0n, beneficiary }))
  const cashout = buildFundCashOut({ ...terminal, holder: owner, tokenCount: 100n, minTokensReclaimed: 9n, beneficiary })
  assert.equal(decode(cashout).functionName, 'cashOutTokensOf')
  assert.equal(cashout.args[4], 9n)
  assert.throws(() => buildFundClaimCredits({ chainId: 8453, projectId: 7n, holder: owner, tokenCount: 1n, beneficiary, tokenAddress: zeroAddress }))
  assert.equal(decode(buildFundClaimCredits({ chainId: 8453, projectId: 7n, holder: owner, tokenCount: 1n, beneficiary, tokenAddress: beneficiary })).functionName, 'claimTokensFor')
  assert.equal(decode(buildFundTransferCredits({ chainId: 8453, projectId: 7n, holder: owner, recipient: beneficiary, creditCount: 1n })).functionName, 'transferCreditsFrom')
  const deploy = buildFundDeployErc20({ chainId: 8453, projectId: 7n, projectName: 'Founder Haus', salt })
  assert.equal(decode(deploy).functionName, 'deployERC20For')
  assert.deepEqual(deploy.args, [7n, 'Founder Haus FUND', 'FUND', salt])
})
