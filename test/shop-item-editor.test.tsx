import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/components/ui/ModalShell', () => ({
  ModalShell: ({ title, children, footer }: { title: ReactNode; children: ReactNode; footer: ReactNode }) => <div role="dialog"><h2>{title}</h2>{children}{footer}</div>,
}))
import { ShopItemEditor } from '../src/components/ShopItemEditor'
import { newDemoShopItem, type DemoShopCurrency, type DemoShopItem } from '../src/lib/demo-shop'

let root: Root
let host: HTMLDivElement
const onSave = vi.fn()

function field(label: string): HTMLInputElement | HTMLTextAreaElement {
  const node = Array.from(host.querySelectorAll<HTMLLabelElement>('label')).find(element => element.textContent?.trim() === label)
  if (!node) throw new Error(`Missing label: ${label}`)
  return document.getElementById(node.htmlFor) as HTMLInputElement | HTMLTextAreaElement
}

async function change(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  await act(async () => {
    const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value)
    element.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function click(label: string) {
  const button = Array.from(host.querySelectorAll('button')).find(element => element.textContent?.trim() === label)
  if (!button) throw new Error(`Missing button: ${label}`)
  await act(async () => button.click())
}

async function mount(currency: DemoShopCurrency = 'USD', item: DemoShopItem = newDemoShopItem(), priceDecimals?: number) {
  await act(async () => root.render(<ShopItemEditor initial={{ mode: 'add', items: [item], currency }} categories={[]} maximumItems={20} variant="live" priceDecimals={priceDecimals} onClose={vi.fn()} onSave={onSave} />))
}

async function review() {
  await act(async () => host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
}

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 1 })
  vi.stubGlobal('CSS', { escape: (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, '\\$&') })
  HTMLElement.prototype.scrollIntoView = vi.fn()
})

afterEach(async () => { await act(async () => root.unmount()); host.remove() })

describe('live shop item editor', () => {
  it.each(['USD', 'ETH'] as const)('inherits %s pricing without a currency picker or local demo notice', async currency => {
    await mount(currency)
    expect(field(`Price (${currency})`).value).toBe('')
    expect(host.textContent).not.toContain('Shop currency')
    expect(host.textContent).not.toContain('Local demo')
    expect(host.textContent).not.toContain('Nothing is uploaded or published')
    expect(host.querySelector('select option[value="USD"], select option[value="ETH"]')).toBeNull()
    expect(onSave).not.toHaveBeenCalled()
  })

  it('requires review, then passes normalized metadata and inherited currency to the transaction flow', async () => {
    const item = newDemoShopItem()
    await mount('ETH', item)
    await change(field('Item name'), '  Weekend stay  ')
    await change(field('Price (ETH)'), '0.025')
    await change(field('Description (optional)'), '  Two nights in the guest room.  ')
    await click('More options ↓')
    await change(field('Category'), '  Stays  ')
    await review()

    expect(host.textContent).toContain('Review shop items')
    expect(host.querySelector('.ds-review-price')?.textContent).toBe('0.025 ETH')
    expect(host.textContent).not.toContain('Local demo')
    expect(onSave).not.toHaveBeenCalled()
    await click('Continue to transaction')

    expect(onSave).toHaveBeenCalledExactlyOnceWith([
      { ...item, name: 'Weekend stay', description: 'Two nights in the guest room.', category: 'Stays', price: '0.025' },
    ], 'ETH')
    expect(item.name).toBe('')
  })

  it('blocks review when a price exceeds the inherited USD precision', async () => {
    await mount('USD', { ...newDemoShopItem(), name: 'Day pass', price: '0.0000001' })
    await review()
    expect(host.textContent).toContain('Enter a positive USD price with at most 6 decimal places.')
    expect(field('Price (USD)').getAttribute('aria-invalid')).toBe('true')
    expect(host.textContent).not.toContain('Continue to transaction')
    expect(onSave).not.toHaveBeenCalled()

    await change(field('Price (USD)'), '0.000001')
    await review()
    expect(host.textContent).toContain('Continue to transaction')
    expect(onSave).not.toHaveBeenCalled()
  })

  it('uses the existing shop decimals for validation and contract rounding in the review', async () => {
    await mount('USD', { ...newDemoShopItem(), name: 'Day pass', price: '0.001', discountPct: '50' }, 2)
    await review()
    expect(host.textContent).toContain('Enter a positive USD price with at most 2 decimal places.')
    expect(field('Price (USD)').getAttribute('aria-invalid')).toBe('true')
    expect(host.textContent).not.toContain('Continue to transaction')

    await change(field('Price (USD)'), '0.03')
    await review()
    expect(host.querySelector('.ds-review-price')?.textContent).toBe('0.02 USD')
    expect(host.textContent).toContain('Continue to transaction')
    expect(onSave).not.toHaveBeenCalled()
  })
})
