'use client'

// Clear callback data before loading a wallet SDK or rendering.
import './center-callback'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { type PropsWithChildren, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createConfig, injected, WagmiProvider } from 'wagmi'
import { TransactionReviewProvider } from '@/components/TransactionReviewProvider'
import { SUPPORTED_CHAINS } from '@/lib/chains'
import { jbCenterRpcTransport } from '@/lib/jbcenter-rpc'
import { installQueryPersistence } from '@/lib/query-persist'
import { watchSafeWalletPeer } from '@/lib/safe-wallet-peer'
import { WalletAuthContext } from './WalletAuthContext'
import { lazyCenterConnector } from './lazy-center-connector'
import { ExternalWalletDialog } from './preload-center'
import { externalWalletConnectors } from './wallet-connectors'
import { CENTER_WALLET_ENABLED } from './wallet-config'
import { arbitrum, arbitrumSepolia, base, baseSepolia, mainnet, optimism, optimismSepolia, sepolia } from '@bananapus/nana-sdk-core/chains'


export const IS_DETERMINISTIC_BROWSER = process.env.NEXT_PUBLIC_DETERMINISTIC_BROWSER === 'true'
export { SUPPORTED_CHAINS } from '@/lib/chains'
const transports = {
  [mainnet.id]: jbCenterRpcTransport(mainnet.id), [optimism.id]: jbCenterRpcTransport(optimism.id),
  [base.id]: jbCenterRpcTransport(base.id), [arbitrum.id]: jbCenterRpcTransport(arbitrum.id),
  [sepolia.id]: jbCenterRpcTransport(sepolia.id), [optimismSepolia.id]: jbCenterRpcTransport(optimismSepolia.id),
  [baseSepolia.id]: jbCenterRpcTransport(baseSepolia.id), [arbitrumSepolia.id]: jbCenterRpcTransport(arbitrumSepolia.id),
}

/** One connection state for Center and existing external wallets. Vendor clients load only
 * when selected or when their own saved connection is restored. */
export const wagmiConfig = createConfig({ chains: SUPPORTED_CHAINS, transports,
  connectors: IS_DETERMINISTIC_BROWSER ? [] : [injected({ shimDisconnect: true }),
    ...(CENTER_WALLET_ENABLED ? [lazyCenterConnector()] : []), ...externalWalletConnectors()],
  multiInjectedProviderDiscovery: !IS_DETERMINISTIC_BROWSER, ssr: true })

export function Providers({ children }: PropsWithChildren) {
  const [queryClient] = useState(() => new QueryClient({ defaultOptions: { queries: {
    staleTime: 30_000, gcTime: 10 * 60_000, retry: 1, refetchOnWindowFocus: false,
  } } }))
  // Delay disk work until load; each persisted reader also preserves its own server render
  // with useHydrated because streamed children can hydrate after this event.
  useEffect(() => {
    let teardown: (() => void) | undefined
    const restore = () => { teardown = installQueryPersistence(queryClient) }
    if (document.readyState === 'complete') restore()
    else window.addEventListener('load', restore, { once: true })
    return () => { window.removeEventListener('load', restore); teardown?.() }
  }, [queryClient])
  // Safe{Wallet} over WalletConnect proposes like the Safe app, and Safe tracking reads each chain through this config.
  useEffect(() => watchSafeWalletPeer(wagmiConfig), [])
  // 'loading' while the chooser's code downloads on a first request: the opener shows it is busy, and Escape or
  // moving focus elsewhere cancels, so the chooser never opens over something the visitor moved on to.
  const [wallet, setWallet] = useState<'closed' | 'loading' | 'open'>('closed')
  const waiting = useRef<(() => void)[]>([])
  const closeWallet = useCallback(() => {
    setWallet('closed')
    const pending = waiting.current
    waiting.current = []
    for (const resolve of pending) resolve()
  }, [])
  const requestSignIn = useCallback(() => {
    if (IS_DETERMINISTIC_BROWSER) return Promise.resolve()
    setWallet(state => state === 'open' ? state : 'loading')
    void ExternalWalletDialog.preload().then(() => setWallet(state => state === 'loading' ? 'open' : state))
    return new Promise<void>(resolve => { waiting.current = [...waiting.current, resolve] })
  }, [])
  useEffect(() => {
    if (wallet !== 'loading') return
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') closeWallet() }
    document.addEventListener('keydown', onKeyDown)
    document.addEventListener('focusin', closeWallet)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('focusin', closeWallet)
    }
  }, [wallet, closeWallet])
  const walletAuth = useMemo(() => ({ requestSignIn, signInPending: wallet === 'loading' }), [requestSignIn, wallet])
  return <QueryClientProvider client={queryClient}>
    <WagmiProvider config={wagmiConfig} reconnectOnMount={!IS_DETERMINISTIC_BROWSER}>
      <WalletAuthContext.Provider value={walletAuth}>
        <TransactionReviewProvider>{children}</TransactionReviewProvider>
        {wallet === 'open' ? <ExternalWalletDialog onClose={closeWallet} /> : null}
      </WalletAuthContext.Provider>
    </WagmiProvider>
  </QueryClientProvider>
}
