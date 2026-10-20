/** Loads code a page is likely to need next once the browser is idle, so the tab or step that uses it opens at once.
 * Returns a cancel for an effect cleanup. */
export function preloadWhenIdle(loads: readonly (() => Promise<unknown>)[]): () => void {
  const run = () => { for (const load of loads) load().catch(() => {}) }
  if (typeof window.requestIdleCallback === 'function') {
    const id = window.requestIdleCallback(run, { timeout: 4_000 })
    return () => window.cancelIdleCallback(id)
  }
  const id = window.setTimeout(run, 1_500)
  return () => window.clearTimeout(id)
}
