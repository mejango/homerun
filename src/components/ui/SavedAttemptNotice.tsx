'use client'

import { useState } from 'react'
import { HELD_SUCCESS_LINE, SAVED_ATTEMPT_TAB_ONLY_LINE } from '@bananapus/nana-sdk-core/review'
import type { UseSavedAttemptResult } from '@/hooks/held-binding'

/**
 * What a saved attempt's recovery asks of the user, in the SDK's words: its one check action (and,
 * only once storage proved unreadable, the warned exit), or "Check again" on a success the hold
 * settled whose details can't be shown here. It decides nothing.
 */
export function SavedAttemptNotice({ attempt, title }: { attempt: UseSavedAttemptResult<unknown>; title?: string }) {
  const [busy, setBusy] = useState(false)
  const [tabOnly, setTabOnly] = useState(false)
  const { outcome, checkAction, unreadableAction } = attempt
  const run = (action: () => Promise<{ retired: boolean; durable?: boolean } | unknown>) => {
    setBusy(true)
    void action().then(result => {
      const retired = result as { retired?: boolean; durable?: boolean } | null
      if (retired?.retired) setTabOnly(retired.durable === false)
    }, () => undefined).finally(() => setBusy(false))
  }
  const button = 'btn-secondary min-h-10 justify-self-start px-4'
  if (checkAction) return <div role="status" className="mt-4 grid gap-2 text-sm">
    {title && <p className="font-medium">{title}</p>}
    <p>{checkAction.line}</p>
    <p>{checkAction.warning}</p>
    <button type="button" className={button} disabled={busy} onClick={() => run(checkAction.run)}>{checkAction.label}</button>
    {unreadableAction && <>
      <p>{unreadableAction.line}</p>
      <button type="button" className={button} disabled={busy} onClick={() => run(unreadableAction.run)}>{unreadableAction.label}</button>
    </>}
  </div>
  if (outcome?.status === 'done' && outcome.result === 'success' && !outcome.authenticated) return <div role="status" className="mt-4 grid gap-2 text-sm">
    {title && <p className="font-medium">{title}</p>}
    <p>{HELD_SUCCESS_LINE}</p>
    <button type="button" className={button} disabled={busy || attempt.recovering} onClick={() => run(attempt.recover)}>Check again</button>
  </div>
  return tabOnly ? <p role="status" className="mt-4 text-sm">{SAVED_ATTEMPT_TAB_ONLY_LINE}</p> : null
}
