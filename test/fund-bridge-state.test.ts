import assert from 'node:assert/strict'
import { beforeEach, test, vi } from 'vitest'
import { USDC_ADDRESSES, type JBChainId } from '@bananapus/nana-sdk-core'
import { suckerBranchRoot, suckerLeafHash, suckerLeafProof, tokenCurrencyId, v6Address, type JBSuckerMovement, type JBSuckerPairV6 } from '@bananapus/nana-sdk-core/v6'
import { padHex, zeroAddress, zeroHash, type Address, type Hex, type PublicClient } from 'viem'
import { initialFundRuleset } from '../src/lib/fund-contracts'
import { type FundAccountingContext, type FundProjectState } from '../src/lib/fund-state'
import { readFundBridgeRoute, readFundBridgeMovements, type FundBridgeRoute } from '../src/lib/fund-bridge'

const mocks = vi.hoisted(() => ({
  readFundProjectState: vi.fn(), readLinkedFundProjects: vi.fn(),
  getAllV6SuckerPairs: vi.fn(), getSuckerMovements: vi.fn(), classifySuckerTransport: vi.fn(),
}))
vi.mock('../src/lib/fund-state', async importOriginal => ({
  ...await importOriginal<typeof import('../src/lib/fund-state')>(),
  readFundProjectState: mocks.readFundProjectState, readLinkedFundProjects: mocks.readLinkedFundProjects,
}))
vi.mock('@bananapus/nana-sdk-core/v6', async importOriginal => ({
  ...await importOriginal<typeof import('@bananapus/nana-sdk-core/v6')>(),
  getAllV6SuckerPairs: mocks.getAllV6SuckerPairs, getSuckerMovements: mocks.getSuckerMovements,
  classifySuckerTransport: mocks.classifySuckerTransport,
}))
beforeEach(() => vi.resetAllMocks())

const account = '0x1111111111111111111111111111111111111111' as const
const beneficiary = '0x2222222222222222222222222222222222222222' as const
const activeSource = '0x3333333333333333333333333333333333333333' as const
const activeDestination = '0x4444444444444444444444444444444444444444' as const
const historicalSource = '0x5555555555555555555555555555555555555555' as const
const historicalDestination = '0x6666666666666666666666666666666666666666' as const
const fundToken = '0x7777777777777777777777777777777777777777' as const
const blockHash = `0x${'ab'.repeat(32)}` as Hex

function context(chainId: 8453 | 10): FundAccountingContext {
  const terminal = v6Address('JBMultiTerminal', chainId)
  const token = USDC_ADDRESSES[chainId]
  return { terminal, primaryTerminal: terminal, isPrimary: true, token, currency: tokenCurrencyId(token), decimals: 6,
    balance: 1_000_000_000n, surplus: 1_000_000_000n, symbol: 'USDC', payoutLimits: [], surplusAllowances: [] }
}

function state(chainId: 8453 | 10): FundProjectState {
  const configuration = initialFundRuleset()
  configuration.metadata.dataHook = v6Address('JBOmnichainDeployer', chainId)
  configuration.metadata.useDataHookForPay = true
  configuration.metadata.useDataHookForCashOut = true
  const projectId = chainId === 8453 ? 7n : 19n
  const treasury = context(chainId)
  const controller = v6Address('JBController', chainId)
  return {
    chainId, projectId, blockNumber: 100n, blockHash, blockTimestamp: 1_800_000_000n,
    owner: account, operator: account, account, controller, supportedController: true, knownOwnerWrapper: true,
    terminals: [treasury.terminal], supportedTerminals: true,
    ruleset: { cycleNumber: 1, id: 1, basedOnId: 0, start: 1_799_000_000, duration: 0,
      weight: configuration.weight, weightCutPercent: 0, approvalHook: zeroAddress, metadata: 0n },
    metadata: configuration.metadata, upcoming: null, queued: null, hasPendingRuleset: false,
    projectUri: 'ipfs://verified-fund-metadata', tokenAddress: fundToken, tokenSymbol: 'FUND', tokenDecimals: 18,
    totalSupply: 1000n, totalCreditSupply: 100n, pendingReservedTokens: 0n, totalSupplyWithReservedTokens: 1000n,
    creditBalance: 10n, erc20Balance: 10n, totalBalance: 20n,
    accountingContexts: [treasury], permissions: { queueRulesets: false, mintTokens: false, useAllowance: false,
      sendPayouts: false, deployErc20: false, setProjectUri: false },
    linkedPeers: [{ chainId: chainId === 8453 ? 10 : 8453,
      localSuckerAddress: chainId === 8453 ? activeSource : activeDestination,
      suckerAddress: chainId === 8453 ? activeDestination : activeSource }],
    linkedChainIds: [8453, 10], linkedProjects: [{ chainId: 8453, projectId: 7n }, { chainId: 10, projectId: 19n }],
    rulesetSnapshot: { chainId, projectId, blockNumber: 100n, controller, currentRulesetId: 1n, upcomingRulesetId: 0n,
      configuration, linkedChainIds: [8453, 10], accountingContexts: [treasury],
      omnichainHooks: { dataHook: zeroAddress, tiered721Hook: zeroAddress, useDataHookForPay: false, useDataHookForCashOut: false } },
    issues: [],
  }
}

function sdkMovement(): JBSuckerMovement {
  const leaf = { index: 0n, beneficiary: padHex(beneficiary, { size: 32 }), projectTokenCount: 10n,
    terminalTokenAmount: 100_000_000n, metadata: zeroHash }
  const leafHash = suckerLeafHash(leaf)
  const proof = suckerLeafProof([leafHash], 0)
  return { sourceToken: USDC_ADDRESSES[8453], remoteToken: USDC_ADDRESSES[10], leaf, leafHash,
    outboxRoot: suckerBranchRoot(leafHash, proof, 0), blockNumber: 99n, status: 'claimable', canExecute: false, proof }
}

type ReadRequest = { address: Address; functionName: string; args?: readonly unknown[]; blockNumber?: bigint }
function fixture(options: {
  mapping?: { enabled: boolean; addr: Hex }; transport?: 'ccip' | 'native' | 'unknown'; sendingState?: number;
  sourceChain?: number; destinationChain?: number; sourceId?: bigint; destinationId?: bigint; count?: bigint; hash?: Hex;
} = {}) {
  const source = state(8453)
  const destination = state(10)
  const sourceRead = vi.fn(async (request: ReadRequest): Promise<unknown> => {
    if (request.functionName === 'projectId') {
      assert.equal(request.address, historicalSource)
      return options.sourceId ?? 7n
    }
    if (request.functionName === 'outboxOf') {
      assert.equal(request.address, historicalSource)
      assert.deepEqual(request.args, [USDC_ADDRESSES[8453]])
      return { tree: { count: options.count ?? 1n } }
    }
    assert.equal(request.blockNumber, source.blockNumber)
    if (request.functionName === 'toRemoteFee') {
      assert.equal(request.address, v6Address('JBSuckerRegistry', 8453))
      return 1000n
    }
    assert.equal(request.address, activeSource)
    if (request.functionName === 'remoteTokenFor') {
      assert.deepEqual(request.args, [USDC_ADDRESSES[8453]])
      return { emergencyHatch: false, minGas: 200_000, enabled: true, addr: padHex(USDC_ADDRESSES[10], { size: 32 }), ...options.mapping }
    }
    if (request.functionName === 'state') return options.sendingState ?? 0
    throw new Error(`Unexpected source RPC read: ${request.functionName}`)
  })
  const destinationRead = vi.fn(async (request: ReadRequest): Promise<unknown> => {
    assert.equal(request.address, historicalDestination)
    assert.equal(request.functionName, 'projectId')
    return options.destinationId ?? 19n
  })
  const getBlock = vi.fn(async (request: { blockNumber: bigint }) => {
    assert.equal(request.blockNumber, source.blockNumber)
    return { number: source.blockNumber, hash: options.hash ?? blockHash }
  })
  const sourceClient = { getChainId: vi.fn(async () => options.sourceChain ?? 8453), readContract: sourceRead, getBlock } as unknown as PublicClient
  const destinationClient = { getChainId: vi.fn(async () => options.destinationChain ?? 10), readContract: destinationRead } as unknown as PublicClient
  const clients = vi.fn((chainId: JBChainId) => {
    if (chainId === 8453) return sourceClient
    if (chainId === 10) return destinationClient
    throw new Error(`Unexpected chain ${chainId}`)
  })
  mocks.readFundProjectState.mockResolvedValue(source)
  mocks.readLinkedFundProjects.mockResolvedValue([source, destination])
  mocks.classifySuckerTransport.mockResolvedValue(options.transport ?? 'ccip')
  const sourcePairs: JBSuckerPairV6[] = [{ local: historicalSource, remote: historicalDestination, remoteChainId: 10n }]
  const destinationPairs: JBSuckerPairV6[] = [{ local: historicalDestination, remote: historicalSource, remoteChainId: 8453n }]
  mocks.getAllV6SuckerPairs.mockImplementation(async (_client: PublicClient, input: { chainId: number; projectId: bigint }) => {
    assert.equal(input.projectId, input.chainId === 8453 ? 7n : 19n)
    return input.chainId === 8453 ? sourcePairs : destinationPairs
  })
  mocks.getSuckerMovements.mockResolvedValue([sdkMovement()])
  const route: FundBridgeRoute = { source, destination, sourceSucker: activeSource, destinationSucker: activeDestination,
    sourceToken: USDC_ADDRESSES[8453], destinationToken: USDC_ADDRESSES[10], sourceContext: source.accountingContexts[0],
    destinationContext: destination.accountingContexts[0], transport: options.transport ?? 'ccip', baseFee: 1000n, canPrepare: true, prepareIssue: null }
  return { source, destination, sourceClient, destinationClient, clients, sourceRead, destinationRead, getBlock, route, sourcePairs, destinationPairs }
}

test('route reads fresh source state with the same wallet before resolving linked projects', async () => {
  const f = fixture()
  const stale = { ...f.source, blockNumber: 90n, erc20Balance: 9999n }
  const result = await readFundBridgeRoute(f.clients, stale, 10)
  assert.deepEqual(mocks.readFundProjectState.mock.calls, [[f.sourceClient, { chainId: 8453, projectId: 7n, account }]])
  assert.deepEqual(mocks.readLinkedFundProjects.mock.calls, [[f.clients, f.source]])
  assert.equal(result.source, f.source)
  assert.equal(result.source.erc20Balance, 10n)
  assert.equal(result.destination.projectId, 19n)
  assert.equal(result.sourceSucker, activeSource)
  assert.equal(result.destinationSucker, activeDestination)
  assert.equal(result.sourceToken, USDC_ADDRESSES[8453])
  assert.equal(result.destinationToken, USDC_ADDRESSES[10])
  assert.equal(result.baseFee, 1000n)
  assert.equal(result.canPrepare, true)
  assert.equal(f.getBlock.mock.calls.length, 1)
})

test('route refresh omits a wallet when the original source is disconnected', async () => {
  const f = fixture()
  await readFundBridgeRoute(f.clients, { ...f.source, account: null }, 10)
  assert.deepEqual(mocks.readFundProjectState.mock.calls[0][1], { chainId: 8453, projectId: 7n })
})

test('route requires a distinct linked destination and exactly one matching source peer', async () => {
  const f = fixture()
  await assert.rejects(() => readFundBridgeRoute(f.clients, f.source, 8453))
  mocks.readLinkedFundProjects.mockResolvedValueOnce([f.source])
  await assert.rejects(() => readFundBridgeRoute(f.clients, f.source, 10))
  f.source.linkedPeers.push({ ...f.source.linkedPeers[0], localSuckerAddress: historicalSource })
  await assert.rejects(() => readFundBridgeRoute(f.clients, f.source, 10))
  f.source.linkedPeers = []
  await assert.rejects(() => readFundBridgeRoute(f.clients, f.source, 10))
})

test('route rejects missing treasury tokens, mismatched mapped assets and incompatible precision', async () => {
  const missing = fixture()
  missing.source.accountingContexts = []
  await assert.rejects(() => readFundBridgeRoute(missing.clients, missing.source, 10))
  const wrongMapping = fixture({ mapping: { enabled: true, addr: padHex(fundToken, { size: 32 }) } })
  wrongMapping.destination.accountingContexts.push({ ...context(10), token: fundToken })
  await assert.rejects(() => readFundBridgeRoute(wrongMapping.clients, wrongMapping.source, 10))
  const wrongDecimals = fixture()
  wrongDecimals.destination.accountingContexts[0].decimals = 18
  await assert.rejects(() => readFundBridgeRoute(wrongDecimals.clients, wrongDecimals.source, 10))
})

test('disabled token mappings retain a readable historical route while preventing new preparations', async () => {
  for (const addr of [zeroHash, padHex(USDC_ADDRESSES[10], { size: 32 })]) {
    const f = fixture({ mapping: { enabled: false, addr } })
    const result = await readFundBridgeRoute(f.clients, f.source, 10)
    assert.equal(result.destinationToken, USDC_ADDRESSES[10])
    assert.equal(result.canPrepare, false)
    assert.match(result.prepareIssue!, /disabled/)
    const rows = await readFundBridgeMovements(f.clients, result)
    assert.equal(rows[0].status, 'claimable')
  }
})

test('native USDC, unknown transports, disabled sending and missing FUND ERC20 prevent new preparations', async () => {
  for (const options of [{ transport: 'native' as const }, { transport: 'unknown' as const }, { sendingState: 2 }, { sendingState: 3 }]) {
    const f = fixture(options)
    assert.equal((await readFundBridgeRoute(f.clients, f.source, 10)).canPrepare, false)
  }
  const f = fixture()
  f.source.tokenAddress = null
  assert.equal((await readFundBridgeRoute(f.clients, f.source, 10)).canPrepare, false)
})

test('route rejects source reorgs and propagates state/transport RPC failures', async () => {
  const reorg = fixture({ hash: zeroHash })
  await assert.rejects(() => readFundBridgeRoute(reorg.clients, reorg.source, 10), /changed/)
  const failed = fixture()
  mocks.readFundProjectState.mockRejectedValueOnce(new Error('Missing controller RPC'))
  await assert.rejects(() => readFundBridgeRoute(failed.clients, failed.source, 10), /Missing controller RPC/)
  mocks.classifySuckerTransport.mockRejectedValueOnce(new Error('Transport RPC unavailable'))
  await assert.rejects(() => readFundBridgeRoute(failed.clients, failed.source, 10), /Transport RPC unavailable/)
})

test('historical movements require both registries and preserve the exact SDK proof and project identities', async () => {
  const f = fixture()
  const sdk = sdkMovement()
  const rows = await readFundBridgeMovements(f.clients, f.route)
  assert.deepEqual(mocks.getAllV6SuckerPairs.mock.calls, [
    [f.sourceClient, { chainId: 8453, projectId: 7n }], [f.destinationClient, { chainId: 10, projectId: 19n }],
  ])
  assert.deepEqual(mocks.getSuckerMovements.mock.calls, [[f.sourceClient, f.destinationClient, {
    sourceSucker: historicalSource, destinationSucker: historicalDestination, sourceToken: USDC_ADDRESSES[8453],
    remoteToken: USDC_ADDRESSES[10], blockRange: 9999n, maxBlockRanges: 512,
  }]])
  assert.deepEqual(rows, [{ ...sdk, sourceSucker: historicalSource, destinationSucker: historicalDestination,
    sourceChainId: 8453, destinationChainId: 10, sourceProjectId: 7n, destinationProjectId: 19n,
    beneficiary, inboxRoot: suckerBranchRoot(sdk.leafHash, sdk.proof!, 0) }])
  assert.notEqual(rows[0].sourceSucker, f.route.sourceSucker)
})

test('historical movement lookup rejects wrong RPC chains before reading registries or SDK proofs', async () => {
  for (const options of [{ sourceChain: 1 }, { destinationChain: 8453 }]) {
    const f = fixture(options)
    mocks.getAllV6SuckerPairs.mockClear()
    mocks.getSuckerMovements.mockClear()
    await assert.rejects(() => readFundBridgeMovements(f.clients, f.route), /wrong chain/)
    assert.equal(mocks.getAllV6SuckerPairs.mock.calls.length, 0)
    assert.equal(mocks.getSuckerMovements.mock.calls.length, 0)
  }
})

test('historical routes require reciprocal addresses, reverse chain identity and matching project IDs', async () => {
  for (const change of [{ local: activeDestination }, { remote: activeSource }, { remoteChainId: 1n }]) {
    const f = fixture()
    Object.assign(f.destinationPairs[0], change)
    await assert.rejects(() => readFundBridgeMovements(f.clients, f.route), /reciprocally registered/)
    assert.equal(mocks.getSuckerMovements.mock.calls.length, 0)
  }
  for (const options of [{ sourceId: 19n }, { destinationId: 7n }]) {
    const f = fixture(options)
    await assert.rejects(() => readFundBridgeMovements(f.clients, f.route), /different projects/)
    assert.equal(mocks.getSuckerMovements.mock.calls.length, 0)
  }
})

test('historical route and outbox limits stop excessive scans before requesting SDK movements', async () => {
  for (const side of ['sourcePairs', 'destinationPairs'] as const) {
    const f = fixture()
    f[side].push(...Array.from({ length: 32 }, () => ({ ...f[side][0] })))
    await assert.rejects(() => readFundBridgeMovements(f.clients, f.route), /route count/)
    assert.equal(mocks.getSuckerMovements.mock.calls.length, 0)
  }
  const large = fixture({ count: 4097n })
  await assert.rejects(() => readFundBridgeMovements(large.clients, large.route), /movement count/)
  assert.equal(mocks.getSuckerMovements.mock.calls.length, 0)
})

test('history retains pending status without fabricating a proof and sorts returned movements newest first', async () => {
  const f = fixture({ count: 2n })
  const claimable = sdkMovement()
  const pending: JBSuckerMovement = { ...sdkMovement(), leaf: { ...claimable.leaf, index: 1n }, blockNumber: 105n,
    status: 'pending', canExecute: true, proof: null }
  mocks.getSuckerMovements.mockResolvedValue([claimable, pending])
  const rows = await readFundBridgeMovements(f.clients, f.route)
  assert.equal(rows[0].status, 'pending')
  assert.equal(rows[0].proof, null)
  assert.equal(rows[0].inboxRoot, null)
  assert.equal(rows[0].canExecute, true)
  assert.equal(rows[1].status, 'claimable')
})

test('SDK history and mapping verification failures propagate instead of producing fallback claims', async () => {
  const f = fixture()
  const failure = new Error('The supplied historical token does not match the sucker live mapping.')
  mocks.getSuckerMovements.mockRejectedValueOnce(failure)
  await assert.rejects(() => readFundBridgeMovements(f.clients, f.route), error => error === failure)
  const excessMovement = sdkMovement()
  mocks.getSuckerMovements.mockResolvedValueOnce(Array.from({ length: 4097 }, () => excessMovement))
  await assert.rejects(() => readFundBridgeMovements(f.clients, f.route), /movement count/)
})
