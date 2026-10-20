'use client'
import { CENTER_WALLET_ENABLED } from './wallet-config'
/** Loads the sign-in dialog, and the Center wallet runtime when it is on, before the click that opens them. */
export function preloadSignIn() {
  void import('./ExternalWalletDialog')
  if (CENTER_WALLET_ENABLED) void import('./center-runtime')
}
