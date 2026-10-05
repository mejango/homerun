import { jbControllerAbi, jbTokensAbi } from '@bananapus/nana-sdk-core'
import { v6Address } from '@bananapus/nana-sdk-core/v6'
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, encodeFunctionData, getAbiItem, parseAbi, zeroAddress, type AbiEvent, type Address, type Hex, type PublicClient, type TransactionReceipt } from 'viem'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { IncomeProjectState } from '../src/lib/income-state'
import { safeExecutionLog } from './support/safe-logs'
const runtime = vi.hoisted(() => ({ readState: vi.fn() }))
vi.mock('../src/lib/income-state', () => ({ readIncomeProjectState: runtime.readState }))
import { assertIncomeReservedProject, assertSameIncomeReservedTokens, buildSendIncomeReservedTokensTx, readIncomeReservedTokens, verifyIncomeReservedReceipt, type IncomeReservedSnapshot } from '../src/lib/income-reserved'

const ACCOUNT = '0x1111111111111111111111111111111111111111' as Address
const TOKEN = '0x2222222222222222222222222222222222222222' as Address
const HOOK = '0x3333333333333333333333333333333333333333' as Address
const HASH = `0x${'aa'.repeat(32)}` as Hex
const TX_HASH = `0x${'bb'.repeat(32)}` as Hex
const DEAD = '0x000000000000000000000000000000000000dEaD' as Address
const safeAbi = parseAbi(['function execTransaction(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,bytes signatures) returns (bool success)', 'event ExecutionSuccess(bytes32 txHash,uint256 payment)'])
function snapshot(): IncomeReservedSnapshot {
  return { chainId: 1, projectId: 7n, blockNumber: 100n, blockHash: HASH, controller: v6Address('JBController', 1), owner: v6Address('REVOwner', 1), tokenAddress: TOKEN, rulesetId: 90n, cycleNumber: 1n, pending: 1000n, splits: [
    { percent: 700_000_000, projectId: 0n, beneficiary: ACCOUNT, hook: zeroAddress, lockedUntil: 100, preferAddToBalance: false },
    { percent: 200_000_000, projectId: 0n, beneficiary: TOKEN, hook: HOOK, lockedUntil: 100, preferAddToBalance: false },
  ] }
}
function state(): IncomeProjectState { const s = snapshot(); return { ...s, ruleset: { id: Number(s.rulesetId), cycleNumber: Number(s.cycleNumber) }, pendingReservedTokens: s.pending, isOperator: false, totalBalance: 0n } as unknown as IncomeProjectState }
function log(name: string, values: Record<string, unknown>, address = snapshot().controller, abi = jbControllerAbi as readonly unknown[]) {
  const event = getAbiItem({ abi: abi as readonly AbiEvent[], name }) as AbiEvent
  return { address, data: encodeAbiParameters(event.inputs.filter(input => !input.indexed), event.inputs.filter(input => !input.indexed).map(input => values[input.name!])), topics: encodeEventTopics({ abi: [event], eventName: name, args: values }) } as unknown as TransactionReceipt['logs'][number]
}
function fixture(amount = 1000n, reviewedSplits = snapshot().splits) {
  const reviewed = { ...snapshot(), splits: reviewedSplits }
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
    { pending: 999n }, { pending: 0n }, { rulesetId: 91n }, { cycleNumber: 2n }, { blockNumber: 99n }, { controller: TOKEN }, { tokenAddress: HOOK }, { owner: ACCOUNT }, { chainId: 10 }, { projectId: 8n },
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
    await expect(verifyIncomeReservedReceipt(f.rpc, f.reviewed, ACCOUNT, f.receipt)).resolves.toEqual({ tokenCount: 1000n })
  })
  it('refuses a distribution of another amount than the reviewed pending reserves', async () => {
    // Payments added reserves after the review.
    const f = fixture(1234n)
    await expect(verifyIncomeReservedReceipt(f.rpc, f.reviewed, ACCOUNT, f.receipt)).rejects.toThrow('1,234 tokens were distributed, not the reviewed 1,000')
  })
  it.each([
    ['a reward hook', () => log('SplitHookReverted', { projectId: 7n, hook: HOOK, reason: '0x', caller: ACCOUNT })],
    ['a project payment', () => log('ReservedDistributionReverted', { projectId: 7n, split: snapshot().splits[1], tokenCount: 200n, reason: '0x', caller: ACCOUNT })],
  ])('refuses a receipt in which %s failed', async (_, failure) => {
    const f = fixture()
    f.receipt.logs.push(failure())
    await expect(verifyIncomeReservedReceipt(f.rpc, f.reviewed, ACCOUNT, f.receipt)).rejects.toThrow('a recipient failed')
  })
  it('refuses a distribution in another cycle of the reviewed ruleset', async () => {
    const f = fixture()
    f.receipt.logs[2] = log('SendReservedTokensToSplits', { projectId: 7n, rulesetId: 90n, rulesetCycleNumber: 2n, owner: f.reviewed.owner, tokenCount: 1000n, leftoverAmount: 100n, caller: ACCOUNT })
    await expect(verifyIncomeReservedReceipt(f.rpc, f.reviewed, ACCOUNT, f.receipt)).rejects.toThrow('cycle 2, not ruleset 90 cycle 1')
  })
  it('refuses a controller log its ABI cannot read, rather than skipping it', async () => {
    const f = fixture()
    f.receipt.logs.push({ address: f.reviewed.controller, topics: [`0x${'99'.repeat(32)}`], data: '0x' } as unknown as TransactionReceipt['logs'][number])
    await expect(verifyIncomeReservedReceipt(f.rpc, f.reviewed, ACCOUNT, f.receipt)).rejects.toThrow('cannot read')
  })
  describe('burned reserves', () => {
    const burn = (count: bigint) => log('Burn', { holder: snapshot().controller, projectId: 7n, count, creditBalance: 0n, tokenBalance: count, caller: snapshot().controller }, v6Address('JBTokens', 1), jbTokensAbi as readonly unknown[])
    it('accepts a burn of exactly the share sent to 0x…dEaD', async () => {
      const splits = snapshot().splits.map((split, index) => index === 1 ? { ...split, beneficiary: DEAD, hook: zeroAddress } : split)
      const f = fixture(1000n, splits)
      f.receipt.logs.push(burn(200n))
      await expect(verifyIncomeReservedReceipt(f.rpc, f.reviewed, ACCOUNT, f.receipt)).resolves.toEqual({ tokenCount: 1000n })
    })
    it('refuses a burn of tokens a hook did not take', async () => {
      const f = fixture()
      f.receipt.logs.push(burn(5n))
      await expect(verifyIncomeReservedReceipt(f.rpc, f.reviewed, ACCOUNT, f.receipt)).rejects.toThrow('a hook did not take its share')
    })
  })
  it('requires the exact Safe inner call and its ExecutionSuccess event', async () => {
    const f = fixture()
    f.transaction.to = ACCOUNT
    f.transaction.input = encodeFunctionData({ abi: safeAbi, functionName: 'execTransaction', args: [f.reviewed.controller, 0n, encodeFunctionData(buildSendIncomeReservedTokensTx(1, 7n)), 0, 0n, 0n, 0n, zeroAddress, zeroAddress, '0x'] })
    await expect(verifyIncomeReservedReceipt(f.rpc, f.reviewed, ACCOUNT, f.receipt)).rejects.toThrow('has no ExecutionSuccess or ExecutionFailure from Safe')
    f.receipt.logs.push(log('ExecutionSuccess', { txHash: TX_HASH, payment: 0n }, ACCOUNT, safeAbi))
    await expect(verifyIncomeReservedReceipt(f.rpc, f.reviewed, ACCOUNT, f.receipt)).resolves.toMatchObject({ tokenCount: 1000n })
    f.transaction.input = encodeFunctionData({ abi: safeAbi, functionName: 'execTransaction', args: [f.reviewed.controller, 0n, encodeFunctionData(buildSendIncomeReservedTokensTx(1, 8n)), 0, 0n, 0n, 0n, zeroAddress, zeroAddress, '0x'] })
    await expect(verifyIncomeReservedReceipt(f.rpc, f.reviewed, ACCOUNT, f.receipt)).rejects.toThrow('different reserved')
  })
  describe('Safe execution events', () => {
    const PROPOSAL = `0x${'dd'.repeat(32)}` as Hex
    /** The Safe executing the reviewed distribution, with `events` in its receipt. */
    const verify = (...events: ReturnType<typeof safeExecutionLog>[]) => {
      const f = fixture()
      f.transaction.to = ACCOUNT
      f.transaction.input = encodeFunctionData({ abi: safeAbi, functionName: 'execTransaction', args: [f.reviewed.controller, 0n, encodeFunctionData(buildSendIncomeReservedTokensTx(1, 7n)), 0, 0n, 0n, 0n, zeroAddress, zeroAddress, '0x'] })
      const logs = [...f.receipt.logs, ...events as unknown as TransactionReceipt['logs']]
      return verifyIncomeReservedReceipt(f.rpc, f.reviewed, ACCOUNT, { ...f.receipt, logs })
    }
    it('accepts a Safe 1.4.1 ExecutionSuccess, whose txHash is indexed', async () => {
      await expect(verify(safeExecutionLog(ACCOUNT, PROPOSAL))).resolves.toMatchObject({ tokenCount: 1000n })
    })
    it('refuses a Safe 1.4.1 ExecutionFailure', async () => {
      await expect(verify(safeExecutionLog(ACCOUNT, PROPOSAL, { failed: true }))).rejects.toThrow('its call failed (ExecutionFailure)')
    })
    it('accepts a Safe 1.3 ExecutionSuccess, whose txHash is in data', async () => {
      await expect(verify(safeExecutionLog(ACCOUNT, PROPOSAL, { version: '1.3' }))).resolves.toMatchObject({ tokenCount: 1000n })
    })
    it('ignores another Safe’s failure in the same receipt', async () => {
      await expect(verify(safeExecutionLog(HOOK, PROPOSAL, { failed: true }), safeExecutionLog(ACCOUNT, PROPOSAL))).resolves.toMatchObject({ tokenCount: 1000n })
    })
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
  it('rejects missing/duplicate summaries or a missing split event', async () => {
    const f = fixture()
    await expect(verifyIncomeReservedReceipt(f.rpc, f.reviewed, ACCOUNT, { ...f.receipt, logs: f.receipt.logs.slice(0, -1) })).rejects.toThrow('has 0 SendReservedTokensToSplits events, not 1')
    await expect(verifyIncomeReservedReceipt(f.rpc, f.reviewed, ACCOUNT, { ...f.receipt, logs: [...f.receipt.logs, f.receipt.logs[2]] })).rejects.toThrow('has 2 SendReservedTokensToSplits events, not 1')
    await expect(verifyIncomeReservedReceipt(f.rpc, f.reviewed, ACCOUNT, { ...f.receipt, logs: f.receipt.logs.slice(1) })).rejects.toThrow('sends to 1 splits, not the reviewed 2')
  })
  it('refuses a distribution sent by another caller', async () => {
    const f = fixture()
    f.receipt.logs[2] = log('SendReservedTokensToSplits', { projectId: 7n, rulesetId: 90n, rulesetCycleNumber: 1n, owner: f.reviewed.owner, tokenCount: 1000n, leftoverAmount: 100n, caller: HOOK })
    await expect(verifyIncomeReservedReceipt(f.rpc, f.reviewed, ACCOUNT, f.receipt)).rejects.toThrow(`sent by ${HOOK}, not ${ACCOUNT}`)
  })
})
