import type { JBChainId } from '@bananapus/nana-sdk-core'
import {
  displayChainId,
  displayChainName,
  displayChainSlug,
} from './chainDisplay'

/**
 * Parse a `<chainSlug>:<projectId>` URN (e.g. `eth:1`). V6-only site: no
 * version segment — bare URNs ARE v6.
 */
export function parseUrn(
  urn: string,
): { chainId: JBChainId; projectId: number } | null {
  const [slug, id] = decodeURIComponent(urn).split(':')
  const chainId = displayChainId(slug?.trim())
  const projectId = Number(id)
  if (chainId === null || !Number.isInteger(projectId) || projectId <= 0) {
    return null
  }
  return { chainId: chainId as JBChainId, projectId }
}

export function toUrn(chainId: number, projectId: number): string {
  return `${displayChainSlug(chainId) ?? chainId}:${projectId}`
}

export function chainName(chainId: number): string {
  return displayChainName(chainId)
}

const LEGACY_SITE = 'https://old.juicebox.money'

/**
 * Rebuild a request path on the legacy site with each segment decoded once and
 * re-normalized. The legacy app matches literal characters — its `/@handle`
 * route 404s when handed `/%40handle` — while `encodeURI` keeps the result a
 * valid Location header (spaces, non-ASCII) without touching `@` or `:`.
 */
export function legacyHref(pathname: string, search = ''): string {
  const path = pathname
    .split('/')
    .map(segment => {
      try {
        return decodeURIComponent(segment)
      } catch {
        return segment
      }
    })
    .join('/')
  return `${LEGACY_SITE}${encodeURI(path)}${search}`
}

/**
 * Where a project on a prior protocol version lives, now that this app holds the
 * apex domain and V1–V5 serve from old.juicebox.money.
 *
 * That app's route shapes are not uniform, and guessing one uniformly lands on its
 * 404 rather than the project:
 *   V4/V5  `/v5/eth:1`  — chain-scoped, and its slugs match ours (eth/op/base/arb)
 *   V2/V3  `/v2/p/1`    — mainnet-only ids, both versions served under /v2
 *   V1     `/p/<handle>` — handle-keyed, and no caller here holds the handle
 *
 * The indexer this app reads carries versions 4 and up, so the older branches are
 * a guard against a link that would 404, not a live path.
 */
export function legacyProjectHref(
  chainId: number,
  projectId: number,
  version: number,
): string {
  if (version >= 4) {
    return `${LEGACY_SITE}/v${version}/${toUrn(chainId, projectId)}`
  }
  if (version >= 2) return `${LEGACY_SITE}/v2/p/${projectId}`
  return LEGACY_SITE
}
