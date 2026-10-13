import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Address, Hex } from 'viem'
import { createBrowserWriteRecovery } from '@bananapus/nana-sdk-core/review'
import { adoptLegacyProjectAdminRecord, noteProjectAdminAccount, otherProjectAdminHolds, projectAdminNamespace } from '@/lib/project-admin-reservation'
import { installRecoveryLocks, recoveryRecords } from './runtime/write-recovery-fixture'

const ALICE = '0x1111111111111111111111111111111111111111' as Address
const BOB = '0x3333333333333333333333333333333333333333' as Address
const TARGET = '0x2222222222222222222222222222222222222222' as Address
const HASH = `0x${'ab'.repeat(32)}` as Hex
const KEY = 'homerun:project-admin:pending:v1:8453:7'
const legacy = (extra: Record<string, unknown> = {}) => JSON.stringify({
  version: 1, id: '11111111-1111-4111-8111-111111111111', chainId: 8453, projectId: '7', holder: ALICE, target: TARGET,
  data: '0x12345678', value: '0', label: 'Save', safe: false, submittedAt: 1, afterBlock: '5', ...extra,
})
const client = () => ({
  getChainId: vi.fn(async () => 8453), getBlock: vi.fn(async () => ({ number: 100n, hash: HASH, timestamp: 1n })),
  getTransaction: vi.fn(async () => { throw new Error('unknown') }), getTransactionCount: vi.fn(async () => 5),
  getTransactionReceipt: vi.fn(async () => { throw new Error('unknown') }),
})

beforeEach(() => { localStorage.clear(); installRecoveryLocks() })

describe('an editor record from before the SDK journal', () => {
  it('moves into it with its exact call, account and returned hash, and the old key goes', async () => {
    localStorage.setItem(KEY, legacy({ hash: HASH }))
    await adoptLegacyProjectAdminRecord(localStorage, 8453, 7n)
    expect(localStorage.getItem(KEY)).toBeNull()
    expect(recoveryRecords()).toEqual([expect.objectContaining({
      chainId: 8453, account: ALICE, safe: false, namespace: projectAdminNamespace(7n), hash: HASH,
      call: { to: TARGET, data: '0x12345678', value: '0' },
    })])
    // Adopting again changes nothing.
    await adoptLegacyProjectAdminRecord(localStorage, 8453, 7n)
    expect(recoveryRecords()).toHaveLength(1)
  })

  it('keeps a write with no returned hash held, without inventing one', async () => {
    localStorage.setItem(KEY, legacy())
    await adoptLegacyProjectAdminRecord(localStorage, 8453, 7n)
    expect(recoveryRecords()[0].hash).toBeUndefined()
  })

  it('stays where it is, and refuses writes, when it cannot be read', async () => {
    localStorage.setItem(KEY, legacy({ holder: 'nope' }))
    await expect(adoptLegacyProjectAdminRecord(localStorage, 8453, 7n)).rejects.toThrow(/could not be read/)
    expect(localStorage.getItem(KEY)).not.toBeNull()
    expect(recoveryRecords()).toHaveLength(0)
  })
})

describe('the project reservation across accounts', () => {
  async function hold(account: Address) {
    const journal = createBrowserWriteRecovery({ chainId: 8453, account, safe: false, namespace: projectAdminNamespace(7n), call: { to: TARGET, data: '0x12345678', value: 0n } })
    await journal.withLock(async () => { journal.reserve() })
    noteProjectAdminAccount(localStorage, 8453, 7n, account)
  }

  it('holds a second authorized account while the first account’s update is unresolved', async () => {
    await hold(ALICE)
    const holds = await otherProjectAdminHolds(localStorage, client() as never, 8453, 7n, BOB)
    expect(holds).toHaveLength(1)
    expect(holds[0].record.account).toBe(ALICE)
  })

  it('does not hold the account that made it, which its own journal answers for', async () => {
    await hold(ALICE)
    expect(await otherProjectAdminHolds(localStorage, client() as never, 8453, 7n, ALICE)).toHaveLength(0)
  })

  it('lets the exit release it, and forgets accounts with nothing held', async () => {
    await hold(ALICE)
    const [held] = await otherProjectAdminHolds(localStorage, client() as never, 8453, 7n, BOB)
    held.journal.abandon(held.record, { checkedWallet: true })
    expect(await otherProjectAdminHolds(localStorage, client() as never, 8453, 7n, BOB)).toHaveLength(0)
    expect(localStorage.getItem('homerun:project-admin:accounts:v1:8453:7')).toBeNull()
  })

  it('is per project', async () => {
    await hold(ALICE)
    expect(await otherProjectAdminHolds(localStorage, client() as never, 8453, 8n, BOB)).toHaveLength(0)
  })
})
