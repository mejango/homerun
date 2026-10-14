import { placeReceipt } from './support/recovery-receipt'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MappableAsset, parseSuckerDeployerConfig, type JBChainId } from '@bananapus/nana-sdk-core'
import { encodeAbiParameters, encodeEventTopics, encodeFunctionData, parseAbi, zeroAddress, zeroHash, type Hex, type PublicClient } from 'viem'
import { homerunDeployerAbi, INITIAL_INCOME_SUPPLY } from '../src/lib/income-contracts'
import type { FundTransaction } from '../src/lib/fund-contracts'
import {
  clearIncomeLaunchPending, exportIncomeLaunchPending, incomeLaunchAttempt, incomeLaunchRequest, incomeLaunchIntent, incomeLaunchRecord,
  incomeLaunchSessionKey, readIncomeLaunchPending, verifyIncomeLaunchExecution, type IncomeLaunchPending, type IncomeLaunchStorage,
} from '../src/lib/income-launch-session'
import { safeExecutionLog } from './support/safe-logs'

const { registered } = vi.hoisted(() => ({ registered: vi.fn() }))
vi.mock('../src/lib/income-contracts', async importOriginal => ({ ...await importOriginal<typeof import('../src/lib/income-contracts')>(), registeredHomerunDeployer: registered }))
const HOLDER = '0x1111111111111111111111111111111111111111'
const TARGET = '0x2222222222222222222222222222222222222222'
const OTHER = '0x3333333333333333333333333333333333333333'
const HASH = `0x${'ab'.repeat(32)}` as Hex
const EXECUTION_HASH = `0x${'ef'.repeat(32)}` as Hex
const BLOCK_HASH = `0x${'cd'.repeat(32)}` as Hex
const key = incomeLaunchSessionKey(1, 9n)
const allocation = { chainId: 1, fundProjectId: 9n, snapshotBlockNumber: 90n, snapshotBlockHash: BLOCK_HASH, incomeAmount: INITIAL_INCOME_SUPPLY }
const snapshot = { sourceSetHash: HASH, totalFundSupply: 1_000_000n, manifestHash: HASH, manifestUri: 'ipfs://manifest', allocations: [allocation] }
const suckersFor = (chainId: JBChainId, chains: JBChainId[]) => parseSuckerDeployerConfig(chainId, chains, [MappableAsset.USDC], { version: 6, bridge: 'ccip', salt: HASH })
const args = [9n, snapshot, { name: 'Founder Haus INCOME', ticker: 'RENT', uri: 'ipfs://metadata', salt: HASH }, 8_000, 1_800_000_000, suckersFor(1, [1])] as const
const request: FundTransaction = { chainId: 1, address: TARGET, abi: homerunDeployerAbi, functionName: 'deployIncome', args, value: 100n }
const safeAbi = parseAbi([
  'function execTransaction(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,bytes signatures) payable returns (bool success)',
  'event ExecutionSuccess(bytes32 txHash,uint256 payment)', 'event ExecutionFailure(bytes32 txHash,uint256 payment)',
])
function memory(): IncomeLaunchStorage {
  const items = new Map<string, string>()
  return { getItem: key => items.get(key) ?? null, setItem: (key, value) => { items.set(key, value) }, removeItem: key => { items.delete(key) } }
}
/** A launch as the journal saved it before SDK holds. */
function begin(storage = memory(), safe = false, hash?: Hex) { const record = incomeLaunchRecord(request, 9n, HOLDER, safe, 100n, hash); storage.setItem(key, JSON.stringify(record)); return record }
/** A saved journal record, read back through its validation. */
function readSaved(raw: string) { const storage = memory(); storage.setItem(key, raw); return readIncomeLaunchPending(storage, key) }
function clientFor(record: IncomeLaunchPending, options: { payload?: Hex; sender?: typeof OTHER; target?: typeof OTHER; value?: bigint; chain?: number; block?: bigint; reorg?: boolean; failed?: boolean; safeFailure?: boolean; missingEvent?: boolean; proposal?: Hex; operation?: number; logs?: ReturnType<typeof safeExecutionLog>[] } = {}) {
  const input = record.safe
    ? encodeFunctionData({ abi: safeAbi, functionName: 'execTransaction', args: [options.target ?? TARGET, options.value ?? 100n, options.payload ?? record.data, options.operation ?? 0, 0n, 0n, 0n, zeroAddress, zeroAddress, '0x'] })
    : options.payload ?? record.data
  const transaction = { hash: EXECUTION_HASH, to: record.safe ? HOLDER : options.target ?? TARGET, from: options.sender ?? HOLDER, input, value: record.safe ? 0n : options.value ?? 100n, blockNumber: options.block ?? 101n, blockHash: BLOCK_HASH }
  const logs = options.logs ?? (record.safe && !options.missingEvent ? [{ address: HOLDER, topics: encodeEventTopics({ abi: safeAbi, eventName: options.safeFailure ? 'ExecutionFailure' : 'ExecutionSuccess' }), data: encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint256' }], [options.proposal ?? record.hash ?? HASH, 0n]) }] : [])
  const receipt = { transactionHash: EXECUTION_HASH, status: options.failed ? 'reverted' : 'success', blockNumber: transaction.blockNumber, blockHash: BLOCK_HASH, logs }
  placeReceipt(transaction, receipt)
  return { getChainId: async () => options.chain ?? 1, getTransaction: async () => transaction, getTransactionReceipt: async () => receipt, getBlock: async ({ blockNumber }: { blockNumber?: bigint }) => ({ hash: options.reorg ? HASH : BLOCK_HASH, number: blockNumber ?? 200n, timestamp: 1_000n }) } as unknown as PublicClient
}
beforeEach(() => { registered.mockReturnValue(TARGET) })
afterEach(() => { vi.restoreAllMocks() })

describe('INCOME launch journal identity', () => {
  it('reads a saved hashless launch back as unknown', () => {
    const storage = memory(), record = begin(storage)
    expect(record.phase).toBe('unknown')
    expect(record.hash).toBeUndefined()
    expect(readIncomeLaunchPending(storage, key)).toEqual(record)
  })
  it('keeps a separate namespace from holder Sticky transactions and other FUNDs/chains', () => {
    const storage = memory(); storage.setItem(`homerun:sticky:pending:v1:1:9:${HOLDER}`, 'unrelated')
    begin(storage)
    expect(readIncomeLaunchPending(storage, incomeLaunchSessionKey(10, 9n))).toBeNull()
    expect(readIncomeLaunchPending(storage, incomeLaunchSessionKey(1, 10n))).toBeNull()
  })
  it.each([[0, 9n], [137, 9n], [1, 0n], [1, -1n], [1, 1n << 256n]])('rejects unsupported identities %s/%s', (chain, project) => {
    expect(() => incomeLaunchSessionKey(Number(chain), BigInt(project))).toThrow()
  })
  it('gives each launch record its own session ID', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000)
    expect(begin().sessionId).not.toBe(begin().sessionId)
  })
  it('verifies record removal', () => {
    const storage = memory(); begin(storage)
    clearIncomeLaunchPending(storage, key)
    expect(readIncomeLaunchPending(storage, key)).toBeNull()
    begin(storage); storage.removeItem = () => {}
    expect(() => clearIncomeLaunchPending(storage, key)).toThrow(/could not clear/)
  })
})

describe('strict INCOME launch recovery imports', () => {
  it('rejects a reserved percent above 100% or a blank ticker even when the signer is the FUND owner', () => {
    const storage = memory()
    const record = begin(storage)
    expect(record.holder).toBe(HOLDER)
    expect(readSaved(exportIncomeLaunchPending(record))).toEqual(record)
    for (const bad of [
      [args[0], args[1], args[2], 10_001, args[4], args[5]],
      [args[0], args[1], { ...args[2], ticker: '' }, args[3], args[4], args[5]],
    ] as const) {
      const invalidData = encodeFunctionData({ abi: homerunDeployerAbi, functionName: 'deployIncome', args: bad as unknown as typeof args })
      expect(() => readSaved(JSON.stringify({ ...record, data: invalidData }))).toThrow()
    }
  })
  it('round-trips unknown and pending records without asserting execution', () => {
    const unknown = begin(), pending = begin(memory(), false, HASH)
    expect(pending.phase).toBe('pending')
    expect(readSaved(exportIncomeLaunchPending(unknown))).toEqual(unknown)
    expect(readSaved(exportIncomeLaunchPending(pending))).toEqual(pending)
  })
  it.each([
    { version: 2 }, { kind: 'sticky' }, { sessionId: 'not-unique' }, { phase: 'confirmed' }, { phase: 'reverted' },
    { chainId: 10 }, { projectId: '10' }, { projectId: '09' }, { projectId: (1n << 256n).toString() },
    { holder: zeroAddress }, { holder: '0x1234' }, { target: OTHER }, { value: '-1' }, { value: '01' },
    { value: (1n << 256n).toString() }, { value: 0 }, { safe: 'false' }, { afterBlock: '-1' },
    { afterBlock: '89' }, { submittedAt: 0 }, { submittedAt: 1.5 }, { hash: HASH },
    { phase: 'pending' }, { phase: 'pending', hash: zeroHash }, { label: 'Send everything' }, { executionHash: HASH },
  ])('rejects malformed, complete-looking or foreign data %j', changes => {
    const record = begin()
    expect(() => readSaved(JSON.stringify({ ...record, ...changes }))).toThrow()
  })
  it.each(['null', '[]', '42', '{broken', ' '.repeat(32_769)])('rejects non-record JSON safely', raw => {
    expect(() => readSaved(raw)).toThrow()
  })
  it('rejects the wrong selector, truncated or trailing calldata, and mismatched first project argument', () => {
    const record = begin()
    const invalid = [
      encodeFunctionData({ abi: homerunDeployerAbi, functionName: 'incomeProjectIdOf', args: [9n] }),
      '0x12345678', record.data.slice(0, -2), `${record.data}00`,
      encodeFunctionData({ abi: homerunDeployerAbi, functionName: 'deployIncome', args: [10n, ...args.slice(1)] as unknown as typeof args }),
    ]
    for (const data of invalid) expect(() => readSaved(JSON.stringify({ ...record, data }))).toThrow()
  })
  it('validates the entire snapshot, INCOME description, reserved percent and start', () => {
    const record = begin()
    const invalidAllocation = (changes: Partial<typeof allocation>) => [9n, { ...snapshot, allocations: [{ ...allocation, ...changes }] }, ...args.slice(2)]
    const invalidArgs: unknown[][] = [
      invalidAllocation({ snapshotBlockNumber: 0n }),
      invalidAllocation({ snapshotBlockNumber: 101n }),
      invalidAllocation({ snapshotBlockHash: zeroHash }),
      invalidAllocation({ fundProjectId: 10n }),
      invalidAllocation({ chainId: 10 }),
      invalidAllocation({ incomeAmount: INITIAL_INCOME_SUPPLY - 1n }),
      [9n, { ...args[1], sourceSetHash: zeroHash }, ...args.slice(2)],
      [9n, { ...args[1], totalFundSupply: 0n }, ...args.slice(2)],
      [9n, { ...args[1], allocations: [] }, ...args.slice(2)],
      [9n, { ...args[1], manifestHash: zeroHash }, ...args.slice(2)],
      [9n, { ...args[1], manifestUri: 'https://mutable.example/manifest' }, ...args.slice(2)],
      [9n, args[1], { ...args[2], salt: zeroHash }, ...args.slice(3)],
      [9n, args[1], { ...args[2], name: ' ' }, ...args.slice(3)],
      [9n, args[1], { ...args[2], ticker: '' }, ...args.slice(3)],
      [9n, args[1], { ...args[2], uri: 'https://mutable.example/metadata' }, ...args.slice(3)],
      [9n, args[1], args[2], 10_001, ...args.slice(4)],
      [...args.slice(0, 4), 0, args[5]],
      [...args.slice(0, 5), { ...args[5], salt: BLOCK_HASH }],
    ]
    for (const [index, values] of invalidArgs.entries()) {
      const data = encodeFunctionData({ abi: homerunDeployerAbi, functionName: 'deployIncome', args: values as unknown as typeof args })
      expect(() => readSaved(JSON.stringify({ ...record, data })), `case ${index}`).toThrow()
    }
  })
  it('restores chain-specific attempts with a zero local allocation and retains the complete global commitment', () => {
    {
      const local = { ...allocation, incomeAmount: 0n }
      const remote = { ...allocation, chainId: 10, fundProjectId: 44n, snapshotBlockNumber: 500n }
      const linkedArgs = [9n, { ...snapshot, allocations: [local, remote] }, ...args.slice(2, 5), suckersFor(1, [1, 10])] as unknown as typeof args
      const linkedRequest = { ...request, args: linkedArgs }
      const saved = incomeLaunchRecord(linkedRequest, 9n, HOLDER, false, 100n)
      expect(readSaved(exportIncomeLaunchPending(saved))).toEqual(saved)
      expect(saved.data).toBe(encodeFunctionData({ abi: homerunDeployerAbi, functionName: 'deployIncome', args: linkedArgs }).toLowerCase())
    }
  })
  it('rejects inconsistent linked topology, duplicate chains and substituted bridge destinations', () => {
    const record = begin()
    const local = { ...allocation, incomeAmount: INITIAL_INCOME_SUPPLY / 2n }
    const remote = { ...local, chainId: 10, fundProjectId: 44n, snapshotBlockNumber: 500n }
    const configuration = suckersFor(1, [1, 10])
    const canonical = [9n, { ...snapshot, allocations: [local, remote] }, ...args.slice(2, 5), configuration]
    const alteredBridge = { ...configuration, deployerConfigurations: configuration.deployerConfigurations.map(entry => ({ ...entry, peer: HASH })) }
    const invalidArgs = [
      [9n, { ...snapshot, allocations: [remote, local] }, ...args.slice(2, 5), configuration],
      [9n, { ...snapshot, allocations: [local, local] }, ...args.slice(2, 5), configuration],
      [9n, { ...snapshot, allocations: [local, { ...remote, chainId: 137 }] }, ...args.slice(2, 5), configuration],
      [9n, { ...snapshot, allocations: [local, { ...remote, chainId: 11155111 }] }, ...args.slice(2, 5), configuration],
      [...canonical.slice(0, 5), args[5]],
      [...canonical.slice(0, 5), alteredBridge],
    ]
    for (const values of invalidArgs) {
      const data = encodeFunctionData({ abi: homerunDeployerAbi, functionName: 'deployIncome', args: values as unknown as typeof args })
      expect(() => readSaved(JSON.stringify({ ...record, data }))).toThrow()
    }
  })
  it('requires the current registered launcher both when starting and reading a saved launch', () => {
    const storage = memory(); begin(storage)
    registered.mockReturnValue(null)
    expect(() => readIncomeLaunchPending(storage, key)).toThrow(/currently registered/)
    expect(() => begin()).toThrow(/currently registered/)
    registered.mockReturnValue(OTHER)
    expect(() => readIncomeLaunchPending(storage, key)).toThrow(/currently registered/)
    expect(storage.getItem(key)).not.toBeNull()
  })
})

describe('exact INCOME EOA and Safe execution recovery', () => {
  it('verifies an unknown EOA attempt from the full payload and preserves pending state until explicitly resolved', async () => {
    const storage = memory(), record = begin(storage)
    await expect(verifyIncomeLaunchExecution(clientFor(record), record, EXECUTION_HASH)).resolves.toBe('confirmed')
    expect(readIncomeLaunchPending(storage, key)).toEqual(record)
  })
  it('keeps an unknown attempt held despite an exact reverted EOA execution', async () => {
    const record = begin()
    await expect(verifyIncomeLaunchExecution(clientFor(record, { failed: true }), record, EXECUTION_HASH)).rejects.toThrow(/historical failure/)
  })
  it('does not use another identical EOA transaction to resolve a known pending transaction', async () => {
    const storage = memory(), record = begin(storage, false, HASH)
    await expect(verifyIncomeLaunchExecution(clientFor(record), record, EXECUTION_HASH)).rejects.toThrow(/saved INCOME transaction hash/)
    expect(readIncomeLaunchPending(storage, key)).toEqual(record)
  })
  it.each([{ payload: '0x1234' as Hex }, { sender: OTHER }, { target: OTHER }, { value: 101n }, { chain: 10 }, { block: 100n }, { reorg: true }])('rejects unrelated or noncanonical EOA evidence %o', async options => {
    const record = begin()
    await expect(verifyIncomeLaunchExecution(clientFor(record, options), record, EXECUTION_HASH)).rejects.toThrow()
  })
  it('keeps the Safe proposal separate and accepts only the exact executed call and matching proposal event', async () => {
    const storage = memory(), record = begin(storage, true, HASH)
    await expect(verifyIncomeLaunchExecution(clientFor(record), record, EXECUTION_HASH)).resolves.toBe('confirmed')
    await expect(verifyIncomeLaunchExecution(clientFor(record, { safeFailure: true }), record, EXECUTION_HASH)).resolves.toBe('reverted')
    for (const options of [{ proposal: BLOCK_HASH }, { missingEvent: true }, { operation: 1 }, { payload: '0x1234' as Hex }, { value: 0n }]) {
      await expect(verifyIncomeLaunchExecution(clientFor(record, options), record, EXECUTION_HASH)).rejects.toThrow()
    }
    expect(readIncomeLaunchPending(storage, key)?.hash).toBe(HASH)
  })
  describe('Safe execution events', () => {
    const verify = (logs: ReturnType<typeof safeExecutionLog>[]) => {
      const storage = memory(), record = begin(storage, true, HASH)
      return verifyIncomeLaunchExecution(clientFor(record, { logs }), record, EXECUTION_HASH)
    }
    it('confirms a Safe 1.4.1 execution, whose txHash is indexed', async () => {
      await expect(verify([safeExecutionLog(HOLDER, HASH)])).resolves.toBe('confirmed')
    })
    it('reads a Safe 1.4.1 ExecutionFailure as reverted', async () => {
      await expect(verify([safeExecutionLog(HOLDER, HASH, { failed: true })])).resolves.toBe('reverted')
    })
    it('confirms a Safe 1.3 execution, whose txHash is in data', async () => {
      await expect(verify([safeExecutionLog(HOLDER, HASH, { version: '1.3' })])).resolves.toBe('confirmed')
    })
    it('keeps the launch pending when the Safe’s execution transaction reverted, since its proposal can still execute', async () => {
      const storage = memory(), record = begin(storage, true, HASH)
      await expect(verifyIncomeLaunchExecution(clientFor(record, { failed: true, logs: [] }), record, EXECUTION_HASH)).rejects.toThrow('before resolving its proposal')
    })
    it('ignores another Safe’s failure in the same receipt', async () => {
      await expect(verify([safeExecutionLog(OTHER, HASH, { failed: true }), safeExecutionLog(HOLDER, HASH)])).resolves.toBe('confirmed')
    })
  })
  it('never clears an unknown attempt after a network error', async () => {
    const storage = memory(), record = begin(storage)
    const client = clientFor(record); client.getTransactionReceipt = vi.fn().mockRejectedValue(new Error('RPC timeout'))
    await expect(verifyIncomeLaunchExecution(client, record, EXECUTION_HASH)).rejects.toThrow(/RPC timeout/)
    expect(readIncomeLaunchPending(storage, key)).toEqual(record)
  })
})

describe('a journal launch as its saved attempt', () => {
  const retirable = async () => true
  it('recovers the call under the FUND intent with the saved send time and the evidence it has', () => {
    const unknown = begin(), client = {} as never
    const attempt = incomeLaunchAttempt(client, 1, 9n, HOLDER, false, { pending: unknown }, undefined, retirable)
    expect(attempt).toMatchObject({ chainId: 1, account: HOLDER, safe: false, namespaces: [incomeLaunchIntent(9n)], call: { to: TARGET, data: unknown.data, value: 100n }, saved: { started: true, submittedAt: unknown.submittedAt } })
    expect(encodeFunctionData(incomeLaunchRequest(unknown))).toBe(unknown.data)
    expect(incomeLaunchAttempt(client, 1, 9n, HOLDER, false, { pending: begin(memory(), false, HASH) }, undefined, retirable).saved).toEqual({ started: true, submittedAt: expect.any(Number), hash: HASH })
    expect(incomeLaunchAttempt(client, 1, 9n, HOLDER, false, { pending: begin(memory(), true, HASH) }, undefined, retirable).saved).toEqual({ started: true, submittedAt: expect.any(Number), safeTxHash: HASH })
    // With nothing saved, the FUND's launch hold alone says whether anything was sent.
    expect(incomeLaunchAttempt(client, 1, 9n, HOLDER, false, { pending: null }, undefined, retirable)).toMatchObject({ namespaces: [incomeLaunchIntent(9n)], saved: { started: false } })
  })
})
