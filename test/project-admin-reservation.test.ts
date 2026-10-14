import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { Address, Hex } from 'viem'
import { createBrowserWriteRecovery } from '@bananapus/nana-sdk-core/review'
import { adoptLegacyProjectAdminRecord, noteProjectAdminAccount, otherProjectAdminHolds, projectAdminNamespace, pruneProjectAdminAccounts } from '@/lib/project-admin-reservation'
import { heldStorage } from '@/lib/write-hold'
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
  getTransactionReceipt: vi.fn(async () => { throw new Error('unknown') }), getBlockNumber: vi.fn(async () => 100n),
  request: vi.fn(async () => { throw new Error('unknown') }),
})

beforeEach(() => {
  localStorage.clear(); installRecoveryLocks()
})

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

  it('merges its hash into a matching reservation that has none, and keeps the old key until that saved', async () => {
    const input = { chainId: 8453, account: ALICE, safe: false, namespace: projectAdminNamespace(7n), call: { to: TARGET, data: '0x12345678' as Hex, value: 0n } }
    const journal = createBrowserWriteRecovery(input)
    await journal.withLock(async () => { journal.reserve() })
    localStorage.setItem(KEY, legacy({ hash: HASH }))
    await adoptLegacyProjectAdminRecord(localStorage, 8453, 7n)
    expect(recoveryRecords()).toEqual([expect.objectContaining({ hash: HASH })])
    expect(localStorage.getItem(KEY)).toBeNull()
  })

  it('keeps the old key when the merged hash cannot be saved, and when two hashes disagree', async () => {
    const input = { chainId: 8453, account: ALICE, safe: false, namespace: projectAdminNamespace(7n), call: { to: TARGET, data: '0x12345678' as Hex, value: 0n } }
    const journal = createBrowserWriteRecovery(input)
    await journal.withLock(async () => { journal.reserve() })
    localStorage.setItem(KEY, legacy({ hash: HASH }))
    const original = Storage.prototype.setItem
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
      if (key.startsWith('nana-sdk:') && value.includes(HASH)) throw new Error('Storage unavailable')
      original.call(this, key, value)
    })
    await expect(adoptLegacyProjectAdminRecord(localStorage, 8453, 7n)).rejects.toThrow()
    spy.mockRestore()
    expect(localStorage.getItem(KEY)).not.toBeNull()
    expect(recoveryRecords()[0].hash).toBeUndefined()
  })

  it('keeps the old key when its hash and the reservation’s disagree', async () => {
    const input = { chainId: 8453, account: ALICE, safe: false, namespace: projectAdminNamespace(8n), call: { to: TARGET, data: '0x12345678' as Hex, value: 0n } }
    const journal = createBrowserWriteRecovery(input)
    await journal.withLock(async () => { journal.reserve(); journal.submitted(`0x${'cd'.repeat(32)}` as Hex) })
    localStorage.setItem('homerun:project-admin:pending:v1:8453:8', legacy({ projectId: '8', hash: HASH }))
    await expect(adoptLegacyProjectAdminRecord(localStorage, 8453, 8n)).rejects.toThrow(/unresolved/)
    expect(localStorage.getItem('homerun:project-admin:pending:v1:8453:8')).not.toBeNull()
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
    expect(holds[0].state.record.account).toBe(ALICE)
    expect(holds[0].state).toMatchObject({ status: 'held-no-hash', exit: true })
  })

  it('never offers the first account’s exit from a saved state when the chain could not be asked: the scan fails instead', async () => {
    await hold(ALICE)
    const { holds } = await import('@/lib/write-hold')
    const open = holds.open
    const spy = vi.spyOn(holds, 'open').mockImplementation(input => ({ ...open(input), state: async () => { throw new Error('RPC unavailable') } }))
    try {
      await expect(otherProjectAdminHolds(localStorage, client() as never, 8453, 7n, BOB)).rejects.toThrow('could not be checked')
    } finally { spy.mockRestore() }
  })

  it('does not hold the account that made it, which its own journal answers for', async () => {
    await hold(ALICE)
    expect(await otherProjectAdminHolds(localStorage, client() as never, 8453, 7n, ALICE)).toHaveLength(0)
  })

  it('lets the exit release it, and forgets accounts with nothing held', async () => {
    await hold(ALICE)
    const [held] = await otherProjectAdminHolds(localStorage, client() as never, 8453, 7n, BOB)
    expect((await held.hold.exit(held.state, { checkedWallet: true }, client() as never)).released).toBe(true)
    expect(await otherProjectAdminHolds(localStorage, client() as never, 8453, 7n, BOB)).toHaveLength(0)
    pruneProjectAdminAccounts(localStorage, 8453, 7n, BOB)
    expect(localStorage.getItem('homerun:project-admin:accounts:v1:8453:7')).toBeNull()
  })

  it('holds a second account while the first account’s update is kept in memory because storage refuses records', async () => {
    const original = Storage.prototype.setItem
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
      if (key.startsWith('nana-sdk:reviewed-write')) throw new Error('Storage unavailable')
      original.call(this, key, value)
    })
    const journal = createBrowserWriteRecovery({ chainId: 8453, account: ALICE, safe: false, namespace: projectAdminNamespace(7n), call: { to: TARGET, data: '0x12345678', value: 0n } }, { storage: heldStorage })
    await journal.withLock(async () => { journal.reserve() })
    noteProjectAdminAccount(localStorage, 8453, 7n, ALICE)
    expect(recoveryRecords()).toHaveLength(0)
    const found = await otherProjectAdminHolds(localStorage, client() as never, 8453, 7n, BOB)
    expect(found).toHaveLength(1)
    expect(found[0].state.record.account).toBe(ALICE)
    pruneProjectAdminAccounts(localStorage, 8453, 7n, BOB)
    expect(JSON.parse(localStorage.getItem('homerun:project-admin:accounts:v1:8453:7')!)).toContain(ALICE.toLowerCase())
  })

  it('is per project', async () => {
    await hold(ALICE)
    expect(await otherProjectAdminHolds(localStorage, client() as never, 8453, 8n, BOB)).toHaveLength(0)
  })

  describe('another account’s Safe proposal', () => {
    const SAFE = '0x4444444444444444444444444444444444444444' as Address
    const PROPOSAL = `0x${'dd'.repeat(32)}` as Hex
    async function holdSafe() {
      const journal = createBrowserWriteRecovery({ chainId: 8453, account: SAFE, safe: true, namespace: projectAdminNamespace(7n), call: { to: TARGET, data: '0x12345678', value: 0n } })
      await journal.withLock(async () => { journal.reserve(); journal.submitted(PROPOSAL) })
      noteProjectAdminAccount(localStorage, 8453, 7n, SAFE)
    }
    const holds = () => otherProjectAdminHolds(localStorage, client() as never, 8453, 7n, BOB)

    it('stays held, with no exit, while it can still run', async () => {
      await holdSafe()
      const [held] = await holds()
      expect(held.state).toMatchObject({ status: 'pending-known-hash', exit: false })
      expect(held.state.record.hash).toBe(PROPOSAL)
    })
  })

  describe('the account list under concurrent change', () => {
    const CAROL = '0x5555555555555555555555555555555555555555' as Address
    const DAVE = '0x6666666666666666666666666666666666666666' as Address
    const accounts = () => JSON.parse(localStorage.getItem('homerun:project-admin:accounts:v1:8453:7') ?? '[]') as string[]
    async function hold(account: Address) {
      const journal = createBrowserWriteRecovery({ chainId: 8453, account, safe: false, namespace: projectAdminNamespace(7n), call: { to: TARGET, data: '0x12345678', value: 0n } })
      await journal.withLock(async () => { journal.reserve() })
      noteProjectAdminAccount(localStorage, 8453, 7n, account)
    }

    it('does not write back a stale list over an account registered while its chain checks waited', async () => {
      await hold(ALICE)
      noteProjectAdminAccount(localStorage, 8453, 7n, DAVE) // listed with nothing held: stale
      let open!: () => void
      const gate = new Promise<void>(resolve => { open = resolve })
      const slow = { ...client(), getChainId: vi.fn(async () => { await gate; return 8453 }) }
      const scanning = otherProjectAdminHolds(localStorage, slow as never, 8453, 7n, BOB)
      await hold(CAROL)
      open()
      const found = await scanning
      // CAROL registered after the scan took its list: the recheck before the wallet opens finds her.
      expect(found.map(item => item.state.record.account)).toEqual([ALICE])
      expect((await otherProjectAdminHolds(localStorage, client() as never, 8453, 7n, BOB)).map(item => item.state.record.account).sort()).toEqual([ALICE, CAROL].sort())
      expect(accounts()).toEqual(expect.arrayContaining([ALICE.toLowerCase(), CAROL.toLowerCase()]))
    })

    it('prunes accounts that hold nothing from the list it reads at that moment, keeping the caller’s', async () => {
      await hold(ALICE)
      noteProjectAdminAccount(localStorage, 8453, 7n, DAVE)
      noteProjectAdminAccount(localStorage, 8453, 7n, BOB)
      pruneProjectAdminAccounts(localStorage, 8453, 7n, BOB)
      expect(accounts()).toEqual([ALICE.toLowerCase(), BOB.toLowerCase()])
    })
  })
})
