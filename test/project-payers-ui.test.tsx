import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Address } from 'viem'
const mocks = vi.hoisted(() => ({ address: '0x1111111111111111111111111111111111111111' as Address | undefined, factory: vi.fn(), rows: vi.fn(), verify: vi.fn(), send: vi.fn(), open: vi.fn(), reset: vi.fn(), safe: false, waitSafe: vi.fn(), getReceipt: vi.fn(), getBlockNumber: vi.fn() }))
vi.mock('@/hooks/useWallet', () => ({ useWallet: () => ({ address: mocks.address, openSignIn: mocks.open }) }))
vi.mock('@/hooks/useSafeTx', () => ({ txPhaseLabel: (_: string, labels: { idle: string }) => labels.idle, useSafeTx: () => ({ phase: 'idle', busy: false, error: null, isSafe: mocks.safe, send: mocks.send, reset: mocks.reset }) }))
vi.mock('wagmi', () => ({ usePublicClient: () => ({ getTransactionReceipt: mocks.getReceipt, getBlockNumber: mocks.getBlockNumber }) }))
vi.mock('@/lib/safe-connector', () => ({ waitForSafeExecutionHash: mocks.waitSafe }))
vi.mock('@/lib/project-payers', async importOriginal => ({ ...await importOriginal<typeof import('../src/lib/project-payers')>(), checkPayerFactory: mocks.factory, getProjectPayerAddresses: mocks.rows, verifyPayerReceipt: mocks.verify }))
import { ProjectPayerAddresses } from '../src/components/ProjectPayerAddresses'
import { payerAttemptKey, type PayerAttempt } from '../src/lib/project-payers'
import { submitReviewedContractWrite } from '../src/lib/contract-write'
const HASH = `0x${'aa'.repeat(32)}`, EXECUTION = `0x${'bb'.repeat(32)}`, PAYER = '0x2222222222222222222222222222222222222222', KEY = payerAttemptKey(1, 7n)
function saved(): PayerAttempt { return { version: 1, settings: { chainId: 1, projectId: '7', beneficiary: '0x0000000000000000000000000000000000000000', owner: '0x0000000000000000000000000000000000000000', memo: '', addToBalance: false }, account: '0x1111111111111111111111111111111111111111', safe: false, phase: 'signing', afterBlock: '100' } }
describe('project payer controls', () => {
  let client: QueryClient, root: Root, host: HTMLDivElement
  beforeEach(() => {
    localStorage.clear(); vi.clearAllMocks()
    mocks.address = saved().account; mocks.safe = false
    mocks.factory.mockResolvedValue({ acceptsNative: true }); mocks.rows.mockResolvedValue([])
    mocks.getReceipt.mockRejectedValue(new Error('Transaction pending')); mocks.waitSafe.mockRejectedValue(new Error('Safe not yet executed')); mocks.getBlockNumber.mockResolvedValue(100n)
    mocks.verify.mockResolvedValue({ status: 'confirmed', payer: PAYER })
    mocks.send.mockImplementation(async (_request, options) => { await options.reverify(); await options.beforeWrite(); return HASH })
    client = new QueryClient({ defaultOptions: { queries: { staleTime: 30_000, retry: false, retryDelay: 0, gcTime: Infinity } } })
    host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  })
  afterEach(async () => { await act(async () => root.unmount()); client.clear(); host.remove(); localStorage.clear() })
  async function settle() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)) }) }
  async function render() { await act(async () => root.render(<QueryClientProvider client={client}><ProjectPayerAddresses chainId={1} projectId={7n} tokenLabel="FUND" /></QueryClientProvider>)); await settle(); await settle() }
  function button(text: string) { return [...host.querySelectorAll('button')].find(item => item.textContent === text)! }
  async function click(text: string) { expect(button(text)).toBeDefined(); await act(async () => button(text).click()); await settle(); await settle() }

  it('lists an existing canonical payer without a wallet and does not display a terminal as one', async () => {
    mocks.address = undefined
    mocks.rows.mockResolvedValue([{ chainId: 1, projectId: 7, version: 6, address: PAYER, defaultBeneficiary: saved().settings.beneficiary, owner: saved().settings.owner, defaultAddToBalance: false, paymentsCount: 2, addToBalanceCount: 0, totalFacilitated: '100', totalFacilitatedUsd: '1000000000000000000' }])
    await render()
    expect(host.textContent).toContain('FUND goes to the original payer')
    expect(host.textContent).toContain('$1.00 facilitated')
    expect(host.querySelector('a')?.href).toBe(`https://etherscan.io/address/${PAYER}`)
    await click('Connect wallet'); expect(mocks.open).toHaveBeenCalledOnce(); expect(mocks.send).not.toHaveBeenCalled()
  })
  it('creates only through shared review, fresh validation and a persisted pre-write marker', async () => {
    await render(); await click('Review payer creation')
    expect(mocks.send).toHaveBeenCalledOnce()
    const [request, options] = mocks.send.mock.calls[0]
    expect(request.functionName).toBe('deployProjectPayer')
    expect(options.reviewNotice).toContain('Routing is immutable')
    expect(mocks.factory).toHaveBeenCalledTimes(3)
    expect(JSON.parse(localStorage.getItem(KEY)!)).toMatchObject({ phase: 'submitted', hash: HASH, afterBlock: '100', safe: false })
    expect(host.textContent).toContain('Submitted. Verifying')
    expect(button('Review payer creation').closest('fieldset')?.disabled).toBe(true)
  })
  it('restores an unknown submission without offering a duplicate deployment', async () => {
    localStorage.setItem(KEY, JSON.stringify(saved())); await render()
    expect(host.textContent).toContain('Check your wallet before creating another')
    expect(button('Review payer creation').closest('fieldset')?.disabled).toBe(true)
    expect(mocks.send).not.toHaveBeenCalled()
  })
  it('keeps a Safe proposal separate from execution and confirms only after receipt proof', async () => {
    mocks.safe = true; await render(); await click('Review payer creation')
    expect(host.textContent).toContain('Proposed to Safe. Execution and onchain confirmation are still required.')
    expect(mocks.getReceipt).not.toHaveBeenCalled()
    mocks.waitSafe.mockResolvedValue(EXECUTION); mocks.getReceipt.mockResolvedValue({ transactionHash: EXECUTION })
    await act(async () => { await client.refetchQueries({ queryKey: ['project-payer-confirmation'] }) }); await settle(); await settle()
    expect(mocks.verify).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ safe: true, hash: HASH }), { transactionHash: EXECUTION })
    expect(host.textContent).toContain('Payer deployment confirmed.')
    expect(JSON.parse(localStorage.getItem(KEY)!)).toMatchObject({ hash: HASH, executionHash: EXECUTION, phase: 'confirmed', payer: PAYER })
    expect(mocks.reset).toHaveBeenCalledOnce()
  })
  it('never presents a successful receipt as a payer when exact verification fails', async () => {
    localStorage.setItem(KEY, JSON.stringify({ ...saved(), hash: HASH, phase: 'submitted' }))
    mocks.getReceipt.mockResolvedValue({ transactionHash: HASH }); mocks.verify.mockRejectedValue(new Error('Wrong deployment settings'))
    await render()
    expect(host.textContent).toContain('Wrong deployment settings')
    expect(host.textContent).not.toContain('Payer deployment confirmed.')
    expect(JSON.parse(localStorage.getItem(KEY)!)).toMatchObject({ phase: 'submitted' })
  })
  it('re-verifies saved success before showing deployment confirmation', async () => {
    localStorage.setItem(KEY, JSON.stringify({ ...saved(), hash: HASH, phase: 'confirmed', payer: PAYER }))
    mocks.getReceipt.mockResolvedValue({ transactionHash: HASH }); mocks.verify.mockRejectedValue(new Error('Receipt is no longer canonical'))
    await render()
    expect(host.textContent).toContain('Receipt is no longer canonical')
    expect(host.textContent).not.toContain('Payer deployment confirmed.')
    expect(host.querySelector(`a[href*="${PAYER}"]`)).toBeNull()
    expect(button('Review payer creation').closest('fieldset')?.disabled).toBe(true)
  })
  it('blocks deployment when the canonical factory is unavailable and explains native-terminal limits', async () => {
    mocks.factory.mockResolvedValue({ acceptsNative: false }); await render()
    expect(host.textContent).toContain('direct ETH transfers will revert')
    mocks.factory.mockRejectedValue(new Error('The canonical Juicebox V6 payer factory could not be verified on this chain.'))
    await act(async () => { await client.refetchQueries({ queryKey: ['project-payer-factory'] }) }); await settle()
    expect(host.textContent).toContain('Payer creation is unavailable')
    expect(button('Review payer creation').disabled).toBe(true)
  })
  it('clears the unknown-submission marker only after an explicit wallet rejection', async () => {
    mocks.send.mockImplementation(async (_request, options) => { await options.beforeWrite(); await options.onWriteRejected(); return null })
    await render(); await click('Review payer creation')
    expect(localStorage.getItem(KEY)).toBeNull()
    expect(button('Review payer creation').closest('fieldset')?.disabled).toBe(false)
  })
  it('re-verifies immediately on remount even with a recently confirmed proof in the same cache', async () => {
    localStorage.setItem(KEY, JSON.stringify({ ...saved(), hash: HASH, phase: 'submitted' }))
    mocks.getReceipt.mockResolvedValue({ transactionHash: HASH }); await render()
    expect(host.textContent).toContain('Payer deployment confirmed.')
    expect(mocks.verify).toHaveBeenCalledOnce()
    await act(async () => root.render(null))
    mocks.verify.mockRejectedValue(new Error('Receipt reorged'))
    await render()
    expect(mocks.verify).toHaveBeenCalledTimes(2)
    expect(host.textContent).toContain('Receipt reorged')
    expect(host.textContent).not.toContain('Payer deployment confirmed.')
  })
  it('never reuses an older manual-recovery proof for different attempt inputs', async () => {
    localStorage.setItem(KEY, JSON.stringify({ ...saved(), executionHash: HASH, phase: 'submitted' }))
    mocks.getReceipt.mockResolvedValue({ transactionHash: HASH }); await render()
    expect(host.textContent).toContain('Payer deployment confirmed.')
    await act(async () => root.render(null))
    const later = { ...saved(), afterBlock: '200', settings: { ...saved().settings, memo: 'New attempt' }, executionHash: HASH, phase: 'submitted' }
    localStorage.setItem(KEY, JSON.stringify(later))
    mocks.verify.mockRejectedValue(new Error('Receipt predates this attempt'))
    await render()
    expect(mocks.verify).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ afterBlock: '200', settings: expect.objectContaining({ memo: 'New attempt' }) }), { transactionHash: HASH })
    expect(host.textContent).toContain('Receipt predates this attempt')
    expect(host.textContent).not.toContain('Payer deployment confirmed.')
    expect(JSON.parse(localStorage.getItem(KEY)!)).toMatchObject({ afterBlock: '200', phase: 'submitted' })
  })
  it('shows saved deployment success as a historical receipt without offering stale editable routing', async () => {
    localStorage.setItem(KEY, JSON.stringify({ ...saved(), settings: { ...saved().settings, owner: saved().account }, hash: HASH, phase: 'submitted' }))
    mocks.getReceipt.mockResolvedValue({ transactionHash: HASH }); await render()
    expect(host.textContent).toContain('This receipt confirms the original deployment.')
    expect(host.textContent).toContain('an admin may have changed editable settings')
    expect(button('Copy address')).toBeUndefined()
    expect(host.querySelector(`a[href*="${PAYER}"]`)).toBeNull()
    expect(host.querySelector(`a[href*="${HASH}"]`)).not.toBeNull()
  })
  it('cleans up a persisted marker when an account change aborts strictly before the wallet writer', async () => {
    const writer = vi.fn(async () => HASH)
    mocks.getBlockNumber.mockImplementation(async () => { mocks.address = PAYER as Address; return 100n })
    mocks.send.mockImplementation(async (request, options) => {
      try { return await submitReviewedContractWrite({ request, expectedAccount: saved().account, review: async () => {}, switchChain: async () => {}, currentAccount: () => mocks.address, simulate: async () => request, ...options, write: writer }) }
      catch { return null }
    })
    await render(); await click('Review payer creation')
    expect(writer).not.toHaveBeenCalled()
    expect(localStorage.getItem(KEY)).toBeNull()
    expect(button('Review payer creation').closest('fieldset')?.disabled).toBe(false)
  })
  it('retains the lock for an ambiguous writer error after the wallet boundary', async () => {
    const writer = vi.fn(async () => { throw new Error('RPC disconnected after submitting') })
    mocks.send.mockImplementation(async (request, options) => {
      try { return await submitReviewedContractWrite({ request, expectedAccount: saved().account, review: async () => {}, switchChain: async () => {}, currentAccount: () => mocks.address, simulate: async () => request, ...options, write: writer }) }
      catch { return null }
    })
    await render(); await click('Review payer creation')
    expect(writer).toHaveBeenCalledOnce()
    expect(JSON.parse(localStorage.getItem(KEY)!)).toMatchObject({ phase: 'signing' })
    expect(button('Review payer creation').closest('fieldset')?.disabled).toBe(true)
  })
})
