'use client'

import { useCallback, useEffect, useRef } from 'react'
import type { WriteHoldClient, WriteHoldHandle, WriteHoldState } from '@bananapus/nana-sdk-core/review'
import { sameShownHold } from '@/lib/write-hold'

/** How often a shown hold is asked again, so an exit that becomes due with time appears. */
const HOLD_RECHECK_MS = 15_000

/**
 * Keep a shown write hold current: every state it reports (this tab's,
 * another tab's, its own follow's, and the latest one the SDK replays as it
 * subscribes) reaches `onState`, and it is asked again every 15 seconds while
 * `hold` is given, so an exit that becomes due with time appears. An exit
 * reaches `onState` only from the chain's answer to such a check: a reported
 * state that offers one is checked first, and the same state without its exit
 * never hides the exit `shown` (the state the screen shows) already has: only
 * another chain answer does. `checkNow` also asks the chain at once. Returns a
 * recheck for after a manual check.
 */
export function useWriteHoldWatch(
  hold: WriteHoldHandle | undefined,
  client: WriteHoldClient | undefined,
  onState: (state: WriteHoldState) => void,
  { checkNow = false, shown }: { checkNow?: boolean; shown?: WriteHoldState | null } = {},
): () => void {
  const onStateRef = useRef(onState)
  const clientRef = useRef(client)
  const shownRef = useRef(shown)
  useEffect(() => {
    onStateRef.current = onState
    clientRef.current = client
    shownRef.current = shown
  })
  const recheckRef = useRef<() => void>(() => {})
  useEffect(() => {
    if (!hold) return
    let live = true
    let checking = false
    // The chain's answer reaches `onState` itself: only that, never a replayed or
    // peeked state, may offer an exit.
    const check = () => {
      const current = clientRef.current
      if (!current || checking) return
      checking = true
      void hold.state(current)
        .then(state => { if (live) onStateRef.current(state) }, () => {})
        .finally(() => { checking = false })
    }
    // The SDK replays the hold's latest state as it subscribes, so a state reported before is not missed.
    // One that offers an exit is asked of the chain first.
    const stop = hold.subscribe(state => {
      if (state.status !== 'clear' && state.exit) { check(); return }
      // The same state without the exit (a replay, or a look while the lock was contended) never
      // hides an exit the chain offered: only another chain answer does.
      const current = shownRef.current
      if (state.status !== 'clear' && current && current.status !== 'clear' && current.exit &&
        sameShownHold({ ...state, exit: true } as WriteHoldState, current)) return
      onStateRef.current(state)
    })
    recheckRef.current = check
    const timer = setInterval(check, HOLD_RECHECK_MS)
    return () => {
      live = false
      stop()
      clearInterval(timer)
      recheckRef.current = () => {}
    }
  }, [hold])
  useEffect(() => {
    if (hold && checkNow) recheckRef.current()
  }, [hold, checkNow])
  return useCallback(() => recheckRef.current(), [])
}
