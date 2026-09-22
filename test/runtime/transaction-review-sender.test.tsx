// @vitest-environment jsdom

/**
 * A reviewed call says who sends it. A transaction is sent by the connected
 * wallet, so the review fills that address in. An authorization is sent by a
 * relayer, a Safe or Juicebox Center's sponsor, so the review shows a sender
 * only when the call itself names one.
 */

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const wallet = '0x1111111111111111111111111111111111111111'
const relayed = '0x2222222222222222222222222222222222222222'

vi.mock('wagmi', () => ({
  useAccount: () => ({ address: wallet, chainId: 8453 }),
}))
vi.mock('next/image', () => ({
  default: (props: Record<string, unknown>) =>
    createElement('img', { ...props, src: 'asset' }),
}))

import { TransactionReviewProvider } from '@/components/TransactionReviewProvider'
import { requireTransactionReview, type TransactionReviewRequest } from '@/lib/transaction-review'
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

async function open(request: TransactionReviewRequest) {
  act(() => root.render(<TransactionReviewProvider>{null}</TransactionReviewProvider>))
  await act(async () => {
    // Swallow the cancellation thrown when the modal unmounts after the test.
    requireTransactionReview(request).catch(() => {})
  })
  await act(async () => { await vi.dynamicImportSettled() })
  return document.querySelector('dialog')!
}

/** The From row, when the review renders one. */
const sender = (dialog: Element) =>
  [...dialog.querySelectorAll('dt')].find(node => node.textContent === 'From')?.nextElementSibling?.textContent

const call = {
  chainId: 8453,
  to: '0xAC9250654ea223513FfEe25fDB647Dc016873905' as const,
  data: '0xdeadbeef' as const,
}

describe('who a reviewed call names as its sender', () => {
  it('names no sender for a project Juicebox Center’s sponsor sends', async () => {
    const dialog = await open({
      kind: 'authorization',
      title: 'Create your project',
      calls: [{ ...call, label: 'Center’s sponsor creates the FUND on Base' }],
      authorization: { kind: 'message', type: 'Juicebox Center project intent' },
    })
    expect(dialog.textContent).toContain('Center’s sponsor creates the FUND on Base')
    expect(sender(dialog)).toBeUndefined()
    expect(dialog.textContent).not.toContain(wallet)
  })

  it('keeps the sender a relayed authorization names', async () => {
    const dialog = await open({
      kind: 'authorization',
      title: 'Review relayed transaction',
      calls: [{ ...call, from: relayed }],
      authorization: { type: 'EIP-712 ForwardRequest' },
    })
    expect(sender(dialog)).toBe(relayed)
  })

  it('names the connected wallet on a transaction it will send itself', async () => {
    const dialog = await open({ calls: [call] })
    expect(sender(dialog)).toBe(wallet)
  })
})
