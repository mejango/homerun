import { isRateLimited } from '@bananapus/nana-sdk-core/jbcenter'

/** How often a page asks again for what it shows. */
export const REFRESH_MS = 30_000

/** A read that changes while the page is open: asked again every REFRESH_MS while the tab
 * shows, and as it shows again when the answer went stale meanwhile. */
export const POLLED = { refetchInterval: REFRESH_MS, refetchOnWindowFocus: true } as const

/** One more try for a failed read, and none for a rate limit: asking again only extends it. */
export function retryRead(failures: number, error: unknown): boolean {
  return failures < 1 && !isRateLimited(error)
}
