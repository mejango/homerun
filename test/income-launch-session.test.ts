import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MappableAsset, parseSuckerDeployerConfig, type JBChainId } from '@bananapus/nana-sdk-core'
import { encodeAbiParameters, encodeEventTopics, encodeFunctionData, parseAbi, zeroAddress, zeroHash, type Hex, type PublicClient } from 'viem'
import { legacyHomerunIncomeDeployerAbi as homerunIncomeDeployerAbi, homerunIncomeDeployerAbi as currentIncomeDeployerAbi, INITIAL_INCOME_SUPPLY } from '../src/lib/income-contracts'
import type { FundTransaction } from '../src/lib/fund-contracts'
import {
  beginIncomeLaunchSubmission, clearIncomeLaunchPending, exportIncomeLaunchPending, importIncomeLaunchPending,
  incomeLaunchSessionKey, readIncomeLaunchPending, recordIncomeLaunchHash, verifyIncomeLaunchExecution,
  withIncomeLaunchLock, type IncomeLaunchPending, type IncomeLaunchStorage,
} from '../src/lib/income-launch-session'

const { registered } = vi.hoisted(() => ({ registered: vi.fn() }))
vi.mock('../src/lib/income-contracts', async importOriginal => ({ ...await importOriginal<typeof import('../src/lib/income-contracts')>(), registeredIncomeDeployer: registered }))
const HOLDER = '0x1111111111111111111111111111111111111111'
const TARGET = '0x2222222222222222222222222222222222222222'
const OTHER = '0x3333333333333333333333333333333333333333'
const HASH = `0x${'ab'.repeat(32)}` as Hex
const EXECUTION_HASH = `0x${'ef'.repeat(32)}` as Hex
const BLOCK_HASH = `0x${'cd'.repeat(32)}` as Hex
const key = incomeLaunchSessionKey(1, 9n)
const allocation = { chainId: 1, fundProjectId: 9n, snapshotBlockNumber: 90n, snapshotBlockHash: BLOCK_HASH, merkleRoot: HASH, leafCount: 500n, incomeAmount: INITIAL_INCOME_SUPPLY }
const snapshot = { sourceSetHash: HASH, totalFundSupply: 1_000_000n, manifestHash: HASH, manifestUri: 'ipfs://manifest', allocations: [allocation] }
const suckersFor = (chainId: JBChainId, chains: JBChainId[]) => parseSuckerDeployerConfig(chainId, chains, [MappableAsset.USDC], { version: 6, bridge: 'ccip', salt: HASH })
const args = [9n, snapshot, { name: 'Founder Haus INCOME', ticker: 'INCOME', uri: 'ipfs://metadata', salt: HASH }, 7_000, 1_000, 10n, 1_800_000_000, suckersFor(1, [1])] as const
const request: FundTransaction = { chainId: 1, address: TARGET, abi: homerunIncomeDeployerAbi, functionName: 'deployIncome', args, value: 100n }
const safeAbi = parseAbi([
  'function execTransaction(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,bytes signatures) payable returns (bool success)',
  'event ExecutionSuccess(bytes32 txHash,uint256 payment)', 'event ExecutionFailure(bytes32 txHash,uint256 payment)',
])
function memory(): IncomeLaunchStorage {
  const items = new Map<string, string>()
  return { getItem: key => items.get(key) ?? null, setItem: (key, value) => { items.set(key, value) }, removeItem: key => { items.delete(key) } }
}
function begin(storage = memory(), safe = false) { return beginIncomeLaunchSubmission(storage, key, request, 9n, HOLDER, safe, 100n) }
function clientFor(record: IncomeLaunchPending, options: { payload?: Hex; sender?: typeof OTHER; target?: typeof OTHER; value?: bigint; chain?: number; block?: bigint; reorg?: boolean; failed?: boolean; safeFailure?: boolean; missingEvent?: boolean; proposal?: Hex; operation?: number } = {}) {
  const input = record.safe
    ? encodeFunctionData({ abi: safeAbi, functionName: 'execTransaction', args: [options.target ?? TARGET, options.value ?? 100n, options.payload ?? record.data, options.operation ?? 0, 0n, 0n, 0n, zeroAddress, zeroAddress, '0x'] })
    : options.payload ?? record.data
  const transaction = { hash: EXECUTION_HASH, to: record.safe ? HOLDER : options.target ?? TARGET, from: options.sender ?? HOLDER, input, value: record.safe ? 0n : options.value ?? 100n, blockNumber: options.block ?? 101n, blockHash: BLOCK_HASH }
  const logs = record.safe && !options.missingEvent ? [{ address: HOLDER, topics: encodeEventTopics({ abi: safeAbi, eventName: options.safeFailure ? 'ExecutionFailure' : 'ExecutionSuccess' }), data: encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint256' }], [options.proposal ?? record.hash ?? HASH, 0n]) }] : []
  const receipt = { transactionHash: EXECUTION_HASH, status: options.failed ? 'reverted' : 'success', blockNumber: transaction.blockNumber, blockHash: BLOCK_HASH, logs }
  return { getChainId: async () => options.chain ?? 1, getTransaction: async () => transaction, getTransactionReceipt: async () => receipt, getBlock: async () => ({ hash: options.reorg ? HASH : BLOCK_HASH }) } as unknown as PublicClient
}
beforeEach(() => { registered.mockReturnValue(TARGET) })
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); Reflect.deleteProperty(navigator, 'locks') })

describe('INCOME launch journal identity and persistence', () => {
  it('saves an unknown submission before a hash exists and blocks duplicates after remount or owner change', () => {
    const storage = memory(), record = begin(storage)
    expect(record.phase).toBe('unknown')
    expect(record.hash).toBeUndefined()
    expect(readIncomeLaunchPending(storage, key)).toEqual(record)
    expect(() => beginIncomeLaunchSubmission(storage, key, request, 9n, OTHER, false, 100n)).toThrow(/already be pending/)
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
  it('uses a unique submission ID even if two resolved attempts begin in the same millisecond', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000)
    const storage = memory(), first = begin(storage)
    clearIncomeLaunchPending(storage, key, first)
    const second = begin(storage)
    expect(second.sessionId).not.toBe(first.sessionId)
    expect(() => clearIncomeLaunchPending(storage, key, first)).toThrow(/changed in another tab/)
    expect(readIncomeLaunchPending(storage, key)).toEqual(second)
  })
  it('fails closed if storage refuses or mutates the write', () => {
    const silent = memory(); silent.setItem = () => {}
    expect(() => begin(silent)).toThrow(/could not save/)
    const wrong = memory(), original = wrong.setItem
    wrong.setItem = (key, value) => original(key, value.replace('unknown', 'confirmed'))
    expect(() => begin(wrong)).toThrow(/could not save/)
  })
  it('fails closed if secure session IDs are unavailable', () => {
    vi.stubGlobal('crypto', {})
    expect(() => begin()).toThrow(/Secure browser/)
  })
  it('records a hash only for the exact current attempt and cannot replace an existing hash', () => {
    const storage = memory(), first = begin(storage)
    const pending = recordIncomeLaunchHash(storage, key, first, HASH)
    expect(readIncomeLaunchPending(storage, key)).toEqual(pending)
    expect(pending.phase).toBe('pending')
    expect(() => recordIncomeLaunchHash(storage, key, first, HASH)).toThrow(/changed in another tab/)
    expect(() => recordIncomeLaunchHash(storage, key, pending, EXECUTION_HASH)).toThrow(/different INCOME transaction/)
    expect(recordIncomeLaunchHash(storage, key, pending, HASH)).toEqual(pending)
    expect(() => clearIncomeLaunchPending(storage, key, first)).toThrow(/changed in another tab/)
    clearIncomeLaunchPending(storage, key, pending)
    expect(readIncomeLaunchPending(storage, key)).toBeNull()
  })
  it('does not overwrite another tab’s newer record while recording a hash', () => {
    const storage = memory(), record = begin(storage)
    storage.setItem(key, JSON.stringify({ ...record, sessionId: crypto.randomUUID() }))
    expect(() => recordIncomeLaunchHash(storage, key, record, HASH)).toThrow(/changed in another tab/)
    expect(readIncomeLaunchPending(storage, key)?.hash).toBeUndefined()
  })
  it('verifies hash writes and record removal', () => {
    const storage = memory(), record = begin(storage)
    storage.setItem = () => {}
    expect(() => recordIncomeLaunchHash(storage, key, record, HASH)).toThrow(/could not save/)
    storage.removeItem = () => {}
    expect(() => clearIncomeLaunchPending(storage, key, record)).toThrow(/could not clear/)
  })
})

describe('strict INCOME launch recovery imports', () => {
  it('preserves distinct incentive recipients while the saved signer remains the FUND owner', () => {
    const storage = memory()
    const currentRequest = { ...request, abi: currentIncomeDeployerAbi, args: [...args, OTHER] }
    const record = beginIncomeLaunchSubmission(storage, key, currentRequest, 9n, HOLDER, false, 100n)
    expect(record.holder).toBe(HOLDER)
    expect(record.data).toBe(encodeFunctionData({ abi: currentIncomeDeployerAbi, functionName: 'deployIncome', args: [...args, OTHER] }).toLowerCase())
    expect(importIncomeLaunchPending(memory(), key, exportIncomeLaunchPending(record))).toEqual(record)
    const invalidData = encodeFunctionData({ abi: currentIncomeDeployerAbi, functionName: 'deployIncome', args: [...args, zeroAddress] })
    expect(() => importIncomeLaunchPending(memory(), key, JSON.stringify({ ...record, data: invalidData }))).toThrow()
  })
  it('round-trips unknown and pending records without asserting execution', () => {
    const storage = memory(), unknown = begin(storage), restored = memory()
    expect(importIncomeLaunchPending(restored, key, exportIncomeLaunchPending(unknown))).toEqual(unknown)
    expect(() => begin(restored)).toThrow(/already be pending/)
    const pending = recordIncomeLaunchHash(storage, key, unknown, HASH)
    const target = memory()
    expect(importIncomeLaunchPending(target, key, exportIncomeLaunchPending(pending))).toEqual(pending)
    expect(importIncomeLaunchPending(target, key, exportIncomeLaunchPending(pending))).toEqual(pending)
    expect(() => importIncomeLaunchPending(target, key, exportIncomeLaunchPending(unknown))).toThrow(/already saved/)
  })
  it('does not overwrite corrupt existing recovery state with a different import', () => {
    const record = begin(), storage = memory(); storage.setItem(key, '{broken')
    expect(() => importIncomeLaunchPending(storage, key, exportIncomeLaunchPending(record))).toThrow(/unreadable/)
    expect(storage.getItem(key)).toBe('{broken')
  })
  it.each([
    { version: 2 }, { kind: 'sticky' }, { sessionId: 'not-unique' }, { phase: 'confirmed' }, { phase: 'reverted' },
    { chainId: 10 }, { projectId: '10' }, { projectId: '09' }, { projectId: (1n << 256n).toString() },
    { holder: zeroAddress }, { holder: '0x1234' }, { target: OTHER }, { value: '-1' }, { value: '01' },
    { value: (1n << 256n).toString() }, { value: 0 }, { safe: 'false' }, { afterBlock: '-1' },
    { afterBlock: '89' }, { submittedAt: 0 }, { submittedAt: 1.5 }, { hash: HASH },
    { phase: 'pending' }, { phase: 'pending', hash: zeroHash }, { label: 'Send everything' }, { executionHash: HASH },
  ])('rejects malformed, complete-looking or foreign data %j', changes => {
    const storage = memory(), record = begin()
    expect(() => importIncomeLaunchPending(storage, key, JSON.stringify({ ...record, ...changes }))).toThrow()
    expect(storage.getItem(key)).toBeNull()
  })
  it.each(['null', '[]', '42', '{broken', ' '.repeat(32_769)])('rejects non-record JSON safely', raw => {
    expect(() => importIncomeLaunchPending(memory(), key, raw)).toThrow()
  })
  it('rejects the wrong selector, truncated or trailing calldata, and mismatched first project argument', () => {
    const record = begin()
    const invalid = [
      encodeFunctionData({ abi: homerunIncomeDeployerAbi, functionName: 'incomeProjectIdOf', args: [9n] }),
      '0x12345678', record.data.slice(0, -2), `${record.data}00`,
      encodeFunctionData({ abi: homerunIncomeDeployerAbi, functionName: 'deployIncome', args: [10n, ...args.slice(1)] as unknown as typeof args }),
    ]
    for (const data of invalid) expect(() => importIncomeLaunchPending(memory(), key, JSON.stringify({ ...record, data }))).toThrow()
  })
  it('validates the entire snapshot, INCOME description, allocation and Sticky destination', () => {
    const record = begin()
    const invalidAllocation = (changes: Partial<typeof allocation>) => [9n, { ...snapshot, allocations: [{ ...allocation, ...changes }] }, ...args.slice(2)]
    const invalidArgs: unknown[][] = [
      invalidAllocation({ snapshotBlockNumber: 0n }),
      invalidAllocation({ snapshotBlockNumber: 101n }),
      invalidAllocation({ snapshotBlockHash: zeroHash }),
      invalidAllocation({ fundProjectId: 10n }),
      invalidAllocation({ chainId: 10 }),
      invalidAllocation({ leafCount: 0n }),
      invalidAllocation({ leafCount: (1n << 160n) + 1n }),
      invalidAllocation({ merkleRoot: zeroHash }),
      invalidAllocation({ incomeAmount: INITIAL_INCOME_SUPPLY - 1n }),
      [9n, { ...args[1], sourceSetHash: zeroHash }, ...args.slice(2)],
      [9n, { ...args[1], totalFundSupply: 0n }, ...args.slice(2)],
      [9n, { ...args[1], allocations: [] }, ...args.slice(2)],
      [9n, { ...args[1], manifestHash: zeroHash }, ...args.slice(2)],
      [9n, { ...args[1], manifestUri: 'https://mutable.example/manifest' }, ...args.slice(2)],
      [9n, args[1], { ...args[2], salt: zeroHash }, ...args.slice(3)],
      [9n, args[1], { ...args[2], name: ' ' }, ...args.slice(3)],
      [9n, args[1], { ...args[2], ticker: 'FUND' }, ...args.slice(3)],
      [9n, args[1], { ...args[2], uri: 'https://mutable.example/metadata' }, ...args.slice(3)],
      [9n, args[1], args[2], 10_000, 1_000, 10n, ...args.slice(6)],
      [9n, args[1], args[2], 7_000, 0, 10n, ...args.slice(6)],
      [9n, args[1], args[2], 7_000, 1_000, 0n, ...args.slice(6)],
      [9n, args[1], args[2], 7_000, 1_000, 9n, ...args.slice(6)],
      [...args.slice(0, 6), 0, args[7]],
      [...args.slice(0, 6), 2 ** 48 - 1, args[7]],
      [...args.slice(0, 7), { ...args[7], salt: BLOCK_HASH }],
    ]
    for (const values of invalidArgs) {
      const data = encodeFunctionData({ abi: homerunIncomeDeployerAbi, functionName: 'deployIncome', args: values as unknown as typeof args })
      expect(() => importIncomeLaunchPending(memory(), key, JSON.stringify({ ...record, data }))).toThrow()
    }
  })
  it('restores chain-specific attempts with zero or dust local allocations and retains the complete global commitment', () => {
    for (const leaves of [0n, 1n]) {
      const local = { ...allocation, incomeAmount: 0n, leafCount: leaves, merkleRoot: leaves === 0n ? zeroHash : HASH }
      const remote = { ...allocation, chainId: 10, fundProjectId: 44n, snapshotBlockNumber: 500n }
      const linkedArgs = [9n, { ...snapshot, allocations: [local, remote] }, ...args.slice(2, 7), suckersFor(1, [1, 10])] as unknown as typeof args
      const linkedRequest = { ...request, args: linkedArgs }
      const storage = memory()
      const saved = beginIncomeLaunchSubmission(storage, key, linkedRequest, 9n, HOLDER, false, 100n)
      expect(importIncomeLaunchPending(memory(), key, exportIncomeLaunchPending(saved))).toEqual(saved)
      expect(saved.data).toBe(encodeFunctionData({ abi: homerunIncomeDeployerAbi, functionName: 'deployIncome', args: linkedArgs }).toLowerCase())
    }
  })
  it('rejects inconsistent linked topology, duplicate chains and substituted bridge destinations', () => {
    const record = begin()
    const local = { ...allocation, incomeAmount: INITIAL_INCOME_SUPPLY / 2n }
    const remote = { ...local, chainId: 10, fundProjectId: 44n, snapshotBlockNumber: 500n }
    const configuration = suckersFor(1, [1, 10])
    const canonical = [9n, { ...snapshot, allocations: [local, remote] }, ...args.slice(2, 7), configuration]
    const alteredBridge = { ...configuration, deployerConfigurations: configuration.deployerConfigurations.map(entry => ({ ...entry, peer: HASH })) }
    const invalidArgs = [
      [9n, { ...snapshot, allocations: [remote, local] }, ...args.slice(2, 7), configuration],
      [9n, { ...snapshot, allocations: [local, local] }, ...args.slice(2, 7), configuration],
      [9n, { ...snapshot, allocations: [local, { ...remote, chainId: 137 }] }, ...args.slice(2, 7), configuration],
      [9n, { ...snapshot, allocations: [local, { ...remote, chainId: 11155111 }] }, ...args.slice(2, 7), configuration],
      [...canonical.slice(0, 7), args[7]],
      [...canonical.slice(0, 7), alteredBridge],
    ]
    for (const values of invalidArgs) {
      const data = encodeFunctionData({ abi: homerunIncomeDeployerAbi, functionName: 'deployIncome', args: values as unknown as typeof args })
      expect(() => importIncomeLaunchPending(memory(), key, JSON.stringify({ ...record, data }))).toThrow()
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
    clearIncomeLaunchPending(storage, key, record)
    expect(readIncomeLaunchPending(storage, key)).toBeNull()
  })
  it('verifies an exact reverted EOA execution', async () => {
    const record = begin()
    await expect(verifyIncomeLaunchExecution(clientFor(record, { failed: true }), record, EXECUTION_HASH)).resolves.toBe('reverted')
  })
  it('does not use another identical EOA transaction to resolve a known pending transaction', async () => {
    const storage = memory(), record = recordIncomeLaunchHash(storage, key, begin(storage), HASH)
    await expect(verifyIncomeLaunchExecution(clientFor(record), record, EXECUTION_HASH)).rejects.toThrow(/saved INCOME transaction hash/)
    expect(readIncomeLaunchPending(storage, key)).toEqual(record)
  })
  it.each([{ payload: '0x1234' as Hex }, { sender: OTHER }, { target: OTHER }, { value: 101n }, { chain: 10 }, { block: 100n }, { reorg: true }])('rejects unrelated or noncanonical EOA evidence %o', async options => {
    const record = begin()
    await expect(verifyIncomeLaunchExecution(clientFor(record, options), record, EXECUTION_HASH)).rejects.toThrow()
  })
  it('keeps the Safe proposal separate and accepts only the exact executed call and matching proposal event', async () => {
    const storage = memory(), record = recordIncomeLaunchHash(storage, key, begin(storage, true), HASH)
    await expect(verifyIncomeLaunchExecution(clientFor(record), record, EXECUTION_HASH)).resolves.toBe('confirmed')
    await expect(verifyIncomeLaunchExecution(clientFor(record, { safeFailure: true }), record, EXECUTION_HASH)).resolves.toBe('reverted')
    for (const options of [{ proposal: BLOCK_HASH }, { missingEvent: true }, { operation: 1 }, { payload: '0x1234' as Hex }, { value: 0n }]) {
      await expect(verifyIncomeLaunchExecution(clientFor(record, options), record, EXECUTION_HASH)).rejects.toThrow()
    }
    expect(readIncomeLaunchPending(storage, key)?.hash).toBe(HASH)
  })
  it('never clears an unknown attempt after a network error', async () => {
    const storage = memory(), record = begin(storage)
    const client = clientFor(record); client.getTransactionReceipt = vi.fn().mockRejectedValue(new Error('RPC timeout'))
    await expect(verifyIncomeLaunchExecution(client, record, EXECUTION_HASH)).rejects.toThrow(/RPC timeout/)
    expect(readIncomeLaunchPending(storage, key)).toEqual(record)
    expect(() => begin(storage)).toThrow(/already be pending/)
  })
})

describe('INCOME cross-tab review and submission lock', () => {
  function installLocks() {
    const active = new Set<string>()
    const request = vi.fn(async (name: string, _options: unknown, callback: (lock: object | null) => Promise<unknown>) => {
      if (active.has(name)) return callback(null)
      active.add(name)
      try { return await callback({ name }) } finally { active.delete(name) }
    })
    Object.defineProperty(navigator, 'locks', { value: { request }, configurable: true })
    return request
  }
  it('fails closed when Web Locks are unavailable', async () => {
    const task = vi.fn()
    await expect(withIncomeLaunchLock(key, task)).rejects.toThrow(/Web Locks/)
    expect(task).not.toHaveBeenCalled()
  })
  it('holds the same project lock through review and wallet write while allowing other project reviews', async () => {
    const lockRequest = installLocks()
    let finish!: () => void
    const review = new Promise<void>(resolve => { finish = resolve })
    const running = withIncomeLaunchLock(key, async () => { await review; return 'submitted' })
    const duplicate = vi.fn()
    await expect(withIncomeLaunchLock(key, duplicate)).rejects.toThrow(/another tab/)
    expect(duplicate).not.toHaveBeenCalled()
    await expect(withIncomeLaunchLock(incomeLaunchSessionKey(1, 10n), async () => 'other')).resolves.toBe('other')
    finish()
    await expect(running).resolves.toBe('submitted')
    expect(lockRequest).toHaveBeenCalledWith(key, { mode: 'exclusive', ifAvailable: true }, expect.any(Function))
    await expect(withIncomeLaunchLock(key, async () => 'reopened')).resolves.toBe('reopened')
  })
  it('releases a failed review lock but retains an unknown submitted attempt', async () => {
    installLocks()
    const storage = memory()
    await expect(withIncomeLaunchLock(key, async () => { begin(storage); throw new Error('Wallet disconnected') })).rejects.toThrow(/Wallet disconnected/)
    await expect(withIncomeLaunchLock(key, async () => begin(storage))).rejects.toThrow(/already be pending/)
    expect(readIncomeLaunchPending(storage, key)?.phase).toBe('unknown')
  })
})
