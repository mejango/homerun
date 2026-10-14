import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type Address } from 'viem'
const mocks = vi.hoisted(() => ({ address: '0x1111111111111111111111111111111111111111' as Address | undefined, factory: vi.fn(), rows: vi.fn(), verify: vi.fn(), send: vi.fn(), open: vi.fn(), reset: vi.fn(), track: vi.fn(), safe: false, phase: 'idle', receipt: null as null | { transactionHash: string }, waitSafe: vi.fn(), getReceipt: vi.fn(), getBlockNumber: vi.fn() }))
vi.mock('@/hooks/useWallet', () => ({ useWallet: () => ({ address: mocks.address, openSignIn: mocks.open }) }))
vi.mock('@/hooks/useSafeTx', () => ({ txPhaseLabel: (_: string, labels: { idle: string }) => labels.idle, useSafeTx: () => ({ phase: mocks.phase, receipt: mocks.receipt, hash: mocks.receipt?.transactionHash ?? null, submissionHash: mocks.receipt?.transactionHash ?? null, busy: false, error: null, notice: null, held: null, isSafe: mocks.safe, send: mocks.send, reset: mocks.reset, track: mocks.track }) }))
vi.mock('wagmi', () => ({ usePublicClient: () => ({ getTransactionReceipt: mocks.getReceipt, getBlockNumber: mocks.getBlockNumber }) }))
vi.mock('@/lib/safe-connector', () => ({ waitForSafeExecutionHash: mocks.waitSafe }))
vi.mock('@/lib/project-payers', async importOriginal => ({ ...await importOriginal<typeof import('../src/lib/project-payers')>(), checkPayerFactory: mocks.factory, getProjectPayerAddresses: mocks.rows, verifyPayerReceipt: mocks.verify }))
import { ProjectPayerAddresses } from '../src/components/ProjectPayerAddresses'
import { payerAttemptKey, payerIntent, type PayerAttempt } from '../src/lib/project-payers'
const HASH = `0x${'aa'.repeat(32)}`, PAYER = '0x2222222222222222222222222222222222222222', KEY = payerAttemptKey(1, 7n)
function saved(): PayerAttempt { return { version: 1, settings: { chainId: 1, projectId: '7', beneficiary: '0x0000000000000000000000000000000000000000', owner: '0x0000000000000000000000000000000000000000', memo: '', addToBalance: false }, account: '0x1111111111111111111111111111111111111111', safe: false, phase: 'signing', afterBlock: '100' } }
describe('project payer controls', () => {
  let client: QueryClient, root: Root, host: HTMLDivElement
  beforeEach(() => {
    localStorage.clear(); vi.clearAllMocks()
    Object.defineProperty(navigator, 'locks', { configurable: true, value: { request: async (_name: string, _options: unknown, task: (lock: object) => Promise<unknown>) => task({}) } })
    mocks.address = saved().account; mocks.safe = false
    mocks.factory.mockResolvedValue({ acceptsNative: true }); mocks.rows.mockResolvedValue([])
    mocks.getReceipt.mockRejectedValue(new Error('Transaction pending')); mocks.waitSafe.mockRejectedValue(new Error('Safe not yet executed')); mocks.getBlockNumber.mockResolvedValue(100n)
    mocks.verify.mockResolvedValue({ status: 'confirmed', payer: PAYER })
    mocks.phase = 'idle'; mocks.receipt = null
    mocks.send.mockImplementation(async (_request, options) => { await options.reverify(); return HASH })
    client = new QueryClient({ defaultOptions: { queries: { staleTime: 30_000, retry: false, retryDelay: 0, gcTime: Infinity } } })
    host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  })
  afterEach(async () => { await act(async () => root.unmount()); client.clear(); host.remove(); localStorage.clear(); Reflect.deleteProperty(navigator, 'locks') })
  async function settle() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)) }) }
  async function render() { await act(async () => root.render(<QueryClientProvider client={client}><ProjectPayerAddresses chainId={1} projectId={7n} tokenLabel="FUND" /></QueryClientProvider>)); await settle(); await settle() }
  function button(text: string) { return [...host.querySelectorAll('button')].find(item => item.textContent === text)! }
  async function click(text: string) { expect(button(text)).toBeDefined(); await act(async () => button(text).click()); await settle(); await settle() }

  it('lists an existing canonical payer without a wallet and does not display a terminal as one', async () => {
    mocks.address = undefined
    mocks.rows.mockResolvedValue([{ chainId: 1, projectId: 7, version: 6, address: PAYER, defaultBeneficiary: saved().settings.beneficiary, owner: saved().settings.owner, defaultAddToBalance: false, paymentsCount: 2, addToBalanceCount: 0, totalFacilitated: '100', totalFacilitatedUsd: '1000000000000000000' }])
    await render()
    expect(mocks.rows).toHaveBeenCalledWith(1, 7n, { signal: expect.any(AbortSignal) })
    expect(host.textContent).toContain('FUND goes to the original payer')
    expect(host.textContent).toContain('$1.00 facilitated')
    expect(host.querySelector('a')?.href).toBe(`https://etherscan.io/address/${PAYER}`)
    await click('Connect wallet'); expect(mocks.open).toHaveBeenCalledOnce(); expect(mocks.send).not.toHaveBeenCalled()
  })
  it('creates only through shared review and fresh validation, held under the chosen settings', async () => {
    await render(); await click('Review payer creation')
    expect(mocks.send).toHaveBeenCalledOnce()
    const [request, options] = mocks.send.mock.calls[0]
    expect(request.functionName).toBe('deployProjectPayer')
    expect(options.reviewNotice).toContain('Routing is immutable')
    expect(options.reviewedAccount).toBe(mocks.address)
    expect(options.recoveryNamespace).toBe(payerIntent(saved().settings))
    expect(options.durableRecovery).toBeUndefined()
    expect(mocks.factory).toHaveBeenCalledTimes(3)
    expect(localStorage.getItem(KEY)).toBeNull()
  })
  it('shows a deployment the hold settled only once its receipt proves the exact payer', async () => {
    await render(); await click('Review payer creation')
    mocks.phase = 'success'; mocks.receipt = { transactionHash: HASH }
    await render()
    expect(mocks.verify).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ settings: saved().settings, hash: HASH }), { transactionHash: HASH })
    expect(host.textContent).toContain('Payer deployment confirmed.')
  })
  it('never presents a successful receipt as a payer when exact verification fails', async () => {
    mocks.verify.mockRejectedValue(new Error('Wrong deployment settings'))
    await render(); await click('Review payer creation')
    mocks.phase = 'success'; mocks.receipt = { transactionHash: HASH }
    await render()
    expect(host.textContent).toContain('Wrong deployment settings')
    expect(host.textContent).not.toContain('Payer deployment confirmed.')
  })
  it('blocks deployment when the canonical factory is unavailable and explains native-terminal limits', async () => {
    mocks.factory.mockResolvedValue({ acceptsNative: false }); await render()
    expect(host.textContent).toContain('Direct ETH transfers will revert')
    mocks.factory.mockRejectedValue(new Error('The canonical Juicebox V6 payer factory could not be verified on this chain.'))
    await act(async () => { await client.refetchQueries({ queryKey: ['project-payer-factory'] }) }); await settle()
    expect(host.textContent).toContain('Payer creation is unavailable')
    expect(button('Review payer creation').disabled).toBe(true)
  })
})
