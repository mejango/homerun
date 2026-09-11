import React, { act, useEffect, useState, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { NATIVE_TOKEN } from '@bananapus/nana-sdk-core'
import { uniswapV4Deployment } from '@bananapus/nana-sdk-core/v6'
import { decodeAbiParameters, encodeFunctionData, decodeFunctionData, getAddress, parseAbiParameters, zeroAddress, type Address, type Hex } from 'viem'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectPayQuote, ProjectPayTokenOption } from '@/lib/project-pay-quote'
import type { TxRequest, TxSendOptions } from '@/hooks/useSafeTx'

type Action = 'payment' | 'approval' | 'router'
type Handle = { phase: string; busy: boolean; isSafe: boolean; error: null; hash: Hex | null; safeProposalHash: Hex | null; receipt: null; send: ReturnType<typeof vi.fn>; reset: ReturnType<typeof vi.fn> }
const runtime = vi.hoisted(() => ({
  address: '0x1111111111111111111111111111111111111111' as Address | undefined,
  nextHook: 0, mounts: 0, unmounts: 0,
  handles: [] as Handle[],
  quote: vi.fn(), options: vi.fn(), sign: vi.fn(), verify: vi.fn(), openSignIn: vi.fn(),
  readContract: vi.fn(), waitForTransactionReceipt: vi.fn(), getTransactionReceipt: vi.fn(), getBytecode: vi.fn(),
  writes: [] as { action: Action; request: TxRequest; options: TxSendOptions }[],
  review: undefined as ((action: Action, request: TxRequest) => Promise<void>) | undefined,
  allowance: 0n,
}))

vi.mock('wagmi', () => ({ usePublicClient: () => ({ readContract: runtime.readContract, waitForTransactionReceipt: runtime.waitForTransactionReceipt, getTransactionReceipt: runtime.getTransactionReceipt, getBytecode: runtime.getBytecode }) }))
vi.mock('@/hooks/useWallet', () => ({ useWallet: () => ({ address: runtime.address, openSignIn: runtime.openSignIn }) }))
vi.mock('@/hooks/useReviewedPermit2Signature', () => ({ useReviewedPermit2Signature: () => ({ signPermit2Async: runtime.sign }) }))
vi.mock('@/lib/project-pay-quote', () => ({ prepareProjectPayQuote: runtime.quote, readProjectPayTokenOptions: runtime.options }))
vi.mock('@/lib/safe-connector', () => ({ swapDeadline: (safe: boolean) => BigInt(Math.floor(Date.now() / 1000) + (safe ? 86_400 : 1800)) }))
vi.mock('@/hooks/useSafeTx', () => ({
  txPhaseLabel: (_phase: string, labels: { idle: string }) => labels.idle,
  useSafeTx: () => {
    const [index] = useState(() => runtime.nextHook++)
    useEffect(() => { runtime.mounts++; return () => { runtime.unmounts++ } }, [])
    return runtime.handles[index]
  },
}))

import { ProjectPayment } from '@/components/ProjectPayment'

const TERMINAL = '0x3333333333333333333333333333333333333333' as Address
const TOKEN = '0x5555555555555555555555555555555555555555' as Address
const OUTPUT = '0x9999999999999999999999999999999999999999' as Address
const WALLET = '0x1111111111111111111111111111111111111111' as Address
const UNIT = 10n ** 18n
const DEPLOYMENT = uniswapV4Deployment(1)!
const HASH = `0x${'a'.repeat(64)}` as Hex
type Props = ComponentProps<typeof ProjectPayment>

function quote(minimum = 99n * UNIT, overrides: Partial<ProjectPayQuote> = {}): ProjectPayQuote {
  return { kind: 'pay', terminal: TERMINAL, preview: { beneficiaryTokenCount: 100n * UNIT, reservedTokenCount: 0n }, minimumTokenCount: minimum, reservedTokenCount: 0n, blockNumber: 100n, ...overrides }
}
function swapQuote(token = NATIVE_TOKEN, minimum = 107n * UNIT): ProjectPayQuote {
  return quote(minimum, { kind: 'direct-swap', terminal: DEPLOYMENT.universalRouter!, swapQuote: {
    kind: 'direct-swap', poolKey: { currency0: token === NATIVE_TOKEN ? zeroAddress : token, currency1: OUTPUT, fee: 3000, tickSpacing: 60, hooks: zeroAddress },
    zeroForOne: true, quotedTokenCount: 110n * UNIT, minimumTokenCount: minimum, beneficiaryTokenCount: minimum, reservedTokenCount: 0n, inputRoute: { kind: 'single-v4' },
  } })
}
function encoded(request: TxRequest) {
  return decodeFunctionData({ abi: request.abi, data: encodeFunctionData({ abi: request.abi, functionName: request.functionName, args: request.args }) })
}
function swapMinimum(request: TxRequest) {
  const execution = encoded(request)
  const [, inputs] = execution.args as readonly [Hex, Hex[], bigint]
  const [actions, params] = decodeAbiParameters(parseAbiParameters('bytes, bytes[]'), inputs.at(-1)!)
  expect(actions).toBe('0x060c0e')
  const [swap] = decodeAbiParameters(parseAbiParameters('((address, address, uint24, int24, address), bool, uint128, uint128, bytes)'), params[0])
  return swap[3]
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
    runtime.sign.mockReset().mockResolvedValue(`0x${'12'.repeat(65)}`)
    runtime.verify.mockReset().mockImplementation(async (_account, minimumBlock) => ({ blockNumber: minimumBlock ?? 100n }))
    runtime.waitForTransactionReceipt.mockReset().mockResolvedValue({ status: 'success', blockNumber: 101n, transactionHash: HASH })
    runtime.getTransactionReceipt.mockReset()
    runtime.getBytecode.mockReset().mockResolvedValue(undefined)
    runtime.readContract.mockReset().mockImplementation(async ({ address, functionName }: { address: Address; functionName: string }) => {
      if (functionName === 'allowance' && address.toLowerCase() === DEPLOYMENT.permit2.toLowerCase()) return [0n, 0, 7]
      if (functionName === 'allowance') return runtime.allowance
      throw new Error(`Unexpected contract read: ${functionName}`)
    })
    runtime.handles = (['payment', 'approval', 'router'] as const).map(action => ({
      phase: 'idle', busy: false, isSafe: false, error: null, hash: null, safeProposalHash: null, receipt: null, reset: vi.fn(),
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
  async function render() { await act(async () => commitRender()) }
  async function input(value: string) { await act(async () => changeInput(value)) }
  async function waitUntil(assertion: () => void) {
    await vi.waitFor(async () => {
      // Drain React and Query notifications, then test an observable condition.
      // A fixed delay alone is insufficient when the full suite saturates CPUs.
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
      assertion()
    }, { timeout: 5000, interval: 10 })
  }
  function button() { return [...host.querySelectorAll('button')].find(element => /Review contribution|Review payment|Preparing payment/.test(element.textContent ?? ''))! }
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
        expect(host.textContent).not.toMatch(/Finding the best|Review and execute|Confirming approval onchain/)
      })
    }
  }
  function erc20() {
    props.context = { token: TOKEN, terminal: TERMINAL, decimals: 6, symbol: 'USDC' }
    runtime.options.mockResolvedValue([{ ...props.context, viaRouter: false }])
  }

  it('freezes the refreshed terminal minimum and explicitly reviews a decreased quote', async () => {
    await ready()
    runtime.quote.mockResolvedValue(quote(88n * UNIT))
    runtime.review = async action => {
      if (action !== 'payment') return
      // A background quote may update the display while the reviewed call stays frozen.
      cache.setQueriesData({ queryKey: ['project-pay'] }, quote(66n * UNIT))
    }
    await submit()
    expect(runtime.writes).toHaveLength(1)
    const { request, options } = runtime.writes[0]
    expect(encoded(request).functionName).toBe('pay')
    expect(encoded(request).args?.slice(0, 5)).toEqual([7n, NATIVE_TOKEN, UNIT, WALLET, 88n * UNIT])
    expect(request.value).toBe(UNIT)
    expect(options.reviewNotice).toContain('quote decreased')
    expect(options.reviewNotice).toContain('88 FUND')
    expect(options.simulationBlockNumber).toBe(100n)
  })

  it('preserves the SDK swap minimum exactly in genuine Universal Router calldata', async () => {
    const minimum = 107_123_456_789_123_456_789n
    runtime.quote.mockResolvedValue(swapQuote(NATIVE_TOKEN, minimum))
    await ready(); await submit()
    expect(runtime.writes).toHaveLength(1)
    const { request, options } = runtime.writes[0]
    expect(request.address).toBe(DEPLOYMENT.universalRouter)
    expect(encoded(request).functionName).toBe('execute')
    expect(swapMinimum(request)).toBe(minimum)
    expect(request.value).toBe(UNIT)
    expect(options.reviewNotice).toContain('does not add the payment to the project treasury')
  })

  it('approves an ERC-20 terminal route for the actual terminal and exact amount', async () => {
    erc20(); runtime.allowance = 0n
    await ready('2.5'); await submit()
    expect(runtime.writes.map(item => item.action)).toEqual(['approval', 'payment'])
    expect(encoded(runtime.writes[0].request).args).toEqual([TERMINAL, 2_500_000n])
    expect(runtime.writes[0].request.address).toBe(TOKEN)
    expect(runtime.writes[1].request.value).toBe(0n)
    expect(runtime.verify).toHaveBeenCalledWith(WALLET, 101n)
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

  it('approves Permit2 and uses a reviewed EOA signature for the swap router', async () => {
    erc20(); runtime.allowance = 0n; runtime.quote.mockResolvedValue(swapQuote(TOKEN))
    await ready('2'); await submit()
    expect(runtime.writes.map(item => item.action)).toEqual(['approval', 'payment'])
    expect(encoded(runtime.writes[0].request).args).toEqual([DEPLOYMENT.permit2, 2_000_000n])
    expect(runtime.sign).toHaveBeenCalledWith(expect.objectContaining({ expectedAccount: WALLET, authorization: expect.objectContaining({ token: TOKEN, spender: DEPLOYMENT.universalRouter, amount: 2_000_000n, nonce: 7 }) }))
    expect(encoded(runtime.writes[1].request).args?.[0]).toBe('0x0a10')
    expect(swapMinimum(runtime.writes[1].request)).toBe(107n * UNIT)
    expect(runtime.writes[1].request.value).toBe(0n)
  })

  it('falls back to an exact onchain Permit2 approval when typed data is unsupported', async () => {
    erc20(); runtime.quote.mockResolvedValue(swapQuote(TOKEN))
    runtime.sign.mockRejectedValue(Object.assign(new Error('Method eth_signTypedData_v4 not supported'), { code: -32601 }))
    await ready('3'); await submit()
    expect(runtime.writes.map(item => item.action)).toEqual(['router', 'payment'])
    expect(runtime.writes[0].request.address).toBe(DEPLOYMENT.permit2)
    expect(encoded(runtime.writes[0].request).args?.slice(0, 3)).toEqual([TOKEN, getAddress(DEPLOYMENT.universalRouter!), 3_000_000n])
    expect(encoded(runtime.writes[1].request).args?.[0]).toBe('0x10')
  })

  it('never substitutes an onchain approval after the user rejects a signature', async () => {
    erc20(); runtime.quote.mockResolvedValue(swapQuote(TOKEN))
    runtime.sign.mockRejectedValue(Object.assign(new Error('User rejected the request'), { code: 4001 }))
    await ready(); await submit()
    expect(runtime.writes).toHaveLength(0)
    expect(host.textContent).toContain('User rejected')
  })

  it.each(['erc20', 'router'] as const)('stops after a Safe %s approval proposal, without signing or paying', async step => {
    erc20(); runtime.quote.mockResolvedValue(swapQuote(TOKEN)); runtime.allowance = step === 'erc20' ? 0n : 10n ** 9n
    runtime.handles.forEach(handle => { handle.isSafe = true })
    await ready(); await submit()
    expect(runtime.writes.map(item => item.action)).toEqual([step === 'erc20' ? 'approval' : 'router'])
    expect(runtime.sign).not.toHaveBeenCalled()
    expect(runtime.waitForTransactionReceipt).not.toHaveBeenCalled()
    expect(host.textContent).toContain('Execute it there')
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
    expect(runtime.unmounts).toBe(3)
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

  it('retains all three receipt watchers across currency, quote, and rules changes', async () => {
    const options: ProjectPayTokenOption[] = [{ token: NATIVE_TOKEN, terminal: TERMINAL, decimals: 18, symbol: 'ETH', viaRouter: false }, { token: TOKEN, terminal: TERMINAL, decimals: 6, symbol: 'USDC', viaRouter: true }]
    runtime.options.mockResolvedValue(options)
    await ready()
    expect(runtime.mounts).toBe(3)
    runtime.quote.mockRejectedValue(new Error('RPC offline'))
    await input('2')
    await act(async () => { const select = host.querySelector('select')!; select.value = TOKEN; select.dispatchEvent(new Event('change', { bubbles: true })) })
    props.rulesetId = '101'; await render()
    expect(runtime.mounts).toBe(3)
    expect(runtime.unmounts).toBe(0)
    expect(runtime.writes).toHaveLength(0)
  })
})
