import { afterEach, describe, expect, it, vi } from 'vitest'
import { v6Address } from '@bananapus/nana-sdk-core/v6'
import { encodeAbiParameters, encodeEventTopics, encodeFunctionData, parseAbi, zeroAddress, type Hex, type PublicClient } from 'viem'
import { newDemoShopItem } from '../src/lib/demo-shop'
import { initialFundRuleset } from '../src/lib/fund-contracts'
import { parseProjectShopWrite, projectShopWriteRequest, type PreparedProjectShopWrite } from '../src/lib/project-shop-write'
import {
  beginShopWriteSubmission, clearShopWriteSession, confirmShopWriteExecution, readShopWriteSession,
  recordShopWriteHash, rejectShopWriteSubmission, restoreShopWritePermissions, shopWriteRequestIndex, shopWriteRequestIndices, shopWriteSessionKey, startShopWriteSession,
  verifyShopWriteProgress, withShopWriteLock, type ShopWriteSession,
} from '../src/lib/project-shop-session'

const OWNER = '0x1111111111111111111111111111111111111111' as const
const OTHER = '0x2222222222222222222222222222222222222222' as const
const BLOCK_HASH = `0x${'ab'.repeat(32)}` as Hex
const executionHash = (step: number) => `0x${(step + 1).toString(16).padStart(64, '0')}` as Hex
const key = shopWriteSessionKey(8453, 7n)
const safeAbi = parseAbi([
  'function execTransaction(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,bytes signatures) payable returns (bool success)',
  'event ExecutionSuccess(bytes32 txHash,uint256 payment)',
  'event ExecutionFailure(bytes32 txHash,uint256 payment)',
])

function memory() {
  const values = new Map<string, string>()
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, raw: string) => { values.set(key, raw) }, removeItem: (key: string) => { values.delete(key) } }
}

function plan(): PreparedProjectShopWrite {
  const facts = {
    version: 1, snapshot: {
      chainId: 8453, projectId: 7n, account: OWNER, owner: OWNER, controller: v6Address('JBController', 8453),
      hookOwner: null, shop: null, blockNumber: 100n, mode: 'create', pricing: { currency: 2, decimals: 6 },
      currency: 'USD', symbol: 'USD', canAdd: true, canRemove: false, blockedReason: null, flags: null,
      maxTierId: 0n, rulesetId: 1, identity: 'reviewed project configuration',
      create: { configuration: initialFundRuleset(), projectUri: 'ipfs://project', deployerCanQueue: false, deployerPermissions: 1n << 255n, canManagePermissions: true },
    },
    pinned: [{ draft: { ...newDemoShopItem(), name: 'A weekend stay', price: '25', supply: '10' }, encodedIpfsUri: BLOCK_HASH }],
    removeTierIds: [], removalIdentity: '[]', salt: BLOCK_HASH,
  }
  const prepared = parseProjectShopWrite(JSON.stringify(facts, (_key, value) => typeof value === 'bigint' ? { $bigint: value.toString() } : value))
  if (!prepared) throw new Error('Invalid test plan')
  return prepared
}

type ExecutionOptions = { reverted?: boolean; wrongPayload?: boolean; wrongSender?: boolean; reorg?: boolean; old?: boolean; safeFailure?: boolean; noEvent?: boolean; delegateCall?: boolean; proposalHash?: Hex }
function rpc(session: ShopWriteSession, options: Record<number, ExecutionOptions> = {}) {
  const records = session.completed.map(entry => entry.submission)
  if (session.pending) records.push(session.pending)
  const transactions = records.map((saved, step) => {
    const request = projectShopWriteRequest(session.plan, shopWriteRequestIndices(session)[step])
    const opts = options[step] ?? {}
    const data = opts.wrongPayload ? '0x1234' : encodeFunctionData(request)
    const input = saved.safe ? encodeFunctionData({ abi: safeAbi, functionName: 'execTransaction', args: [request.address, 0n, data, opts.delegateCall ? 1 : 0, 0n, 0n, 0n, zeroAddress, zeroAddress, '0x'] }) : data
    return {
      hash: executionHash(step), to: saved.safe ? OWNER : request.address, from: opts.wrongSender ? OTHER : OWNER,
      input, value: 0n, blockNumber: opts.old ? BigInt(saved.afterBlock) : 101n + BigInt(step), blockHash: BLOCK_HASH,
    }
  })
  const receipts = transactions.map((transaction, step) => {
    const saved = records[step], opts = options[step] ?? {}
    const eventName = opts.safeFailure ? 'ExecutionFailure' : 'ExecutionSuccess'
    return {
      transactionHash: transaction.hash, blockNumber: transaction.blockNumber, blockHash: BLOCK_HASH,
      status: opts.reverted ? 'reverted' : 'success',
      logs: saved.safe && !opts.noEvent ? [{ address: OWNER, topics: encodeEventTopics({ abi: safeAbi, eventName }),
        data: encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint256' }], [opts.proposalHash ?? saved.hash ?? executionHash(step), 0n]) }] : [],
    }
  })
  const getTransaction = vi.fn(async ({ hash }: { hash: Hex }) => {
    const tx = transactions.find(tx => tx.hash === hash)
    if (!tx) throw new Error('Transaction not found')
    return tx
  })
  const getTransactionReceipt = vi.fn(async ({ hash }: { hash: Hex }) => {
    const receipt = receipts.find(receipt => receipt.transactionHash === hash)
    if (!receipt) throw new Error('Receipt not found')
    return receipt
  })
  const getBlock = vi.fn(async ({ blockNumber }: { blockNumber: bigint }) => ({ hash: options[Number(blockNumber - 101n)]?.reorg ? executionHash(9) : BLOCK_HASH }))
  return { getTransaction, getTransactionReceipt, getBlock, getChainId: vi.fn(async () => 8453) }
}

function pending(safe = false) {
  const storage = memory()
  const session = beginShopWriteSubmission(storage, key, startShopWriteSession(storage, key, plan()), { safe, afterBlock: 100n })
  return { storage, session }
}

afterEach(() => vi.unstubAllGlobals())

describe('durable live shop updates', () => {
  it('persists canonical plan facts without executable ABIs or requests and resumes after reload', () => {
    const { storage, session } = pending()
    const raw = storage.getItem(key)!
    expect(raw).not.toMatch(/"abi"|"requests"|"requestKinds"/)
    expect(readShopWriteSession(storage, key)).toEqual(session)
    expect(() => startShopWriteSession(storage, key, { ...plan(), snapshot: { ...plan().snapshot, account: OTHER } })).toThrow('already saved')
    expect(() => beginShopWriteSubmission(storage, key, session, { safe: false, afterBlock: 1000n })).toThrow('already be pending')
  })

  it('refuses corrupt, unknown-field, foreign-network, foreign-project and malformed submission data', () => {
    const { storage } = pending()
    const original = storage.getItem(key)!
    storage.setItem(key, '{broken')
    expect(() => readShopWriteSession(storage, key)).toThrow('unreadable')
    for (const mutate of [
      (saved: Record<string, unknown>) => ({ ...saved, version: 2 }),
      (saved: Record<string, unknown>) => ({ ...saved, target: OTHER }),
      (saved: Record<string, unknown>) => ({ ...saved, id: 'not-a-uuid' }),
      (saved: Record<string, unknown>) => ({ ...saved, pending: { safe: false, afterBlock: '99', startedAt: 1 } }),
      (saved: Record<string, unknown>) => ({ ...saved, pending: { safe: false, afterBlock: '100', startedAt: 1, hash: `0x${'0'.repeat(64)}` } }),
    ]) {
      storage.setItem(key, JSON.stringify(mutate(JSON.parse(original))))
      expect(() => readShopWriteSession(storage, key)).toThrow('invalid')
    }
    for (const otherKey of [shopWriteSessionKey(1, 7n), shopWriteSessionKey(8453, 8n)]) {
      storage.setItem(otherKey, original)
      expect(() => readShopWriteSession(storage, otherKey)).toThrow('another project')
    }
  })

  it('uses exact compare-and-set to prevent stale tabs from recording hashes or clearing newer progress', async () => {
    const { storage, session } = pending()
    const current = recordShopWriteHash(storage, key, session, executionHash(0))
    expect(() => recordShopWriteHash(storage, key, session, executionHash(1))).toThrow('another tab')
    expect(() => rejectShopWriteSubmission(storage, key, session, 'wallet-rejected')).toThrow('another tab')
    await expect(clearShopWriteSession(storage, key, session)).rejects.toThrow('another tab')
    expect(readShopWriteSession(storage, key)).toEqual(current)
    expect(() => recordShopWriteHash(storage, key, current, executionHash(1))).toThrow('different shop transaction')
  })

  it('retains unknown or hashed submissions on timeout and allows only an explicit pre-broadcast rejection', async () => {
    const { storage, session } = pending()
    const client = rpc(session)
    client.getTransactionReceipt.mockRejectedValue(new Error('RPC timeout'))
    await expect(confirmShopWriteExecution(client as unknown as PublicClient, storage, key, session, executionHash(0))).rejects.toThrow('RPC timeout')
    expect(readShopWriteSession(storage, key)).toEqual(session)
    expect(() => rejectShopWriteSubmission(storage, key, session, 'timeout' as never)).toThrow('uncertain')
    const rejected = rejectShopWriteSubmission(storage, key, session, 'wallet-rejected')
    expect(rejected.pending).toBeUndefined()
    const next = beginShopWriteSubmission(storage, key, rejected, { safe: false, afterBlock: 100n })
    const hashed = recordShopWriteHash(storage, key, next, executionHash(0))
    expect(() => rejectShopWriteSubmission(storage, key, hashed, 'wallet-rejected')).toThrow('cannot be discarded')
  })

  it('requires the saved EOA hash and the exact fresh, canonical transaction', async () => {
    const f = pending()
    const session = recordShopWriteHash(f.storage, key, f.session, executionHash(0))
    await expect(confirmShopWriteExecution(rpc(session) as unknown as PublicClient, f.storage, key, session, executionHash(1))).rejects.toThrow('saved shop transaction hash')
    for (const opts of [{ wrongSender: true }, { wrongPayload: true }, { old: true }, { reorg: true }]) {
      await expect(confirmShopWriteExecution(rpc(session, { 0: opts }) as unknown as PublicClient, f.storage, key, session, executionHash(0))).rejects.toThrow()
      expect(readShopWriteSession(f.storage, key)).toEqual(session)
    }
  })

  it('verifies all three creation steps after reload and retains permission restoration until it confirms', async () => {
    const { storage } = pending()
    let session = readShopWriteSession(storage, key)!
    expect(session.plan.requestKinds).toEqual(['grant', 'create', 'restore'])
    for (let step = 0; step < 3; step++) {
      if (step) session = beginShopWriteSubmission(storage, key, session, { safe: false, afterBlock: 100n + BigInt(step) })
      session = recordShopWriteHash(storage, key, session, executionHash(step))
      const client = rpc(session)
      const result = await confirmShopWriteExecution(client as unknown as PublicClient, storage, key, session, executionHash(step))
      expect(result.status).toBe('confirmed')
      session = readShopWriteSession(storage, key)!
      expect(session.completed).toHaveLength(step + 1)
      expect(session.pending).toBeUndefined()
      expect(await verifyShopWriteProgress(rpc(session) as unknown as PublicClient, session)).toBe(101n + BigInt(step))
      if (step < 2) await expect(clearShopWriteSession(storage, key, session)).rejects.toThrow('unfinished steps')
    }
    await expect(clearShopWriteSession(storage, key, session)).rejects.toThrow('Verify every completed')
    await clearShopWriteSession(storage, key, session, rpc(session) as unknown as PublicClient)
    expect(readShopWriteSession(storage, key)).toBeNull()
  })

  it('retains a confirmed grant when creation reverts, so cleanup cannot be forgotten', async () => {
    const f = pending()
    let session = (await confirmShopWriteExecution(rpc(f.session) as unknown as PublicClient, f.storage, key, f.session, executionHash(0))).session
    session = beginShopWriteSubmission(f.storage, key, session, { safe: false, afterBlock: 101n })
    const result = await confirmShopWriteExecution(rpc(session, { 1: { reverted: true } }) as unknown as PublicClient, f.storage, key, session, executionHash(1))
    expect(result.status).toBe('reverted')
    expect(result.session.pending).toBeUndefined()
    expect(result.session.completed).toHaveLength(1)
    expect(result.session.plan.requestKinds[result.session.completed.length]).toBe('create')
    await expect(clearShopWriteSession(f.storage, key, result.session)).rejects.toThrow('restoring deployer permissions')
  })

  it('does not trust restored completion flags or reorged prerequisite receipts', async () => {
    const f = pending()
    const completed = (await confirmShopWriteExecution(rpc(f.session) as unknown as PublicClient, f.storage, key, f.session, executionHash(0))).session
    for (const opts of [{ reverted: true }, { reorg: true }, { wrongPayload: true }, { wrongSender: true }]) {
      await expect(verifyShopWriteProgress(rpc(completed, { 0: opts }) as unknown as PublicClient, completed)).rejects.toThrow()
    }
    const unknown = rpc(completed)
    unknown.getTransactionReceipt.mockRejectedValue(new Error('Receipt not found'))
    await expect(verifyShopWriteProgress(unknown as unknown as PublicClient, completed)).rejects.toThrow()
    expect(await verifyShopWriteProgress(rpc(f.session) as unknown as PublicClient, { ...f.session, completed: [] })).toBe(0n)
  })

  it('requires a matching Safe call, operation, execution event and proposal hash', async () => {
    const f = pending(true)
    const proposal = executionHash(8)
    const session = recordShopWriteHash(f.storage, key, f.session, proposal)
    for (const opts of [{ wrongPayload: true }, { noEvent: true }, { delegateCall: true }, { proposalHash: executionHash(9) }]) {
      await expect(confirmShopWriteExecution(rpc(session, { 0: opts }) as unknown as PublicClient, f.storage, key, session, executionHash(0))).rejects.toThrow()
    }
    const result = await confirmShopWriteExecution(rpc(session) as unknown as PublicClient, f.storage, key, session, executionHash(0))
    expect(result.status).toBe('confirmed')
    expect(result.session.completed[0]).toMatchObject({ executionHash: executionHash(0), submission: { hash: proposal, safe: true } })
  })

  it('recognizes a Safe inner-call failure without treating a successful outer receipt as successful creation', async () => {
    const { storage, session } = pending(true)
    const result = await confirmShopWriteExecution(rpc(session, { 0: { safeFailure: true } }) as unknown as PublicClient, storage, key, session, executionHash(0))
    expect(result.status).toBe('reverted')
    expect(result.session.completed).toEqual([])
    await clearShopWriteSession(storage, key, result.session)
    expect(readShopWriteSession(storage, key)).toBeNull()
  })

  it('keeps a Safe proposal pending after an outer revert because that proposal can still execute', async () => {
    const { storage, session } = pending(true)
    await expect(confirmShopWriteExecution(rpc(session, { 0: { reverted: true } }) as unknown as PublicClient, storage, key, session, executionHash(0))).rejects.toThrow('before resolving its proposal')
    expect(readShopWriteSession(storage, key)).toEqual(session)
  })

  it('can abandon unsubmitted creation and restore the exact temporary grant, surviving reload until cleanup is proven', async () => {
    const { storage, session } = pending()
    const granted = (await confirmShopWriteExecution(rpc(session) as unknown as PublicClient, storage, key, session, executionHash(0))).session
    const restore = restoreShopWritePermissions(storage, key, granted)
    expect(readShopWriteSession(storage, key)).toEqual(restore)
    expect(shopWriteRequestIndices(restore)).toEqual([0, 2])
    expect(shopWriteRequestIndex(restore)).toBe(2)
    await expect(clearShopWriteSession(storage, key, restore)).rejects.toThrow('unfinished steps')
    const submitting = beginShopWriteSubmission(storage, key, restore, { safe: false, afterBlock: 101n })
    const resolved = (await confirmShopWriteExecution(rpc(submitting) as unknown as PublicClient, storage, key, submitting, executionHash(1))).session
    expect(resolved.completed).toHaveLength(2)
    expect(shopWriteRequestIndex(resolved)).toBeNull()
    await clearShopWriteSession(storage, key, resolved, rpc(resolved) as unknown as PublicClient)
    expect(readShopWriteSession(storage, key)).toBeNull()
  })

  it('refuses to skip an uncertain creation and never accepts its execution as permission restoration', async () => {
    const { storage, session } = pending()
    expect(() => restoreShopWritePermissions(storage, key, session)).toThrow('pending shop creation')
    const granted = (await confirmShopWriteExecution(rpc(session) as unknown as PublicClient, storage, key, session, executionHash(0))).session
    const creating = beginShopWriteSubmission(storage, key, granted, { safe: false, afterBlock: 101n })
    expect(() => restoreShopWritePermissions(storage, key, creating)).toThrow('pending shop creation')
    const rejected = rejectShopWriteSubmission(storage, key, creating, 'before-write-aborted')
    const restore = restoreShopWritePermissions(storage, key, rejected)
    const restoring = beginShopWriteSubmission(storage, key, restore, { safe: false, afterBlock: 101n })
    await expect(confirmShopWriteExecution(rpc(creating) as unknown as PublicClient, storage, key, restoring, executionHash(1))).rejects.toThrow('does not match')
    expect(readShopWriteSession(storage, key)).toEqual(restoring)
  })

  it('rechecks storage after receipt verification instead of overwriting another tab', async () => {
    const { storage, session } = pending()
    const client = rpc(session)
    const getReceipt = client.getTransactionReceipt.getMockImplementation()!
    client.getTransactionReceipt.mockImplementation(async args => {
      const receipt = await getReceipt(args)
      const saved = JSON.parse(storage.getItem(key)!)
      storage.setItem(key, JSON.stringify({ ...saved, id: '12345678-1234-4234-8234-123456789abc' }))
      return receipt
    })
    await expect(confirmShopWriteExecution(client as unknown as PublicClient, storage, key, session, executionHash(0))).rejects.toThrow('another tab')
    expect(readShopWriteSession(storage, key)?.completed).toEqual([])
  })

  it('fails before signing when browser storage cannot save the exact recovery marker', () => {
    const storage = { getItem: () => null, setItem: () => undefined, removeItem: () => undefined }
    expect(() => startShopWriteSession(storage, key, plan())).toThrow('could not save')
  })

  it('holds an exclusive project lock across asynchronous review and fails closed without cross-tab locks', async () => {
    vi.stubGlobal('navigator', {})
    const task = vi.fn(async () => 'submitted')
    await expect(withShopWriteLock(key, task)).rejects.toThrow('Web Locks')
    expect(task).not.toHaveBeenCalled()
    let locked = false
    vi.stubGlobal('navigator', { locks: { request: async (_key: string, _options: unknown, run: (lock: object | null) => unknown) => {
      if (locked) return run(null)
      locked = true
      try { return await run({}) } finally { locked = false }
    } } })
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const first = withShopWriteLock(key, async () => { await gate; return 'submitted' })
    await expect(withShopWriteLock(key, task)).rejects.toThrow('another tab')
    release()
    await expect(first).resolves.toBe('submitted')
    await expect(withShopWriteLock(key, task)).resolves.toBe('submitted')
  })
})
