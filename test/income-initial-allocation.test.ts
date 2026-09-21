import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getAddress, zeroAddress, type Address, type Hex, type PublicClient } from 'viem'
import { v6Address } from '@bananapus/nana-sdk-core/v6'
import { assertInitialIncomeAllocation, buildInitialIncomeMint, readInitialIncomeAllocation, type InitialIncomeAllocationState } from '../src/lib/income-initial-allocation'

const { registered } = vi.hoisted(() => ({ registered: vi.fn() }))
vi.mock('../src/lib/income-contracts', async importOriginal => ({ ...await importOriginal<typeof import('../src/lib/income-contracts')>(), registeredHomerunDeployer: registered }))

const HELPER = getAddress('0x2222222222222222222222222222222222222222')
const OWNER = getAddress('0x1111111111111111111111111111111111111111')
const HASH = `0x${'ab'.repeat(32)}` as Hex
const OTHER = `0x${'cd'.repeat(32)}` as Hex
const AMOUNT = 250_000n * 10n ** 18n
const input = { chainId: 8453, incomeProjectId: 10n, fundProjectId: 7n }

function client(overrides: { bound?: bigint; owner?: Address; stageId?: bigint; start?: bigint; pending?: bigint; reorg?: boolean; chainId?: number } = {}) {
  const reads: { address: Address; functionName: string; args?: readonly unknown[]; blockNumber?: bigint }[] = []
  const rpc = {
    getChainId: vi.fn(async () => overrides.chainId ?? 8453),
    getBlock: vi.fn(async (args?: { blockNumber?: bigint; blockTag?: string }) => ({ number: args?.blockNumber ?? 100n, hash: overrides.reorg && args?.blockNumber !== undefined ? OTHER : HASH, timestamp: 1_800_000_000n })),
    readContract: vi.fn(async (request: { address: Address; functionName: string; args?: readonly unknown[]; blockNumber?: bigint }) => {
      reads.push(request)
      if (request.functionName === 'incomeProjectIdOf') { expect(request.address).toBe(HELPER); expect(request.args).toEqual([7n]); return overrides.bound ?? 10n }
      if (request.functionName === 'ownerOf') { expect(request.address).toBe(v6Address('JBProjects', 8453)); expect(request.args).toEqual([7n]); return overrides.owner ?? OWNER }
      if (request.functionName === 'latestQueuedRulesetOf') { expect(request.address).toBe(v6Address('JBController', 8453)); expect(request.args).toEqual([10n]); return [{ id: Number(overrides.stageId ?? 1_799_999_900n), start: Number(overrides.start ?? 1_799_999_900n) }, {}, 0] }
      if (request.functionName === 'amountToAutoIssue') { expect(request.address).toBe(v6Address('REVOwner', 8453)); expect(request.args).toEqual([10n, overrides.stageId ?? 1_799_999_900n, HELPER]); return overrides.pending ?? AMOUNT }
      throw new Error(`Unexpected read ${request.functionName}`)
    }),
  }
  return { rpc: rpc as unknown as PublicClient, calls: rpc, reads }
}

beforeEach(() => { registered.mockReturnValue(HELPER) })

describe('initial INCOME auto-issuance held by the helper for the FUND owner', () => {
  it('reads the launcher binding, the current FUND owner, the single stage and the pending helper allocation at one block', async () => {
    const { rpc, reads, calls } = client()
    expect(await readInitialIncomeAllocation(rpc, input)).toEqual<InitialIncomeAllocationState>({ chainId: 8453, incomeProjectId: 10n, fundProjectId: 7n, deployer: HELPER, owner: OWNER, blockNumber: 100n, blockHash: HASH, blockTimestamp: 1_800_000_000n, stageId: 1_799_999_900n, stageStart: 1_799_999_900n, started: true, pending: AMOUNT })
    expect(reads.every(read => read.blockNumber === 100n)).toBe(true)
    expect(calls.getBlock).toHaveBeenCalledWith({ blockTag: 'latest' })
    expect(calls.getBlock).toHaveBeenLastCalledWith({ blockNumber: 100n })
  })
  it('pins to a caller-supplied block without a second canonical check', async () => {
    const { rpc, reads, calls } = client()
    const state = await readInitialIncomeAllocation(rpc, { ...input, blockNumber: 90n })
    expect(state.blockNumber).toBe(90n)
    expect(reads.every(read => read.blockNumber === 90n)).toBe(true)
    expect(calls.getBlock).toHaveBeenCalledTimes(1)
  })
  it('reports a stage that has not started and a minted allocation without inventing amounts', async () => {
    expect(await readInitialIncomeAllocation(client({ start: 1_800_000_100n }).rpc, input)).toMatchObject({ started: false, pending: AMOUNT })
    expect(await readInitialIncomeAllocation(client({ pending: 0n }).rpc, input)).toMatchObject({ started: true, pending: 0n })
  })
  it('follows the current FUND owner rather than the launch-time owner', async () => {
    const next = getAddress('0x3333333333333333333333333333333333333333')
    expect((await readInitialIncomeAllocation(client({ owner: next }).rpc, input)).owner).toBe(next)
    await expect(readInitialIncomeAllocation(client({ owner: zeroAddress }).rpc, input)).rejects.toThrow('no owner')
  })
  it.each([{ bound: 0n }, { bound: 11n }, { bound: (1n << 256n) - 1n }])('rejects a FUND the launcher never bound to this INCOME %#', async overrides => {
    await expect(readInitialIncomeAllocation(client(overrides).rpc, input)).rejects.toThrow('not bound')
  })
  it('rejects a missing stage, a foreign chain, a reorganization, and an unregistered launcher', async () => {
    await expect(readInitialIncomeAllocation(client({ stageId: 0n }).rpc, input)).rejects.toThrow('no recorded stage')
    await expect(readInitialIncomeAllocation(client({ chainId: 10 }).rpc, input)).rejects.toThrow('different chain')
    await expect(readInitialIncomeAllocation(client({ reorg: true }).rpc, input)).rejects.toThrow('chain changed')
    registered.mockReturnValue(null)
    await expect(readInitialIncomeAllocation(client().rpc, input)).rejects.toThrow('No verified INCOME launcher')
  })
  it.each([{ incomeProjectId: 0n }, { fundProjectId: 7n, incomeProjectId: 7n }, { chainId: 0 }])('rejects invalid input before any read %#', async patch => {
    const { rpc, calls } = client()
    await expect(readInitialIncomeAllocation(rpc, { ...input, ...patch })).rejects.toThrow()
    expect(calls.readContract).not.toHaveBeenCalled()
  })
  it('accepts a pending recorded allocation or a minted one after the stage started, and nothing else', async () => {
    const state = await readInitialIncomeAllocation(client().rpc, input)
    expect(() => assertInitialIncomeAllocation(state, AMOUNT)).not.toThrow()
    expect(() => assertInitialIncomeAllocation({ ...state, started: false }, AMOUNT)).not.toThrow()
    expect(() => assertInitialIncomeAllocation({ ...state, pending: 0n }, AMOUNT)).not.toThrow()
    expect(() => assertInitialIncomeAllocation({ ...state, pending: 0n }, 0n)).not.toThrow()
    expect(() => assertInitialIncomeAllocation({ ...state, pending: 0n, started: false }, AMOUNT)).toThrow('does not match the published manifest')
    expect(() => assertInitialIncomeAllocation({ ...state, pending: AMOUNT - 1n }, AMOUNT)).toThrow('does not match the published manifest')
    expect(() => assertInitialIncomeAllocation(state, AMOUNT + 1n)).toThrow('does not match the published manifest')
  })
  it('builds the permissionless helper mint and refuses it when nothing is pending or the stage has not started', async () => {
    const state = await readInitialIncomeAllocation(client().rpc, input)
    expect(buildInitialIncomeMint(state)).toMatchObject({ chainId: 8453, address: HELPER, functionName: 'mintInitialAllocation', args: [7n] })
    expect(buildInitialIncomeMint(state).value).toBeUndefined()
    expect(() => buildInitialIncomeMint({ ...state, pending: 0n })).toThrow('Nothing is left to mint')
    expect(() => buildInitialIncomeMint({ ...state, started: false })).toThrow('not started')
  })
})
