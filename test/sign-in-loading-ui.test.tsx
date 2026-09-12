import React, { act, useEffect, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import './dialog-shim'

const runtime = vi.hoisted(() => ({ ready: false, renderAuth: vi.fn() }))

vi.mock('@getpara/react-component-library', () => ({
  PortalContainerProvider: ({ children }: { children: ReactNode }) => children,
}))
vi.mock('@getpara/react-sdk-lite', () => ({
  // Para withholds its descendants until initialization finishes. Keeping
  // Driver unmounted is essential to reproduce cancellation during loading.
  ParaProvider: ({ children }: { children: ReactNode }) => runtime.ready ? children : null,
}))
vi.mock('@getpara/web-sdk', () => ({
  Network: {}, OnRampAsset: {}, OnRampProvider: {}, OnRampPurchaseType: {},
}))
vi.mock('wagmi', () => ({ useAccount: () => ({}), useConnectors: () => [] }))
vi.mock('@/providers/para-config', () => ({
  getParaClient: () => ({}),
  PARA_APP: { appName: 'Homerun' },
  PARA_ONRAMP_PROVIDER: 'COINBASE',
  recordOnRampPurchase: vi.fn(),
}))
vi.mock('@/providers/ParaAuthSheet', () => ({
  default: function AuthSheet({ onClose }: { onClose: () => void }) {
    runtime.renderAuth()
    useEffect(() => {
      const onKeyDown = (event: KeyboardEvent) => {
        if (event.key === 'Escape') onClose()
      }
      document.addEventListener('keydown', onKeyDown)
      return () => document.removeEventListener('keydown', onKeyDown)
    }, [onClose])
    return <button data-testid="live-auth-sheet" onClick={onClose}>Close live sign in</button>
  },
}))

import ParaModalHost from '@/providers/ParaModalHost'
import { SignInPlaceholder } from '@/providers/SignInPlaceholder'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  runtime.ready = false
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

function dialog() {
  const host = document.querySelector<HTMLDialogElement>('dialog.ui-modal-host')
  expect(host).not.toBeNull()
  return host!
}

function closeButton(host: HTMLDialogElement) {
  const button = host.querySelector<HTMLButtonElement>('button[aria-label="Close sign in"]')
  expect(button).not.toBeNull()
  expect(button!.disabled).toBe(false)
  return button!
}

describe('sign-in while its runtime loads', () => {
  it('lets Escape cancel the download placeholder and exposes an enabled close control', async () => {
    const onClose = vi.fn()
    await act(async () => root.render(
      <SignInPlaceholder entry="owner@example.com" onEntryChange={vi.fn()} onClose={onClose} />,
    ))
    const host = dialog()
    expect(host.open).toBe(true)
    closeButton(host)
    expect(host.querySelector<HTMLInputElement>('input')!.value).toBe('owner@example.com')

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(onClose).toHaveBeenCalledTimes(1)

    // The parent removes the lazy-load placeholder when the request is canceled.
    await act(async () => root.render(null))
    expect(document.querySelector('dialog.ui-modal-host')).toBeNull()
  })

  it('routes the placeholder close button through the current cancellation callback', async () => {
    const previousClose = vi.fn()
    const currentClose = vi.fn()
    await act(async () => root.render(
      <SignInPlaceholder entry="" onEntryChange={vi.fn()} onClose={previousClose} />,
    ))
    await act(async () => root.render(
      <SignInPlaceholder entry="" onEntryChange={vi.fn()} onClose={currentClose} />,
    ))
    await act(async () => closeButton(dialog()).click())
    expect(previousClose).not.toHaveBeenCalled()
    expect(currentClose).toHaveBeenCalledTimes(1)
  })

  it.each(['native cancel', 'close button'] as const)(
    'cancels the initialization shell through %s without reopening when the SDK becomes ready',
    async gesture => {
      const onCancelRequest = vi.fn()
      const onOpenChange = vi.fn()
      const onSettled = vi.fn()
      const onEntryChange = vi.fn()
      const renderHost = (requestId: number, cancelledThrough: number) => root.render(
        <ParaModalHost
          requestId={requestId}
          request={{ kind: 'auth' }}
          cancelledThrough={cancelledThrough}
          onCancelRequest={onCancelRequest}
          onOpenChange={onOpenChange}
          onSettled={onSettled}
          entry="owner@example.com"
          onEntryChange={onEntryChange}
        />,
      )

      await act(async () => renderHost(1, 0))
      const host = dialog()
      expect(host.open).toBe(true)
      expect(runtime.renderAuth).not.toHaveBeenCalled()
      expect(host.querySelector<HTMLInputElement>('input')!.value).toBe('owner@example.com')
      await act(async () => {
        if (gesture === 'native cancel') {
          const event = new Event('cancel', { cancelable: true })
          host.dispatchEvent(event)
          expect(event.defaultPrevented).toBe(true)
        } else closeButton(host).click()
      })
      expect(onCancelRequest).toHaveBeenCalledTimes(1)

      await act(async () => renderHost(1, 1))
      expect(host.open).toBe(false)
      expect(host.querySelector('input')).toBeNull()
      runtime.ready = true
      await act(async () => renderHost(1, 1))
      expect(host.open).toBe(false)
      expect(host.querySelector('[data-testid="live-auth-sheet"]')).toBeNull()
      expect(runtime.renderAuth).not.toHaveBeenCalled()

      // Dismissal only invalidates the canceled request, so a later explicit
      // sign-in still opens against the now-initialized provider.
      await act(async () => renderHost(2, 1))
      expect(host.open).toBe(true)
      expect(host.querySelector('[data-testid="live-auth-sheet"]')).not.toBeNull()
      expect(onOpenChange).toHaveBeenLastCalledWith(true)

      const nativeCancel = new Event('cancel', { cancelable: true })
      await act(async () => { host.dispatchEvent(nativeCancel) })
      expect(nativeCancel.defaultPrevented).toBe(true)
      expect(onCancelRequest).toHaveBeenCalledTimes(1)
      expect(host.open).toBe(true)

      // Once initialized, the auth sheet owns Escape and reports its close
      // through Driver; a native dialog close must not bypass that path.
      await act(async () => {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      })
      expect(host.open).toBe(false)
      expect(onOpenChange).toHaveBeenLastCalledWith(false)
      expect(onSettled).toHaveBeenCalledTimes(1)
      expect(onCancelRequest).toHaveBeenCalledTimes(1)
    },
  )

  it('keeps SDK warm-up hidden until a user explicitly requests sign-in', async () => {
    const props = {
      cancelledThrough: 0,
      onCancelRequest: vi.fn(),
      onOpenChange: vi.fn(),
      onSettled: vi.fn(),
      entry: '',
      onEntryChange: vi.fn(),
    }
    await act(async () => root.render(<ParaModalHost {...props} requestId={0} request={{ kind: 'auth' }} />))
    const host = dialog()
    expect(host.open).toBe(false)
    expect(host.querySelector('input')).toBeNull()

    runtime.ready = true
    await act(async () => root.render(<ParaModalHost {...props} requestId={0} request={{ kind: 'auth' }} />))
    expect(host.open).toBe(false)
    expect(runtime.renderAuth).not.toHaveBeenCalled()
    await act(async () => root.render(<ParaModalHost {...props} requestId={1} request={{ kind: 'auth' }} />))
    expect(host.open).toBe(true)
    expect(host.querySelector('[data-testid="live-auth-sheet"]')).not.toBeNull()
  })
})
