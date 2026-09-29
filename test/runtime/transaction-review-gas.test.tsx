// @vitest-environment jsdom

/**
 * Gas fixed before review is reviewed. A wallet or forwarder gas limit shows as
 * its own row, and a Safe proposal's safeTxGas shows too, with what a nonzero
 * value means. The review says the wallet only adds the nonce and fees when
 * every call carries its gas; otherwise the wallet shows the gas limit it sets.
 */

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('wagmi', () => ({
  useAccount: () => ({ address: undefined, chainId: undefined }),
}))
vi.mock('next/image', () => ({
  default: (props: Record<string, unknown>) =>
    createElement('img', { ...props, src: 'asset' }),
}))

import { TransactionReviewProvider } from '@/components/TransactionReviewProvider'
import {
  requireTransactionReview,
  type TransactionReviewCall,
  type TransactionReviewRequest,
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

const call: TransactionReviewCall = {
  chainId: 8453,
  to: '0x1111111111111111111111111111111111111111',
  data: '0xdeadbeef',
}
const SAFE_NOTE = 'If this call fails, the Safe still executes and uses this nonce.'

async function open(
  calls: TransactionReviewCall[],
  request: Omit<TransactionReviewRequest, 'calls'> = {},
) {
  act(() => root.render(<TransactionReviewProvider>{null}</TransactionReviewProvider>))
  await act(async () => {
    // Swallow the cancellation thrown when the modal unmounts after the test.
    requireTransactionReview({ ...request, calls }).catch(() => {})
  })
  await act(async () => { await vi.dynamicImportSettled() })
  return document.querySelector('dialog')!
}

/** The values under a row's label: its value, then any note. */
function row(dialog: Element, label: string): string[] | undefined {
  const term = [...dialog.querySelectorAll('dt')].find(node => node.textContent === label)
  if (!term) return undefined
  const values: string[] = []
  for (let node = term.nextElementSibling; node?.tagName === 'DD'; node = node.nextElementSibling) {
    values.push(node.textContent ?? '')
  }
  return values
}

const description = (dialog: Element) =>
  document.getElementById(dialog.getAttribute('aria-describedby')!)?.textContent

const SENT = 'This is the exact destination, native value, and calldata the app will ask your wallet to send.'
const GAS_REVIEWED = `${SENT} Your wallet adds the nonce and network fees.`
const GAS_IN_WALLET = `${SENT} Your wallet shows the gas limit and network fees before you send.`

describe('gas in the transaction review', () => {
  it('shows a fixed gas limit and says the wallet adds only the nonce and fees', async () => {
    const dialog = await open([{ ...call, gas: 4_000_000n }])
    expect(row(dialog, 'Gas limit')).toEqual(['4,000,000'])
    expect(row(dialog, 'Safe gas')).toBeUndefined()
    expect(description(dialog)).toBe(GAS_REVIEWED)
    expect(dialog.querySelector('pre')?.textContent).toContain('"gas": "0x3d0900"')
  })

  it('says the wallet shows the gas limit when none is fixed', async () => {
    const dialog = await open([call])
    expect(row(dialog, 'Gas limit')).toBeUndefined()
    expect(row(dialog, 'Safe gas')).toBeUndefined()
    expect(description(dialog)).toBe(GAS_IN_WALLET)
  })

  it('says the wallet shows the gas limit when any one of several calls leaves it open', async () => {
    const dialog = await open([call, { ...call, gas: 150_000n }])
    expect(row(dialog, 'Gas limit')).toEqual(['150,000'])
    expect(description(dialog)).toBe(GAS_IN_WALLET)
  })

  it('counts a Safe proposal’s safeTxGas as the gas it sends', async () => {
    const dialog = await open([{ ...call, safeTxGas: 0n }])
    expect(description(dialog)).toBe(GAS_REVIEWED)
  })

  it('says the wallet adds only the nonce and fees when every call carries gas or safeTxGas', async () => {
    const dialog = await open([{ ...call, gas: 150_000n }, { ...call, safeTxGas: 0n }])
    expect(description(dialog)).toBe(GAS_REVIEWED)
  })

  it.each([
    ['without', call],
    ['with', { ...call, gas: 500_000n }],
  ])('keeps the authorization description %s a signed gas limit', async (_, reviewed) => {
    const dialog = await open([reviewed], { kind: 'authorization', authorization: { type: 'test' } })
    expect(description(dialog)).toBe(
      'This authorization commits to the exact destination, native value, and calldata below. A Safe or relayer can submit that call onchain after you continue.',
    )
  })

  it('keeps a flow’s own description', async () => {
    const dialog = await open([call], { description: 'Pay for relayed transactions.' })
    expect(description(dialog)).toBe('Pay for relayed transactions.')
  })

  it('shows a nonzero safeTxGas with what it means for a failed call', async () => {
    const dialog = await open([{ ...call, safeTxGas: 150_000n }])
    expect(row(dialog, 'Safe gas')).toEqual(['150,000', SAFE_NOTE])
    expect(row(dialog, 'Gas limit')).toBeUndefined()
  })

  it('shows a zero safeTxGas without the note', async () => {
    const dialog = await open([{ ...call, safeTxGas: 0n }])
    expect(row(dialog, 'Safe gas')).toEqual(['0'])
    expect(dialog.textContent).not.toContain(SAFE_NOTE)
  })

  it('shows Safe gas before the gas limit, after the native value', async () => {
    const dialog = await open([{ ...call, gas: 90_000n, safeTxGas: 60_000n }])
    const terms = [...dialog.querySelectorAll('dt')].map(node => node.textContent)
    expect(terms.slice(terms.indexOf('Native value'), terms.indexOf('Native value') + 3)).toEqual([
      'Native value', 'Safe gas', 'Gas limit',
    ])
  })
})
