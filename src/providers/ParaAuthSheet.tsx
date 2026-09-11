'use client'

import {
  useAuthenticateWithEmailOrPhone,
  useAuthenticateWithOAuth,
  useResendVerificationCode,
  useVerifyNewAccount,
} from '@getpara/react-sdk-lite'
import type { StateSnapshot, TOAuthMethod } from '@getpara/web-sdk'
import { useCallback, useEffect, useRef, useState } from 'react'
import { BrandMark, WalletFallbackMark } from '@/components/BrandMarks'
import { ModalCloseButton } from '@/components/ui/ModalShell'
import { useMobileWallet } from '@/hooks/useMobileWallet'
import { useWallet } from '@/hooks/useWallet'
import { mobileWalletLinks, walletDappUrl } from '@/lib/walletLinks'
import { getParaClient, PARA_PORTAL_THEME } from './para-config'

/** Not exported by the SDK on its own, but reachable through the snapshot. */
type AuthPhase = StateSnapshot['authPhase']

type CredentialMethod = 'passkey' | 'password' | 'PIN'

type CredentialStep = {
  method: CredentialMethod
  url: string
}

type CredentialUrls = {
  passkeyUrl?: string | null
  passwordUrl?: string | null
  pinUrl?: string | null
}

function credentialStepOf(info: CredentialUrls): CredentialStep | null {
  if (info.passkeyUrl) return { method: 'passkey', url: info.passkeyUrl }
  if (info.passwordUrl) return { method: 'password', url: info.passwordUrl }
  if (info.pinUrl) return { method: 'PIN', url: info.pinUrl }
  return null
}

/** Every method Para can broker. `TWITTER` is the wire value — Para never
 *  renamed the enum after X did, so the label and the value differ. */
const OAUTH_METHODS: { method: TOAuthMethod; label: string }[] = [
  { method: 'GOOGLE', label: 'Google' },
  { method: 'TWITTER', label: 'X' },
  { method: 'APPLE', label: 'Apple' },
  { method: 'DISCORD', label: 'Discord' },
  { method: 'FARCASTER', label: 'Farcaster' },
  { method: 'TELEGRAM', label: 'Telegram' },
  { method: 'FACEBOOK', label: 'Facebook' },
]

/** Phases where Para is mid-flight and unmounting us would strand the poll. */
/**
 * Phases that only occur because of something the visitor just did here.
 *
 * `awaiting_session_start` and `waiting_for_session` are deliberately absent:
 * Para sits in them while it polls, including with the code field still
 * untouched, so counting them as busy disabled the close button and Escape on
 * a sheet that was doing nothing.
 */
const BUSY_PHASES: ReadonlySet<AuthPhase> = new Set<AuthPhase>([
  'authenticating_email_phone',
  'authenticating_oauth',
  'processing_authentication',
  'verifying_new_account',
])

type Identifier =
  | { kind: 'empty' }
  | { kind: 'email'; email: string }
  | { kind: 'phone'; phone: `+${number}` }
  | { kind: 'invalid'; hint: string }

/**
 * One field for either an email or a phone number, rather than a mode switch
 * the visitor has to set before typing. An `@` is the only reliable signal —
 * no phone number contains one, and no address omits one.
 */
function parseIdentifier(raw: string): Identifier {
  const value = raw.trim()
  if (!value) return { kind: 'empty' }
  if (value.includes('@')) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value)
      ? { kind: 'email', email: value }
      : { kind: 'invalid', hint: 'That email address looks incomplete.' }
  }
  const compact = value.replace(/[\s().-]/g, '')
  if (/^\+\d{6,15}$/.test(compact)) {
    return { kind: 'phone', phone: compact as `+${number}` }
  }
  // Guessing a country code would silently text the wrong country, so ask.
  if (/^\d{6,15}$/.test(compact)) {
    return { kind: 'invalid', hint: 'Add your country code, like +1.' }
  }
  return { kind: 'invalid', hint: 'Enter an email address or phone number.' }
}

function messageOf(error: unknown): string | null {
  if (!error) return null
  return error instanceof Error ? error.message : String(error)
}

/**
 * Our own sign-in UI, driven by Para's headless auth hooks. Para's packaged
 * modal is never opened for authentication — it stays mounted only so the
 * add-funds step has something to render.
 *
 * The hooks poll internally, so this component must stay mounted for the whole
 * flow: closing is blocked while `BUSY_PHASES` is active.
 */
export default function ParaAuthSheet({
  onClose,
  entry,
  onEntryChange,
}: {
  onClose: () => void
  /** Held above this component so an address typed while Para was still
   *  starting up is not thrown away when the shell hands over. */
  entry: string
  onEntryChange: (value: string) => void
}) {
  // The same singleton ParaProvider was handed, so the state stream below is
  // the one the hooks are driving. `useClient()` returns it too, but optional.
  const para = getParaClient()
  const { connectors, connectWith } = useWallet()
  const mobileWallet = useMobileWallet()

  const { authenticateWithEmailOrPhoneAsync, error: authError } =
    useAuthenticateWithEmailOrPhone()
  const { authenticateWithOAuthAsync, error: oauthError } =
    useAuthenticateWithOAuth()
  const { verifyNewAccountAsync, isPending: verifying, error: verifyError } =
    useVerifyNewAccount()
  const { resendVerificationCodeAsync } = useResendVerificationCode()

  const [code, setCode] = useState('')
  const [authPhase, setAuthPhase] = useState<AuthPhase>('unauthenticated')
  const [pendingMethod, setPendingMethod] = useState<TOAuthMethod | 'local' | null>(
    null,
  )
  const [resent, setResent] = useState(false)
  const [localError, setLocalError] = useState<string | null>(null)
  const [pairingQr, setPairingQr] = useState<string | null>(null)
  const [pairingUri, setPairingUri] = useState<string | null>(null)
  const [hostedVerifyUrl, setHostedVerifyUrl] = useState<string | null>(null)
  // Set when the account's key is being created on Para's own origin. A blocked popup looks
  // exactly like a slow one, so the sheet says which window to look for and offers it again.
  const [credentialStep, setCredentialStep] = useState<CredentialStep | null>(null)

  const popupRef = useRef<Window | null>(null)

  /**
   * Claim a popup window NOW, while a click is still on the stack.
   *
   * The URL that goes in it does not exist yet — Para answers with it a second
   * or two later — and by then the gesture is gone and `window.open` is a
   * blocked popup. So the window is opened blank and navigated when the URL
   * lands.
   *
   * Only from a click that RELIABLY leads to one. Claiming on "Continue"
   * covered a case that no longer exists — the code is framed — and cost every
   * visitor a blank window flashing over the page before it was handed back. A
   * popup that arrives unclaimed and gets blocked is one "don't see it?" click
   * away; a blank window is in everyone's face.
   */
  const claimPopup = useCallback(() => {
    if (popupRef.current && !popupRef.current.closed) return
    popupRef.current = window.open('', 'ParaAuth', 'popup,width=420,height=560')
  }, [])

  const sendPopupTo = useCallback((url: string) => {
    if (popupRef.current && !popupRef.current.closed) {
      popupRef.current.location.replace(url)
      popupRef.current.focus()
      return
    }
    popupRef.current = window.open(url, 'ParaAuth', 'popup,width=420,height=560')
  }, [])
  const lastUrlRef = useRef<string | null>(null)
  const settledRef = useRef(false)

  const identifier = parseIdentifier(entry)

  // WalletConnect runs with its own modal suppressed, so the pairing URI
  // arrives as a connector message and this sheet is what shows it. The QR
  // encoder is imported here rather than at module scope so it rides the
  // sign-in chunk instead of the page load.
  useEffect(() => {
    const wc = connectors.find(connector => connector.id === 'walletConnect')
    if (!wc) return
    let live = true
    const onMessage = ({ type, data }: { type: string; data?: unknown }) => {
      if (type !== 'display_uri' || typeof data !== 'string') return
      setPairingUri(data)
      void import('qrcode')
        .then(qr =>
          qr.toDataURL(data, { margin: 1, width: 320, errorCorrectionLevel: 'M' }),
        )
        .then(url => {
          if (live) setPairingQr(url)
        })
        .catch(() => {
          // The link below still works without it.
        })
    }
    wc.emitter.on('message', onMessage)
    return () => {
      live = false
      wc.emitter.off('message', onMessage)
    }
  }, [connectors])

  // Para hands portal URLs back through the state stream rather than the hook
  // promise, so placing them is our job — and where they go differs by kind.
  //
  // The verification code goes in an IFRAME, inside this sheet. Para confirmed
  // the six-digit page can be framed, and a basic-login account has no WebAuthn
  // step to break, so there is no reason to throw the visitor onto another
  // origin to type six digits.
  //
  // Passkey, password and PIN still take the window: WebAuthn silently fails
  // inside an iframe, and credential entry belongs on the origin that owns the
  // credential.
  useEffect(() => {
    const unsubscribe = para.onStatePhaseChange((snapshot: StateSnapshot) => {
      setAuthPhase(snapshot.authPhase)
      const info = snapshot.authStateInfo
      if (info.verificationUrl) {
        setHostedVerifyUrl(info.verificationUrl)
        // The window claimed on the click was insurance against a URL that
        // needed one. This one does not, so give it straight back rather than
        // leaving a blank popup around.
        popupRef.current?.close()
        popupRef.current = null
      }
      const next = credentialStepOf(info)
      if (next && next.url !== lastUrlRef.current) {
        lastUrlRef.current = next.url
        setCredentialStep(current =>
          current?.url === next.url && current.method === next.method
            ? current
            : next,
        )
        sendPopupTo(next.url)
      }
      // Closing is what settles the flow: the host reports the transition,
      // which is what tells wagmi to pick the new Para session up.
      if (snapshot.corePhase === 'authenticated' && !settledRef.current) {
        settledRef.current = true
        setHostedVerifyUrl(null)
        setCredentialStep(null)
        popupRef.current?.close()
        onClose()
      }
    })
    return () => {
      unsubscribe()
      lastUrlRef.current = null
    }
  }, [para, onClose, sendPopupTo])

  const busy = BUSY_PHASES.has(authPhase) || verifying

  // The host dialog swallows Escape so Para's own modal stays in sync with it.
  // This sheet has no such contract, and a dialog you can only leave by
  // hunting for the X is one people get stuck in. Mid-flight is the exception:
  // unmounting then would strand Para's poll.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || busy) return
      event.preventDefault()
      onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [busy, onClose])
  // Para reports this phase only for accounts the app is allowed to verify
  // itself. Basic-login accounts arrive as a `verificationUrl` instead, and
  // take the portal branch below.
  const awaitingCode = authPhase === 'awaiting_account_verification'

  const submitIdentifier = useCallback(async () => {
    if (identifier.kind !== 'email' && identifier.kind !== 'phone') return
    setLocalError(null)
    setPendingMethod('local')
    try {
      await authenticateWithEmailOrPhoneAsync({
        auth:
          identifier.kind === 'email'
            ? { email: identifier.email }
            : { phone: identifier.phone },
        // Para bakes the theme into the URL it generates, so it has to be asked
        // for here rather than applied to the iframe afterwards — nothing of
        // ours can reach inside that frame.
        portalTheme: PARA_PORTAL_THEME,
        sessionPollingCallbacks: {
          onPoll: () => {
            if (popupRef.current?.closed) popupRef.current = null
          },
        },
      })
    } catch (error) {
      setLocalError(messageOf(error))
    } finally {
      setPendingMethod(null)
    }
  }, [authenticateWithEmailOrPhoneAsync, identifier])

  const submitOAuth = useCallback(
    async (method: TOAuthMethod) => {
      setLocalError(null)
      setPendingMethod(method)
      try {
        await authenticateWithOAuthAsync({
          method,
          // ponytail: Farcaster goes through the popup like every other
          // provider, so Para's portal renders its QR. Swap to `onOAuthUrl`
          // + an inline QR if we ever want that step to stay in-page.
          redirectCallbacks: {
            onOAuthPopup: popup => {
              popupRef.current = popup
            },
          },
          oAuthPollingCallbacks: {
            onPoll: () => {
              if (popupRef.current?.closed) popupRef.current = null
            },
          },
        })
      } catch (error) {
        setLocalError(messageOf(error))
      } finally {
        setPendingMethod(null)
      }
    },
    [authenticateWithOAuthAsync],
  )

  const submitCode = useCallback(async () => {
    setLocalError(null)
    // Same reason: the key-creation URL comes back from the call below, too
    // late to open a window without a blocker eating it.
    claimPopup()
    try {
      // Verifying the code is only half of a signup: it answers with the portal
      // URL for creating the account's key, and NOTHING else advances the flow
      // until that window is opened. The URL arrives in this promise, not in
      // the state stream the popup effect watches — waiting on that stream is
      // what left this sitting at "Verifying…" forever.
      const signup = await verifyNewAccountAsync({
        verificationCode: code.trim(),
        portalTheme: PARA_PORTAL_THEME,
      })
      const setup = credentialStepOf(signup)
      if (!setup) return
      lastUrlRef.current = setup.url
      setCredentialStep(setup)
      sendPopupTo(setup.url)
      // Key generation runs on Para's side; this settles when it lands, and the
      // state stream then reports `authenticated` and closes the sheet.
      await para.waitForWalletCreation({
        onPoll: () => {
          if (popupRef.current?.closed) popupRef.current = null
        },
      })
    } catch (error) {
      setLocalError(messageOf(error))
    }
  }, [verifyNewAccountAsync, code, para, claimPopup, sendPopupTo])

  const error =
    localError ??
    messageOf(verifyError) ??
    messageOf(authError) ??
    messageOf(oauthError)

  // Para has this project on basic login, where the code is entered on its own
  // page and `verifyNewAccount` is not a call the app may make — it never
  // settles, so a field of ours here would take a code, accept a wrong one, and
  // hang. Para confirmed that page can be framed, and a basic-login account has
  // no WebAuthn step to break, so it is framed here rather than thrown onto
  // another origin.
  if (hostedVerifyUrl) {
    return (
      <div className="w-full">
        <h2 className="font-agrandir text-2xl font-medium text-ink">
          Enter the code
        </h2>
        <p className="mt-1 text-sm text-smoke-700">
          Sent to <span className="font-medium text-ink">{entry.trim()}</span>.
        </p>
        {/* The frame is cropped to the boxes and nothing else. Para's page
            repeats the heading and the address above them — which the sheet has
            already said in its own words — and below them puts "Didn't receive
            a code?", a label that looks like a link and is not one. Resending is
            offered underneath in our own voice instead.

            The offsets are measured against that page, so they are what to
            revisit if their layout moves: too tight and a row of boxes loses its
            focus ring, too loose and their text peeks back in. Neither breaks
            anything.

            The skeleton behind it covers the beat where the frame paints
            nothing, which mid sign-in reads as broken. */}
        <div
          className="relative mt-4 w-full overflow-hidden"
          style={{ height: '72px' }}
        >
          {/* Not a mock-up of the boxes: a placeholder shaped like the thing
              it is standing in for promises the field is ready, and taking a
              keystroke that goes nowhere is worse than an honest wait. It says
              what it is instead, and gets out of the way. */}
          <div
            aria-hidden="true"
            className="absolute inset-0 flex items-center justify-center"
          >
            <span className="animate-pulse text-xs text-smoke-700">
              Loading secure entry…
            </span>
          </div>
          <iframe
            src={hostedVerifyUrl}
            title="Verification code"
            className="absolute left-0 h-72 w-full border-0"
            style={{ top: '-104px' }}
          />
        </div>
        <button
          type="button"
          onClick={() => {
            setResent(true)
            void resendVerificationCodeAsync({ type: 'SIGNUP' }).catch(() =>
              setResent(false),
            )
          }}
          className="mt-3 text-xs text-smoke-700 underline underline-offset-2 hover:text-ink"
        >
          {resent ? 'Code resent' : 'Resend code'}
        </button>
      </div>
    )
  }

  // Para's passkey page has to run on Para's origin. Its URL only arrives
  // after the identifier request, so browsers are allowed to block the first
  // best-effort popup as no longer user initiated. Keep a real button in our
  // sheet: the second open is directly tied to a click and therefore works
  // even under strict popup blocking.
  if (credentialStep && !awaitingCode) {
    return (
      <div className="w-full">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="font-agrandir text-2xl font-medium text-ink">
              Continue with your {credentialStep.method}
            </h2>
            <p className="mt-1 text-sm text-smoke-700">
              Finish signing in securely with Para.
            </p>
          </div>
          <ModalCloseButton
            onClick={onClose}
            disabled={busy}
            aria-label="Close"
            className="-mr-2 -mt-1"
          />
        </div>
        <button
          type="button"
          onClick={() => sendPopupTo(credentialStep.url)}
          className="btn-primary mt-5 h-10 w-full px-5 text-sm"
        >
          Open {credentialStep.method}
        </button>
        <p className="mt-3 text-xs leading-relaxed text-smoke-700">
          Para opens a secure window because passkeys cannot be used inside this page.
        </p>
      </div>
    )
  }

  if (awaitingCode) {
    return (
      <div className="w-full">
        <h2 className="font-agrandir text-2xl font-medium text-ink">
          Enter your code
        </h2>
        <p className="mt-1 text-sm text-smoke-700">
          Sent to <span className="font-medium text-ink">{entry.trim()}</span>.
        </p>
        <input
          value={code}
          onChange={event => setCode(event.target.value)}
          inputMode="numeric"
          autoComplete="one-time-code"
          placeholder="000000"
          aria-label="Verification code"
          className="input-well mt-5 w-full px-4 py-3 text-center font-agrandir text-2xl tracking-[0.4em]"
        />
        {error ? <p className="mt-2 text-xs text-error-500">{error}</p> : null}
        <div className="mt-4 flex items-center justify-between">
          <button
            type="button"
            onClick={() => {
              setResent(true)
              void resendVerificationCodeAsync({ type: 'SIGNUP' }).catch(() =>
                setResent(false),
              )
            }}
            className="text-xs text-smoke-700 underline underline-offset-2 hover:text-ink"
          >
            {resent ? 'Code resent' : 'Resend code'}
          </button>
          <button
            type="button"
            onClick={submitCode}
            disabled={verifying || code.trim().length === 0}
            className="btn-primary h-10 px-5 text-sm disabled:opacity-60"
          >
            {/* Only this call's own state, never Para's ambient phase: the
                phase sits in "waiting for session" while the field is still
                empty, which read as the button already working. */}
            {verifying ? 'Confirming…' : 'Confirm'}
          </button>
        </div>
        {credentialStep ? (
          <p className="mt-3 text-xs leading-relaxed text-smoke-700">
            Finish setting up your account in the window we opened.{' '}
            <button
              type="button"
              onClick={() => {
                popupRef.current = window.open(
                  credentialStep.url,
                  'ParaAuth',
                  'popup,width=420,height=560',
                )
              }}
              className="underline underline-offset-2 hover:text-ink"
            >
              Don&apos;t see it?
            </button>
          </p>
        ) : null}
      </div>
    )
  }

  return (
    <div className="w-full">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="font-agrandir text-2xl font-medium text-ink">Sign in</h2>
        </div>
        <ModalCloseButton
          onClick={onClose}
          disabled={busy}
          aria-label="Close"
          className="-mr-2 -mt-1"
        />
      </div>

      <form
        onSubmit={event => {
          event.preventDefault()
          void submitIdentifier()
        }}
        className="mt-5"
      >
        <input
          type="text"
          value={entry}
          onChange={event => onEntryChange(event.target.value)}
          placeholder="you@email.com | +1 222 333 4444"
          aria-label="Email address or phone number"
          autoComplete="email"
          autoFocus
          className="input-well w-full px-4 py-3"
        />
        {identifier.kind === 'invalid' && entry.trim().length > 3 ? (
          <p className="mt-1.5 text-xs text-smoke-700">{identifier.hint}</p>
        ) : null}
        <div className="mt-3 flex justify-end">
          <button
            type="submit"
            disabled={
              busy || (identifier.kind !== 'email' && identifier.kind !== 'phone')
            }
            className="btn-primary h-10 px-5 text-sm disabled:opacity-60"
          >
            {pendingMethod === 'local' ? 'Sending…' : 'Continue'}
          </button>
        </div>
      </form>

      <>
          <p className="mb-2 mt-5 text-xs text-smoke-500">Or, use socials</p>
          <div className="scroll-row flex gap-1.5 overflow-x-auto">
            {OAUTH_METHODS.map(({ method, label }) => (
              <button
                key={method}
                type="button"
                onClick={() => void submitOAuth(method)}
                disabled={busy}
                title={label}
                aria-label={label}
                aria-busy={pendingMethod === method}
                className="btn-secondary flex h-10 w-10 shrink-0 items-center justify-center !px-0 disabled:opacity-60"
              >
                <BrandMark
                  method={method}
                  className={`h-5 w-5 shrink-0 ${
                    pendingMethod === method ? 'animate-pulse' : ''
                  }`}
                />
              </button>
            ))}
          </div>

          {pairingUri ? (
            <div className="mt-4 rounded-lg border border-smoke-200 bg-white p-3 text-center">
              <p className="text-xs text-smoke-700">
                Scan with your wallet app, or open it on this device.
              </p>
              {pairingQr ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={pairingQr}
                  alt="WalletConnect pairing QR code"
                  className="mx-auto mt-2 h-40 w-40"
                />
              ) : null}
              <a
                href={pairingUri}
                className="btn-primary mt-2 flex h-10 items-center justify-center text-sm no-underline"
              >
                Open in wallet app
              </a>
            </div>
          ) : null}

          {/* Always rendered, with the row's height reserved. EIP-6963 wallets
              announce themselves over the first few hundred milliseconds, so
              revealing this section once they arrive would resize a panel the
              visitor is already looking at — and it is centred, so it jumps. */}
          <p className="mb-2 mt-4 text-xs text-smoke-500">... or, a wallet.</p>
          <div className="scroll-row flex min-h-10 gap-1.5 overflow-x-auto">
                {connectors.map(connector => (
                  <button
                    key={connector.id}
                    type="button"
                    title={connector.name}
                    aria-label={connector.name}
                    onClick={() => {
                      connectWith(connector.id)
                        .then(onClose)
                        .catch(cause => setLocalError(messageOf(cause)))
                    }}
                    className="btn-secondary flex h-10 w-10 shrink-0 items-center justify-center !px-0"
                  >
                    {connector.icon ? (
                      // EIP-6963 hands us the wallet's own mark as a data URI.
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={connector.icon} alt="" className="h-5 w-5 shrink-0" />
                    ) : (
                      <WalletFallbackMark
                        id={connector.id}
                        className="h-5 w-5 shrink-0"
                      />
                    )}
                  </button>
                ))}
          </div>

          {/* A phone browser with no injected wallet can still get there, but
              only by reopening the page inside the wallet's own browser. */}
          {mobileWallet === 'handoff' && typeof window !== 'undefined' ? (
            <>
              <p className="mb-2 mt-4 text-xs text-smoke-500">
                Open in a wallet app
              </p>
              <div className="flex flex-wrap gap-1.5">
                {mobileWalletLinks(window.location.href).map(link => (
                  <a
                    key={link.name}
                    href={link.url}
                    className="btn-secondary flex h-10 items-center px-3 text-xs no-underline"
                  >
                    {link.name}
                  </a>
                ))}
                {typeof navigator.share === 'function' ? (
                  <button
                    type="button"
                    onClick={() => {
                      void navigator
                        .share({
                          title: document.title,
                          url: walletDappUrl(window.location.href),
                        })
                        .catch(cause => {
                          if (cause instanceof Error && cause.name === 'AbortError') return
                          console.error('Wallet handoff share failed:', cause)
                        })
                    }}
                    className="btn-secondary flex h-10 items-center px-3 text-xs"
                  >
                    Other…
                  </button>
                ) : null}
              </div>
            </>
          ) : null}
      </>

      {error ? <p className="mt-3 text-xs text-error-500">{error}</p> : null}




    </div>
  )
}
