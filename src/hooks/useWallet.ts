'use client'

import { useEffect, useRef } from 'react'
import type { Address } from 'viem'
import { useAccount, useConnect, useDisconnect } from 'wagmi'
import { IS_DETERMINISTIC_BROWSER } from '@/providers/Providers'
import { offerableWallets } from '@/lib/wallet-list'
import { PARA_AUTH_ENABLED } from '@/providers/wallet-config'
import { markParaSession, useParaAuth } from '@/providers/ParaAuthContext'

/**
 * Wallet state with wagmi as the single source of truth.
 *
 * - External wallets connect straight through wagmi connectors (see the
 *   `connectors` list — WalletButton renders them as options).
 * - Embedded (email/social) sign-in opens the Para modal; when the Para
 *   session appears, the bridge effect below connects wagmiConfig's `para`
 *   connector so the embedded wallet behaves like any other connection.
 */
export function useWallet() {
  const { address, isConnected } = useAccount()
  const { connectAsync, connectors } = useConnect()
  const { disconnect: wagmiDisconnect } = useDisconnect()
  const { modalOpen, requestSignIn, sessionVersion } = useParaAuth()
  const bridging = useRef(false)

  // Bridge a newly settled Para modal into wagmi. The dynamic import is
  // deliberately gated by sessionVersion so anonymous visits never initialize
  // Para's worker or session API.
  useEffect(() => {
    if (IS_DETERMINISTIC_BROWSER || !PARA_AUTH_ENABLED) return
    if (sessionVersion === 0) return
    if (modalOpen || isConnected || bridging.current) return
    bridging.current = true
    ;(async () => {
      try {
        const { getParaClient } = await import('@/providers/para-config')
        const paraClient = getParaClient()
        const loggedIn = await paraClient.isFullyLoggedIn()
        if (!loggedIn) return
        const para = connectors.find(c => c.id === 'para')
        if (para) {
          await connectAsync({ connector: para })
          markParaSession(true)
        }
      } catch {
        // No Para session, or the user's Para env is unreachable — external
        // wallets still work.
      } finally {
        bridging.current = false
      }
    })()
  }, [modalOpen, sessionVersion, isConnected, connectors, connectAsync])

  return {
    isConnected,
    address: address as Address | undefined,
    /** Wallet connectors the user can pick from (excludes the Para bridge,
     *  the redundant injected fallback, and duplicate names). */
    connectors: offerableWallets(connectors),
    /** Connect a specific external wallet connector. */
    connectWith: (connectorId: string) => {
      const connector = connectors.find(c => c.id === connectorId)
      if (connector) return connectAsync({ connector })
      return Promise.reject(new Error('Unknown wallet'))
    },
    /** Open the Para email/social sign-in modal. */
    openSignIn: () => {
      if (!IS_DETERMINISTIC_BROWSER) requestSignIn()
    },
    disconnect: () => {
      wagmiDisconnect()
      if (IS_DETERMINISTIC_BROWSER || !PARA_AUTH_ENABLED) return
      // Whether a Para session EXISTS, not whether the active connector is named "para". An
      // email sign-in whose connector reads as anything else left that session alive — and the
      // bridge effect above, which exists to pick a live session up, then signed the visitor
      // straight back in.
      void import('@/providers/para-config').then(async ({ getParaClient }) => {
        const client = getParaClient()
        const live = await client.isFullyLoggedIn().catch(() => false)
        if (!live) return
        markParaSession(false)
        await client.logout().catch(() => {})
      })
    },
  }
}
