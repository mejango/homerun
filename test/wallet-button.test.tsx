import { act, type AnchorHTMLAttributes } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Address } from 'viem'

const ADDRESS_A = '0x1111111111111111111111111111111111111111' as const
const ADDRESS_B = '0x2222222222222222222222222222222222222222' as const
const runtime = vi.hoisted(() => ({
  wallet: { address: undefined as Address | undefined, isConnected: false },
  disconnect: vi.fn(),
  openSignIn: vi.fn(),
  preload: vi.fn(),
  ensName: undefined as string | null | undefined,
  ensQuery: vi.fn(),
}))

vi.mock('@/hooks/useWallet', () => ({ useWallet: () => ({
  ...runtime.wallet, disconnect: runtime.disconnect, openSignIn: runtime.openSignIn,
}) }))
vi.mock('@/providers/preload-para', () => ({ preloadParaHost: runtime.preload }))
vi.mock('@/providers/Providers', () => ({ IS_DETERMINISTIC_BROWSER: false }))
vi.mock('wagmi', () => ({ useEnsName: (query: unknown) => {
  runtime.ensQuery(query)
  return { data: runtime.ensName }
} }))
vi.mock('next/link', () => ({ default: (props: AnchorHTMLAttributes<HTMLAnchorElement>) => <a {...props} /> }))

import { WalletButton } from '@/components/WalletButton'

let host: HTMLDivElement
let root: Root
let clipboard: ReturnType<typeof vi.fn>

beforeEach(() => {
  runtime.wallet = { address: ADDRESS_A, isConnected: true }
  runtime.ensName = undefined
  clipboard = vi.fn().mockResolvedValue(undefined)
  vi.stubGlobal('navigator', Object.assign(Object.create(navigator), { clipboard: { writeText: clipboard } }))
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
})

async function render() {
  await act(async () => root.render(<WalletButton />))
}

function trigger() {
  return host.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!
}

function menu() {
  return host.querySelector<HTMLDivElement>('[role="menu"]')
}

function item(text: string) {
  return [...host.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(node => node.textContent === text)!
}

async function press(target: EventTarget, key: string) {
  await act(async () => target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })))
}

describe('signed-in account menu', () => {
  it('collapses the header to a single signed-in button and resolves ENS on Ethereum', async () => {
    await render()
    expect(host.querySelectorAll('button')).toHaveLength(1)
    expect(host.querySelector('a')).toBeNull()
    expect(trigger().textContent).toBe('Signed in0x1111…1111')
    expect(trigger().getAttribute('aria-expanded')).toBe('false')
    expect(runtime.ensQuery).toHaveBeenCalledWith(expect.objectContaining({ address: ADDRESS_A, chainId: 1 }))

    runtime.ensName = 'susy.eth'
    await render()
    expect(trigger().textContent).toBe('Signed insusy.eth')
    expect(trigger().getAttribute('aria-label')).toBe('Signed in as susy.eth')
    expect(trigger().querySelector('[title]')?.getAttribute('title')).toBe(ADDRESS_A)

    runtime.ensName = null
    await render()
    expect(trigger().textContent).toContain('0x1111…1111')
  })

  it('opens account options, focuses the first option, and closes after navigation', async () => {
    await render()
    await act(async () => trigger().click())
    expect(trigger().getAttribute('aria-controls')).toBe(menu()!.id)
    expect(trigger().getAttribute('aria-expanded')).toBe('true')
    expect(item('View account').getAttribute('href')).toBe(`/account/${ADDRESS_A}`)
    expect(item('Your projects').getAttribute('href')).toBe('/projects')
    expect(document.activeElement).toBe(item('View account'))

    host.addEventListener('click', event => event.preventDefault(), { once: true })
    await act(async () => item('View account').click())
    expect(menu()).toBeNull()
    expect(document.activeElement).toBe(trigger())
  })

  it('supports arrow keys, Home, End, and Escape with focus restored to the button', async () => {
    await render()
    await press(trigger(), 'ArrowUp')
    expect(document.activeElement).toBe(item('Sign out'))
    await press(document.activeElement!, 'ArrowDown')
    expect(document.activeElement).toBe(item('View account'))
    await press(document.activeElement!, 'ArrowUp')
    expect(document.activeElement).toBe(item('Sign out'))
    await press(document.activeElement!, 'Home')
    expect(document.activeElement).toBe(item('View account'))
    await press(document.activeElement!, 'End')
    expect(document.activeElement).toBe(item('Sign out'))
    await press(document.activeElement!, 'Escape')
    expect(menu()).toBeNull()
    expect(document.activeElement).toBe(trigger())
    await press(trigger(), 'ArrowDown')
    expect(document.activeElement).toBe(item('View account'))
  })

  it('dismisses on an outside pointer or when focus leaves the account options', async () => {
    await render()
    await act(async () => trigger().click())
    await act(async () => document.body.dispatchEvent(new Event('pointerdown', { bubbles: true })))
    expect(menu()).toBeNull()

    const outside = document.createElement('button')
    document.body.append(outside)
    await act(async () => trigger().click())
    await act(async () => outside.focus())
    expect(menu()).toBeNull()
    expect(document.activeElement).toBe(outside)
    outside.remove()
  })

  it('copies the connected address and resets confirmation when reopened', async () => {
    await render()
    await act(async () => trigger().click())
    await act(async () => item('Copy address').click())
    expect(clipboard).toHaveBeenCalledExactlyOnceWith(ADDRESS_A)
    expect(item('Address copied')).toBeDefined()
    await press(document.activeElement!, 'Escape')
    await act(async () => trigger().click())
    expect(item('Copy address')).toBeDefined()
  })

  it('keeps account navigation available if the clipboard is unavailable', async () => {
    clipboard.mockRejectedValue(new Error('Clipboard unavailable'))
    await render()
    await act(async () => trigger().click())
    await act(async () => item('Copy address').click())
    expect(menu()!.querySelector('[role="status"]')?.textContent).toContain('Couldn’t copy')
    expect(item('View account').getAttribute('href')).toBe(`/account/${ADDRESS_A}`)
  })

  it('discards the old menu and identity when the connected account changes', async () => {
    runtime.ensName = 'first.eth'
    await render()
    await act(async () => trigger().click())
    runtime.wallet = { address: ADDRESS_B, isConnected: true }
    runtime.ensName = undefined
    await render()
    expect(menu()).toBeNull()
    expect(trigger().textContent).toContain('0x2222…2222')
    expect(host.textContent).not.toContain('first.eth')
    await act(async () => trigger().click())
    expect(item('View account').getAttribute('href')).toBe(`/account/${ADDRESS_B}`)
    await act(async () => item('Copy address').click())
    expect(clipboard).toHaveBeenCalledExactlyOnceWith(ADDRESS_B)
  })

  it('signs out through the existing wallet runtime and removes connected options', async () => {
    await render()
    await act(async () => trigger().click())
    await act(async () => item('Sign out').click())
    expect(runtime.disconnect).toHaveBeenCalledTimes(1)
    expect(menu()).toBeNull()
    runtime.wallet = { address: undefined, isConnected: false }
    await render()
    expect(host.textContent).toBe('Sign in')
    expect(trigger()).toBeNull()
  })

  it('preserves direct sign-in and Para preload on pointer, keyboard, and touch', async () => {
    runtime.wallet = { address: undefined, isConnected: false }
    await render()
    const signIn = host.querySelector('button')!
    await act(async () => signIn.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })))
    await act(async () => signIn.focus())
    await act(async () => signIn.dispatchEvent(new Event('touchstart', { bubbles: true })))
    expect(runtime.preload).toHaveBeenCalledTimes(3)
    await act(async () => signIn.click())
    expect(runtime.openSignIn).toHaveBeenCalledTimes(1)
    expect(runtime.ensQuery).not.toHaveBeenCalled()
  })
})
