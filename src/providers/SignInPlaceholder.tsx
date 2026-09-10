'use client'

import { useEffect, useLayoutEffect, useState } from 'react'
import { createPortal } from 'react-dom'

/** Before paint, so the click is acknowledged in the frame it happened in. */
const useBeforePaint =
  typeof window === 'undefined' ? useEffect : useLayoutEffect

/**
 * Painted the instant sign-in is asked for, while Para's runtime downloads.
 *
 * That runtime is ~725 KiB gzipped and is deliberately not shipped to
 * anonymous visitors, so the first click has to fetch it — several seconds on
 * a slow connection. Rendering nothing until it lands makes the button feel
 * broken, so this stands in: the real sheet's opening, inert, in the same
 * frame, so the swap reads as filling in rather than as a jump.
 *
 * It owns a `showModal()` dialog for the same reason ParaModalHost does —
 * sign-in is reachable from inside other modals, and everything outside the
 * topmost one is inert.
 */
export function SignInPlaceholder({
  entry,
  onEntryChange,
}: {
  entry: string
  onEntryChange: (value: string) => void
}) {
  const [host] = useState<HTMLDialogElement | null>(() => {
    if (typeof document === 'undefined') return null
    const dialog = document.createElement('dialog')
    dialog.className = 'ui-modal-host'
    return dialog
  })

  useBeforePaint(() => {
    if (!host) return
    document.body.append(host)
    return () => host.remove()
  }, [host])

  // Opening is passive so this lands above any modal it was launched from,
  // which enters the top layer in its own passive effect.
  useEffect(() => {
    if (host && !host.open) host.showModal()
  }, [host])

  if (!host) return null

  return createPortal(
    <div className="flex h-full w-full items-center justify-center overflow-y-auto bg-slate-900/55 p-6">
      <div className="card w-full max-w-sm p-6">
        <div className="w-full">
          <h2 className="font-agrandir text-2xl font-medium text-ink">Sign in</h2>
          <p className="mt-1 text-sm text-smoke-700">Use your passkey, or receive a code.</p>
          <input
            type="text"
            value={entry}
            onChange={event => onEntryChange(event.target.value)}
            placeholder="you@email.com | +1 222 333 4444"
            aria-label="Email address or phone number"
            autoComplete="email"
            autoFocus
            className="input-well mt-5 w-full px-4 py-3"
          />
          <div className="mt-3 flex justify-end">
            <button
              type="button"
              disabled
              aria-busy="true"
              className="btn-primary h-10 px-5 text-sm disabled:opacity-60"
            >
              Continue
            </button>
          </div>
          {/* Labels and reserved rows, but no provider marks: this component
              is eager, and the marks would ride along on every page load for
              a panel most visitors never open. The full shell renders them a
              moment later, from Para's own chunk. */}
          {['Or, use socials', '... or, a wallet.'].map(label => (
            <div key={label}>
              <p className="mb-2 mt-4 text-xs text-smoke-500">
                {label}
              </p>
              <div className="min-h-10" />
            </div>
          ))}
        </div>
      </div>
    </div>,
    host,
  )
}
