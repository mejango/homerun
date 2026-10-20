import './dialog-shim'
import React, { act, useEffect, useState, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { NATIVE_TOKEN } from '@bananapus/nana-sdk-core'
import { encodeAbiParameters, encodeFunctionData, decodeFunctionData, type Address, type Hex } from 'viem'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectPayQuote, ProjectPayTokenOption } from '@/lib/project-pay-quote'
import type { TxRequest, TxSendOptions } from '@/hooks/useSafeTx'
import { intent, writeIntentKey } from '@bananapus/nana-sdk-core/review'
import { approvalIntentKey } from '@/lib/transaction-builders'
import { expectRetryHeldByIntent } from './support/intent-retry'

type Action = 'payment' | 'approval'
type Handle = { notice: string | null; dismiss: ReturnType<typeof vi.fn>; phase: string; busy: boolean; isSafe: boolean; error: null; hash: Hex | null; safeProposalHash: Hex | null; receipt: null; send: ReturnType<typeof vi.fn>; reset: ReturnType<typeof vi.fn> }
const runtime = vi.hoisted(() => ({
  address: '0x1111111111111111111111111111111111111111' as Address | undefined,
  nextHook: 0, mounts: 0, unmounts: 0,
  handles: [] as Handle[],
  quote: vi.fn(), options: vi.fn(), verify: vi.fn(), openSignIn: vi.fn(),
  readContract: vi.fn(), waitForTransactionReceipt: vi.fn(), getTransactionReceipt: vi.fn(),
  writes: [] as { action: Action; request: TxRequest; options: TxSendOptions }[],
  review: undefined as ((action: Action, request: TxRequest) => Promise<void>) | undefined,
  allowance: 0n,
}))

vi.mock('wagmi', () => ({ usePublicClient: () => ({ readContract: runtime.readContract, waitForTransactionReceipt: runtime.waitForTransactionReceipt, getTransactionReceipt: runtime.getTransactionReceipt }) }))
vi.mock('@/hooks/useWallet', () => ({ useWallet: () => ({ address: runtime.address, openSignIn: runtime.openSignIn }) }))
vi.mock('@/lib/project-pay-quote', () => ({ prepareProjectPayQuote: runtime.quote, readProjectPayTokenOptions: runtime.options }))
vi.mock('@/hooks/useSafeTx', () => ({
  txPhaseLabel: (_phase: string, labels: { idle: string }) => labels.idle,
  useSafeTx: () => {
    const [index] = useState(() => runtime.nextHook++)
    useEffect(() => { runtime.mounts++; return () => { runtime.unmounts++ } }, [])
    return runtime.handles[index]
  },
}))

import { ProjectPayment } from '@/components/ProjectPayment'
import { WritesChecking } from '@/components/writes-checking'

const TERMINAL = '0x3333333333333333333333333333333333333333' as Address
const TOKEN = '0x5555555555555555555555555555555555555555' as Address
const WALLET = '0x1111111111111111111111111111111111111111' as Address
const UNIT = 10n ** 18n
const METADATA = `0x${'00'.repeat(32)}${'ab'.repeat(32)}` as Hex
const REFRESHED_METADATA = `0x${'00'.repeat(32)}${'cd'.repeat(32)}` as Hex
const BACKGROUND_METADATA = `0x${'00'.repeat(32)}${'ef'.repeat(32)}` as Hex
const REFRESHED_TERMINAL = '0x4444444444444444444444444444444444444444' as Address
const HASH = `0x${'a'.repeat(64)}` as Hex
type Props = ComponentProps<typeof ProjectPayment>

function quote(minimum = 99n * UNIT, overrides: Partial<ProjectPayQuote> = {}): ProjectPayQuote {
  return { terminal: TERMINAL, preview: { beneficiaryTokenCount: 100n * UNIT, reservedTokenCount: 0n }, minimumTokenCount: minimum, reservedTokenCount: 0n, metadata: METADATA, blockNumber: 100n, ...overrides }
}
function encoded(request: TxRequest) {
  return decodeFunctionData({ abi: request.abi, data: encodeFunctionData({ abi: request.abi, functionName: request.functionName, args: request.args }) })
}
describe('shared payment execution', () => {
  let host: HTMLDivElement
  let root: Root
  let cache: QueryClient
  let props: Props

  beforeEach(() => {
    runtime.address = WALLET; runtime.nextHook = 0; runtime.mounts = 0; runtime.unmounts = 0
    runtime.writes = []; runtime.review = undefined; runtime.allowance = 1000n * UNIT
    runtime.quote.mockReset().mockResolvedValue(quote())
    runtime.options.mockReset().mockResolvedValue([{ token: NATIVE_TOKEN, terminal: TERMINAL, decimals: 18, symbol: 'ETH', viaRouter: false }])
    runtime.verify.mockReset().mockImplementation(async (_account, minimumBlock) => ({ blockNumber: minimumBlock ?? 100n }))
    runtime.waitForTransactionReceipt.mockReset().mockResolvedValue({ status: 'success', blockNumber: 101n, transactionHash: HASH })
    runtime.getTransactionReceipt.mockReset()
    runtime.readContract.mockReset().mockImplementation(async ({ functionName }: { functionName: string }) => {
      if (functionName === 'allowance') return runtime.allowance
      throw new Error(`Unexpected contract read: ${functionName}`)
    })
    runtime.handles = (['payment', 'approval'] as const).map(action => ({
      notice: null, dismiss: vi.fn(), phase: 'idle', busy: false, isSafe: false, error: null, hash: null, safeProposalHash: null, receipt: null, reset: vi.fn(),
      send: vi.fn(async (request: TxRequest, options: TxSendOptions = {}) => {
        await runtime.review?.(action, request)
        // Model the mandatory shared transaction review's last write gate.
        await options.reverify?.(request)
        runtime.writes.push({ action, request, options })
        if (action === 'approval') runtime.allowance = request.args[1] as bigint
        return HASH
      }),
    }))
    props = { chainId: 1, projectId: 7n, tokenLabel: 'FUND', title: 'Contribute', context: { token: NATIVE_TOKEN, terminal: TERMINAL, decimals: 18, symbol: 'ETH' }, paused: false, reservedPercent: 0, rulesetId: '100', verify: runtime.verify }
    cache = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })
    host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  })
  afterEach(async () => { await act(async () => root.unmount()); cache.clear(); host.remove() })

  function commitRender() {
    flushSync(() => root.render(<QueryClientProvider client={cache}><ProjectPayment {...props} /></QueryClientProvider>))
  }
  function changeInput(value: string) {
    const element = host.querySelector('input')!
    flushSync(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, value)
      element.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }
  async function render() {
    await act(async () => commitRender())
    if (!host.querySelector('dialog')) await act(async () => [...host.querySelectorAll('button')].find(button => button.textContent?.startsWith('Pay on '))?.click())
  }
  async function input(value: string) { await act(async () => changeInput(value)) }
  async function waitUntil(assertion: () => void) {
    await vi.waitFor(async () => {
      // Drain React and Query notifications, then test an observable condition.
      // A fixed delay alone is insufficient when the full suite saturates CPUs.
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
      assertion()
    }, { timeout: 5000, interval: 10 })
  }
  function button() { return [...host.querySelectorAll('button')].find(element => /^Confirm & (contribute|pay)$/.test(element.textContent ?? ''))! }
  async function ready(value = '1') {
    await render(); await input(value)
    await waitUntil(() => expect(button().disabled).toBe(false))
  }
  async function submit(waitingForApproval = false) {
    await act(async () => button().click())
    if (waitingForApproval) {
      await waitUntil(() => {
        expect(runtime.waitForTransactionReceipt).toHaveBeenCalledTimes(1)
        expect(host.textContent).toContain('Confirming approval onchain')
      })
    } else {
      await waitUntil(() => {
        expect(button().textContent).not.toContain('Preparing')
        expect(host.textContent).not.toMatch(/Getting the latest|Review and execute|Confirming approval onchain/)
      })
    }
  }
  function erc20() {
    props.context = { token: TOKEN, terminal: TERMINAL, decimals: 6, symbol: 'USDC' }
    runtime.options.mockResolvedValue([{ ...props.context, viaRouter: false }])
  }

  it('labels the Pay button while the page is still checking its first verified read', async () => {
    flushSync(() => root.render(<QueryClientProvider client={cache}><WritesChecking.Provider value={true}><ProjectPayment {...props} /></WritesChecking.Provider></QueryClientProvider>))
    expect([...host.querySelectorAll('button')].some(button => button.textContent === 'Checking…')).toBe(true)
    expect([...host.querySelectorAll('button')].some(button => button.textContent?.startsWith('Pay on '))).toBe(false)
  })

  it('freezes the refreshed terminal minimum and explicitly reviews a decreased quote', async () => {
    await ready()
    runtime.quote.mockResolvedValue(quote(88n * UNIT, { metadata: REFRESHED_METADATA }))
    runtime.review = async action => {
      if (action !== 'payment') return
      // A background quote may update the display while the reviewed call stays frozen.
      cache.setQueriesData({ queryKey: ['project-pay'] }, quote(66n * UNIT, { metadata: BACKGROUND_METADATA }))
    }
    await submit()
    expect(runtime.writes).toHaveLength(1)
    const { request, options } = runtime.writes[0]
    expect(encoded(request).functionName).toBe('pay')
    expect(encoded(request).args?.slice(0, 5)).toEqual([7n, NATIVE_TOKEN, UNIT, WALLET, 88n * UNIT])
    // The refreshed prepareUserPay metadata goes out with its own minimum, not the displayed or background quote's.
    expect(encoded(request).args?.[6]).toBe(REFRESHED_METADATA)
    expect(request.value).toBe(UNIT)
    expect(options.reviewNotice).toContain('quote decreased')
    expect(options.reviewNotice).toContain('88 FUND')
    expect(options.reviewedAccount).toBe(WALLET)
    expect(options.simulationBlockNumber).toBe(100n)
    // Its minimum comes from a fresh quote, so a retry is held by the user's choice, not the calldata.
    expect(options.recoveryNamespace).toBe(writeIntentKey('pay', { project: 7n, token: 'auto:token', amount: '1' }))
  })

  it('holds a payment in the default currency by the amount as typed, so a retry after the default switched from ETH to USDC is held by the first', async () => {
    await ready('1'); await submit()
    // The page's default currency switched after the lost reply: "1" is now 10^6 units, not 10^18.
    erc20()
    await ready('1.0'); await submit()
    const payments = runtime.writes.filter(item => item.action === 'payment')
    expect(payments).toHaveLength(2)
    await expectRetryHeldByIntent(payments[0], payments[1], writeIntentKey('pay', { project: 7n, token: 'auto:token', amount: '1' }))
  })

  it('keys a payment in a chosen currency by its exact units', async () => {
    erc20(); props.currencyChosen = true
    await ready('2.5'); await submit()
    expect(runtime.writes.find(item => item.action === 'payment')!.options.recoveryNamespace)
      .toBe(writeIntentKey('pay', { project: 7n, token: intent.address(TOKEN), amount: 2_500_000n }))
  })

  it('approves an ERC-20 terminal route for the actual terminal and exact amount', async () => {
    erc20(); runtime.allowance = 0n
    await ready('2.5'); await submit()
    expect(runtime.writes.map(item => item.action)).toEqual(['approval', 'payment'])
    expect(encoded(runtime.writes[0].request).args).toEqual([TERMINAL, 2_500_000n])
    // No declared output, so a token whose approve returns nothing (USDT) still simulates.
    expect(runtime.writes[0].request.abi[0]).toMatchObject({ name: 'approve', outputs: [] })
    expect(runtime.writes[0].request.address).toBe(TOKEN)
    expect(runtime.writes[1].request.value).toBe(0n)
    // One payment intent whichever route the quote picks; its approval is that intent's token step.
    const payment = writeIntentKey('pay', { project: 7n, token: 'auto:token', amount: '2.5' })
    expect(runtime.writes[1].options.recoveryNamespace).toBe(payment)
    expect(runtime.writes[0].options.recoveryNamespace).toBe(approvalIntentKey(payment, { token: TOKEN, spender: TERMINAL, step: 'token' }))
    expect(runtime.verify).toHaveBeenCalledWith(WALLET, 101n)
  })

  it('approves and pays the refreshed terminal with its own metadata and minimum', async () => {
    erc20(); runtime.allowance = 0n
    await ready('2.5')
    runtime.quote.mockResolvedValue(quote(77n * UNIT, { terminal: REFRESHED_TERMINAL, metadata: REFRESHED_METADATA }))
    runtime.review = async action => { if (action === 'payment') cache.setQueriesData({ queryKey: ['project-pay'] }, quote(66n * UNIT, { metadata: BACKGROUND_METADATA })) }
    await submit()
    expect(runtime.writes.map(item => item.action)).toEqual(['approval', 'payment'])
    expect(encoded(runtime.writes[0].request).args).toEqual([REFRESHED_TERMINAL, 2_500_000n])
    const pay = runtime.writes[1].request
    expect(pay.address).toBe(REFRESHED_TERMINAL)
    expect(encoded(pay).args?.[4]).toBe(77n * UNIT)
    expect(encoded(pay).args?.[6]).toBe(REFRESHED_METADATA)
  })

  it('blocks approval and payment when the refreshed preparation fails, and stays usable', async () => {
    erc20(); runtime.allowance = 0n
    await ready('2.5')
    runtime.quote.mockRejectedValue(new Error('The buyback hook could not be read.'))
    await submit()
    expect(runtime.writes).toHaveLength(0)
    expect(host.textContent).toContain('buyback hook could not be read')
    await waitUntil(() => expect(button().disabled).toBe(false))
    runtime.quote.mockResolvedValue(quote(77n * UNIT, { metadata: REFRESHED_METADATA }))
    await submit()
    expect(runtime.writes.map(item => item.action)).toEqual(['approval', 'payment'])
    expect(encoded(runtime.writes[1].request).args?.[6]).toBe(REFRESHED_METADATA)
  })

  it('quotes a routed payment currency using its own decimals and preserves the accounting terminal anchor', async () => {
    runtime.options.mockResolvedValue([{ ...props.context, viaRouter: false }, { token: TOKEN, terminal: TERMINAL, decimals: 6, symbol: 'USDC', viaRouter: true }])
    await ready()
    await act(async () => { const select = host.querySelector('select')!; select.value = TOKEN; select.dispatchEvent(new Event('change', { bubbles: true })) })
    await input('2.125')
    await waitUntil(() => expect(button().disabled).toBe(false))
    expect(runtime.quote).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ token: TOKEN, terminal: TERMINAL, amount: 2_125_000n }))
    await submit()
    expect(encoded(runtime.writes.at(-1)!.request).args?.slice(1, 3)).toEqual([TOKEN, 2_125_000n])
  })

  it('stops after a Safe approval proposal, without paying', async () => {
    erc20(); runtime.allowance = 0n
    runtime.handles.forEach(handle => { handle.isSafe = true })
    await ready(); await submit()
    expect(runtime.writes.map(item => item.action)).toEqual(['approval'])
    expect(runtime.waitForTransactionReceipt).not.toHaveBeenCalled()
    expect(host.textContent).toContain('Execute it there')
  })

  it('shows the approval proposal notice and Done without completing or paying', async () => {
    const action = 'approval'
    erc20(); runtime.allowance = 0n
    runtime.handles.forEach(handle => { handle.isSafe = true })
    await ready(); await submit()
    const handle = runtime.handles[1]
    handle.phase = 'submitted'
    handle.notice = 'The Safe result could not be proven. Check Safe before taking another action.'
    await render()
    const dialog = host.querySelector('[data-tx-confirm]')!
    expect(dialog.textContent).toContain(handle.notice)
    expect(dialog.textContent).not.toContain('Contribution confirmed')
    const done = [...dialog.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === 'Done')!
    expect(done.disabled).toBe(false)
    expect(dialog.querySelector('li[data-state="complete"]')).toBeNull()
    expect(runtime.writes.map(item => item.action)).toEqual([action])
    await act(async () => done.click())
    expect(handle.dismiss).toHaveBeenCalledOnce()
    expect(host.querySelector('[data-tx-confirm]')).toBeNull()
    expect(runtime.writes.map(item => item.action)).toEqual([action])
  })

  it.each(['account', 'amount', 'rules'] as const)('rechecks a changed %s after review and before the wallet write', async change => {
    await ready()
    runtime.review = async action => {
      if (action !== 'payment') return
      if (change === 'account') { runtime.address = '0x2222222222222222222222222222222222222222'; commitRender() }
      if (change === 'amount') changeInput('2')
      if (change === 'rules') { props.rulesetId = '101'; commitRender() }
    }
    await submit()
    expect(runtime.writes).toHaveLength(0)
    expect(host.textContent).toContain('changed. Review the payment again')
  })

  it('refuses a quote older than the verified contract state', async () => {
    runtime.verify.mockResolvedValue({ blockNumber: 101n })
    await ready(); await submit()
    expect(runtime.writes).toHaveLength(0)
    expect(host.textContent).toContain('quote RPC has not caught up')
  })

  it('does not send a payment after unmounting while its approval confirms', async () => {
    erc20(); runtime.allowance = 0n
    const receipt = Promise.withResolvers<{ status: string; blockNumber: bigint; transactionHash: Hex }>()
    runtime.waitForTransactionReceipt.mockReturnValue(receipt.promise)
    await ready(); await submit(true)
    expect(runtime.writes.map(item => item.action)).toEqual(['approval'])
    await act(async () => root.unmount())
    await act(async () => {
      receipt.resolve({ status: 'success', blockNumber: 101n, transactionHash: HASH })
      await receipt.promise
      // Finish the awaiting paymentReceipt continuation and its guard/catch/finally.
      await new Promise<void>(resolve => queueMicrotask(resolve))
    })
    expect(runtime.writes.map(item => item.action)).toEqual(['approval'])
    expect(runtime.unmounts).toBe(2)
  })

  it.each([0, 10_000])('rejects an unprotected zero output with reserved percent %s', async reservedPercent => {
    props.reservedPercent = reservedPercent
    await ready()
    runtime.quote.mockResolvedValue(quote(0n))
    await submit()
    expect(runtime.writes).toHaveLength(0)
    expect(host.textContent).toContain('No protected token output')
  })

  it('only allows the explicit 100% reserved allocation case with its review notice', async () => {
    props.reservedPercent = 10_000
    runtime.quote.mockResolvedValue(quote(0n, { reservedTokenCount: 20n * UNIT }))
    await ready(); await submit()
    expect(runtime.writes).toHaveLength(1)
    expect(encoded(runtime.writes[0].request).args?.[4]).toBe(0n)
    expect(runtime.writes[0].options.reviewNotice).toContain('You receive no FUND')
  })

  it('retains both receipt watchers across currency, quote, and rules changes', async () => {
    const options: ProjectPayTokenOption[] = [{ token: NATIVE_TOKEN, terminal: TERMINAL, decimals: 18, symbol: 'ETH', viaRouter: false }, { token: TOKEN, terminal: TERMINAL, decimals: 6, symbol: 'USDC', viaRouter: true }]
    runtime.options.mockResolvedValue(options)
    await ready()
    expect(runtime.mounts).toBe(2)
    runtime.quote.mockRejectedValue(new Error('RPC offline'))
    await input('2')
    await act(async () => { const select = host.querySelector('select')!; select.value = TOKEN; select.dispatchEvent(new Event('change', { bubbles: true })) })
    props.rulesetId = '101'; await render()
    expect(runtime.mounts).toBe(2)
    expect(runtime.unmounts).toBe(0)
    expect(runtime.writes).toHaveLength(0)
  })
  it('opens a payment modal and retains its amount and receipt watchers when closed', async () => {
    await ready('2')
    expect(host.querySelector('dialog[open]')).not.toBeNull()
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!.click())
    expect(host.querySelector('dialog')).toBeNull()
    expect(runtime.unmounts).toBe(0)
    await render()
    expect(host.querySelector('input')!.value).toBe('2')
    expect(runtime.mounts).toBe(2)
  })

  it('lists the wallet steps before the first prompt and advances through them, as jbm\'s pay sequence does', async () => {
    erc20(); runtime.allowance = 0n
    await ready('2.5')
    await waitUntil(() => expect(host.textContent).toContain('Your wallet will ask for 2 actions'))
    const titles = () => [...host.querySelectorAll('li[data-state]')].map(step => step.textContent)
    expect(titles()[0]).toContain('Approve USDC')
    expect(titles()[1]).toContain('Contribute 2.5 USDC')
    expect([...host.querySelectorAll('li[data-state]')].map(step => step.getAttribute('data-state'))).toEqual(['pending', 'pending'])
    await submit()
    expect(runtime.writes.map(item => item.action)).toEqual(['approval', 'payment'])
    expect([...host.querySelectorAll('li[data-state]')].map(step => step.getAttribute('data-state'))).toEqual(['complete', 'active'])
  })

  it('asks for one action when a native payment needs no approval', async () => {
    await ready()
    await waitUntil(() => expect(host.textContent).toContain('Your wallet will ask for one action'))
    expect(host.querySelectorAll('li[data-state]')).toHaveLength(1)
  })

  it('does not quote a closed allowlist for a visitor without a wallet, and asks for an allowed one', async () => {
    runtime.address = undefined
    props.quoteNeedsWallet = true
    await render(); await input('25')
    await waitUntil(() => expect(host.textContent).toContain('Connect an allowed wallet to see your quote.'))
    expect(runtime.quote).not.toHaveBeenCalled()
    expect(host.textContent).not.toContain('quote is unavailable')
    expect(host.textContent).not.toContain('Enter an amount')
  })

  it('submits the selected chain and its own project ID', async () => {
    props.chainId = 8453
    props.projectId = 42n
    await ready(); await submit()
    expect(runtime.writes[0].request.chainId).toBe(8453)
    expect(encoded(runtime.writes[0].request).args?.[0]).toBe(42n)
  })

  // JBMultiTerminal_UnderMin(98 tokens, 99 tokens) as revert data.
  const UNDER_MIN = encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [98n * UNIT, 99n * UNIT]).replace('0x', '0x6b2bb382') as Hex
  const SHORTFALL = 'This payment would get fewer tokens than your minimum, so lower your minimum or try again.'
  function allowedDecrease() { return host.querySelector<HTMLInputElement>('input[type="number"]') }

  it('names a shortfall the simulation hit and reviews again with the looser minimum it offers', async () => {
    await ready()
    const pay = runtime.handles[0].send
    pay.mockImplementationOnce(async (_request: TxRequest, options: TxSendOptions & { onFailure?: (error: unknown) => void }) => { options.onFailure?.(UNDER_MIN); return null })
    await act(async () => button().click())
    await waitUntil(() => expect(host.textContent).toContain(SHORTFALL))
    // 1% plus the ~1.02% shortfall, rounded up to a half percent.
    expect(allowedDecrease()?.value).toBe('2.5')
    const again = [...host.querySelectorAll('button')].find(element => element.textContent === 'Review again')!
    runtime.quote.mockResolvedValue(quote(97n * UNIT))
    await act(async () => again.click())
    await waitUntil(() => expect(runtime.writes.filter(item => item.action === 'payment')).toHaveLength(1))
    expect(runtime.quote).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ slippageBps: 250n }))
    expect(encoded(runtime.writes[0].request).args?.[4]).toBe(97n * UNIT)
    expect(host.textContent).not.toContain(SHORTFALL)
    expect(host.textContent).toContain('2.5% maximum slippage')
  })

  it('says a mined payment reverted, without a reason, and reviews it again at the latest block', async () => {
    await ready()
    const pay = runtime.handles[0] as unknown as { phase: string; reverted: boolean; reset: ReturnType<typeof vi.fn> }
    pay.reset.mockImplementation(() => { pay.phase = 'idle'; pay.reverted = false })
    await submit()
    pay.phase = 'error'; pay.reverted = true
    await act(async () => commitRender())
    expect(host.textContent).toContain('The payment reverted.')
    expect(allowedDecrease()).toBeNull()
    const again = [...host.querySelectorAll('button')].find(element => element.textContent === 'Review again')!
    runtime.quote.mockResolvedValue(quote(97n * UNIT))
    await act(async () => again.click())
    await waitUntil(() => expect(runtime.writes.filter(item => item.action === 'payment')).toHaveLength(2))
    expect(encoded(runtime.writes[1].request).args?.[4]).toBe(97n * UNIT)
    expect(runtime.quote).not.toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ slippageBps: expect.anything() }))
    expect(host.textContent).not.toContain('The payment reverted.')
  })

  it('keeps the shared line and offers no minimum for an unknown failure', async () => {
    await ready()
    runtime.handles[0].send.mockImplementationOnce(async (_request: TxRequest, options: TxSendOptions & { onFailure?: (error: unknown) => void }) => { options.onFailure?.(new Error('nonce too low')); return null })
    await submit()
    expect(allowedDecrease()).toBeNull()
    expect([...host.querySelectorAll('button')].some(element => element.textContent === 'Review again')).toBe(false)
    expect(runtime.quote).not.toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ slippageBps: expect.anything() }))
  })

  it('drops a shortfall and its retry once the amount changes', async () => {
    await ready()
    runtime.handles[0].send.mockImplementationOnce(async (_request: TxRequest, options: TxSendOptions & { onFailure?: (error: unknown) => void }) => { options.onFailure?.(UNDER_MIN); return null })
    await act(async () => button().click())
    await waitUntil(() => expect(host.textContent).toContain(SHORTFALL))
    await input('2')
    await waitUntil(() => expect(button().disabled).toBe(false))
    expect(host.textContent).not.toContain(SHORTFALL)
    expect(allowedDecrease()).toBeNull()
  })

  it('says a payment would return no tokens, and offers no minimum of zero', async () => {
    await ready()
    const none = encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [0n, 99n * UNIT]).replace('0x', '0x6b2bb382') as Hex
    runtime.handles[0].send.mockImplementationOnce(async (_request: TxRequest, options: TxSendOptions & { onFailure?: (error: unknown) => void }) => { options.onFailure?.(none); return null })
    await submit()
    await waitUntil(() => expect(host.textContent).toContain('This payment would return no tokens.'))
    expect(allowedDecrease()).toBeNull()
    expect([...host.querySelectorAll('button')].some(element => element.textContent === 'Review again')).toBe(false)
  })

})
