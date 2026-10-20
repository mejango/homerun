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

describe('account menu loading after connect', () => {
  it('keeps focus on the trigger and opens the menu pressed while its code loaded', async () => {
    await act(async () => root.render(<WalletButton />))
    const placeholder = host.querySelector<HTMLButtonElement>('button[aria-busy="true"]')!
    act(() => placeholder.focus())
    act(() => placeholder.click())

    await act(async () => runtime.release())
    await vi.waitFor(() => expect(host.querySelector('button[aria-haspopup="menu"]')).not.toBeNull())
    const trigger = host.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!
    await vi.waitFor(() => expect(trigger.getAttribute('aria-expanded')).toBe('true'))
    expect(host.querySelector('[role="menu"]')?.contains(document.activeElement)).toBe(true)
  })
})
