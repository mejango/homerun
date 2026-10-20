'use client'

import { ModalShell } from '@/components/ui/ModalShell'

// A browser caches a failed dynamic import, so retrying the same chunk fails again without a request; only a reload
// fetches it anew. lazyComponent renders these when a chunk cannot load, instead of crashing the page.

const reload = () => window.location.reload()

export function ChunkFailed() {
  return (
    <div role="alert" className="card flex flex-wrap items-center justify-between gap-3 p-4 text-sm">
      <span>This part of the page did not load.</span>
      <button type="button" className="button" onClick={reload}>Reload the page to try again</button>
    </div>
  )
}

export function ChunkFailedDialog({ onClose }: { onClose: () => void }) {
  return (
    <ModalShell title="This did not load" onClose={onClose}>
      <div role="alert" className="flex flex-wrap items-center justify-between gap-3 text-sm">
        <span>Your connection may have dropped.</span>
        <button type="button" className="button" onClick={reload}>Reload the page to try again</button>
      </div>
    </ModalShell>
  )
}
