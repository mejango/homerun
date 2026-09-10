import { jbControllerAbi } from '@bananapus/nana-sdk-core'
import { v6Address } from '@bananapus/nana-sdk-core/v6'
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, encodeFunctionData, getAbiItem, parseAbi, zeroAddress, type AbiEvent, type Address, type Hex, type PublicClient, type TransactionReceipt } from 'viem'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { IncomeProjectState } from '../src/lib/income-state'
const runtime = vi.hoisted(() => ({ readState: vi.fn() }))
vi.mock('../src/lib/income-state', () => ({ readIncomeProjectState: runtime.readState }))
import { assertIncomeReservedProject, assertSameIncomeReservedTokens, buildSendIncomeReservedTokensTx, readIncomeReservedTokens, verifyIncomeReservedReceipt, type IncomeReservedSnapshot } from '../src/lib/income-reserved'

const ACCOUNT = '0x1111111111111111111111111111111111111111' as Address
const TOKEN = '0x2222222222222222222222222222222222222222' as Address
const HOOK = '0x3333333333333333333333333333333333333333' as Address
const HASH = `0x${'aa'.repeat(32)}` as Hex
const TX_HASH = `0x${'bb'.repeat(32)}` as Hex
const safeAbi = parseAbi(['function execTransaction(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,bytes signatures) returns (bool success)', 'event ExecutionSuccess(bytes32 txHash,uint256 payment)'])
function snapshot(): IncomeReservedSnapshot {
  return { chainId: 1, projectId: 7n, blockNumber: 100n, blockHash: HASH, controller: v6Address('JBController', 1), owner: v6Address('REVOwner', 1), tokenAddress: TOKEN, rulesetId: 90n, pending: 1000n, splits: [
    { percent: 700_000_000, projectId: 0n, beneficiary: ACCOUNT, hook: zeroAddress, lockedUntil: 100, preferAddToBalance: false },
    { percent: 200_000_000, projectId: 0n, beneficiary: TOKEN, hook: HOOK, lockedUntil: 100, preferAddToBalance: false },
  ] }
}
function state(): IncomeProjectState { const s = snapshot(); return { ...s, ruleset: { id: Number(s.rulesetId) }, pendingReservedTokens: s.pending, isOperator: false, totalBalance: 0n } as unknown as IncomeProjectState }
function log(name: string, values: Record<string, unknown>, address = snapshot().controller, abi = jbControllerAbi as readonly unknown[]) {
  const event = getAbiItem({ abi: abi as readonly AbiEvent[], name }) as AbiEvent
  return { address, data: encodeAbiParameters(event.inputs.filter(input => !input.indexed), event.inputs.filter(input => !input.indexed).map(input => values[input.name!])), topics: encodeEventTopics({ abi: [event], eventName: name, args: values }) } as unknown as TransactionReceipt['logs'][number]
}
function fixture(amount = 1000n) {
  const reviewed = snapshot()
  const request = buildSendIncomeReservedTokensTx(1, reviewed.projectId)
  const splits = reviewed.splits.map(split => log('SendReservedTokensToSplit', { projectId: 7n, rulesetId: 90n, groupId: 1n, split, tokenCount: amount * BigInt(split.percent) / 1_000_000_000n, caller: ACCOUNT }))
  const receipt = { transactionHash: TX_HASH, blockNumber: 101n, blockHash: HASH, status: 'success', logs: [...splits, log('SendReservedTokensToSplits', { projectId: 7n, rulesetId: 90n, rulesetCycleNumber: 1n, owner: reviewed.owner, tokenCount: amount, leftoverAmount: amount - amount * 7n / 10n - amount * 2n / 10n, caller: ACCOUNT })] } as TransactionReceipt
  const transaction = { hash: TX_HASH, blockNumber: 101n, blockHash: HASH, from: ACCOUNT, to: request.address, value: 0n, input: encodeFunctionData(request) }
  const client = { getChainId: vi.fn(async () => 1), getBlock: vi.fn(async () => ({ hash: HASH })), getTransaction: vi.fn(async () => transaction), readContract: vi.fn(async () => reviewed.splits) }
  return { reviewed, receipt, transaction, client, rpc: client as unknown as PublicClient }
}
beforeEach(() => { runtime.readState.mockReset(); runtime.readState.mockResolvedValue(state()) })
describe('reserved INCOME preparation', () => {
  it('builds only the SDK controller call, without allowance, amounts or owner privileges', () => {
    const request = buildSendIncomeReservedTokensTx(1, 7n)
    expect(request.address).toBe(v6Address('JBController', 1))
    expect(decodeFunctionData({ abi: jbControllerAbi, data: encodeFunctionData(request) })).toEqual({ functionName: 'sendReservedTokensToSplitsOf', args: [7n] })
    expect(request).not.toHaveProperty('value')
    expect(() => buildSendIncomeReservedTokensTx(1, 0n)).toThrow('positive')
  })
  it('reads current recipients at the canonical project snapshot even for a non-holder', async () => {
    const f = fixture()
    expect(await readIncomeReservedTokens(f.rpc, { chainId: 1, projectId: 7n })).toEqual(f.reviewed)
    expect(f.client.readContract).toHaveBeenCalledWith(expect.objectContaining({ address: v6Address('JBSplits', 1), functionName: 'splitsOf', args: [7n, 90n, 1n], blockNumber: 100n }))
  })
  it('rejects failed canonical project reads before reading splits', async () => {
    const f = fixture(); runtime.readState.mockRejectedValue(new Error('foreign controller'))
    await expect(readIncomeReservedTokens(f.rpc, { chainId: 1, projectId: 7n })).rejects.toThrow('foreign controller')
    expect(f.client.readContract).not.toHaveBeenCalled()
  })
  it('rejects a reorg or oversubscribed split group', async () => {
    const f = fixture(); f.client.getBlock.mockResolvedValueOnce({ hash: TX_HASH })
    await expect(readIncomeReservedTokens(f.rpc, { chainId: 1, projectId: 7n })).rejects.toThrow('chain changed')
    f.client.readContract.mockResolvedValueOnce([{ ...f.reviewed.splits[0], percent: 1_000_000_001 }])
    await expect(readIncomeReservedTokens(f.rpc, { chainId: 1, projectId: 7n })).rejects.toThrow('inconsistent')
  })
  it.each([
    { pending: 999n }, { pending: 0n }, { rulesetId: 91n }, { blockNumber: 99n }, { controller: TOKEN }, { tokenAddress: HOOK }, { owner: ACCOUNT }, { chainId: 10 }, { projectId: 8n },
  ])('rejects changed review state %#', change => {
    expect(() => assertSameIncomeReservedTokens(snapshot(), { ...snapshot(), ...change } as IncomeReservedSnapshot)).toThrow('changed')
  })
  it.each(['beneficiary', 'hook', 'percent', 'projectId', 'lockedUntil', 'preferAddToBalance'] as const)('rejects a change to split %s', field => {
    const newer = snapshot(), split = { ...newer.splits[0] }
    Object.assign(split, { [field]: field === 'percent' || field === 'lockedUntil' ? 123 : field === 'projectId' ? 3n : field === 'preferAddToBalance' ? true : HOOK })
    newer.splits = [split, newer.splits[1]]
    expect(() => assertSameIncomeReservedTokens(snapshot(), newer)).toThrow('recipients changed')
  })
  it('allows a newer unchanged block and rejects a stale project identity', () => {
    expect(() => assertSameIncomeReservedTokens(snapshot(), { ...snapshot(), blockNumber: 101n })).not.toThrow()
    expect(() => assertIncomeReservedProject(snapshot(), { ...state(), projectId: 9n })).toThrow('contracts changed')
  })
})
describe('reserved INCOME receipt confirmation', () => {
  it('proves exact EOA call and reconciles split amounts plus owner remainder', async () => {
    const f = fixture()
    await expect(verifyIncomeReservedReceipt(f.rpc, f.reviewed, ACCOUNT, f.receipt)).resolves.toEqual({ tokenCount: 1000n, hookFailures: 0, projectFallbacks: 0 })
  })
  it('reports the actual execution amount when payments added reserves after review', async () => {
    const f = fixture(1234n)
    expect((await verifyIncomeReservedReceipt(f.rpc, f.reviewed, ACCOUNT, f.receipt)).tokenCount).toBe(1234n)
  })
  it('reports caught hook failures and project-payment fallbacks despite outer success', async () => {
    const f = fixture()
    f.receipt.logs.push(log('SplitHookReverted', { projectId: 7n, hook: HOOK, reason: '0x', caller: ACCOUNT }))
    f.receipt.logs.push(log('ReservedDistributionReverted', { projectId: 7n, split: f.reviewed.splits[1], tokenCount: 200n, reason: '0x', caller: ACCOUNT }))
    expect(await verifyIncomeReservedReceipt(f.rpc, f.reviewed, ACCOUNT, f.receipt)).toMatchObject({ hookFailures: 1, projectFallbacks: 1 })
  })
  it('requires the exact Safe inner call and its ExecutionSuccess event', async () => {
    const f = fixture()
    f.transaction.to = ACCOUNT
    f.transaction.input = encodeFunctionData({ abi: safeAbi, functionName: 'execTransaction', args: [f.reviewed.controller, 0n, encodeFunctionData(buildSendIncomeReservedTokensTx(1, 7n)), 0, 0n, 0n, 0n, zeroAddress, zeroAddress, '0x'] })
    await expect(verifyIncomeReservedReceipt(f.rpc, f.reviewed, ACCOUNT, f.receipt)).rejects.toThrow('successful execution by the Safe')
    f.receipt.logs.push(log('ExecutionSuccess', { txHash: TX_HASH, payment: 0n }, ACCOUNT, safeAbi))
    await expect(verifyIncomeReservedReceipt(f.rpc, f.reviewed, ACCOUNT, f.receipt)).resolves.toMatchObject({ tokenCount: 1000n })
    f.transaction.input = encodeFunctionData({ abi: safeAbi, functionName: 'execTransaction', args: [f.reviewed.controller, 0n, encodeFunctionData(buildSendIncomeReservedTokensTx(1, 8n)), 0, 0n, 0n, 0n, zeroAddress, zeroAddress, '0x'] })
    await expect(verifyIncomeReservedReceipt(f.rpc, f.reviewed, ACCOUNT, f.receipt)).rejects.toThrow('different reserved')
  })
  it.each(['from', 'to', 'input', 'value', 'hash', 'blockNumber', 'blockHash'])('rejects a different mined %s', field => {
    const f = fixture()
    Object.assign(f.transaction, { [field]: field === 'blockNumber' ? 90n : field === 'value' ? 1n : field === 'input' ? '0x' : field === 'hash' || field === 'blockHash' ? `0x${'cc'.repeat(32)}` : HOOK })
    return expect(verifyIncomeReservedReceipt(f.rpc, f.reviewed, ACCOUNT, f.receipt)).rejects.toThrow()
  })
  it('rejects reverted, historical, wrong-chain or reorged receipts', async () => {
    const f = fixture()
    await expect(verifyIncomeReservedReceipt(f.rpc, f.reviewed, ACCOUNT, { ...f.receipt, status: 'reverted' })).rejects.toThrow('successful')
    await expect(verifyIncomeReservedReceipt(f.rpc, f.reviewed, ACCOUNT, { ...f.receipt, blockNumber: 100n })).rejects.toThrow('new successful')
    f.client.getChainId.mockResolvedValueOnce(10)
    await expect(verifyIncomeReservedReceipt(f.rpc, f.reviewed, ACCOUNT, f.receipt)).rejects.toThrow('different chain')
    f.client.getBlock.mockResolvedValueOnce({ hash: TX_HASH })
    await expect(verifyIncomeReservedReceipt(f.rpc, f.reviewed, ACCOUNT, f.receipt)).rejects.toThrow('canonical')
  })
  it('rejects missing/duplicate summaries or missing recipient events', async () => {
    const f = fixture()
    await expect(verifyIncomeReservedReceipt(f.rpc, f.reviewed, ACCOUNT, { ...f.receipt, logs: f.receipt.logs.slice(0, -1) })).rejects.toThrow('exactly one')
    await expect(verifyIncomeReservedReceipt(f.rpc, f.reviewed, ACCOUNT, { ...f.receipt, logs: [...f.receipt.logs, f.receipt.logs[2]] })).rejects.toThrow('exactly one')
    await expect(verifyIncomeReservedReceipt(f.rpc, f.reviewed, ACCOUNT, { ...f.receipt, logs: f.receipt.logs.slice(1) })).rejects.toThrow('different reserved INCOME recipients')
  })
})
