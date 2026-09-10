'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useWallet } from '@/hooks/useWallet'
import { preloadParaHost } from '@/providers/preload-para'

/** A small Homerun shell around the reference apps' shared wallet runtime. */
export function WalletButton() {
  const { address, isConnected, openSignIn, disconnect } = useWallet()
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])

  if (mounted && isConnected && address) {
    return (
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <Link href="/projects" className="underline">Your projects</Link>
        <span title={address} aria-label={`Connected wallet ${address}`}>
          {address.slice(0, 6)}…{address.slice(-4)}
        </span>
        <button type="button" onClick={disconnect} className="btn-secondary min-h-11 px-4">Disconnect</button>
      </div>
    )
  }

  return (
    <button
      type="button"
      onClick={openSignIn}
      onMouseEnter={preloadParaHost}
      onFocus={preloadParaHost}
      onTouchStart={preloadParaHost}
      className="btn-primary min-h-11 px-5 text-sm"
    >
      Connect wallet
    </button>
  )
}
