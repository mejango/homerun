import { notFound, permanentRedirect } from 'next/navigation'
import type { JBChainId } from '@bananapus/nana-sdk-core'
import { FUND_CHAIN_IDS } from '@/lib/fund-contracts'
import { projectPath } from '@/lib/urn'

const INTENT_ID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i

type ProjectRouteProps = {
  params: Promise<{ chainId: string; projectId: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

function projectRoute(chainId: string, projectId: string) {
  if (!/^[1-9]\d*$/.test(chainId) || !/^[1-9]\d*$/.test(projectId) || projectId.length > 78) notFound()
  const chain = Number(chainId)
  if (!(FUND_CHAIN_IDS as readonly number[]).includes(chain) || BigInt(projectId) >= 1n << 256n) notFound()
  return { chainId: chain as JBChainId, projectId }
}

/** Project pages live at `/<chain>:<id>`; older links forward there. */
export default async function LegacyProjectPage({ params, searchParams }: ProjectRouteProps) {
  const route = projectRoute((await params).chainId, (await params).projectId)
  const query = await searchParams
  const intent = typeof query.intent === 'string' && INTENT_ID.test(query.intent) ? `?intent=${query.intent}` : ''
  permanentRedirect(`${projectPath(route.chainId, route.projectId)}${intent}`)
}
