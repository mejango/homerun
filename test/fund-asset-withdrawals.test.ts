import { beforeEach, describe, expect, it, vi } from 'vitest'
import { jbMultiTerminalAbi } from '@bananapus/nana-sdk-core'
import { v6Address } from '@bananapus/nana-sdk-core/v6'
import { encodeAbiParameters, encodeEventTopics, type PublicClient, type TransactionReceipt } from 'viem'
import type { FundAccountingContext, FundProjectState } from '../src/lib/fund-state'

vi.mock('@/providers/Providers', () => ({ wagmiConfig: {} }))
vi.mock('@/hooks/useSafeTx', () => ({ useSafeTx: vi.fn(), txPhaseLabel: vi.fn() }))
vi.mock('@/hooks/useWallet', () => ({ useWallet: vi.fn() }))

import { confirmedAssetWithdrawal, readAssetAllowance } from '../src/components/FundAssetWithdrawals'

const terminal = v6Address('JBMultiTerminal', 1)
const holder = '0x1111111111111111111111111111111111111111'
const beneficiary = '0x2222222222222222222222222222222222222222'
const feeBeneficiary = '0x3333333333333333333333333333333333333333'
const blockHash = `0x${'a'.repeat(64)}`
const state = { chainId: 1, projectId: 7n, ruleset: { id: 42 }, blockNumber: 100n, blockHash } as unknown as FundProjectState
const context = { terminal, token: '0x4444444444444444444444444444444444444444', decimals: 6, currency: 2, surplus: 800n, surplusAllowances: [{ currency: 2, amount: 1000n }] } as FundAccountingContext

describe('bounded asset allowance reads', () => {
  const readContract = vi.fn()
  const getBlock = vi.fn()
  const client = { readContract, getBlock } as unknown as PublicClient
  beforeEach(() => { readContract.mockReset().mockResolvedValue(300n); getBlock.mockReset().mockResolvedValue({ hash: blockHash }) })

  it('subtracts already used allowance and caps spending at available surplus', async () => {
    expect(await readAssetAllowance(client, state, context)).toEqual({ configured: 1000n, used: 300n, remaining: 700n, available: 700n })
    expect((await readAssetAllowance(client, state, { ...context, surplus: 50n })).available).toBe(50n)
  })

  it('reads usage on the same block, ruleset and currency as the verified configuration', async () => {
    await readAssetAllowance(client, state, context)
    expect(readContract).toHaveBeenCalledWith(expect.objectContaining({ functionName: 'usedSurplusAllowanceOf', args: [terminal, 7n, context.token, 42n, 2n], blockNumber: 100n }))
    expect(getBlock).toHaveBeenCalledWith({ blockNumber: 100n })
  })

  it('does not borrow authority from an allowance in another currency', async () => {
    readContract.mockResolvedValue(0n)
    expect((await readAssetAllowance(client, state, { ...context, surplusAllowances: [{ currency: 1, amount: 1000n }] })).available).toBe(0n)
  })

  it('rejects inconsistent or duplicated contract limits', async () => {
    await expect(readAssetAllowance(client, state, { ...context, surplusAllowances: [{ currency: 2, amount: 1n }] })).rejects.toThrow('exceeds')
    await expect(readAssetAllowance(client, state, { ...context, surplusAllowances: [...context.surplusAllowances, ...context.surplusAllowances] })).rejects.toThrow('duplicate')
  })

  it('rejects read failures and a reorg instead of inventing an allowance', async () => {
    readContract.mockRejectedValueOnce(new Error('RPC unavailable'))
    await expect(readAssetAllowance(client, state, context)).rejects.toThrow('RPC unavailable')
    getBlock.mockResolvedValue({ hash: `0x${'b'.repeat(64)}` })
    await expect(readAssetAllowance(client, state, context)).rejects.toThrow('chain changed')
  })
})

describe('asset withdrawal confirmation', () => {
  const intent = { chainId: 1, terminal, projectId: 7n, rulesetId: 42n, amount: 1000n, netAmount: 975n, beneficiary, feeBeneficiary, account: holder, memo: 'Asset purchase reference' } as Parameters<typeof confirmedAssetWithdrawal>[1]
  function receipt(overrides: Partial<{ status: 'success' | 'reverted'; terminal: `0x${string}`; projectId: bigint; rulesetId: bigint; amount: bigint; amountPaidOut: bigint; net: bigint; beneficiary: string; feeBeneficiary: string; caller: string; memo: string }> = {}) {
    const values = { status: 'success' as const, terminal, projectId: 7n, rulesetId: 42n, amount: 1000n, amountPaidOut: 1000n, net: 975n, beneficiary, feeBeneficiary, caller: holder, memo: intent.memo, ...overrides }
    const topics = encodeEventTopics({ abi: jbMultiTerminalAbi, eventName: 'UseAllowance', args: { rulesetId: values.rulesetId, rulesetCycleNumber: 1n, projectId: values.projectId } })
    const data = encodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'string' }, { type: 'address' }], [values.beneficiary as `0x${string}`, values.feeBeneficiary as `0x${string}`, values.amount, values.amountPaidOut, values.net, values.memo, values.caller as `0x${string}`])
    return { status: values.status, logs: [{ address: values.terminal, topics, data }] } as unknown as TransactionReceipt
  }

  it('requires the exact successful withdrawal event and returns its net payment', () => {
    expect(confirmedAssetWithdrawal(receipt(), intent)).toBe(975n)
  })

  it('never treats an onchain revert as success', () => {
    expect(() => confirmedAssetWithdrawal(receipt({ status: 'reverted' }), intent)).toThrow('reverted')
  })

  it.each([
    { projectId: 8n }, { rulesetId: 43n }, { terminal: '0x5555555555555555555555555555555555555555' as const },
    { beneficiary: holder }, { feeBeneficiary: holder }, { caller: beneficiary }, { amount: 999n },
    { amountPaidOut: 999n }, { net: 974n }, { memo: 'A different purchase' },
  ])('rejects a mismatched withdrawal event %#', overrides => {
    expect(() => confirmedAssetWithdrawal(receipt(overrides), intent)).toThrow('could not be verified')
  })

  it('rejects missing or ambiguous matching events', () => {
    const one = receipt()
    expect(() => confirmedAssetWithdrawal({ ...one, logs: [] }, intent)).toThrow('could not be verified')
    expect(() => confirmedAssetWithdrawal({ ...one, logs: [...one.logs, ...one.logs] }, intent)).toThrow('could not be verified')
  })
})
