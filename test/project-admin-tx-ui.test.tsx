import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { encodeAbiParameters, encodeEventTopics, encodeFunctionData, parseAbi, zeroAddress, type Address, type Hex } from 'viem'
import type { TxRequest, TxSendOptions } from '@/hooks/useSafeTx'
import type { ProjectAdminTx } from '@/hooks/useProjectAdminTx'

const runtime = vi.hoisted(() => ({
  account: '0x1111111111111111111111111111111111111111' as Address | undefined,
  safe: false, phase: 'idle', send: vi.fn(), reset: vi.fn(), reverify: vi.fn(), waitSafe: vi.fn(), viewAs: vi.fn(),
  client: { getBlock: vi.fn(), getChainId: vi.fn(), getTransaction: vi.fn(), getTransactionReceipt: vi.fn() },
}))
vi.mock('wagmi', () => ({ usePublicClient: () => runtime.client }))
vi.mock('@/hooks/useWallet', () => ({ useWallet: () => ({ address: runtime.account }) }))
vi.mock('@/hooks/useSafeTx', () => ({ useSafeTx: () => ({
  phase: runtime.phase, busy: false, error: null, isSafe: runtime.safe, send: runtime.send, reset: runtime.reset,
}) }))
vi.mock('@/lib/safe-connector', () => ({ waitForSafeExecutionHash: runtime.waitSafe }))
vi.mock('@/lib/viewAs', () => ({ assertNoViewAs: runtime.viewAs }))

import { useProjectAdminTx } from '@/hooks/useProjectAdminTx'
import { ProjectAdminTransactionStatus } from '@/components/ProjectAdminTransactionStatus'
import { projectAdminSessionKey, readProjectAdminPending } from '@/lib/project-admin-session'

const OWNER = '0x1111111111111111111111111111111111111111' as const
const TARGET = '0x2222222222222222222222222222222222222222' as const
const EXECUTION = `0x${'ab'.repeat(32)}` as Hex
const PROPOSAL = `0x${'cd'.repeat(32)}` as Hex
const BLOCK_HASH = `0x${'ef'.repeat(32)}` as Hex
const OTHER_HASH = `0x${'12'.repeat(32)}` as Hex
const KEY = projectAdminSessionKey(8453, 7n)
const ABI = parseAbi(['function setUriOf(uint256 projectId,string uri)'])
const SAFE_ABI = parseAbi([
  'function execTransaction(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,bytes signatures) payable returns (bool success)',
  'event ExecutionSuccess(bytes32 txHash,uint256 payment)',
])

function request(label = 'Save project details'): TxRequest {
  return { chainId: 8453, address: TARGET, abi: ABI, functionName: 'setUriOf', args: [7n, 'ipfs://updated-project'], label }
}

let host: HTMLDivElement
let root: Root
let cache: QueryClient
const handles = new Map<string, ProjectAdminTx>()
const callbacks = new Map<string, ReturnType<typeof vi.fn>>()

function Panel({ feature, projectId = 7n }: { feature: string; projectId?: bigint }) {
  const tx = useProjectAdminTx({ chainId: 8453, projectId, onConfirmed: callbacks.get(feature) })
  handles.set(feature, tx)
  return <section data-feature={feature}>
    <button disabled={!tx.ready || tx.busy} onClick={() => void tx.send(request(feature), { reverify: runtime.reverify })}>{feature}</button>
    <output data-phase>{tx.phase}</output>
    <ProjectAdminTransactionStatus tx={tx} />
  </section>
}

beforeEach(() => {
  localStorage.clear(); handles.clear(); callbacks.clear()
  runtime.account = OWNER; runtime.safe = false; runtime.phase = 'idle'
  runtime.reset.mockReset()
  runtime.reverify.mockReset().mockResolvedValue(undefined)
  runtime.viewAs.mockReset()
  runtime.waitSafe.mockReset().mockRejectedValue(new Error('Safe proposal has not executed'))
  runtime.client.getChainId.mockReset().mockResolvedValue(8453)
  runtime.client.getBlock.mockReset().mockResolvedValue({ number: 100n, hash: BLOCK_HASH })
  runtime.client.getTransaction.mockReset().mockRejectedValue(new Error('Transaction has not been mined'))
  runtime.client.getTransactionReceipt.mockReset().mockRejectedValue(new Error('Transaction receipt is not available'))
  const held = new Set<string>()
  vi.stubGlobal('navigator', { locks: { request: vi.fn(async (key: string, options: unknown, task: (lock: object | null) => Promise<unknown>) => {
    expect(options).toEqual({ mode: 'exclusive', ifAvailable: true })
    if (held.has(key)) return task(null)
    held.add(key)
    try { return await task({ name: key }) } finally { held.delete(key) }
  }) } })
  runtime.send.mockReset().mockImplementation(async (reviewed: TxRequest, options: TxSendOptions) => {
    await options.reverify?.(reviewed)
    await options.beforeWrite?.()
    // This is the mocked wallet boundary: the real journal must already exist.
    expect(readProjectAdminPending(localStorage, KEY)).toMatchObject({
      holder: OWNER, target: TARGET, data: encodeFunctionData(reviewed), afterBlock: '100', safe: runtime.safe,
    })
    return runtime.safe ? PROPOSAL : EXECUTION
  })
  cache = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => { await act(async () => root.unmount()); cache.clear(); host.remove(); localStorage.clear() })

async function render(features = ['Metadata'], projectId = 7n) {
  await act(async () => root.render(<QueryClientProvider client={cache}>{features.map(feature => <Panel key={`${feature}:${projectId}`} feature={feature} projectId={projectId} />)}</QueryClientProvider>))
}
async function settle(assertion: () => void) {
  await vi.waitFor(async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) }); assertion() }, { timeout: 5000, interval: 10 })
}
function panel(feature = 'Metadata') { return host.querySelector<HTMLElement>(`[data-feature="${feature}"]`)! }
function button(text: string, feature = 'Metadata') {
  const found = [...panel(feature).querySelectorAll('button')].find(node => node.textContent === text)
  if (!found) throw new Error(`Missing ${text}: ${host.textContent}`)
  return found
}
async function click(text: string, feature = 'Metadata') {
  expect(button(text, feature).disabled).toBe(false)
  await act(async () => button(text, feature).click())
}
async function recover(hash = EXECUTION, feature = 'Metadata') {
  const field = panel(feature).querySelector('input')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, hash)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await click('Check execution', feature)
}
function canonicalExecution({ safe = false, wrongPayload = false, reverted = false, proposal = PROPOSAL }: { safe?: boolean; wrongPayload?: boolean; reverted?: boolean; proposal?: Hex } = {}) {
  const saved = readProjectAdminPending(localStorage, KEY)!
  const data = wrongPayload ? '0x12345678' : saved.data
  runtime.client.getTransaction.mockResolvedValue({
    hash: EXECUTION, from: OWNER, to: safe ? OWNER : TARGET, value: 0n,
    input: safe ? encodeFunctionData({ abi: SAFE_ABI, functionName: 'execTransaction', args: [TARGET, 0n, data, 0, 0n, 0n, 0n, zeroAddress, zeroAddress, '0x'] }) : data,
    blockNumber: 101n, blockHash: BLOCK_HASH,
  })
  runtime.client.getTransactionReceipt.mockResolvedValue({
    transactionHash: EXECUTION, status: reverted ? 'reverted' : 'success', blockNumber: 101n, blockHash: BLOCK_HASH,
    logs: safe ? [{ address: OWNER, topics: encodeEventTopics({ abi: SAFE_ABI, eventName: 'ExecutionSuccess' }), data: encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint256' }], [proposal, 0n]) }] : [],
  })
}

describe('project administrative transaction recovery', () => {
  it('persists the exact reviewed call before wallet submission and keeps a returned hash pending', async () => {
    await render()
    await click('Metadata')
    expect(runtime.reverify).toHaveBeenCalledWith(request('Metadata'))
    const saved = readProjectAdminPending(localStorage, KEY)
    expect(saved).toMatchObject({ label: 'Metadata', hash: EXECUTION, afterBlock: '100' })
    expect(localStorage.getItem(KEY)).not.toMatch(/"abi"|"request"|"functionName"|"args"/)
    expect(button('Metadata').disabled).toBe(true)
    expect(panel().querySelector('[data-phase]')?.textContent).toBe('pending')
    expect(panel().textContent).toContain('Metadata is pending.')
    expect(panel().querySelector(`a[href*="${EXECUTION}"]`)).not.toBeNull()
    expect(button('Check execution').disabled).toBe(true)
  })

  it('restores an unknown wallet broadcast after remount and blocks every editor for that project', async () => {
    runtime.send.mockImplementation(async (reviewed: TxRequest, options: TxSendOptions) => {
      await options.reverify?.(reviewed); await options.beforeWrite?.()
      throw new Error('Wallet closed without returning a hash')
    })
    await render(); await click('Metadata')
    const original = localStorage.getItem(KEY)
    expect(readProjectAdminPending(localStorage, KEY)?.hash).toBeUndefined()
    expect(panel().textContent).toContain('Wallet closed without returning a hash')
    await act(async () => root.unmount())
    root = createRoot(host)
    await render(['Ownership', 'Permissions'])
    for (const feature of ['Ownership', 'Permissions']) {
      expect(button(feature, feature).disabled).toBe(true)
      expect(panel(feature).textContent).toContain('Metadata is pending.')
    }
    await act(async () => { await handles.get('Ownership')!.send(request('Ownership'), { reverify: runtime.reverify }) })
    expect(runtime.send).toHaveBeenCalledOnce()
    expect(localStorage.getItem(KEY)).toBe(original)
    expect(panel('Ownership').textContent).toContain('already be pending')

    await render(['Metadata'], 9n)
    expect(button('Metadata').disabled).toBe(false)
    await render()
    expect(button('Metadata').disabled).toBe(true)
  })

  it.each(['onWriteRejected', 'onBeforeWriteAborted'] as const)('releases only explicitly rejected or aborted submissions via %s', async callback => {
    runtime.send.mockImplementation(async (reviewed: TxRequest, options: TxSendOptions) => {
      await options.reverify?.(reviewed); await options.beforeWrite?.()
      expect(readProjectAdminPending(localStorage, KEY)).not.toBeNull()
      await options[callback]?.()
      return null
    })
    await render(); await click('Metadata')
    expect(readProjectAdminPending(localStorage, KEY)).toBeNull()
    expect(button('Metadata').disabled).toBe(false)
    expect(panel().textContent).not.toContain('is pending')
  })

  it('uses a canonical matching execution to recover an unknown broadcast and refresh authoritative queries', async () => {
    const confirmed = vi.fn()
    const otherConfirmed = vi.fn()
    callbacks.set('Metadata', confirmed)
    callbacks.set('Ownership', otherConfirmed)
    runtime.send.mockImplementation(async (_reviewed: TxRequest, options: TxSendOptions) => { await options.beforeWrite?.(); return null })
    for (const prefix of ['project-metadata', 'income-operator', 'project-permissions', 'project-ownership', 'project-splits', 'project-admin-custom', 'unrelated']) cache.setQueryData([prefix, 8453, '7'], 'cached')
    await render(['Metadata', 'Ownership']); await click('Metadata')
    canonicalExecution({ wrongPayload: true })
    await recover(EXECUTION, 'Ownership')
    expect(panel('Ownership').textContent).toContain('does not match the saved project update transaction')
    expect(readProjectAdminPending(localStorage, KEY)).not.toBeNull()
    expect(confirmed).not.toHaveBeenCalled()
    canonicalExecution()
    await click('Check execution', 'Ownership')
    await settle(() => expect(confirmed).toHaveBeenCalledOnce())
    expect(readProjectAdminPending(localStorage, KEY)).toBeNull()
    expect(button('Metadata').disabled).toBe(false)
    expect(panel().querySelector('[data-phase]')?.textContent).toBe('success')
    expect(panel().textContent).toContain('Metadata confirmed.')
    expect(panel('Ownership').textContent).toContain('Metadata confirmed.')
    expect(otherConfirmed).not.toHaveBeenCalled()
    expect(cache.getQueryData(['project-admin-confirmed-block', 8453, '7'])).toBe(101n)
    expect(cache.getQueryState(['project-admin-confirmed-block', 8453, '7'])?.isInvalidated).toBe(false)
    for (const prefix of ['project-metadata', 'income-operator', 'project-permissions', 'project-ownership', 'project-splits', 'project-admin-custom']) expect(cache.getQueryState([prefix, 8453, '7'])?.isInvalidated).toBe(true)
    expect(cache.getQueryState(['unrelated', 8453, '7'])?.isInvalidated).toBe(false)
    expect(runtime.send).toHaveBeenCalledOnce()
  })

  it('shares the review lock across independently mounted feature hooks before any pending record exists', async () => {
    let release!: () => void
    const review = new Promise<void>(resolve => { release = resolve })
    runtime.send.mockImplementation(async (_reviewed: TxRequest, options: TxSendOptions) => { await review; await options.beforeWrite?.(); return EXECUTION })
    await render(['Metadata', 'Permissions'])
    await act(async () => button('Metadata').click())
    expect(localStorage.getItem(KEY)).toBeNull()
    await click('Permissions', 'Permissions')
    expect(panel('Permissions').textContent).toContain('being reviewed or submitted in another tab')
    expect(runtime.send).toHaveBeenCalledOnce()
    await act(async () => release())
    await settle(() => expect(button('Permissions', 'Permissions').disabled).toBe(true))
    expect(panel('Permissions').textContent).toContain('Metadata is pending.')
  })

  it('keeps Safe proposals pending despite a provider success phase and verifies the exact executed proposal', async () => {
    runtime.safe = true
    await render(); await click('Metadata')
    await settle(() => expect(runtime.waitSafe).toHaveBeenCalledWith(8453, PROPOSAL, expect.objectContaining({ signal: expect.any(AbortSignal) })))
    runtime.phase = 'success'
    await render()
    expect(panel().querySelector('[data-phase]')?.textContent).toBe('pending')
    expect(panel().textContent).toContain('Check Safe for signatures and execution.')
    expect(panel().querySelector(`a[href*="${PROPOSAL}"]`)).toBeNull()
    expect(runtime.client.getTransactionReceipt).not.toHaveBeenCalled()

    canonicalExecution({ safe: true, proposal: OTHER_HASH })
    await recover()
    expect(panel().textContent).toContain('does not match the saved proposal hash')
    expect(readProjectAdminPending(localStorage, KEY)?.hash).toBe(PROPOSAL)
    canonicalExecution({ safe: true })
    await click('Check execution')
    await settle(() => expect(panel().textContent).toContain('Metadata confirmed.'))
    expect(readProjectAdminPending(localStorage, KEY)).toBeNull()
    expect(panel().querySelector(`a[href*="${EXECUTION}"]`)).not.toBeNull()
  })

  it('releases a verified direct revert without reporting success or calling completion callbacks', async () => {
    const confirmed = vi.fn(); callbacks.set('Metadata', confirmed)
    await render(); await click('Metadata')
    canonicalExecution({ reverted: true })
    await recover()
    expect(readProjectAdminPending(localStorage, KEY)).toBeNull()
    expect(panel().textContent).toContain('Metadata reverted onchain.')
    expect(panel().querySelector('[data-phase]')?.textContent).toBe('error')
    expect(confirmed).not.toHaveBeenCalled()
    expect(cache.getQueryData(['project-admin-confirmed-block', 8453, '7'])).toBeUndefined()
    expect(button('Metadata').disabled).toBe(false)
  })

  it('fails before a wallet write when reviewed calldata changes or recovery storage is corrupt', async () => {
    runtime.reverify.mockImplementation(async (reviewed: TxRequest) => { reviewed.args = [7n, 'ipfs://unreviewed'] })
    await render(); await click('Metadata')
    expect(panel().textContent).toContain('changed during review')
    expect(localStorage.getItem(KEY)).toBeNull()
    expect(runtime.client.getBlock).toHaveBeenCalledOnce()
    localStorage.setItem(KEY, '{broken')
    await act(async () => window.dispatchEvent(new StorageEvent('storage', { key: KEY, newValue: '{broken' })))
    expect(button('Metadata').disabled).toBe(true)
    expect(panel().textContent).toContain('recovery data is unreadable')
    expect(runtime.send).toHaveBeenCalledOnce()
  })

  it.each([
    { scenario: 'the RPC is already behind the last confirmed update', floor: 101n, beforeWrite: 100n, advanceFloor: false, reverifications: 0 },
    { scenario: 'the RPC regresses after revalidation', floor: 100n, beforeWrite: 99n, advanceFloor: false, reverifications: 1 },
    { scenario: 'another update confirms during revalidation', floor: 100n, beforeWrite: 100n, advanceFloor: true, reverifications: 1 },
  ])('stops before persisting or signing when $scenario', async ({ floor, beforeWrite, advanceFloor, reverifications }) => {
    const walletWrite = vi.fn(async () => EXECUTION)
    cache.setQueryData(['project-admin-confirmed-block', 8453, '7'], floor)
    runtime.client.getBlock.mockResolvedValueOnce({ number: 100n, hash: BLOCK_HASH }).mockResolvedValue({ number: beforeWrite, hash: BLOCK_HASH })
    if (advanceFloor) runtime.reverify.mockImplementation(async () => { cache.setQueryData(['project-admin-confirmed-block', 8453, '7'], 101n) })
    runtime.send.mockImplementation(async (reviewed: TxRequest, options: TxSendOptions) => {
      await options.reverify?.(reviewed)
      await options.beforeWrite?.()
      return walletWrite()
    })
    await render(); await click('Metadata')
    expect(panel().textContent).toContain('The network has not reached the last confirmed project update. Wait for it to catch up before submitting another update.')
    expect(runtime.reverify).toHaveBeenCalledTimes(reverifications)
    expect(walletWrite).not.toHaveBeenCalled()
    expect(readProjectAdminPending(localStorage, KEY)).toBeNull()
    expect(button('Metadata').disabled).toBe(false)
    expect(panel().textContent).not.toContain('Metadata is pending.')
  })
})
