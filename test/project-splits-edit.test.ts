import { jbControllerAbi, NATIVE_TOKEN, USDC_ADDRESSES } from '@bananapus/nana-sdk-core'
import { JBPermissionIdsV6, payoutSplitGroupId, RESERVED_TOKEN_SPLIT_GROUP_ID, v6Address } from '@bananapus/nana-sdk-core/v6'
import { decodeFunctionData, encodeFunctionData, zeroAddress, type Address, type Hex, type PublicClient } from 'viem'
import { describe, expect, it, vi } from 'vitest'
import { assertSameProjectSplitsSnapshot, buildProjectSplitsTx, formatSplitPercent, isReservedTokenBurn, RESERVED_TOKEN_BURN_ADDRESS, parseSplitPercent, projectSplitDrafts, readProjectSplitsSnapshot, type ProjectSplit, type ProjectSplitDraft, type ProjectSplitGroup, type ProjectSplitsSnapshot } from '../src/lib/project-splits-edit'

const OWNER = '0x1111111111111111111111111111111111111111' as Address
const DELEGATE = '0x2222222222222222222222222222222222222222' as Address
const RECIPIENT = '0x3333333333333333333333333333333333333333' as Address
const HOOK = '0x4444444444444444444444444444444444444444' as Address
const HASH = `0x${'aa'.repeat(32)}` as Hex
const OTHER_HASH = `0x${'bb'.repeat(32)}` as Hex
const RESERVED = RESERVED_TOKEN_SPLIT_GROUP_ID
const ETH_PAYOUTS = payoutSplitGroupId(NATIVE_TOKEN)
const USDC_PAYOUTS = payoutSplitGroupId(USDC_ADDRESSES[1])

function split(change: Partial<ProjectSplit> = {}): ProjectSplit {
  return { percent: 400_000_000, beneficiary: RECIPIENT, projectId: 0n, hook: zeroAddress, lockedUntil: 0, preferAddToBalance: false, ...change }
}
function group(change: Partial<ProjectSplitGroup> = {}): ProjectSplitGroup {
  return { groupId: RESERVED, kind: 'reserved', label: 'Reserved tokens', splits: [split()], fallback: [], ...change }
}
function snapshot(phase: 'fund' | 'income' = 'fund'): ProjectSplitsSnapshot {
  return {
    chainId: 1, projectId: 7n, phase, blockNumber: 100n, blockHash: HASH, blockTimestamp: 1000n,
    owner: phase === 'fund' ? OWNER : v6Address('REVOwner', 1), controller: v6Address('JBController', 1), account: OWNER, canEdit: true,
    currentRulesetId: 90n, stages: [90n, 100n, 110n].map((rulesetId, index) => ({
      rulesetId, start: index ? 1000n + BigInt(index * 100) : 900n, isCurrent: index === 0, reservedPercent: 8000,
      groups: [group(), ...(phase === 'fund' ? [group({ groupId: ETH_PAYOUTS, kind: 'payout', label: 'ETH payouts' }), group({ groupId: USDC_PAYOUTS, kind: 'payout', label: 'USDC payouts' })] : [])],
    })),
  }
}
function drafts(g = group(), change: Partial<ProjectSplitDraft> = {}) {
  return projectSplitDrafts(g).map((draft, index) => index === 0 ? { ...draft, ...change } : draft)
}
function buildWithGroup(g: ProjectSplitGroup, rows: readonly ProjectSplitDraft[], allowHookChanges = false) {
  const reviewed = snapshot(); reviewed.stages[0].groups[0] = g
  return buildProjectSplitsTx(reviewed, 90n, g.groupId, rows, { allowHookChanges })
}
function ruleset(id: number, start: number, basedOnId: number) {
  return { id, start, basedOnId, cycleNumber: 1, duration: 0, weight: 1n, weightCutPercent: 0, approvalHook: zeroAddress, metadata: 0n }
}
type ReadCall = { address: Address; functionName: string; args?: readonly unknown[]; blockNumber?: bigint }
function fixture(phase: 'fund' | 'income' = 'fund') {
  const reviewed = snapshot(phase)
  const state = {
    permission: true, canonicalHash: HASH, activeController: reviewed.controller,
    ownerController: reviewed.controller, fallback: [] as ProjectSplit[],
    current: ruleset(90, 900, 0), latest: ruleset(110, 1200, 100),
    metadata: { dataHook: phase === 'income' ? reviewed.owner : zeroAddress, useDataHookForPay: phase === 'income', useDataHookForCashOut: phase === 'income', reservedPercent: 8000 },
  }
  const readContract = vi.fn(async ({ functionName, args }: ReadCall): Promise<unknown> => {
    if (functionName === 'ownerOf') return reviewed.owner
    if (functionName === 'controllerOf') return state.activeController
    if (functionName === 'currentRulesetOf') return [state.current, state.metadata]
    if (functionName === 'latestQueuedRulesetOf') return [state.latest, state.metadata, 0]
    if (functionName === 'CONTROLLER') return state.ownerController
    if (functionName === 'hasPermission') return state.permission
    if (functionName === 'getRulesetOf') return [args?.[1] === 100n ? ruleset(100, 1100, 90) : state.current, state.metadata]
    if (functionName === 'terminalsOf') return [v6Address('JBMultiTerminal', 1)]
    if (functionName === 'accountingContextsOf') return [{ token: NATIVE_TOKEN, decimals: 18, currency: 1 }, { token: USDC_ADDRESSES[1], decimals: 6, currency: 2 }, { token: NATIVE_TOKEN, decimals: 18, currency: 1 }]
    if (functionName === 'splitsOf') {
      if (args?.[1] === 0n) return state.fallback
      return reviewed.stages.find(stage => stage.rulesetId === args?.[1])!.groups.find(g => g.groupId === args?.[2])!.splits
    }
    throw new Error(`Unexpected read: ${functionName}`)
  })
  const client = {
    getChainId: vi.fn(async () => 1),
    getBlock: vi.fn(async (args: { blockTag?: string; blockNumber?: bigint }) => ({ number: 100n, hash: args.blockNumber ? state.canonicalHash : HASH, timestamp: 1000n })),
    readContract,
  }
  return { reviewed, state, client, rpc: client as unknown as PublicClient }
}

describe('split precision and transaction boundaries', () => {
  it('preserves every billionth through decimal input and display', () => {
    for (const units of [1, 9, 10, 9_999_999, 10_000_000, 333_333_333, 999_999_999, 1_000_000_000]) expect(parseSplitPercent(formatSplitPercent(units))).toBe(units)
    expect(formatSplitPercent(1)).toBe('0.0000001')
    expect(parseSplitPercent(' 0033.3333333 ')).toBe(333_333_333)
    expect(formatSplitPercent(0)).toBe('0')
  })
  it.each(['0', '-1', '-0.0000001', '100.0000001', '100000000000000000000000000000', '0.00000001', '1e1', 'NaN', '1.', '.1', ''])('rejects invalid or inexact percentage %s', value => {
    expect(() => parseSplitPercent(value)).toThrow()
  })
  it('builds one selected future namespace and payout group without mutating any other group', () => {
    const reviewed = snapshot(), before = structuredClone(reviewed)
    const target = reviewed.stages[2].groups[1]
    const request = buildProjectSplitsTx(reviewed, 110n, ETH_PAYOUTS, drafts(target, { beneficiary: DELEGATE, percent: '33.3333333' }))
    expect(request.address).toBe(reviewed.controller)
    expect(request.chainId).toBe(1)
    expect(decodeFunctionData({ abi: jbControllerAbi, data: encodeFunctionData(request) })).toEqual({ functionName: 'setSplitGroupsOf', args: [7n, 110n, [{ groupId: ETH_PAYOUTS, splits: [split({ beneficiary: DELEGATE, percent: 333_333_333 })] }]] })
    expect(reviewed).toEqual(before)
  })
  it('requires authority, a verified nondefault namespace and an actual change', () => {
    const reviewed = snapshot(), rows = drafts(group(), { percent: '20' })
    for (const next of [{ ...reviewed, account: null }, { ...reviewed, canEdit: false }]) expect(() => buildProjectSplitsTx(next, 90n, RESERVED, rows)).toThrow()
    for (const [rulesetId, groupId] of [[0n, RESERVED], [91n, RESERVED], [90n, 2n]]) expect(() => buildProjectSplitsTx(reviewed, rulesetId, groupId, rows)).toThrow()
    expect(() => buildProjectSplitsTx(reviewed, 90n, RESERVED, drafts())).toThrow('not changed')
  })
  it('rejects excessive totals and invalid destination IDs or locks', () => {
    const g = group({ splits: [split({ percent: 600_000_000 }), split({ percent: 400_000_000, beneficiary: DELEGATE })] })
    expect(() => buildWithGroup(g, drafts(g, { percent: '60.0000001' }))).toThrow('invalid')
    for (const projectId of ['0', '-1', '1.1', (1n << 64n).toString()]) expect(() => buildWithGroup(group(), drafts(group(), { recipient: 'project', projectId }))).toThrow()
    for (const lockedUntil of ['-1', '1.1', (1n << 48n).toString()]) expect(() => buildWithGroup(group(), drafts(group(), { percent: '30', lockedUntil }))).toThrow()
  })
})

describe('split snapshot reads', () => {
  it('reads every future namespace and both payout currencies at a single canonical block', async () => {
    const f = fixture()
    await expect(readProjectSplitsSnapshot(f.rpc, { chainId: 1, projectId: 7n, phase: 'fund', account: OWNER })).resolves.toEqual(f.reviewed)
    expect(f.client.readContract.mock.calls.every(([call]) => call.blockNumber === 100n)).toBe(true)
    for (const rulesetId of [0n, 90n, 100n, 110n]) for (const groupId of [RESERVED, ETH_PAYOUTS, USDC_PAYOUTS]) expect(f.client.readContract).toHaveBeenCalledWith(expect.objectContaining({ functionName: 'splitsOf', args: [7n, rulesetId, groupId], blockNumber: 100n }))
    expect(f.client.readContract.mock.calls.filter(([call]) => call.functionName === 'getRulesetOf').map(([call]) => call.args?.[1])).toEqual([100n, 90n])
    expect(f.client.getBlock).toHaveBeenLastCalledWith({ blockNumber: 100n })
  })
  it.each(['fund', 'income'] as const)('checks actual SET_SPLIT_GROUPS grants for a delegated %s wallet', async phase => {
    const f = fixture(phase)
    const result = await readProjectSplitsSnapshot(f.rpc, { chainId: 1, projectId: 7n, phase, account: DELEGATE })
    expect(result.canEdit).toBe(true)
    expect(f.client.readContract).toHaveBeenCalledWith(expect.objectContaining({ address: v6Address('JBPermissions', 1), functionName: 'hasPermission', args: [DELEGATE, f.reviewed.owner, 7n, BigInt(JBPermissionIdsV6.SET_SPLIT_GROUPS), true, true] }))
    expect(f.client.readContract.mock.calls.some(([call]) => call.functionName === 'isOperatorOf')).toBe(false)
    f.state.permission = false
    expect((await readProjectSplitsSnapshot(f.rpc, { chainId: 1, projectId: 7n, phase, account: DELEGATE })).canEdit).toBe(false)
  })
  it('supports public reads without inferring management permission', async () => {
    const f = fixture('income')
    const result = await readProjectSplitsSnapshot(f.rpc, { chainId: 1, projectId: 7n, phase: 'income' })
    expect(result.account).toBeNull(); expect(result.canEdit).toBe(false)
    expect(result.stages.every(stage => stage.groups.length === 1)).toBe(true)
    expect(f.client.readContract.mock.calls.some(([call]) => call.functionName === 'hasPermission')).toBe(false)
  })
  it('keeps fallback recipients separate and rejects an unread fallback', async () => {
    const f = fixture(); f.state.fallback = [split({ beneficiary: DELEGATE })]
    const result = await readProjectSplitsSnapshot(f.rpc, { chainId: 1, projectId: 7n, phase: 'fund', account: OWNER })
    expect(result.stages[0].groups[0].splits[0].beneficiary).toBe(RECIPIENT)
    expect(result.stages[0].groups[0].fallback[0].beneficiary).toBe(DELEGATE)
    const original = f.client.readContract.getMockImplementation()!
    f.client.readContract.mockImplementation(async call => {
      if (call.functionName === 'splitsOf' && call.args?.[1] === 0n) throw new Error('fallback RPC unavailable')
      return original(call)
    })
    await expect(readProjectSplitsSnapshot(f.rpc, { chainId: 1, projectId: 7n, phase: 'fund' })).rejects.toThrow('fallback RPC unavailable')
  })
  it('does not duplicate a current ruleset when the latest queue entry has its same ID', async () => {
    const f = fixture(); f.state.latest = { ...f.state.current }
    const result = await readProjectSplitsSnapshot(f.rpc, { chainId: 1, projectId: 7n, phase: 'fund' })
    expect(result.stages.map(stage => stage.rulesetId)).toEqual([90n])
    expect(f.client.readContract.mock.calls.some(([call]) => call.functionName === 'getRulesetOf')).toBe(false)
  })
  it('rejects wrong-chain, foreign-controller, changed-phase and reorged reads', async () => {
    const f = fixture()
    f.client.getChainId.mockResolvedValueOnce(10)
    await expect(readProjectSplitsSnapshot(f.rpc, { chainId: 1, projectId: 7n, phase: 'fund' })).rejects.toThrow('chain')
    f.state.activeController = HOOK
    await expect(readProjectSplitsSnapshot(f.rpc, { chainId: 1, projectId: 7n, phase: 'fund' })).rejects.toThrow('controller')
    f.state.activeController = f.reviewed.controller
    await expect(readProjectSplitsSnapshot(f.rpc, { chainId: 1, projectId: 7n, phase: 'income' })).rejects.toThrow('phase')
    f.state.canonicalHash = OTHER_HASH
    await expect(readProjectSplitsSnapshot(f.rpc, { chainId: 1, projectId: 7n, phase: 'fund' })).rejects.toThrow('chain changed')
  })
  it('rejects mismatched INCOME governance and malformed queue ancestry', async () => {
    const f = fixture('income')
    f.state.ownerController = HOOK
    await expect(readProjectSplitsSnapshot(f.rpc, { chainId: 1, projectId: 7n, phase: 'income' })).rejects.toThrow('controller')
    f.state.ownerController = f.reviewed.controller; f.state.metadata.useDataHookForPay = false
    await expect(readProjectSplitsSnapshot(f.rpc, { chainId: 1, projectId: 7n, phase: 'income' })).rejects.toThrow('governed')
    f.state.metadata.useDataHookForPay = true; f.state.latest.basedOnId = 110
    await expect(readProjectSplitsSnapshot(f.rpc, { chainId: 1, projectId: 7n, phase: 'income' })).rejects.toThrow('ancestry')
  })
})

describe('locked and hooked allocation protection', () => {
  it('preserves duplicate locked splits, permits extending locks, and rejects collapsing duplicates', () => {
    const g = group({ splits: [split({ percent: 200_000_000, lockedUntil: 1500 }), split({ percent: 200_000_000, lockedUntil: 1500 })] })
    const rows = drafts(g, { lockedUntil: '1600' })
    expect(buildWithGroup(g, rows).args[2][0].splits).toEqual([{ ...g.splits[0], lockedUntil: 1600 }, g.splits[1]])
    expect(() => buildWithGroup(g, rows.slice(0, 1))).toThrow('every locked split')
    expect(() => buildWithGroup(g, drafts(g, { lockedUntil: '1499' }))).toThrow('every locked split')
    expect(() => buildWithGroup(g, drafts(g, { percent: '19' }))).toThrow('every locked split')
    expect(() => buildWithGroup(g, drafts(g, { beneficiary: OWNER }))).toThrow('every locked split')
    expect(() => buildWithGroup(g, [rows[0], rows[0]])).toThrow('row no longer matches')
  })
  it('preserves inherited effective locks and allows removal at the exact expiry timestamp', () => {
    const locked = split({ lockedUntil: 1001 }), g = group({ splits: [locked], fallback: [locked] })
    expect(() => buildWithGroup(g, drafts(g, { beneficiary: OWNER }))).toThrow('locked')
    g.splits = [split({ lockedUntil: 1000 })]; g.fallback = []
    expect(buildWithGroup(g, []).args[2][0].splits).toEqual([])
  })
  it('blocks clear-to-fallback while allowing an explicit replacement or an empty verified fallback', () => {
    const g = group({ fallback: [split({ beneficiary: OWNER })] })
    expect(() => buildWithGroup(g, [])).toThrow('default recipients')
    expect(buildWithGroup(g, drafts(g, { beneficiary: DELEGATE })).args[2][0].splits[0].beneficiary).toBe(DELEGATE)
    expect(buildWithGroup(group(), []).args[2][0].splits).toEqual([])
  })
  it('keeps hook routing intact and requires explicit acknowledgment for allocation changes or removal', () => {
    const hooked = split({ hook: HOOK, projectId: 7n, beneficiary: OWNER, preferAddToBalance: true, percent: 600_000_000 })
    const g = group({ splits: [hooked, split()] })
    const rows = projectSplitDrafts(g); rows[1].beneficiary = DELEGATE
    expect(buildWithGroup(g, rows).args[2][0].splits[0]).toEqual(hooked)
    const changed = drafts(g, { percent: '50' })
    expect(() => buildWithGroup(g, changed)).toThrow('Confirm changes')
    expect(buildWithGroup(g, changed, true).args[2][0].splits[0]).toEqual({ ...hooked, percent: 500_000_000 })
    expect(() => buildWithGroup(g, rows.slice(1))).toThrow('Confirm changes')
    expect(buildWithGroup(g, rows.slice(1), true).args[2][0].splits).toHaveLength(1)
    for (const change of [{ beneficiary: DELEGATE }, { recipient: 'wallet' as const, projectId: '' }, { preferAddToBalance: false }]) expect(() => buildWithGroup(g, drafts(g, change), true)).toThrow('routing is preserved')
  })
  it('does not let hook acknowledgment override a still-active lock', () => {
    const g = group({ splits: [split({ hook: HOOK, lockedUntil: 2000 })] })
    expect(() => buildWithGroup(g, drafts(g, { percent: '30' }), true)).toThrow('locked')
  })
  it('rejects new zero beneficiaries and reserved self-routing while preserving existing zero beneficiary rows', () => {
    expect(() => buildWithGroup(group(), drafts(group(), { beneficiary: zeroAddress }))).toThrow('transaction caller')
    const empty = group({ splits: [] })
    expect(() => buildWithGroup(empty, [{ ...drafts()[0], sourceIndex: undefined, beneficiary: zeroAddress }])).toThrow('transaction caller')
    const existingZero = group({ splits: [split({ beneficiary: zeroAddress })] })
    expect(buildWithGroup(existingZero, drafts(existingZero, { percent: '30' })).args[2][0].splits[0].beneficiary).toBe(zeroAddress)
    expect(() => buildWithGroup(group(), drafts(group(), { recipient: 'project', projectId: '7' }))).toThrow('own project')
    const otherProject = buildWithGroup(group(), drafts(group(), { recipient: 'project', projectId: '8' }))
    expect(otherProject.args[2][0].splits[0]).toMatchObject({ projectId: 8n, preferAddToBalance: false })
  })
  it('offers add-to-balance only for payout routing and preserves existing reserved flags', () => {
    expect(() => buildWithGroup(group(), drafts(group(), { recipient: 'project', projectId: '8', preferAddToBalance: true }))).toThrow('applies to payouts')
    const saved = group({ splits: [split({ preferAddToBalance: true })] })
    expect(buildWithGroup(saved, drafts(saved, { percent: '30' })).args[2][0].splits[0].preferAddToBalance).toBe(true)
    const reviewed = snapshot(), target = reviewed.stages[0].groups[1]
    const request = buildProjectSplitsTx(reviewed, 90n, ETH_PAYOUTS, drafts(target, { recipient: 'project', projectId: '8', preferAddToBalance: true }))
    expect(request.args[2][0].splits[0]).toMatchObject({ projectId: 8n, preferAddToBalance: true })
  })
  it('requires explicit confirmation for new or increased reserved-token burns', () => {
    const reviewed = snapshot(), target = reviewed.stages[0].groups[0]
    const rows = drafts(target, { beneficiary: RESERVED_TOKEN_BURN_ADDRESS })
    expect(() => buildProjectSplitsTx(reviewed, 90n, RESERVED, rows)).toThrow('Confirm burning')
    expect(buildProjectSplitsTx(reviewed, 90n, RESERVED, rows, { allowBurn: true }).args[2][0].splits[0].beneficiary).toBe(RESERVED_TOKEN_BURN_ADDRESS)
    target.splits = [split({ beneficiary: RESERVED_TOKEN_BURN_ADDRESS })]
    expect(() => buildProjectSplitsTx(reviewed, 90n, RESERVED, drafts(target, { percent: '50' }))).toThrow('Confirm burning')
    expect(() => buildProjectSplitsTx(reviewed, 90n, RESERVED, drafts(target, { percent: '30' }))).not.toThrow()
  })
  it('distinguishes controller burns from payout, project and hook routing to the same address', () => {
    const burn = split({ beneficiary: RESERVED_TOKEN_BURN_ADDRESS })
    expect(isReservedTokenBurn(burn, 'reserved')).toBe(true)
    expect(isReservedTokenBurn(burn, 'payout')).toBe(false)
    expect(isReservedTokenBurn({ ...burn, projectId: 8n }, 'reserved')).toBe(false)
    expect(isReservedTokenBurn({ ...burn, hook: HOOK }, 'reserved')).toBe(false)
    const reviewed = snapshot(), target = reviewed.stages[0].groups[1]
    expect(() => buildProjectSplitsTx(reviewed, 90n, ETH_PAYOUTS, drafts(target, { beneficiary: RESERVED_TOKEN_BURN_ADDRESS }))).not.toThrow()
  })
})

describe('split review revalidation', () => {
  it.each([
    { chainId: 10 }, { projectId: 8n }, { phase: 'income' }, { blockNumber: 99n }, { blockHash: OTHER_HASH },
    { owner: DELEGATE }, { controller: HOOK }, { account: DELEGATE }, { account: null }, { canEdit: false }, { currentRulesetId: 100n },
  ])('rejects changed authority, chain or project identity %#', change => {
    expect(() => assertSameProjectSplitsSnapshot(snapshot(), { ...snapshot(), ...change } as ProjectSplitsSnapshot, 110n, RESERVED)).toThrow('changed during review')
  })
  it('allows a newer unchanged snapshot, but requires review of schedule and reserved-share changes', () => {
    expect(() => assertSameProjectSplitsSnapshot(snapshot(), { ...snapshot(), blockNumber: 101n, blockHash: OTHER_HASH }, 110n, RESERVED)).not.toThrow()
    for (const change of [{ rulesetId: 120n }, { start: 1250n }, { reservedPercent: 7000 }]) {
      const latest = snapshot(); Object.assign(latest.stages[2], change)
      expect(() => assertSameProjectSplitsSnapshot(snapshot(), latest, 110n, RESERVED)).toThrow()
    }
    const latest = snapshot(); latest.stages.pop()
    expect(() => assertSameProjectSplitsSnapshot(snapshot(), latest, 110n, RESERVED)).toThrow()
  })
  it.each(['beneficiary', 'hook', 'projectId', 'percent', 'lockedUntil', 'preferAddToBalance'] as const)('rejects changed selected split %s and changed fallback', field => {
    const latest = snapshot(), selected = latest.stages[2].groups[0]
    selected.splits = [{ ...selected.splits[0], [field]: field === 'percent' || field === 'lockedUntil' ? 123 : field === 'projectId' ? 8n : field === 'preferAddToBalance' ? true : DELEGATE }]
    expect(() => assertSameProjectSplitsSnapshot(snapshot(), latest, 110n, RESERVED)).toThrow()
    const fallback = snapshot(); fallback.stages[2].groups[0].fallback = [split({ beneficiary: OWNER })]
    expect(() => assertSameProjectSplitsSnapshot(snapshot(), fallback, 110n, RESERVED)).toThrow()
  })
  it('does not overwrite unrelated stages or groups when their recipients change during review', () => {
    const latest = snapshot()
    latest.stages[0].groups[0].splits = [split({ beneficiary: OWNER })]
    latest.stages[2].groups[1].splits = [split({ beneficiary: DELEGATE })]
    expect(() => assertSameProjectSplitsSnapshot(snapshot(), latest, 110n, RESERVED)).not.toThrow()
  })
})
