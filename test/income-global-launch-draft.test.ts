import { beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('../src/lib/income-contracts', async original => ({ ...await original<typeof import('../src/lib/income-contracts')>(), registeredHomerunDeployer: () => '0x2222222222222222222222222222222222222222' }))
import { incomeLaunchRecord } from '../src/lib/income-launch-session'
import { HELD, LOST } from './support/locks'
import { LockLostError } from '@bananapus/nana-sdk-core/review/locks'
import { INCOME_GLOBAL_DRAFT_KEY, parseIncomeGlobalDraft, readIncomeGlobalDraft, saveIncomeGlobalDraft, serializeIncomeGlobalDraft, verifyIncomeGlobalDraftManifest, withIncomeGlobalDraftLock } from '../src/lib/income-global-launch-draft'
import { globalDraft, globalManifest, hashFor, launchInput, launchPlan, OWNER } from './fixtures/income-global-launch'

function memory() { const values = new Map<string, string>(); return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) } } }
beforeEach(() => { localStorage.clear() })
describe('frozen global INCOME launch descriptor', () => {
  it('persists one small descriptor discoverable from every linked FUND, including a zero-allocation chain', async () => {
    const storage = memory(), draft = await saveIncomeGlobalDraft(storage, globalDraft(), HELD)
    for (const chain of draft.chains) expect(readIncomeGlobalDraft(storage, chain.chainId, BigInt(chain.fundProjectId))).toEqual(draft)
    expect(draft.chains.at(-1)?.initialIncomeAmount).toBe('0')
    expect(serializeIncomeGlobalDraft(draft)).not.toContain('holders')
    expect(serializeIncomeGlobalDraft(draft).length).toBeLessThan(3000)
  })
  it('reconciles restored ownership files with every frozen commitment', async () => {
    expect(verifyIncomeGlobalDraftManifest(globalDraft(), globalManifest())).toEqual(globalManifest())
    expect(() => verifyIncomeGlobalDraftManifest({ ...globalDraft(), manifestHash: hashFor(1) }, globalManifest())).toThrow(/does not match/)
    expect(() => verifyIncomeGlobalDraftManifest({ ...globalDraft(), launchSalt: hashFor(1) }, globalManifest())).toThrow(/does not match/)
  })
  it.each(['name', 'ticker', 'metadataUri', 'manifestUri', 'manifestHash', 'sourceSetHash', 'launchSalt', 'startsAtOrAfter', 'reservedBps'] as const)('does not change frozen %s even before the first chain has submitted', async field => {
    const storage = memory(), draft = await saveIncomeGlobalDraft(storage, globalDraft(), HELD)
    const changed = { ...draft, [field]: field.endsWith('Bps') ? 100 : field === 'startsAtOrAfter' ? 1100 : field === 'name' ? 'Changed' : field === 'ticker' ? 'OTHER' : field.endsWith('Uri') ? 'ipfs://changed' : hashFor(1) }
    await expect(saveIncomeGlobalDraft(storage, changed, HELD)).rejects.toThrow(/frozen global/)
    expect(readIncomeGlobalDraft(storage, 8453, 7n)).toEqual(draft)
  })
  it('merges execution evidence without stale tabs erasing another chain’s progress', async () => {
    const storage = memory(), initial = await saveIncomeGlobalDraft(storage, globalDraft(), HELD)
    const evidence = (chainId: number) => {
      const record = incomeLaunchRecord(launchPlan(launchInput(initial, chainId as 1)).request, BigInt(initial.chains.find(local => local.chainId === chainId)!.fundProjectId), OWNER, false, 200n)
      return { hash: hashFor(chainId), record }
    }
    await saveIncomeGlobalDraft(storage, { ...initial, chains: initial.chains.map(local => local.chainId === 1 ? { ...local, execution: evidence(1) } : local) }, HELD)
    const merged = await saveIncomeGlobalDraft(storage, { ...initial, chains: initial.chains.map(local => local.chainId === 10 ? { ...local, execution: evidence(10) } : local) }, HELD)
    expect(merged.chains[0].execution?.hash).toBe(hashFor(1)); expect(merged.chains[1].execution?.hash).toBe(hashFor(10))
    await expect(saveIncomeGlobalDraft(storage, { ...merged, chains: merged.chains.map(local => local.chainId === 1 ? { ...local, execution: { ...local.execution!, hash: hashFor(2) } } : local) }, HELD)).rejects.toThrow(/different confirmed action/)
  })
  it('binds execution evidence to the frozen ticker and reserved percent', async () => {
    const draft = globalDraft()
    const record = incomeLaunchRecord(launchPlan(launchInput(draft)).request, 7n, OWNER, false, 200n)
    draft.chains[2].execution = { hash: hashFor(8453), record }
    expect(parseIncomeGlobalDraft(draft).ticker).toBe('RENT')
    expect(() => parseIncomeGlobalDraft({ ...draft, ticker: 'OTHER' })).toThrow(/invalid/)
    expect(() => parseIncomeGlobalDraft({ ...draft, reservedBps: 5000 })).toThrow(/invalid/)
  })
  it('stores receipt evidence without a trusted success flag and rejects evidence for different economics', async () => {
    const draft = globalDraft()
    const input = launchInput(draft), record = incomeLaunchRecord(launchPlan(input).request, 7n, OWNER, false, 200n)
    draft.chains[2].execution = { hash: hashFor(8453), record }
    const parsed = parseIncomeGlobalDraft(JSON.parse(serializeIncomeGlobalDraft(draft)))
    expect(parsed.chains[2].execution?.record).toEqual(record)
    expect('confirmed' in parsed.chains[2]).toBe(false)
    expect(() => parseIncomeGlobalDraft({ ...draft, startsAtOrAfter: 900 })).toThrow(/invalid/)
  })
  it('rejects reordered or dropped chains and an inflated global allocation', async () => {
    const draft = globalDraft()
    expect(() => parseIncomeGlobalDraft({ ...draft, chains: [...draft.chains].reverse() })).toThrow()
    expect(() => parseIncomeGlobalDraft({ ...draft, chains: draft.chains.slice(1) })).toThrow()
    expect(() => parseIncomeGlobalDraft({ ...draft, chains: draft.chains.map(local => ({ ...local, initialIncomeAmount: '1' })) })).toThrow()
  })
  it('fails closed on corrupt persisted data and failed storage writes', async () => {
    const storage = memory(); storage.setItem(INCOME_GLOBAL_DRAFT_KEY, '{')
    expect(() => readIncomeGlobalDraft(storage, 8453, 7n)).toThrow()
    await expect(saveIncomeGlobalDraft({ getItem: () => null, setItem: () => undefined }, globalDraft(), HELD)).rejects.toThrow(/could not save/)
  })
  it('queues simultaneous chain completions and preserves both changes', async () => {
    const storage = memory(); await saveIncomeGlobalDraft(storage, globalDraft(), HELD)
    let queue: Promise<unknown> = Promise.resolve()
    const request = vi.fn((_name: string, options: { ifAvailable?: boolean }, callback: (lock: object) => unknown) => {
      expect(options.ifAvailable).not.toBe(true)
      const next = queue.then(() => callback({})); queue = next; return next
    })
    Object.defineProperty(navigator, 'locks', { configurable: true, value: { request } })
    const initial = readIncomeGlobalDraft(storage, 8453, 7n)!
    await Promise.all([1, 8453].map(chainId => withIncomeGlobalDraftLock(async lock => {
      const current = readIncomeGlobalDraft(storage, 8453, 7n)!
      const fundProjectId = BigInt(initial.chains.find(local => local.chainId === chainId)!.fundProjectId)
      const record = incomeLaunchRecord(launchPlan(launchInput(initial, chainId as 1)).request, fundProjectId, OWNER, false, 200n)
      return await saveIncomeGlobalDraft(storage, { ...current, chains: current.chains.map(local => local.chainId === chainId ? { ...local, execution: { hash: hashFor(chainId), record } } : local) }, lock)
    })))
    const updated = readIncomeGlobalDraft(storage, 8453, 7n)!
    expect(updated.chains.filter(local => local.execution).map(local => local.chainId)).toEqual([1, 8453])
  })
  it('saves nothing once another tab took the draft lock', async () => {
    const storage = memory()
    await expect(saveIncomeGlobalDraft(storage, globalDraft(), LOST)).rejects.toThrow(LockLostError)
    expect(storage.getItem(INCOME_GLOBAL_DRAFT_KEY)).toBeNull()
  })
  it('locks the shared draft collection, on the fallback when Web Locks are missing', async () => {
    Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined })
    const task = vi.fn(() => 'saved')
    await expect(withIncomeGlobalDraftLock(task)).resolves.toBe('saved')
    expect(task).toHaveBeenCalledOnce()
    task.mockClear()
    Object.defineProperty(navigator, 'locks', { configurable: true, value: { request: async (_name: string, _options: unknown, callback: (lock: unknown) => void) => callback(null) } })
    await expect(withIncomeGlobalDraftLock(task)).rejects.toThrow(/another tab/)
  })
})
