'use client'

/**
 * The SDK's React binding of its held-write view and saved-attempt recovery, kept in this one file
 * until `@bananapus/nana-sdk-core/review/react` ships (SDK 2.40): nana-sdk-react 53 peers on wagmi 2
 * and Homerun runs wagmi 3. Same names and signatures as the SDK's hooks, over core's framework-free
 * `createHeldWriteView` and `createSavedAttemptRecovery`; it decides nothing. Swap the imports for
 * the SDK's and delete this file.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { Address } from 'viem'
import {
  checkedItLabel, createHeldWriteView, HELD_RELEASE_LABEL, SAVED_ATTEMPT_CONTINUE_ANYWAY_LABEL, SAVED_ATTEMPT_UNREADABLE_LINE,
  type HeldWriteView, type HeldWriteViewController, type SavedAttempt, type SavedAttemptOutcome, type SavedAttemptRecovery,
  type SavedAttemptRetirement, type WriteHold, type WriteHoldClient, type WriteHoldHandle,
} from '@bananapus/nana-sdk-core/review'

type Retired = Awaited<ReturnType<SavedAttemptRecovery['retire']>>

export type UseSavedAttemptResult<T> = {
  outcome: SavedAttemptOutcome<T> | null
  recovering: boolean
  recover: () => Promise<SavedAttemptOutcome<T> | null>
  checkAction: { line: string; warning: string; label: string; run: () => Promise<Retired> } | null
  unreadableAction: { line: string; label: string; run: () => Promise<Retired> } | null
  retire: (reason: SavedAttemptRetirement) => Promise<Retired>
}

const keyOf = (attempt: unknown) => attempt
  ? JSON.stringify({ ...(attempt as object), authenticate: undefined }, (_, value) => typeof value === 'bigint' ? value.toString() : value)
  : null

/** One saved attempt's recovery: recovered when it (or the client) appears, before any new send is prepared. */
export function useSavedAttempt<T>({ recovery, attempt, client, checkNext }: {
  recovery: SavedAttemptRecovery; attempt: SavedAttempt<T> | null | undefined; client: WriteHoldClient | undefined; checkNext?: string
}): UseSavedAttemptResult<T> {
  const key = keyOf(attempt)
  const latest = useRef(attempt)
  latest.current = attempt
  // The key stands for the attempt.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const lifecycle = useMemo(() => ({ recovery, client }), [key, recovery, client])
  const requests = useRef(0)
  const rendered = useRef(lifecycle)
  rendered.current = lifecycle
  const mounted = useRef(false)
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const [shown, setShown] = useState<{ of?: typeof lifecycle; outcome: SavedAttemptOutcome<T> | null; recovering: boolean }>({ outcome: null, recovering: false })
  const [unreadable, setUnreadable] = useState<typeof lifecycle>()
  const recover = useCallback(async () => {
    const saved = latest.current
    if (!saved || !lifecycle.client || !mounted.current || rendered.current !== lifecycle) return null
    const request = ++requests.current
    setShown(now => ({ of: lifecycle, outcome: now.of === lifecycle ? now.outcome : null, recovering: true }))
    const outcome = await lifecycle.recovery.recover(saved, lifecycle.client)
    if (!mounted.current || rendered.current !== lifecycle || requests.current !== request) return null
    setShown({ of: lifecycle, outcome, recovering: false })
    return outcome
  }, [lifecycle])
  useEffect(() => { void recover() }, [recover])
  const retire = useCallback(async (reason: SavedAttemptRetirement): Promise<Retired> => {
    const saved = latest.current
    if (!saved || !mounted.current || rendered.current !== lifecycle) return { retired: false }
    const retired = await lifecycle.recovery.retire(saved, reason)
    if (!mounted.current || rendered.current !== lifecycle) return retired
    if (!retired.retired && retired.reason === 'unreadable') setUnreadable(lifecycle)
    await recover()
    return retired
  }, [lifecycle, recover])
  const outcome = shown.of === lifecycle ? shown.outcome : null
  return {
    outcome,
    recovering: shown.of === lifecycle && shown.recovering,
    recover,
    checkAction: outcome?.status === 'check'
      ? { line: outcome.line, warning: outcome.warning, label: checkedItLabel(checkNext), run: () => retire({ by: 'check', outcome }) } : null,
    unreadableAction: outcome?.status === 'check' && unreadable === lifecycle
      ? { line: SAVED_ATTEMPT_UNREADABLE_LINE, label: SAVED_ATTEMPT_CONTINUE_ANYWAY_LABEL, run: () => retire({ by: 'check', outcome, force: 'unreadable' }) } : null,
    retire,
  }
}

/** One held write an app-wide notice shows. */
export type HeldWriteItem = { key: string; label?: string; view: HeldWriteView; release: () => Promise<boolean> }

/** The holds of a fixed set of actions, found by their intents alone and shown with their lines and exits. */
export function useHeldIntents({ hold, chainId, account, client, intents, pollMs }: {
  hold: WriteHold; chainId: number; account: Address | undefined; client: WriteHoldClient | undefined
  intents: readonly { namespace: string; label?: string }[]; pollMs?: number
}): HeldWriteItem[] {
  const intentsKey = JSON.stringify(intents)
  const entries = useMemo(() => account ? intents.map(({ namespace, label }) => ({
    key: namespace, label, handle: hold.open({ chainId, account, safe: false, namespace, call: { to: account, data: '0x' } }),
  })) : [],
  // The intents key stands for the intents.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [hold, chainId, account, intentsKey])
  return useHeldViews(entries, client, pollMs)
}

function useHeldViews(entries: { key: string; label?: string; handle: WriteHoldHandle }[], client: WriteHoldClient | undefined, pollMs?: number): HeldWriteItem[] {
  const views = useMemo(() => client ? entries.map(entry => ({ entry, view: createHeldWriteView(entry.handle, { client, pollMs }) })) : [], [entries, client, pollMs])
  useEffect(() => {
    const stops = views.map(({ view }) => view.start())
    return () => stops.forEach(stop => stop())
  }, [views])
  const store = useMemo(() => feed(views.map(({ view }) => view)), [views])
  const shown = useSyncExternalStore(store.subscribe, store.get, store.get)
  return views.map(({ entry, view }, index) => ({ key: entry.key, ...(entry.label ? { label: entry.label } : {}), view: shown[index], release: view.exit }))
    .filter(({ view }) => view.phase !== 'clear')
}

function feed(views: HeldWriteViewController[]) {
  let snapshot = views.map(view => view.get())
  return {
    subscribe(listener: () => void) {
      const stops = views.map(view => view.subscribe(() => { snapshot = views.map(each => each.get()); listener() }))
      return () => stops.forEach(stop => stop())
    },
    get: () => snapshot,
  }
}

/** The one app-wide notice of held writes: each with its label, line, warning, and the release when its hold offers the exit. */
export function HeldWritesNotice({ items, className }: { items: readonly HeldWriteItem[]; className?: string }) {
  const [busy, setBusy] = useState<string | null>(null)
  const shown = items.filter(({ view }) => view.line)
  if (!shown.length) return null
  return <div role="status" className={className}>{shown.map(({ key, label, view, release }) => <div key={key} data-phase={view.phase}>
    {label ? <p>{label}</p> : null}
    <p>{view.line}</p>
    {view.warning ? <p>{view.warning}</p> : null}
    {view.notice ? <p>{view.notice}</p> : null}
    {view.exit ? <button type="button" disabled={busy === key} onClick={() => { setBusy(key); void release().finally(() => setBusy(null)) }}>{HELD_RELEASE_LABEL}</button> : null}
  </div>)}</div>
}
