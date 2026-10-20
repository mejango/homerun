'use client'

import { lazy, Suspense, useEffect, useState } from 'react'
import type { Address } from 'viem'
import { useWallet } from '@/hooks/useWallet'
import { preloadSignIn } from '@/providers/preload-center'
import styles from './wallet-button.module.css'

// The account menu and its ENS lookup load once a wallet is connected; until then the trigger shows the short address.
const SignedInWallet = lazy(() => import('./SignedInWallet').then(module => ({ default: module.SignedInWallet })))

function SignedInPlaceholder({ address }: { address: Address }) {
  return (
    <div className={styles.container}>
      <button type="button" className={styles.trigger} aria-label="Signed in" aria-busy="true">
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
  const { address, isConnected, openSignIn, disconnect } = useWallet()
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])

  if (mounted && isConnected && address) {
    // Account changes discard the old menu and its address-dependent state.
    return (
      <Suspense fallback={<SignedInPlaceholder address={address} />}>
        <SignedInWallet key={address.toLowerCase()} address={address} disconnect={disconnect} />
      </Suspense>
    )
  }

  return (
    <button
      type="button"
      onClick={openSignIn}
      onMouseEnter={preloadSignIn}
      onFocus={preloadSignIn}
      onTouchStart={preloadSignIn}
      className="btn-primary min-h-11 px-5 text-sm"
    >
      Sign in
    </button>
  )
}
