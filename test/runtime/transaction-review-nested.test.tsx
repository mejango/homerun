// @vitest-environment jsdom

/**
 * A batching call's decoded inner calls are part of what the person reviews.
 * MultiSend shows them inside its `transactions` argument; every other call
 * that carries them shows them below its own function, once.
 */

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { encodeFunctionData, erc20Abi, parseAbi, type Hex } from 'viem'

vi.mock('wagmi', () => ({
  useAccount: () => ({ address: undefined, chainId: undefined }),
}))
vi.mock('next/image', () => ({
  default: (props: Record<string, unknown>) =>
    createElement('img', { ...props, src: 'asset' }),
}))

import { TransactionReviewProvider } from '@/components/TransactionReviewProvider'
import { requireTransactionReview, type TransactionReviewCall } from '@/lib/transaction-review'
import '../dialog-shim'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const HEADING = 'Calls it makes, in order'
const TOKEN = '0x1111111111111111111111111111111111111111'
const BATCHER = '0x2222222222222222222222222222222222222222'
const ALICE = '0x3333333333333333333333333333333333333333'
const BOB = '0x4444444444444444444444444444444444444444'

function transfer(label: string, recipient: `0x${string}`, amount: bigint): TransactionReviewCall {
  const args = [recipient, amount] as const
  return {
    chainId: 8453,
    to: TOKEN,
    data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args }),
    abi: erc20Abi,
    functionName: 'transfer',
    args,
    label,
  }
}
const inner = [transfer('Pay Alice', ALICE, 5n), transfer('Pay Bob', BOB, 7n)]

async function open(call: TransactionReviewCall) {
  act(() => root.render(<TransactionReviewProvider>{null}</TransactionReviewProvider>))
  await act(async () => {
    // Swallow the cancellation thrown when the modal unmounts after the test.
    requireTransactionReview({ calls: [call] }).catch(() => {})
  })
  await act(async () => { await vi.dynamicImportSettled() })
  return document.querySelector('dialog')!
}

const count = (dialog: Element, text: string) =>
  [...dialog.querySelectorAll('h3, p')].filter(node => node.textContent === text).length

describe('nested calls in the transaction review', () => {
  it('shows the calls a non-MultiSend batch makes below its function', async () => {
    const abi = parseAbi([
      'function aggregate3Value((address target,bool allowFailure,uint256 value,bytes callData)[] calls) payable returns ((bool success,bytes returnData)[] returnData)',
    ])
    const args = [inner.map(call => ({ target: call.to, allowFailure: false, value: 0n, callData: call.data }))] as const
    const dialog = await open({
      chainId: 8453,
      to: BATCHER,
      data: encodeFunctionData({ abi, functionName: 'aggregate3Value', args }),
      abi,
      functionName: 'aggregate3Value',
      args,
      label: 'Pay both recipients',
      calls: inner,
    })

    expect(count(dialog, HEADING)).toBe(1)
    expect(count(dialog, 'Pay Alice')).toBe(1)
    expect(count(dialog, 'Pay Bob')).toBe(1)
    expect(count(dialog, 'Call 1 of 2')).toBe(1)
    expect(count(dialog, 'Call 2 of 2')).toBe(1)
    expect(count(dialog, 'transfer(address, uint256)')).toBe(2)
    expect(dialog.textContent).toContain(ALICE)
    expect(dialog.textContent).toContain(BOB)
    // The batch's own function still comes first.
    const text = dialog.textContent ?? ''
    expect(text.indexOf('aggregate3Value(')).toBeLessThan(text.indexOf(HEADING))
  })

  it('shows the calls a batch without an ABI makes, after the ABI warning', async () => {
    const dialog = await open({
      chainId: 8453,
      to: BATCHER,
      data: '0x12345678',
      label: 'Run the batch',
      calls: [inner[0]],
    })

    expect(dialog.textContent).toContain('This call’s ABI is not available in this flow.')
    expect(count(dialog, HEADING)).toBe(1)
    expect(count(dialog, 'Pay Alice')).toBe(1)
    expect(count(dialog, 'transfer(address, uint256)')).toBe(1)
  })

  it('keeps a MultiSend batch’s calls in its transactions argument, shown once', async () => {
    const abi = parseAbi(['function multiSend(bytes transactions) payable'])
    const args = [`0x${'00'.repeat(85)}`] as readonly [Hex]
    const dialog = await open({
      chainId: 8453,
      to: BATCHER,
      data: encodeFunctionData({ abi, functionName: 'multiSend', args }),
      abi,
      functionName: 'multiSend',
      args,
      calls: inner,
    })

    expect(count(dialog, HEADING)).toBe(0)
    expect(count(dialog, 'Pay Alice')).toBe(1)
    expect(count(dialog, 'Pay Bob')).toBe(1)
    const argument = [...dialog.querySelectorAll('p')].find(node => node.textContent === 'transactions bytes, decoded')
    expect(argument?.parentElement?.textContent).toContain('Pay Alice')
    expect(argument?.parentElement?.textContent).toContain('Pay Bob')
  })

  it('shows calls nested inside a nested call', async () => {
    const dialog = await open({
      chainId: 8453,
      to: BATCHER,
      data: '0x12345678',
      label: 'Outer batch',
      calls: [{ chainId: 8453, to: BATCHER, data: '0x9abcdef0', label: 'Inner batch', calls: inner }],
    })

    expect(count(dialog, HEADING)).toBe(2)
    expect(count(dialog, 'Inner batch')).toBe(1)
    expect(count(dialog, 'Pay Alice')).toBe(1)
    expect(count(dialog, 'Pay Bob')).toBe(1)
  })

  it('shows no nested section for an empty list of calls', async () => {
    const dialog = await open({ ...inner[0], calls: [] })
    expect(count(dialog, HEADING)).toBe(0)
    expect(count(dialog, 'Pay Alice')).toBe(1)
  })
})
