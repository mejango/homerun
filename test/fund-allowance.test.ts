import assert from 'node:assert/strict'
import { test } from 'vitest'
import { decodeFunctionData, encodeFunctionData, getAddress, zeroAddress, type Address } from 'viem'
import { NATIVE_TOKEN, USDC_ADDRESSES } from '@bananapus/nana-sdk-core'
import { tokenCurrencyId, v6Address } from '@bananapus/nana-sdk-core/v6'
import {
  buildFundAssetAllowanceChange, buildFundUseAllowance, buildFundRulesetChange, initialFundRuleset,
  type FundRulesetSnapshot, type FundTransaction,
} from '../src/lib/fund-contracts'

const beneficiary = '0x1111111111111111111111111111111111111111' as const
const feeBeneficiary = '0x2222222222222222222222222222222222222222' as const
const otherAddress = '0x3333333333333333333333333333333333333333' as const
const amount = 500_000n * 10n ** 6n
const uint224Max = (1n << 224n) - 1n

function context(chainId: 8453 | 10 = 8453, token: Address = USDC_ADDRESSES[chainId]) {
  return { chainId, terminal: getAddress(v6Address('JBMultiTerminal', chainId)), token, currency: tokenCurrencyId(token) }
}

function snapshot(chainId: 8453 | 10 = 8453, allowance = 0n, token: Address = USDC_ADDRESSES[chainId]): FundRulesetSnapshot {
  const configuration = initialFundRuleset()
  configuration.metadata.pausePay = true
  configuration.metadata.cashOutTaxRate = 10_000
  configuration.fundAccessLimitGroups = [{
    terminal: context(chainId).terminal, token, payoutLimits: [],
    surplusAllowances: allowance === 0n ? [] : [{ amount: allowance, currency: tokenCurrencyId(token) }],
  }]
  return {
    chainId, projectId: 7n, blockNumber: 100n, controller: v6Address('JBController', chainId),
    currentRulesetId: 1n, upcomingRulesetId: 0n, configuration, linkedChainIds: [chainId],
    accountingContexts: [{ terminal: context(chainId).terminal, token, currency: tokenCurrencyId(token), decimals: token === NATIVE_TOKEN ? 18 : 6 }],
  }
}

function spend() {
  return { snapshot: snapshot(8453, amount), ...context(), amount, minTokensPaidOut: amount * 975n / 1000n, beneficiary, feeBeneficiary, memo: 'Reviewed asset purchase' }
}

function configure(snapshots: FundRulesetSnapshot[] = [snapshot()]) {
  return { snapshots, mustStartAtOrAfter: 1_800_000_000, allowances: [{ ...context(), amount }] }
}

function decode(request: FundTransaction) {
  return decodeFunctionData({ abi: request.abi, data: encodeFunctionData({ abi: request.abi, functionName: request.functionName, args: request.args }) })
}

test('allowance spend encodes the selected treasury, exact budget, payout minimum and recipients', () => {
  const input = spend()
  const original = structuredClone(input.snapshot)
  const request = buildFundUseAllowance(input)
  assert.equal(request.address.toLowerCase(), context().terminal.toLowerCase())
  assert.equal(request.chainId, 8453)
  assert.equal(request.value ?? 0n, 0n)
  const decoded = decode(request)
  assert.equal(decoded.functionName, 'useAllowanceOf')
  assert.deepEqual(decoded.args, [7n, input.token, amount, BigInt(input.currency), input.minTokensPaidOut, beneficiary, feeBeneficiary, input.memo])
  assert.deepEqual(input.snapshot, original)
})

test('allowance spend accepts a partial use of a configured cap and canonical native-token context', () => {
  assert.equal(buildFundUseAllowance({ ...spend(), amount: 100n, minTokensPaidOut: 97n }).args[2], 100n)
  const native = { ...spend(), ...context(8453, NATIVE_TOKEN), snapshot: snapshot(8453, amount, NATIVE_TOKEN) }
  assert.equal(decode(buildFundUseAllowance(native)).args?.[1], NATIVE_TOKEN)
})

test('allowance spend requires confirmed closed rules and rejects incomplete or custom snapshots', () => {
  const inputs = [
    { ...snapshot(8453, amount), configuration: null },
    { ...snapshot(8453, amount), upcomingRulesetId: 2n },
    { ...snapshot(8453, amount), controller: otherAddress },
    { ...snapshot(8453, amount), blockNumber: 0n },
  ]
  for (const change of [{ pausePay: false }, { cashOutTaxRate: 1000 }, { cashOutTaxRate: 0 }, { dataHook: otherAddress }]) {
    const candidate = snapshot(8453, amount)
    Object.assign(candidate.configuration!.metadata, change)
    inputs.push(candidate)
  }
  for (const candidate of inputs) assert.throws(() => buildFundUseAllowance({ ...spend(), snapshot: candidate }))
})

test('allowance spend rejects unsupported treasury contexts, missing allocations and currency mismatches', () => {
  for (const change of [
    { terminal: otherAddress }, { token: otherAddress }, { token: USDC_ADDRESSES[10] },
    { currency: 2 }, { currency: -1 }, { currency: 1.5 }, { currency: 2 ** 32 },
    { currency: Number.NaN }, { snapshot: snapshot() },
  ]) assert.throws(() => buildFundUseAllowance({ ...spend(), ...change }))
  const wrongCurrency = snapshot(8453, amount)
  wrongCurrency.configuration!.fundAccessLimitGroups[0].surplusAllowances[0].currency = 2
  assert.throws(() => buildFundUseAllowance({ ...spend(), snapshot: wrongCurrency }))
  const missingContext = snapshot(8453, amount)
  missingContext.configuration!.fundAccessLimitGroups = []
  assert.throws(() => buildFundUseAllowance({ ...spend(), snapshot: missingContext }))
})

test('allowance spend enforces finite caps, positive payout protection and valid nonzero recipients', () => {
  for (const value of [-1n, 0n, amount + 1n, uint224Max, uint224Max + 1n]) {
    assert.throws(() => buildFundUseAllowance({ ...spend(), amount: value }))
  }
  for (const value of [-1n, 0n, amount + 1n]) {
    assert.throws(() => buildFundUseAllowance({ ...spend(), minTokensPaidOut: value }))
  }
  for (const field of ['beneficiary', 'feeBeneficiary'] as const) {
    for (const value of [zeroAddress, '0x1234' as Address]) {
      assert.throws(() => buildFundUseAllowance({ ...spend(), [field]: value }))
    }
  }
})

test('configuring an explicit allowance preserves other closed rules and leaves caller snapshots untouched', () => {
  const input = configure()
  input.snapshots[0].configuration!.metadata.holdFees = true
  input.snapshots[0].configuration!.metadata.metadata = 64
  const original = structuredClone(input.snapshots)
  const result = buildFundAssetAllowanceChange(input)
  assert.equal(result.action, 'configure-asset-allowance')
  assert.equal(result.requests.length, 1)
  assert.equal(decode(result.requests[0]).functionName, 'queueRulesetsOf')
  assert.equal(result.requests[0].address, v6Address('JBController', 8453))
  const next = result.configurations[0]
  assert.equal(next.mustStartAtOrAfter, input.mustStartAtOrAfter)
  assert.deepEqual(next.metadata, original[0].configuration!.metadata)
  assert.equal(next.weight, original[0].configuration!.weight)
  assert.deepEqual(next.fundAccessLimitGroups, [{
    terminal: context().terminal, token: context().token, payoutLimits: [],
    surplusAllowances: [{ amount, currency: context().currency }],
  }])
  assert.deepEqual(input.snapshots, original)
})

test('allowance configuration accepts only an explicit, finite budget in an existing canonical accounting context', () => {
  for (const value of [-1n, uint224Max, uint224Max + 1n]) {
    assert.throws(() => buildFundAssetAllowanceChange({ ...configure(), allowances: [{ ...context(), amount: value }] }))
  }
  for (const change of [
    { terminal: otherAddress }, { token: otherAddress }, { token: USDC_ADDRESSES[10] },
    { currency: 2 }, { currency: -1 }, { currency: 1.5 }, { currency: 2 ** 32 }, { currency: Number.NaN }, { chainId: 10 },
  ]) {
    assert.throws(() => buildFundAssetAllowanceChange({ ...configure(), allowances: [{ ...context(), amount, ...change }] }))
  }
  assert.throws(() => buildFundAssetAllowanceChange({ ...configure(), allowances: [] }))
  assert.throws(() => buildFundAssetAllowanceChange({ ...configure(), allowances: [{ ...context(), amount }, { ...context(), amount }] }))
  const native = buildFundAssetAllowanceChange({ ...configure([snapshot(8453, 0n, NATIVE_TOKEN)]), allowances: [{ ...context(8453, NATIVE_TOKEN), amount }] })
  assert.equal(native.configurations[0].fundAccessLimitGroups[0].token, NATIVE_TOKEN)
})

test('newly launched projects can configure their first allowance without an existing fund access group', () => {
  const current = snapshot()
  current.configuration!.fundAccessLimitGroups = []
  const result = buildFundAssetAllowanceChange(configure([current]))
  assert.deepEqual(result.configurations[0].fundAccessLimitGroups, [{
    terminal: context().terminal, token: context().token, payoutLimits: [],
    surplusAllowances: [{ amount, currency: context().currency }],
  }])
  assert.deepEqual(current.configuration!.fundAccessLimitGroups, [])
})

test('configuring and spending require exactly one verified accounting context with the correct token precision', () => {
  const verified = snapshot().accountingContexts![0]
  const invalidContexts: FundRulesetSnapshot['accountingContexts'][] = [
    undefined, [], [verified, verified], [{ ...verified, decimals: 18 }],
    [{ ...verified, terminal: otherAddress }], [{ ...verified, token: USDC_ADDRESSES[10] }],
    [{ ...verified, currency: 2 }],
  ]
  for (const accountingContexts of invalidContexts) {
    assert.throws(() => buildFundAssetAllowanceChange(configure([{ ...snapshot(), accountingContexts }])))
    assert.throws(() => buildFundUseAllowance({ ...spend(), snapshot: { ...snapshot(8453, amount), accountingContexts } }))
  }
  const native = snapshot(8453, amount, NATIVE_TOKEN)
  native.accountingContexts = [{ ...native.accountingContexts![0], decimals: 6 }]
  assert.throws(() => buildFundAssetAllowanceChange({ ...configure([native]), allowances: [{ ...context(8453, NATIVE_TOKEN), amount }] }))
  assert.throws(() => buildFundUseAllowance({ ...spend(), ...context(8453, NATIVE_TOKEN), snapshot: native }))
})

test('an explicitly verified USD accounting currency is accepted without assuming token-based currency IDs', () => {
  const current = snapshot(8453, amount)
  current.accountingContexts = [{ ...current.accountingContexts![0], currency: 2 }]
  current.configuration!.fundAccessLimitGroups[0].surplusAllowances[0].currency = 2
  const result = buildFundAssetAllowanceChange({ ...configure([current]), allowances: [{ ...context(), currency: 2, amount }] })
  assert.deepEqual(result.configurations[0].fundAccessLimitGroups[0].surplusAllowances, [{ amount, currency: 2 }])
  assert.equal(decode(buildFundUseAllowance({ ...spend(), snapshot: current, currency: 2 })).args?.[3], 2n)
  assert.throws(() => buildFundUseAllowance({ ...spend(), snapshot: current }))
  assert.throws(() => buildFundAssetAllowanceChange(configure([current])))
})

test('allowance configuration requires closed rules, full snapshots and no conflicting queue', () => {
  assert.throws(() => buildFundAssetAllowanceChange(configure([])))
  for (const change of [{ configuration: null }, { upcomingRulesetId: 2n }, { controller: otherAddress }]) {
    assert.throws(() => buildFundAssetAllowanceChange(configure([{ ...snapshot(), ...change }])))
  }
  for (const change of [{ pausePay: false }, { cashOutTaxRate: 1000 }, { cashOutTaxRate: 0 }]) {
    const candidate = snapshot()
    Object.assign(candidate.configuration!.metadata, change)
    assert.throws(() => buildFundAssetAllowanceChange(configure([candidate])))
  }
})

test('allowance configuration replaces a selected cap only when its full context is explicitly reviewed', () => {
  const current = snapshot(8453, amount / 2n)
  const next = buildFundAssetAllowanceChange(configure([current])).configurations[0]
  assert.deepEqual(next.fundAccessLimitGroups[0].surplusAllowances, [{ amount, currency: context().currency }])
  assert.equal(current.configuration!.fundAccessLimitGroups[0].surplusAllowances[0].amount, amount / 2n)
  const otherCurrency = snapshot(8453, amount)
  otherCurrency.configuration = {
    ...otherCurrency.configuration!,
    fundAccessLimitGroups: otherCurrency.configuration!.fundAccessLimitGroups.map((group, index) => index === 0
      ? { ...group, surplusAllowances: [...group.surplusAllowances, { amount: 1n, currency: 2 }] }
      : group),
  }
  assert.throws(() => buildFundAssetAllowanceChange(configure([otherCurrency])))
  const otherToken = snapshot(8453, amount)
  otherToken.configuration = {
    ...otherToken.configuration!,
    fundAccessLimitGroups: [...otherToken.configuration!.fundAccessLimitGroups, {
      terminal: context().terminal, token: NATIVE_TOKEN, payoutLimits: [],
      surplusAllowances: [{ amount: 1n, currency: tokenCurrencyId(NATIVE_TOKEN) }],
    }],
  }
  assert.throws(() => buildFundAssetAllowanceChange(configure([otherToken])))
})

test('an explicitly selected zero budget revokes the prior allowance without replenishing it', () => {
  const current = snapshot(8453, amount)
  const result = buildFundAssetAllowanceChange({ ...configure([current]), allowances: [{ ...context(), amount: 0n }] })
  assert.equal(result.configurations[0].fundAccessLimitGroups.flatMap(group => group.surplusAllowances).reduce((total, cap) => total + cap.amount, 0n), 0n)
  assert.equal(current.configuration!.fundAccessLimitGroups[0].surplusAllowances[0].amount, amount)
})

test('existing nonzero payouts fail even when the allowance context is selected for replacement', () => {
  const current = snapshot(8453, amount)
  current.configuration!.fundAccessLimitGroups[0].payoutLimits = [{ amount: 1n, currency: context().currency }]
  assert.throws(() => buildFundAssetAllowanceChange(configure([current])))
})

test('generic ruleset changes cannot silently renew allowances while failure and sale clear them', () => {
  const current = snapshot(8453, amount)
  for (const action of ['pause', 'resume', 'close', 'enable-success-minting', 'finish-success-minting'] as const) {
    assert.throws(() => buildFundRulesetChange({ snapshots: [current], action, mustStartAtOrAfter: 1_800_000_000 }))
  }
  for (const action of ['failure-refunds', 'asset-sale-refunds'] as const) {
    const result = buildFundRulesetChange({ snapshots: [current], action, mustStartAtOrAfter: 1_800_000_000 })
    assert.deepEqual(result.configurations[0].fundAccessLimitGroups, [])
    assert.equal(result.configurations[0].metadata.cashOutTaxRate, 0)
  }
  assert.equal(current.configuration!.fundAccessLimitGroups[0].surplusAllowances[0].amount, amount)
})

function linkedSnapshots() {
  return [snapshot(8453), snapshot(10)].map(item => {
    item.linkedChainIds = [8453, 10]
    return item
  })
}

test('linked allowance configuration requires every peer and applies a selected budget to only its chosen chain', () => {
  const snapshots = linkedSnapshots()
  const original = structuredClone(snapshots)
  const result = buildFundAssetAllowanceChange(configure(snapshots))
  assert.equal(result.requests.length, 2)
  result.requests.forEach(request => assert.equal(request.address, v6Address('JBOmnichainDeployer', request.chainId as 8453 | 10)))
  assert.equal(result.configurations[0].fundAccessLimitGroups[0].token, USDC_ADDRESSES[8453])
  assert.deepEqual(result.configurations[0].fundAccessLimitGroups[0].surplusAllowances, [{ amount, currency: context().currency }])
  assert.equal(result.configurations[1].fundAccessLimitGroups.flatMap(group => group.surplusAllowances).reduce((total, cap) => total + cap.amount, 0n), 0n)
  assert.deepEqual(snapshots, original)
  assert.throws(() => buildFundAssetAllowanceChange(configure([snapshots[0]])))
  assert.throws(() => buildFundAssetAllowanceChange({ ...configure(snapshots), mustStartAtOrAfter: 0 }))
  assert.throws(() => buildFundAssetAllowanceChange(configure([snapshots[0], { ...snapshots[1], linkedChainIds: [10] }])))
})

test('linked budgets use each chain’s USDC context and preserve explicit per-chain amounts', () => {
  const allowances = [{ ...context(8453), amount }, { ...context(10), amount: amount / 4n }]
  const result = buildFundAssetAllowanceChange({ ...configure(linkedSnapshots()), allowances })
  result.configurations.forEach((config, index) => {
    assert.deepEqual(config.fundAccessLimitGroups, [{
      terminal: allowances[index].terminal, token: allowances[index].token, payoutLimits: [],
      surplusAllowances: [{ amount: allowances[index].amount, currency: allowances[index].currency }],
    }])
  })
  assert.equal(result.configurations.flatMap(config => config.fundAccessLimitGroups).flatMap(group => group.surplusAllowances).reduce((total, cap) => total + cap.amount, 0n), amount * 5n / 4n)
})

test('linked allowance changes reject other rule mismatches and unselected peer caps rather than replenishing them', () => {
  const mismatch = linkedSnapshots()
  mismatch[1].configuration!.metadata.holdFees = true
  assert.throws(() => buildFundAssetAllowanceChange(configure(mismatch)))
  const existing = linkedSnapshots()
  existing[1].configuration!.fundAccessLimitGroups[0].surplusAllowances = [{ amount: 50n, currency: context(10).currency }]
  assert.throws(() => buildFundAssetAllowanceChange(configure(existing)))
  const selected = buildFundAssetAllowanceChange({ ...configure(existing), allowances: [{ ...context(), amount }, { ...context(10), amount: 10n }] })
  assert.equal(selected.configurations[1].fundAccessLimitGroups[0].surplusAllowances[0].amount, 10n)
})

test('linked allowance configuration verifies and unwraps canonical omnichain hooks before comparing rules', () => {
  const snapshots = linkedSnapshots()
  snapshots.forEach(item => {
    item.configuration!.metadata.dataHook = v6Address('JBOmnichainDeployer', item.chainId as 8453 | 10)
    item.configuration!.metadata.useDataHookForPay = true
    item.configuration!.metadata.useDataHookForCashOut = true
    item.omnichainHooks = { dataHook: zeroAddress, useDataHookForPay: false, useDataHookForCashOut: false, tiered721Hook: zeroAddress }
  })
  const result = buildFundAssetAllowanceChange(configure(snapshots))
  result.configurations.forEach(config => assert.equal(config.metadata.dataHook, zeroAddress))
  assert.throws(() => buildFundAssetAllowanceChange(configure([{ ...snapshots[0], omnichainHooks: undefined }, snapshots[1]])))
})
