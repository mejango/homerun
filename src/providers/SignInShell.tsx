'use client'

import type { TOAuthMethod } from '@getpara/web-sdk'
import { useConnectors } from 'wagmi'
import { BrandMark, WalletFallbackMark } from '@/components/BrandMarks'
import { offerableWallets } from '@/lib/wallet-list'

/** Kept in step with the sheet's own list. */
const OAUTH_METHODS: { method: TOAuthMethod; label: string }[] = [
  { method: 'GOOGLE', label: 'Google' },
  { method: 'TWITTER', label: 'X' },
  { method: 'APPLE', label: 'Apple' },
  { method: 'DISCORD', label: 'Discord' },
  { method: 'FARCASTER', label: 'Farcaster' },
  { method: 'TELEGRAM', label: 'Telegram' },
  { method: 'FACEBOOK', label: 'Facebook' },
]

/**
 * The sign-in sheet before Para can drive it.
 *
 * None of what you see here needs Para: the provider marks are inlined SVG
 * and the wallet marks come from EIP-6963 through wagmi, which is already
 * running. So this renders the real thing rather than grey boxes, and the
 * swap to the live sheet changes nothing visible.
 *
 * The field is genuinely editable, and its value lives above the boundary —
 * so an address typed during the wait is still there when the sheet takes
 * over, rather than being thrown away with this component.
 */
export function SignInShell({
  entry,
  onEntryChange,
}: {
  entry: string
  onEntryChange: (value: string) => void
}) {
  const connectors = offerableWallets(useConnectors())

  return (
    <div className="w-full">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="font-agrandir text-2xl font-medium text-ink">Sign in</h2>
          <p className="mt-1 text-sm text-smoke-700">Use your passkey, or receive a code.</p>
        </div>
      </div>

      <div className="mt-5">
        <input
          type="text"
          value={entry}
          onChange={event => onEntryChange(event.target.value)}
          placeholder="you@email.com | +1 222 333 4444"
          aria-label="Email address or phone number"
          autoComplete="email"
          autoFocus
          className="input-well w-full px-4 py-3"
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
      </div>

      <p className="mb-2 mt-5 text-xs text-smoke-500">Or, use socials</p>
      <div className="scroll-row flex gap-1.5 overflow-x-auto">
        {OAUTH_METHODS.map(({ method, label }) => (
          <button
            key={method}
            type="button"
            disabled
            title={label}
            aria-label={label}
            className="btn-secondary flex h-10 w-10 shrink-0 items-center justify-center !px-0 disabled:opacity-60"
          >
            <BrandMark method={method} className="h-5 w-5 shrink-0" />
          </button>
        ))}
      </div>

      <p className="mb-2 mt-4 text-xs text-smoke-500">... or, a wallet.</p>
      <div className="scroll-row flex min-h-10 gap-1.5 overflow-x-auto">
        {connectors.map(connector => (
          <button
            key={connector.id}
            type="button"
            disabled
            title={connector.name}
            aria-label={connector.name}
            className="btn-secondary flex h-10 w-10 shrink-0 items-center justify-center !px-0 disabled:opacity-60"
          >
            {connector.icon ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={connector.icon} alt="" className="h-5 w-5 shrink-0" />
            ) : (
              <WalletFallbackMark id={connector.id} className="h-5 w-5 shrink-0" />
            )}
          </button>
        ))}
      </div>
    </div>
  )
}
