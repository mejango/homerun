import { StrictMode, act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/components/ui/ModalShell', () => ({ ModalShell: ({ title, children, footer, onClose }: { title: ReactNode; children: ReactNode; footer: ReactNode; onClose: () => void }) => <div role="dialog"><h2>{title}</h2><button type="button" aria-label="Close" onClick={onClose}>Close</button>{children}{footer}</div> }))
import { DemoProjectShop } from '../src/components/DemoProjectShop'
import { demoShopStorageKey, newDemoShopItem } from '../src/lib/demo-shop'

let root: Root
let host: HTMLDivElement
const key = demoShopStorageKey('test-project')
function button(label: string): HTMLButtonElement {
  const result = Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find(element => !element.closest('[hidden]') && (element.getAttribute('aria-label') === label || element.textContent?.trim() === label))
  if (!result) throw new Error(`Missing button: ${label}`)
  return result
}
function field(label: string): HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement {
  const labels = Array.from(host.querySelectorAll<HTMLLabelElement>('label'))
  const node = labels.find(element => element.textContent?.trim() === label)
  if (!node) throw new Error(`Missing label: ${label}`)
  return (node.htmlFor ? document.getElementById(node.htmlFor) : node.querySelector('input,textarea,select')) as HTMLInputElement
}
async function click(label: string) { await act(async () => button(label).click()) }
async function change(element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) {
  await act(async () => {
    const proto = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(element, value)
    element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }))
  })
}
async function mount(resetKey = 0, strict = false) { await act(async () => root.render(strict ? <StrictMode><DemoProjectShop projectKey="test-project" resetKey={resetKey} /></StrictMode> : <DemoProjectShop projectKey="test-project" resetKey={resetKey} />)) }
async function review() { await act(async () => host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))) }
async function fillBasic(name = 'Community day pass') {
  await change(field('Item name'), name)
  await change(field('Price (USD)'), '25')
  await change(field('Quantity'), '30')
}
beforeEach(() => {
  localStorage.clear()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 1 })
  vi.stubGlobal('CSS', { escape: (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, '\\$&') })
  HTMLElement.prototype.scrollIntoView = vi.fn()
})
afterEach(async () => { await act(async () => root.unmount()); host.remove() })

describe('demo shop editor', () => {
  it('requires review before an item becomes inventory, then restores the saved shop', async () => {
    await mount()
    await click('Add your first item')
    await fillBasic()
    await review()
    expect(host.textContent).toContain('Review shop items')
    expect(localStorage.getItem(key)).toBeNull()
    expect(host.querySelector('.ds-item-card')).toBeNull()
    await click('Add item to demo shop')
    expect(host.querySelector('.ds-item-card')?.textContent).toContain('Community day pass')
    expect(JSON.parse(localStorage.getItem(key)!).items[0]).toMatchObject({ name: 'Community day pass', price: '25', supply: '30' })
    await act(async () => root.unmount())
    root = createRoot(host)
    await mount()
    expect(host.querySelector('.ds-item-card')?.textContent).toContain('Community day pass')
  })

  it('shows validation and opens invalid advanced options before a review is possible', async () => {
    await mount()
    await click('Add items for sale')
    await review()
    expect(host.textContent).toContain('Enter an item name.')
    expect(host.textContent).toContain('Enter a positive USD price')
    await fillBasic()
    await click('More options ↓')
    await change(field('1 of every'), '4')
    await click('Fewer options ↑')
    await review()
    expect(host.textContent).toContain('Enter a nonzero wallet address for reserved items.')
    expect(button('Fewer options ↑').getAttribute('aria-expanded')).toBe('true')
    expect(localStorage.getItem(key)).toBeNull()
  })

  it('keeps existing items unchanged until edited settings are reviewed and saved', async () => {
    const item = { ...newDemoShopItem(), name: 'Day pass', price: '25' }
    localStorage.setItem(key, JSON.stringify({ version: 1, currency: 'USD', items: [item] }))
    await mount()
    await click('Edit Day pass')
    expect((field('Shop currency') as HTMLSelectElement).disabled).toBe(true)
    await change(field('Price (USD)'), '30')
    await review()
    expect(JSON.parse(localStorage.getItem(key)!).items[0].price).toBe('25')
    await click('Save demo changes')
    expect(JSON.parse(localStorage.getItem(key)!).items[0].price).toBe('30')
    await click('Remove Day pass')
    expect(host.textContent).toContain('Remove Day pass?')
    expect(JSON.parse(localStorage.getItem(key)!).items).toHaveLength(1)
    await click('Remove demo item')
    expect(JSON.parse(localStorage.getItem(key)!).items).toHaveLength(0)
  })

  it('discards unsaved drafts without touching inventory', async () => {
    await mount()
    await click('Add items for sale')
    await fillBasic()
    await click('Cancel')
    expect(host.textContent).toContain('Discard your changes?')
    await click('Keep editing')
    expect(field('Item name').value).toBe('Community day pass')
    await click('Cancel')
    expect(Array.from(host.querySelectorAll('button')).some(button => button.textContent === 'Discard changes')).toBe(false)
    await click('Close')
    expect(host.querySelector('[role=dialog]')).toBeNull()
    expect(localStorage.getItem(key)).toBeNull()
  })

  it('reads uploaded media under StrictMode and saves it after review', async () => {
    await mount(0, true)
    await click('Add items for sale')
    await fillBasic()
    const input = host.querySelector<HTMLInputElement>('input[type=file]')!
    await act(async () => {
      Object.defineProperty(input, 'files', { configurable: true, value: [new File(['image'], 'day-pass.png', { type: 'image/png' })] })
      input.dispatchEvent(new Event('change', { bubbles: true }))
      await new Promise(resolve => setTimeout(resolve, 25))
    })
    expect(host.querySelector('.ds-media-field img')?.getAttribute('src')).toBe('data:image/png;base64,aW1hZ2U=')
    expect(button('Review items').disabled).toBe(false)
    await review()
    await click('Add item to demo shop')
    expect(JSON.parse(localStorage.getItem(key)!).items[0].media).toEqual({ name: 'day-pass.png', type: 'image/png', url: 'data:image/png;base64,aW1hZ2U=' })
  })

  it('accepts incremental media URL typing and rejects unsafe URL schemes', async () => {
    await mount()
    await click('Add items for sale')
    await fillBasic()
    await click('Use a media URL')
    await change(field('Media URL'), 'h')
    expect(field('Media URL').value).toBe('h')
    await change(field('Media URL'), 'javascript:alert(1)')
    await review()
    expect(host.textContent).toContain('Use HTTPS media')
    expect(localStorage.getItem(key)).toBeNull()
    await change(field('Media URL'), 'https://example.com/image.png')
    await review()
    expect(host.textContent).toContain('Review shop items')
  })

  it('resets only after resetKey changes, not when mounting with a nonzero resetKey', async () => {
    const item = { ...newDemoShopItem(), name: 'Day pass', price: '25' }
    localStorage.setItem(key, JSON.stringify({ version: 1, currency: 'USD', items: [item] }))
    await mount(4)
    expect(host.querySelector('.ds-item-card')).not.toBeNull()
    await mount(5)
    expect(host.querySelector('.ds-item-card')).toBeNull()
    expect(localStorage.getItem(key)).toBeNull()
  })

  it('keeps session previews usable and explains when storage is unavailable', async () => {
    await mount()
    await click('Add items for sale')
    await fillBasic()
    await review()
    vi.spyOn(Storage.prototype, 'setItem').mockImplementationOnce(() => { throw new Error('QuotaExceededError') })
    await click('Add item to demo shop')
    expect(host.querySelector('.ds-item-card')).not.toBeNull()
    expect(host.querySelector('[role=status]')?.textContent).toContain('these changes last only for this visit')
  })

  it('limits new drafts to the remaining saved inventory slots', async () => {
    const items = Array.from({ length: 99 }, (_, index) => ({ ...newDemoShopItem(), name: `Item ${index + 1}`, price: '25' }))
    localStorage.setItem(key, JSON.stringify({ version: 1, currency: 'USD', items }))
    await mount()
    await click('Add items for sale')
    expect(button('＋ Add an item').disabled).toBe(true)
    expect(host.textContent).toContain('This demo has room for 1 more item.')
    await fillBasic()
    await review()
    await click('Add item to demo shop')
    expect(JSON.parse(localStorage.getItem(key)!).items).toHaveLength(100)
    expect(button('Add items for sale').disabled).toBe(true)
  })
})
