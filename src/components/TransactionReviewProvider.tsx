'use client'

import {
  type ComponentType,
  type PropsWithChildren,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react'
import { registerReviewHandler, type ReviewModel, type ReviewSimulation } from '@bananapus/nana-sdk-core/review'
import { createReviewQueue } from '@bananapus/nana-sdk-core/review/machines'
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
}

export type PendingFundingChainSelection = {
  kind: 'funding'
  id: number
  options: readonly FundingChainOption[]
  initialChainId: number | null
}

export type PendingDialog = PendingReview | PendingFundingChainSelection
type Payload = Omit<PendingReview, 'id'> | Omit<PendingFundingChainSelection, 'id'>
/** True approves a review, a chain ID picks a funding chain, anything else declines. */
type DialogResult = boolean | number | null

export type TransactionReviewDialogProps = {
  pending: PendingDialog
  onFinish: (result: DialogResult) => void
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
  const [queue] = useState(() => createReviewQueue<Payload, DialogResult>())
  const state = useSyncExternalStore(queue.subscribe, queue.getState, queue.getState)
  const active = useMemo<PendingDialog | null>(
    () => state.active && ({ id: state.active.id, ...state.active.payload } as PendingDialog),
    [state.active],
  )
  const [Dialog, setDialog] = useState<ComponentType<TransactionReviewDialogProps> | null>(null)

  useEffect(
    () =>
      registerReviewHandler(async prompt => {
        const approved = await queue.request(
          { kind: 'review', model: prompt.model, simulation: prompt.simulation },
          { declined: false, approves: result => result === true, signal: prompt.signal },
        )
        return approved === true ? prompt.confirmation : null
      }),
    [queue],
  )
  useEffect(
    () => registerFundingChainSelectionHandler(async (options, initialChainId) => {
      const chosen = await queue.request(
        { kind: 'funding', options: options.map(option => ({ ...option })), initialChainId },
        { declined: null, approves: result => typeof result === 'number' },
      )
      return typeof chosen === 'number' ? chosen : null
    }),
    [queue],
  )
  useEffect(() => () => queue.cancelAll(), [queue])

  const finish = (id: number, result: DialogResult) => { void queue.finish(id, result) }

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
        if (!cancelled) void queue.finish(active.id, null)
      },
    )
    return () => { cancelled = true }
  }, [active, Dialog, queue])

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
