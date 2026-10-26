'use client'

import { useEffect, useId, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { ReviewContextRow } from '@bananapus/nana-sdk-core/review'
import {
  ModalCloseButton,
  ModalDialog,
  useEnclosingModalCard,
  useHoldEnclosingModal,
} from '@/components/ui/ModalShell'
import { TxSteps } from '@/components/ui/TxSteps'
import { HeldWriteExit, type HeldWrite } from '@/components/ui/HeldWriteExit'

/** The rows a progress shows, as its write's review shows them: a row whose value is not plain text stays on the progress only. */
export function reviewContext(rows: readonly TxProgressRow[]): ReviewContextRow[] {
  return rows.flatMap(row => typeof row.label === 'string' && (typeof row.value === 'string' || typeof row.value === 'number')
    ? [{ label: row.label, value: String(row.value), ...(row.mono ? { mono: true } : {}), ...(row.strong ? { strong: true } : {}) }]
    : [])
}

export type TxProgressRow = {
  label: ReactNode
  value: ReactNode
  /** Render the value in a monospace face (addresses, hashes). */
  mono?: boolean
  /** Emphasize the value (the amount that leaves the wallet). */
  strong?: boolean
}

/**
 * A write's progress: what it does (label/value rows), the wallet-prompt queue,
 * its status and error. It never confirms: `start` opens the write's one review
 * as soon as the progress is open and ready, and again from Try again after an
 * error. Closing is refused while `busy`; once `complete` the footer is Done.
 */
export function TxProgress({
  open,
  onClose,
  eyebrow = 'Review',
  title,
  rows,
  children,
  steps,
  activeIndex,
  stepsIntro,
  start,
  cancelLabel = 'Cancel',
  busy = false,
  complete = false,
  settled = false,
  preparing = false,
  status,
  held,
  error,
}: {
  open: boolean
  onClose: () => void
  eyebrow?: string
  title: ReactNode
  rows?: readonly TxProgressRow[]
  /** Extra body content under the rows (warnings, notes, custom grids). */
  children?: ReactNode
  steps: readonly { key?: string; title: ReactNode; detail?: string }[]
  activeIndex: number
  stepsIntro?: string
  /** Opens the write's review; absent while it can't start yet (a quote still loading, say). */
  start?: () => void
  cancelLabel?: string
  busy?: boolean
  complete?: boolean
  /** The action is submitted to a Safe; Done dismisses it without marking its steps confirmed. */
  settled?: boolean
  /** Rows and steps are still being read; `status` says what is happening. */
  preparing?: boolean
  status?: ReactNode
  /** The write is held: the user's exit, shown under `status`. */
  held?: HeldWrite | null
  error?: ReactNode
}) {
  const titleId = useId()
  const ready = open && !busy && !preparing && !complete && !settled && !error && !!start
  // Once per opening or preparation: a cancelled review leaves the progress to its site, never
  // reopens itself; a new preparation is a new write.
  const started = useRef(false)
  const startRef = useRef(start)
  startRef.current = start
  useEffect(() => {
    if (!open || preparing) started.current = false
    else if (ready && !started.current) {
      started.current = true
      startRef.current?.()
    }
  }, [open, preparing, ready])
  // Inside a ModalShell already, the confirm replaces that card's content in
  // place: one scrim, one card, and closing brings the form back.
  const host = useEnclosingModalCard()
  // Hosted, the confirm has no dialog of its own: while busy it keeps the
  // enclosing shell open, or Escape there would drop a send in flight.
  useHoldEnclosingModal(open && busy)
  useEffect(() => {
    if (!host || !open) return
    const hidden = Array.from(host.children).filter(
      (child): child is HTMLElement =>
        child instanceof HTMLElement &&
        !child.hasAttribute('data-tx-confirm') &&
        !child.hidden,
    )
    hidden.forEach(child => (child.hidden = true))
    return () => hidden.forEach(child => (child.hidden = false))
  }, [host, open])
  if (!open) return null
  const section = (
    <section
      data-tx-confirm
      className={
        host
          ? 'w-full bg-bone'
          : 'w-full max-w-lg overflow-hidden rounded-2xl border border-smoke-300 bg-bone shadow-2xl'
      }
    >
        <header className="flex items-start justify-between gap-4 border-b border-smoke-200 bg-bone px-5 py-4">
          <div className="min-w-0">
            <p className="text-xs font-medium uppercase tracking-wide text-bluebs-600">
              {eyebrow}
            </p>
            <h2
              id={titleId}
              className="mt-1 font-agrandir text-xl font-medium text-ink"
            >
              {title}
            </h2>
          </div>
          <ModalCloseButton
            onClick={onClose}
            disabled={busy}
            aria-label="Close"
            className="-mr-2 -mt-2 transition-transform hover:scale-110 hover:bg-transparent disabled:opacity-40"
          />
        </header>
        <div className="space-y-4 px-5 py-5">
          {preparing ? (
            <p className="py-2 text-sm text-bluebs-700" role="status">
              {status ?? 'Preparing…'}
            </p>
          ) : (
            <>
              {rows && rows.length > 0 ? (
                <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
                  {rows.map((row, index) => (
                    <TxProgressRowItem key={index} row={row} />
                  ))}
                </div>
              ) : null}
              {children}
              <TxSteps
                steps={steps}
                activeIndex={complete ? steps.length : activeIndex}
                intro={stepsIntro}
                className="rounded-xl border border-smoke-200 bg-white p-3"
              />
              {status ? <p className="text-sm text-bluebs-700">{status}</p> : null}
              <HeldWriteExit held={held} />
            </>
          )}
          {error ? <p className="text-sm text-red-600">{error}</p> : null}
        </div>
        <footer className="flex justify-end gap-2 border-t border-smoke-200 bg-bone px-5 py-4">
          {complete || settled ? (
            <button
              type="button"
              className="btn-primary min-h-[44px] px-5 text-sm"
              onClick={onClose}
            >
              Done
            </button>
          ) : (
            <>
              <button
                type="button"
                className="btn-secondary min-h-[44px] px-5 text-sm"
                disabled={busy}
                onClick={onClose}
              >
                {cancelLabel}
              </button>
              {/* After an error, or a review the person closed, the write starts again only from here. */}
              {start && !busy && (error || (ready && started.current)) ? (
                <button
                  type="button"
                  className="btn-primary min-h-[44px] px-5 text-sm"
                  disabled={preparing}
                  onClick={start}
                >
                  {error ? 'Try again' : 'Review again'}
                </button>
              ) : null}
            </>
          )}
        </footer>
    </section>
  )
  if (host) return createPortal(section, host)
  return (
    <ModalDialog
      onClose={onClose}
      dismissible={!busy}
      labelledBy={titleId}
      className="items-start justify-center px-3 py-6 sm:items-center"
    >
      {section}
    </ModalDialog>
  )
}

function TxProgressRowItem({ row }: { row: TxProgressRow }) {
  return (
    <>
      <span className="text-smoke-500">{row.label}</span>
      <span
        className={`min-w-0 text-right text-ink ${
          row.mono ? 'break-all font-mono text-xs' : 'break-words'
        } ${row.strong ? 'font-medium' : ''}`}
      >
        {row.value}
      </span>
    </>
  )
}
