'use client'

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  lazy,
  PropsWithChildren,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react'
import { createConfig, injected, WagmiProvider } from 'wagmi'
import { TransactionReviewProvider } from '@/components/TransactionReviewProvider'
import { SUPPORTED_CHAINS } from '@/lib/chains'
import { jbCenterRpcTransport } from '@/lib/jbcenter-rpc'
import { installQueryPersistence } from '@/lib/query-persist'
import {
  ParaAuthContext,
  type ParaAddFundsRequest,
  type ParaRequest,
} from './ParaAuthContext'
import { lazyParaConnector } from './lazy-para-connector'
import { SignInPlaceholder } from './SignInPlaceholder'
import { externalWalletConnectors } from './wallet-connectors'
import { PARA_AUTH_ENABLED } from './wallet-config'
import { ExternalWalletDialog } from './ExternalWalletDialog'
import { verifyMarkedParaSession } from './para-session'
import {
  arbitrum,
  arbitrumSepolia,
  base,
  baseSepolia,
  mainnet,
  optimism,
  optimismSepolia,
  sepolia,
} from '@bananapus/nana-sdk-core/chains'

export const IS_DETERMINISTIC_BROWSER =
  process.env.NEXT_PUBLIC_DETERMINISTIC_BROWSER === 'true'
export { SUPPORTED_CHAINS } from '@/lib/chains'

const transports = {
  [mainnet.id]: jbCenterRpcTransport(mainnet.id),
  [optimism.id]: jbCenterRpcTransport(optimism.id),
  [base.id]: jbCenterRpcTransport(base.id),
  [arbitrum.id]: jbCenterRpcTransport(arbitrum.id),
  [sepolia.id]: jbCenterRpcTransport(sepolia.id),
  [optimismSepolia.id]: jbCenterRpcTransport(optimismSepolia.id),
  [baseSepolia.id]: jbCenterRpcTransport(baseSepolia.id),
  [arbitrumSepolia.id]: jbCenterRpcTransport(arbitrumSepolia.id),
}

const ParaModalHost = lazy(() => import('./ParaModalHost'))


/**
 * The app's single wagmi config — the one source of truth for connections,
 * chain switching, and writes. EIP-6963 discovery plus a generic injected
 * fallback cover browser wallets. Every remaining wallet — Para, WalletConnect,
 * Coinbase, Safe — sits behind a lazy delegate, so no vendor SDK is downloaded
 * until that wallet is picked or restored. `reconnect()` probes every connector
 * on mount, which is exactly what those delegates short-circuit.
 */
export const wagmiConfig = createConfig({
  chains: SUPPORTED_CHAINS,
  transports,
  connectors: IS_DETERMINISTIC_BROWSER
    ? []
    : [
        injected({ shimDisconnect: true }),
        ...(PARA_AUTH_ENABLED ? [lazyParaConnector()] : []),
        ...externalWalletConnectors(),
      ],
  multiInjectedProviderDiscovery: !IS_DETERMINISTIC_BROWSER,
  ssr: true,
})

/**
 * Root providers: react-query + wagmi only. Both render children
 * synchronously, so server-rendered pages stream unblocked. The Para provider
 * intentionally does NOT wrap the app — it gates its entire subtree behind an
 * async client init (rendering nothing until Para's API responds), which
 * would break SSR, 404 statuses, and resilience. It's mounted as a
 * self-contained modal host instead (see ParaHost).
 */
export function Providers({ children }: PropsWithChildren) {
  const [queryClient] = useState(() => {
    const client = new QueryClient({
      defaultOptions: {
        queries: {
          staleTime: 30_000,
          gcTime: 10 * 60_000,
          retry: 1,
          refetchOnWindowFocus: false,
        },
      },
    })
    return client
  })
  // Last session's values are, by definition, values the server did not render, and
  // streamed segments keep hydrating after this effect fires. Seeding the cache before
  // the document settles re-renders a tree React is still matching against the server's
  // HTML, which it reports as a hydration failure.
  useEffect(() => {
    let teardown: (() => void) | undefined
    const restore = () => {
      teardown = installQueryPersistence(queryClient)
    }
    if (document.readyState === 'complete') restore()
    else window.addEventListener('load', restore, { once: true })
    return () => {
      window.removeEventListener('load', restore)
      teardown?.()
    }
  }, [queryClient])
  const [externalWalletOpen, setExternalWalletOpen] = useState(false)
  const [paraHostLoaded, setParaHostLoaded] = useState(false)
  const [paraRequestId, setParaRequestId] = useState(0)
  const [paraCancelledThrough, setParaCancelledThrough] = useState(0)
  const [paraRequest, setParaRequest] = useState<ParaRequest>({ kind: 'auth' })
  const [paraModalOpen, setParaModalOpen] = useState(false)
  const [paraSessionVersion, setParaSessionVersion] = useState(0)
  // Held here so it survives the shell handing over to the real sheet: those
  // are two components either side of a Suspense boundary, and anything typed
  // during the wait would otherwise go with the first one.
  const [signInEntry, setSignInEntry] = useState('')

  // Bring Para up in the background once the page is done and the browser is
  // idle. It mounts closed and invisible, so by the time anyone clicks Sign
  // in both the chunk and Para's own async init are already finished and the
  // sheet opens with nothing to wait for.
  //
  // Skipped on metered or slow connections: this is ~725 KiB that a visitor
  // who never signs in does not need, and on those links the preload would
  // cost more than the wait it saves. They still get it on click.
  useEffect(() => {
    if (IS_DETERMINISTIC_BROWSER || !PARA_AUTH_ENABLED) return
    const link = (
      navigator as Navigator & {
        connection?: { saveData?: boolean; effectiveType?: string }
      }
    ).connection
    if (link?.saveData) return
    if (link?.effectiveType && /(^|-)2g$/.test(link.effectiveType)) return

    let cancelled = false
    const warm = () => {
      if (!cancelled) setParaHostLoaded(true)
    }
    const idle = (
      window as Window & {
        requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number
      }
    ).requestIdleCallback
    const schedule = () =>
      idle ? idle(warm, { timeout: 4000 }) : window.setTimeout(warm, 1500)

    let handle: number | undefined
    if (document.readyState === 'complete') handle = schedule()
    else window.addEventListener('load', () => (handle = schedule()), { once: true })
    return () => {
      cancelled = true
      if (handle !== undefined) window.clearTimeout(handle)
    }
  }, [])

  // Preserve embedded-wallet sessions without penalizing anonymous visitors:
  // only a browser that previously completed Para auth loads its runtime.
  // Para's own session is authoritative; transient verification failures keep
  // the marker intact so a later page load can recover.
  useEffect(() => {
    if (!IS_DETERMINISTIC_BROWSER && PARA_AUTH_ENABLED) void verifyMarkedParaSession()
  }, [])

  const requestSignIn = useCallback(() => {
    if (IS_DETERMINISTIC_BROWSER) return
    if (!PARA_AUTH_ENABLED) {
      setExternalWalletOpen(true)
      return
    }
    setParaHostLoaded(true)
    setParaRequest({ kind: 'auth' })
    setParaRequestId(current => current + 1)
  }, [])
  const requestAddFunds = useCallback((request: ParaAddFundsRequest) => {
    if (IS_DETERMINISTIC_BROWSER || !PARA_AUTH_ENABLED) return
    setParaHostLoaded(true)
    setParaRequest({ kind: 'addFunds', ...request })
    setParaRequestId(current => current + 1)
  }, [])
  const cancelLoadingSignIn = useCallback(() => {
    // Keep request IDs monotonic: a delayed SDK mount must not reopen a
    // cancelled request, while the next explicit sign-in click still works.
    setParaCancelledThrough(current => Math.max(current, paraRequestId))
    setParaModalOpen(false)
  }, [paraRequestId])
  const markParaSettled = useCallback(
    () => setParaSessionVersion(current => current + 1),
    [],
  )
  const paraAuth = useMemo(
    () => ({
      modalOpen: paraModalOpen || externalWalletOpen,
      sessionVersion: paraSessionVersion,
      requestSignIn,
      requestAddFunds,
    }),
    [paraModalOpen, externalWalletOpen, paraSessionVersion, requestSignIn, requestAddFunds],
  )

  return (
    <QueryClientProvider client={queryClient}>
      <WagmiProvider
        config={wagmiConfig}
        reconnectOnMount={!IS_DETERMINISTIC_BROWSER}
      >
        <ParaAuthContext.Provider value={paraAuth}>
          <TransactionReviewProvider>{children}</TransactionReviewProvider>
          {externalWalletOpen ? (
            <ExternalWalletDialog onClose={() => setExternalWalletOpen(false)} />
          ) : null}
          {/* Para renders its own overlay, so it must stay in the browser's
              top layer: `openSignIn` is reachable from inside app modals
              (AddShopItemsModal, RedeemShopItemsModal), and everything outside
              the topmost `showModal()` dialog is inert — body-level portals
              included. ParaModalHost owns a `showModal()` dialog for exactly
              that reason. Any future overlay that renders to the body needs
              the same treatment before it can be opened from a modal. */}
          {paraHostLoaded ? (
            <Suspense
              fallback={
                paraRequest.kind === 'auth' && paraRequestId > paraCancelledThrough ? (
                  <SignInPlaceholder
                    entry={signInEntry}
                    onEntryChange={setSignInEntry}
                    onClose={cancelLoadingSignIn}
                  />
                ) : null
              }
            >
              <ParaModalHost
                requestId={paraRequestId}
                cancelledThrough={paraCancelledThrough}
                onCancelRequest={cancelLoadingSignIn}
                request={paraRequest}
                onOpenChange={setParaModalOpen}
                onSettled={markParaSettled}
                entry={signInEntry}
                onEntryChange={setSignInEntry}
              />
            </Suspense>
          ) : null}
        </ParaAuthContext.Provider>
      </WagmiProvider>
    </QueryClientProvider>
  )
}
