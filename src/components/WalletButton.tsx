'use client'

import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import Link from 'next/link'
import type { Address } from 'viem'
import { useAccountIdentity } from '@/hooks/useAccountIdentity'
import { useWallet } from '@/hooks/useWallet'
import { preloadParaHost } from '@/providers/preload-para'
import styles from './wallet-button.module.css'

function menuItems(menu: HTMLElement | null) {
  return Array.from(menu?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])
}

function SignedInWallet({ address, disconnect }: { address: Address; disconnect: () => void }) {
  const { label } = useAccountIdentity(address)
  const [open, setOpen] = useState(false)
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const containerRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const initialFocusRef = useRef<'first' | 'last'>('first')
  const menuId = useId()

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      setOpen(false)
      triggerRef.current?.focus()
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    const items = menuItems(menuRef.current)
    const first = initialFocusRef.current === 'last' ? items.at(-1) : items[0]
    first?.focus()
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  function openMenu(initialFocus: 'first' | 'last' = 'first') {
    initialFocusRef.current = initialFocus
    setCopyState('idle')
    setOpen(true)
  }

  function closeMenu() {
    setOpen(false)
    triggerRef.current?.focus()
  }

  function onMenuKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const items = menuItems(menuRef.current)
    const index = items.indexOf(document.activeElement as HTMLElement)
    let next: number
    switch (event.key) {
      case 'ArrowDown': next = (index + 1) % items.length; break
      case 'ArrowUp': next = (index - 1 + items.length) % items.length; break
      case 'Home': next = 0; break
      case 'End': next = items.length - 1; break
      default: return
    }
    event.preventDefault()
    items[next]?.focus()
  }

  async function copyAddress() {
    try {
      await navigator.clipboard.writeText(address)
      setCopyState('copied')
    } catch {
      setCopyState('failed')
    }
  }

  return (
    <div
      className={styles.container}
      ref={containerRef}
      onBlur={event => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false)
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        className={styles.trigger}
        aria-label={`Signed in as ${label}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => open ? setOpen(false) : openMenu()}
        onKeyDown={event => {
          if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
          event.preventDefault()
          openMenu(event.key === 'ArrowUp' ? 'last' : 'first')
        }}
      >
        <span className={styles.headline}>
          <span className={styles.statusDot} aria-hidden="true" />
          Signed in
        </span>
        <span className={styles.identity} title={address}>{label}</span>
      </button>
      {open && (
        <div
          ref={menuRef}
          id={menuId}
          role="menu"
          aria-label="Account options"
          className={styles.menu}
          onKeyDown={onMenuKeyDown}
        >
          <Link href={`/account/${address}`} role="menuitem" tabIndex={-1} className={styles.item} onClick={closeMenu}>
            View account
          </Link>
          <Link href="/projects" role="menuitem" tabIndex={-1} className={styles.item} onClick={closeMenu}>
            Your projects
          </Link>
          <button type="button" role="menuitem" tabIndex={-1} className={styles.item} onClick={copyAddress}>
            {copyState === 'copied' ? 'Address copied' : 'Copy address'}
          </button>
          {copyState === 'failed' && <p role="status" className={styles.copyError}>Couldn’t copy the address. You can copy it from your account.</p>}
          <div role="separator" className={styles.separator} />
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            className={styles.item}
            onClick={() => {
              closeMenu()
              disconnect()
            }}
          >
            Sign out
          </button>
        </div>
      )}
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
    return <SignedInWallet key={address.toLowerCase()} address={address} disconnect={disconnect} />
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
      Sign in
    </button>
  )
}
