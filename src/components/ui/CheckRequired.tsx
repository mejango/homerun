'use client'

/**
 * A settled write this screen couldn't authenticate: its completion is withheld, and the flow reopens
 * only on the user's explicit check. Every flow shows it the same way.
 */
export function CheckRequired({ line, action, onChecked, retry }: { line: string; action: string; onChecked: () => void; retry?: () => void }) {
  return <div role="status" className="mt-4 grid gap-2 text-sm">
    <p>{line}</p>
    <div className="flex flex-wrap gap-3">
      {retry && <button type="button" className="btn-secondary min-h-10 px-4" onClick={retry}>Check again</button>}
      <button type="button" className="btn-secondary min-h-10 px-4" onClick={onChecked}>{action}</button>
    </div>
  </div>
}
