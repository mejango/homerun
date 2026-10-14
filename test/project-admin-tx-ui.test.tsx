import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseAbi, type Address, type Hex } from 'viem'
import { WRITE_EXIT_LABEL, writeExitMessage, writeHeldMessage } from '@bananapus/nana-sdk-core/review'
import { createBrowserWriteRecovery } from '@bananapus/nana-sdk-core/review'
import { installRecoveryLocks, recoveryRecords } from './runtime/write-recovery-fixture'
import { noteProjectAdminAccount, projectAdminLockName, projectAdminNamespace } from '@/lib/project-admin-reservation'
import type { TxRequest, TxSendOptions } from '@/hooks/useSafeTx'
import type { ProjectAdminTx } from '@/hooks/useProjectAdminTx'

const OWNER = '0x1111111111111111111111111111111111111111' as Address
const TARGET = '0x2222222222222222222222222222222222222222' as const
const EXECUTION = `0x${'ab'.repeat(32)}` as Hex
const BLOCK_HASH = `0x${'ef'.repeat(32)}` as Hex
const ABI = parseAbi(['function setUriOf(uint256 projectId,string uri)'])

const runtime = vi.hoisted(() => ({
  account: undefined as Address | undefined,
  engine: {} as Record<string, unknown>,
  send: vi.fn(), reset: vi.fn(), dismiss: vi.fn(), reverify: vi.fn(), viewAs: vi.fn(),
  client: { getBlock: vi.fn() },
}))
vi.mock('wagmi', () => ({ usePublicClient: () => runtime.client }))
vi.mock('@/hooks/useWallet', () => ({ useWallet: () => ({ address: runtime.account }) }))
vi.mock('@/hooks/useSafeTx', () => ({ useSafeTx: () => ({
  phase: 'idle', busy: false, error: null, isSafe: false, notice: null, hash: null, submissionHash: null, receipt: null,
  held: null, confirmationUncertain: false, settled: false,
  send: runtime.send, reset: runtime.reset, dismiss: runtime.dismiss, ...runtime.engine,
}) }))
vi.mock('@/lib/viewAs', () => ({ assertNoViewAs: runtime.viewAs }))

import { useProjectAdminTx } from '@/hooks/useProjectAdminTx'
import { ProjectAdminTransactionStatus } from '@/components/ProjectAdminTransactionStatus'

function request(label = 'Save project details'): TxRequest {
  return { chainId: 8453, address: TARGET, abi: ABI, functionName: 'setUriOf', args: [7n, 'ipfs://updated-project'], label }
}

let host: HTMLDivElement
let root: Root
let cache: QueryClient
let handle: ProjectAdminTx
const confirmed = vi.fn()

function Panel({ projectId = 7n }: { projectId?: bigint }) {
  const tx = useProjectAdminTx({ chainId: 8453, projectId, onConfirmed: confirmed })
  handle = tx
  return <section>
    <button disabled={!tx.ready || tx.busy} onClick={() => void tx.send(request(), { reviewedAccount: OWNER, reverify: runtime.reverify })}>Save</button>
    <ProjectAdminTransactionStatus tx={tx} />
  </section>
}
async function render(projectId = 7n) {
  await act(async () => root.render(<QueryClientProvider client={cache}><Panel projectId={projectId} /></QueryClientProvider>))
}
const button = (text: string) => [...host.querySelectorAll('button')].find(node => node.textContent === text)

beforeEach(() => {
  localStorage.clear(); installRecoveryLocks()
  runtime.account = OWNER; runtime.engine = {}
  for (const mock of [runtime.reset, runtime.dismiss, runtime.viewAs, confirmed]) mock.mockReset()
  runtime.reverify.mockReset().mockResolvedValue(undefined)
  runtime.client.getBlock.mockReset().mockResolvedValue({ number: 100n, hash: BLOCK_HASH })
  for (const name of ['getChainId', 'getTransaction', 'getTransactionReceipt', 'getTransactionCount'] as const) (runtime.client as Record<string, ReturnType<typeof vi.fn>>)[name] = vi.fn(async () => { throw new Error('unknown') })
  runtime.send.mockReset().mockImplementation(async (reviewed: TxRequest, options: TxSendOptions) => {
    await options.reverify?.(reviewed)
    await options.beforeWrite?.()
    return EXECUTION
  })
  cache = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => { await act(async () => root.unmount()); cache.clear(); host.remove() })

describe('project administrative writes', () => {
  it('hold the whole project under one name and send as the account the editor reviewed for', async () => {
    await render()
    await act(async () => button('Save')!.click())
    expect(runtime.send).toHaveBeenCalledWith(request(), expect.objectContaining({
      reviewedAccount: OWNER, recoveryNamespace: 'homerun:project-admin:7',
    }))
    expect(runtime.reverify).toHaveBeenCalledOnce()
    expect(runtime.viewAs).toHaveBeenCalled()
  })

  it('refuse a request for another network, and a missing recheck', async () => {
    await render()
    await act(async () => { await handle.send({ ...request(), chainId: 10 }, { reviewedAccount: OWNER, reverify: runtime.reverify }) })
    expect(handle.error).toBe('This update belongs to a different network.')
    await act(async () => { await handle.send(request(), { reviewedAccount: OWNER } as never) })
    expect(handle.error).toMatch(/Recheck project permissions/)
    expect(runtime.send).not.toHaveBeenCalled()
  })

  it('wait for the network to reach the last confirmed update before sending another', async () => {
    cache.setQueryData(['project-admin-confirmed-block', 8453, '7'], 120n)
    await render()
    await act(async () => { await handle.send(request(), { reviewedAccount: OWNER, reverify: runtime.reverify }) })
    expect(handle.error).toMatch(/has not reached the last confirmed project update/)
    expect(runtime.reverify).not.toHaveBeenCalled()
  })

  it('refresh what the editors read once, when the update confirms', async () => {
    const invalidate = vi.spyOn(cache, 'invalidateQueries')
    runtime.engine = { phase: 'success', hash: EXECUTION, receipt: { transactionHash: EXECUTION, blockNumber: 105n } }
    await render()
    await vi.waitFor(() => expect(confirmed).toHaveBeenCalledOnce())
    expect(invalidate).toHaveBeenCalled()
    expect(cache.getQueryData(['project-admin-confirmed-block', 8453, '7'])).toBe(105n)
    await render()
    expect(confirmed).toHaveBeenCalledOnce()
    expect(host.textContent).toContain('Project update confirmed.')
  })

  it('show a held write with its one line and its exit', async () => {
    const release = vi.fn()
    runtime.engine = {
      phase: 'submitted', notice: writeHeldMessage(), confirmationUncertain: true,
      held: { line: writeHeldMessage(), warning: writeExitMessage({ to: TARGET, data: '0x', value: 0n }), label: WRITE_EXIT_LABEL, release },
    }
    await render()
    expect(host.textContent).toContain(writeHeldMessage())
    await act(async () => button(WRITE_EXIT_LABEL)!.click())
    expect(release).toHaveBeenCalledOnce()
  })

  it('keep following a write that is still confirming when its review closes', async () => {
    runtime.engine = { phase: 'pending', busy: true }
    await render()
    await act(async () => handle.dismiss())
    expect(runtime.dismiss).not.toHaveBeenCalled()
    runtime.engine = { phase: 'submitted', confirmationUncertain: true }
    await render()
    await act(async () => handle.dismiss())
    expect(runtime.dismiss).toHaveBeenCalledOnce()
  })

  it('adopt an editor record from before the SDK journal before any write is enabled', async () => {
    localStorage.setItem('homerun:project-admin:pending:v1:8453:7', JSON.stringify({
      version: 1, id: '11111111-1111-4111-8111-111111111111', chainId: 8453, projectId: '7', holder: OWNER, target: TARGET,
      data: '0x12345678', value: '0', label: 'Save', safe: false, submittedAt: 1, afterBlock: '5', hash: EXECUTION,
    }))
    await render()
    await vi.waitFor(() => expect(handle.ready).toBe(true))
    expect(recoveryRecords()).toEqual([expect.objectContaining({ account: OWNER, hash: EXECUTION, call: { to: TARGET, data: '0x12345678', value: '0' } })])
    expect(localStorage.getItem('homerun:project-admin:pending:v1:8453:7')).toBeNull()
  })

  it('stay unready, with the reason, while an old record cannot be read', async () => {
    localStorage.setItem('homerun:project-admin:pending:v1:8453:7', '{not json')
    await render()
    await vi.waitFor(() => expect(handle.error).toMatch(/could not be read/))
    expect(handle.ready).toBe(false)
    await act(async () => { await handle.send(request(), { reviewedAccount: OWNER, reverify: runtime.reverify }) })
    expect(runtime.send).not.toHaveBeenCalled()
  })

  it('hold a second authorized wallet while the first wallet’s update is unresolved, until its exit', async () => {
    const first = '0x3333333333333333333333333333333333333333' as Address
    const journal = createBrowserWriteRecovery({ chainId: 8453, account: first, safe: false, namespace: projectAdminNamespace(7n),
      call: { to: TARGET, data: '0x12345678', value: 0n } })
    await journal.withLock(async () => { journal.reserve() })
    noteProjectAdminAccount(localStorage, 8453, 7n, first)
    await render()
    await vi.waitFor(() => expect(handle.ready).toBe(true))
    await act(async () => { await handle.send(request(), { reviewedAccount: OWNER, reverify: runtime.reverify }) })
    expect(runtime.send).not.toHaveBeenCalled()
    expect(handle.phase).toBe('submitted')
    expect(handle.held).toMatchObject({ label: expect.stringContaining('I checked my wallet') })
    await act(async () => handle.held!.release())
    expect(handle.held).toBeNull()
    await act(async () => { await handle.send(request(), { reviewedAccount: OWNER, reverify: runtime.reverify }) })
    expect(runtime.send).toHaveBeenCalledOnce()
  })

  it('never offers the exit for another wallet’s update whose hash is still pending', async () => {
    const first = '0x3333333333333333333333333333333333333333' as Address
    const journal = createBrowserWriteRecovery({ chainId: 8453, account: first, safe: false, namespace: projectAdminNamespace(7n),
      call: { to: TARGET, data: '0x12345678', value: 0n } })
    await journal.withLock(async () => { journal.reserve(undefined, { nonce: 5, blockNumber: 90n }); journal.submitted(EXECUTION) })
    noteProjectAdminAccount(localStorage, 8453, 7n, first)
    ;(runtime.client as Record<string, unknown>).getTransaction = vi.fn(async () => ({ hash: EXECUTION, blockNumber: null }))
    await render()
    await vi.waitFor(() => expect(handle.ready).toBe(true))
    await act(async () => { await handle.send(request(), { reviewedAccount: OWNER, reverify: runtime.reverify }) })
    expect(runtime.send).not.toHaveBeenCalled()
    expect(handle.notice).toBe('Still pending in your wallet. Speed it up or cancel it there.')
    expect(handle.held).toBeNull()
  })

  async function foreignHold() {
    const first = '0x3333333333333333333333333333333333333333' as Address
    const journal = createBrowserWriteRecovery({ chainId: 8453, account: first, safe: false, namespace: projectAdminNamespace(7n), call: { to: TARGET, data: '0x12345678', value: 0n } })
    await journal.withLock(async () => { journal.reserve() })
    noteProjectAdminAccount(localStorage, 8453, 7n, first)
    return { journal, first }
  }

  it('check the project and reserve under one lock per chain and project', async () => {
    await render()
    await vi.waitFor(() => expect(handle.ready).toBe(true))
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    const taking = navigator.locks.request(projectAdminLockName(8453, 7n), { mode: 'exclusive' }, () => held)
    await act(async () => { await handle.send(request(), { reviewedAccount: OWNER, reverify: runtime.reverify }) })
    expect(runtime.send).not.toHaveBeenCalled()
    expect(handle.error).toMatch(/another tab/i)
    release(); await taking
    await act(async () => { await handle.send(request(), { reviewedAccount: OWNER, reverify: runtime.reverify }) })
    expect(runtime.send).toHaveBeenCalledOnce()
  })

  it('check the project again right before the wallet opens', async () => {
    await render()
    await vi.waitFor(() => expect(handle.ready).toBe(true))
    runtime.send.mockImplementation(async (reviewed: TxRequest, options: TxSendOptions) => {
      await options.reverify?.(reviewed)
      await foreignHold()
      await options.beforeWrite?.()
      return EXECUTION
    })
    await act(async () => { await handle.send(request(), { reviewedAccount: OWNER, reverify: runtime.reverify }) })
    expect(handle.error).toMatch(/another wallet/i)
  })

  it('watch the displayed hold and clear it when its chain proof changes', async () => {
    vi.useFakeTimers()
    try {
      const { journal } = await foreignHold()
      await render()
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })
      await act(async () => { await handle.send(request(), { reviewedAccount: OWNER, reverify: runtime.reverify }) })
      expect(handle.held).not.toBeNull()
      await act(async () => { journal.abandon(journal.read()!, { checkedWallet: true }) })
      await act(async () => { await vi.advanceTimersByTimeAsync(15_000) })
      expect(handle.held).toBeNull()
      expect(handle.phase).toBe('idle')
    } finally { vi.useRealTimers() }
  })

  it('show another tab ending the displayed hold at once, without waiting for the next look', async () => {
    vi.useFakeTimers()
    try {
      const { journal } = await foreignHold()
      await render()
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })
      await act(async () => { await handle.send(request(), { reviewedAccount: OWNER, reverify: runtime.reverify }) })
      expect(handle.held).not.toBeNull()
      // Another tab takes the exit: the browser tells this one through a storage event.
      await act(async () => {
        journal.abandon(journal.read()!, { checkedWallet: true })
        window.dispatchEvent(new StorageEvent('storage', { key: 'nana-sdk:reviewed-write:other-tab' }))
        await vi.advanceTimersByTimeAsync(0)
      })
      expect(handle.held).toBeNull()
      expect(handle.phase).toBe('idle')
    } finally { vi.useRealTimers() }
  })

  it('shows the exit of another wallet\'s update once a check offers it, after the first look found the hold contended', async () => {
    vi.useFakeTimers()
    const { holds } = await import('@/lib/write-hold')
    const open = holds.open
    let looks = 0
    // The first look runs while another tab holds the lock: the same state, but with no exit.
    const spy = vi.spyOn(holds, 'open').mockImplementation((...args: Parameters<typeof open>) => {
      const handle = open(...args)
      return { ...handle, state: async (...state: Parameters<typeof handle.state>) => {
        const now = await handle.state(...state)
        return (looks += 1) === 1 && now.status !== 'clear' ? { ...now, exit: false } : now
      } }
    })
    try {
      await foreignHold()
      await render()
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })
      await act(async () => { await handle.send(request(), { reviewedAccount: OWNER, reverify: runtime.reverify }) })
      expect(handle.phase).toBe('submitted')
      // The watch's own next look is not contended: the exit appears.
      await act(async () => { await vi.advanceTimersByTimeAsync(15_000) })
      expect(looks).toBeGreaterThan(1)
      expect(handle.held).toMatchObject({ label: expect.stringContaining('I checked my wallet') })
      expect(button('I checked my wallet. Send again')).toBeDefined()
    } finally { spy.mockRestore(); vi.useRealTimers() }
  })

  it('register the account when an existing Safe proposal is adopted, under the project lock', async () => {
    await render()
    await vi.waitFor(() => expect(handle.ready).toBe(true))
    runtime.send.mockImplementation(async (reviewed: TxRequest, options: TxSendOptions) => {
      await options.reverify?.(reviewed)
      await options.onExistingProposal?.({ proposalHash: EXECUTION, call: { to: TARGET, data: '0x12345678', value: 0n } })
      return EXECUTION
    })
    await act(async () => { await handle.send(request(), { reviewedAccount: OWNER, reverify: runtime.reverify }) })
    expect(JSON.parse(localStorage.getItem('homerun:project-admin:accounts:v1:8453:7')!)).toEqual([OWNER.toLowerCase()])
  })
})

