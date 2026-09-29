// @vitest-environment jsdom

/**
 * One fee picker: the chain the wallet started on is chosen when it is quoted,
 * and so is a lone quote. Otherwise nothing is chosen until the person picks,
 * and closing the picker sends nothing.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('wagmi', () => ({
  useAccount: () => ({ address: undefined, chainId: undefined }),
}))

import { TransactionReviewProvider } from '@/components/TransactionReviewProvider'
import {
  fundingChainLabel,
  requireFundingChainSelection,
  TransactionReviewCancelledError,
  type FundingChainOption,
} from '@/lib/transaction-review'
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

const ethereum = { chainId: 1, label: fundingChainLabel('Ethereum', 1_234_567_000_000_000n) }
const base = { chainId: 8453, label: fundingChainLabel('Base', 123_456_789_012_345n) }

async function choose(options: FundingChainOption[], preferredChainId?: number) {
  act(() => root.render(<TransactionReviewProvider>{null}</TransactionReviewProvider>))
  let outcome!: Promise<{ chainId: number } | { error: unknown }>
  await act(async () => {
    outcome = requireFundingChainSelection(options, preferredChainId).then(chainId => ({ chainId }), error => ({ error }))
  })
  await act(async () => { await vi.dynamicImportSettled() })
  const dialog = document.querySelector('dialog')!
  const button = (label: string) =>
    [...dialog.querySelectorAll('button')].find(item => item.textContent === label)!
  return {
    outcome,
    dialog,
    select: dialog.querySelector('select')!,
    confirm: button('Continue to payment review'),
    cancel: button('Cancel'),
  }
}

describe('choosing where to pay a relay fee', () => {
  it('asks where to pay, in the shared wording', async () => {
    const { dialog, select } = await choose([ethereum, base], 8453)
    expect(dialog.querySelector('h2')?.textContent).toBe('Choose where to pay')
    expect(document.getElementById(dialog.getAttribute('aria-describedby')!)?.textContent).toBe(
      "One payment covers every chain. You’ll review it before your wallet sends it.",
    )
    expect(dialog.querySelector(`label[for="${select.id}"]`)?.textContent).toBe('Pay on')
    expect([...select.options].map(option => option.textContent)).toEqual([
      'Choose a chain', 'Ethereum (~0.00123 ETH)', 'Base (~0.000123 ETH)',
    ])
  })

  it('preselects the chain the wallet is on when it is quoted', async () => {
    const { select, confirm, outcome } = await choose([ethereum, base], 8453)
    expect(select.value).toBe('8453')
    expect(confirm.disabled).toBe(false)
    await act(async () => confirm.click())
    await expect(outcome).resolves.toEqual({ chainId: 8453 })
  })

  it('preselects a lone quote', async () => {
    const { select, confirm, outcome } = await choose([base], 10)
    expect(select.value).toBe('8453')
    expect(confirm.disabled).toBe(false)
    await act(async () => confirm.click())
    await expect(outcome).resolves.toEqual({ chainId: 8453 })
  })

  it.each([undefined, 10])('chooses nothing among several quotes when the wallet chain is %s', async preferred => {
    const { select, confirm, outcome } = await choose([ethereum, base], preferred)
    expect(select.value).toBe('')
    expect(confirm.disabled).toBe(true)
    await act(async () => {
      select.value = '1'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(confirm.disabled).toBe(false)
    await act(async () => confirm.click())
    await expect(outcome).resolves.toEqual({ chainId: 1 })
  })

  it('sends nothing when the picker is closed', async () => {
    const { cancel, outcome } = await choose([ethereum, base], 8453)
    await act(async () => cancel.click())
    const { error } = (await outcome) as { error: unknown }
    expect(error).toBeInstanceOf(TransactionReviewCancelledError)
    expect(error).toMatchObject({ message: 'Funding chain selection cancelled. Nothing was sent.' })
  })

  it('sends nothing when the picker is dismissed with Escape', async () => {
    const { outcome } = await choose([ethereum, base], 8453)
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })
    expect((await outcome as { error: unknown }).error).toBeInstanceOf(TransactionReviewCancelledError)
    expect(document.querySelector('dialog')).toBeNull()
  })
})
