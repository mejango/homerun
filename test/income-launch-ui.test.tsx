import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { encodeAbiParameters, encodeEventTopics, type Address, type Hex, type PublicClient } from 'viem'
import type { FundProjectState } from '../src/lib/fund-state'
import type { FundGlobalManifest } from '../src/lib/fund-global-manifest'

const runtime = vi.hoisted(() => ({
  account: '0x1111111111111111111111111111111111111111' as Address | undefined,
  helper: '0x2222222222222222222222222222222222222222' as Address | null,
  clients: new Map<number, PublicClient>(), funds: new Map<number, FundProjectState>(), bindings: new Map<number, bigint>(),
  bindingError: false, blockers: [] as string[], safe: false, manifest: null as FundGlobalManifest | null,
  send: vi.fn(), snapshot: vi.fn(), history: vi.fn(), prepare: vi.fn(), pinMedia: vi.fn(), pinJson: vi.fn(),
  readBinding: vi.fn(), allocation: vi.fn(), verify: vi.fn(), waitSafe: vi.fn(), invalidate: vi.fn(), fetch: vi.fn(),
}))
vi.mock('@wagmi/core', () => ({ getAccount: () => ({ address: runtime.account }), getPublicClient: (_config: unknown, options: {chainId: number}) => runtime.clients.get(options.chainId) }))
vi.mock('@/hooks/useWallet', () => ({ useWallet: () => ({ address: runtime.account }) }))
vi.mock('@/hooks/useSafeTx', () => ({ useSafeTx: () => ({ phase: 'idle', busy: false, safeProposalHash: null, error: null, send: runtime.send }), txPhaseLabel: (_phase: string, labels: { idle: string }) => labels.idle }))
vi.mock('@tanstack/react-query', () => { const cache = { invalidateQueries: runtime.invalidate }; return { keepPreviousData: (data: unknown) => data, useQuery: ({ queryKey }: {queryKey: [string, number, string]}) => ({ data: queryKey[0] === 'income-launch-fund' ? runtime.funds.get(queryKey[1]) : runtime.bindings.get(queryKey[1]) ?? null, isError: queryKey[0] === 'income-binding' && runtime.bindingError, isPending: false }), useQueryClient: () => cache } })
vi.mock('@/components/IncomeProject', () => ({ IncomeProject: ({ chainId, projectId }: {chainId: number; projectId: bigint}) => <div>Existing INCOME {chainId}/{projectId.toString()}</div> }))
vi.mock('@/components/StickyCreate', () => ({ StickyCreate: ({ state, onCreated }: {state: FundProjectState; onCreated: (id: bigint) => void}) => <div data-sticky={state.chainId}><button type="button" onClick={() => onCreated(90n)}>Confirm Sticky {state.chainId}</button></div> }))
vi.mock('@/lib/income-contracts', async importOriginal => ({ ...await importOriginal<typeof import('../src/lib/income-contracts')>(), registeredIncomeDeployer: () => runtime.helper }))
vi.mock('@/lib/income-launch', async importOriginal => ({ ...await importOriginal<typeof import('../src/lib/income-launch')>(), incomeLaunchBlockers: () => runtime.blockers, prepareIncomeLaunch: runtime.prepare, readIncomeLaunchBinding: runtime.readBinding }))
vi.mock('@/lib/fund-global-snapshot', async importOriginal => ({ ...await importOriginal<typeof import('../src/lib/fund-global-snapshot')>(), readFundGlobalSnapshot: runtime.snapshot }))
vi.mock('@/lib/fund-global-manifest', async importOriginal => ({ ...await importOriginal<typeof import('../src/lib/fund-global-manifest')>(), verifyFundGlobalManifestHistory: runtime.history }))
vi.mock('@/lib/income-allocation-state', () => ({ readInitialIncomeAllocation: runtime.allocation }))
vi.mock('@/lib/income-launch-session', async importOriginal => ({ ...await importOriginal<typeof import('../src/lib/income-launch-session')>(), verifyIncomeLaunchExecution: runtime.verify }))
vi.mock('@/lib/jbcenter-ipfs', () => ({ JBCENTER_IPFS_GATEWAY: 'https://ipfs.test/ipfs/', jbCenterIpfs: { pinMedia: runtime.pinMedia, pinJson: runtime.pinJson } }))
vi.mock('@/lib/safe-connector', () => ({ isSafeConnection: () => runtime.safe, waitForSafeExecutionHash: runtime.waitSafe }))
vi.mock('@/providers/Providers', () => ({ wagmiConfig: {} }))

import { IncomeLaunch } from '../src/components/IncomeLaunch'
import { fundGlobalManifestHash, serializeFundGlobalManifest } from '../src/lib/fund-global-manifest'
import { homerunIncomeDeployerAbi } from '../src/lib/income-contracts'
import { beginIncomeLaunchSubmission, incomeLaunchSessionKey, readIncomeLaunchPending, type IncomeLaunchPending } from '../src/lib/income-launch-session'
import { readIncomeGlobalDraft, saveIncomeGlobalDraft, serializeIncomeGlobalDraft } from '../src/lib/income-global-launch-draft'
import { displayChainName } from '../src/lib/chainDisplay'
import { BLOCK_HASH, CHAIN_IDS, FUND_IDS, HELPER, OWNER, TOKEN, VAULT, fundState, globalDraft, globalManifest, globalSnapshot, hashFor, launchInput, launchPlan } from './fixtures/income-global-launch'

const KEY = incomeLaunchSessionKey(8453, 7n)
type Callbacks = { reverify: () => Promise<unknown>; beforeWrite: () => Promise<void>; onWriteRejected: () => void }
function pending() { return readIncomeLaunchPending(localStorage, KEY) }
function draft() { return readIncomeGlobalDraft(localStorage, 8453, 7n)! }
function eventReceipt(chainId: number) {
  const local = runtime.manifest!.allocations.find(entry => entry.chainId === chainId)!
  return { transactionHash: hashFor(chainId), blockNumber: 201n, logs: [{ address: HELPER, topics: encodeEventTopics({ abi: homerunIncomeDeployerAbi, eventName: 'IncomeDeployed', args: { fundProjectId: BigInt(local.fundProjectId), incomeProjectId: 10n, operator: OWNER } }), data: encodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'address' }, { type: 'bytes32' }], [TOKEN, VAULT, TOKEN, local.merkleRoot]) }] }
}
function allocation(chainId: number) {
  const manifest = runtime.manifest!, local = manifest.allocations.find(entry => entry.chainId === chainId)!
  return { chainId, deployer: HELPER, fundProjectId: BigInt(local.fundProjectId), snapshotBlockNumber: BigInt(local.snapshotBlockNumber), snapshotBlockHash: local.snapshotBlockHash, sourceSetHash: manifest.sourceSetHash, totalFundSupply: BigInt(manifest.totalFundSupply), launchSalt: manifest.launchSalt, merkleRoot: local.merkleRoot, leafCount: BigInt(local.leafCount), manifestHash: fundGlobalManifestHash(manifest), distributionId: local.distributionId, initialIncomeSupply: 500_000n * 10n ** 18n, localInitialIncomeSupply: BigInt(local.incomeAmount), vault: VAULT, blockNumber: 201n }
}
function readFile(file: File) { return new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = reject; reader.readAsText(file) }) }

describe('global INCOME launch flow', () => {
  let host: HTMLDivElement, root: Root
  beforeEach(() => {
    localStorage.clear(); vi.clearAllMocks()
    runtime.account = OWNER; runtime.helper = HELPER; runtime.bindingError = false; runtime.blockers = []; runtime.safe = false; runtime.manifest = globalManifest(); runtime.bindings.clear(); runtime.clients.clear(); runtime.funds.clear()
    for (const chainId of CHAIN_IDS) { runtime.funds.set(chainId, fundState(chainId)); runtime.clients.set(chainId, { getChainId: async () => chainId, getBlock: async () => ({ number: 200n, hash: BLOCK_HASH, timestamp: BigInt(1000 + chainId) }), getTransactionReceipt: async () => eventReceipt(chainId) } as unknown as PublicClient) }
    runtime.send.mockResolvedValue(null); runtime.snapshot.mockResolvedValue(globalSnapshot()); runtime.history.mockImplementation(async (_clients, value) => value)
    runtime.prepare.mockImplementation(async (_client, input) => launchPlan(input)); runtime.pinMedia.mockImplementation(async file => { runtime.manifest = JSON.parse(await readFile(file)); return { cid: 'global-snapshot' } }); runtime.pinJson.mockResolvedValue({ cid: 'global-metadata' })
    runtime.verify.mockResolvedValue('confirmed'); runtime.readBinding.mockResolvedValue(10n); runtime.allocation.mockImplementation(async (_client, {chainId}) => allocation(chainId)); runtime.waitSafe.mockResolvedValue(hashFor(8453)); runtime.invalidate.mockResolvedValue(undefined)
    runtime.fetch.mockImplementation(async () => ({ ok: true, json: async () => runtime.manifest })); vi.stubGlobal('fetch', runtime.fetch)
    Object.defineProperty(navigator, 'locks', { configurable: true, value: { request: async (_name: string, _options: unknown, callback: (lock: object) => Promise<void>) => callback({}) } })
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:test') }); Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() })
    host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  })
  afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals() })
  async function render(launchUnavailable = false, plannedAllocation?: { operatorPercent: number | null; fundStakerPercent: number | null }) { await act(async () => root.render(<IncomeLaunch state={runtime.funds.get(8453)!} client={runtime.clients.get(8453)!} launchUnavailable={launchUnavailable} plannedAllocation={plannedAllocation} />)) }
  function section(chainId = 8453) { const node = host.querySelector(`[aria-label="${displayChainName(chainId)} INCOME launch"]`); if (!node) throw new Error(`Missing chain ${chainId}: ${host.textContent}`); return node }
  function button(text: string, scope: ParentNode = host) { const result = [...scope.querySelectorAll('button')].find(item => item.textContent === text); if (!result) throw new Error(`Missing button: ${text}: ${host.textContent}`); return result }
  async function click(text: string, scope: ParentNode = host) { await act(async () => { button(text, scope).click(); await Promise.allSettled(runtime.pinMedia.mock.results.filter(result => result.type === 'return').map(result => result.value)) }) }
  async function frozen() { await render(); await click('Create global ownership snapshot'); await click('Publish snapshot'); await click('Save shared launch plan') }
  async function ready(chainId = 8453) { await frozen(); await click(`Confirm Sticky ${chainId}`); await click(`Prepare ${displayChainName(chainId)} INCOME`); await act(async () => (section(chainId).querySelector('input[type="checkbox"]') as HTMLInputElement).click()) }
  function savedPending(chainId = 8453) { const index = CHAIN_IDS.indexOf(chainId as typeof CHAIN_IDS[number]); return beginIncomeLaunchSubmission(localStorage, incomeLaunchSessionKey(chainId, FUND_IDS[index]), launchPlan(launchInput(draft(), chainId as 8453, runtime.manifest!)).request, FUND_IDS[index], OWNER, false, 200n) }
  async function setInput(field: HTMLInputElement, value: string) { await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value); field.dispatchEvent(new Event('input', { bubbles: true })) }) }
  async function hashInput(value: string, chainId = 8453) { await setInput(section(chainId).querySelector('input[placeholder="0x…"]') as HTMLInputElement, value) }
  async function upload(field: Element, json: string) { Object.defineProperty(field, 'files', { configurable: true, value: [{ size: json.length, text: async () => json }] }); await act(async () => field.dispatchEvent(new Event('change', { bubbles: true }))) }
  function restorePlan() { saveIncomeGlobalDraft(localStorage, globalDraft()) }
  function allocationInputs() {
    const fields = [...host.querySelectorAll<HTMLInputElement>('input[inputmode="decimal"]')]
    expect(fields).toHaveLength(2)
    return fields
  }

  it('publishes exact global manifest bytes once and keeps all four networks, including zero allocation', async () => {
    await render(); await click('Create global ownership snapshot')
    expect(button('Download snapshot').disabled).toBe(false)
    expect(runtime.snapshot).toHaveBeenCalledWith(expect.objectContaining({ root: { chainId: 8453, projectId: 7n }, clients: expect.any(Map) }))
    await click('Publish snapshot')
    const file = runtime.pinMedia.mock.calls[0][0] as File, contents = await readFile(file)
    expect(file.type).toBe('application/json'); expect(serializeFundGlobalManifest(JSON.parse(contents))).toBe(contents)
    expect(host.textContent).toContain('4 networks'); expect(host.textContent).toContain('Arbitrum: 0 INCOME')
    expect(host.querySelector('[data-sticky]')).toBeNull(); expect(runtime.pinJson).not.toHaveBeenCalled()
    await click('Save shared launch plan')
    expect(host.querySelectorAll('[data-sticky]').length).toBe(4); expect(section(42161).textContent).toContain('still needs Sticky and INCOME')
    expect(runtime.pinMedia).toHaveBeenCalledOnce(); expect(draft().startsAtOrAfter).toBe(1001)
  })

  it('keeps the ownership file downloadable after a failed publication', async () => {
    runtime.pinMedia.mockRejectedValueOnce(new Error('Pin unavailable')); await render(); await click('Create global ownership snapshot'); await click('Publish snapshot')
    expect(host.textContent).toContain('Pin unavailable'); expect(button('Download snapshot').disabled).toBe(false); expect(host.querySelector('[data-sticky]')).toBeNull()
  })

  it('freezes one start, name, metadata, snapshot, and percentages before Sticky setup', async () => {
    await frozen(); const shared = draft()
    expect(host.querySelector('input[inputmode="decimal"]')).toBeNull()
    for (const chainId of [8453, 42161]) { await click(`Confirm Sticky ${chainId}`); await click(`Prepare ${displayChainName(chainId)} INCOME`) }
    for (const [, input] of runtime.prepare.mock.calls) expect(input).toEqual(expect.objectContaining({ name: shared.name, projectUri: shared.metadataUri, manifestUri: shared.manifestUri, salt: shared.launchSalt, startsAtOrAfter: shared.startsAtOrAfter, operatorBps: 7000, fundHolderBps: 1000, clients: expect.any(Map) }))
    expect(runtime.pinJson).toHaveBeenCalledOnce(); expect(host.textContent).toContain('0 of 4 networks confirmed')
  })

  it('prefills editable allocation terms from FUND metadata and freezes those reviewed percentages', async () => {
    await render(false, { operatorPercent: 50, fundStakerPercent: 15 })
    await click('Create global ownership snapshot'); await click('Publish snapshot')
    expect(allocationInputs().map(field => field.value)).toEqual(['50', '15'])
    expect(allocationInputs().every(field => !field.disabled && !field.readOnly)).toBe(true)
    await click('Save shared launch plan')
    expect(draft()).toMatchObject({ operatorBps: 5000, fundHolderBps: 1500 })
    expect(runtime.pinJson).toHaveBeenCalledWith(expect.objectContaining({ homerun: expect.objectContaining({ operatorBps: 5000, fundHolderBps: 1500 }) }))
    await click('Confirm Sticky 8453'); await click('Prepare Base INCOME')
    expect(runtime.prepare).toHaveBeenCalledWith(runtime.clients.get(8453), expect.objectContaining({ operatorBps: 5000, fundHolderBps: 1500 }))
    expect(host.textContent).toContain('50% operators, 15% stakers, 35% customers')
  })

  it('seeds late metadata while the displayed shared terms are still untouched', async () => {
    await render(); await click('Create global ownership snapshot'); await click('Publish snapshot')
    expect(allocationInputs().map(field => field.value)).toEqual(['70', '10'])
    await render(false, { operatorPercent: 50, fundStakerPercent: 15 })
    expect(allocationInputs().map(field => field.value)).toEqual(['50', '15'])
    await click('Save shared launch plan')
    expect(draft()).toMatchObject({ operatorBps: 5000, fundHolderBps: 1500 })
  })

  it.each([0, 1])('preserves both allocation fields after the operator edits field %s', async fieldIndex => {
    await render(false, { operatorPercent: 50, fundStakerPercent: 15 })
    await click('Create global ownership snapshot'); await click('Publish snapshot')
    await setInput(allocationInputs()[fieldIndex], fieldIndex === 0 ? '60' : '20')
    await render(false, { operatorPercent: 40, fundStakerPercent: 30 })
    expect(allocationInputs().map(field => field.value)).toEqual(fieldIndex === 0 ? ['60', '15'] : ['50', '20'])
    await click('Save shared launch plan')
    expect(draft()).toMatchObject(fieldIndex === 0 ? { operatorBps: 6000, fundHolderBps: 1500 } : { operatorBps: 5000, fundHolderBps: 2000 })
  })

  it('keeps already frozen default percentages when different metadata arrives', async () => {
    await frozen()
    const saved = serializeIncomeGlobalDraft(draft())
    await render(false, { operatorPercent: 50, fundStakerPercent: 15 })
    expect(serializeIncomeGlobalDraft(draft())).toBe(saved)
    expect(host.querySelector('input[inputmode="decimal"]')).toBeNull()
    expect(host.textContent).toContain('70% operators, 10% stakers, 20% customers')
    await click('Confirm Sticky 8453'); await click('Prepare Base INCOME')
    expect(runtime.prepare).toHaveBeenCalledWith(runtime.clients.get(8453), expect.objectContaining({ operatorBps: 7000, fundHolderBps: 1000 }))
  })

  it('restores frozen percentages before considering different metadata defaults', async () => {
    restorePlan()
    const saved = serializeIncomeGlobalDraft(draft())
    await render(false, { operatorPercent: 50, fundStakerPercent: 15 })
    expect(serializeIncomeGlobalDraft(draft())).toBe(saved)
    expect(host.querySelector('input[inputmode="decimal"]')).toBeNull()
    expect(host.textContent).toContain('70% operators, 10% stakers, 20% customers')
    await click('Confirm Sticky 8453'); await click('Prepare Base INCOME')
    expect(runtime.prepare).toHaveBeenCalledWith(runtime.clients.get(8453), expect.objectContaining({ operatorBps: 7000, fundHolderBps: 1000 }))
    expect(runtime.pinJson).not.toHaveBeenCalled()
  })

  it('keeps reviewed terms stable when metadata arrives during asynchronous freeze verification', async () => {
    await render(false, { operatorPercent: 50, fundStakerPercent: 15 })
    await click('Create global ownership snapshot'); await click('Publish snapshot')
    let finish!: (manifest: FundGlobalManifest) => void
    runtime.history.mockImplementationOnce(() => new Promise<FundGlobalManifest>(resolve => { finish = resolve }))
    await act(async () => { button('Save shared launch plan').click(); await Promise.resolve() })
    await render(false, { operatorPercent: 40, fundStakerPercent: 30 })
    expect(allocationInputs().map(field => field.value)).toEqual(['50', '15'])
    expect(readIncomeGlobalDraft(localStorage, 8453, 7n)).toBeNull()
    await act(async () => finish(runtime.manifest!))
    expect(draft()).toMatchObject({ operatorBps: 5000, fundHolderBps: 1500 })
    expect(runtime.pinJson).toHaveBeenCalledWith(expect.objectContaining({ homerun: expect.objectContaining({ operatorBps: 5000, fundHolderBps: 1500 }) }))
  })

  it.each([
    { operatorPercent: -1, fundStakerPercent: 15 },
    { operatorPercent: 101, fundStakerPercent: 0 },
    { operatorPercent: 50, fundStakerPercent: -1 },
    { operatorPercent: 0, fundStakerPercent: 101 },
    { operatorPercent: Number.NaN, fundStakerPercent: 15 },
    { operatorPercent: 50, fundStakerPercent: Number.NaN },
    { operatorPercent: Number.POSITIVE_INFINITY, fundStakerPercent: 15 },
    { operatorPercent: 50, fundStakerPercent: Number.NEGATIVE_INFINITY },
    { operatorPercent: 90, fundStakerPercent: 15 },
    { operatorPercent: 50.001, fundStakerPercent: 15 },
    { operatorPercent: 50, fundStakerPercent: 15.001 },
    { operatorPercent: null, fundStakerPercent: 95 },
  ])('ignores invalid planned percentages without partially changing valid defaults: %o', async plannedAllocation => {
    await render(false, plannedAllocation); await click('Create global ownership snapshot'); await click('Publish snapshot')
    expect(allocationInputs().map(field => field.value)).toEqual(['70', '10'])
    await click('Save shared launch plan')
    expect(draft()).toMatchObject({ operatorBps: 7000, fundHolderBps: 1000 })
  })

  it('uses existing defaults when both planned percentages are absent', async () => {
    await render(false, { operatorPercent: null, fundStakerPercent: null })
    await click('Create global ownership snapshot'); await click('Publish snapshot')
    expect(allocationInputs().map(field => field.value)).toEqual(['70', '10'])
  })

  it.each([
    { planned: { operatorPercent: null, fundStakerPercent: 15 }, expected: ['70', '15'] },
    { planned: { operatorPercent: 50, fundStakerPercent: null }, expected: ['50', '10'] },
  ])('uses defaults only for missing planned fields: %o', async ({ planned, expected }) => {
    await render(false, planned); await click('Create global ownership snapshot'); await click('Publish snapshot')
    expect(allocationInputs().map(field => field.value)).toEqual(expected)
  })

  it('displays a planned zero staker share but blocks freezing it until explicitly corrected', async () => {
    await render(false, { operatorPercent: 50, fundStakerPercent: 0 })
    await click('Create global ownership snapshot'); await click('Publish snapshot')
    expect(allocationInputs().map(field => field.value)).toEqual(['50', '0'])
    await click('Save shared launch plan')
    expect(host.textContent).toContain('Include a positive staker share')
    expect(readIncomeGlobalDraft(localStorage, 8453, 7n)).toBeNull()
    expect(runtime.pinJson).not.toHaveBeenCalled(); expect(runtime.prepare).not.toHaveBeenCalled()
    await render(false, { operatorPercent: 70, fundStakerPercent: 10 })
    expect(allocationInputs().map(field => field.value)).toEqual(['50', '0'])
    await setInput(allocationInputs()[1], '15'); await click('Save shared launch plan')
    expect(draft()).toMatchObject({ operatorBps: 5000, fundHolderBps: 1500 })
  })

  it('requires explicit operator attestation before the mandatory transaction review', async () => {
    await frozen(); await click('Confirm Sticky 8453'); await click('Prepare Base INCOME')
    expect(button('Review Base deployment').disabled).toBe(true); await click('Review Base deployment'); expect(runtime.send).not.toHaveBeenCalled()
    expect(host.textContent).toContain('does not prove historical completeness')
  })

  it('cancelling review records no submission and explains independent local activation', async () => {
    await ready(); await click('Review Base deployment')
    expect(runtime.send).toHaveBeenCalledOnce(); expect(pending()).toBeNull()
    expect(runtime.send.mock.calls[0][1].reviewNotice).toContain('no all-networks-ready barrier')
  })

  it('persists the exact unknown attempt before writing and restores it across remounts', async () => {
    runtime.send.mockImplementation(async (_request, callbacks: Callbacks) => { await callbacks.reverify(); await callbacks.beforeWrite(); expect(pending()?.phase).toBe('unknown'); return null })
    await ready(); await click('Review Base deployment'); const record = pending()!
    expect(record.value).toBe('1'); expect(record.data).toMatch(/^0x/)
    await act(async () => root.unmount()); root = createRoot(host); await render()
    expect(pending()?.sessionId).toBe(record.sessionId); expect(runtime.send).toHaveBeenCalledOnce(); expect(host.textContent).toContain('0 of 4 networks confirmed')
  })

  it('clears an unknown submission only after explicit wallet rejection', async () => {
    runtime.send.mockImplementation(async (_request, callbacks: Callbacks) => { await callbacks.beforeWrite(); callbacks.onWriteRejected(); return null })
    await ready(); await click('Review Base deployment'); expect(pending()).toBeNull()
  })

  it('rejects changed encoded request or fee before recording a write', async () => {
    runtime.send.mockImplementation(async (_request, callbacks: Callbacks) => { runtime.prepare.mockImplementationOnce(async (_client, input) => ({ ...launchPlan(input), request: { ...launchPlan(input).request, value: 2n } })); await callbacks.reverify(); await callbacks.beforeWrite(); return null })
    await ready(); await click('Review Base deployment'); expect(host.textContent).toContain('deployment changed'); expect(pending()).toBeNull()
  })

  it('blocks a different tab’s pending attempt after an earlier review', async () => {
    await ready(); savedPending(); await click('Review Base deployment')
    expect(runtime.send).not.toHaveBeenCalled(); expect(host.textContent).toContain('already be pending')
  })

  it('requires Web Locks before opening wallet review', async () => {
    await ready(); Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined }); await click('Review Base deployment')
    expect(runtime.send).not.toHaveBeenCalled(); expect(host.textContent).toContain('Web Locks')
  })

  it('keeps Sticky recovery mounted across wallet changes and binding read failures', async () => {
    await ready(); runtime.account = undefined; runtime.bindingError = true; await render()
    expect(host.querySelectorAll('[data-sticky]').length).toBe(4); expect(button('Review Base deployment').closest('fieldset')?.disabled).toBe(true)
  })

  it('counts only the network whose receipt, binding, and local vault have all verified', async () => {
    await ready(); const record = savedPending(); await act(async () => window.dispatchEvent(new Event('homerun-income-launch-recovery')))
    await hashInput(hashFor(8453)); await click('Check execution', section())
    expect(runtime.verify).toHaveBeenCalledWith(runtime.clients.get(8453), record, hashFor(8453)); expect(pending()).toBeNull()
    expect(host.textContent).toContain('1 of 4 networks confirmed'); expect(host.textContent).not.toContain('Every network’s deployment')
    expect(draft().chains.find(row => row.chainId === 8453)?.execution?.hash).toBe(hashFor(8453))
    expect(host.textContent).toContain('Existing INCOME 8453/10')
  })

  it('retains pending recovery when the vault cannot be verified', async () => {
    await ready(); savedPending(); runtime.allocation.mockResolvedValue(null); await act(async () => window.dispatchEvent(new Event('homerun-income-launch-recovery')))
    await hashInput(hashFor(8453)); await click('Check execution', section())
    expect(pending()).not.toBeNull(); expect(host.textContent).toContain('vault could not be verified'); expect(host.textContent).toContain('0 of 4')
  })

  it('refuses a funded vault bound to another global source set', async () => {
    await ready(); savedPending(); runtime.allocation.mockImplementation(async (_client, {chainId}) => ({ ...allocation(chainId), sourceSetHash: BLOCK_HASH })); await act(async () => window.dispatchEvent(new Event('homerun-income-launch-recovery')))
    await hashInput(hashFor(8453)); await click('Check execution', section())
    expect(pending()).not.toBeNull(); expect(host.textContent).toContain('does not match the verified initial INCOME vault')
  })

  it('restores downloaded ownership history and republishes the exact imported bytes', async () => {
    await render(); const contents = serializeFundGlobalManifest(globalManifest()); await upload(host.querySelector('input[type="file"]')!, contents)
    expect(runtime.history).toHaveBeenCalledWith(expect.any(Map), globalManifest(), expect.objectContaining({ signal: expect.any(AbortSignal) }))
    await click('Publish snapshot'); expect(await readFile(runtime.pinMedia.mock.calls[0][0])).toBe(contents); expect(runtime.snapshot).not.toHaveBeenCalled()
  })

  it('restores a frozen descriptor from any chain and fetches its committed manifest', async () => {
    await render(); await upload([...host.querySelectorAll('input[type="file"]')].at(-1)!, serializeIncomeGlobalDraft(globalDraft()))
    expect(runtime.fetch).toHaveBeenCalled(); expect(host.querySelectorAll('[data-sticky]').length).toBe(4); expect(host.textContent).toContain('0 of 4 networks confirmed')
    expect(runtime.pinMedia).not.toHaveBeenCalled(); expect(runtime.pinJson).not.toHaveBeenCalled()
  })

  it('accepts the downloaded manifest when IPFS restoration is unavailable', async () => {
    restorePlan(); runtime.fetch.mockRejectedValue(new Error('IPFS unavailable')); await render()
    expect(host.querySelector('[data-sticky]')).toBeNull()
    await upload(host.querySelector('input[type="file"]')!, serializeFundGlobalManifest(globalManifest()))
    expect(host.querySelectorAll('[data-sticky]').length).toBe(4); expect(runtime.history).not.toHaveBeenCalled()
  })

  it('never treats a Safe proposal as a confirmed local deployment', async () => {
    runtime.safe = true; const proposal = BLOCK_HASH; let execute!: (hash: Hex) => void
    runtime.waitSafe.mockImplementation(() => new Promise<Hex>(resolve => { execute = resolve }))
    runtime.send.mockImplementation(async (_request, callbacks: Callbacks) => { await callbacks.beforeWrite(); return proposal })
    await ready(); await click('Review Base deployment')
    expect(pending()?.hash).toBe(proposal); expect(pending()?.safe).toBe(true); expect(runtime.verify).not.toHaveBeenCalled(); expect(host.textContent).toContain('0 of 4')
    await act(async () => execute(hashFor(8453)))
    expect(runtime.verify).toHaveBeenCalledWith(runtime.clients.get(8453), expect.objectContaining({ hash: proposal, safe: true }), hashFor(8453)); expect(pending()).toBeNull(); expect(host.textContent).toContain('1 of 4')
  })

  it('opens only one wallet review on immediate repeated clicks', async () => {
    let finish!: () => void; const submitted = new Promise<void>(resolve => { finish = resolve })
    runtime.send.mockImplementation(async (_request, callbacks: Callbacks) => { await callbacks.beforeWrite(); await submitted; return null })
    await ready(); const deploy = button('Review Base deployment'); await act(async () => { deploy.click(); deploy.click(); await Promise.resolve() })
    expect(runtime.send).toHaveBeenCalledOnce(); await act(async () => finish()); expect(pending()?.phase).toBe('unknown')
  })

  it('reverifies restored completed receipts rather than trusting the saved completion count', async () => {
    restorePlan(); let shared = draft()
    for (const chainId of CHAIN_IDS) { const record = savedPending(chainId); shared = { ...shared, chains: shared.chains.map(row => row.chainId === chainId ? { ...row, stickyProjectId: '90', execution: { hash: hashFor(chainId), record } } : row) } }
    saveIncomeGlobalDraft(localStorage, shared)
    runtime.verify.mockImplementation(async (client: PublicClient) => { if (await client.getChainId() === 10) throw new Error('RPC unavailable'); return 'confirmed' })
    await render()
    expect(host.textContent).toContain('3 of 4 networks confirmed'); expect(host.textContent).not.toContain('Every network’s deployment'); expect(runtime.verify).toHaveBeenCalled()
  })

  it('confirms all four local vaults, including the empty allocation, before declaring completion', async () => {
    restorePlan(); let shared = draft()
    for (const chainId of CHAIN_IDS) { const record = savedPending(chainId); shared = { ...shared, chains: shared.chains.map(row => row.chainId === chainId ? { ...row, stickyProjectId: '90', execution: { hash: hashFor(chainId), record } } : row) } }
    saveIncomeGlobalDraft(localStorage, shared); await render()
    expect(host.textContent).toContain('4 of 4 networks confirmed'); expect(host.textContent).toContain('Every network’s deployment and local initial allocation is confirmed')
  })

  it('keeps an empty remote chain visible when it still needs its canonical FUND token', async () => {
    runtime.funds.set(42161, { ...fundState(42161), tokenAddress: null }); await frozen()
    expect(section(42161).querySelector('a')?.getAttribute('href')).toBe('/project/42161/8'); expect(host.querySelectorAll('[data-sticky]').length).toBe(4)
  })

  it('requires registered contracts and preserves operations for an existing local INCOME', async () => {
    runtime.helper = null; await render(); await click('Create global ownership snapshot'); expect(runtime.snapshot).not.toHaveBeenCalled(); expect(runtime.send).not.toHaveBeenCalled()
    runtime.bindings.set(8453, 10n); await render(); expect(host.textContent).toContain('Existing INCOME 8453/10'); expect(host.textContent).toContain('Restore the shared launch plan')
  })


  it('keeps verified INCOME operations available when a saved manifest cannot load', async () => {
    restorePlan(); runtime.bindings.set(8453, 10n); runtime.fetch.mockRejectedValue(new Error('IPFS unavailable')); await render(true)
    expect(host.textContent).toContain('Existing INCOME 8453/10'); expect(host.querySelector('[data-sticky]')).toBeNull()
    runtime.bindings.clear(); runtime.bindingError = true; await render(true)
    expect(host.textContent).toContain('Existing INCOME 8453/10'); expect(runtime.send).not.toHaveBeenCalled()
  })

  it('disables new launch controls while retaining pending execution recovery', async () => {
    await ready(); savedPending(); await act(async () => window.dispatchEvent(new Event('homerun-income-launch-recovery'))); await render(true)
    expect(button('Review Base deployment').closest('fieldset')?.disabled).toBe(true)
    await hashInput(hashFor(8453)); expect(button('Check execution', section()).disabled).toBe(false); await click('Check execution', section())
    expect(host.textContent).toContain('1 of 4 networks confirmed'); expect(host.textContent).toContain('Existing INCOME 8453/10')
  })

  it('rechecks parent launch eligibility immediately before submitting an already reviewed transaction', async () => {
    let callbacks!: Callbacks, finish!: () => void
    runtime.send.mockImplementation(async (_request, options: Callbacks) => { callbacks = options; await new Promise<void>(resolve => { finish = resolve }); return null })
    await ready(); await act(async () => { button('Review Base deployment').click(); await Promise.resolve() }); await render(true)
    await expect(callbacks.beforeWrite()).rejects.toThrow('Refresh the FUND state'); expect(pending()).toBeNull(); await act(async () => finish())
  })

  it('retains foreign or unconfirmed execution attempts without claiming completion', async () => {
    await ready(); const record: IncomeLaunchPending = savedPending(); runtime.verify.mockRejectedValue(new Error('Execution does not match saved call')); await act(async () => window.dispatchEvent(new Event('homerun-income-launch-recovery')))
    await hashInput(hashFor(8453)); await click('Check execution', section()); expect(pending()?.sessionId).toBe(record.sessionId); expect(runtime.allocation).not.toHaveBeenCalled(); expect(host.textContent).toContain('0 of 4')
  })
})
