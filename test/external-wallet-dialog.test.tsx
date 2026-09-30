import './dialog-shim'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ExternalWalletDialog } from '@/providers/ExternalWalletDialog'

// The dialog is rendered with the SDK's own modal and connect controller, so this exercises what a visitor sees.
// Only the wagmi hook and the site's Signa configuration are replaced.
type FakeConnector = { id: string; name: string; icon?: string; emitter: { on: ReturnType<typeof vi.fn>; off: ReturnType<typeof vi.fn> } }
const mocks = vi.hoisted(() => ({ connectors: [] as unknown[], connectWith: vi.fn() }))
vi.mock('@/hooks/useWallet', () => ({
  useWallet: () => ({ connectors: mocks.connectors, connectWith: mocks.connectWith, isConnected: false }),
}))
vi.mock('@/providers/wallet-config', () => ({ CENTER_WALLET_CONFIG: null, CENTER_WALLET_ENABLED: false }))

const connector = (id: string, name: string, icon?: string): FakeConnector => ({ id, name, icon, emitter: { on: vi.fn(), off: vi.fn() } })

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

const tile = (name: string) => [...host.querySelectorAll<HTMLButtonElement>('.jb-connect-tile')].find(item => item.getAttribute('aria-label') === name)!

describe('the wallet chooser', () => {
  it('shows only inline images as wallet icons: a remote icon would tell its host about the visit', async () => {
    mocks.connectors = [
      connector('io.rabby', 'Rabby', 'data:image/svg+xml;base64,PHN2Zy8+'),
      connector('metamask', 'MetaMask', 'data:image/svg+xml,%3Csvg%2F%3E'),
      connector('sneaky', 'Sneaky', 'https://tracker.example/icon.png'),
      connector('script', 'Script', 'data:text/html;base64,PHNjcmlwdD48L3NjcmlwdD4='),
      connector('js', 'Js', 'javascript:alert(1)'),
      connector('plain', 'Plain'),
    ]
    await act(async () => root.render(<ExternalWalletDialog onClose={vi.fn()} />))

    expect(tile('Rabby').querySelector('img')!.getAttribute('src')).toBe('data:image/svg+xml;base64,PHN2Zy8+')
    expect(tile('MetaMask').querySelector('img')!.getAttribute('src')).toBe('data:image/svg+xml,%3Csvg%2F%3E')
    for (const name of ['Sneaky', 'Script', 'Js', 'Plain']) {
      expect(tile(name).querySelector('img'), name).toBeNull()
      expect(tile(name).querySelector('svg')!.getAttribute('aria-hidden'), name).toBe('true')
    }
    expect(host.innerHTML).not.toContain('tracker.example')
    expect(host.innerHTML).not.toContain('javascript:')
    expect(host.innerHTML).not.toContain('text/html')
  })

  // An icon is drawn when it starts with one of these image types and then `;` or `,`, whatever the case. Nothing else is.
  const iconTile = async (icon: string) => {
    mocks.connectors = [connector('probe', 'Probe', icon)]
    await act(async () => root.render(<ExternalWalletDialog onClose={vi.fn()} />))
    return tile('Probe')
  }

  it.each([
    ['a PNG', 'data:image/png;base64,iVBORw0KGgo='],
    ['a WebP', 'data:image/webp;base64,UklGRg=='],
    ['a JPEG', 'data:image/jpeg;base64,/9j/4AAQ'],
    ['a GIF', 'data:image/gif;base64,R0lGODlh'],
    ['a scheme and image type in capitals', 'DATA:IMAGE/PNG;base64,iVBORw0KGgo='],
  ])('draws %s', async (_name, icon) => {
    expect((await iconTile(icon)).querySelector('img')!.getAttribute('src')).toBe(icon)
  })

  it.each([
    ['image/jpg, which the list spells jpeg', 'data:image/jpg;base64,/9j/4AAQ'],
    ['an image type the list leaves out', 'data:image/x-icon;base64,AAABAA=='],
    ['an SVG type with no payload after it', 'data:image/svg+xml'],
  ])('draws the generic mark for %s', async (_name, icon) => {
    const shown = await iconTile(icon)
    expect(shown.querySelector('img')).toBeNull()
    expect(shown.querySelector('svg')!.getAttribute('aria-hidden')).toBe('true')
  })

  it('lists wallets named like Safe, and offers Safe itself only inside Safe{Wallet}', async () => {
    mocks.connectors = [connector('safe', 'Safe'), connector('app.safepal', 'SafePal Wallet'), connector('injected', 'SafePal')]
    await act(async () => root.render(<ExternalWalletDialog onClose={vi.fn()} />))

    expect(tile('SafePal Wallet')).toBeTruthy()
    expect(tile('SafePal')).toBeTruthy()
    // This page is not framed by Safe{Wallet}, so the Safe app connector cannot connect here.
    expect(tile('Safe')).toBeUndefined()
  })
})
