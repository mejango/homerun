'use client'

/**
 * What a held write offers: the hold's exit when the chain has not placed it (`exit`), or "Send it
 * again" on a success that settled while the user was away (`send-again`). `release` says whether it
 * took.
 */
export type HeldWrite = { kind: 'exit' | 'send-again'; line: string; warning?: string; label: string; release: () => Promise<boolean> }

/**
 * The held write with a saved attempt's retirement behind its exit: once the user's exit releases the
 * hold, the attempt is retired by that exit, so recovery never asks for it again.
 */
export function retiringExit(held: HeldWrite | null, retire: (reason: { by: 'exit' }) => Promise<unknown>, after?: () => void): HeldWrite | null {
  if (!held || held.kind !== 'exit') return held
  return { ...held, release: async () => {
    const released = await held.release()
    if (released) { await retire({ by: 'exit' }); after?.() }
    return released
  } }
}

export function HeldWriteExit({ held }: { held: HeldWrite | null | undefined }) {
  if (!held) return null
  return <div className="mt-2 space-y-2 text-sm">
    {held.warning && <p>{held.warning}</p>}
    <button type="button" className="btn-secondary min-h-10 px-4" onClick={() => void held.release()}>{held.label}</button>
  </div>
}

/** The line a submitted write shows, with its exit while it is held. */
export function HeldNotice({ tx }: { tx: { notice: string | null; held: HeldWrite | null } }) {
  return <>
    <p>{tx.notice}</p>
    <HeldWriteExit held={tx.held} />
  </>
}
