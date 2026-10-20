'use client'
import { ChunkFailedDialog } from '@/components/ChunkFailed'
import { lazyComponent } from '@/components/lazy-component'
import { CENTER_WALLET_ENABLED } from './wallet-config'

/** The sign-in dialog. Providers opens it once its code is in; the wallet button preloads it on hover and focus. */
export const ExternalWalletDialog = lazyComponent(() => import('./ExternalWalletDialog').then(m => m.ExternalWalletDialog), { failed: ChunkFailedDialog })

/** Loads the sign-in dialog, and the Center wallet runtime when it is on, before the click that opens them. */
export function preloadSignIn() {
  void ExternalWalletDialog.preload()
  if (CENTER_WALLET_ENABLED) void import('./center-runtime')
}
