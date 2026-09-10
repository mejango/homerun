import { describe, expect, it, vi } from 'vitest'
import { USDC_ADDRESSES, jbContractAddress, type JBChainId } from '@bananapus/nana-sdk-core'
import {
  JBPermissionIdsV6,
  RESERVED_TOKEN_SPLIT_GROUP_ID,
  buildTerminalConfigurations,
  payoutSplitGroupId,
  v6Address,
  type JBRuleset,
} from '@bananapus/nana-sdk-core/v6'
import { padHex, zeroAddress, type Address, type Hex, type PublicClient } from 'viem'
import { buildFundRulesetChange, initialFundRuleset } from '../src/lib/fund-contracts'
import { assertFundStateForWrite, readFundProjectState, readLinkedFundProjects } from '../src/lib/fund-state'

const OWNER = '0x1111111111111111111111111111111111111111' as const
const DELEGATE = '0x2222222222222222222222222222222222222222' as const
const TOKEN = '0x3333333333333333333333333333333333333333' as const
const LOCAL_SUCKER = '0x4444444444444444444444444444444444444444' as const
const REMOTE_SUCKER = '0x5555555555555555555555555555555555555555' as const
const TIER_HOOK = '0x6666666666666666666666666666666666666666' as const
const HASH = `0x${'ab'.repeat(32)}` as Hex
const REORG_HASH = `0x${'cd'.repeat(32)}` as Hex
const PROJECT_ID = 7n
const PERMISSION_IDS = [
  JBPermissionIdsV6.QUEUE_RULESETS,
  JBPermissionIdsV6.MINT_TOKENS,
  JBPermissionIdsV6.USE_ALLOWANCE,
  JBPermissionIdsV6.SEND_PAYOUTS,
  JBPermissionIdsV6.DEPLOY_ERC20,
  JBPermissionIdsV6.SET_PROJECT_URI,
]

type ReadRequest = { address: Address; functionName: string; args?: readonly unknown[]; blockNumber?: bigint }
type Pair = { local: Address; remote: Hex; remoteChainId: bigint }
type FixtureOptions = {
  chainId?: JBChainId
  projectId?: bigint
  blockNumber?: bigint
  owner?: Address
  controller?: Address
  token?: Address
  upcomingId?: number
  queuedId?: number
  peers?: Pair[]
  fail?: string
  values?: Record<string, unknown>
  allowedPermissions?: number[]
  omnichain?: boolean
  bridge?: { address: Address; peer: Address; peerChainId: number; projectId?: bigint }
}

/** Only modeled canonical calls are accepted; an accidental extra read fails loudly. */
function rpcFixture(options: FixtureOptions = {}) {
  const chainId = options.chainId ?? 1
  const projectId = options.projectId ?? PROJECT_ID
  const blockNumber = options.blockNumber ?? 12345n
  const owner = options.owner ?? OWNER
  const token = options.token ?? TOKEN
  const terminal = v6Address('JBMultiTerminal', chainId)
  const controller = v6Address('JBController', chainId)
  const terminalStore = v6Address('JBTerminalStore', chainId)
  const metadata = { ...initialFundRuleset().metadata, holdFees: true, metadata: 64 }
  if (options.omnichain) {
    metadata.dataHook = v6Address('JBOmnichainDeployer', chainId)
    metadata.useDataHookForPay = true
    metadata.useDataHookForCashOut = true
  }
  const ruleset: JBRuleset = {
    cycleNumber: 1, id: 71, basedOnId: 0, start: 1_800_000_000, duration: 0,
    weight: initialFundRuleset().weight, weightCutPercent: 0, approvalHook: zeroAddress, metadata: 0n,
  }
  const context = { token: USDC_ADDRESSES[chainId], decimals: 6, currency: 2 }
  const payoutLimits = [{ amount: 8_000_000n, currency: 2 }]
  const surplusAllowances = [{ amount: 500_000n, currency: 2 }]
  const reservedSplits = [{ percent: 100_000_000, projectId: 0n, beneficiary: OWNER, preferAddToBalance: false, lockedUntil: 0, hook: zeroAddress }]
  const payoutSplits = [{ percent: 500_000_000, projectId: 123n, beneficiary: DELEGATE, preferAddToBalance: true, lockedUntil: 1_800_000_001, hook: zeroAddress }]
  const rows = new Map<string, { args?: readonly unknown[]; result: unknown }>()
  const key = (address: Address, name: string) => `${address.toLowerCase()}:${name}`
  const add = (address: Address, name: string, result: unknown, args?: readonly unknown[]) => {
    rows.set(key(address, name), { args, result })
  }
  add(v6Address('JBProjects', chainId), 'ownerOf', owner, [projectId])
  add(v6Address('JBDirectory', chainId), 'controllerOf', options.controller ?? controller, [projectId])
  add(v6Address('JBDirectory', chainId), 'terminalsOf', [terminal], [projectId])
  add(controller, 'currentRulesetOf', [ruleset, metadata], [projectId])
  add(controller, 'upcomingRulesetOf', [{ ...ruleset, id: options.upcomingId ?? 0 }, metadata], [projectId])
  add(controller, 'latestQueuedRulesetOf', [{ ...ruleset, id: options.queuedId ?? ruleset.id }, metadata, 1], [projectId])
  add(controller, 'pendingReservedTokenBalanceOf', 40n, [projectId])
  add(controller, 'totalTokenSupplyWithReservedTokensOf', 1040n, [projectId])
  add(controller, 'uriOf', 'ipfs://canonical-fund-metadata', [projectId])
  add(v6Address('JBTokens', chainId), 'tokenOf', token, [projectId])
  add(v6Address('JBTokens', chainId), 'totalSupplyOf', 1000n, [projectId])
  add(v6Address('JBTokens', chainId), 'totalCreditSupplyOf', 700n, [projectId])
  add(v6Address('JBTokens', chainId), 'creditBalanceOf', 30n)
  add(v6Address('JBTokens', chainId), 'totalBalanceOf', token === zeroAddress ? 30n : 50n)
  add(v6Address('JBSuckerRegistry', chainId), 'suckerPairsOf', options.peers ?? [], [projectId])
  add(terminal, 'accountingContextsOf', [context], [projectId])
  add(v6Address('JBDirectory', chainId), 'primaryTerminalOf', terminal, [projectId, context.token])
  add(terminalStore, 'balanceOf', 12_345_678n, [terminal, projectId, context.token])
  add(terminal, 'currentSurplusOf', 4_345_678n, [projectId, [context.token], 6n, 2n])
  add(v6Address('JBFundAccessLimits', chainId), 'payoutLimitsOf', payoutLimits, [projectId, 71n, terminal, context.token])
  add(v6Address('JBFundAccessLimits', chainId), 'surplusAllowancesOf', surplusAllowances, [projectId, 71n, terminal, context.token])
  add(token, 'symbol', 'REALFUND')
  add(token, 'decimals', 18)
  add(token, 'balanceOf', 20n)
  if (options.omnichain) {
    add(metadata.dataHook, 'extraDataHookOf', { dataHook: zeroAddress, useDataHookForPay: false, useDataHookForCashOut: false }, [projectId, 71n])
    add(metadata.dataHook, 'tiered721HookOf', [TIER_HOOK, false], [projectId, 71n])
    add(TIER_HOOK, 'STORE', v6Address('JB721TiersHookStore', chainId))
    add(TIER_HOOK, 'projectId', projectId)
    add(TIER_HOOK, 'jbOwner', [zeroAddress, projectId, 0])
    add(TIER_HOOK, 'owner', owner)
    add(v6Address('JB721TiersHookStore', chainId), 'maxTierIdOf', 0n, [TIER_HOOK])
  }
  if (options.bridge) {
    add(options.bridge.address, 'projectId', options.bridge.projectId ?? projectId)
    add(options.bridge.address, 'peer', padHex(options.bridge.peer, { size: 32 }))
    add(options.bridge.address, 'peerChainId', BigInt(options.bridge.peerChainId))
  }
  const readContract = vi.fn(async (request: ReadRequest): Promise<unknown> => {
    // Tests deliberately use distinct heads on each chain.
    expect(request.blockNumber).toBe(blockNumber)
    const label = request.functionName === 'balanceOf'
      ? request.address.toLowerCase() === terminalStore.toLowerCase() ? 'terminalBalance' : 'erc20Balance'
      : request.functionName
    if (options.fail === label) throw new Error(`RPC unavailable: ${label}`)
    if (request.functionName === 'hasPermission') {
      expect(request.address).toBe(v6Address('JBPermissions', chainId))
      expect(request.args).toEqual([DELEGATE, owner, projectId, expect.any(BigInt), true, true])
      return (options.allowedPermissions ?? []).includes(Number(request.args![3]))
    }
    if (request.functionName === 'splitsOf') {
      expect(request.address).toBe(v6Address('JBSplits', chainId))
      expect(request.args?.slice(0, 2)).toEqual([projectId, 71n])
      const groupId = request.args![2]
      if (groupId === RESERVED_TOKEN_SPLIT_GROUP_ID) return reservedSplits
      expect(groupId).toBe(payoutSplitGroupId(context.token))
      return payoutSplits
    }
    const row = rows.get(key(request.address, request.functionName))
    if (!row) throw new Error(`Unexpected RPC read: ${request.address}.${request.functionName}`)
    if (row.args) expect(request.args).toEqual(row.args)
    if (Object.hasOwn(options.values ?? {}, label)) return options.values![label]
    return row.result
  })
  const getBlock = vi.fn(async (_request: { blockTag?: string; blockNumber?: bigint }) => ({ number: blockNumber, hash: HASH, timestamp: 1_800_000_100n }))
  const getChainId = vi.fn(async () => chainId)
  const client = { chain: { id: chainId }, getChainId, getBlock, readContract } as unknown as PublicClient
  return { client, chainId, projectId, blockNumber, readContract, getBlock, getChainId, ruleset, metadata, context, terminal, payoutLimits, surplusAllowances, reservedSplits, payoutSplits }
}

function read(fixture: ReturnType<typeof rpcFixture>, account: Address | undefined = DELEGATE) {
  return readFundProjectState(fixture.client, { chainId: fixture.chainId, projectId: fixture.projectId, account })
}

describe('readFundProjectState', () => {
  it('pins every canonical read and preserves the full onchain configuration and exact balances', async () => {
    const fixture = rpcFixture()
    const state = await read(fixture)
    expect(fixture.getBlock.mock.calls).toEqual([[{ blockTag: 'latest' }], [{ blockNumber: fixture.blockNumber }]])
    expect(fixture.readContract.mock.calls.length).toBeGreaterThan(25)
    expect(fixture.readContract.mock.calls.every(([request]) => request.blockNumber === fixture.blockNumber)).toBe(true)
    expect(state).toMatchObject({
      owner: OWNER, operator: OWNER, account: DELEGATE, blockHash: HASH,
      blockNumber: fixture.blockNumber, blockTimestamp: 1_800_000_100n,
      tokenAddress: TOKEN, tokenSymbol: 'REALFUND', tokenDecimals: 18,
      totalSupply: 1000n, totalCreditSupply: 700n, pendingReservedTokens: 40n,
      totalSupplyWithReservedTokens: 1040n, creditBalance: 30n, erc20Balance: 20n, totalBalance: 50n,
      hasPendingRuleset: false, linkedProjects: [{ chainId: 1, projectId: PROJECT_ID }], issues: [],
    })
    expect(state.accountingContexts).toEqual([{
      ...fixture.context, terminal: fixture.terminal, primaryTerminal: fixture.terminal,
      isPrimary: true, symbol: 'USDC', balance: 12_345_678n, surplus: 4_345_678n,
      payoutLimits: fixture.payoutLimits, surplusAllowances: fixture.surplusAllowances,
    }])
    expect(state.rulesetSnapshot.configuration).toEqual({
      mustStartAtOrAfter: fixture.ruleset.start, duration: 0, weight: fixture.ruleset.weight,
      weightCutPercent: 0, approvalHook: zeroAddress, metadata: fixture.metadata,
      splitGroups: [
        { groupId: RESERVED_TOKEN_SPLIT_GROUP_ID, splits: fixture.reservedSplits },
        { groupId: payoutSplitGroupId(fixture.context.token), splits: fixture.payoutSplits },
      ],
      fundAccessLimitGroups: [{ terminal: fixture.terminal, token: fixture.context.token, payoutLimits: fixture.payoutLimits, surplusAllowances: fixture.surplusAllowances }],
    })
    expect(() => assertFundStateForWrite(state, DELEGATE)).not.toThrow()
    expect(() => assertFundStateForWrite(state, OWNER)).toThrow(/reconnect the wallet/i)
  })

  it('uses the actual NFT owner directly without requiring delegated permissions', async () => {
    const fixture = rpcFixture({ fail: 'hasPermission' })
    const state = await read(fixture, OWNER)
    expect(Object.values(state.permissions)).toEqual([true, true, true, true, true, true])
    expect(fixture.readContract.mock.calls.some(([request]) => request.functionName === 'hasPermission')).toBe(false)
  })

  it('checks each delegate permission live against the owner and project, including root and wildcard grants', async () => {
    const fixture = rpcFixture({ allowedPermissions: [JBPermissionIdsV6.MINT_TOKENS, JBPermissionIdsV6.SEND_PAYOUTS] })
    const state = await read(fixture)
    const requests = fixture.readContract.mock.calls.map(([request]) => request).filter(request => request.functionName === 'hasPermission')
    expect(requests.map(request => request.args)).toEqual(PERMISSION_IDS.map(id => [DELEGATE, OWNER, PROJECT_ID, BigInt(id), true, true]))
    expect(state.permissions).toEqual({ queueRulesets: false, mintTokens: true, useAllowance: false, sendPayouts: true, deployErc20: false, setProjectUri: false })
  })

  it('returns no wallet authority when disconnected and does not invent holder reads', async () => {
    const fixture = rpcFixture()
    const state = await readFundProjectState(fixture.client, { chainId: 1, projectId: PROJECT_ID })
    expect(state.account).toBeNull()
    expect([state.creditBalance, state.erc20Balance, state.totalBalance]).toEqual([0n, 0n, 0n])
    expect(Object.values(state.permissions).every(value => value === false)).toBe(true)
    expect(fixture.readContract.mock.calls.some(([request]) => ['creditBalanceOf', 'totalBalanceOf', 'hasPermission'].includes(request.functionName))).toBe(false)
    expect(() => assertFundStateForWrite(state, OWNER)).toThrow(/reconnect the wallet/i)
  })

  it('accounts for a project that has only Juicebox credits', async () => {
    const fixture = rpcFixture({ token: zeroAddress })
    const state = await read(fixture)
    expect(state).toMatchObject({ tokenAddress: null, tokenSymbol: 'FUND', tokenDecimals: 18, creditBalance: 30n, erc20Balance: 0n, totalBalance: 30n })
    expect(fixture.readContract.mock.calls.some(([request]) => request.address === zeroAddress)).toBe(false)
  })

  it.each([
    'ownerOf', 'controllerOf', 'terminalsOf', 'currentRulesetOf', 'upcomingRulesetOf', 'latestQueuedRulesetOf',
    'tokenOf', 'totalSupplyOf', 'totalCreditSupplyOf', 'pendingReservedTokenBalanceOf', 'totalTokenSupplyWithReservedTokensOf',
    'suckerPairsOf', 'accountingContextsOf', 'primaryTerminalOf', 'terminalBalance', 'currentSurplusOf',
    'payoutLimitsOf', 'surplusAllowancesOf', 'splitsOf', 'decimals', 'creditBalanceOf', 'erc20Balance', 'totalBalanceOf', 'hasPermission',
  ])('rejects a failed required %s read instead of returning plausible zero state', async fail => {
    await expect(read(rpcFixture({ fail }))).rejects.toThrow(`RPC unavailable: ${fail}`)
  })

  it.each(['uriOf', 'symbol'])('permits only display metadata fallback after a failed %s read', async fail => {
    const state = await read(rpcFixture({ fail }))
    expect(state.totalBalance).toBe(50n)
    expect(state.totalSupplyWithReservedTokens).toBe(1040n)
    expect(fail === 'uriOf' ? state.projectUri : state.tokenSymbol).toBe(fail === 'uriOf' ? '' : 'FUND')
  })

  it.each([
    { upcomingId: 71, queuedId: 72 },
    { upcomingId: 72, queuedId: 0 },
    { upcomingId: 72, queuedId: 71 },
  ])('marks pending rulesets from both current and latest queue views: %j', async options => {
    const state = await read(rpcFixture(options))
    expect(state.hasPendingRuleset).toBe(true)
    expect(state.rulesetSnapshot.upcomingRulesetId).toBe(72n)
    expect(() => buildFundRulesetChange({ snapshots: [state.rulesetSnapshot], action: 'pause', mustStartAtOrAfter: 1_800_000_200 })).toThrow(/already queued ruleset/i)
  })

  it('does not mislabel the current ruleset as a pending configuration', async () => {
    const state = await read(rpcFixture({ upcomingId: 71, queuedId: 71, values: { payoutLimitsOf: [], surplusAllowancesOf: [] } }))
    expect(state.hasPendingRuleset).toBe(false)
    expect(state.rulesetSnapshot.upcomingRulesetId).toBe(0n)
    expect(buildFundRulesetChange({ snapshots: [state.rulesetSnapshot], action: 'pause', mustStartAtOrAfter: 1_800_000_200 }).configurations[0].metadata.pausePay).toBe(true)
  })

  it('disables all permissions and rejects writes for an unsupported controller even for the owner', async () => {
    const fixture = rpcFixture({ controller: DELEGATE })
    const state = await read(fixture, OWNER)
    expect(state.supportedController).toBe(false)
    expect(state.rulesetSnapshot.configuration).toBeNull()
    expect(Object.values(state.permissions).every(value => value === false)).toBe(true)
    expect(state.issues).toContain('This project uses a different controller. FUND transactions are unavailable.')
    expect(() => assertFundStateForWrite(state, OWNER)).toThrow(/not supported/i)
  })

  it('supports the actual SDK launch terminals and counts only the canonical treasury context', async () => {
    const configurations = buildTerminalConfigurations({
      chainId: 1,
      accountingContexts: [{ token: USDC_ADDRESSES[1], decimals: 6, currency: 2 }],
    })
    const terminals = configurations.map(configuration => configuration.terminal)
    expect(terminals).toEqual([v6Address('JBMultiTerminal', 1), v6Address('JBRouterTerminalRegistry', 1)])
    const fixture = rpcFixture({ values: { terminalsOf: terminals } })
    const state = await read(fixture, OWNER)
    expect(state.supportedTerminals).toBe(true)
    expect(state.rulesetSnapshot.configuration).not.toBeNull()
    expect(() => assertFundStateForWrite(state, OWNER)).not.toThrow()
    expect(state.accountingContexts).toHaveLength(1)
    expect(state.accountingContexts[0]).toMatchObject({ ...fixture.context, terminal: fixture.terminal, balance: 12_345_678n })
    const contextReads = fixture.readContract.mock.calls.map(([request]) => request)
      .filter(request => request.functionName === 'accountingContextsOf')
    expect(contextReads).toHaveLength(1)
    expect(contextReads[0].address).toBe(fixture.terminal)
    expect(fixture.readContract.mock.calls.some(([request]) => request.address === v6Address('JBRouterTerminalRegistry', 1))).toBe(false)
  })

  it('rejects writes when an unknown terminal accompanies the supported SDK launch terminals', async () => {
    const terminals = buildTerminalConfigurations({
      chainId: 1,
      accountingContexts: [{ token: USDC_ADDRESSES[1], decimals: 6, currency: 2 }],
    }).map(configuration => configuration.terminal)
    const state = await read(rpcFixture({ values: { terminalsOf: [...terminals, DELEGATE] } }), OWNER)
    expect(state.supportedTerminals).toBe(false)
    expect(state.rulesetSnapshot.configuration).toBeNull()
    expect(() => assertFundStateForWrite(state, OWNER)).toThrow(/not supported/i)
  })

  it('does not treat REVOwner operator powers as ownership of a FUND', async () => {
    const revOwner = (jbContractAddress['6'] as Record<string, Record<number, Address>>).REVOwner[1]
    const state = await read(rpcFixture({ owner: revOwner }), revOwner)
    expect(state.knownOwnerWrapper).toBe(false)
    expect(Object.values(state.permissions).every(value => value === false)).toBe(true)
    expect(() => assertFundStateForWrite(state, revOwner)).toThrow(/not supported/i)
  })

  it.each([
    { name: 'holder balance', values: { totalBalanceOf: 49n } },
    { name: 'pending reserved supply', values: { totalTokenSupplyWithReservedTokensOf: 1000n } },
  ])('rejects inconsistent $name accounting', async ({ values }) => {
    await expect(read(rpcFixture({ values }))).rejects.toThrow(/inconsistent project token accounting/i)
  })

  it('proves a recorded omnichain NFT hook has no tiers and is scoped to the current owner and project', async () => {
    const fixture = rpcFixture({ omnichain: true, values: { payoutLimitsOf: [], surplusAllowancesOf: [] } })
    const state = await read(fixture)
    expect(state.rulesetSnapshot.configuration).not.toBeNull()
    expect(state.rulesetSnapshot.omnichainHooks).toEqual({
      dataHook: zeroAddress, useDataHookForPay: false, useDataHookForCashOut: false,
      tiered721Hook: TIER_HOOK, tiered721UseDataHookForCashOut: false, tiered721HasTiers: false,
    })
    const hookReads = fixture.readContract.mock.calls.map(([request]) => request)
      .filter(request => ['extraDataHookOf', 'tiered721HookOf', 'STORE', 'projectId', 'jbOwner', 'owner', 'maxTierIdOf'].includes(request.functionName))
    expect(hookReads).toHaveLength(7)
    expect(hookReads.every(request => request.blockNumber === fixture.blockNumber)).toBe(true)
    const { configurations } = buildFundRulesetChange({ snapshots: [state.rulesetSnapshot], action: 'pause', mustStartAtOrAfter: 1_800_000_200 })
    expect(configurations[0].metadata.dataHook).toBe(zeroAddress)
  })

  it('withholds editable configuration when the recorded NFT hook has live tiers', async () => {
    const state = await read(rpcFixture({ omnichain: true, values: { maxTierIdOf: 1n } }))
    expect(state.rulesetSnapshot.configuration).toBeNull()
    expect(state.rulesetSnapshot.omnichainHooks?.tiered721HasTiers).toBe(true)
  })

  it.each([
    { name: 'store', values: { STORE: DELEGATE } },
    { name: 'project', values: { projectId: 999n } },
    { name: 'owner scope', values: { jbOwner: [zeroAddress, 999n, 0] } },
    { name: 'owner', values: { owner: DELEGATE } },
  ])('rejects a recorded NFT hook with an unrelated $name', async ({ values }) => {
    await expect(read(rpcFixture({ omnichain: true, values }))).rejects.toThrow(/NFT hook is not scoped/i)
  })

  it('preserves the absence of withdrawal limits without creating empty access-limit groups', async () => {
    const fixture = rpcFixture({ values: { payoutLimitsOf: [], surplusAllowancesOf: [] } })
    const state = await read(fixture)
    expect(state.rulesetSnapshot.configuration?.fundAccessLimitGroups).toEqual([])
    expect(state.rulesetSnapshot.accountingContexts).toEqual([{ terminal: fixture.terminal, ...fixture.context }])
    const contextReads = fixture.readContract.mock.calls.map(([request]) => request)
      .filter(request => request.functionName === 'accountingContextsOf')
    expect(contextReads).toHaveLength(1)
    expect(contextReads[0].blockNumber).toBe(state.rulesetSnapshot.blockNumber)
  })

  it('rejects a changed block hash after the pinned reads', async () => {
    const fixture = rpcFixture()
    fixture.getBlock.mockResolvedValueOnce({ number: fixture.blockNumber, hash: HASH, timestamp: 1_800_000_100n })
      .mockResolvedValueOnce({ number: fixture.blockNumber, hash: REORG_HASH, timestamp: 1_800_000_100n })
    await expect(read(fixture)).rejects.toThrow(/chain changed during the project read/i)
  })

  it('rejects a misconfigured RPC endpoint before reading any contracts', async () => {
    const fixture = rpcFixture()
    fixture.getChainId.mockResolvedValue(10)
    await expect(read(fixture)).rejects.toThrow(/RPC endpoint returned a different chain/i)
    expect(fixture.readContract).not.toHaveBeenCalled()
  })
})

function linkedFixtures(remoteOptions: FixtureOptions = {}) {
  const local = rpcFixture({
    chainId: 1, projectId: 7n, blockNumber: 12345n,
    peers: [{ local: LOCAL_SUCKER, remote: padHex(REMOTE_SUCKER, { size: 32 }), remoteChainId: 10n }],
    bridge: { address: LOCAL_SUCKER, peer: REMOTE_SUCKER, peerChainId: 10 },
  })
  const remote = rpcFixture({
    chainId: 10, projectId: 901n, blockNumber: 54321n,
    peers: [{ local: REMOTE_SUCKER, remote: padHex(LOCAL_SUCKER, { size: 32 }), remoteChainId: 1n }],
    bridge: { address: REMOTE_SUCKER, peer: LOCAL_SUCKER, peerChainId: 1 },
    ...remoteOptions,
  })
  const clientForChainId = vi.fn((chainId: JBChainId) => {
    if (chainId === 1) return local.client
    if (chainId === 10) return remote.client
    throw new Error(`Unexpected linked chain ${chainId}`)
  })
  return { local, remote, clientForChainId }
}

describe('readLinkedFundProjects', () => {
  it('resolves different project IDs from reciprocal registered bridges and pins each chain independently', async () => {
    const { local, remote, clientForChainId } = linkedFixtures()
    const states = await readLinkedFundProjects(clientForChainId, await read(local))
    const membership = [{ chainId: 1, projectId: 7n }, { chainId: 10, projectId: 901n }]
    expect(states.map(state => ({ chainId: state.chainId, projectId: state.projectId }))).toEqual(membership)
    expect(states.every(state => state.linkedProjects.length === 2)).toBe(true)
    for (const state of states) {
      expect(state.linkedProjects).toEqual(membership)
      expect(state.linkedChainIds).toEqual([1, 10])
    }
    expect(states.map(state => state.blockNumber)).toEqual([12345n, 54321n])
    for (const fixture of [local, remote]) {
      expect(fixture.readContract.mock.calls.every(([request]) => request.blockNumber === fixture.blockNumber)).toBe(true)
      const bridgeReads = fixture.readContract.mock.calls.map(([request]) => request).filter(request => ['projectId', 'peer', 'peerChainId'].includes(request.functionName))
      expect(new Set(bridgeReads.map(request => request.functionName))).toEqual(new Set(['projectId', 'peer', 'peerChainId']))
    }
    expect(remote.readContract.mock.calls.some(([request]) => request.functionName === 'ownerOf' && request.args?.[0] === 901n)).toBe(true)
    expect(remote.readContract.mock.calls.some(([request]) => request.functionName === 'ownerOf' && request.args?.[0] === 7n)).toBe(false)
  })

  it.each([
    { name: 'missing reciprocal registry entry', options: { peers: [] } },
    { name: 'different peer address', options: { bridge: { address: REMOTE_SUCKER, peer: DELEGATE, peerChainId: 1 } } },
    { name: 'different peer chain', options: { bridge: { address: REMOTE_SUCKER, peer: LOCAL_SUCKER, peerChainId: 8453 } } },
  ])('rejects a linked project with $name', async ({ options }) => {
    const { local, clientForChainId } = linkedFixtures(options)
    await expect(readLinkedFundProjects(clientForChainId, await read(local))).rejects.toThrow(/reciprocal registered bridge/i)
  })

  it('rejects a remote sucker that changes its project between discovery and the pinned validation', async () => {
    const { local, remote, clientForChainId } = linkedFixtures()
    const implementation = remote.readContract.getMockImplementation()!
    let discovery = true
    remote.readContract.mockImplementation(async request => {
      const value = await implementation(request)
      if (request.functionName === 'projectId') {
        if (!discovery) return 902n
        discovery = false
      }
      return value
    })
    await expect(readLinkedFundProjects(clientForChainId, await read(local))).rejects.toThrow(/reciprocal registered bridge/i)
  })

  it('rejects a remote chain reorg after validating the reciprocal bridge', async () => {
    const { local, remote, clientForChainId } = linkedFixtures()
    let pinnedChecks = 0
    remote.getBlock.mockImplementation(async request => {
      if (request.blockNumber !== undefined) pinnedChecks++
      return { number: remote.blockNumber, hash: pinnedChecks >= 2 ? REORG_HASH : HASH, timestamp: 1_800_000_100n }
    })
    await expect(readLinkedFundProjects(clientForChainId, await read(local))).rejects.toThrow(/remote chain changed during the project read/i)
  })
})
