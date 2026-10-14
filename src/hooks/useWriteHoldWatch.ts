'use client'

import { useCallback, useEffect, useRef } from 'react'
import type { WriteHoldClient, WriteHoldHandle, WriteHoldState } from '@bananapus/nana-sdk-core/review'

/** How often a shown hold is asked again, so an exit that becomes due with time appears. */
const HOLD_RECHECK_MS = 15_000

/**
 * Keep a shown write hold current: every state it reports (this tab's,
 * another tab's, its own follow's) reaches `onState`, and it is asked again
 * every 15 seconds while `hold` is given, so an exit that becomes due with
 * time appears. Its latest state reaches `onState` as it subscribes (the SDK
 * replays it), and `checkNow` also asks the chain at once. Returns a recheck
 * for after a manual check.
 */
export function useWriteHoldWatch(
  hold: WriteHoldHandle | undefined,
  client: WriteHoldClient | undefined,
  onState: (state: WriteHoldState) => void,
  { checkNow = false }: { checkNow?: boolean } = {},
): () => void {
  const onStateRef = useRef(onState)
  const clientRef = useRef(client)
  useEffect(() => {
    onStateRef.current = onState
    clientRef.current = client
  })
  const recheckRef = useRef<() => void>(() => {})
  useEffect(() => {
    if (!hold) return
    // The SDK replays the hold's latest state as it subscribes, so a state reported before is not missed.
    const stop = hold.subscribe(state => onStateRef.current(state))
    const check = () => {
      const current = clientRef.current
      if (current) void hold.state(current).catch(() => {})
    }
    recheckRef.current = check
    const timer = setInterval(check, HOLD_RECHECK_MS)
    return () => {
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
