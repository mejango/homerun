import type { QueryClient } from '@tanstack/react-query'

/** The index trails a confirmed transaction by a few seconds; look again while it catches up. */
const CATCH_UP_MS = [0, 4_000, 12_000] as const

/**
 * Refresh a project's indexed reads (activity, holders, index row) after a confirmed
 * transaction. Their query keys use a numeric project ID, never a bigint.
 */
export function refreshIndexedProject(cache: QueryClient, chainId: number, projectId: bigint | number) {
  const id = Number(projectId)
  const refresh = () => {
    for (const prefix of ['project-activity', 'project-participants', 'indexed-project']) {
      const filters = { queryKey: [prefix, chainId, id] }
      // Discard initial reads started before confirmation before refreshing.
      void cache.cancelQueries(filters).then(() => cache.invalidateQueries(filters))
    }
  }
  for (const delay of CATCH_UP_MS) {
    if (delay === 0) refresh()
    else setTimeout(refresh, delay)
  }
}
