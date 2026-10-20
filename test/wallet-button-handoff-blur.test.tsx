import { act, type AnchorHTMLAttributes } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const runtime = vi.hoisted(() => {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  return { gate, release: () => release() }
})

vi.mock('@/hooks/useWallet', () => ({ useWallet: () => ({
  address: '0x1111111111111111111111111111111111111111', isConnected: true, disconnect: vi.fn(), openSignIn: vi.fn(), signInPending: false,
}) }))
vi.mock('@/providers/preload-center', () => ({ preloadSignIn: vi.fn() }))
vi.mock('@/hooks/useAccountIdentity', () => ({ useAccountIdentity: () => ({ label: '0x1111…1111' }) }))
vi.mock('next/link', () => ({ default: (props: AnchorHTMLAttributes<HTMLAnchorElement>) => <a {...props} /> }))
vi.mock('@/components/SignedInWallet', async importOriginal => {
  await runtime.gate
  return importOriginal()
})

import { WalletButton } from '@/components/WalletButton'

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
})

// Its own file: the account menu's code must still be loading when the test starts, and a module loads once per file.
describe('account menu loading after connect', () => {
  it('drops a press once focus moves on before the menu loads', async () => {
    const elsewhere = document.createElement('button')
    document.body.append(elsewhere)
    await act(async () => root.render(<WalletButton />))
    const placeholder = host.querySelector<HTMLButtonElement>('button[aria-busy="true"]')!
    act(() => placeholder.focus())
    act(() => placeholder.click())
    act(() => elsewhere.focus())

    await act(async () => runtime.release())
    await vi.waitFor(() => expect(host.querySelector('button[aria-haspopup="menu"]')).not.toBeNull())
    expect(host.querySelector('button[aria-haspopup="menu"]')!.getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(elsewhere)
    elsewhere.remove()
  })
})
