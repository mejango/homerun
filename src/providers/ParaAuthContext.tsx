'use client'

import { createContext, useContext } from 'react'

const PARA_SESSION_MARKER = 'homerun.para-session'

export function hasParaSessionMarker(): boolean {
  try {
    return window.localStorage.getItem(PARA_SESSION_MARKER) === 'true'
  } catch {
    return false
  }
}

export function markParaSession(active: boolean) {
  try {
    if (active) window.localStorage.setItem(PARA_SESSION_MARKER, 'true')
    else window.localStorage.removeItem(PARA_SESSION_MARKER)
  } catch {
    // Storage can be blocked in privacy modes; the live wagmi session remains
    // usable, it simply will not be restored on the next page load.
  }
}

/** The two assets Para's on-ramp can deliver that we actually accept. */
export type ParaOnRampAsset = 'ETHEREUM' | 'USDC'

/** Para names networks itself; only the ones we deploy to are mapped. */
export type ParaOnRampNetwork =
  | 'ETHEREUM'
  | 'BASE'
  | 'ARBITRUM'
  | 'OPTIMISM'
  | 'SEPOLIA'

export type ParaAddFundsRequest = {
  asset: ParaOnRampAsset
  network: ParaOnRampNetwork
  /** How much of `asset` to buy, in whole units. Seeds the provider's amount
   *  field so a payer who is short does not have to work out the difference.
   *  Only the headless path can carry it — Para's own add-funds modal takes
   *  no amount — so the embedded wallet still starts from an empty field. */
  assetQuantity?: string
  /** How much to SPEND, in dollars, when the payer typed a dollar figure rather
   *  than an amount of the asset. Seeds the provider's fiat field instead of
   *  its asset field. */
  fiatQuantity?: string
  /** Where the provider's own page goes. "embed" keeps it inside our dialog,
   *  which is what a payer part-way through a payment expects. */
  display?: 'window' | 'embed'
}

export type ParaRequest =
  | { kind: 'auth' }
  | ({ kind: 'addFunds' } & ParaAddFundsRequest)

export type ParaAuthController = {
  modalOpen: boolean
  sessionVersion: number
  requestSignIn: () => void
  /** Open the on-ramp. Signs the user into Para first when they have no
   *  session — the on-ramp is account-scoped even when it delivers to an
   *  external address. */
  requestAddFunds: (request: ParaAddFundsRequest) => void
}

export const ParaAuthContext = createContext<ParaAuthController>({
  modalOpen: false,
  sessionVersion: 0,
  requestSignIn: () => {},
  requestAddFunds: () => {},
})

export function useParaAuth() {
  return useContext(ParaAuthContext)
}
