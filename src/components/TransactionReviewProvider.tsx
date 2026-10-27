'use client'

import {
  type ComponentType,
  type PropsWithChildren,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react'
import { registerReviewHandler, type ReviewModel, type ReviewSimulation } from '@bananapus/nana-sdk-core/review'
import { ModalDialog } from '@/components/ui/ModalShell'
import {
  registerFundingChainSelectionHandler,
  type FundingChainOption,
} from '@/lib/transaction-review'

export type PendingReview = {
  kind: 'review'
  id: number
  /** Core's prompt model, confirmed only by its own confirmation. */
  model: ReviewModel
  /** Core's review-time simulation, which runs while the review is open. */
  simulation?: Promise<ReviewSimulation>
  resolve: (approved: boolean) => void
}

export type PendingFundingChainSelection = {
  kind: 'funding'
  id: number
  options: readonly FundingChainOption[]
  initialChainId: number | null
  resolve: (chainId: number | null) => void
}

export type PendingDialog = PendingReview | PendingFundingChainSelection

export type TransactionReviewDialogProps = {
  pending: PendingDialog
  onFinish: (result: boolean | number | null) => void
}

function cancelPendingDialog(pending: PendingDialog) {
  if (pending.kind === 'review') pending.resolve(false)
  else pending.resolve(null)
}

let dialogLoad: Promise<typeof import('./TransactionReviewDialog')> | undefined
/** The dialog's one download, shared by its preload and the first review; a failed one is tried again next time. */
export function loadReviewDialog() {
  dialogLoad ??= import('./TransactionReviewDialog').catch(error => {
    dialogLoad = undefined
    throw error
  })
  return dialogLoad
}

/**
 * Global, promise-based modal queue. Every low-level transaction boundary
 * registers with this one provider, so simultaneous multichain flows review
 * sequentially and each approval applies to one immutable call snapshot.
 */
export function TransactionReviewProvider({ children }: PropsWithChildren) {
  const nextId = useRef(1)
  const activeRef = useRef<PendingDialog | null>(null)
  const queueRef = useRef<PendingDialog[]>([])
  const [active, setActive] = useState<PendingDialog | null>(null)
  const [Dialog, setDialog] = useState<ComponentType<TransactionReviewDialogProps> | null>(null)

  const enqueueDialog = useCallback((pending: PendingDialog) => {
    if (activeRef.current) {
      queueRef.current.push(pending)
      return
    }
    activeRef.current = pending
    setActive(pending)
  }, [])

  const enqueueFundingChainSelection = useCallback(
    (options: readonly FundingChainOption[], initialChainId: number | null) =>
      new Promise<number | null>(resolve => {
        enqueueDialog({
          kind: 'funding',
          id: nextId.current++,
          options: options.map(option => ({ ...option })),
          initialChainId,
          resolve,
        })
      }),
    [enqueueDialog],
  )

  useEffect(
    () => registerFundingChainSelectionHandler(enqueueFundingChainSelection),
    [enqueueFundingChainSelection],
  )

  useEffect(
    () => () => {
      if (activeRef.current) cancelPendingDialog(activeRef.current)
      queueRef.current.forEach(cancelPendingDialog)
      activeRef.current = null
      queueRef.current = []
    },
    [],
  )

  const finish = useCallback((id: number, result: boolean | number | null) => {
    const current = activeRef.current
    if (!current || current.id !== id) return
    const next = queueRef.current.shift() ?? null
    activeRef.current = next
    setActive(next)
    if (current.kind === 'review') current.resolve(result === true)
    else current.resolve(typeof result === 'number' ? result : null)
  }, [])

  useEffect(
    () =>
      registerReviewHandler(async prompt => {
        const approved = await new Promise<boolean>(resolve => {
          const pending: PendingReview = { kind: 'review', id: nextId.current++, model: prompt.model, simulation: prompt.simulation, resolve }
          // Core withdrew the prompt: its dialog closes, or it leaves the queue.
          prompt.signal.addEventListener('abort', () => {
            if (activeRef.current === pending) finish(pending.id, null)
            else {
              queueRef.current = queueRef.current.filter(queued => queued !== pending)
              resolve(false)
            }
          }, { once: true })
          enqueueDialog(pending)
        })
        return approved ? prompt.confirmation : null
      }),
    [enqueueDialog, finish],
  )

  // Keep the global queue ready immediately, but fetch the full decoder and
  // review UI only when a request arrives. Loading never authorizes a call;
  // cancellation, unmount, or a failed download resolves it as declined.
  useEffect(() => {
    if (!active || Dialog) return
    let cancelled = false
    void loadReviewDialog().then(
      module => {
        if (!cancelled) setDialog(() => module.TransactionReviewDialog)
      },
      () => {
        if (!cancelled) finish(active.id, null)
      },
    )
    return () => { cancelled = true }
  }, [active, Dialog, finish])

  return (
    <>
      {children}
      {active ? (
        Dialog ? (
          <Dialog
            key={active.id}
            pending={active}
            onFinish={result => finish(active.id, result)}
          />
        ) : (
          <ModalDialog
            key={active.id}
            onClose={() => finish(active.id, null)}
            labelledBy={`transaction-review-loading-${active.id}`}
            className="items-start justify-center px-3 py-5 sm:px-6 sm:py-10"
          >
            <div className="card w-full max-w-lg p-5 shadow-2xl">
              <p id={`transaction-review-loading-${active.id}`} role="status">
                Loading transaction review…
              </p>
              <button
                type="button"
                onClick={() => finish(active.id, null)}
                className="btn-secondary mt-4 min-h-[44px] px-5 text-sm"
              >
                Cancel
              </button>
            </div>
          </ModalDialog>
        )
      ) : null}
    </>
  )
}
