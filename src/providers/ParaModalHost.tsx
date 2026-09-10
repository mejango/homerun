'use client'

import { PortalContainerProvider } from '@getpara/react-component-library'
import { ParaProvider } from '@getpara/react-sdk-lite'
import {
  Network,
  OnRampAsset,
  OnRampProvider,
  OnRampPurchaseType,
} from '@getpara/web-sdk'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent,
} from 'react'
import { createPortal } from 'react-dom'
import { useAccount } from 'wagmi'
import type { ParaRequest } from './ParaAuthContext'
import {
  getParaClient,
  PARA_APP,
  PARA_ONRAMP_PROVIDER,
  recordOnRampPurchase,
} from './para-config'
import { OnRampFrame, OnRampHandoff } from './OnRampHandoff'
import ParaAuthSheet from './ParaAuthSheet'
import { SignInShell } from './SignInShell'

/** Layout effects run before paint, which is the whole point here; on the
 *  server there is no paint and React warns, so fall back there. */
const useBeforePaint =
  typeof window === 'undefined' ? useEffect : useLayoutEffect

/**
 * Dismiss on a click that both starts and ends on the backdrop.
 *
 * Checking only where the mouse came up would close the panel when a drag to
 * select text inside it happened to be released outside.
 */
function useBackdropDismiss(onDismiss: () => void) {
  const pressedBackdrop = useRef(false)
  return {
    onMouseDown(event: MouseEvent<HTMLElement>) {
      pressedBackdrop.current = event.target === event.currentTarget
    },
    onClick(event: MouseEvent<HTMLElement>) {
      const dismiss =
        pressedBackdrop.current && event.target === event.currentTarget
      pressedBackdrop.current = false
      if (dismiss) onDismiss()
    },
  }
}

function Driver({
  requestId,
  request,
  onOpenChange,
  onSettled,
  onLive,
  entry,
  onEntryChange,
}: {
  requestId: number
  request: ParaRequest
  onOpenChange: (open: boolean) => void
  onSettled: () => void
  /** Fired once Para is initialised far enough for this to render at all. */
  onLive: () => void
  entry: string
  onEntryChange: (value: string) => void
}) {
  const { address } = useAccount()
  const [sheetOpen, setSheetOpen] = useState(false)
  // Set once the purchase window is handed off, so we can say what to do when
  // it does not go through — and re-offer the link if the popup was blocked.
  const [handoffUrl, setHandoffUrl] = useState<string | null>(null)
  // What the provider was asked to deliver, so the handoff can name it.
  const [handoffAsset, setHandoffAsset] = useState<string | null>(null)
  // Whether that purchase is showing in the dialog rather than in a window of
  // its own.
  const [embedded, setEmbedded] = useState(false)
  const handledRequest = useRef(0)
  const wasOpen = useRef(false)
  // Set when the on-ramp had to sign the user in first, so it can resume once
  // the sheet closes.
  const resumeAddFunds = useRef<ParaRequest | null>(null)

  const startAddFunds = useCallback(
    async (target: Extract<ParaRequest, { kind: 'addFunds' }>) => {
      const para = getParaClient()
      // Both on-ramp paths are keyed to a Para user, even the one that
      // delivers to someone else's wallet. No session means sign in first.
      if (!(await para.isFullyLoggedIn().catch(() => false))) {
        resumeAddFunds.current = target
        setSheetOpen(true)
        return
      }
      // The embedded wallet used to go through Para's own add-funds modal, which brought its
      // branding and a second provider picker with it. The headless call takes any destination
      // address, and Para knows the embedded wallet's own — so both wallets take the same path
      // and no Para-rendered screen appears.
      const destination =
        address ??
        Object.values(para.getWallets()).find(
          wallet => wallet.type === 'EVM' && wallet.address,
        )?.address
      if (!destination) return
      // Our domain strings and Para's enums share their values, so the enum
      // objects double as the lookup table.
      const asset = OnRampAsset[target.asset]
      const network = Network[target.network]
      const embed = target.display === 'embed'
      const { portalUrl, onRampPurchase } =
        await para.initiateOnRampTransaction({
          externalWalletAddress: destination,
          // Para records the purchase only when IT opens the window; an
          // embedded one has to be handed that record separately, or the
          // portal's first message goes unanswered.
          shouldOpenPopup: !embed,
        params: {
          type: OnRampPurchaseType.BUY,
          provider: OnRampProvider[PARA_ONRAMP_PROVIDER],
          asset,
          network,
          defaultAsset: asset,
          defaultNetwork: network,
          externalWalletAddress: destination,
          ...(target.assetQuantity
            ? { assetQuantity: target.assetQuantity }
            : {}),
          // A payer who typed dollars gets the provider's fiat field filled,
          // not its asset one.
          ...(target.fiatQuantity
            ? { fiat: 'USD', fiatQuantity: target.fiatQuantity }
            : {}),
        },
      })
      // If the SDK has moved the field this reaches for, fall back to the
      // window rather than showing a frame that can only spin.
      const framed = embed && recordOnRampPurchase(para, onRampPurchase)
      if (embed && !framed) {
        window.open(portalUrl, 'ParaOnRamp', 'popup,width=420,height=640')
      }
      setEmbedded(framed)
      setHandoffAsset(target.asset === 'USDC' ? 'USDC' : 'ETH')
      setHandoffUrl(portalUrl)
    },
    [address],
  )

  useEffect(() => {
    if (requestId <= handledRequest.current) return
    handledRequest.current = requestId
    if (request.kind === 'auth') {
      setSheetOpen(true)
      return
    }
    void startAddFunds(request).catch(() => {
      // A declined popup or an on-ramp provider the portal has switched off.
      // Nothing to recover: the affordance is optional either way.
    })
  }, [requestId, request, startAddFunds])

  const closeSheet = useCallback(() => {
    setSheetOpen(false)
    const resume = resumeAddFunds.current
    resumeAddFunds.current = null
    if (resume?.kind !== 'addFunds') return
    // Sign-in was only a means to the on-ramp, so pick the interrupted flow
    // back up — but ONLY once a session actually exists. The sheet reports the
    // same close whether the visitor signed in or cancelled, and resuming
    // after a cancel walks straight back into "no session, open the sheet",
    // which reopens it forever.
    void getParaClient()
      .isFullyLoggedIn()
      .then(loggedIn => {
        if (loggedIn) return startAddFunds(resume)
      })
      .catch(() => {})
  }, [startAddFunds])

  const sheetBackdrop = useBackdropDismiss(() => closeSheet())
  const handoffBackdrop = useBackdropDismiss(() => setHandoffUrl(null))

  // Para owns whether its own modal is showing; the host above owns the
  // dialog, because it has to open it before this component can exist at all
  // — ParaProvider renders nothing until Para's API answers.
  const open = sheetOpen || !!handoffUrl

  useEffect(() => onLive(), [onLive])

  useEffect(() => {
    onOpenChange(open)
    if (wasOpen.current && !open) onSettled()
    wasOpen.current = open
  }, [open, onOpenChange, onSettled])

  if (handoffUrl) {
    return (
      <div
        className="flex h-full w-full items-center justify-center overflow-y-auto bg-slate-900/55 p-6"
        {...handoffBackdrop}
      >
        <div className={`card w-full p-6 ${embedded ? 'max-w-md' : 'max-w-sm'}`}>
          {embedded ? (
            <OnRampFrame
              url={handoffUrl}
              asset={handoffAsset ?? undefined}
              onClose={() => setHandoffUrl(null)}
            />
          ) : (
            <OnRampHandoff
              url={handoffUrl}
              asset={handoffAsset ?? undefined}
              onClose={() => setHandoffUrl(null)}
            />
          )}
        </div>
      </div>
    )
  }

  if (!sheetOpen) return null
  // The host contributes top-layer membership and nothing else — it paints no
  // backdrop and its `.modal-dialog` styling is `<dialog>`-scoped — so the
  // sheet brings its own dimmed surface and panel.
  return (
    <div
      className="flex h-full w-full items-center justify-center overflow-y-auto bg-slate-900/55 p-6"
      {...sheetBackdrop}
    >
      <div className="card w-full max-w-sm p-6">
        <ParaAuthSheet
            onClose={closeSheet}
            entry={entry}
            onEntryChange={onEntryChange}
          />
      </div>
    </div>
  )
}

/** Loaded only after a user requests embedded sign-in or the on-ramp. */
export default function ParaModalHost({
  requestId,
  request,
  onOpenChange,
  onSettled,
  entry,
  onEntryChange,
}: {
  requestId: number
  request: ParaRequest
  onOpenChange: (open: boolean) => void
  onSettled: () => void
  entry: string
  onEntryChange: (value: string) => void
}) {
  const paraClient = getParaClient()

  // Sign-in is reachable from inside an app modal — AddShopItemsModal and
  // RedeemShopItemsModal both offer it — and a dialog opened with
  // `showModal()` inerts everything outside itself, including body-level
  // portals, which is what Para renders. So the Para overlay has to be in the
  // top layer too, which means it has to be a `showModal()` dialog: the host
  // below. `PortalContainerProvider` points Para's portal container at that
  // host instead of the body. The provider tree itself lives in the host as
  // well, because Para's warm-up iframe is a sibling of the overlay and has to
  // stay above the dialog underneath along with it.
  // Built during render rather than in an effect. Creating it afterwards
  // meant returning null for a render first — and since the placeholder has
  // already unmounted by then, that null is a frame of empty screen between
  // the two. Attaching it happens before paint for the same reason.
  const [host] = useState<HTMLDialogElement | null>(() => {
    if (typeof document === 'undefined') return null
    const dialog = document.createElement('dialog')
    dialog.className = 'ui-modal-host'
    dialog.tabIndex = -1
    return dialog
  })
  // ParaProvider renders nothing until Para's API answers, so Driver — and
  // with it the sheet — does not exist for the first few hundred
  // milliseconds. Without this the dialog would sit closed and the visitor
  // would watch the page reappear between the placeholder and the sheet.
  const [driverOpen, setDriverOpen] = useState(false)
  const [driverLive, setDriverLive] = useState(false)
  // `requestId > 0` matters: the host is also mounted ahead of time to warm
  // Para up, and nothing should be on screen for that.
  const showShell = !driverLive && request.kind === 'auth' && requestId > 0
  const open = driverOpen || showShell

  // Stable identities: Driver keys effects off these, so a closure recreated
  // each render would re-run them every render. The callers' own handlers are
  // not stable, so hold them in a ref rather than in the dependency list.
  const onOpenChangeRef = useRef(onOpenChange)
  onOpenChangeRef.current = onOpenChange
  const reportOpen = useCallback((next: boolean) => {
    setDriverOpen(next)
    onOpenChangeRef.current(next)
  }, [])
  const markDriverLive = useCallback(() => setDriverLive(true), [])

  useBeforePaint(() => {
    if (!host) return
    // Escape belongs to Para's own dismissal path. Closing the host natively
    // would leave Para believing its modal was still open.
    const preventNativeCancel = (event: Event) => event.preventDefault()
    host.addEventListener('cancel', preventNativeCancel)
    document.body.append(host)
    return () => {
      host.removeEventListener('cancel', preventNativeCancel)
      host.remove()
    }
  }, [host])

  // Deliberately a passive effect, not a layout one: sign-in is reachable
  // from inside other modals, and this dialog has to enter the top layer
  // after theirs to sit above them. Opening before paint would put it under.
  useEffect(() => {
    if (!host) return
    if (open && !host.open) {
      host.showModal()
      // Keep the first open from landing focus (and a focus ring) on the sheet's close button.
      host.focus({ preventScroll: true })
    } else if (!open && host.open) host.close()
  }, [host, open])

  if (!host) return null

  return createPortal(
    <PortalContainerProvider container={host}>
      {/* Authentication is ours (ParaAuthSheet); Para's packaged modal stays
          mounted only to render the add-funds step, which has no headless
          equivalent for the embedded wallet. Its theme is therefore only ever
          seen on that screen. */}
      {showShell ? (
        <div className="flex h-full w-full items-center justify-center overflow-y-auto bg-slate-900/55 p-6">
          <div className="card w-full max-w-sm p-6">
            <SignInShell entry={entry} onEntryChange={onEntryChange} />
          </div>
        </div>
      ) : null}
      <ParaProvider
        paraClientConfig={paraClient}
        config={{ appName: PARA_APP.appName }}
        paraModalConfig={{
          authLayout: ['AUTH:FULL'],
          oAuthMethods: ['GOOGLE', 'TWITTER', 'APPLE', 'DISCORD', 'FARCASTER'],
          // Bone and ink with Bluebs as the accent, in Beatrice — the same
          // palette the rest of the site draws from.
          theme: {
            mode: 'light',
            backgroundColor: '#f7f5ef',
            foregroundColor: '#293b33',
            accentColor: '#45674e',
            font: 'system-ui',
            borderRadius: 'lg',
          },
        }}
        externalWalletConfig={{ wallets: [] }}
      >
        <Driver
          requestId={requestId}
          request={request}
          onOpenChange={reportOpen}
          onSettled={onSettled}
          onLive={markDriverLive}
          entry={entry}
          onEntryChange={onEntryChange}
        />
      </ParaProvider>
    </PortalContainerProvider>,
    host,
  )
}
