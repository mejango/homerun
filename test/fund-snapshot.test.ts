import { describe, expect, it, vi } from 'vitest'
import { jbContractAddress } from '@bananapus/nana-sdk-core'
import { v6Address, type JBRuleset } from '@bananapus/nana-sdk-core/v6'
import { getAddress, zeroAddress, type Address, type Hex, type PublicClient } from 'viem'
import { initialFundRuleset } from '../src/lib/fund-contracts'
import { readFundOwnershipSnapshot, readFundOwnershipForGlobalSnapshot, type FundSnapshotInput } from '../src/lib/fund-snapshot'

const CHAIN_ID = 1
const PROJECT_ID = 7n
const CREATION_BLOCK = 40n
const SNAPSHOT_BLOCK = 120n
const HASH = `0x${'ab'.repeat(32)}` as Hex
const REORG_HASH = `0x${'cd'.repeat(32)}` as Hex
const TRANSACTION_HASH = `0x${'ef'.repeat(32)}` as Hex
const OWNER = '0x1111111111111111111111111111111111111111' as const
const ALICE = '0x2222222222222222222222222222222222222222' as const
const BOB = '0x3333333333333333333333333333333333333333' as const
const CAROL = '0x4444444444444444444444444444444444444444' as const
const DAVE = '0x5555555555555555555555555555555555555555' as const
const TOKEN = '0x6666666666666666666666666666666666666666' as const
const IMPLEMENTATION = '0x7777777777777777777777777777777777777777' as const
const SUCKER = '0x8888888888888888888888888888888888888888' as const
const PROJECTS = v6Address('JBProjects', CHAIN_ID)
const TOKENS = v6Address('JBTokens', CHAIN_ID)
const CONTROLLER = v6Address('JBController', CHAIN_ID)
const DIRECTORY = v6Address('JBDirectory', CHAIN_ID)
const SUCKER_REGISTRY = v6Address('JBSuckerRegistry', CHAIN_ID)
const CLONE_CODE = `0x363d3d373d3d3d363d73${IMPLEMENTATION.slice(2)}5af43d82803e903d91602b57fd5bf3` as Hex

type ReadRequest = { address: Address; functionName: string; args?: readonly unknown[]; blockNumber?: bigint }
type LogRequest = { address: Address; event: { name: string }; args?: { projectId: bigint }; fromBlock: bigint; toBlock: bigint; strict?: boolean }
type Log = {
  eventName: string; address: Address; blockNumber: bigint; blockHash: Hex;
  transactionHash: Hex; logIndex: number; args: Record<string, unknown>; removed?: boolean;
}
type Holder = { holder: Address; creditBalance: bigint; erc20Balance: bigint; reportedTotal?: bigint }
type Metadata = ReturnType<typeof initialFundRuleset>['metadata']
type FixtureOptions = {
  token?: Address
  holders?: Holder[]
  logs?: Log[]
  ruleset?: Partial<JBRuleset>
  metadata?: Partial<Metadata>
  values?: Record<string, unknown>
  tokenCode?: Hex
}

function log(eventName: string, args: Record<string, unknown>, blockNumber: bigint, logIndex: number): Log {
  return {
    eventName, address: eventName === 'Create' ? PROJECTS : eventName === 'Transfer' ? TOKEN : TOKENS,
    blockNumber, blockHash: HASH, transactionHash: TRANSACTION_HASH, logIndex,
    args: eventName === 'Transfer' ? args : { projectId: PROJECT_ID, ...args },
  }
}

function mixedHistory(): Log[] {
  return [
    log('Create', { owner: OWNER, caller: OWNER }, CREATION_BLOCK, 0),
    log('Mint', { holder: ALICE, count: 100n, tokensWereClaimed: false, caller: OWNER }, 41n, 1),
    log('DeployERC20', { token: TOKEN, name: 'FUND', symbol: 'FUND', salt: HASH, caller: OWNER }, 42n, 2),
    log('ClaimTokens', { holder: ALICE, beneficiary: BOB, count: 40n, creditBalance: 60n, caller: ALICE }, 43n, 3),
    log('Transfer', { from: zeroAddress, to: BOB, value: 40n }, 43n, 4),
    log('TransferCredits', { holder: ALICE, recipient: CAROL, count: 20n, caller: ALICE }, 44n, 5),
    log('Transfer', { from: BOB, to: DAVE, value: 10n }, 45n, 6),
    log('Burn', { holder: ALICE, count: 5n, creditBalance: 35n, tokenBalance: 0n, caller: OWNER }, 46n, 7),
  ]
}

/** Canonical addresses, call arguments, and pinned blocks are asserted inside every RPC read. */
function fixture(options: FixtureOptions = {}) {
  const token = options.token ?? TOKEN
  const holders = options.holders ?? [
    { holder: ALICE, creditBalance: 35n, erc20Balance: 0n },
    { holder: BOB, creditBalance: 0n, erc20Balance: 30n },
    { holder: CAROL, creditBalance: 20n, erc20Balance: 0n },
    { holder: DAVE, creditBalance: 0n, erc20Balance: 10n },
  ]
  const logs = options.logs ?? mixedHistory()
  const totalCreditSupply = holders.reduce((sum, row) => sum + row.creditBalance, 0n)
  const totalErc20Supply = holders.reduce((sum, row) => sum + row.erc20Balance, 0n)
  // uint48 and uint32 decode to number, not bigint, with the real SDK ABI.
  const ruleset: JBRuleset = {
    cycleNumber: 1, id: 71, basedOnId: 0, start: 1_800_000_000, duration: 0,
    weight: 10n ** 18n, weightCutPercent: 0, approvalHook: zeroAddress, metadata: 0n,
    ...options.ruleset,
  }
  const metadata: Metadata = {
    ...initialFundRuleset().metadata, pausePay: true, allowOwnerMinting: false,
    cashOutTaxRate: 10_000, dataHook: zeroAddress, useDataHookForPay: false,
    useDataHookForCashOut: false, ...options.metadata,
  }
  const canonicalReads: Record<string, [Address, unknown]> = {
    ownerOf: [PROJECTS, OWNER], controllerOf: [DIRECTORY, CONTROLLER], tokenOf: [TOKENS, token],
    totalSupplyOf: [TOKENS, totalCreditSupply + totalErc20Supply], totalCreditSupplyOf: [TOKENS, totalCreditSupply],
    pendingReservedTokenBalanceOf: [CONTROLLER, 0n], currentRulesetOf: [CONTROLLER, [ruleset, metadata]],
    upcomingRulesetOf: [CONTROLLER, [{ ...ruleset, id: 0 }, metadata]],
    latestQueuedRulesetOf: [CONTROLLER, [ruleset, metadata, 1]], allSuckersOf: [SUCKER_REGISTRY, []],
    TOKEN: [TOKENS, IMPLEMENTATION], totalSupply: [token, totalErc20Supply],
  }
  const readContract = vi.fn(async (request: ReadRequest): Promise<unknown> => {
    if (request.functionName === 'count') {
      expect(request.address).toBe(PROJECTS)
      expect(request.blockNumber).toBeTypeOf('bigint')
      return request.blockNumber! < CREATION_BLOCK ? PROJECT_ID - 1n : PROJECT_ID
    }
    expect(request.blockNumber).toBe(SNAPSHOT_BLOCK)
    if (['creditBalanceOf', 'totalBalanceOf', 'balanceOf'].includes(request.functionName)) {
      const erc20 = request.functionName === 'balanceOf'
      expect(request.address).toBe(erc20 ? token : TOKENS)
      expect(request.args).toEqual(erc20 ? [expect.any(String)] : [expect.any(String), PROJECT_ID])
      const row = holders.find(holder => holder.holder.toLowerCase() === String(request.args![0]).toLowerCase())
      if (!row) return 0n
      if (request.functionName === 'creditBalanceOf') return row.creditBalance
      if (erc20) return row.erc20Balance
      return row.reportedTotal ?? row.creditBalance + row.erc20Balance
    }
    const expected = canonicalReads[request.functionName]
    if (!expected) throw new Error(`Unexpected snapshot read: ${request.functionName}`)
    expect(request.address).toBe(expected[0])
    expect(request.args).toEqual(['TOKEN', 'totalSupply'].includes(request.functionName) ? undefined : [PROJECT_ID])
    return Object.hasOwn(options.values ?? {}, request.functionName) ? options.values![request.functionName] : expected[1]
  })
  const getCode = vi.fn(async (request: { address: Address; blockNumber: bigint }) => {
    if (request.address === PROJECTS) return request.blockNumber < 20n ? undefined : '0x6000'
    expect(request).toEqual({ address: token, blockNumber: SNAPSHOT_BLOCK })
    return options.tokenCode ?? CLONE_CODE
  })
  const matchingLogs = (request: LogRequest) => {
    expect(request.strict).toBe(true)
    expect(request.address).toBe(request.event.name === 'Create' ? PROJECTS : request.event.name === 'Transfer' ? token : TOKENS)
    expect(request.args).toEqual(request.event.name === 'Transfer' ? undefined : { projectId: PROJECT_ID })
    return logs.filter(row => row.eventName === request.event.name && row.blockNumber >= request.fromBlock && row.blockNumber <= request.toBlock)
  }
  const getLogs = vi.fn(async (request: LogRequest): Promise<Log[]> => matchingLogs(request))
  const getBlock = vi.fn(async (_request: { blockTag?: string; blockNumber?: bigint }) => ({
    number: SNAPSHOT_BLOCK, hash: HASH, timestamp: 1_800_000_100n,
  }))
  const getChainId = vi.fn(async (): Promise<number> => CHAIN_ID)
  const client = { getChainId, getBlock, getCode, getLogs, readContract } as unknown as PublicClient
  return { client, holders, logs, ruleset, metadata, getChainId, getBlock, getCode, getLogs, readContract, matchingLogs }
}

function read(rpc: ReturnType<typeof fixture>, input: Partial<FundSnapshotInput> = {}) {
  return readFundOwnershipSnapshot(rpc.client, {
    chainId: CHAIN_ID, projectId: PROJECT_ID, snapshotBlockNumber: SNAPSHOT_BLOCK,
    creationBlockNumber: CREATION_BLOCK, ...input,
  })
}

describe('canonical FUND ownership snapshot', () => {
  it('reconciles credits and ERC20 ownership after claims to a different beneficiary, credit transfers, token transfers, and burns', async () => {
    const rpc = fixture()
    const progress = vi.fn()
    const result = await read(rpc, { onProgress: progress })
    expect(result).toMatchObject({
      chainId: CHAIN_ID, projectId: PROJECT_ID, blockNumber: SNAPSHOT_BLOCK, blockHash: HASH,
      blockTimestamp: 1_800_000_100n, creationBlockNumber: CREATION_BLOCK,
      creationTransactionHash: TRANSACTION_HASH, owner: OWNER, tokenAddress: TOKEN,
      totalFundSupply: 95n, totalCreditSupply: 55n, totalErc20Supply: 40n,
      holders: rpc.holders.map(row => ({ ...row, balance: row.creditBalance + row.erc20Balance })),
      evidence: {
        projects: PROJECTS, tokens: TOKENS, controller: CONTROLLER, suckerRegistry: SUCKER_REGISTRY,
        eventCounts: { Mint: 1, Burn: 1, ClaimTokens: 1, TransferCredits: 1, DeployERC20: 1, Transfer: 2 },
        candidateCount: 5, bridgePolicy: 'no-historical-suckers',
      },
    })
    expect(rpc.getBlock.mock.calls).toEqual([[{ blockNumber: SNAPSHOT_BLOCK }], [{ blockNumber: SNAPSHOT_BLOCK }]])
    expect(rpc.readContract.mock.calls.every(([request]) => request.blockNumber === SNAPSHOT_BLOCK)).toBe(true)
    expect(progress.mock.calls.at(-1)?.[0]).toEqual({ stage: 'complete', completed: 4n, total: 4n, candidates: 5 })
  })

  it('can discover a claimed-token beneficiary even without the redundant ERC20 mint event', async () => {
    const rpc = fixture({
      holders: [{ holder: BOB, creditBalance: 0n, erc20Balance: 100n }],
      logs: [
        mixedHistory()[0], mixedHistory()[1], mixedHistory()[2],
        log('ClaimTokens', { holder: ALICE, beneficiary: BOB, count: 100n, creditBalance: 0n, caller: ALICE }, 43n, 3),
      ],
    })
    expect((await read(rpc)).holders).toEqual([{ holder: BOB, creditBalance: 0n, erc20Balance: 100n, balance: 100n }])
  })

  it('supports credit-only FUND with no ERC20 deployment or ERC20 reads', async () => {
    const rpc = fixture({
      token: zeroAddress, holders: [{ holder: CAROL, creditBalance: 100n, erc20Balance: 0n }],
      logs: [mixedHistory()[0], mixedHistory()[1], log('TransferCredits', { holder: ALICE, recipient: CAROL, count: 100n }, 44n, 2)],
    })
    const result = await read(rpc)
    expect(result).toMatchObject({ tokenAddress: null, totalCreditSupply: 100n, totalErc20Supply: 0n })
    expect(result.holders).toEqual([{ holder: CAROL, balance: 100n, creditBalance: 100n, erc20Balance: 0n }])
    expect(rpc.getCode).not.toHaveBeenCalled()
    expect(rpc.getLogs.mock.calls.some(([request]) => request.event.name === 'Transfer')).toBe(false)
    expect(rpc.readContract.mock.calls.some(([request]) => ['TOKEN', 'totalSupply', 'balanceOf'].includes(request.functionName))).toBe(false)
  })

  it('retains positive zero-address credits in the denominator instead of dropping them', async () => {
    const rpc = fixture()
    rpc.holders[0].creditBalance = 30n
    rpc.holders.push({ holder: zeroAddress, creditBalance: 5n, erc20Balance: 0n })
    rpc.logs.push(log('TransferCredits', { holder: ALICE, recipient: zeroAddress, count: 5n }, 47n, 8))
    const result = await read(rpc)
    expect(result.holders[0]).toEqual({ holder: zeroAddress, balance: 5n, creditBalance: 5n, erc20Balance: 0n })
    expect(result.holders.reduce((sum, row) => sum + row.balance, 0n)).toBe(95n)
  })

  it('includes more than 200 holders without imposing the old atomic-launch cap', async () => {
    const holders = Array.from({ length: 205 }, (_, index) => ({
      holder: getAddress(`0x${(index + 1).toString(16).padStart(40, '0')}`), creditBalance: 1n, erc20Balance: 0n,
    }))
    const rpc = fixture({
      token: zeroAddress, holders,
      logs: [mixedHistory()[0], ...holders.map((row, index) => log('Mint', { holder: row.holder, count: 1n }, 41n + BigInt(index % 60), index + 1))],
    })
    const result = await read(rpc, { logBlockWindow: 13n })
    expect(result.holders).toHaveLength(205)
    expect(result.totalFundSupply).toBe(205n)
    expect(result.holders.map(row => row.holder)).toEqual(holders.map(row => row.holder))
  })

  it('adds and deduplicates candidate hints without replacing canonical history', async () => {
    const rpc = fixture()
    const result = await read(rpc, { candidateHints: [BOB, BOB, OWNER] })
    expect(result.holders).toHaveLength(4)
    expect(result.evidence.candidateCount).toBe(5)
    expect(rpc.getLogs.mock.calls.some(([request]) => request.event.name === 'TransferCredits')).toBe(true)
    expect(rpc.readContract.mock.calls.filter(([request]) => request.functionName === 'creditBalanceOf' && request.args![0] === BOB)).toHaveLength(1)
  })

  it('does not treat a full user-supplied holder list as permission to skip unavailable history', async () => {
    const rpc = fixture()
    rpc.getLogs.mockImplementation(async request => {
      if (request.event.name === 'Mint') throw new Error('history unavailable')
      return rpc.matchingLogs(request)
    })
    await expect(read(rpc, { candidateHints: rpc.holders.map(row => row.holder) })).rejects.toThrow('Canonical Mint history could not be read')
  })

  it('rejects missing holder history even when the remaining RPC logs appear valid', async () => {
    const rpc = fixture({ logs: mixedHistory().filter(row => row.eventName !== 'TransferCredits') })
    await expect(read(rpc)).rejects.toThrow('ownership history is incomplete')
  })

  it.each([
    ['inflated combined supply', { totalSupplyOf: 96n }, 'supplies do not reconcile'],
    ['credit supply above combined supply', { totalCreditSupplyOf: 96n }, 'supply cannot support'],
    ['no FUND supply', { totalSupplyOf: 0n, totalCreditSupplyOf: 0n }, 'supply cannot support'],
    ['ERC20 supply mismatch', { totalSupply: 41n }, 'supplies do not reconcile'],
  ])('rejects %s', async (_label, values, message) => {
    await expect(read(fixture({ values }))).rejects.toThrow(message)
  })

  it('rejects a holder whose totalBalanceOf disagrees with credits plus ERC20 balance', async () => {
    const rpc = fixture()
    rpc.holders[0].reportedTotal = 36n
    await expect(read(rpc)).rejects.toThrow('holder balance did not reconcile')
  })

  it.each([
    ['pay enabled', { pausePay: false }],
    ['owner minting enabled', { allowOwnerMinting: true }],
    ['cashouts enabled', { cashOutTaxRate: 0 }],
  ])('rejects unfinished FUND with %s', async (_label, metadata) => {
    await expect(read(fixture({ metadata }))).rejects.toThrow('requires a closed FUND')
  })

  it('rejects pending reserved tokens', async () => {
    await expect(read(fixture({ values: { pendingReservedTokenBalanceOf: 1n } }))).rejects.toThrow('no pending reserved tokens')
  })

  it('rejects a zero ruleset ID using the actual SDK numeric decoding', async () => {
    await expect(read(fixture({ ruleset: { id: 0 } }))).rejects.toThrow('requires a closed FUND')
  })

  it.each(['upcomingRulesetOf', 'latestQueuedRulesetOf'])('rejects a future ruleset returned by %s', async function (functionName) {
    const baseline = fixture()
    const rpc = fixture({ values: { [functionName]: [{ ...baseline.ruleset, id: 72 }, baseline.metadata, 1] } })
    await expect(read(rpc)).rejects.toThrow('pending rulesets')
  })

  it.each([
    ['recurring ruleset', { duration: 86_400 }],
    ['weight cut', { weightCutPercent: 1 }],
    ['approval hook', { approvalHook: OWNER }],
  ])('rejects a %s', async (_label, ruleset) => {
    await expect(read(fixture({ ruleset }))).rejects.toThrow('custom hooks, scheduled rules')
  })

  it.each([
    ['data hook', { dataHook: OWNER }],
    ['pay hook', { useDataHookForPay: true }],
    ['cashout hook', { useDataHookForCashOut: true }],
  ])('rejects a custom %s', async (_label, metadata) => {
    await expect(read(fixture({ metadata }))).rejects.toThrow('custom hooks')
  })

  it('rejects historical suckers even when no active-peer lookup would find them', async () => {
    const rpc = fixture({ values: { allSuckersOf: [SUCKER] } })
    await expect(read(rpc)).rejects.toThrow('historical bridges')
    expect(rpc.readContract.mock.calls.some(([request]) => request.functionName === 'allSuckersOf')).toBe(true)
    expect(rpc.readContract.mock.calls.some(([request]) => request.functionName === 'suckerPairsOf')).toBe(false)
    expect(rpc.getLogs).not.toHaveBeenCalled()
  })

  it.each([
    ['custom controller', { controllerOf: OWNER }],
    ['zero owner', { ownerOf: zeroAddress }],
  ])('rejects %s', async (_label, values) => {
    await expect(read(fixture({ values }))).rejects.toThrow('controller or owner is unsupported')
  })

  it.each(['0x6000', '0x', `0x363d3d373d3d3d363d73${OWNER.slice(2)}5af43d82803e903d91602b57fd5bf3`] as Hex[])('rejects a noncanonical FUND token runtime: %s', async tokenCode => {
    await expect(read(fixture({ tokenCode }))).rejects.toThrow('canonical core FUND ERC-20 clones')
  })

  it.each(['missing', 'different token'])('rejects a canonical clone with a %s core deployment event', async mode => {
    const logs = mixedHistory().filter(row => row.eventName !== 'DeployERC20')
    if (mode === 'different token') logs.push(log('DeployERC20', { token: OWNER }, 42n, 9))
    await expect(read(fixture({ logs }))).rejects.toThrow('deployment event is missing')
  })

  it('rejects an RPC for the wrong chain before reading project data', async () => {
    const rpc = fixture()
    rpc.getChainId.mockResolvedValue(10)
    await expect(read(rpc)).rejects.toThrow('different snapshot chain')
    expect(rpc.readContract).not.toHaveBeenCalled()
  })

  it('rejects a changed snapshot hash without returning a partially valid result', async () => {
    const rpc = fixture()
    rpc.getBlock.mockResolvedValueOnce({ number: SNAPSHOT_BLOCK, hash: HASH, timestamp: 1_800_000_100n })
      .mockResolvedValueOnce({ number: SNAPSHOT_BLOCK, hash: REORG_HASH, timestamp: 1_800_000_100n })
    const progress = vi.fn()
    await expect(read(rpc, { onProgress: progress })).rejects.toThrow('chain reorganized')
    expect(progress.mock.calls.some(([value]) => value.stage === 'complete')).toBe(false)
  })

  it('rejects an RPC block that differs from the explicitly requested snapshot', async () => {
    const rpc = fixture()
    rpc.getBlock.mockResolvedValue({ number: SNAPSHOT_BLOCK + 1n, hash: HASH, timestamp: 1_800_000_100n })
    await expect(read(rpc)).rejects.toThrow('mined snapshot block')
  })

  it('pins finalized-block requests before any state or history is read', async () => {
    const rpc = fixture()
    await read(rpc, { snapshotBlockNumber: undefined })
    expect(rpc.getBlock.mock.calls[0]).toEqual([{ blockTag: 'finalized' }])
    expect(rpc.readContract.mock.calls.every(([request]) => request.blockNumber === SNAPSHOT_BLOCK)).toBe(true)
  })

  it('fails clearly if the provider cannot read finalized blocks instead of falling back to latest', async () => {
    const rpc = fixture()
    rpc.getBlock.mockRejectedValue(new Error('Unsupported block tag'))
    await expect(read(rpc, { snapshotBlockNumber: undefined })).rejects.toThrow('finalized snapshot block')
    expect(rpc.getBlock).toHaveBeenCalledOnce()
    expect(rpc.readContract).not.toHaveBeenCalled()
  })
})

describe('FUND history pagination and provenance', () => {
  it('recovers from provider range errors by bisecting without omitting either half', async () => {
    const rpc = fixture()
    const failedRanges: [bigint, bigint][] = []
    rpc.getLogs.mockImplementation(async request => {
      if (request.event.name === 'Transfer' && request.toBlock - request.fromBlock > 4n) {
        failedRanges.push([request.fromBlock, request.toBlock])
        throw new Error('RPC block-range limit exceeded')
      }
      return rpc.matchingLogs(request)
    })
    const result = await read(rpc)
    expect(failedRanges.length).toBeGreaterThan(1)
    expect(result.holders).toHaveLength(4)
    const successfulRanges = rpc.getLogs.mock.calls.map(([request]) => request)
      .filter(request => request.event.name === 'Transfer' && request.toBlock - request.fromBlock <= 4n)
    expect(successfulRanges[0].fromBlock).toBe(CREATION_BLOCK)
    expect(successfulRanges.at(-1)?.toBlock).toBe(SNAPSHOT_BLOCK)
    for (let index = 1; index < successfulRanges.length; index++) {
      expect(successfulRanges[index].fromBlock).toBe(successfulRanges[index - 1].toBlock + 1n)
    }
  })

  it('bisects saturated successful responses as well as RPC errors', async () => {
    const rpc = fixture()
    const result = await read(rpc, { logResponseLimit: 2 })
    expect(result.evidence.eventCounts.Transfer).toBe(2)
    const transferRequests = rpc.getLogs.mock.calls.map(([request]) => request).filter(request => request.event.name === 'Transfer')
    expect(transferRequests.length).toBeGreaterThan(1)
    expect(transferRequests.some(request => request.toBlock < 45n)).toBe(true)
    expect(transferRequests.some(request => request.fromBlock >= 45n)).toBe(true)
  })

  it('fails closed when a single block saturates the provider response limit', async () => {
    const rpc = fixture()
    rpc.logs.push(log('Mint', { holder: OWNER, count: 1n }, 41n, 20))
    await expect(read(rpc, { logResponseLimit: 2 })).rejects.toThrow('truncated Mint history in a single block')
  })

  it('fails closed when even a single block cannot be read', async () => {
    const rpc = fixture()
    rpc.getLogs.mockImplementation(async request => {
      if (request.event.name === 'Burn' && request.fromBlock <= 46n && request.toBlock >= 46n) throw new Error('unavailable')
      return rpc.matchingLogs(request)
    })
    await expect(read(rpc)).rejects.toThrow('Canonical Burn history could not be read at block 46')
  })

  it.each([
    ['removed log', (row: Log) => { row.removed = true }],
    ['wrong emitter', (row: Log) => { row.address = OWNER }],
    ['wrong project', (row: Log) => { row.args.projectId = PROJECT_ID + 1n }],
  ])('rejects a %s', async (_label, corrupt) => {
    const rpc = fixture()
    corrupt(rpc.logs.find(row => row.eventName === 'Mint')!)
    await expect(read(rpc)).rejects.toThrow(/inconsistent FUND history|different FUND project/)
  })

  it('rejects duplicate RPC history entries instead of using them as evidence', async () => {
    const rpc = fixture()
    rpc.logs.push({ ...rpc.logs[1] })
    await expect(read(rpc)).rejects.toThrow('duplicate FUND history')
  })

  it('verifies a supplied creation-block hint against the canonical Create event', async () => {
    const rpc = fixture()
    await expect(read(rpc, { creationBlockNumber: CREATION_BLOCK + 1n })).rejects.toThrow('creation event could not be verified')
    expect(rpc.getLogs.mock.calls).toHaveLength(1)
    expect(rpc.getLogs.mock.calls[0][0]).toMatchObject({
      address: PROJECTS, fromBlock: CREATION_BLOCK + 1n, toBlock: CREATION_BLOCK + 1n,
      args: { projectId: PROJECT_ID },
    })
  })

  it('binary-searches canonical project counts and verifies the exact creation event when no hint exists', async () => {
    const rpc = fixture()
    const result = await read(rpc, { creationBlockNumber: undefined })
    expect(result.creationBlockNumber).toBe(CREATION_BLOCK)
    expect(rpc.readContract.mock.calls.filter(([request]) => request.functionName === 'count').length).toBeGreaterThan(1)
    expect(rpc.getLogs.mock.calls[0][0]).toMatchObject({
      address: PROJECTS, event: { name: 'Create' }, fromBlock: CREATION_BLOCK, toBlock: CREATION_BLOCK,
    })
  })

  it.each([-1n, SNAPSHOT_BLOCK + 1n])('rejects creation hints outside the snapshot history: %s', async creationBlockNumber => {
    await expect(read(fixture(), { creationBlockNumber })).rejects.toThrow('outside the snapshot history')
  })

  it('stops immediately when cancelled before any RPC request', async () => {
    const rpc = fixture()
    const controller = new AbortController()
    controller.abort()
    await expect(read(rpc, { signal: controller.signal })).rejects.toThrow('cancelled')
    expect(rpc.getChainId).not.toHaveBeenCalled()
  })

  it('cancels a paginated scan without starting another range or returning partial holders', async () => {
    const rpc = fixture()
    const controller = new AbortController()
    const onProgress = vi.fn(progress => { if (progress.stage === 'history') controller.abort() })
    await expect(read(rpc, { signal: controller.signal, logBlockWindow: 2n, onProgress })).rejects.toThrow('cancelled')
    expect(rpc.getLogs.mock.calls.every(([request]) => request.toBlock <= 41n)).toBe(true)
    expect(onProgress.mock.calls.some(([progress]) => progress.stage === 'complete')).toBe(false)
  })

  it.each([
    { logBlockWindow: 0n }, { logBlockWindow: 100_001n }, { logResponseLimit: 1 }, { logResponseLimit: 1.5 },
  ])('rejects invalid pagination configuration %s', async input => {
    const rpc = fixture()
    await expect(read(rpc, input)).rejects.toThrow('pagination settings')
    expect(rpc.getChainId).not.toHaveBeenCalled()
  })
})

describe('canonical Sticky custody in the fixed FUND snapshot', () => {
  it.each(['positive', 'empty', 'wrong-token', 'wrong-wiring'] as const)('verifies every discovered Sticky project (%s)', async mode => {
    const registry = jbContractAddress['6'] as Record<string, Record<number, Address> | undefined>
    const previous = registry.JBStickyDeployer
    const factory = getAddress('0x9999999999999999999999999999999999999999')
    registry.JBStickyDeployer = { [CHAIN_ID]: factory }
    const terminal = v6Address('JBMultiTerminal', CHAIN_ID)
    const store = v6Address('JBTerminalStore', CHAIN_ID)
    const rpc = fixture()
    const originalCode = rpc.getCode.getMockImplementation()!
    const originalRead = rpc.readContract.getMockImplementation()!
    const originalLogs = rpc.getLogs.getMockImplementation()!
    rpc.getCode.mockImplementation(async request => request.address === factory ? '0x6001' : originalCode(request))
    rpc.readContract.mockImplementation(async request => {
      expect(request.blockNumber).toBe(SNAPSHOT_BLOCK)
      if (request.address === factory) {
        if (request.functionName === 'CONTROLLER') return mode === 'wrong-wiring' ? OWNER : CONTROLLER
        if (request.functionName === 'TOKENS') return TOKENS
        if (request.functionName === 'TERMINAL') return terminal
        if (request.functionName === 'stakedTokenOf') { expect(request.args).toEqual([99n]); return mode === 'wrong-token' ? OWNER : TOKEN }
      }
      if (request.address === store) {
        expect(request.functionName).toBe('balanceOf')
        expect(request.args).toEqual([terminal, 99n, TOKEN])
        return mode === 'positive' ? 10n ** 18n : 0n
      }
      return originalRead(request)
    })
    rpc.getLogs.mockImplementation(async request => {
      if (request.event.name !== 'DeploySticky') return originalLogs(request)
      expect(request.address).toBe(factory)
      expect(request.args).toEqual({ stakedToken: TOKEN })
      return [{ ...log('DeploySticky', { projectId: 99n, stakedToken: TOKEN }, 80n, 99), address: factory }]
    })
    try {
      if (mode === 'positive') await expect(read(rpc)).rejects.toMatchObject({ code: 'UNRESOLVED_STICKY_CUSTODY', positions: [{ chainId: CHAIN_ID, projectId: 99n, terminal, backing: 10n ** 18n }] })
      else if (mode === 'wrong-token') await expect(read(rpc)).rejects.toThrow('immutable underlying token')
      else if (mode === 'wrong-wiring') await expect(read(rpc)).rejects.toThrow('canonical FUND custody contracts')
      else expect((await read(rpc)).evidence.eventCounts.DeploySticky).toBe(1)
    } finally {
      if (previous) registry.JBStickyDeployer = previous
      else delete registry.JBStickyDeployer
    }
  })

  it('does not mistake an unsolicited ERC20 transfer to the shared terminal for a stake', async () => {
    const terminal = getAddress(v6Address('JBMultiTerminal', CHAIN_ID))
    const original = fixture()
    const rpc = fixture({
      holders: [...original.holders.map(row => row.holder === BOB ? { ...row, erc20Balance: row.erc20Balance - 1n } : row), { holder: terminal, creditBalance: 0n, erc20Balance: 1n }],
      logs: [...mixedHistory(), log('Transfer', { from: BOB, to: terminal, value: 1n }, 81n, 100)],
    })
    const result = await read(rpc)
    expect(result.holders.find(row => row.holder === terminal)?.balance).toBe(1n)
    expect(result.totalFundSupply).toBe(95n)
  })
})

describe('local components of a global snapshot', () => {
  const component = (rpc: ReturnType<typeof fixture>) => readFundOwnershipForGlobalSnapshot(rpc.client, { chainId: CHAIN_ID, projectId: PROJECT_ID, snapshotBlockNumber: SNAPSHOT_BLOCK, creationBlockNumber: CREATION_BLOCK })

  it('retains all historical suckers while marking the result incomplete without global reconciliation', async () => {
    const rpc = fixture({ values: { allSuckersOf: [SUCKER] } })
    const result = await component(rpc)
    expect(result.historicalSuckers).toEqual([SUCKER])
    expect(result.evidence.bridgePolicy).toBe('historical-graph-required')
    expect(result.totalFundSupply).toBe(95n)
    await expect(read(rpc)).rejects.toThrow('historical bridges')
  })

  it('allows an empty local supply because its entire balance can be in outgoing bridge leaves', async () => {
    const rpc = fixture({ holders: [], values: { allSuckersOf: [SUCKER] } })
    const result = await component(rpc)
    expect(result.totalFundSupply).toBe(0n)
    expect(result.holders).toEqual([])
    const standalone = fixture({ holders: [] })
    await expect(read(standalone)).rejects.toThrow('supply')
  })

  it.each([false, true])('verifies the canonical omnichain wrapper without allowing an extra custom hook (custom=%s)', async custom => {
    const omnichain = v6Address('JBOmnichainDeployer', CHAIN_ID)
    const rpc = fixture({ metadata: { dataHook: omnichain, useDataHookForPay: true, useDataHookForCashOut: true }, values: { allSuckersOf: [SUCKER] } })
    const original = rpc.readContract.getMockImplementation()!
    rpc.readContract.mockImplementation(async request => {
      if (request.address === omnichain) {
        expect(request.args).toEqual([PROJECT_ID, 71n])
        expect(request.blockNumber).toBe(SNAPSHOT_BLOCK)
        if (request.functionName === 'extraDataHookOf') return { dataHook: custom ? OWNER : zeroAddress, useDataHookForPay: false, useDataHookForCashOut: false }
        if (request.functionName === 'tiered721HookOf') return [zeroAddress, false]
      }
      return original(request)
    })
    if (custom) await expect(component(rpc)).rejects.toThrow('custom hooks')
    else expect((await component(rpc)).totalFundSupply).toBe(95n)
    await expect(read(rpc)).rejects.toThrow('historical bridges')
  })

  it.each(['empty', 'tiers', 'wrong-store', 'wrong-project', 'wrong-scope', 'wrong-owner', 'cash-out'] as const)('checks an existing omnichain NFT hook before accepting a closed global component (%s)', async mode => {
    const omnichain = v6Address('JBOmnichainDeployer', CHAIN_ID)
    const hook = '0x00000000000000000000000000000000000000AA'
    const store = v6Address('JB721TiersHookStore', CHAIN_ID)
    const rpc = fixture({ metadata: { dataHook: omnichain, useDataHookForPay: true, useDataHookForCashOut: true }, values: { allSuckersOf: [SUCKER] } })
    const original = rpc.readContract.getMockImplementation()!
    rpc.readContract.mockImplementation(async request => {
      expect(request.blockNumber).toBe(SNAPSHOT_BLOCK)
      if (request.address === omnichain && request.functionName === 'extraDataHookOf') return { dataHook: zeroAddress, useDataHookForPay: false, useDataHookForCashOut: false }
      if (request.address === omnichain && request.functionName === 'tiered721HookOf') return [hook, mode === 'cash-out']
      if (request.address === hook) {
        if (request.functionName === 'STORE') return mode === 'wrong-store' ? OWNER : store
        if (request.functionName === 'projectId') return mode === 'wrong-project' ? PROJECT_ID + 1n : PROJECT_ID
        if (request.functionName === 'jbOwner') return [zeroAddress, mode === 'wrong-scope' ? PROJECT_ID + 1n : PROJECT_ID, 0]
        if (request.functionName === 'owner') return mode === 'wrong-owner' ? zeroAddress : OWNER
      }
      if (request.address === store && request.functionName === 'maxTierIdOf') return mode === 'tiers' ? 1n : 0n
      return original(request)
    })
    if (mode === 'empty') expect((await component(rpc)).totalFundSupply).toBe(95n)
    else await expect(component(rpc)).rejects.toThrow()
  })
})
