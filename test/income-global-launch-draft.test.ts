import { beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('../src/lib/income-contracts', async original => ({ ...await original<typeof import('../src/lib/income-contracts')>(), registeredHomerunDeployer: () => '0x2222222222222222222222222222222222222222' }))
import { beginIncomeLaunchSubmission, incomeLaunchSessionKey } from '../src/lib/income-launch-session'
import { INCOME_GLOBAL_DRAFT_KEY, parseIncomeGlobalDraft, readIncomeGlobalDraft, saveIncomeGlobalDraft, serializeIncomeGlobalDraft, verifyIncomeGlobalDraftManifest, withIncomeGlobalDraftLock } from '../src/lib/income-global-launch-draft'
import { globalDraft, globalManifest, hashFor, launchInput, launchPlan, OWNER } from './fixtures/income-global-launch'

function memory() { const values = new Map<string, string>(); return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) } } }
beforeEach(() => { localStorage.clear() })
describe('frozen global INCOME launch descriptor', () => {
  it('persists one small descriptor discoverable from every linked FUND, including a zero-allocation chain', () => {
    const storage = memory(), draft = saveIncomeGlobalDraft(storage, globalDraft())
    for (const chain of draft.chains) expect(readIncomeGlobalDraft(storage, chain.chainId, BigInt(chain.fundProjectId))).toEqual(draft)
    expect(draft.chains.at(-1)?.initialIncomeAmount).toBe('0')
    expect(serializeIncomeGlobalDraft(draft)).not.toContain('holders')
    expect(serializeIncomeGlobalDraft(draft).length).toBeLessThan(3000)
  })
  it('reconciles restored ownership files with every frozen commitment', () => {
    expect(verifyIncomeGlobalDraftManifest(globalDraft(), globalManifest())).toEqual(globalManifest())
    expect(() => verifyIncomeGlobalDraftManifest({ ...globalDraft(), manifestHash: hashFor(1) }, globalManifest())).toThrow(/does not match/)
    expect(() => verifyIncomeGlobalDraftManifest({ ...globalDraft(), launchSalt: hashFor(1) }, globalManifest())).toThrow(/does not match/)
  })
  it.each(['name', 'ticker', 'metadataUri', 'manifestUri', 'manifestHash', 'sourceSetHash', 'launchSalt', 'startsAtOrAfter', 'reservedBps'] as const)('does not change frozen %s even before the first chain has submitted', field => {
    const storage = memory(), draft = saveIncomeGlobalDraft(storage, globalDraft())
    const changed = { ...draft, [field]: field.endsWith('Bps') ? 100 : field === 'startsAtOrAfter' ? 1100 : field === 'name' ? 'Changed' : field === 'ticker' ? 'OTHER' : field.endsWith('Uri') ? 'ipfs://changed' : hashFor(1) }
    expect(() => saveIncomeGlobalDraft(storage, changed)).toThrow(/frozen global/)
    expect(readIncomeGlobalDraft(storage, 8453, 7n)).toEqual(draft)
  })
  it('merges execution evidence without stale tabs erasing another chain’s progress', () => {
    const storage = memory(), initial = saveIncomeGlobalDraft(storage, globalDraft())
    const evidence = (chainId: number) => {
      const record = beginIncomeLaunchSubmission(localStorage, incomeLaunchSessionKey(chainId, BigInt(initial.chains.find(local => local.chainId === chainId)!.fundProjectId)), launchPlan(launchInput(initial, chainId as 1)).request, BigInt(initial.chains.find(local => local.chainId === chainId)!.fundProjectId), OWNER, false, 200n)
      return { hash: hashFor(chainId), record }
    }
    saveIncomeGlobalDraft(storage, { ...initial, chains: initial.chains.map(local => local.chainId === 1 ? { ...local, execution: evidence(1) } : local) })
    const merged = saveIncomeGlobalDraft(storage, { ...initial, chains: initial.chains.map(local => local.chainId === 10 ? { ...local, execution: evidence(10) } : local) })
    expect(merged.chains[0].execution?.hash).toBe(hashFor(1)); expect(merged.chains[1].execution?.hash).toBe(hashFor(10))
    expect(() => saveIncomeGlobalDraft(storage, { ...merged, chains: merged.chains.map(local => local.chainId === 1 ? { ...local, execution: { ...local.execution!, hash: hashFor(2) } } : local) })).toThrow(/different confirmed action/)
  })
  it('binds execution evidence to the frozen ticker and reserved percent', () => {
    const draft = globalDraft()
    const record = beginIncomeLaunchSubmission(localStorage, incomeLaunchSessionKey(8453, 7n), launchPlan(launchInput(draft)).request, 7n, OWNER, false, 200n)
    draft.chains[2].execution = { hash: hashFor(8453), record }
    expect(parseIncomeGlobalDraft(draft).ticker).toBe('RENT')
    expect(() => parseIncomeGlobalDraft({ ...draft, ticker: 'OTHER' })).toThrow(/invalid/)
    expect(() => parseIncomeGlobalDraft({ ...draft, reservedBps: 5000 })).toThrow(/invalid/)
  })
  it('stores receipt evidence without a trusted success flag and rejects evidence for different economics', () => {
    const draft = globalDraft()
    const input = launchInput(draft), record = beginIncomeLaunchSubmission(localStorage, incomeLaunchSessionKey(8453, 7n), launchPlan(input).request, 7n, OWNER, false, 200n)
    draft.chains[2].execution = { hash: hashFor(8453), record }
    const parsed = parseIncomeGlobalDraft(JSON.parse(serializeIncomeGlobalDraft(draft)))
    expect(parsed.chains[2].execution?.record).toEqual(record)
    expect('confirmed' in parsed.chains[2]).toBe(false)
    expect(() => parseIncomeGlobalDraft({ ...draft, startsAtOrAfter: 900 })).toThrow(/invalid/)
  })
  it('rejects reordered or dropped chains and an inflated global allocation', () => {
    const draft = globalDraft()
    expect(() => parseIncomeGlobalDraft({ ...draft, chains: [...draft.chains].reverse() })).toThrow()
    expect(() => parseIncomeGlobalDraft({ ...draft, chains: draft.chains.slice(1) })).toThrow()
    expect(() => parseIncomeGlobalDraft({ ...draft, chains: draft.chains.map(local => ({ ...local, initialIncomeAmount: '1' })) })).toThrow()
  })
  it('fails closed on corrupt persisted data and failed storage writes', () => {
    const storage = memory(); storage.setItem(INCOME_GLOBAL_DRAFT_KEY, '{')
    expect(() => readIncomeGlobalDraft(storage, 8453, 7n)).toThrow()
    expect(() => saveIncomeGlobalDraft({ getItem: () => null, setItem: () => undefined }, globalDraft())).toThrow(/could not save/)
  })
  it('queues simultaneous chain completions and preserves both changes', async () => {
    const storage = memory(); saveIncomeGlobalDraft(storage, globalDraft())
    let queue: Promise<unknown> = Promise.resolve()
    const request = vi.fn((_name: string, options: { ifAvailable?: boolean }, callback: (lock: object) => unknown) => {
      expect(options.ifAvailable).not.toBe(true)
      const next = queue.then(() => callback({})); queue = next; return next
    })
    Object.defineProperty(navigator, 'locks', { configurable: true, value: { request } })
    const initial = readIncomeGlobalDraft(storage, 8453, 7n)!
    await Promise.all([1, 8453].map(chainId => withIncomeGlobalDraftLock(() => {
      const current = readIncomeGlobalDraft(storage, 8453, 7n)!
      const fundProjectId = BigInt(initial.chains.find(local => local.chainId === chainId)!.fundProjectId)
      const record = beginIncomeLaunchSubmission(localStorage, incomeLaunchSessionKey(chainId, fundProjectId), launchPlan(launchInput(initial, chainId as 1)).request, fundProjectId, OWNER, false, 200n)
      return saveIncomeGlobalDraft(storage, { ...current, chains: current.chains.map(local => local.chainId === chainId ? { ...local, execution: { hash: hashFor(chainId), record } } : local) })
    })))
    const updated = readIncomeGlobalDraft(storage, 8453, 7n)!
    expect(updated.chains.filter(local => local.execution).map(local => local.chainId)).toEqual([1, 8453])
  })
  it('requires a Web Lock before editing the shared draft collection', async () => {
    Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined })
    const task = vi.fn()
    await expect(withIncomeGlobalDraftLock(task)).rejects.toThrow(/Web Locks/)
    expect(task).not.toHaveBeenCalled()
    Object.defineProperty(navigator, 'locks', { configurable: true, value: { request: async (_name: string, _options: unknown, callback: (lock: unknown) => void) => callback(null) } })
    await expect(withIncomeGlobalDraftLock(task)).rejects.toThrow(/another tab/)
  })
})
