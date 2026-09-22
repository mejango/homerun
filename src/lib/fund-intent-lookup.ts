import type { Address } from 'viem'
import type { JBCenterClient, JBCenterIntent, JBCenterRequestOptions } from '@bananapus/nana-sdk-core/jbcenter'
import { decodeFundIntent } from './fund-intent'

const INTENT_ID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i
const SEARCH_LIMIT = 24
const CANDIDATES = 3

/** A project belongs to an intent only when that intent's own record deployed it. */
function deploysProject(intent: JBCenterIntent, project: { chainId: number; projectId: string }): boolean {
  if (!intent.deployments.some(row => row.chainId === project.chainId && row.projectId === project.projectId)) return false
  try { decodeFundIntent(intent); return true } catch { return false }
}

export async function findProjectIntent(
  client: Pick<JBCenterClient, 'getIntent' | 'searchIntents'>,
  project: { chainId: number; projectId: string },
  hints: readonly (string | null | undefined)[],
  owner?: Address,
  options?: JBCenterRequestOptions,
): Promise<JBCenterIntent | null> {
  const seen = new Set<string>()
  const read = async (id: string) => {
    if (seen.has(id)) return null
    seen.add(id)
    const intent = await client.getIntent(id, options).catch(() => null)
    return intent && deploysProject(intent, project) ? intent : null
  }
  for (const hint of hints) {
    if (!hint || !INTENT_ID.test(hint)) continue
    const found = await read(hint)
    if (found) return found
  }
  if (!owner) return null
  const page = await client.searchIntents({ owner, limit: SEARCH_LIMIT }, options).catch(() => null)
  const candidates = (page?.items ?? []).filter(item => item.chainIds.includes(project.chainId)).slice(0, CANDIDATES)
  for (const item of candidates) {
    const found = await read(item.intentId)
    if (found) return found
  }
  return null
}
