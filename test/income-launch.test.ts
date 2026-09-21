import { beforeEach, describe, expect, it, vi } from 'vitest'
import { decodeFunctionData, encodeAbiParameters, encodeFunctionData, getAddress, keccak256, parseAbiParameters, zeroAddress, zeroHash, type Address, type Hex, type PublicClient } from 'viem'
import type { FundProjectState } from '../src/lib/fund-state'
import type { FundGlobalManifest } from '../src/lib/fund-global-manifest'
import type { InitialIncomeAllocationState } from '../src/lib/income-initial-allocation'
import type { FundGlobalSnapshot } from '../src/lib/fund-global-snapshot'

const runtime = vi.hoisted(() => ({
  launcher: '0x0000000000000000000000000000000000000200' as Address,
  allowlist: '0x0000000000000000000000000000000000000400' as Address,
  state: {} as FundProjectState,
  remoteStates: new Map<number, FundProjectState>(),
  allocationManifest: null as FundGlobalManifest | null, allocation: vi.fn(),
}))
vi.mock('@bananapus/nana-sdk-core', async importOriginal => {
  const actual = await importOriginal<typeof import('@bananapus/nana-sdk-core')>()
  return { ...actual, jbContractAddress: { ...actual.jbContractAddress, '6': { ...actual.jbContractAddress['6'], HomerunDeployer: { 8453: runtime.launcher, 10: runtime.launcher }, HomerunAllowlistHook: { 8453: runtime.allowlist, 10: runtime.allowlist } } } }
})
vi.mock('../src/lib/fund-state', () => ({ readFundProjectState: vi.fn((_client, { chainId }) => runtime.remoteStates.get(chainId) ?? runtime.state) }))
vi.mock('../src/lib/income-initial-allocation', async importOriginal => ({ ...await importOriginal<typeof import('../src/lib/income-initial-allocation')>(), readInitialIncomeAllocation: runtime.allocation }))
vi.mock('../src/lib/fund-global-manifest', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/lib/fund-global-manifest')>()
  return { ...actual, verifyFundGlobalManifestHistory: vi.fn(async (_clients, value) => actual.parseFundGlobalManifest(value)) }
})
import { MappableAsset, parseSuckerDeployerConfig, USDC_ADDRESSES, type JBChainId } from '@bananapus/nana-sdk-core'
import { v6Address } from '@bananapus/nana-sdk-core/v6'
import { incomeConfigurationHash, incomeConfigurationSalt, incomeLaunchBlockers, prepareIncomeLaunch, readIncomeLaunchBinding } from '../src/lib/income-launch'
import { buildFundGlobalManifest, fundGlobalManifestHash, globalIncomeSnapshotParameters, verifyFundGlobalManifestHistory } from '../src/lib/fund-global-manifest'
import { homerunDeployerAbi, INITIAL_INCOME_SUPPLY } from '../src/lib/income-contracts'
import { readFundProjectState } from '../src/lib/fund-state'
import { HOMERUN_DEPLOYER } from '../src/lib/homerun-addresses'

const holder = getAddress('0x0000000000000000000000000000000000000011')
const token = getAddress('0x0000000000000000000000000000000000000022')
const other = getAddress('0x0000000000000000000000000000000000000033')
const hash = `0x${'aa'.repeat(32)}` as Hex
const snapshotHash = `0x${'bb'.repeat(32)}` as Hex
const salt = `0x${'cc'.repeat(32)}` as Hex
const startsAtOrAfter = 1_799_999_900
const defaultSplits = [
  { percent: 1_000_000_000, projectId: 0n, beneficiary: holder, preferAddToBalance: false, lockedUntil: 0, hook: zeroAddress },
]
function globalSnapshot(chains: JBChainId[] = [8453], emptyLocal = false): FundGlobalSnapshot {
  const projects = chains.map(chainId => {
    const supply = emptyLocal && chainId === 8453 ? 0n : 100n
    const projectId = chainId === 8453 ? 7n : 17n
    return {
      chainId, projectId, blockNumber: 50n, blockHash: snapshotHash, blockTimestamp: 1_799_999_000n,
      creationBlockNumber: 10n, creationTransactionHash: hash, owner: holder, tokenAddress: token, controller: v6Address('JBController', chainId), historicalSuckers: [],
      totalFundSupply: supply, totalCreditSupply: supply * 3n / 10n, totalErc20Supply: supply * 7n / 10n,
      holders: supply ? [{ holder, balance: supply, creditBalance: supply * 3n / 10n, erc20Balance: supply * 7n / 10n }] : [],
      evidence: { projects: v6Address('JBProjects', chainId), tokens: v6Address('JBTokens', chainId), controller: v6Address('JBController', chainId), suckerRegistry: v6Address('JBSuckerRegistry', chainId), eventCounts: { Mint: 1, ClaimTokens: 1, Transfer: 1 }, candidateCount: supply ? 1 : 0, bridgePolicy: 'historical-graph-required' as const },
    }
  })
  const liveFundSupply = projects.reduce((sum, project) => sum + project.totalFundSupply, 0n)
  return {
    kind: 'homerun-global-fund-entitlements', version: 1, root: { chainId: 8453, projectId: 7n },
    claimPolicy: 'live-chain-and-pending-bridge-destination', historyAttestation: 'complete-canonical-rpc-log-history-required',
    graph: { cuts: projects.map(({ chainId, blockNumber, blockHash, blockTimestamp }) => ({ chainId, blockNumber, blockHash, blockTimestamp })), projects: projects.map(({ chainId, projectId, owner, controller, historicalSuckers }) => ({ chainId, projectId, owner, controller, historicalSuckers })), lanes: [] },
    projects, bridges: [], entitlements: projects.filter(project => project.totalFundSupply > 0n).map(project => ({
      claimChainId: project.chainId, beneficiary: holder, liveFundBalance: project.totalFundSupply, pendingFundBalance: 0n, fundBalance: project.totalFundSupply,
      sources: [{ kind: 'live-balance', chainId: project.chainId, projectId: project.projectId, amount: project.totalFundSupply }],
    })), totals: { liveFundSupply, pendingFundSupply: 0n, globalFundSupply: liveFundSupply },
  }
}
const manifest = buildFundGlobalManifest(globalSnapshot(), { helper: runtime.launcher, launchSalt: salt })
const input = { chainId: 8453 as const, fundProjectId: 7n, account: holder, manifest, manifestUri: 'ipfs://bafysnapshot', name: 'Founder Haus INCOME', ticker: 'RENT', projectUri: 'ipfs://bafyincome', salt, reservedBps: 8000, startsAtOrAfter }

function configurationSalt(snapshot: ReturnType<typeof globalIncomeSnapshotParameters>, launchSalt: Hex) {
  const allocationsHash = keccak256(encodeAbiParameters(parseAbiParameters('(uint32 chainId,uint256 fundProjectId,uint256 snapshotBlockNumber,bytes32 snapshotBlockHash,uint104 incomeAmount)[]'), [snapshot.allocations]))
  return keccak256(encodeAbiParameters(parseAbiParameters('bytes32,bytes32,uint256,bytes32,bytes32'), [launchSalt, snapshot.sourceSetHash, snapshot.totalFundSupply, snapshot.manifestHash, allocationsHash]))
}

function client(overrides: Record<string, unknown> = {}, chainId: JBChainId = 8453) {
  const defaults: Record<string, unknown> = {
    CONTROLLER: v6Address('JBController', chainId), PROJECTS: v6Address('JBProjects', chainId), TOKENS: v6Address('JBTokens', chainId),
    REV_DEPLOYER: v6Address('REVDeployer', chainId), REV_OWNER: v6Address('REVOwner', chainId),
    OMNICHAIN_DEPLOYER: v6Address('JBOmnichainDeployer', chainId), TERMINAL: v6Address('JBMultiTerminal', chainId), ROUTER_TERMINAL_REGISTRY: v6Address('JBRouterTerminalRegistry', chainId), ALLOWLIST_HOOK: runtime.allowlist,
    USDC: USDC_ADDRESSES[chainId], incomeProjectIdOf: 0n, creationFee: 15n,
    currentRulesetOf: [{ id: 80n }, {}], splitsOf: defaultSplits,
  }
  return {
    getChainId: vi.fn(async () => chainId as number),
    getBlock: vi.fn(async (args?: { blockNumber?: bigint; blockTag?: string }) => ({ number: args?.blockNumber === 50n ? 50n : 100n, hash: args?.blockNumber === 50n ? snapshotHash : hash, timestamp: 1_800_000_000n })),
    getCode: vi.fn(async (_args?: { address?: Address; blockNumber?: bigint }) => '0x1234'),
    readContract: vi.fn(async ({ functionName, blockNumber, args }: { functionName: string; blockNumber?: bigint; args?: readonly unknown[] }) => {
      expect(blockNumber).toBe(100n)
      if (!(functionName in overrides) && functionName === 'configurationSaltFor') return configurationSalt(args![0] as ReturnType<typeof globalIncomeSnapshotParameters>, args![1] as Hex)
      if (!(functionName in overrides) && functionName === 'usdcOf') return USDC_ADDRESSES[Number(args![0]) as JBChainId]
      const result = functionName in overrides ? overrides[functionName] : defaults[functionName]
      if (result instanceof Error) throw result
      if (result === undefined) throw new Error(`Unexpected read ${functionName}`)
      return result
    }),
  }
}

function linkedFixture(options: { remoteOverrides?: Record<string, unknown>; emptyLocal?: boolean } = {}) {
  const rpc = client(), remote = client(options.remoteOverrides, 10)
  runtime.state = { ...runtime.state, linkedChainIds: [10, 8453] }
  runtime.remoteStates.set(10, { ...runtime.state, chainId: 10, projectId: 17n, account: undefined } as unknown as FundProjectState)
  const linkedManifest = buildFundGlobalManifest(globalSnapshot([10, 8453], options.emptyLocal), { helper: runtime.launcher, launchSalt: salt })
  runtime.allocationManifest = linkedManifest
  const clients = new Map<number, PublicClient>([[8453, rpc as unknown as PublicClient], [10, remote as unknown as PublicClient]])
  return { rpc, remote, manifest: linkedManifest, input: { ...input, manifest: linkedManifest, clients } }
}

function allocationState({ chainId, incomeProjectId, fundProjectId }: { chainId: JBChainId; incomeProjectId: bigint; fundProjectId: bigint }): InitialIncomeAllocationState {
  const value = runtime.allocationManifest!, local = value.allocations.find(entry => entry.chainId === chainId && BigInt(entry.fundProjectId) === fundProjectId)!
  if (!local) throw new Error('No fixture for the requested initial INCOME allocation')
  return { chainId, incomeProjectId, fundProjectId, deployer: runtime.launcher, owner: holder, blockNumber: 100n, blockHash: hash, blockTimestamp: 1_800_000_000n, stageId: BigInt(startsAtOrAfter), stageStart: BigInt(startsAtOrAfter), started: true, recorded: BigInt(local.incomeAmount), held: 0n, pending: BigInt(local.incomeAmount) }
}
function launchedPeerFixture() {
  const fixture = linkedFixture(), snapshot = globalIncomeSnapshotParameters(fixture.manifest, input.manifestUri)
  const expectedHash = incomeConfigurationHash({ ...input, helper: runtime.launcher, snapshot, configurationSalt: configurationSalt(snapshot, salt) })
  const remote = client({ incomeProjectIdOf: 18n, hashedEncodedConfigurationOf: expectedHash }, 10)
  fixture.input.clients.set(10, remote as unknown as PublicClient)
  return { ...fixture, remote, expectedHash }
}

describe('global atomic INCOME launch preparation', () => {
  beforeEach(() => {
    vi.mocked(verifyFundGlobalManifestHistory).mockClear()
    vi.mocked(readFundProjectState).mockClear()
    runtime.remoteStates.clear()
    runtime.allocationManifest = manifest
    runtime.allocation.mockReset().mockImplementation(async (_client, args) => allocationState(args))
    runtime.state = {
      chainId: 8453, projectId: 7n, blockNumber: 100n, blockHash: hash, blockTimestamp: 1_800_000_000n, owner: holder, account: holder,
      supportedController: true, supportedTerminals: true, knownOwnerWrapper: true, tokenAddress: token,
      metadata: { pausePay: true, cashOutTaxRate: 10_000, allowOwnerMinting: false, dataHook: zeroAddress, useDataHookForPay: false, useDataHookForCashOut: false },
      linkedChainIds: [8453], linkedPeers: [], pendingReservedTokens: 0n, totalSupply: 100n, hasPendingRuleset: false,
    } as unknown as FundProjectState
  })
  it('encodes the immutable global allocation, shared start time, stock sucker configuration, and exact creation fee', async () => {
    const rpc = client()
    const prepared = await prepareIncomeLaunch(rpc as unknown as PublicClient, input)
    expect(verifyFundGlobalManifestHistory).toHaveBeenCalledWith(new Map([[8453, rpc]]), manifest)
    expect(prepared.request.address).toBe(runtime.launcher)
    expect(prepared.request.functionName).toBe('deployIncome')
    expect(prepared.snapshot).toEqual(globalIncomeSnapshotParameters(manifest, input.manifestUri))
    expect(prepared.localAllocation).toEqual(manifest.allocations[0])
    expect(prepared.configurationSalt).toBe(configurationSalt(prepared.snapshot, salt))
    expect(prepared.expectedConfigurationHash).toMatch(/^0x[\da-f]{64}$/)
    expect(prepared.expectedConfigurationHash).not.toBe(zeroHash)
    expect(prepared.request.args).toEqual([7n, prepared.snapshot, { name: input.name, ticker: 'RENT', uri: input.projectUri, salt }, 8000, startsAtOrAfter, parseSuckerDeployerConfig(8453, [8453], [MappableAsset.USDC], { version: 6, bridge: 'ccip', salt })])
    expect(prepared.request.value).toBe(15n)
    expect(decodeFunctionData({ abi: homerunDeployerAbi, data: encodeFunctionData({ abi: homerunDeployerAbi, functionName: 'deployIncome', args: prepared.request.args as never }) }).args?.[1]).toEqual(prepared.snapshot)
  })
  it('keeps historical entitlements when current FUND supply later changes', async () => {
    runtime.state.totalSupply = 90n
    expect((await prepareIncomeLaunch(client() as unknown as PublicClient, input)).snapshot.totalFundSupply).toBe(100n)
  })
  it('requires the FUND owner to submit and rejects a blank ticker before preparing a transaction', async () => {
    const other = getAddress('0x0000000000000000000000000000000000000999')
    const prepared = await prepareIncomeLaunch(client() as unknown as PublicClient, input)
    expect(prepared.fund.owner).toBe(holder)
    await expect(prepareIncomeLaunch(client() as unknown as PublicClient, { ...input, account: other })).rejects.toThrow('The FUND owner must launch INCOME.')
    await expect(prepareIncomeLaunch(client() as unknown as PublicClient, { ...input, ticker: ' ' })).rejects.toThrow(/ticker/)
  })
  it('accepts a linked FUND and verifies all source chains against one global allocation', async () => {
    const f = linkedFixture()
    expect(incomeLaunchBlockers(runtime.state)).toEqual([])
    const prepared = await prepareIncomeLaunch(f.rpc as unknown as PublicClient, f.input)
    expect(verifyFundGlobalManifestHistory).toHaveBeenCalledWith(f.input.clients, f.manifest)
    expect(readFundProjectState).toHaveBeenCalledWith(f.rpc, { chainId: 8453, projectId: 7n, account: holder })
    expect(readFundProjectState).toHaveBeenCalledWith(f.remote, { chainId: 10, projectId: 17n, account: undefined })
    expect(prepared.localAllocation.chainId).toBe(8453)
    expect(prepared.snapshot.allocations.map(row => [row.chainId, row.incomeAmount])).toEqual([[10, INITIAL_INCOME_SUPPLY / 2n], [8453, INITIAL_INCOME_SUPPLY / 2n]])
    expect(prepared.snapshot.allocations.reduce((sum, row) => sum + row.incomeAmount, 0n)).toBe(INITIAL_INCOME_SUPPLY)
    expect(prepared.request.args[5]).toEqual(parseSuckerDeployerConfig(8453, [10, 8453], [MappableAsset.USDC], { version: 6, bridge: 'ccip', salt }))
    for (const rpc of [f.rpc, f.remote]) {
      expect(rpc.readContract.mock.calls.filter(([args]) => args.functionName === 'usdcOf').map(([args]) => args.args)).toEqual([[10], [8453]])
      expect(rpc.getBlock).toHaveBeenCalledWith({ blockTag: 'finalized' })
      expect(rpc.getBlock).toHaveBeenCalledWith({ blockNumber: 50n })
      expect(rpc.getBlock).toHaveBeenCalledWith({ blockNumber: 100n })
    }
  })
  it('launches a zero local allocation without creating a second global 500k supply', async () => {
    const f = linkedFixture({ emptyLocal: true })
    runtime.state = { ...runtime.state, totalSupply: 0n }
    const prepared = await prepareIncomeLaunch(f.rpc as unknown as PublicClient, f.input)
    expect(prepared.localAllocation).toMatchObject({ chainId: 8453, incomeAmount: '0', holders: [] })
    expect(prepared.snapshot.allocations.map(row => [row.chainId, row.incomeAmount])).toEqual([[10, INITIAL_INCOME_SUPPLY], [8453, 0n]])
    expect(prepared.request.args[1]).toEqual(prepared.snapshot)
  })
  it('uses the explicitly selected local client even if the supplied client map has a stale local entry', async () => {
    const f = linkedFixture()
    const stale = client(); stale.getChainId.mockResolvedValue(1)
    f.input.clients.set(8453, stale as unknown as PublicClient)
    await prepareIncomeLaunch(f.rpc as unknown as PublicClient, f.input)
    expect(stale.getChainId).not.toHaveBeenCalled()
    expect(verifyFundGlobalManifestHistory).toHaveBeenCalledWith(new Map([[10, f.remote], [8453, f.rpc]]), f.manifest)
  })
  it('requires a verified RPC client and correct chain for every global source', async () => {
    const f = linkedFixture()
    await expect(prepareIncomeLaunch(f.rpc as unknown as PublicClient, { ...f.input, clients: undefined })).rejects.toThrow(/RPC client.*10/)
    f.remote.getChainId.mockResolvedValue(8453)
    await expect(prepareIncomeLaunch(f.rpc as unknown as PublicClient, f.input)).rejects.toThrow(/different chain/)
  })
  it('requires a registered deterministic helper on every global claim chain', async () => {
    const f = linkedFixture()
    const other = buildFundGlobalManifest(globalSnapshot([1, 8453]), { helper: runtime.launcher, launchSalt: salt })
    const clients = new Map<number, PublicClient>([[1, client({}, 1) as unknown as PublicClient]])
    await expect(prepareIncomeLaunch(f.rpc as unknown as PublicClient, { ...f.input, manifest: other, clients })).rejects.toThrow(/same deterministic.*helper/)
  })
  it('rejects a remote source whose snapshot has not finalized', async () => {
    const f = linkedFixture()
    f.remote.getBlock.mockResolvedValue({ number: 49n, hash, timestamp: 1_800_000_000n })
    await expect(prepareIncomeLaunch(f.rpc as unknown as PublicClient, f.input)).rejects.toThrow(/finalized/)
  })
  it('requires successful closed FUND state on every source chain', async () => {
    const f = linkedFixture()
    const remoteState = runtime.remoteStates.get(10)!
    runtime.remoteStates.set(10, { ...remoteState, metadata: { ...remoteState.metadata, pausePay: false } })
    await expect(prepareIncomeLaunch(f.rpc as unknown as PublicClient, f.input)).rejects.toThrow(/Chain 10.*Finish the successful raise/)
  })
  it('rejects a remote helper with an incomplete USDC deployment profile', async () => {
    const f = linkedFixture({ remoteOverrides: { usdcOf: holder } })
    await expect(prepareIncomeLaunch(f.rpc as unknown as PublicClient, f.input)).rejects.toThrow(/complete reviewed chain and USDC/)
  })
  it('permits the remaining chain after a remote launch with the exact reviewed revnet configuration', async () => {
    const f = linkedFixture()
    const snapshot = globalIncomeSnapshotParameters(f.manifest, input.manifestUri)
    const expectedHash = incomeConfigurationHash({ ...input, helper: runtime.launcher, snapshot, configurationSalt: configurationSalt(snapshot, salt) })
    const remote = client({ incomeProjectIdOf: 18n, hashedEncodedConfigurationOf: expectedHash }, 10)
    f.input.clients.set(10, remote as unknown as PublicClient)
    const prepared = await prepareIncomeLaunch(f.rpc as unknown as PublicClient, f.input)
    expect(prepared.expectedConfigurationHash).toBe(expectedHash)
    expect(remote.readContract).toHaveBeenCalledWith(expect.objectContaining({ address: v6Address('REVDeployer', 10), functionName: 'hashedEncodedConfigurationOf', args: [18n], blockNumber: 100n }))
  })
  it('joins after a launched peer begins asset-sale cashouts, changes owner, and burns FUND', async () => {
    const f = launchedPeerFixture(), old = runtime.remoteStates.get(10)!
    runtime.remoteStates.set(10, { ...old, owner: other, totalSupply: 12n, hasPendingRuleset: true, metadata: { ...old.metadata, cashOutTaxRate: 0 } })
    const prepared = await prepareIncomeLaunch(f.rpc as unknown as PublicClient, f.input)
    expect(prepared.snapshot.totalFundSupply).toBe(200n)
    expect(prepared.manifestHash).toBe(fundGlobalManifestHash(f.manifest))
    expect(prepared.expectedConfigurationHash).toBe(f.expectedHash)
    expect(runtime.allocation).toHaveBeenCalledWith(f.remote, { chainId: 10, incomeProjectId: 18n, fundProjectId: 17n, blockNumber: 100n })
    expect(runtime.allocation).toHaveBeenCalledOnce()
  })
  it('still requires an unlaunched peer to close its raise even if another chain could otherwise prepare', async () => {
    const f = linkedFixture(), old = runtime.remoteStates.get(10)!
    runtime.remoteStates.set(10, { ...old, totalSupply: 12n, metadata: { ...old.metadata, cashOutTaxRate: 0 } })
    await expect(prepareIncomeLaunch(f.rpc as unknown as PublicClient, f.input)).rejects.toThrow(/Chain 10.*Finish the successful raise/)
    expect(runtime.allocation).not.toHaveBeenCalled()
  })
  it.each([{ pending: 1n }, { pending: 0n, started: false }, { pending: INITIAL_INCOME_SUPPLY }])('rejects a launched peer whose recorded owner allocation differs from the global manifest %#', async changed => {
    const f = launchedPeerFixture()
    runtime.allocation.mockImplementation(async (_client, args) => ({ ...allocationState(args), ...changed }))
    await expect(prepareIncomeLaunch(f.rpc as unknown as PublicClient, f.input)).rejects.toThrow('does not match the published manifest')
  })
  it.each([{ started: false }, { pending: 0n, started: true }])('accepts a launched peer whose allocation is still pending or already minted %#', async changed => {
    const f = launchedPeerFixture()
    runtime.allocation.mockImplementation(async (_client, args) => ({ ...allocationState(args), ...changed }))
    await expect(prepareIncomeLaunch(f.rpc as unknown as PublicClient, f.input)).resolves.toBeDefined()
  })
  it('propagates peer allocation read failures', async () => {
    const f = launchedPeerFixture()
    runtime.allocation.mockRejectedValueOnce(new Error('Initial allocation RPC unavailable'))
    await expect(prepareIncomeLaunch(f.rpc as unknown as PublicClient, f.input)).rejects.toThrow('Initial allocation RPC unavailable')
  })
  it.each([{ supportedController: false }, { knownOwnerWrapper: false }, { tokenAddress: null }, { projectId: 99n }])('retains canonical FUND identity requirements on completed peers %#', async changed => {
    const f = launchedPeerFixture()
    runtime.remoteStates.set(10, { ...runtime.remoteStates.get(10)!, ...changed })
    await expect(prepareIncomeLaunch(f.rpc as unknown as PublicClient, f.input)).rejects.toThrow(/Chain 10.*identity/)
  })
  it('refuses to join an existing remote INCOME with a different reviewed configuration', async () => {
    const f = linkedFixture({ remoteOverrides: { incomeProjectIdOf: 18n, hashedEncodedConfigurationOf: hash } })
    await expect(prepareIncomeLaunch(f.rpc as unknown as PublicClient, f.input)).rejects.toThrow(/different start time, name, economics, or global allocation/)
  })
  it('allows a launched peer to change its split percentages while keeping the immutable stock identity', async () => {
    const f = linkedFixture()
    const snapshot = globalIncomeSnapshotParameters(f.manifest, input.manifestUri)
    const config = { ...input, helper: runtime.launcher, snapshot, configurationSalt: configurationSalt(snapshot, salt) }
    const expectedHash = incomeConfigurationHash(config)
    // The reserved percent is part of the stock identity; only the split rows inside it are free.
    expect(incomeConfigurationHash({ ...config, reservedBps: 6000 })).not.toBe(expectedHash)
    const remote = client({ incomeProjectIdOf: 18n, hashedEncodedConfigurationOf: expectedHash,
      splitsOf: [{ ...defaultSplits[0], percent: 750_000_000 }, { ...defaultSplits[0], beneficiary: other, percent: 250_000_000 }],
    }, 10)
    f.input.clients.set(10, remote as unknown as PublicClient)
    await expect(prepareIncomeLaunch(f.rpc as unknown as PublicClient, f.input)).resolves.toMatchObject({ request: { args: expect.arrayContaining([8000]) } })
    expect(remote.readContract.mock.calls.some(([args]) => args.functionName === 'splitsOf')).toBe(false)
  })
  it('allows the Owner to redirect a launched peer split without changing the frozen plan', async () => {
    const f = launchedPeerFixture()
    const redirected = client({ incomeProjectIdOf: 18n, hashedEncodedConfigurationOf: f.expectedHash, splitsOf: [{ ...defaultSplits[0], beneficiary: other }] }, 10)
    f.input.clients.set(10, redirected as unknown as PublicClient)
    await expect(prepareIncomeLaunch(f.rpc as unknown as PublicClient, f.input)).resolves.toBeDefined()
  })
  it('accepts older peers with locked splits without applying that policy to new launches', async () => {
    const f = launchedPeerFixture()
    const legacy = client({ incomeProjectIdOf: 18n, hashedEncodedConfigurationOf: f.expectedHash,
      splitsOf: defaultSplits.map(split => ({ ...split, lockedUntil: 2 ** 48 - 1 })),
    }, 10)
    f.input.clients.set(10, legacy as unknown as PublicClient)
    await expect(prepareIncomeLaunch(f.rpc as unknown as PublicClient, f.input)).resolves.toBeDefined()
  })
  it.each([
    [{ ...defaultSplits[0], beneficiary: other }],
    [{ ...defaultSplits[0], hook: holder }],
    [{ ...defaultSplits[0], projectId: 12n }],
    [{ ...defaultSplits[0], preferAddToBalance: true }],
  ])('allows Owner updates to a launched peer’s split routing %#', async (...splitsOf) => {
    const f = linkedFixture()
    const snapshot = globalIncomeSnapshotParameters(f.manifest, input.manifestUri)
    const expectedHash = incomeConfigurationHash({ ...input, helper: runtime.launcher, snapshot, configurationSalt: configurationSalt(snapshot, salt) })
    f.input.clients.set(10, client({ incomeProjectIdOf: 18n, hashedEncodedConfigurationOf: expectedHash, splitsOf }, 10) as unknown as PublicClient)
    await expect(prepareIncomeLaunch(f.rpc as unknown as PublicClient, f.input)).resolves.toBeDefined()
  })
  it('rejects a remote source reorganization after preparing the allocation', async () => {
    const f = linkedFixture()
    f.remote.getBlock.mockImplementation(async args => ({ number: args?.blockNumber === 50n ? 50n : 100n, hash: args?.blockNumber === 50n ? salt : hash, timestamp: 1_800_000_000n }))
    await expect(prepareIncomeLaunch(f.rpc as unknown as PublicClient, f.input)).rejects.toThrow(/reorganized/)
  })
  it.each([0, 10_000])('allows a deliberately %s bps reserved allocation', async reservedBps => {
    const prepared = await prepareIncomeLaunch(client() as unknown as PublicClient, { ...input, reservedBps })
    expect(prepared.request.args[3]).toBe(reservedBps)
  })
  it.each([
    { incomeProjectIdOf: 8n }, { REV_DEPLOYER: holder }, { CONTROLLER: holder }, { OMNICHAIN_DEPLOYER: holder }, { TERMINAL: holder }, { ROUTER_TERMINAL_REGISTRY: holder }, { ALLOWLIST_HOOK: holder }, { usdcOf: holder }, { configurationSaltFor: hash },
  ])('refuses unverified or already bound launch %#', async override => {
    await expect(prepareIncomeLaunch(client(override) as unknown as PublicClient, input)).rejects.toThrow()
  })
  it('commits the reconciled manifest hash into the prepared plan', async () => {
    const rpc = client()
    const prepared = await prepareIncomeLaunch(rpc as unknown as PublicClient, input)
    expect(prepared.manifestHash).toBe(fundGlobalManifestHash(manifest))
  })
  it('requires a finalized imported snapshot', async () => {
    const rpc = client(); rpc.getBlock.mockResolvedValue({ number: 49n, hash, timestamp: 1_800_000_000n })
    await expect(prepareIncomeLaunch(rpc as unknown as PublicClient, input)).rejects.toThrow(/finalized/)
  })
  it('requires the actual FUND NFT owner', async () => {
    runtime.state = { ...runtime.state, owner: token }
    await expect(prepareIncomeLaunch(client() as unknown as PublicClient, input)).rejects.toThrow(/FUND owner/)
  })
  it.each([
    { helper: holder }, { launchSalt: hash },
  ])('rejects another launch domain %#', async changes => {
    const other = buildFundGlobalManifest(globalSnapshot(), { helper: runtime.launcher, launchSalt: salt, ...changes })
    await expect(prepareIncomeLaunch(client() as unknown as PublicClient, { ...input, manifest: other })).rejects.toThrow(/different FUND|launcher|launch salt/)
  })
  it('does not suppress independent historical reconstruction failures', async () => {
    vi.mocked(verifyFundGlobalManifestHistory).mockRejectedValueOnce(new Error('Historical ownership differs'))
    await expect(prepareIncomeLaunch(client() as unknown as PublicClient, input)).rejects.toThrow(/Historical ownership/)
  })
  it.each([{ manifestUri: 'https://example.com/snapshot' }, { reservedBps: 10001 }, { reservedBps: -1 }, { reservedBps: 12.5 }, { startsAtOrAfter: 0 }, { startsAtOrAfter: 1.5 }])('refuses incomplete launch configuration %#', async patch => {
    await expect(prepareIncomeLaunch(client() as unknown as PublicClient, { ...input, ...patch })).rejects.toThrow()
  })
  it('requires already deployed canonical helper code', async () => {
    const rpc = client(); rpc.getCode.mockResolvedValue('0x')
    await expect(prepareIncomeLaunch(rpc as unknown as PublicClient, input)).rejects.toThrow(/no deployed code/)
  })
  it('rejects a reorganization after preparing the allocation', async () => {
    const rpc = client(); rpc.getBlock.mockResolvedValue({ number: 100n, hash: salt, timestamp: 1_800_000_000n })
    await expect(prepareIncomeLaunch(rpc as unknown as PublicClient, input)).rejects.toThrow(/reorganized/)
  })
  it.each([
    { hasPendingRuleset: true }, { tokenAddress: null }, { pendingReservedTokens: 1n },
    { metadata: { pausePay: false, cashOutTaxRate: 1000, allowOwnerMinting: false, dataHook: zeroAddress } },
  ])('keeps unsupported lifecycle states unavailable %#', patch => {
    expect(incomeLaunchBlockers({ ...runtime.state, ...patch } as FundProjectState).length).toBeGreaterThan(0)
  })
  it('reports missing add-ons without substituting simulation addresses', () => {
    // The registry mock has no entry for chain 1, so only the pinned deployment resolves it.
    const pinned = HOMERUN_DEPLOYER[1]
    delete HOMERUN_DEPLOYER[1]
    try {
      expect(incomeLaunchBlockers({ ...runtime.state, chainId: 1, linkedChainIds: [1] }).filter(value => value.includes('verified and registered'))).toHaveLength(1)
    } finally {
      HOMERUN_DEPLOYER[1] = pinned
    }
    expect(incomeLaunchBlockers({ ...runtime.state, chainId: 1, linkedChainIds: [1] }).filter(value => value.includes('verified and registered'))).toHaveLength(0)
  })
  it.each([false, true])('allows an authenticated stocked FUND shop at the INCOME transition (omnichain=%s)', omnichain => {
    const hook = other
    const state = {
      ...runtime.state,
      metadata: { ...runtime.state.metadata, dataHook: omnichain ? v6Address('JBOmnichainDeployer', 8453) : hook, useDataHookForPay: true },
      rulesetSnapshot: {
        stock721Hook: { address: hook, verified: true, hasTiers: true },
        ...(omnichain ? { omnichainHooks: { dataHook: zeroAddress, useDataHookForPay: false, useDataHookForCashOut: false, tiered721Hook: hook, tiered721UseDataHookForCashOut: false, tiered721HasTiers: true } } : {}),
      },
    } as FundProjectState
    expect(incomeLaunchBlockers(state)).toEqual([])
    expect(incomeLaunchBlockers({ ...state, rulesetSnapshot: { ...state.rulesetSnapshot, stock721Hook: undefined } } as FundProjectState)).toContain('The initial INCOME launcher requires a closed FUND with no custom hooks or pending rulesets.')
    expect(incomeLaunchBlockers({ ...state, rulesetSnapshot: { ...state.rulesetSnapshot, stock721Hook: { address: token, verified: true, hasTiers: true } } } as FundProjectState)).toContain('The initial INCOME launcher requires a closed FUND with no custom hooks or pending rulesets.')
    const cashOutState = omnichain
      ? { ...state, rulesetSnapshot: { ...state.rulesetSnapshot, omnichainHooks: { ...state.rulesetSnapshot!.omnichainHooks, tiered721UseDataHookForCashOut: true } } }
      : { ...state, metadata: { ...state.metadata, useDataHookForCashOut: true } }
    expect(incomeLaunchBlockers(cashOutState as FundProjectState)).toContain('The initial INCOME launcher requires a closed FUND with no custom hooks or pending rulesets.')
  })
  it('reads the canonical INCOME binding from the contract', async () => {
    expect(await readIncomeLaunchBinding(client({ incomeProjectIdOf: 8n }) as unknown as PublicClient, 8453, 7n)).toBe(8n)
    expect(await readIncomeLaunchBinding(client() as unknown as PublicClient, 8453, 7n)).toBeNull()
  })
  it('rejects a wrong-chain binding', async () => {
    const rpc = client(); rpc.getChainId.mockResolvedValue(1)
    await expect(readIncomeLaunchBinding(rpc as unknown as PublicClient, 8453, 7n)).rejects.toThrow(/different chain/)
  })
})

it('matches the fixed configuration salt and actual REV hash verified in Solidity integration', () => {
  const bytes = (value: number) => `0x${value.toString(16).padStart(64, '0')}` as Hex
  const snapshot = {
    sourceSetHash: bytes(1), totalFundSupply: 1000n * 10n ** 18n, manifestHash: bytes(2), manifestUri: 'ipfs://global-vector',
    allocations: [
      { chainId: 1, fundProjectId: 7n, snapshotBlockNumber: 99n, snapshotBlockHash: bytes(11), incomeAmount: 0n },
      { chainId: 10, fundProjectId: 8n, snapshotBlockNumber: 100n, snapshotBlockHash: bytes(12), incomeAmount: 200_000n * 10n ** 18n },
      { chainId: 8453, fundProjectId: 9n, snapshotBlockNumber: 101n, snapshotBlockHash: bytes(13), incomeAmount: 300_000n * 10n ** 18n },
    ],
  }
  const configurationSalt = incomeConfigurationSalt(snapshot, bytes(3))
  expect(configurationSalt).toBe('0xba844f8a9fd17eec81c3c0e8d0acfc8470d079e6c646bc0e4a099166f4148a11')
  expect(incomeConfigurationHash({ snapshot, configurationSalt, startsAtOrAfter: 1_000_001, name: 'Global INCOME vector', ticker: 'RENT', helper: '0x1111111111111111111111111111111111111111', reservedBps: 8000 })).toBe('0x78e512e3b06ea190817cd931528acef3b45664a1a18726b16e41da9c9100f541')
})
