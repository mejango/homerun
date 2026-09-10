'use client'

import { ModalCloseButton } from '@/components/ui/ModalShell'

/**
 * What we say once the purchase is handed to the on-ramp provider.
 *
 * Card purchases of crypto are declined far more often than people expect —
 * the only public study of the question put card authorisation around 43%
 * against 96% for bank transfer — and the decline arrives in the provider's
 * window with no explanation. Saying so up front, with the one lever that
 * actually helps, is cheaper than a support ticket that reads "your site is
 * broken".
 *
 * `url` is the same window we just opened: popup blockers are common enough
 * that the handoff needs a link the visitor can click themselves.
 */
export function OnRampHandoff({
  url,
  asset,
  onClose,
}: {
  url: string
  /** What the provider is being asked to deliver, so the heading names it. */
  asset?: string
  onClose: () => void
}) {
  return (
    <div className="w-full">
      <div className="flex items-start justify-between gap-4">
        <h2 className="font-agrandir text-2xl font-medium text-ink">
          {asset ? `Buy ${asset} in the new window` : 'Finish in the new window'}
        </h2>
        <ModalCloseButton
          onClick={onClose}
          aria-label="Close"
          className="-mr-2 -mt-1"
        />
      </div>

      <p className="mt-2 text-sm text-smoke-700">
        Your wallet address is already filled in. Purchases don&apos;t always go
        through on the first try — card declines are common and usually come
        with no explanation.
      </p>

      <p className="mt-4 text-sm font-medium text-ink">If it doesn&apos;t work</p>
      <ul className="mt-1.5 space-y-1.5 text-sm text-smoke-700">
        <li>
          Pick a bank transfer instead of a card if one is offered — it goes
          through far more often.
        </li>
        <li>Try a smaller amount. Small purchases are approved more often.</li>
        <li>Try a different card, or come back and pick another wallet.</li>
      </ul>

      <div className="mt-5 flex items-center justify-between">
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-smoke-700 underline underline-offset-2 hover:text-ink"
        >
          Window didn&apos;t open?
        </a>
        <button
          type="button"
          onClick={onClose}
          className="btn-primary h-10 px-5 text-sm"
        >
          Done
        </button>
      </div>
    </div>
  )
}

/**
 * The provider's own page, inside our dialog.
 *
 * For a purchase started mid-payment: sending someone to another window loses
 * the thread of what they were doing. Para's portal answers over a
 * `MessagePort` it supplies, so it does not care whether it is a popup or a
 * frame — what it does care about is that the purchase was recorded, which
 * `recordOnRampPurchase` does before this renders.
 */
export function OnRampFrame({
  url,
  asset,
  onClose,
}: {
  url: string
  asset?: string
  onClose: () => void
}) {
  return (
    <div className="w-full">
      <div className="flex items-start justify-between gap-4">
        <h2 className="font-agrandir text-xl font-medium text-ink">
          {asset ? `Buy ${asset}` : 'Buy ETH or USDC'}
        </h2>
        <ModalCloseButton
          onClick={onClose}
          aria-label="Close"
          className="-mr-2 -mt-1"
        />
      </div>
      <p className="mt-1 text-sm text-smoke-700">
        Your wallet address is already filled in. Come back here when it&apos;s
        done.
      </p>
      <iframe
        src={url}
        title={asset ? `Buy ${asset}` : 'Buy crypto'}
        className="mt-3 h-[32rem] w-full rounded-lg border border-smoke-200"
      />
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="mt-2 inline-block text-xs text-smoke-700 underline underline-offset-2 hover:text-ink"
      >
        Open in a separate window instead
      </a>
    </div>
  )
}
