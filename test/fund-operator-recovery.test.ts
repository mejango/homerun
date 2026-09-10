import { describe, expect, it, vi } from 'vitest'
import { USDC_ADDRESSES, jbControllerAbi } from '@bananapus/nana-sdk-core'
import { tokenCurrencyId, v6Address, type JBRulesetConfig } from '@bananapus/nana-sdk-core/v6'
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, encodeFunctionData, parseAbi, zeroAddress, zeroHash, type Address, type Hex, type PublicClient, type TransactionReceipt } from 'viem'
import { buildFundAssetAllowanceChange, buildFundRulesetChange, initialFundRuleset, type FundRulesetSnapshot, type FundTransaction } from '../src/lib/fund-contracts'

// Recovery helpers use the real ABI and builders, without booting wallet providers.
vi.mock('@/providers/Providers', () => ({ wagmiConfig: {} }))
vi.mock('@/hooks/useWallet', () => ({ useWallet: vi.fn() }))
vi.mock('@/hooks/useSafeTx', () => ({ useSafeTx: vi.fn(), txPhaseLabel: vi.fn() }))

import {
  deserializeRulesetRecovery,
  serializeRulesetRecovery,
  validateRulesetRecoveryReceipt,
  verifyRulesetRecoveryExecution,
} from '../src/components/FundOperatorActions'

const ACCOUNT = '0x1111111111111111111111111111111111111111' as const
const OTHER_ACCOUNT = '0x2222222222222222222222222222222222222222' as const
const HASH = `0x${'ab'.repeat(32)}` as Hex
const SAFE_HASH = `0x${'cd'.repeat(32)}` as Hex
const ROOT = { chainId: 8453, projectId: 9_007_199_254_740_993n }
const STARTS_AT = 1_900_000_000
type Plan = Parameters<typeof serializeRulesetRecovery>[0]
type Submissions = Parameters<typeof serializeRulesetRecovery>[1]

function plan(): Plan {
  const states = ([8453, 10] as const).map((chainId, index) => {
    const projectId = ROOT.projectId + BigInt(index)
    const rulesetSnapshot: FundRulesetSnapshot = {
      chainId, projectId, blockNumber: 9_007_199_254_740_995n,
      controller: v6Address('JBController', chainId), currentRulesetId: 71n, upcomingRulesetId: 0n,
      configuration: initialFundRuleset(), linkedChainIds: [8453, 10],
    }
    return { chainId, projectId, owner: ACCOUNT, rulesetSnapshot }
  })
  const requests = buildFundRulesetChange({
    snapshots: states.map(state => state.rulesetSnapshot), action: 'pause', mustStartAtOrAfter: STARTS_AT,
  }).requests
  return { states, requests, action: 'pause', startsAt: STARTS_AT, account: ACCOUNT } as Plan
}

function submissions(): Submissions {
  return new Map([
    [8453, { hash: HASH, kind: 'transaction' as const }],
    [10, { hash: SAFE_HASH, kind: 'safe-proposal' as const }],
  ])
}

function envelope() {
  return JSON.parse(serializeRulesetRecovery(plan(), submissions(), ROOT))
}

function recover(raw = envelope()) {
  return deserializeRulesetRecovery(JSON.stringify(raw), ROOT, ACCOUNT)
}

function assetAllowancePlan(amount = 9_007_199_254_740_993n): Plan {
  const result = plan()
  for (const state of result.states) {
    const terminal = v6Address('JBMultiTerminal', state.chainId)
    const token = USDC_ADDRESSES[state.chainId]
    state.rulesetSnapshot.accountingContexts = [{ terminal, token, currency: tokenCurrencyId(token), decimals: 6 }]
    state.rulesetSnapshot.configuration!.metadata.pausePay = true
    state.rulesetSnapshot.configuration!.metadata.cashOutTaxRate = 10_000
  }
  const selected = result.states[0]
  const { terminal, token, currency } = selected.rulesetSnapshot.accountingContexts![0]
  result.action = 'configure-asset-allowance'
  result.allowances = [{ chainId: selected.chainId, terminal, token, currency, amount }]
  result.requests = buildFundAssetAllowanceChange({
    snapshots: result.states.map(state => state.rulesetSnapshot), mustStartAtOrAfter: result.startsAt, allowances: result.allowances,
  }).requests
  return result
}

function queuedConfigurations(request: FundTransaction): readonly JBRulesetConfig[] {
  const decoded = decodeFunctionData({ abi: request.abi, data: encodeFunctionData({ abi: request.abi, functionName: request.functionName, args: request.args }) })
  expect(decoded.functionName).toBe('queueRulesetsOf')
  return decoded.args![1] as readonly JBRulesetConfig[]
}

describe('linked FUND ruleset recovery journal', () => {
  it('roundtrips precise project IDs, snapshot values, requests and submission types', () => {
    const encoded = serializeRulesetRecovery(plan(), submissions(), ROOT)
    expect(encoded).toContain('"$bigint":"9007199254740993"')
    expect(JSON.parse(encoded).plan.requests).toBeUndefined()
    const restored = deserializeRulesetRecovery(encoded, ROOT, ACCOUNT)
    expect(restored.plan).toEqual(plan())
    expect(restored.submissions).toEqual(submissions())
    expect(restored.submissions.get(10)?.kind).toBe('safe-proposal')
  })

  it('retains a submission with an unknown hash alongside the other chain’s recorded proposal', () => {
    const records = new Map(submissions())
    records.set(8453, { kind: 'submission-unknown' })
    const encoded = serializeRulesetRecovery(plan(), records, ROOT)
    expect(JSON.parse(encoded).submissions).toEqual([
      [8453, { kind: 'submission-unknown' }],
      [10, { hash: SAFE_HASH, kind: 'safe-proposal' }],
    ])
    const restored = deserializeRulesetRecovery(encoded, ROOT, ACCOUNT)
    expect(restored.submissions).toEqual(records)
    expect(restored.submissions.has(8453)).toBe(true)
    expect(restored.submissions.get(8453)).toEqual({ kind: 'submission-unknown' })
  })

  it('rejects unknown-submission markers containing a hash or additional state', () => {
    for (const additional of [{ hash: HASH }, { hash: null }, { confirmed: true }, { retry: true }, { phase: 'ready' }]) {
      const raw = envelope()
      raw.submissions[0] = [8453, { kind: 'submission-unknown', ...additional }]
      expect(() => recover(raw)).toThrow()
    }
  })

  it('rebuilds transactions from validated snapshots instead of executing serialized requests', () => {
    const raw = envelope()
    raw.plan.requests = [{
      chainId: 8453, address: OTHER_ACCOUNT, functionName: 'transfer',
      args: [OTHER_ACCOUNT, { $bigint: '999999999999999999999' }], value: { $bigint: '999999999999999999999' },
    }]
    expect(recover(raw).plan.requests).toEqual(plan().requests)
  })

  it('rejects another project or wallet before resuming the saved plan', () => {
    const encoded = serializeRulesetRecovery(plan(), submissions(), ROOT)
    for (const root of [{ ...ROOT, chainId: 1 }, { ...ROOT, projectId: ROOT.projectId + 1n }]) {
      expect(() => deserializeRulesetRecovery(encoded, root, ACCOUNT)).toThrow()
    }
    expect(() => deserializeRulesetRecovery(encoded, ROOT, OTHER_ACCOUNT)).toThrow()
    expect(() => deserializeRulesetRecovery(encoded, ROOT, zeroAddress)).toThrow()
  })

  it('requires the root project to belong to the recovered plan', () => {
    const raw = envelope()
    raw.root.projectId = { $bigint: '42' }
    expect(() => deserializeRulesetRecovery(JSON.stringify(raw), { ...ROOT, projectId: 42n }, ACCOUNT)).toThrow()
  })

  it('rejects unknown versions, malformed JSON and unsupported actions', () => {
    for (const encoded of ['', '{', 'null', '[]']) {
      expect(() => deserializeRulesetRecovery(encoded, ROOT, ACCOUNT)).toThrow()
    }
    for (const version of [0, 2, '1', null]) {
      const raw = envelope(); raw.version = version
      expect(() => recover(raw)).toThrow()
    }
    for (const action of ['mint', 'transfer', '__proto__', '', null]) {
      const raw = envelope(); raw.plan.action = action
      expect(() => recover(raw)).toThrow()
    }
  })

  it('bounds the payload size and number of chain records', () => {
    const raw = envelope(); raw.padding = 'x'.repeat(256 * 1024)
    expect(() => recover(raw)).toThrow()
    const tooMany = envelope()
    tooMany.plan.states = Array.from({ length: 9 }, (_, index) => ({ ...tooMany.plan.states[0], chainId: index + 1 }))
    expect(() => recover(tooMany)).toThrow()
  })

  it('rejects empty plans, duplicate chains and inconsistent snapshot identities', () => {
    const variants = [
      (raw: ReturnType<typeof envelope>) => { raw.plan.states = [] },
      (raw: ReturnType<typeof envelope>) => { raw.plan.states.push(raw.plan.states[0]) },
      (raw: ReturnType<typeof envelope>) => { raw.plan.states[0].rulesetSnapshot.projectId = { $bigint: '17' } },
      (raw: ReturnType<typeof envelope>) => { raw.plan.states[0].rulesetSnapshot.chainId = 10 },
      (raw: ReturnType<typeof envelope>) => { raw.plan.states[0].owner = zeroAddress },
      (raw: ReturnType<typeof envelope>) => { raw.plan.states[0].owner = 'not-an-address' },
    ]
    for (const change of variants) {
      const raw = envelope(); change(raw)
      expect(() => recover(raw)).toThrow()
    }
  })

  it('rejects unsupported, incomplete or already superseded contract snapshots', () => {
    const variants = [
      (snapshot: ReturnType<typeof envelope>) => { snapshot.controller = OTHER_ACCOUNT },
      (snapshot: ReturnType<typeof envelope>) => { snapshot.configuration = null },
      (snapshot: ReturnType<typeof envelope>) => { snapshot.upcomingRulesetId = { $bigint: '72' } },
      (snapshot: ReturnType<typeof envelope>) => { snapshot.configuration.metadata.dataHook = OTHER_ACCOUNT },
      (snapshot: ReturnType<typeof envelope>) => { delete snapshot.configuration.metadata.pausePay },
    ]
    for (const change of variants) {
      const raw = envelope(); change(raw.plan.states[0].rulesetSnapshot)
      expect(() => recover(raw)).toThrow()
    }
  })

  it('rejects malformed bigint tags and invalid schedule values', () => {
    for (const value of ['-1', '1n', '1e3', '1.2', '', 1, null]) {
      const raw = envelope(); raw.plan.states[0].projectId = { $bigint: value }
      expect(() => recover(raw)).toThrow()
    }
    for (const startsAt of [-1, 1.5, 2 ** 48, '1900000000', null]) {
      const raw = envelope(); raw.plan.startsAt = startsAt
      expect(() => recover(raw)).toThrow()
    }
  })

  it('rejects ambiguous or invalid submitted transaction records', () => {
    const variants = [
      [[8453, { hash: HASH, kind: 'transaction' }], [8453, { hash: SAFE_HASH, kind: 'safe-proposal' }]],
      [[1, { hash: HASH, kind: 'transaction' }]],
      [[8453, { hash: '0x1234', kind: 'transaction' }]],
      [[8453, { hash: HASH, kind: 'confirmed' }]],
      [[8453, { hash: HASH }]],
      [['8453', { hash: HASH, kind: 'transaction' }]],
    ]
    for (const invalid of variants) {
      const raw = envelope(); raw.submissions = invalid
      expect(() => recover(raw)).toThrow()
    }
  })
})

describe('asset allowance plan recovery', () => {
  it('preserves the explicit chain budget and rebuilds it only on the selected peer', () => {
    const original = assetAllowancePlan()
    const raw = JSON.parse(serializeRulesetRecovery(original, submissions(), ROOT))
    expect(raw.plan.allowances[0].amount).toEqual({ $bigint: '9007199254740993' })
    // Imported calldata is never authority for either the amount or its chain.
    raw.plan.requests = [{ ...raw.plan.allowances[0], address: OTHER_ACCOUNT, functionName: 'transfer', args: [] }]
    const restored = recover(raw)
    expect(restored.plan.allowances).toEqual(original.allowances)
    expect(restored.plan.requests).toEqual(original.requests)
    expect(restored.submissions).toEqual(submissions())
    const selected = queuedConfigurations(restored.plan.requests[0])[0]
    const peer = queuedConfigurations(restored.plan.requests[1])[0]
    expect(selected.fundAccessLimitGroups).toHaveLength(1)
    expect(selected.fundAccessLimitGroups[0].surplusAllowances).toEqual([{ amount: original.allowances![0].amount, currency: original.allowances![0].currency }])
    expect(peer.fundAccessLimitGroups).toEqual([])
    expect(selected.metadata.allowOwnerMinting).toBe(false)
    expect(peer.metadata).toEqual(selected.metadata)
  })

  it('retains an explicit zero amount as revocation rather than recreating a budget', () => {
    const original = assetAllowancePlan(0n)
    const selected = original.states[0]
    const allowance = original.allowances![0]
    selected.rulesetSnapshot.configuration!.fundAccessLimitGroups = [{
      terminal: allowance.terminal, token: allowance.token, payoutLimits: [],
      surplusAllowances: [{ currency: allowance.currency, amount: 500_000_000_000n }],
    }]
    const restored = deserializeRulesetRecovery(serializeRulesetRecovery(original, submissions(), ROOT), ROOT, ACCOUNT)
    expect(restored.plan.allowances).toEqual(original.allowances)
    expect(restored.plan.allowances![0].amount).toBe(0n)
    for (const request of restored.plan.requests) expect(queuedConfigurations(request)[0].fundAccessLimitGroups).toEqual([])
  })

  it('rejects forged budget intent, unsupported contexts and allowance fields on lifecycle plans', () => {
    const encoded = serializeRulesetRecovery(assetAllowancePlan(), submissions(), ROOT)
    const changes = [
      (raw: ReturnType<typeof envelope>) => { raw.plan.allowances[0].terminal = OTHER_ACCOUNT },
      (raw: ReturnType<typeof envelope>) => { raw.plan.allowances[0].token = USDC_ADDRESSES[10] },
      (raw: ReturnType<typeof envelope>) => { raw.plan.allowances[0].currency = 2 },
      (raw: ReturnType<typeof envelope>) => { raw.plan.allowances[0].amount = { $bigint: ((1n << 224n) - 1n).toString() } },
      (raw: ReturnType<typeof envelope>) => { raw.plan.allowances[0].amount = '500000000000' },
      (raw: ReturnType<typeof envelope>) => { raw.plan.allowances[0].chainId = 1 },
      (raw: ReturnType<typeof envelope>) => { raw.plan.allowances.push(raw.plan.allowances[0]) },
      (raw: ReturnType<typeof envelope>) => { raw.plan.states[0].rulesetSnapshot.accountingContexts = [] },
      (raw: ReturnType<typeof envelope>) => { raw.plan.states[0].rulesetSnapshot.configuration.metadata.pausePay = false },
      (raw: ReturnType<typeof envelope>) => { raw.plan.action = 'pause' },
    ]
    for (const change of changes) {
      const raw = JSON.parse(encoded); change(raw)
      expect(() => recover(raw)).toThrow()
    }
  })
})

function queueLog({ controller = v6Address('JBController', 8453), projectId = ROOT.projectId, rulesetId = 72n, memo = 'Homerun: pause' }: {
  controller?: Address; projectId?: bigint; rulesetId?: bigint; memo?: string
} = {}): TransactionReceipt['logs'][number] {
  return {
    address: controller,
    topics: encodeEventTopics({ abi: jbControllerAbi, eventName: 'QueueRulesets' }),
    data: encodeAbiParameters([
      { type: 'uint256' }, { type: 'uint256' }, { type: 'string' }, { type: 'address' },
    ], [rulesetId, projectId, memo, ACCOUNT]),
    blockHash: zeroHash, blockNumber: 100n, transactionHash: HASH, transactionIndex: 0, logIndex: 0, removed: false,
  }
}

function receipt(logs: TransactionReceipt['logs'] = [queueLog()], status: TransactionReceipt['status'] = 'success'): TransactionReceipt {
  return { logs, status, transactionHash: HASH, blockNumber: 100n, blockHash: zeroHash } as TransactionReceipt
}

function verified(value: TransactionReceipt) {
  return validateRulesetRecoveryReceipt(value, ROOT.projectId, v6Address('JBController', 8453), 'Homerun: pause')
}

describe('recovered FUND ruleset receipts', () => {
  it('requires one exact controller, project and action event after successful execution', () => {
    expect(verified(receipt())).toBe(72n)
    expect(verified(receipt([
      queueLog({ projectId: 99n }), queueLog({ controller: OTHER_ACCOUNT }),
      queueLog({ memo: 'Homerun: close' }), queueLog(),
    ]))).toBe(72n)
  })

  it('does not accept reverted receipts, missing events or zero ruleset IDs', () => {
    expect(() => verified(receipt([queueLog()], 'reverted'))).toThrow()
    expect(() => verified(receipt([]))).toThrow()
    expect(() => verified(receipt([queueLog({ rulesetId: 0n })]))).toThrow()
  })

  it('does not confuse unrelated contracts, projects or memos with this action', () => {
    for (const log of [
      queueLog({ controller: OTHER_ACCOUNT }), queueLog({ projectId: 42n }),
      queueLog({ memo: 'Homerun: resume' }), queueLog({ memo: 'homerun: pause' }), queueLog({ memo: 'Homerun: pause ' }),
    ]) expect(() => verified(receipt([log]))).toThrow()
  })

  it('rejects ambiguous multiple matching events even if they repeat the same ruleset ID', () => {
    expect(() => verified(receipt([queueLog(), queueLog()]))).toThrow()
    expect(() => verified(receipt([queueLog(), queueLog({ rulesetId: 73n })]))).toThrow()
  })

  it('ignores malformed and unrelated logs without losing the valid queue event', () => {
    const malformed = { ...queueLog(), data: '0x12' as Hex }
    expect(verified(receipt([malformed, queueLog()]))).toBe(72n)
    expect(() => verified(receipt([malformed]))).toThrow()
  })
})

const safeAbi = parseAbi(['function execTransaction(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,bytes signatures) returns (bool success)'])

function executionFixture() {
  const request = plan().requests[0]
  const input = encodeFunctionData({ abi: request.abi, functionName: request.functionName, args: request.args })
  const transaction = { to: request.address, from: ACCOUNT, input, value: request.value ?? 0n, blockHash: zeroHash }
  const getTransaction = vi.fn(async () => transaction)
  const getBlock = vi.fn(async () => ({ hash: zeroHash as Hex }))
  const client = { getTransaction, getBlock } as unknown as PublicClient
  return { request, input, transaction, client, getTransaction, getBlock }
}

describe('recovered transaction intent verification', () => {
  it('accepts the exact direct transaction after checking its canonical block', async () => {
    const fixture = executionFixture()
    await expect(verifyRulesetRecoveryExecution(fixture.client, fixture.request, ACCOUNT, receipt())).resolves.toBeUndefined()
    expect(fixture.getTransaction).toHaveBeenCalledWith({ hash: HASH })
    expect(fixture.getBlock).toHaveBeenCalledWith({ blockNumber: 100n })
  })

  it('rejects changed sender, destination, value or calldata even with a valid ruleset event', async () => {
    const changes = [
      { from: OTHER_ACCOUNT }, { to: OTHER_ACCOUNT }, { value: 1n }, { input: '0x1234' as Hex },
    ]
    for (const change of changes) {
      const fixture = executionFixture()
      fixture.getTransaction.mockResolvedValue({ ...fixture.transaction, ...change })
      await expect(verifyRulesetRecoveryExecution(fixture.client, fixture.request, ACCOUNT, receipt())).rejects.toThrow()
    }
  })

  it('rejects receipts detached from the transaction or canonical block after a reorg', async () => {
    for (const changed of ['transaction', 'block'] as const) {
      const fixture = executionFixture()
      if (changed === 'transaction') fixture.getTransaction.mockResolvedValue({ ...fixture.transaction, blockHash: HASH })
      else fixture.getBlock.mockResolvedValue({ hash: HASH })
      await expect(verifyRulesetRecoveryExecution(fixture.client, fixture.request, ACCOUNT, receipt())).rejects.toThrow()
    }
  })

  it('accepts only a Safe CALL to the exact reviewed target, value and calldata', async () => {
    const fixture = executionFixture()
    const variants = [
      { target: fixture.request.address, value: fixture.request.value ?? 0n, data: fixture.input, operation: 0, valid: true },
      { target: fixture.request.address, value: fixture.request.value ?? 0n, data: fixture.input, operation: 1, valid: false },
      { target: OTHER_ACCOUNT, value: 0n, data: fixture.input, operation: 0, valid: false },
      { target: fixture.request.address, value: 1n, data: fixture.input, operation: 0, valid: false },
      { target: fixture.request.address, value: 0n, data: '0x1234' as Hex, operation: 0, valid: false },
    ]
    for (const variant of variants) {
      const input = encodeFunctionData({
        abi: safeAbi, functionName: 'execTransaction',
        args: [variant.target, variant.value, variant.data, variant.operation, 0n, 0n, 0n, zeroAddress, zeroAddress, '0x'],
      })
      fixture.getTransaction.mockResolvedValue({ ...fixture.transaction, from: OTHER_ACCOUNT, to: ACCOUNT, input })
      const result = verifyRulesetRecoveryExecution(fixture.client, fixture.request, ACCOUNT, receipt())
      if (variant.valid) await expect(result).resolves.toBeUndefined()
      else await expect(result).rejects.toThrow()
    }
  })
})
