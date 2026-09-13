import { afterEach, describe, expect, it, vi } from 'vitest'
import { encodeAbiParameters, encodeEventTopics, encodeFunctionData, parseAbi, zeroAddress, zeroHash, type Hex, type PublicClient } from 'viem'
import type { TxRequest } from '../src/hooks/useSafeTx'
import {
  beginProjectAdminSubmission, confirmProjectAdminExecution, projectAdminSessionKey, readProjectAdminPending,
  recordProjectAdminHash, rejectProjectAdminSubmission, withProjectAdminLock, type ProjectAdminPending,
} from '../src/lib/project-admin-session'

const OWNER = '0x1111111111111111111111111111111111111111' as const
const TARGET = '0x2222222222222222222222222222222222222222' as const
const OTHER = '0x3333333333333333333333333333333333333333' as const
const BLOCK_HASH = `0x${'ab'.repeat(32)}` as Hex
const EXECUTION_HASH = `0x${'cd'.repeat(32)}` as Hex
const PROPOSAL_HASH = `0x${'ef'.repeat(32)}` as Hex
const OTHER_HASH = `0x${'12'.repeat(32)}` as Hex
const key = projectAdminSessionKey(8453, 7n)
const abi = parseAbi(['function setUriOf(uint256 projectId,string uri)'])
const safeAbi = parseAbi([
  'function execTransaction(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,bytes signatures) payable returns (bool success)',
  'event ExecutionSuccess(bytes32 txHash,uint256 payment)',
  'event ExecutionFailure(bytes32 txHash,uint256 payment)',
])

function memory() {
  const values = new Map<string, string>()
  return {
    getItem: (name: string) => values.get(name) ?? null,
    setItem: (name: string, raw: string) => { values.set(name, raw) },
    removeItem: (name: string) => { values.delete(name) },
  }
}

function request(): TxRequest {
  return { chainId: 8453, address: TARGET, abi, functionName: 'setUriOf', args: [7n, 'ipfs://updated'], value: 2n, label: 'Save project details' }
}

function pending(safe = false) {
  const storage = memory()
  const record = beginProjectAdminSubmission(storage, key, { request: request(), projectId: 7n, account: OWNER, safe, afterBlock: 100n })
  return { storage, record }
}

type ExecutionOptions = {
  wrongHash?: boolean; wrongReceiptHash?: boolean; wrongSender?: boolean; wrongTarget?: boolean; wrongPayload?: boolean;
  wrongValue?: boolean; old?: boolean; unmined?: boolean; receiptBlockMismatch?: boolean; reorg?: boolean;
  transactionBlockMismatch?: boolean; reverted?: boolean; wrongChain?: boolean; safeFailure?: boolean;
  delegateCall?: boolean; wrongSafe?: boolean; noEvent?: boolean; wrongEventEmitter?: boolean; proposalHash?: Hex;
}

function rpc(record: ProjectAdminPending, opts: ExecutionOptions = {}) {
  const target = opts.wrongTarget ? OTHER : record.target
  const data = opts.wrongPayload ? '0x12345678' : record.data
  const value = opts.wrongValue ? 3n : BigInt(record.value)
  const blockNumber = opts.old ? 100n : 101n
  const transaction = {
    hash: opts.wrongHash ? OTHER_HASH : EXECUTION_HASH,
    to: record.safe ? (opts.wrongSafe ? OTHER : OWNER) : target,
    from: opts.wrongSender ? OTHER : OWNER,
    input: record.safe ? encodeFunctionData({ abi: safeAbi, functionName: 'execTransaction', args: [target, value, data, opts.delegateCall ? 1 : 0, 0n, 0n, 0n, zeroAddress, zeroAddress, '0x'] }) : data,
    value: record.safe ? 0n : value,
    blockNumber: opts.unmined ? null : blockNumber,
    blockHash: opts.transactionBlockMismatch ? OTHER_HASH : BLOCK_HASH,
  }
  const eventName = opts.safeFailure ? 'ExecutionFailure' : 'ExecutionSuccess'
  const receipt = {
    transactionHash: opts.wrongReceiptHash ? OTHER_HASH : EXECUTION_HASH,
    status: opts.reverted ? 'reverted' : 'success',
    blockNumber: opts.receiptBlockMismatch ? 102n : blockNumber,
    blockHash: BLOCK_HASH,
    logs: record.safe && !opts.noEvent ? [{
      address: opts.wrongEventEmitter ? OTHER : OWNER,
      topics: encodeEventTopics({ abi: safeAbi, eventName }),
      data: encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint256' }], [opts.proposalHash ?? record.hash ?? PROPOSAL_HASH, 0n]),
    }] : [],
  }
  return {
    getChainId: vi.fn(async () => opts.wrongChain ? 1 : 8453),
    getTransaction: vi.fn(async () => transaction),
    getTransactionReceipt: vi.fn(async () => receipt),
    getBlock: vi.fn(async () => ({ hash: opts.reorg ? OTHER_HASH : BLOCK_HASH })),
  }
}

afterEach(() => vi.unstubAllGlobals())

describe('durable project administration submissions', () => {
  it('persists an unknown broadcast marker and restores only transaction facts after remount', () => {
    const { storage, record } = pending()
    const raw = storage.getItem(key)!
    expect(raw).not.toMatch(/"abi"|"request"|"functionName"|"args"/)
    expect(record.data).toBe(encodeFunctionData(request()))
    expect(readProjectAdminPending(storage, key)).toEqual(record)
    expect(record.hash).toBeUndefined()
    expect(() => beginProjectAdminSubmission(storage, key, { request: request(), projectId: 7n, account: OTHER, safe: false, afterBlock: 999n })).toThrow('already be pending')
    expect(readProjectAdminPending(storage, key)).toEqual(record)
  })

  it('rejects corrupt, noncanonical, executable, and malformed recovery records', () => {
    const { storage } = pending()
    const original = JSON.parse(storage.getItem(key)!) as Record<string, unknown>
    storage.setItem(key, '{broken')
    expect(() => readProjectAdminPending(storage, key)).toThrow('unreadable')
    for (const changed of [
      null, [], { ...original, version: 2 }, { ...original, id: 'not-a-uuid' },
      { ...original, abi }, { ...original, request: request().functionName },
      { ...original, chainId: '8453' }, { ...original, projectId: '07' },
      { ...original, holder: zeroAddress }, { ...original, target: 'not-an-address' },
      { ...original, data: '0x123' }, { ...original, data: '0x123456' },
      { ...original, value: '-1' }, { ...original, value: (1n << 256n).toString() },
      { ...original, afterBlock: '1.0' }, { ...original, safe: 'false' },
      { ...original, label: '' }, { ...original, label: 'Update\nproject' }, { ...original, label: 'x'.repeat(257) },
      { ...original, submittedAt: 0 }, { ...original, submittedAt: 1.5 },
      { ...original, hash: zeroHash }, { ...original, hash: '0x1234' },
    ]) {
      storage.setItem(key, JSON.stringify(changed))
      expect(() => readProjectAdminPending(storage, key)).toThrow('invalid')
    }
    storage.setItem(key, ' '.repeat(2 * 1024 * 1024 + 1))
    expect(() => readProjectAdminPending(storage, key)).toThrow('invalid')
  })

  it('rejects unsupported keys and recovery records from another project or chain', () => {
    const { storage } = pending()
    const original = storage.getItem(key)!
    for (const otherKey of [projectAdminSessionKey(1, 7n), projectAdminSessionKey(8453, 8n)]) {
      storage.setItem(otherKey, original)
      expect(() => readProjectAdminPending(storage, otherKey)).toThrow('invalid')
    }
    for (const otherKey of ['foreign-key', `${key}:extra`, key.replace(':7', ':07'), key.replace(':8453:', ':999999:')]) {
      expect(() => readProjectAdminPending(storage, otherKey)).toThrow('invalid')
    }
    expect(() => projectAdminSessionKey(8453, 0n)).toThrow('invalid')
    expect(() => projectAdminSessionKey(8453, 1n << 64n)).toThrow('invalid')
  })

  it('refuses stale tabs and changed record contents when recording or discarding a submission', () => {
    const { storage, record } = pending()
    const hashed = recordProjectAdminHash(storage, key, record, EXECUTION_HASH)
    expect(() => recordProjectAdminHash(storage, key, record, OTHER_HASH)).toThrow('another tab')
    expect(() => rejectProjectAdminSubmission(storage, key, record, 'wallet-rejected')).toThrow('another tab')
    expect(() => recordProjectAdminHash(storage, key, hashed, OTHER_HASH)).toThrow('different project update hash')
    expect(readProjectAdminPending(storage, key)).toEqual(hashed)
    storage.setItem(key, JSON.stringify({ ...hashed, data: '0x12345678' }))
    expect(() => recordProjectAdminHash(storage, key, hashed, EXECUTION_HASH)).toThrow('another tab')
  })

  it.each(['wallet-rejected', 'before-write-aborted'] as const)('clears an unknown marker only after %s', reason => {
    const { storage, record } = pending()
    expect(() => rejectProjectAdminSubmission(storage, key, record, 'timeout' as never)).toThrow('uncertain')
    expect(readProjectAdminPending(storage, key)).toEqual(record)
    rejectProjectAdminSubmission(storage, key, record, reason)
    expect(readProjectAdminPending(storage, key)).toBeNull()
  })

  it('never discards a submitted hash as a later wallet rejection', () => {
    const { storage, record } = pending()
    const hashed = recordProjectAdminHash(storage, key, record, EXECUTION_HASH)
    expect(() => rejectProjectAdminSubmission(storage, key, hashed, 'wallet-rejected')).toThrow('cannot be discarded')
    expect(() => recordProjectAdminHash(storage, key, hashed, zeroHash)).toThrow('valid transaction')
    expect(readProjectAdminPending(storage, key)).toEqual(hashed)
  })

  it('requires the stored direct transaction hash before querying execution', async () => {
    const { storage, record } = pending()
    const hashed = recordProjectAdminHash(storage, key, record, EXECUTION_HASH)
    const client = rpc(hashed)
    await expect(confirmProjectAdminExecution(client as unknown as PublicClient, storage, key, hashed, OTHER_HASH)).rejects.toThrow('saved project update transaction hash')
    expect(client.getTransactionReceipt).not.toHaveBeenCalled()
    expect(readProjectAdminPending(storage, key)).toEqual(hashed)
  })

  it.each<keyof ExecutionOptions>([
    'wrongHash', 'wrongReceiptHash', 'wrongSender', 'wrongTarget', 'wrongPayload', 'wrongValue', 'old',
    'unmined', 'receiptBlockMismatch', 'reorg', 'transactionBlockMismatch', 'wrongChain',
  ])('retains direct submissions when execution has %s', async option => {
    const { storage, record } = pending()
    await expect(confirmProjectAdminExecution(rpc(record, { [option]: true }) as unknown as PublicClient, storage, key, record, EXECUTION_HASH)).rejects.toThrow()
    expect(readProjectAdminPending(storage, key)).toEqual(record)
  })

  it.each([false, true])('releases a canonical matching direct execution with reverted=%s', async reverted => {
    const { storage, record } = pending()
    const result = await confirmProjectAdminExecution(rpc(record, { reverted }) as unknown as PublicClient, storage, key, record, EXECUTION_HASH)
    expect(result).toEqual({ status: reverted ? 'reverted' : 'confirmed', blockNumber: 101n })
    expect(readProjectAdminPending(storage, key)).toBeNull()
  })

  it.each(['getTransactionReceipt', 'getTransaction', 'getBlock'] as const)('keeps uncertain writes pending when %s is unavailable', async method => {
    const { storage, record } = pending()
    const client = rpc(record)
    client[method].mockRejectedValue(new Error('RPC unavailable'))
    await expect(confirmProjectAdminExecution(client as unknown as PublicClient, storage, key, record, EXECUTION_HASH)).rejects.toThrow('RPC unavailable')
    expect(readProjectAdminPending(storage, key)).toEqual(record)
  })

  it.each<keyof ExecutionOptions>(['wrongTarget', 'wrongPayload', 'wrongValue', 'delegateCall', 'wrongSafe', 'noEvent', 'wrongEventEmitter'])('retains Safe proposals when the execution has %s', async option => {
    const { storage, record } = pending(true)
    const hashed = recordProjectAdminHash(storage, key, record, PROPOSAL_HASH)
    await expect(confirmProjectAdminExecution(rpc(hashed, { [option]: true }) as unknown as PublicClient, storage, key, hashed, EXECUTION_HASH)).rejects.toThrow()
    expect(readProjectAdminPending(storage, key)).toEqual(hashed)
  })

  it('requires the exact Safe proposal event hash and accepts its canonical matching call', async () => {
    const { storage, record } = pending(true)
    const hashed = recordProjectAdminHash(storage, key, record, PROPOSAL_HASH)
    await expect(confirmProjectAdminExecution(rpc(hashed, { proposalHash: OTHER_HASH }) as unknown as PublicClient, storage, key, hashed, EXECUTION_HASH)).rejects.toThrow('saved proposal hash')
    expect(readProjectAdminPending(storage, key)).toEqual(hashed)
    await expect(confirmProjectAdminExecution(rpc(hashed) as unknown as PublicClient, storage, key, hashed, EXECUTION_HASH)).resolves.toEqual({ status: 'confirmed', blockNumber: 101n })
    expect(readProjectAdminPending(storage, key)).toBeNull()
  })

  it('resolves a canonical Safe inner failure but preserves a proposal after an outer revert', async () => {
    const { storage, record } = pending(true)
    const hashed = recordProjectAdminHash(storage, key, record, PROPOSAL_HASH)
    await expect(confirmProjectAdminExecution(rpc(hashed, { reverted: true }) as unknown as PublicClient, storage, key, hashed, EXECUTION_HASH)).rejects.toThrow('before resolving its proposal')
    expect(readProjectAdminPending(storage, key)).toEqual(hashed)
    await expect(confirmProjectAdminExecution(rpc(hashed, { safeFailure: true }) as unknown as PublicClient, storage, key, hashed, EXECUTION_HASH)).resolves.toEqual({ status: 'reverted', blockNumber: 101n })
    expect(readProjectAdminPending(storage, key)).toBeNull()
  })

  it('rechecks exact stored contents after asynchronous verification before clearing a record', async () => {
    const { storage, record } = pending()
    const client = rpc(record)
    client.getBlock.mockImplementation(async () => {
      storage.setItem(key, JSON.stringify({ ...record, id: '12345678-1234-4234-8234-123456789abc' }))
      return { hash: BLOCK_HASH }
    })
    await expect(confirmProjectAdminExecution(client as unknown as PublicClient, storage, key, record, EXECUTION_HASH)).rejects.toThrow('another tab')
    expect(readProjectAdminPending(storage, key)?.id).toBe('12345678-1234-4234-8234-123456789abc')
  })

  it('fails before signing if storage cannot persist a recovery marker', () => {
    const storage = { getItem: () => null, setItem: () => undefined, removeItem: () => undefined }
    expect(() => beginProjectAdminSubmission(storage, key, { request: request(), projectId: 7n, account: OWNER, safe: false, afterBlock: 100n })).toThrow('could not save')
  })

  it('holds the same exclusive project lock through asynchronous review and fails closed if unavailable', async () => {
    vi.stubGlobal('navigator', {})
    const task = vi.fn(async () => 'submitted')
    await expect(withProjectAdminLock(key, task)).rejects.toThrow('Web Locks')
    expect(task).not.toHaveBeenCalled()
    let locked = false
    const requestLock = vi.fn(async (_key: string, options: unknown, run: (lock: object | null) => unknown) => {
      expect(_key).toBe(key)
      expect(options).toEqual({ mode: 'exclusive', ifAvailable: true })
      if (locked) return run(null)
      locked = true
      try { return await run({}) } finally { locked = false }
    })
    vi.stubGlobal('navigator', { locks: { request: requestLock } })
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const first = withProjectAdminLock(key, async () => { await gate; return 'submitted' })
    await expect(withProjectAdminLock(key, task)).rejects.toThrow('another tab')
    expect(task).not.toHaveBeenCalled()
    release()
    await expect(first).resolves.toBe('submitted')
    await expect(withProjectAdminLock(key, task)).resolves.toBe('submitted')
  })
})
