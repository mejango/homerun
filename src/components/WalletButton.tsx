'use client'

import { type RefObject, useEffect, useRef, useState } from 'react'
import { lazyComponent } from '@/components/lazy-component'
import type { Address } from 'viem'
import { useWallet } from '@/hooks/useWallet'
import { preloadSignIn } from '@/providers/preload-center'
import styles from './wallet-button.module.css'

// The account menu and its ENS lookup load once a wallet is connected; until then the trigger shows the short address.
const SignedInWallet = lazyComponent(() => import('./SignedInWallet').then(module => module.SignedInWallet), {
  fallback: ({ address, pressRef }) => <SignedInPlaceholder address={address} pressRef={pressRef} />,
})

/** What the visitor did to the placeholder trigger, so the loaded menu keeps focus and opens if it was pressed. */
export type PlaceholderPress = { focused: boolean; pressed: boolean }

function SignedInPlaceholder({ address, pressRef }: { address: Address; pressRef: RefObject<PlaceholderPress> }) {
  return (
    <div className={styles.container}>
      <button type="button" className={styles.trigger} aria-label="Signed in" aria-busy="true"
        onFocus={() => { pressRef.current.focused = true }} onBlur={() => { pressRef.current = { focused: false, pressed: false } }}
        onClick={() => { pressRef.current.pressed = true }}>
        <span className={styles.headline}>
          <span className={styles.statusDot} aria-hidden="true" />
          Signed in
        </span>
        <span className={styles.identity} title={address}>{`${address.slice(0, 6)}…${address.slice(-4)}`}</span>
      </button>
    </div>
  )
}

/** A small Homerun shell around the reference apps' shared wallet runtime. */
export function WalletButton() {
  const { address, isConnected, openSignIn, disconnect, signInPending } = useWallet()
  const pressRef = useRef<PlaceholderPress>({ focused: false, pressed: false })
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])

  if (mounted && isConnected && address) {
    // Account changes discard the old menu and its address-dependent state.
    return (
      <SignedInWallet key={address.toLowerCase()} address={address} disconnect={disconnect} pressRef={pressRef} />
    )
  }

  return (
    <button
      type="button"
      onClick={openSignIn}
      onMouseEnter={preloadSignIn}
      onFocus={preloadSignIn}
      onTouchStart={preloadSignIn}
      aria-busy={signInPending || undefined}
      className="btn-primary min-h-11 px-5 text-sm"
    >
      {signInPending ? 'Opening…' : 'Sign in'}
    </button>
  )
}
