import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseAbi, zeroAddress, type Address, type Hex, type PublicClient } from 'viem'
import type { Project721Tier } from '@bananapus/nana-sdk-core/v6'
import type { TxRequest, TxSendOptions } from '@/hooks/useSafeTx'
import type { ProjectShopState } from '@/lib/project-shop'
import type { PreparedProjectShopWrite, ProjectShopWriteState } from '@/lib/project-shop-write'
import type { ShopWriteSession, ShopWriteStorage } from '@/lib/project-shop-session'

const runtime = vi.hoisted(() => ({
  account: '0x1111111111111111111111111111111111111111' as Address | undefined,
  safe: false, receipt: 'pending' as 'pending' | 'confirmed' | 'reverted',
  send: vi.fn(), reset: vi.fn(), read: vi.fn(), prepare: vi.fn(), reverify: vi.fn(),
  inventory: vi.fn(), customers: vi.fn(), metadata: vi.fn(), waitSafe: vi.fn(), viewAs: vi.fn(),
  readSession: vi.fn(), start: vi.fn(), begin: vi.fn(), record: vi.fn(), reject: vi.fn(),
  confirm: vi.fn(), verify: vi.fn(), clear: vi.fn(), restore: vi.fn(), lock: vi.fn(),
  saved: new Map<string, ShopWriteSession>(), client: { getBlock: vi.fn() },
}))

vi.mock('wagmi', () => ({ usePublicClient: () => runtime.client }))
vi.mock('@/hooks/useWallet', () => ({ useWallet: () => ({ address: runtime.account }) }))
vi.mock('@/hooks/useSafeTx', () => ({
  useSafeTx: () => ({ phase: 'idle', busy: false, error: null, isSafe: runtime.safe, send: runtime.send, reset: runtime.reset }),
  txPhaseLabel: (_phase: string, labels: { idle: string }) => labels.idle,
}))
vi.mock('@/lib/viewAs', () => ({ assertNoViewAs: runtime.viewAs }))
vi.mock('@/lib/safe-connector', () => ({ waitForSafeExecutionHash: runtime.waitSafe }))
vi.mock('@/lib/project-shop-write', () => ({
  readProjectShopWriteState: runtime.read,
  prepareProjectShopWrite: runtime.prepare,
  reverifyProjectShopWrite: runtime.reverify,
  projectShopWriteRequest: (plan: PreparedProjectShopWrite, index: number) => plan.requests[index],
}))
vi.mock('@/lib/project-shop-session', () => ({
  shopWriteSessionKey: (chainId: number, projectId: bigint) => `${chainId}:${projectId}`,
  readShopWriteSession: runtime.readSession, startShopWriteSession: runtime.start,
  beginShopWriteSubmission: runtime.begin, recordShopWriteHash: runtime.record,
  rejectShopWriteSubmission: runtime.reject, confirmShopWriteExecution: runtime.confirm,
  verifyShopWriteProgress: runtime.verify, clearShopWriteSession: runtime.clear, withShopWriteLock: runtime.lock,
  restoreShopWritePermissions: runtime.restore,
  shopWriteRequestIndices: (captured: ShopWriteSession) => captured.restoring ? [0, 2] : captured.plan.requests.map((_request, index) => index),
  shopWriteRequestIndex: (captured: ShopWriteSession) => (captured.restoring ? [0, 2] : captured.plan.requests.map((_request, index) => index))[captured.completed.length] ?? null,
}))
vi.mock('@/lib/project-shop', async importOriginal => ({
  ...await importOriginal<typeof import('@/lib/project-shop')>(),
  readProjectShop: runtime.inventory, readShopCustomers: runtime.customers,
}))
vi.mock('@/lib/shop-item-metadata', () => ({ readShopItemMetadata: runtime.metadata }))
vi.mock('@/components/ui/ModalShell', () => ({
  ModalShell: ({ title, children, footer, onClose }: { title: ReactNode; children: ReactNode; footer: ReactNode; onClose: () => void }) =>
    <div role="dialog"><h2>{title}</h2><button onClick={onClose}>Close dialog</button>{children}{footer}</div>,
}))

import { ProjectShop } from '@/components/ProjectShop'

const WALLET = '0x1111111111111111111111111111111111111111' as Address
const OTHER = '0x2222222222222222222222222222222222222222' as Address
const HOOK = '0x3333333333333333333333333333333333333333' as Address
const HASH = `0x${'a'.repeat(64)}` as Hex
const EXECUTION = `0x${'b'.repeat(64)}` as Hex
const DIGEST = `0x${'c'.repeat(64)}` as Hex
const KEY = '8453:7'
const ABI = parseAbi(['function fixtureStep(uint256 projectId, uint256 step)'])
const TIER: Project721Tier = {
  id: 4, price: 25_000_000n, initialSupply: 10, remainingSupply: 7, votingUnits: 0n,
  reserveFrequency: 0, reserveBeneficiary: zeroAddress, encodedIpfsUri: DIGEST, resolvedUri: '', category: 0,
  discountPercent: 0, splitPercent: 0,
  flags: { allowOwnerMint: false, transfersPausable: false, cantBeRemoved: false, cantIncreaseDiscountPercent: false, cantBuyWithCredits: false },
}

function snapshot(overrides: Partial<ProjectShopWriteState> = {}): ProjectShopWriteState {
  return {
    chainId: 8453, projectId: 7n, account: WALLET, owner: WALLET, controller: OTHER, hookOwner: WALLET,
    shop: null, blockNumber: 100n, mode: 'create', pricing: { currency: 2, decimals: 6 }, currency: 'USD', symbol: 'USD',
    canAdd: true, canRemove: false, blockedReason: null, flags: null, maxTierId: 0n, rulesetId: 100,
    identity: 'reviewed-shop', create: null, ...overrides,
  }
}
function plan(state = snapshot(), kinds: PreparedProjectShopWrite['requestKinds'] = ['grant', 'create', 'restore']): PreparedProjectShopWrite {
  return {
    version: 1, snapshot: state, pinned: [], removeTierIds: [], removalIdentity: '', salt: DIGEST,
    requestKinds: kinds,
    requests: kinds.map((kind, index) => ({ chainId: state.chainId, address: HOOK, abi: ABI, functionName: 'fixtureStep', args: [state.projectId, BigInt(index)], label: `${kind} step` })),
    notice: state.mode === 'create' ? 'Create and attach this shop, then restore the previous permissions.' : 'Update the existing shop inventory.',
  }
}
function session(prepared = plan(), overrides: Partial<ShopWriteSession> = {}): ShopWriteSession {
  return { version: 1, id: '11111111-1111-4111-8111-111111111111', plan: prepared, completed: [], ...overrides }
}
function store(key: string, value: ShopWriteSession) { runtime.saved.set(key, value); return value }
function existing(overrides: Partial<ProjectShopWriteState> = {}) {
  const shop: ProjectShopState = {
    hook: HOOK, store: OTHER, metadataIdTarget: HOOK, pricing: { currency: 2, decimals: 6 }, tiers: [TIER],
    blockNumber: 100n, truncated: false, checkoutUrl: 'https://juicebox.money/base:7#shop',
  }
  const state = snapshot({ mode: 'existing', shop, canRemove: true, ...overrides })
  runtime.inventory.mockResolvedValue({ ...shop, pricing: state.pricing })
  runtime.read.mockResolvedValue(state)
  runtime.prepare.mockResolvedValue(plan(state, ['adjust']))
  return state
}

let host: HTMLDivElement
let root: Root
let cache: QueryClient

beforeEach(() => {
  runtime.account = WALLET; runtime.safe = false; runtime.receipt = 'pending'; runtime.saved.clear()
  runtime.read.mockReset().mockResolvedValue(snapshot())
  runtime.prepare.mockReset().mockResolvedValue(plan())
  runtime.reverify.mockReset().mockResolvedValue(undefined)
  runtime.inventory.mockReset().mockResolvedValue(null)
  runtime.customers.mockReset().mockResolvedValue({ items: [], totalCount: 0, nextOffset: null, skipped: 0 })
  runtime.metadata.mockReset().mockResolvedValue({ name: 'Weekend stay', description: 'Two nights in the guest room.', image: null })
  runtime.viewAs.mockReset()
  runtime.waitSafe.mockReset().mockRejectedValue(new Error('Safe has not executed'))
  runtime.client.getBlock.mockReset().mockResolvedValue({ number: 110n })
  runtime.readSession.mockReset().mockImplementation((_storage, key) => runtime.saved.get(key) ?? null)
  runtime.start.mockReset().mockImplementation((_storage, key, prepared) => store(key, session(prepared)))
  runtime.begin.mockReset().mockImplementation((_storage, key, captured, options) => store(key, {
    ...captured, pending: { afterBlock: options.afterBlock.toString(), safe: options.safe, startedAt: Date.now() },
  }))
  runtime.record.mockReset().mockImplementation((_storage, key, captured, hash) => store(key, { ...captured, pending: { ...captured.pending, hash } }))
  runtime.reject.mockReset().mockImplementation((_storage, key, captured) => { const { pending: _pending, ...next } = captured; return store(key, next) })
  runtime.confirm.mockReset().mockImplementation(async (_client: PublicClient, _storage: ShopWriteStorage, key: string, captured: ShopWriteSession, executionHash: Hex) => {
    if (runtime.receipt === 'pending') throw new Error('Transaction receipt is not available yet')
    const { pending, ...previous } = captured
    const next = runtime.receipt === 'reverted' ? previous : { ...previous, completed: [...previous.completed, { submission: pending!, executionHash }] }
    store(key, next)
    runtime.client.getBlock.mockResolvedValue({ number: 112n })
    return { session: next, status: runtime.receipt }
  })
  runtime.verify.mockReset().mockImplementation(async (_client, captured: ShopWriteSession) => captured.completed.length ? 111n : 0n)
  runtime.clear.mockReset().mockImplementation((_storage, key) => runtime.saved.delete(key))
  runtime.restore.mockReset().mockImplementation((_storage, key, captured) => store(key, { ...captured, restoring: true }))
  runtime.lock.mockReset().mockImplementation(async (_key, task) => task())
  runtime.send.mockReset().mockImplementation(async (request: TxRequest, options: TxSendOptions) => {
    await options.reverify?.(request)
    await options.beforeWrite?.()
    expect(runtime.saved.get(KEY)?.pending).toMatchObject({ safe: runtime.safe })
    return HASH
  })
  runtime.reset.mockReset()
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 1 })
  vi.stubGlobal('CSS', { escape: (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, '\\$&') })
  HTMLElement.prototype.scrollIntoView = vi.fn()
  cache = new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 0, gcTime: Infinity } } })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => { await act(async () => root.unmount()); cache.clear(); host.remove() })

async function render(projectId = 7n) {
  await act(async () => root.render(<QueryClientProvider client={cache}><ProjectShop chainId={8453} projectId={projectId} tokenLabel={projectId === 7n ? 'FUND' : 'INCOME'} /></QueryClientProvider>))
}
async function settled(assertion: () => void) {
  await vi.waitFor(async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) }); assertion() }, { timeout: 5000, interval: 10 })
}
function findButton(text: string) { return [...host.querySelectorAll('button')].find(button => button.textContent?.trim() === text) }
async function click(text: string) {
  const button = findButton(text)
  if (!button) throw new Error(`Missing button ${text}: ${host.textContent}`)
  expect(button.disabled).toBe(false)
  await act(async () => button.click())
}
function field(label: string) {
  const element = [...host.querySelectorAll('label')].find(node => node.textContent?.trim() === label)
  if (!element) throw new Error(`Missing field ${label}`)
  return (element.htmlFor ? document.getElementById(element.htmlFor) : element.querySelector('input')) as HTMLInputElement
}
async function input(element: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, value)
    element.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
async function draft(currency = 'USD', price = '25') {
  await render()
  await settled(() => expect(findButton('Add items for sale')?.disabled).toBe(false))
  await click('Add items for sale')
  expect(host.textContent).not.toContain('Shop currency')
  expect(host.querySelector('select option[value="USD"], select option[value="ETH"]')).toBeNull()
  await input(field('Item name'), 'Weekend stay')
  await input(field(`Price (${currency})`), price)
  await act(async () => host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
  expect(host.textContent).toContain('Review shop items')
  expect(runtime.prepare).not.toHaveBeenCalled()
  await click('Continue to transaction')
  await settled(() => expect(findButton('Review transaction')?.disabled).toBe(false))
}
async function reviewNext() {
  await settled(() => expect(findButton('Review transaction')?.disabled).toBe(false))
  await click('Review transaction')
}

describe('live project shop management', () => {
  it('reviews the first items, executes every exact creation step, and only finishes after restoration is confirmed', async () => {
    await draft()
    const prepared: PreparedProjectShopWrite = await runtime.prepare.mock.results[0].value
    expect(host.textContent).toContain('Create your shop')
    expect(runtime.prepare).toHaveBeenCalledWith(runtime.client, expect.objectContaining({ items: [expect.objectContaining({ name: 'Weekend stay', price: '25' })], removeTierIds: [] }))
    expect(runtime.send).not.toHaveBeenCalled()
    runtime.receipt = 'confirmed'
    for (let index = 0; index < 3; index++) {
      await reviewNext()
      await settled(() => expect(runtime.saved.get(KEY)?.completed).toHaveLength(index + 1))
      expect(runtime.send.mock.calls[index][0]).toBe(prepared.requests[index])
      expect(runtime.reverify).toHaveBeenCalledWith(runtime.client, prepared, WALLET, index, prepared.requests[index])
      if (index < 2) expect(findButton('Done')).toBeUndefined()
    }
    await settled(() => expect(host.textContent).toContain('The shop and first items are created.'))
    await click('Done')
    expect(runtime.clear).toHaveBeenCalledOnce()
    expect(runtime.saved.has(KEY)).toBe(false)
    expect(host.querySelector('[role="dialog"]')).toBeNull()
  })

  it('inherits an existing ETH shop currency and precision through the shared item review', async () => {
    const state = existing({ currency: 'ETH', symbol: 'ETH', pricing: { currency: 1, decimals: 18 } })
    await draft('ETH', '0.000000000000000001')
    expect(runtime.prepare).toHaveBeenCalledWith(runtime.client, expect.objectContaining({ snapshot: state, items: [expect.objectContaining({ price: '0.000000000000000001' })] }))
    expect(host.textContent).toContain('Update your shop')
    expect(host.textContent).not.toContain('grant step')
    await reviewNext()
    expect(runtime.send.mock.calls[0][0]).toMatchObject({ address: HOOK, args: [7n, 0n] })
    expect(runtime.saved.get(KEY)?.pending?.hash).toBe(HASH)
    expect(findButton('Done')).toBeUndefined()
  })

  it('can cancel after the temporary permission grant by reviewing only the restoration transaction', async () => {
    const prepared = plan()
    runtime.saved.set(KEY, session(prepared, { completed: [{ submission: { afterBlock: '100', startedAt: Date.now(), safe: false, hash: HASH }, executionHash: HASH }] }))
    runtime.client.getBlock.mockResolvedValue({ number: 112n })
    await render()
    await settled(() => expect(findButton('Resume shop update')).toBeDefined())
    await click('Resume shop update')
    await click('Cancel creation and restore permissions')
    expect(runtime.restore).toHaveBeenCalledOnce()
    expect(runtime.saved.get(KEY)?.restoring).toBe(true)
    expect(host.textContent).toContain('Restore shop permissions')
    expect(host.textContent).not.toContain('create step')
    expect(findButton('Done')).toBeUndefined()
    runtime.receipt = 'confirmed'
    await reviewNext()
    expect(runtime.send.mock.calls[0][0]).toBe(prepared.requests[2])
    expect(runtime.send.mock.calls[0][1].reviewNotice).toContain('Cancel shop creation by restoring')
    expect(runtime.send.mock.calls[0][1].reviewNotice).not.toBe(prepared.notice)
    await settled(() => expect(host.textContent).toContain('The previous permissions have been restored. Shop creation was cancelled.'))
    expect(runtime.saved.get(KEY)?.completed).toHaveLength(2)
    await click('Done')
    expect(runtime.saved.has(KEY)).toBe(false)
  })

  it('loads published item details and reviews a removal without adding or repinning inventory', async () => {
    const state = existing()
    await render()
    await settled(() => expect(host.textContent).toContain('Two nights in the guest room.'))
    expect(host.textContent).toContain('25 USD')
    expect(host.textContent).toContain('7 of 10 remaining')
    expect(host.querySelector('a[href="https://juicebox.money/base:7#shop"]')).not.toBeNull()
    await settled(() => expect(findButton('Remove item #4')?.disabled).toBe(false))
    await click('Remove item #4')
    expect(runtime.prepare).not.toHaveBeenCalled()
    await click('Continue to transaction')
    await settled(() => expect(runtime.prepare).toHaveBeenCalledOnce())
    expect(runtime.prepare).toHaveBeenCalledWith(runtime.client, expect.objectContaining({ snapshot: state, items: [], removeTierIds: [4] }))
    expect(host.textContent).not.toContain('Item name')
  })

  it.each([
    'Connect the project owner or an authorized shop manager to add inventory.',
    'This shop uses an unsupported pricing currency. Manage it on Juicebox.',
  ])('shows the verified management restriction without offering writes: %s', async blockedReason => {
    existing({ canAdd: false, canRemove: false, blockedReason })
    await render()
    await settled(() => expect(host.textContent).toContain(blockedReason))
    expect(findButton('Add items for sale')).toBeUndefined()
    expect(findButton('Remove item #4')).toBeUndefined()
    expect(runtime.prepare).not.toHaveBeenCalled()
    expect(runtime.send).not.toHaveBeenCalled()
  })

  it('keeps public inventory available when management permission reads fail', async () => {
    existing()
    runtime.read.mockRejectedValue(new Error('RPC unavailable'))
    await render()
    await settled(() => expect(host.textContent).toContain('Shop permissions could not be checked.'))
    expect(host.textContent).toContain('Weekend stay')
    expect(findButton('Add items for sale')).toBeUndefined()
    expect(runtime.send).not.toHaveBeenCalled()
  })

  it('preserves an uncertain wallet submission across phase changes and permits only explicit execution recovery', async () => {
    existing()
    runtime.send.mockImplementation(async (request: TxRequest, options: TxSendOptions) => {
      await options.reverify?.(request); await options.beforeWrite?.()
      throw new Error('Wallet connection closed before returning a hash')
    })
    await draft(); await reviewNext()
    await settled(() => expect(host.textContent).toContain('Wallet connection closed before returning a hash'))
    expect(runtime.saved.get(KEY)?.pending).toMatchObject({ afterBlock: '110' })
    expect(runtime.saved.get(KEY)?.pending?.hash).toBeUndefined()
    expect(findButton('Review transaction')).toBeUndefined()
    expect(findButton('Cancel update')).toBeUndefined()
    expect(findButton('Done')).toBeUndefined()
    expect(runtime.reject).not.toHaveBeenCalled()

    await render(9n)
    expect(findButton('Resume shop update')).toBeUndefined()
    await render(7n)
    await settled(() => expect(findButton('Resume shop update')).toBeDefined())
    await click('Resume shop update')
    expect(findButton('Review transaction')).toBeUndefined()
    await input(field('Execution transaction hash'), EXECUTION)
    await click('Check execution')
    expect(host.textContent).toContain('Transaction receipt is not available yet')
    expect(runtime.saved.get(KEY)?.completed).toHaveLength(0)
    runtime.receipt = 'confirmed'
    await click('Check execution')
    await settled(() => expect(findButton('Done')).toBeDefined())
    expect(runtime.saved.get(KEY)?.completed[0].executionHash).toBe(EXECUTION)
    expect(runtime.send).toHaveBeenCalledOnce()
  })

  it('keeps a Safe proposal pending until its onchain execution is verified', async () => {
    const prepared = plan(snapshot({ mode: 'existing' }), ['adjust'])
    runtime.saved.set(KEY, session(prepared, { pending: { safe: true, afterBlock: '110', startedAt: Date.now(), hash: HASH } }))
    await render()
    await settled(() => expect(runtime.waitSafe).toHaveBeenCalledWith(8453, HASH, expect.objectContaining({ signal: expect.any(AbortSignal) })))
    await click('Resume shop update')
    expect(host.textContent).toContain('Proposed to Safe. Execution is required before the next step.')
    expect(findButton('Done')).toBeUndefined()
    expect(runtime.confirm).not.toHaveBeenCalled()
    expect(host.querySelector(`a[href*="${HASH}"]`)).toBeNull()
    runtime.receipt = 'confirmed'
    await input(field('Execution transaction hash'), EXECUTION)
    await click('Check execution')
    await settled(() => expect(host.textContent).toContain('Your inventory changes are confirmed onchain.'))
    expect(runtime.confirm).toHaveBeenCalledWith(runtime.client, localStorage, KEY, expect.objectContaining({ pending: expect.objectContaining({ hash: HASH, safe: true }) }), EXECUTION)
    expect(host.querySelector(`a[href*="${EXECUTION}"]`)).not.toBeNull()
  })

  it('blocks the next reviewed step if the connected account changes', async () => {
    await draft()
    runtime.account = OTHER
    await render()
    await settled(() => expect(host.textContent).toContain(`Connect ${WALLET} to continue this update.`))
    expect(findButton('Review transaction')?.disabled).toBe(true)
    expect(runtime.send).not.toHaveBeenCalled()
  })

  it('rejects a changed project at the final review gate before recording a submission', async () => {
    await draft()
    runtime.reverify.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('Shop permissions changed since review'))
    await reviewNext()
    expect(host.textContent).toContain('Shop permissions changed since review')
    expect(runtime.begin).not.toHaveBeenCalled()
    expect(runtime.saved.get(KEY)?.pending).toBeUndefined()
    expect(findButton('Done')).toBeUndefined()
  })

  it('retains the reviewed draft if view-as protection blocks preparation', async () => {
    await render()
    await settled(() => expect(findButton('Add items for sale')?.disabled).toBe(false))
    await click('Add items for sale')
    await input(field('Item name'), 'Weekend stay')
    await input(field('Price (USD)'), '25')
    await act(async () => host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
    runtime.viewAs.mockImplementation(() => { throw new Error('Writes are unavailable in view-as mode') })
    await click('Continue to transaction')
    expect(host.textContent).toContain('Writes are unavailable in view-as mode')
    expect(runtime.prepare).not.toHaveBeenCalled()
    expect(runtime.start).not.toHaveBeenCalled()
    await click('Back to items')
    expect(field('Item name').value).toBe('Weekend stay')
    expect(field('Price (USD)').value).toBe('25')
  })
})
