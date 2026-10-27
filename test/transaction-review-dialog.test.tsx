// @vitest-environment jsdom

/**
 * The review dialog's rendered DOM for each SDK fixture request
 * (`REVIEW_REQUESTS` from @bananapus/nana-sdk-core/testing). The dialog renders
 * the SDK's ReviewModel, and this snapshot pins that it shows the same rows it
 * showed before.
 */

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openReview } from './support/open-review'
import { promptReviewForTests, REVIEW_REQUESTS } from '@bananapus/nana-sdk-core/testing'

vi.mock('wagmi', () => ({
  useAccount: () => ({ address: '0x1111111111111111111111111111111111111111', chainId: 1 }),
}))
vi.mock('next/image', () => ({
  default: (props: Record<string, unknown>) => createElement('img', { ...props, src: 'asset' }),
}))
// No fee-buyback reads: the notice stays in its unknown state.
vi.mock('@/lib/fee-buyback-client', () => ({
  feeBuybackContext: () => {
    throw new Error('No fee-buyback reads in this test.')
  },
}))

import { TransactionReviewProvider } from '@/components/TransactionReviewProvider'
import { buildReviewModel } from '@bananapus/nana-sdk-core/review'
import { type TransactionReviewRequest } from '@/lib/transaction-review'
import './dialog-shim'

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

async function renderedDialog(request: (typeof REVIEW_REQUESTS)[keyof typeof REVIEW_REQUESTS]): Promise<string> {
  act(() => root.render(<TransactionReviewProvider>{null}</TransactionReviewProvider>))
  await act(async () => {
    // The modal unmounts after the test, which cancels the review.
    openReview(request).catch(() => {})
  })
  await act(async () => {
    await vi.dynamicImportSettled()
  })
  const dialog = document.querySelector('dialog')
  if (!dialog) throw new Error('The review dialog did not render.')
  return dialog.outerHTML
}

describe('transaction review dialog', () => {
  for (const [name, request] of Object.entries(REVIEW_REQUESTS)) {
    it(`renders the ${name} fixture`, async () => {
      expect(await renderedDialog(request)).toMatchSnapshot()
    })
  }
  it('shows each signature the action asks for, with its text, rows and calls', async () => {
    const payment = REVIEW_REQUESTS['pay with 721 metadata'].calls[0]
    const { TransactionReviewDialog } = await import('@/components/TransactionReviewDialog')
    const request: TransactionReviewRequest = {
      calls: [],
      signatures: [
        { kind: 'message', chainId: 8453, message: 'Publish my Homerun project' },
        {
          kind: 'permit2',
          chainId: 1,
          typedData: { primaryType: 'PermitSingle' },
          steps: [{ title: 'Permit2 allowance', rows: [['Spender', '0x2222222222222222222222222222222222222222']] }],
        },
        { kind: 'forward-request', chainId: 8453, typedData: { primaryType: 'ForwardRequest' }, calls: [payment] },
      ],
    }
    act(() => root.render(
      <TransactionReviewDialog pending={{ kind: 'review', id: 1, model: buildReviewModel(request), resolve: () => {} }} onFinish={() => {}} />,
    ))
    const text = document.querySelector('dialog')?.textContent ?? ''
    expect(text).toContain('Signature 1 of 3')
    expect(text).toContain('Publish my Homerun project')
    expect(text).toContain('Permit2 approval')
    expect(text).toContain('Spender:0x2222222222222222222222222222222222222222')
    expect(text).toContain('Relayed request')
    expect(text).toContain('Calls it lets someone run, in order')
    expect(text).toContain('pay(uint256, address, uint256, address, uint256, string, bytes)')
    expect(text).toContain('plus the exact message and typed data your signatures commit to')
  })

  it('describes a message authorization on a call as a message', async () => {
    const payment = REVIEW_REQUESTS['pay with 721 metadata'].calls[0]
    const { TransactionReviewDialog } = await import('@/components/TransactionReviewDialog')
    const request = { calls: [payment], authorization: { kind: 'message', message: 'hello' } }
    act(() => root.render(
      <TransactionReviewDialog pending={{ kind: 'review', id: 1, model: buildReviewModel(request), resolve: () => {} }} onFinish={() => {}} />,
    ))
    const text = document.querySelector('dialog')?.textContent ?? ''
    expect(text).toContain('plus the exact message your signature commits to')
    expect(text).not.toContain('typed data')
  })

  it('refuses a request it cannot describe, and Close declines it', async () => {
    const payment = REVIEW_REQUESTS['pay with 721 metadata'].calls[0]
    const { TransactionReviewDialog } = await import('@/components/TransactionReviewDialog')
    const finished: unknown[] = []
    const request = { calls: [payment], authorization: { amount: Number.NaN } }
    act(() => root.render(
      <TransactionReviewDialog
        pending={{ kind: 'review', id: 1, model: buildReviewModel(request), resolve: () => {} }}
        onFinish={approved => finished.push(approved)}
      />,
    ))
    const dialog = document.querySelector('dialog')
    expect(dialog?.textContent).toContain("Can't review this request")
    const close = [...(dialog?.querySelectorAll('button') ?? [])].find(button => button.textContent === 'Close')
    act(() => close?.click())
    expect(finished).toEqual([false])
  })

  it("answers core's prompt with its confirmation only when the person confirms, and cancels on Close", async () => {
    act(() => root.render(<TransactionReviewProvider>{null}</TransactionReviewProvider>))
    const request = REVIEW_REQUESTS['pay with 721 metadata']
    const buttons = () => [...(document.querySelector('dialog')?.querySelectorAll('button') ?? [])]
    const confirmed = promptReviewForTests(request)
    await act(async () => { await vi.dynamicImportSettled() })
    act(() => document.querySelector<HTMLInputElement>('dialog input[type="checkbox"]')!.click())
    act(() => buttons().at(-1)!.click())
    await expect(confirmed.outcome).resolves.toBe('confirmed')

    const closed = promptReviewForTests(request)
    await act(async () => { await vi.dynamicImportSettled() })
    act(() => buttons().find(button => button.textContent === 'Cancel')!.click())
    await expect(closed.outcome).resolves.toBe('cancelled')
  })

  it("shows why core's simulation saw the send revert, and offers only Cancel", async () => {
    act(() => root.render(<TransactionReviewProvider>{null}</TransactionReviewProvider>))
    const buttons = () => [...(document.querySelector('dialog')?.querySelectorAll('button') ?? [])]
    const failing = promptReviewForTests(REVIEW_REQUESTS['pay with 721 metadata'], {
      simulation: { status: 'failed', message: 'The payment would mint fewer tokens than your minimum.', explained: true },
    })
    await act(async () => { await vi.dynamicImportSettled() })
    act(() => document.querySelector<HTMLInputElement>('dialog input[type="checkbox"]')!.click())
    expect(document.querySelector('dialog [role="alert"]')?.textContent).toBe('The payment would mint fewer tokens than your minimum.')
    expect(buttons().at(-1)!.disabled).toBe(true)
    act(() => buttons().find(button => button.textContent === 'Cancel')!.click())
    await expect(failing.outcome).resolves.toBe('cancelled')
  })
})
