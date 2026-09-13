import { RESERVED_TOKEN_SPLIT_GROUP_ID, v6Address } from '@bananapus/nana-sdk-core/v6'
import { zeroAddress, type Address, type Hex, type PublicClient } from 'viem'
import { describe, expect, it, vi } from 'vitest'
import { OPERATOR_BURN_ADDRESS, readCurrentProjectOperator } from '../src/lib/project-operator-profile'

const FIRST = '0x1111111111111111111111111111111111111111' as Address
const SECOND = '0x2222222222222222222222222222222222222222' as Address
const HOOK = '0x3333333333333333333333333333333333333333' as Address
const HASH = `0x${'aa'.repeat(32)}` as Hex
const OTHER_HASH = `0x${'bb'.repeat(32)}` as Hex

function fixture() {
  const data = {
    block: { number: 100n, hash: HASH, timestamp: 1_000n },
    projectOwner: v6Address('REVOwner', 1), controller: v6Address('JBController', 1), ownerController: v6Address('JBController', 1),
    ruleset: { id: 90, start: 900 },
    metadata: { dataHook: v6Address('REVOwner', 1), useDataHookForPay: true, useDataHookForCashOut: true, reservedPercent: 10_000 },
    splits: [
      { beneficiary: FIRST, percent: 300_000_000, hook: zeroAddress, projectId: 0n, lockedUntil: 0, preferAddToBalance: false },
      { beneficiary: SECOND, percent: 600_000_000, hook: HOOK, projectId: 0n, lockedUntil: 0, preferAddToBalance: false },
      { beneficiary: SECOND, percent: 100_000_000, hook: zeroAddress, projectId: 9n, lockedUntil: 0, preferAddToBalance: false },
    ],
  }
  const client = {
    getChainId: vi.fn(async () => 1),
    getBlock: vi.fn(async () => data.block),
    readContract: vi.fn(async ({ functionName }: { functionName: string; blockNumber?: bigint }) => {
      if (functionName === 'ownerOf') return data.projectOwner
      if (functionName === 'controllerOf') return data.controller
      if (functionName === 'CONTROLLER') return data.ownerController
      if (functionName === 'currentRulesetOf') return [data.ruleset, data.metadata]
      if (functionName === 'splitsOf') return data.splits
      throw new Error(`Unexpected ${functionName}`)
    }),
  }
  return { data, client, rpc: client as unknown as PublicClient }
}

describe('current project Operator read', () => {
  it('reads the active direct incentive recipient at one canonical block without confusing split hooks, project routes, or controller authority', async () => {
    const f = fixture()
    const result = await readCurrentProjectOperator(f.rpc, { chainId: 1, incomeProjectId: 7n })
    expect(result).toEqual({ chainId: 1, incomeProjectId: 7n, blockNumber: 100n, blockHash: HASH, rulesetId: 90n, reservedPercent: 10_000, recipients: [{ address: FIRST, percent: 300_000_000 }] })
    expect(f.client.readContract.mock.calls.every(([call]) => call.blockNumber === 100n)).toBe(true)
    expect(f.client.readContract).toHaveBeenCalledWith(expect.objectContaining({ address: v6Address('JBSplits', 1), functionName: 'splitsOf', args: [7n, 90n, RESERVED_TOKEN_SPLIT_GROUP_ID] }))
  })
  it('follows confirmed replacement and later active-stage changes instead of using a published wallet or a future namespace', async () => {
    const f = fixture()
    await readCurrentProjectOperator(f.rpc, { chainId: 1, incomeProjectId: 7n })
    f.data.block.number = 101n; f.data.splits[0].beneficiary = SECOND
    expect((await readCurrentProjectOperator(f.rpc, { chainId: 1, incomeProjectId: 7n })).recipients[0].address).toBe(SECOND)
    f.data.ruleset = { id: 110, start: 1_100 }; f.data.block.timestamp = 1_100n; f.data.block.number = 120n
    f.data.splits[0].beneficiary = FIRST
    const current = await readCurrentProjectOperator(f.rpc, { chainId: 1, incomeProjectId: 7n })
    expect(current.rulesetId).toBe(110n)
    expect(current.recipients[0].address).toBe(FIRST)
    expect(f.client.readContract).toHaveBeenLastCalledWith(expect.objectContaining({ functionName: 'splitsOf', args: [7n, 110n, 1n], blockNumber: 120n }))
  })
  it('returns all direct wallets after general split editing, and aggregates repeated rows for the same wallet', async () => {
    const f = fixture()
    f.data.splits[1].hook = zeroAddress
    f.data.splits[2] = { ...f.data.splits[2], projectId: 0n, beneficiary: FIRST }
    expect((await readCurrentProjectOperator(f.rpc, { chainId: 1, incomeProjectId: 7n })).recipients).toEqual([{ address: FIRST, percent: 400_000_000 }, { address: SECOND, percent: 600_000_000 }])
  })
  it('does not identify zero beneficiaries, hook recipients, or default owner leftovers as the Operator', async () => {
    const f = fixture(); f.data.splits[0].beneficiary = zeroAddress
    expect((await readCurrentProjectOperator(f.rpc, { chainId: 1, incomeProjectId: 7n })).recipients).toEqual([])
    f.data.splits = []
    expect((await readCurrentProjectOperator(f.rpc, { chainId: 1, incomeProjectId: 7n })).recipients).toEqual([])
  })
  it('excludes reserved-token burn rows from human Operators while preserving a real direct recipient', async () => {
    const f = fixture(); f.data.splits[0].beneficiary = OPERATOR_BURN_ADDRESS
    expect((await readCurrentProjectOperator(f.rpc, { chainId: 1, incomeProjectId: 7n })).recipients).toEqual([])
    f.data.splits[1] = { ...f.data.splits[1], hook: zeroAddress, beneficiary: FIRST }
    expect((await readCurrentProjectOperator(f.rpc, { chainId: 1, incomeProjectId: 7n })).recipients).toEqual([{ address: FIRST, percent: 600_000_000 }])
    // Neither hook payloads nor project-payment beneficiaries establish a human Operator.
    f.data.splits[0] = { ...f.data.splits[0], hook: HOOK }
    f.data.splits[2] = { ...f.data.splits[2], beneficiary: OPERATOR_BURN_ADDRESS }
    expect((await readCurrentProjectOperator(f.rpc, { chainId: 1, incomeProjectId: 7n })).recipients).toEqual([{ address: FIRST, percent: 600_000_000 }])
  })
  it('has no active incentives when the current reserve rate is zero', async () => {
    const f = fixture(); f.data.metadata.reservedPercent = 0
    expect((await readCurrentProjectOperator(f.rpc, { chainId: 1, incomeProjectId: 7n })).recipients).toEqual([])
  })
  it.each(['projectOwner', 'controller', 'ownerController'] as const)('rejects a foreign %s', async field => {
    const f = fixture(); f.data[field] = FIRST
    await expect(readCurrentProjectOperator(f.rpc, { chainId: 1, incomeProjectId: 7n })).rejects.toThrow('registered revnet')
  })
  it('rejects an inactive or foreign governed stage', async () => {
    const f = fixture(); f.data.ruleset.start = 1_001
    await expect(readCurrentProjectOperator(f.rpc, { chainId: 1, incomeProjectId: 7n })).rejects.toThrow('stage')
    f.data.ruleset.start = 900; f.data.metadata.dataHook = FIRST
    await expect(readCurrentProjectOperator(f.rpc, { chainId: 1, incomeProjectId: 7n })).rejects.toThrow('registered revnet')
    f.data.metadata.dataHook = v6Address('REVOwner', 1); f.data.metadata.useDataHookForPay = false
    await expect(readCurrentProjectOperator(f.rpc, { chainId: 1, incomeProjectId: 7n })).rejects.toThrow('registered revnet')
  })
  it.each([0, -1, 0.5, 1_000_000_001])('rejects inconsistent split percentages %s', async percent => {
    const f = fixture(); f.data.splits[0].percent = percent
    await expect(readCurrentProjectOperator(f.rpc, { chainId: 1, incomeProjectId: 7n })).rejects.toThrow('percentages')
  })
  it('rejects chain mismatches and reorgs, and propagates RPC failures instead of falling back to metadata', async () => {
    const f = fixture(); f.client.getChainId.mockResolvedValueOnce(10)
    await expect(readCurrentProjectOperator(f.rpc, { chainId: 1, incomeProjectId: 7n })).rejects.toThrow('different chain')
    expect(f.client.readContract).not.toHaveBeenCalled()
    f.client.getBlock.mockResolvedValueOnce(f.data.block).mockResolvedValueOnce({ ...f.data.block, hash: OTHER_HASH })
    await expect(readCurrentProjectOperator(f.rpc, { chainId: 1, incomeProjectId: 7n })).rejects.toThrow('chain changed')
    f.client.readContract.mockRejectedValueOnce(new Error('RPC offline'))
    await expect(readCurrentProjectOperator(f.rpc, { chainId: 1, incomeProjectId: 7n })).rejects.toThrow('RPC offline')
  })
  it('rejects a lagging latest block after a verified Operator change before reading an old recipient', async () => {
    const f = fixture()
    await expect(readCurrentProjectOperator(f.rpc, { chainId: 1, incomeProjectId: 7n, minimumBlockNumber: 101n })).rejects.toThrow('not caught up')
    expect(f.client.readContract).not.toHaveBeenCalled()
    f.data.block.number = 101n
    expect((await readCurrentProjectOperator(f.rpc, { chainId: 1, incomeProjectId: 7n, minimumBlockNumber: 101n })).blockNumber).toBe(101n)
  })
})
