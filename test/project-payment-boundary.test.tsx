import './dialog-shim'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { NATIVE_TOKEN } from '@bananapus/nana-sdk-core'
import type { Address, Hex } from 'viem'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectPayQuote } from '@/lib/project-pay-quote'
import { installRecoveryLocks } from './runtime/write-recovery-fixture'

// The real useSafeTx write path: review, reverify, simulation, hold marker, then the final wallet gate.
const runtime = vi.hoisted(() => ({
  quote: vi.fn(), options: vi.fn(), verify: vi.fn(), review: vi.fn(), simulate: vi.fn(), write: vi.fn(),
}))
const WALLET = '0x1111111111111111111111111111111111111111' as Address
const client = {
  simulateContract: runtime.simulate,
  estimateContractGas: vi.fn(async () => 50_000n),
  readContract: vi.fn(), getBlockNumber: vi.fn(async () => 100n), getTransactionCount: vi.fn(async () => 5),
  getChainId: vi.fn(async () => 1), getBlock: vi.fn(async () => ({ number: 100n, timestamp: 1_000n })),
  getTransaction: vi.fn(async () => null), getTransactionReceipt: vi.fn(async () => null), waitForTransactionReceipt: vi.fn(async () => new Promise(() => {})),
}
vi.mock('wagmi', () => ({
  usePublicClient: () => client,
  useSwitchChain: () => ({ switchChainAsync: vi.fn() }),
  useWaitForTransactionReceipt: () => ({ data: undefined, isError: false }),
  useWriteContract: () => ({ writeContractAsync: runtime.write }),
}))
vi.mock('@wagmi/core', () => ({ getAccount: () => ({ address: WALLET, chainId: 1, connector: { uid: 'reviewed' } }) }))
vi.mock('@/hooks/useWallet', () => ({ useWallet: () => ({ isConnected: true, address: WALLET, isCenterWallet: false, openSignIn: vi.fn() }) }))
vi.mock('@/lib/transaction-review', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/transaction-review')>()),
  requestContractTransactionReview: runtime.review,
}))
vi.mock('@/providers/Providers', () => ({ wagmiConfig: {} }))
vi.mock('@/lib/safe-connector', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/safe-connector')>()),
  isSafeConnection: () => false,
  useSafeConnection: () => false,
  findPendingSafeAppProposal: async () => null,
}))
vi.mock('@/lib/project-pay-quote', () => ({ prepareProjectPayQuote: runtime.quote, readProjectPayTokenOptions: runtime.options }))

import { ProjectPayment } from '@/components/ProjectPayment'

const TERMINAL = '0x3333333333333333333333333333333333333333' as Address
const OTHER_TERMINAL = '0x4444444444444444444444444444444444444444' as Address
const UNIT = 10n ** 18n
const quote = (): ProjectPayQuote => ({ terminal: TERMINAL, preview: { beneficiaryTokenCount: 100n * UNIT, reservedTokenCount: 0n }, minimumTokenCount: 99n * UNIT, reservedTokenCount: 0n, metadata: `0x${'ab'.repeat(32)}` as Hex, blockNumber: 100n })

describe('payment freshness at the wallet boundary', () => {
  let host: HTMLDivElement
  let root: Root
  let cache: QueryClient
  let terminal: Address

  beforeEach(() => {
    localStorage.clear(); installRecoveryLocks()
    terminal = TERMINAL
    runtime.quote.mockReset().mockResolvedValue(quote())
    runtime.options.mockReset().mockImplementation(async (_client: unknown, args: { terminal: Address }) => [{ token: NATIVE_TOKEN, terminal: args.terminal, decimals: 18, symbol: 'ETH', viaRouter: false }])
    runtime.verify.mockReset().mockResolvedValue({ blockNumber: 100n })
    runtime.review.mockReset().mockResolvedValue(true)
    runtime.simulate.mockReset().mockImplementation(async ({ address }: { address: Address }) => ({ request: { address, functionName: 'pay' } }))
    runtime.write.mockReset().mockResolvedValue(`0x${'cd'.repeat(32)}`)
    cache = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })
    host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  })
  afterEach(async () => { await act(async () => root.unmount()); cache.clear(); host.remove() })

  function draw() {
    flushSync(() => root.render(<QueryClientProvider client={cache}><ProjectPayment chainId={1} projectId={7n} tokenLabel="FUND" title="Contribute"
      context={{ token: NATIVE_TOKEN, terminal, decimals: 18, symbol: 'ETH' }} paused={false} reservedPercent={0} rulesetId="100" verify={runtime.verify} /></QueryClientProvider>))
  }
  const confirm = () => [...host.querySelectorAll('button')].find(element => /^Confirm & contribute$/.test(element.textContent ?? ''))!
  async function settle(assertion: () => void) {
    await vi.waitFor(async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) }); assertion() }, { timeout: 5000, interval: 10 })
  }
  async function start() {
    await act(async () => draw())
    await act(async () => [...host.querySelectorAll('button')].find(button => button.textContent?.startsWith('Pay on '))!.click())
    const input = host.querySelector('input')!
    await act(async () => flushSync(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '1')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    }))
    await settle(() => expect(confirm().disabled).toBe(false))
    await act(async () => confirm().click())
  }
  function deferred() {
    let resolve!: (value: unknown) => void
    const promise = new Promise(next => { resolve = next })
    return { promise, resolve }
  }
  async function failRefresh() {
    runtime.quote.mockRejectedValue(new Error('RPC offline'))
    await act(async () => { await cache.refetchQueries({ queryKey: ['project-pay'] }) })
  }

  it('sends the payment when nothing changes (control)', async () => {
    await start()
    await settle(() => expect(runtime.write).toHaveBeenCalledOnce())
  })

  it('does not reach the wallet when the terminal changes while simulation is pending', async () => {
    const simulation = deferred()
    runtime.simulate.mockImplementation(async ({ address }: { address: Address }) => { await simulation.promise; return { request: { address, functionName: 'pay' } } })
    await start()
    await settle(() => expect(runtime.simulate).toHaveBeenCalled())
    terminal = OTHER_TERMINAL
    await act(async () => draw())
    await act(async () => simulation.resolve(undefined))
    await settle(() => expect(host.textContent).toContain('Review the payment again'))
    expect(runtime.write).not.toHaveBeenCalled()
  })

  it.each(['review', 'simulation'] as const)('does not reach the wallet when a quote refresh fails during %s', async stage => {
    const pending = deferred()
    if (stage === 'review') runtime.review.mockImplementation(async () => { await pending.promise; return true })
    else runtime.simulate.mockImplementation(async ({ address }: { address: Address }) => { await pending.promise; return { request: { address, functionName: 'pay' } } })
    await start()
    await settle(() => expect(stage === 'review' ? runtime.review : runtime.simulate).toHaveBeenCalled())
    await failRefresh()
    await act(async () => pending.resolve(undefined))
    await settle(() => expect(host.textContent).toContain('quote is no longer available'))
    expect(runtime.write).not.toHaveBeenCalled()
  })
})
