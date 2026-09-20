import assert from 'node:assert/strict'
import { test, vi } from 'vitest'
import { decodeFunctionData, encodeFunctionData, zeroAddress, zeroHash, type Hex } from 'viem'
import { CCIP_SUCKER_DEPLOYER_ADDRESSES, NATIVE_TOKEN, USDC_ADDRESSES } from '@bananapus/nana-sdk-core'
import { v6Address } from '@bananapus/nana-sdk-core/v6'
import { HOMERUN_ALLOWLIST_HOOK, HOMERUN_DEPLOYER } from './fixtures/homerun-deployer'

vi.mock('@bananapus/nana-sdk-core', async importOriginal => (await import('./fixtures/homerun-deployer')).withHomerunDeployer(await importOriginal()))
import {
  buildFundLaunch, initialFundRuleset, parseAmount, parsePercent,
  buildFundRulesetChange, ownerMintAmount, offchainFundAmount, buildFundMint,
  buildFundReturn, buildFundPay, buildFundApproval, buildFundCashOut,
  buildFundAllowlistChange, buildFundAllowlistOpen,
  FUND_WEIGHT, type FundLaunchInput, type FundRulesetSnapshot, type FundTransaction,
} from '../src/lib/fund-contracts'

const owner = '0x1111111111111111111111111111111111111111' as const
const beneficiary = '0x2222222222222222222222222222222222222222' as const
const salt = `0x${'12'.repeat(32)}` as Hex
const input: FundLaunchInput = {
  owner, sender: owner, chainIds: [8453], projectUri: 'ipfs://bafkreihomerunmetadata', tokenName: 'House FUND', ticker: 'HOUSE',
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

test('single-chain launch asks HomerunDeployer for a FUND with no salt, no peers and the current creation fee', () => {
  const { requests: [request], review } = buildFundLaunch(input)
  assert.equal(request.address, HOMERUN_DEPLOYER)
  assert.equal(request.value, 1234n)
  assert.equal(review.incomeDeployed, false)
  assert.equal(review.ownerMinting, false)
  assert.equal(review.ownerCanQueueRulesets, true)
  assert.equal(review.tokensInitially, 'ERC-20')
  const decoded = decode(request)
  assert.equal(decoded.functionName, 'launchFundFor')
  assert.deepEqual(decoded.args, [owner, input.projectUri, 'House FUND', 'HOUSE', 1_800_000_000, zeroHash, []])
})

test('linked launches share the salt and name each peer CCIP deployer in ascending remote chain order', () => {
  const { requests, review } = buildFundLaunch({ ...input, chainIds: [42161, 8453, 10], creationFees: { ...input.creationFees, 42161: 3n } })
  assert.equal(review.linked, true)
  assert.deepEqual(requests.map(request => request.chainId), [42161, 8453, 10])
  assert.ok(requests.every(request => request.address === HOMERUN_DEPLOYER))
  assert.equal(requests[2].value, 2345n)
  const ccip = CCIP_SUCKER_DEPLOYER_ADDRESSES[6]
  for (const request of requests) {
    const args = decode(request).args as readonly unknown[]
    assert.equal(args[5], salt)
    const peers = [10, 8453, 42161].filter(id => id !== request.chainId)
    assert.deepEqual((args[6] as string[]).map(value => value.toLowerCase()), peers.map(id => ccip[request.chainId as 10][id as 10]!.toLowerCase()))
  }
})

test('the fixed rules the contract hardcodes stay available for verification and rule changes', () => {
  const ruleset = initialFundRuleset()
  assert.equal(ruleset.weight, FUND_WEIGHT)
  assert.equal(ruleset.metadata.cashOutTaxRate, 1000)
  assert.equal(ruleset.metadata.baseCurrency, 2)
  assert.equal(ruleset.metadata.allowOwnerMinting, false)
  assert.equal(ruleset.metadata.dataHook, zeroAddress)
  assert.deepEqual(ruleset.fundAccessLimitGroups, [])
  assert.deepEqual(ruleset.splitGroups, [])
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

test('allowlist changes target the registered hook with unique checksummed addresses', () => {
  const change = buildFundAllowlistChange({ chainId: 8453, projectId: 7n, accounts: [beneficiary.toLowerCase(), owner], allowed: true })
  assert.equal(change.address, HOMERUN_ALLOWLIST_HOOK)
  assert.equal(decode(change).functionName, 'setAllowed')
  assert.deepEqual(change.args, [7n, [beneficiary, owner], true])
  assert.deepEqual(buildFundAllowlistChange({ chainId: 8453, projectId: 7n, accounts: [owner], allowed: false }).args, [7n, [owner], false])
  for (const accounts of [[], [owner, owner.toLowerCase()], ['0x123'], Array.from({ length: 201 }, (_, i) => `0x${(i + 1).toString(16).padStart(40, '0')}`)]) {
    assert.throws(() => buildFundAllowlistChange({ chainId: 8453, projectId: 7n, accounts, allowed: true }))
  }
  const open = buildFundAllowlistOpen({ chainId: 8453, projectId: 7n, open: true })
  assert.equal(open.address, HOMERUN_ALLOWLIST_HOOK)
  assert.deepEqual([decode(open).functionName, open.args], ['setOpen', [7n, true]])
  assert.throws(() => buildFundAllowlistOpen({ chainId: 999, projectId: 7n, open: true }))
})

test('canonical omnichain wrapper is verified, unwrapped and queued on every peer', () => {
  const make = (chainId: 8453 | 10): FundRulesetSnapshot => {
    const config = initialFundRuleset()
    config.metadata.dataHook = v6Address('JBOmnichainDeployer', chainId)
    config.metadata.useDataHookForPay = true
    config.metadata.useDataHookForCashOut = true
    return { ...snapshot(config), chainId, controller: v6Address('JBController', chainId), linkedChainIds: [8453, 10],
      stock721Hook: { address: beneficiary, verified: true, hasTiers: true },
      omnichainHooks: { dataHook: zeroAddress, tiered721Hook: beneficiary, useDataHookForPay: false, useDataHookForCashOut: false, tiered721UseDataHookForCashOut: false, tiered721HasTiers: true } }
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
  assert.throws(() => buildFundRulesetChange({ snapshots: [{ ...snapshots[0], stock721Hook: undefined }, snapshots[1]], action: 'pause', mustStartAtOrAfter: 100 }))
  // The registered allowlist hook is the one extra hook a rule change keeps; a cash-out flag on it is foreign.
  const gated = snapshots.map(entry => ({ ...entry, omnichainHooks: { ...entry.omnichainHooks!, dataHook: HOMERUN_ALLOWLIST_HOOK, useDataHookForPay: true } }))
  const kept = buildFundRulesetChange({ snapshots: gated, action: 'pause', mustStartAtOrAfter: 100 }).configurations[0].metadata
  assert.equal(kept.dataHook, HOMERUN_ALLOWLIST_HOOK)
  assert.equal(kept.useDataHookForPay, true)
  assert.equal(kept.useDataHookForCashOut, false)
  assert.throws(() => buildFundRulesetChange({ snapshots: gated.map(entry => ({ ...entry, omnichainHooks: { ...entry.omnichainHooks!, useDataHookForCashOut: true } })), action: 'pause', mustStartAtOrAfter: 100 }))
})

test('direct stock shops retain the hook while closing or opening FUND refunds', () => {
  const config = initialFundRuleset()
  config.metadata.dataHook = beneficiary
  config.metadata.useDataHookForPay = true
  const current: FundRulesetSnapshot = { ...snapshot(config), stock721Hook: { address: beneficiary, verified: true, hasTiers: true } }
  for (const action of ['close', 'failure-refunds', 'asset-sale-refunds'] as const) {
    const result = buildFundRulesetChange({ snapshots: [current], action, mustStartAtOrAfter: 100 })
    assert.equal(result.configurations[0].metadata.dataHook, beneficiary)
    assert.equal(result.configurations[0].metadata.useDataHookForPay, true)
    assert.equal(result.configurations[0].metadata.useDataHookForCashOut, false)
    assert.equal(result.configurations[0].metadata.pausePay, true)
    assert.equal(result.configurations[0].metadata.allowOwnerMinting, false)
    assert.equal(result.configurations[0].metadata.cashOutTaxRate, action === 'close' ? 10_000 : 0)
    assert.equal(decode(result.requests[0]).functionName, 'queueRulesetsOf')
  }
  assert.throws(() => buildFundRulesetChange({ snapshots: [{ ...current, stock721Hook: undefined }], action: 'close', mustStartAtOrAfter: 100 }))
  assert.throws(() => buildFundRulesetChange({ snapshots: [{ ...current, stock721Hook: { ...current.stock721Hook!, address: zeroAddress } }], action: 'close', mustStartAtOrAfter: 100 }))
  assert.throws(() => buildFundRulesetChange({ snapshots: [{ ...current, configuration: { ...config, metadata: { ...config.metadata, useDataHookForCashOut: true } } }], action: 'close', mustStartAtOrAfter: 100 }))
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

test('holder calls encode minimum protection', () => {
  const pay = buildFundPay({ ...terminal, amount: 1_000_000n, minReturnedTokens: 9900n * 10n ** 18n, beneficiary })
  assert.equal(decode(pay).functionName, 'pay')
  assert.throws(() => buildFundPay({ ...terminal, amount: 1n, minReturnedTokens: 0n, beneficiary }))
  const cashout = buildFundCashOut({ ...terminal, holder: owner, tokenCount: 100n, minTokensReclaimed: 9n, beneficiary })
  assert.equal(decode(cashout).functionName, 'cashOutTokensOf')
  assert.equal(cashout.args[4], 9n)
})
