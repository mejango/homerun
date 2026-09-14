'use client'
import { useEffect, useState } from 'react'
import { connect } from '@wagmi/core'
import { wagmiConfig } from '@/providers/Providers'
import { capturedCenterCallback } from '@/providers/center-callback'

let completing: Promise<string> | null = null
let callbackResolved = false
async function complete() {
  const callback = capturedCenterCallback()
  const { centerWalletClient, originalCenterPage } = await import('@/providers/center-runtime')
  const wallet = centerWalletClient()
  if (!callbackResolved && callback && new URL(callback.url).search) {
    if (new URL(callback.url).searchParams.has('review')) await wallet.payments().completePayment(callback.url)
    else await wallet.completeConnection(callback.url)
    callbackResolved = true
  } else if (wallet.payments().pendingPayment()) await wallet.payments().refreshPayment()
  else await wallet.retryConnection()
  const connector = wagmiConfig.connectors.find(item => item.id === 'juicebox-center')
  if (!connector) throw new Error('Juicebox wallet is not configured for this site.')
  if (wagmiConfig.state.current !== connector.uid) await connect(wagmiConfig, { connector })
  return originalCenterPage()
}
export default function CenterCallbackPage() {
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let active = true
    completing ??= complete().catch(cause => { completing = null; throw cause })
    void completing.then(path => { if (active) window.location.replace(path) }, cause => {
      if (active) setError(cause instanceof Error ? cause.message : 'The wallet connection could not be restored.')
    })
    return () => { active = false }
  }, [attempt])
  return <main className="mx-auto max-w-xl px-6 py-16"><h1 className="text-2xl">Your Juicebox wallet</h1>
    <p role="status" className="mt-5 break-words">{error ?? 'Restoring your wallet and original page…'}</p>
    {error ? <button type="button" className="btn-primary mt-5 px-4 py-3" onClick={() => { setError(null); setAttempt(value => value + 1) }}>Retry</button> : null}
  </main>
}
