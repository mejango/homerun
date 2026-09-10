'use client'

import { useEffect, useState } from 'react'
import { ModalShell } from '@/components/ui/ModalShell'
import { WalletFallbackMark } from '@/components/BrandMarks'
import { useWallet } from '@/hooks/useWallet'
import { useMobileWallet } from '@/hooks/useMobileWallet'
import { mobileWalletLinks } from '@/lib/walletLinks'

/** External wallets remain usable when embedded authentication is not configured.
 * The connector, QR pairing, and account state are still the shared Wagmi stack. */
export function ExternalWalletDialog({ onClose }: { onClose: () => void }) {
  const { connectors, connectWith, isConnected } = useWallet()
  const mobileWallet = useMobileWallet()
  const [pending, setPending] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pairingUri, setPairingUri] = useState<string | null>(null)
  const [pairingQr, setPairingQr] = useState<string | null>(null)

  useEffect(() => {
    if (isConnected) onClose()
  }, [isConnected, onClose])

  useEffect(() => {
    const walletConnect = connectors.find(connector => connector.id === 'walletConnect')
    if (!walletConnect) return
    let live = true
    const onMessage = ({ type, data }: { type: string; data?: unknown }) => {
      if (type !== 'display_uri' || typeof data !== 'string') return
      setPairingUri(data)
      void import('qrcode')
        .then(qr => qr.toDataURL(data, { margin: 1, width: 320, errorCorrectionLevel: 'M' }))
        .then(url => { if (live) setPairingQr(url) })
        .catch(() => { /* The pairing link still works if QR rendering fails. */ })
    }
    walletConnect.emitter.on('message', onMessage)
    return () => {
      live = false
      walletConnect.emitter.off('message', onMessage)
    }
  }, [connectors])

  const connect = async (connectorId: string) => {
    setPending(connectorId)
    setError(null)
    setPairingUri(null)
    setPairingQr(null)
    try {
      await connectWith(connectorId)
      onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The wallet could not connect. Try again.')
    } finally {
      setPending(null)
    }
  }

  const framed = typeof window !== 'undefined' && window.self !== window.top
  const available = connectors.filter(connector => connector.id !== 'safe' || framed)

  return (
    <ModalShell title="Connect your wallet" onClose={onClose} maxWidth="max-w-md">
      <p className="text-sm text-smoke-700">Choose a wallet to review and sign transactions.</p>
      <div className="mt-4 grid gap-2">
        {available.map(connector => (
          <button
            type="button"
            key={connector.id}
            onClick={() => void connect(connector.id)}
            disabled={pending !== null}
            aria-busy={pending === connector.id}
            className="btn-secondary flex min-h-11 items-center gap-3 px-4 py-3 text-left text-sm"
          >
            {connector.icon ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={connector.icon} alt="" className="h-5 w-5" />
            ) : <WalletFallbackMark id={connector.id} className="h-5 w-5" />}
            <span>{pending === connector.id ? `Connecting to ${connector.name}…` : connector.name}</span>
          </button>
        ))}
      </div>
      {pairingUri ? (
        <div className="mt-4 rounded-lg border border-smoke-200 bg-white p-3 text-center">
          <p className="text-sm">Scan with your wallet app, or open it on this device.</p>
          {pairingQr ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={pairingQr} alt="WalletConnect pairing QR code" className="mx-auto my-3 w-full max-w-64" />
          ) : null}
          <a href={pairingUri} className="text-sm underline">Open wallet</a>
        </div>
      ) : null}
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
      {error ? <p role="alert" className="mt-4 break-words text-sm text-error-500">{error}</p> : null}
    </ModalShell>
  )
}
