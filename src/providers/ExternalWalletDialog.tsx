'use client'

import { useEffect, useRef, useState } from 'react'
import { createConnectController, passkeyOption, type ConnectOption } from '@bananapus/nana-sdk-connect/core'
import { JBConnectModal } from '@bananapus/nana-sdk-connect/react'
import { WalletFallbackMark } from '@/components/BrandMarks'
import { useWallet } from '@/hooks/useWallet'
import { useMobileWallet } from '@/hooks/useMobileWallet'
import { mobileWalletLinks } from '@/lib/walletLinks'
import { CENTER_WALLET_ENABLED } from './wallet-config'

/** Two ways in: a passkey account at Juicebox Center, or an external wallet through the
 * shared wagmi stack. The SDK modal owns the layout; this file only supplies the options. */
export function ExternalWalletDialog({ onClose }: { onClose: () => void }) {
  const { connectors, connectWith, isConnected } = useWallet()
  const mobileWallet = useMobileWallet()
  const latest = useRef({ connectWith, onClose })
  latest.current = { connectWith, onClose }
  useEffect(() => { if (isConnected) onClose() }, [isConnected, onClose])

  const [controller] = useState(() => {
    const framed = typeof window !== 'undefined' && window.self !== window.top
    const options: ConnectOption[] = []
    let runtime: typeof import('./center-runtime') | undefined
    if (CENTER_WALLET_ENABLED) options.push(passkeyOption({
      // The option loads the runtime before it asks for the return path, so the save is synchronous.
      wallet: async () => { runtime = await import('./center-runtime'); return runtime.centerWalletClient() },
      beforeLaunch: () => runtime!.saveCenterReturnPath(),
    }))
    for (const connector of connectors) {
      if (connector.id === 'safe' && !framed) continue
      options.push({
        id: connector.id, name: connector.name, icon: connector.icon,
        async connect({ signal, handoff }) {
          const onMessage = ({ type, data }: { type: string; data?: unknown }) => {
            if (type === 'display_uri' && typeof data === 'string') handoff(data)
          }
          connector.emitter.on('message', onMessage)
          signal.addEventListener('abort', () => connector.emitter.off('message', onMessage))
          try { await latest.current.connectWith(connector.id) } finally { connector.emitter.off('message', onMessage) }
          latest.current.onClose()
        },
      })
    }
    return createConnectController(options)
  })

  return (
    <JBConnectModal open controller={controller} onClose={onClose} className="homerun-connect"
      renderIcon={option => <WalletFallbackMark id={option.id} className="h-5 w-5" />}
      renderHandoff={uri => <PairingCode uri={uri} />}>
      {mobileWallet === 'handoff' ? (
        <div className="mt-5">
          <p className="text-sm text-smoke-700">Or open Homerun in your wallet app.</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {mobileWalletLinks(window.location.href).map(wallet => (
              <a key={wallet.name} href={wallet.url} className="btn-secondary px-3 py-2 text-sm">{wallet.name}</a>
            ))}
          </div>
        </div>
      ) : null}
    </JBConnectModal>
  )
}

function PairingCode({ uri }: { uri: string }) {
  const [image, setImage] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    void import('qrcode')
      .then(qr => qr.toDataURL(uri, { margin: 1, width: 320, errorCorrectionLevel: 'M' }))
      .then(url => { if (live) setImage(url) })
      .catch(() => { /* The pairing link still works if QR rendering fails. */ })
    return () => { live = false }
  }, [uri])
  return (
    <div className="rounded-lg border border-smoke-200 bg-white p-3 text-center">
      <p className="text-sm">Scan with your wallet app, or open it on this device.</p>
      {image ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={image} alt="WalletConnect pairing QR code" className="mx-auto my-3 w-full max-w-64" />
      ) : null}
      <a href={uri} className="text-sm underline">Open wallet</a>
    </div>
  )
}
