import { jbControllerAbi, jbSplitsAbi } from '@bananapus/nana-sdk-core'
import { RESERVED_TOKEN_SPLIT_GROUP_ID, v6Address } from '@bananapus/nana-sdk-core/v6'
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, encodeFunctionData, getAbiItem, parseAbi, zeroAddress, type AbiEvent, type Address, type Hex, type PublicClient, type TransactionReceipt } from 'viem'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { IncomeProjectState } from '../src/lib/income-state'

const runtime = vi.hoisted(() => ({ readState: vi.fn() }))
vi.mock('../src/lib/income-state', () => ({ readIncomeProjectState: runtime.readState }))
import { assertSameIncomeOperatorSnapshot, buildIncomeOperatorTx, readIncomeOperatorSnapshot, verifyIncomeOperatorReceipt, type IncomeOperatorSnapshot } from '../src/lib/income-operator'

const OWNER = '0x1111111111111111111111111111111111111111' as Address
const OPERATOR = '0x2222222222222222222222222222222222222222' as Address
const RECIPIENT = '0x3333333333333333333333333333333333333333' as Address
const HOOK = '0x4444444444444444444444444444444444444444' as Address
const HASH = `0x${'aa'.repeat(32)}` as Hex
const TX_HASH = `0x${'bb'.repeat(32)}` as Hex
const OTHER_HASH = `0x${'cc'.repeat(32)}` as Hex
const safeAbi = parseAbi([
  'function execTransaction(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,bytes signatures) returns (bool success)',
  'event ExecutionSuccess(bytes32 txHash,uint256 payment)',
])

function snapshot(): IncomeOperatorSnapshot {
  return {
    chainId: 1, projectId: 7n, blockNumber: 100n, blockHash: HASH, blockTimestamp: 1000n,
    controller: v6Address('JBController', 1), owner: v6Address('REVOwner', 1), account: OWNER, isOwner: true, currentRulesetId: 90n,
    stages: [90n, 100n, 110n].map((rulesetId, index) => ({
      rulesetId, start: index === 0 ? 900n : 1000n + BigInt(index * 100), isCurrent: index === 0, operatorIndex: 1,
      splits: [
        { percent: 650_000_000, projectId: 0n, beneficiary: OPERATOR, hook: HOOK, lockedUntil: 0, preferAddToBalance: false },
        { percent: 300_000_000, projectId: 0n, beneficiary: OPERATOR, hook: zeroAddress, lockedUntil: 0, preferAddToBalance: false },
        { percent: 50_000_000, projectId: 9n, beneficiary: OPERATOR, hook: zeroAddress, lockedUntil: 0, preferAddToBalance: true },
      ],
    })),
  }
}
function ruleset(id: number, start: number, basedOnId: number) {
  return { id, start, basedOnId, cycleNumber: 1, duration: 0, weight: 1n, weightCutPercent: 0, approvalHook: zeroAddress, metadata: 0n }
}
function state(): IncomeProjectState {
  const s = snapshot()
  return { ...s, ruleset: ruleset(90, 900, 0), isOperator: true } as unknown as IncomeProjectState
}
function fixture() {
  const reviewed = snapshot()
  const metadata = { dataHook: reviewed.owner, useDataHookForPay: true, useDataHookForCashOut: true }
  const readContract = vi.fn(async ({ functionName, args }: { functionName: string; args?: readonly unknown[]; blockNumber?: bigint }) => {
    if (functionName === 'latestQueuedRulesetOf') return [ruleset(110, 1200, 100), metadata, 0]
    if (functionName === 'getRulesetOf') return [args?.[1] === 100n ? ruleset(100, 1100, 90) : ruleset(90, 900, 0), metadata]
    if (functionName === 'splitsOf') return reviewed.stages.find(stage => stage.rulesetId === args?.[1])!.splits
    throw new Error(`Unexpected read: ${functionName}`)
  })
  const client = { getChainId: vi.fn(async () => 1), getBlock: vi.fn(async () => ({ hash: HASH })), readContract }
  return { reviewed, client, rpc: client as unknown as PublicClient }
}
function log(name: string, values: Record<string, unknown>, address = v6Address('JBSplits', 1), abi = jbSplitsAbi as readonly unknown[]) {
  const event = getAbiItem({ abi: abi as readonly AbiEvent[], name }) as AbiEvent
  return { address, data: encodeAbiParameters(event.inputs.filter(input => !input.indexed), event.inputs.filter(input => !input.indexed).map(input => values[input.name!])), topics: encodeEventTopics({ abi: [event], eventName: name, args: values }) } as unknown as TransactionReceipt['logs'][number]
}
function receiptFixture(rulesetId = 90n) {
  const f = fixture()
  const request = buildIncomeOperatorTx(f.reviewed, rulesetId, RECIPIENT)
  const stage = f.reviewed.stages.find(stage => stage.rulesetId === rulesetId)!
  const logs = stage.splits.map((split, index) => log('SetSplit', { projectId: 7n, rulesetId, groupId: RESERVED_TOKEN_SPLIT_GROUP_ID, split: index === stage.operatorIndex ? { ...split, beneficiary: RECIPIENT } : split, caller: f.reviewed.controller }))
  const receipt = { transactionHash: TX_HASH, blockNumber: 101n, blockHash: HASH, status: 'success', logs } as TransactionReceipt
  const transaction = { hash: TX_HASH, blockNumber: 101n, blockHash: HASH, from: OWNER, to: request.address, value: 0n, input: encodeFunctionData(request) }
  const client = { ...f.client, getTransaction: vi.fn(async () => transaction) }
  return { ...f, receipt, transaction, client, rpc: client as unknown as PublicClient }
}

beforeEach(() => { runtime.readState.mockReset(); runtime.readState.mockResolvedValue(state()) })

describe('INCOME Operator split preparation', () => {
  it('changes only the direct recipient while preserving all routing, percentages, locks and ordering', () => {
    const reviewed = snapshot()
    reviewed.stages[1].splits = reviewed.stages[1].splits.map((split, index) => index === 0 ? { ...split, lockedUntil: 2000 } : split)
    const before = structuredClone(reviewed)
    const request = buildIncomeOperatorTx(reviewed, 100n, RECIPIENT)
    const expectedSplits = reviewed.stages[1].splits.map((split, index) => index === 1 ? { ...split, beneficiary: RECIPIENT } : split)
    expect(request.address).toBe(reviewed.controller)
    expect(request.chainId).toBe(1)
    expect(decodeFunctionData({ abi: jbControllerAbi, data: encodeFunctionData(request) })).toEqual({ functionName: 'setSplitGroupsOf', args: [7n, 100n, [{ groupId: RESERVED_TOKEN_SPLIT_GROUP_ID, splits: expectedSplits }]] })
    expect(request).not.toHaveProperty('value')
    expect(reviewed).toEqual(before)
  })
  it.each(['', 'operator.eth', '0x1234', zeroAddress])('rejects an invalid or zero recipient %s', recipient => {
    expect(() => buildIncomeOperatorTx(snapshot(), 90n, recipient)).toThrow()
  })
  it('requires a connected Owner and a real change to a known editable stage', () => {
    expect(() => buildIncomeOperatorTx({ ...snapshot(), isOwner: false }, 90n, RECIPIENT)).toThrow()
    expect(() => buildIncomeOperatorTx({ ...snapshot(), account: null }, 90n, RECIPIENT)).toThrow()
    expect(() => buildIncomeOperatorTx(snapshot(), 90n, OPERATOR)).toThrow()
    expect(() => buildIncomeOperatorTx(snapshot(), 999n, RECIPIENT)).toThrow()
    const locked = snapshot(); locked.stages[0].splits[1] = { ...locked.stages[0].splits[1], lockedUntil: 1001 }
    expect(() => buildIncomeOperatorTx(locked, 90n, RECIPIENT)).toThrow()
    locked.stages[0].splits[1] = { ...locked.stages[0].splits[1], lockedUntil: 1000 }
    expect(() => buildIncomeOperatorTx(locked, 90n, RECIPIENT)).not.toThrow()
    const ambiguous = snapshot(); ambiguous.stages[0].operatorIndex = null
    expect(() => buildIncomeOperatorTx(ambiguous, 90n, RECIPIENT)).toThrow()
  })
  it('reads current and every future stage at one canonical block, including stages beyond next', async () => {
    const f = fixture()
    await expect(readIncomeOperatorSnapshot(f.rpc, { chainId: 1, projectId: 7n, account: OWNER })).resolves.toEqual(f.reviewed)
    expect(runtime.readState).toHaveBeenCalledWith(f.rpc, { chainId: 1, projectId: 7n, account: OWNER })
    expect(f.client.readContract).toHaveBeenCalledWith(expect.objectContaining({ address: f.reviewed.controller, functionName: 'latestQueuedRulesetOf', args: [7n], blockNumber: 100n }))
    for (const rulesetId of [90n, 100n, 110n]) expect(f.client.readContract).toHaveBeenCalledWith(expect.objectContaining({ address: v6Address('JBSplits', 1), functionName: 'splitsOf', args: [7n, rulesetId, RESERVED_TOKEN_SPLIT_GROUP_ID], blockNumber: 100n }))
    expect(f.client.readContract.mock.calls.every(([call]) => 'blockNumber' in call && call.blockNumber === 100n)).toBe(true)
  })
  it('keeps the Operator recipient distinct from the connected Owner authority', async () => {
    const f = fixture(); runtime.readState.mockResolvedValue({ ...state(), account: OPERATOR, isOperator: false })
    const result = await readIncomeOperatorSnapshot(f.rpc, { chainId: 1, projectId: 7n, account: OPERATOR })
    expect(result.isOwner).toBe(false)
    expect(result.stages[0].splits[result.stages[0].operatorIndex!].beneficiary).toBe(OPERATOR)
  })
  it('allows disconnected reads without granting Owner authority', async () => {
    const f = fixture()
    const result = await readIncomeOperatorSnapshot(f.rpc, { chainId: 1, projectId: 7n })
    expect(result.account).toBe(null)
    expect(result.isOwner).toBe(false)
  })
  it('refuses failed canonical project reads and detects reorgs', async () => {
    const f = fixture(); runtime.readState.mockRejectedValueOnce(new Error('foreign controller'))
    await expect(readIncomeOperatorSnapshot(f.rpc, { chainId: 1, projectId: 7n, account: OWNER })).rejects.toThrow('foreign controller')
    expect(f.client.readContract).not.toHaveBeenCalled()
    f.client.getBlock.mockResolvedValueOnce({ hash: OTHER_HASH })
    await expect(readIncomeOperatorSnapshot(f.rpc, { chainId: 1, projectId: 7n, account: OWNER })).rejects.toThrow()
  })
  it('does not guess when no direct recipient or multiple direct recipients exist', async () => {
    const f = fixture()
    for (const stage of f.reviewed.stages) stage.splits[0] = { ...stage.splits[0], hook: zeroAddress }
    await expect(readIncomeOperatorSnapshot(f.rpc, { chainId: 1, projectId: 7n, account: OWNER })).rejects.toThrow('multiple direct recipients')
    for (const stage of f.reviewed.stages) {
      stage.splits[0] = { ...stage.splits[0], hook: HOOK }
      stage.splits[1] = { ...stage.splits[1], beneficiary: zeroAddress }
    }
    expect((await readIncomeOperatorSnapshot(f.rpc, { chainId: 1, projectId: 7n, account: OWNER })).stages.every(stage => stage.operatorIndex === null)).toBe(true)
  })
  it('rejects invalid percentages before enabling a split edit', async () => {
    const f = fixture()
    for (const percent of [0, -1, 0.5, 1_000_000_001]) {
      f.reviewed.stages[0].splits = [{ ...f.reviewed.stages[0].splits[1], percent }]
      await expect(readIncomeOperatorSnapshot(f.rpc, { chainId: 1, projectId: 7n, account: OWNER })).rejects.toThrow('percentages')
    }
  })
  it('validates revnet metadata on the latest queued stage as well as its ancestors', async () => {
    const f = fixture()
    f.client.readContract.mockResolvedValueOnce([ruleset(110, 1200, 100), { dataHook: HOOK, useDataHookForPay: true, useDataHookForCashOut: true }, 0])
    await expect(readIncomeOperatorSnapshot(f.rpc, { chainId: 1, projectId: 7n, account: OWNER })).rejects.toThrow()
  })
  it('rejects a queued stage that loops back to itself instead of reaching the current ruleset', async () => {
    const f = fixture(), metadata = { dataHook: f.reviewed.owner, useDataHookForPay: true, useDataHookForCashOut: true }
    f.client.readContract.mockResolvedValueOnce([ruleset(110, 1200, 110), metadata, 0])
    f.client.readContract.mockResolvedValueOnce([ruleset(110, 1200, 110), metadata])
    await expect(readIncomeOperatorSnapshot(f.rpc, { chainId: 1, projectId: 7n, account: OWNER })).rejects.toThrow('schedule')
  })
  it.each([
    { chainId: 10 }, { projectId: 8n }, { blockNumber: 99n }, { owner: OPERATOR }, { controller: HOOK }, { account: OPERATOR }, { isOwner: false }, { currentRulesetId: 100n },
  ])('requires renewed review after authority or identity changes %#', change => {
    expect(() => assertSameIncomeOperatorSnapshot(snapshot(), { ...snapshot(), ...change } as IncomeOperatorSnapshot)).toThrow()
  })
  it('allows a newer unchanged snapshot while refusing changed stage schedules', () => {
    expect(() => assertSameIncomeOperatorSnapshot(snapshot(), { ...snapshot(), blockNumber: 101n, blockTimestamp: 1001n })).not.toThrow()
    for (const change of [{ rulesetId: 120n }, { start: 1250n }, { isCurrent: true }, { operatorIndex: null }]) {
      const latest = snapshot(); latest.stages[2] = { ...latest.stages[2], ...change }
      expect(() => assertSameIncomeOperatorSnapshot(snapshot(), latest)).toThrow()
    }
    const latest = snapshot(); latest.stages.pop()
    expect(() => assertSameIncomeOperatorSnapshot(snapshot(), latest)).toThrow()
  })
  it('rejects a different canonical hash at the reviewed block height', () => {
    expect(() => assertSameIncomeOperatorSnapshot(snapshot(), { ...snapshot(), blockHash: OTHER_HASH })).toThrow()
  })
  it.each(['beneficiary', 'hook', 'percent', 'projectId', 'lockedUntil', 'preferAddToBalance'] as const)('requires renewed review when any stage split %s changes', field => {
    const latest = snapshot(), split = { ...latest.stages[2].splits[2] }
    Object.assign(split, { [field]: field === 'percent' || field === 'lockedUntil' ? 123 : field === 'projectId' ? 3n : field === 'preferAddToBalance' ? false : RECIPIENT })
    latest.stages[2].splits[2] = split
    expect(() => assertSameIncomeOperatorSnapshot(snapshot(), latest)).toThrow()
  })
})

describe('INCOME Operator receipt confirmation', () => {
  it.each([90n, 110n])('proves exact EOA calldata and every resulting split for stage %s', async rulesetId => {
    const f = receiptFixture(rulesetId)
    await expect(verifyIncomeOperatorReceipt(f.rpc, f.reviewed, rulesetId, RECIPIENT, OWNER, f.receipt)).resolves.toEqual({ rulesetId, recipient: RECIPIENT })
  })
  it('requires the exact Safe call and an ExecutionSuccess event from that Safe', async () => {
    const f = receiptFixture()
    const innerData = f.transaction.input
    f.transaction.to = OWNER
    f.transaction.from = RECIPIENT
    f.transaction.input = encodeFunctionData({ abi: safeAbi, functionName: 'execTransaction', args: [f.reviewed.controller, 0n, innerData, 0, 0n, 0n, 0n, zeroAddress, zeroAddress, '0x'] })
    await expect(verifyIncomeOperatorReceipt(f.rpc, f.reviewed, 90n, RECIPIENT, OWNER, f.receipt)).rejects.toThrow()
    f.receipt.logs.push(log('ExecutionSuccess', { txHash: TX_HASH, payment: 0n }, OWNER, safeAbi))
    await expect(verifyIncomeOperatorReceipt(f.rpc, f.reviewed, 90n, RECIPIENT, OWNER, f.receipt)).resolves.toEqual({ rulesetId: 90n, recipient: RECIPIENT })
    f.transaction.input = encodeFunctionData({ abi: safeAbi, functionName: 'execTransaction', args: [f.reviewed.controller, 0n, innerData, 1, 0n, 0n, 0n, zeroAddress, zeroAddress, '0x'] })
    await expect(verifyIncomeOperatorReceipt(f.rpc, f.reviewed, 90n, RECIPIENT, OWNER, f.receipt)).rejects.toThrow()
  })
  it('refuses a receipt submitted as a different account than the reviewed Owner', async () => {
    const f = receiptFixture(); f.transaction.from = OPERATOR
    await expect(verifyIncomeOperatorReceipt(f.rpc, f.reviewed, 90n, RECIPIENT, OPERATOR, f.receipt)).rejects.toThrow()
  })
  it.each(['from', 'to', 'input', 'value', 'hash', 'blockNumber', 'blockHash'])('rejects a different mined %s', field => {
    const f = receiptFixture()
    Object.assign(f.transaction, { [field]: field === 'blockNumber' ? 90n : field === 'value' ? 1n : field === 'input' ? '0x' : field === 'hash' || field === 'blockHash' ? OTHER_HASH : HOOK })
    return expect(verifyIncomeOperatorReceipt(f.rpc, f.reviewed, 90n, RECIPIENT, OWNER, f.receipt)).rejects.toThrow()
  })
  it('rejects reverted, historical, wrong-chain and reorged receipts', async () => {
    const f = receiptFixture()
    await expect(verifyIncomeOperatorReceipt(f.rpc, f.reviewed, 90n, RECIPIENT, OWNER, { ...f.receipt, status: 'reverted' })).rejects.toThrow()
    await expect(verifyIncomeOperatorReceipt(f.rpc, f.reviewed, 90n, RECIPIENT, OWNER, { ...f.receipt, blockNumber: 100n })).rejects.toThrow()
    f.client.getChainId.mockResolvedValueOnce(10)
    await expect(verifyIncomeOperatorReceipt(f.rpc, f.reviewed, 90n, RECIPIENT, OWNER, f.receipt)).rejects.toThrow()
    f.client.getBlock.mockResolvedValueOnce({ hash: OTHER_HASH })
    await expect(verifyIncomeOperatorReceipt(f.rpc, f.reviewed, 90n, RECIPIENT, OWNER, f.receipt)).rejects.toThrow()
  })
  it('requires every unchanged split as well as the new Operator event exactly once and in order', async () => {
    const f = receiptFixture()
    for (const logs of [f.receipt.logs.slice(1), [...f.receipt.logs, f.receipt.logs[0]], [...f.receipt.logs].reverse()]) {
      await expect(verifyIncomeOperatorReceipt(f.rpc, f.reviewed, 90n, RECIPIENT, OWNER, { ...f.receipt, logs })).rejects.toThrow()
    }
  })
  it.each([
    { projectId: 8n }, { rulesetId: 100n }, { groupId: 2n }, { caller: OWNER },
    { split: { ...snapshot().stages[0].splits[0], beneficiary: RECIPIENT } },
  ])('rejects events for a different project, group, authority or preserved split %#', async change => {
    const f = receiptFixture()
    f.receipt.logs[0] = log('SetSplit', { projectId: 7n, rulesetId: 90n, groupId: RESERVED_TOKEN_SPLIT_GROUP_ID, split: f.reviewed.stages[0].splits[0], caller: f.reviewed.controller, ...change })
    await expect(verifyIncomeOperatorReceipt(f.rpc, f.reviewed, 90n, RECIPIENT, OWNER, f.receipt)).rejects.toThrow()
  })
})
