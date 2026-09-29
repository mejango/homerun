import './dialog-shim'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { parseAbi, type Address, type Hex } from 'viem'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FundProjectState } from '@/lib/fund-state'
import type { TxRequest, TxSendOptions } from '@/hooks/useSafeTx'

const WALLET = '0x1111111111111111111111111111111111111111' as Address
const TERMINAL = '0x3333333333333333333333333333333333333333' as Address
const TOKEN = '0x5555555555555555555555555555555555555555' as Address
const USDC = '0x7777777777777777777777777777777777777777' as Address
const UNIT = 10n ** 18n

const runtime = vi.hoisted(() => ({
  fresh: undefined as unknown,
  tx: { phase: 'idle', busy: false, isSafe: false, error: null as string | null, hash: null as Hex | null, safeProposalHash: null as Hex | null, receipt: null, send: vi.fn(), reset: vi.fn() },
  quote: vi.fn(), prepare: vi.fn(),
}))
vi.mock('wagmi', async importOriginal => ({ ...await importOriginal<typeof import('wagmi')>(), usePublicClient: () => ({}) }))
vi.mock('@/hooks/useWallet', () => ({ useWallet: () => ({ address: WALLET }) }))
vi.mock('@/lib/fund-state', () => ({ readFundProjectState: async () => runtime.fresh }))
vi.mock('@/hooks/useSafeTx', () => ({ txPhaseLabel: (_: string, labels: { idle: string }) => labels.idle, useSafeTx: () => runtime.tx }))
vi.mock('@bananapus/nana-sdk-core/v6', async importOriginal => ({
  ...await importOriginal<typeof import('@bananapus/nana-sdk-core/v6')>(),
  getHookAwareCashOutQuote: runtime.quote,
  prepareHookAwareCashOut: runtime.prepare,
}))

import { CashOutPanel, HolderActions } from '@/components/live-transactions'

const state = {
  chainId: 1, projectId: 7n, blockNumber: 100n, account: WALLET, controller: '0x2222222222222222222222222222222222222222',
  supportedController: true, supportedTerminals: true, knownOwnerWrapper: true, tokenAddress: TOKEN,
  creditBalance: 0n, erc20Balance: 100n * UNIT, metadata: { cashOutTaxRate: 1000, pausePay: false },
  accountingContexts: [{ token: USDC, terminal: TERMINAL, decimals: 6, currency: 1, symbol: 'USDC', balance: 0n }],
} as unknown as FundProjectState
const cashOutRequest = { chainId: 1, address: TERMINAL, abi: parseAbi(['function cashOutTokensOf(address,uint256,uint256,address,uint256,address,bytes)']), functionName: 'cashOutTokensOf', args: [] }

let host: HTMLDivElement
let root: Root
let cache: QueryClient
const render = (element: React.ReactNode) => act(async () => { root.render(<QueryClientProvider client={cache}>{element}</QueryClientProvider>) })
const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === text)
const click = (text: string) => act(async () => { button(text)!.click() })
async function type(label: string, value: string) {
  const input = [...host.querySelectorAll('label')].find(node => node.textContent?.startsWith(label))!.querySelector('input')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
const dialogText = () => document.querySelector('[data-tx-confirm]')?.textContent ?? ''

beforeEach(() => {
  runtime.fresh = state
  Object.assign(runtime.tx, { phase: 'idle', busy: false, error: null, hash: null, safeProposalHash: null })
  runtime.tx.send.mockReset().mockResolvedValue(null); runtime.tx.reset.mockReset()
  runtime.quote.mockReset().mockResolvedValue({ minimumReturn: 9_000_000n })
  runtime.prepare.mockReset().mockResolvedValue({ route: { minimumReturn: 8_900_000n }, transaction: cashOutRequest })
  cache = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); cache.clear() })

describe('FUND holder actions confirm like Juicebox Money', () => {
  it('reviews a cash out as a frozen plan, sends it once, and ends on Done', async () => {
    await render(<CashOutPanel state={state} client={{} as never} contextIndex={0} />)
    await type('FUND to cash out', '10'); await settle()
    expect(host.textContent).toContain('At least 9 USDC')
    await click('Review cash-out'); await settle()
    expect(dialogText()).toContain('Confirm cash out')
    expect(dialogText()).toContain('10 FUND')
    expect(dialogText()).toContain('8.9 USDC')
    expect(runtime.tx.send).not.toHaveBeenCalled()

    await click('Confirm & cash out')
    expect(runtime.tx.send).toHaveBeenCalledOnce()
    const [request, options] = runtime.tx.send.mock.calls[0] as [TxRequest, TxSendOptions]
    expect(request.label).toBe('Cash out 10 FUND for at least 8.9 USDC')
    expect(options.reviewNotice).toContain('down from 9 USDC')
    await expect(options.reverify!()).resolves.toBeUndefined()
    runtime.fresh = { ...state, erc20Balance: 1n }
    await expect(options.reverify!()).rejects.toThrow('Cash-out conditions changed')

    Object.assign(runtime.tx, { phase: 'success' })
    await render(<CashOutPanel state={state} client={{} as never} contextIndex={0} />)
    expect(dialogText()).toContain('Cashed out')
    await click('Done')
    expect(runtime.tx.reset).toHaveBeenCalledOnce()
    expect(document.querySelector('[data-tx-confirm]')).toBeNull()
    expect(host.querySelector('input')!.value).toBe('')
  })

  it('lets a Safe signer close the dialog while the proposal awaits execution, and keeps tracking it', async () => {
    await render(<CashOutPanel state={state} client={{} as never} contextIndex={0} />)
    await type('FUND to cash out', '10'); await settle()
    await click('Review cash-out'); await settle()
    Object.assign(runtime.tx, { phase: 'pending', busy: true, safeProposalHash: `0x${'b'.repeat(64)}` })
    await render(<CashOutPanel state={state} client={{} as never} contextIndex={0} />)
    expect(dialogText()).toContain('Proposed to Safe')
    const close = document.querySelector<HTMLButtonElement>('[data-tx-confirm] button[aria-label="Close"]')!
    expect(close.disabled).toBe(false)
    await act(async () => close.click())
    expect(document.querySelector('[data-tx-confirm]')).toBeNull()
    expect(runtime.tx.reset).not.toHaveBeenCalled()
    expect(host.textContent).toContain('Proposed to Safe')
  })

  it('keeps an ordinary pending transaction open until it settles', async () => {
    await render(<CashOutPanel state={state} client={{} as never} contextIndex={0} />)
    await type('FUND to cash out', '10'); await settle()
    await click('Review cash-out'); await settle()
    Object.assign(runtime.tx, { phase: 'pending', busy: true, hash: `0x${'c'.repeat(64)}` })
    await render(<CashOutPanel state={state} client={{} as never} contextIndex={0} />)
    expect(dialogText()).toContain('Waiting for confirmation')
    expect(document.querySelector<HTMLButtonElement>('[data-tx-confirm] button[aria-label="Close"]')!.disabled).toBe(true)
  })

  it('shows a failed fresh read inline without opening a plan', async () => {
    runtime.prepare.mockRejectedValueOnce(new Error('No positive protected return'))
    await render(<CashOutPanel state={state} client={{} as never} contextIndex={0} />)
    await type('FUND to cash out', '10'); await settle()
    await click('Review cash-out'); await settle()
    expect(document.querySelector('[data-tx-confirm]')).toBeNull()
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('No positive protected return')
  })

  it('reviews a transfer with its recipient before sending', async () => {
    const recipient = '0x4444444444444444444444444444444444444444'
    await render(<HolderActions state={state} client={{} as never} />)
    await type('FUND amount', '5')
    await type('Recipient wallet', recipient)
    await click('Review transfer'); await settle()
    expect(dialogText()).toContain('Confirm transfer')
    expect(dialogText()).toContain('5 FUND')
    expect(dialogText()).toContain(recipient)
    await click('Confirm & transfer')
    const [request] = runtime.tx.send.mock.calls[0] as [TxRequest]
    expect(request.functionName).toBe('transfer')
    expect(request.args).toEqual([recipient, 5n * UNIT])
  })
})
