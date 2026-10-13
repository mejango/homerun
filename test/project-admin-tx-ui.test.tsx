import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseAbi, type Address, type Hex } from 'viem'
import { WRITE_EXIT_LABEL, writeExitMessage, writeHeldMessage } from '@bananapus/nana-sdk-core/review'
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
  runtime.account = OWNER; runtime.engine = {}
  for (const mock of [runtime.reset, runtime.dismiss, runtime.viewAs, confirmed]) mock.mockReset()
  runtime.reverify.mockReset().mockResolvedValue(undefined)
  runtime.client.getBlock.mockReset().mockResolvedValue({ number: 100n, hash: BLOCK_HASH })
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
      reviewedAccount: OWNER, recoveryNamespace: 'homerun:project-admin:7', action: 'project update',
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
      phase: 'submitted', notice: writeHeldMessage('project update'), confirmationUncertain: true,
      held: { line: writeHeldMessage('project update'), warning: writeExitMessage({ to: TARGET, data: '0x', value: 0n }, 'project update'), label: WRITE_EXIT_LABEL, release },
    }
    await render()
    expect(host.textContent).toContain(writeHeldMessage('project update'))
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
})
