import { unstable_cache } from 'next/cache'
import { cache } from 'react'
import { getProject, type BsProject } from '@/lib/bendystraw'
import { fetchFundProjectMetadata, type FundProjectMetadata } from '@/lib/fund-project-metadata'
import { readIncomeFundBinding } from '@/lib/income-fund-binding'
import { jbCenterPublicClient } from '@/lib/jbcenter-rpc'

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

/**
 * An INCOME's FUND is fixed at launch, so one history search serves every later request.
 * Cached as a string (the cache stores JSON); null for a revnet with no Homerun FUND.
 */
const cachedIncomeFund = unstable_cache(
  async (chainId: number, incomeProjectId: string) => {
    const fund = await readIncomeFundBinding(jbCenterPublicClient(chainId), { chainId, incomeProjectId: BigInt(incomeProjectId) })
    return fund === null ? null : fund.toString()
  },
  ['income-fund-binding'],
  { revalidate: false },
)

/**
 * Server only. For an indexed revnet: the FUND it forwards to, null when it has no Homerun FUND,
 * or undefined when that is not known in time (the browser resolves it then, as before).
 */
export async function loadIncomeFund(chainId: number, projectId: string, seed: ProjectSeed): Promise<string | null | undefined> {
  if (!seed.indexed?.isRevnet) return undefined
  const timeout = new Promise<undefined>(resolve => setTimeout(() => resolve(undefined), SEED_WAIT_MS))
  return Promise.race([cachedIncomeFund(chainId, projectId), timeout]).catch(() => undefined)
}

