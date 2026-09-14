'use client'
import { createCenterWalletClient } from '@juicebox/center-client'
import { CENTER_WALLET_CONFIG } from './wallet-config'
import { centerReturnPath } from './center-callback'
const returnKey = 'homerun:center:return:v1'
let client: ReturnType<typeof createCenterWalletClient> | undefined
export function centerWalletClient() {
  if (!CENTER_WALLET_CONFIG || typeof window === 'undefined') throw new Error('Juicebox wallet is not configured for this site.')
  client ??= createCenterWalletClient({ ...CENTER_WALLET_CONFIG, callbackUri: window.location.origin + '/center/callback' })
  return client
}
export async function beginCenterConnection(signal?: AbortSignal) {
  signal?.throwIfAborted()
  const wallet = centerWalletClient(), path = centerReturnPath(window.location.pathname)
  if (wallet.payments().pendingPayment()) throw new Error('Resume your existing Juicebox payment before connecting another wallet.')
  window.sessionStorage.setItem(returnKey, path)
  if (window.sessionStorage.getItem(returnKey) !== path) throw new Error('This tab could not preserve the original page.')
  const prepared = await wallet.prepareConnection()
  // Closing the wallet chooser never causes a delayed redirect. Keep the SDK's
  // original handoff so reopening can resume it with its existing identifiers.
  signal?.throwIfAborted()
  prepared.launch()
}
export function originalCenterPage() { return centerReturnPath(window.sessionStorage.getItem(returnKey) ?? '/') }
