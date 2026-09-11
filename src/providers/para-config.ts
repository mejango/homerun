'use client'

import { paraConnector } from '@getpara/wagmi-v2-connector'
import ParaWeb, { type Environment } from '@getpara/web-sdk'
import type { Transport } from 'viem'
import type { CreateConnectorFn } from 'wagmi'

export const PARA_APP = {
  appName: 'Homerun',
  appDescription: "Run your homes' investments and revenues.",
  appUrl: process.env.NEXT_PUBLIC_SITE_URL ?? 'https://homerun.money',
}

const ONRAMP_PROVIDERS = ['STRIPE', 'MOONPAY', 'RAMP', 'CDP', 'MERCURYO'] as const

/** The headless on-ramp call refuses to run without an explicit provider, and
 *  which ones are live is a Para dashboard setting rather than a code one —
 *  Stripe and MoonPay are key-less toggles, Ramp needs KYB onboarding.
 *
 *  MoonPay is the default because it is the only one of the two that works
 *  outside the US and EU. Stripe is cheaper but regionally narrow, and its
 *  on-ramp is still labelled a public preview.
 *
 *  Clamped rather than trusted: an unrecognized value makes Para throw deep
 *  inside the call, which surfaces as a button that silently does nothing. */
export const PARA_ONRAMP_PROVIDER = ((): (typeof ONRAMP_PROVIDERS)[number] => {
  const configured = process.env.NEXT_PUBLIC_PARA_ONRAMP_PROVIDER
  if (!configured) return 'MOONPAY'
  const match = ONRAMP_PROVIDERS.find(provider => provider === configured)
  if (match) return match
  console.warn(
    `Ignoring unknown NEXT_PUBLIC_PARA_ONRAMP_PROVIDER "${configured}" — using MOONPAY.`,
  )
  return 'MOONPAY'
})()

let client: ParaWeb | undefined

/** Constructing Para starts its worker/session machinery. Keep the singleton
 * behind a user action so an anonymous page view performs no wallet traffic. */
export function getParaClient(): ParaWeb {
  client ??= new ParaWeb(
    (process.env.NEXT_PUBLIC_PARA_ENV as Environment) || 'BETA',
    process.env.NEXT_PUBLIC_PARA_API_KEY ?? '',
  )
  return client
}

export function createParaWagmiConnector(
  transports: Record<number, Transport>,
): CreateConnectorFn {
  // Para 3.8's declaration excludes wagmi's nullable storage branch, although
  // its runtime connector implements the same interface.
  return paraConnector({
    para: getParaClient(),
    appName: PARA_APP.appName,
    options: {},
    disableModal: true,
    transports,
  }) as unknown as CreateConnectorFn
}

/**
 * How Para's own pages should look when they appear inside ours.
 *
 * The verification code renders in an iframe in the sign-in sheet, so its default
 * white-and-blue portal styling sat inside a bone panel looking like a foreign object. Para
 * bakes this into the URL it generates, so it has to travel with the auth call that asks for
 * one.
 *
 * Values are the site's own tokens: the sheet's white ground, ink text, split yellow accent.
 */
/** Nothing is fetched: whichever of these the visitor already has wins. */
const PARA_PORTAL_MONO =
  'ui-monospace, SFMono-Regular, Menlo, Monaco, "Courier New", monospace'

export const PARA_PORTAL_THEME = {
  // The sheet's card is white; bone here left the frame sitting in the panel as a visible
  // stripe. The ground has to match what surrounds it, not the site's page colour.
  backgroundColor: '#FFFFFF',
  foregroundColor: '#293b33',
  accentColor: '#45674e',
  mode: 'light' as const,
  borderRadius: 'lg' as const,
  // NOT `font`. Para wraps that value in quotes — `"${font}", ui-sans-serif, …`
  // — so a stack passed there becomes one quoted family name that matches
  // nothing, and the portal silently renders sans. `cssOverrides` is applied
  // afterwards, verbatim, and wins.
  cssOverrides: {
    fontFamily: PARA_PORTAL_MONO,
    '--para-font-sans': PARA_PORTAL_MONO,
  },
}

/**
 * Tell Para about a purchase it did not open a window for.
 *
 * `initiateOnRampTransaction` only records the purchase when IT opens the popup. The portal's
 * first message (`ONRAMPS__INIT`) asks for that record, and without one the reply carries
 * `undefined` — which is exactly what leaves an embedded on-ramp spinning forever with no
 * error.
 *
 * The field is `protected`, so this reaches past the type to set it and then checks that it
 * took. A false return means the SDK moved it and the caller should open a window instead —
 * losing the frame is a worse outcome than losing the purchase.
 *
 * `window` is only ever written, never read (SDK 3.11), so the frame has nothing to hand over.
 */
export function recordOnRampPurchase(
  client: unknown,
  purchase: unknown,
): boolean {
  const target = client as {
    onRampPopup?: { window: Window; onRampPurchase: unknown }
  }
  try {
    target.onRampPopup = { window, onRampPurchase: purchase }
    return target.onRampPopup?.onRampPurchase === purchase
  } catch {
    return false
  }
}
