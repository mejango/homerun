import { cache } from 'react'
import { getProject, type BsProject } from '@/lib/bendystraw'
import { fetchFundProjectMetadata, type FundProjectMetadata } from '@/lib/fund-project-metadata'

/** What the server can say about a project before any contract read: its index row and published details. */
export type ProjectSeed = { indexed: BsProject | null; details: FundProjectMetadata | null }

/** A slow index or gateway must never hold the page: past this, the client loads it as before. */
const SEED_WAIT_MS = 2_500

function within<T>(read: Promise<T>): Promise<T | null> {
  return Promise.race([read, new Promise<null>(resolve => setTimeout(() => resolve(null), SEED_WAIT_MS))]).catch(() => null)
}

/** Server only. Deduplicated per request, so the page and its metadata share one read. */
export const loadProjectSeed = cache(async (chainId: number, projectId: string): Promise<ProjectSeed> => {
  const id = Number(projectId)
  const row = Number.isSafeInteger(id) ? await within(getProject(chainId, id)) : null
  // The index row must be this exact V6 project; anything else is not a seed.
  const indexed = row && row.version === 6 && row.chainId === chainId && String(row.projectId) === projectId ? row : null
  // Content-addressed, so a cached copy of the same URI is the same document.
  const details = indexed?.metadataUri
    ? await within(fetchFundProjectMetadata(indexed.metadataUri, (input, init) => fetch(input, { ...init, next: { revalidate: 3_600 } })))
    : null
  return { indexed, details }
})
