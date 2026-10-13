'use client'

/** A write the chain has not placed: what sending again would cost, and the user's one exit. */
export type HeldWrite = { line: string; warning: string; label: string; release: () => void }

export function HeldWriteExit({ held }: { held: HeldWrite | null | undefined }) {
  if (!held) return null
  return <div className="mt-2 space-y-2 text-sm">
    <p>{held.warning}</p>
    <button type="button" className="btn-secondary min-h-10 px-4" onClick={held.release}>{held.label}</button>
  </div>
}

/** The line a submitted write shows, with its exit while it is held. */
export function HeldNotice({ tx }: { tx: { notice: string | null; held: HeldWrite | null } }) {
  return <>
    <p>{tx.notice}</p>
    <HeldWriteExit held={tx.held} />
  </>
}
