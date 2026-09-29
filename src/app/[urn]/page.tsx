import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import type { JBChainId } from '@bananapus/nana-sdk-core'
import { FundProject } from '@/components/FundProject'
import { displayChainId, displayChainName } from '@/lib/chainDisplay'
import { FUND_CHAIN_IDS } from '@/lib/fund-contracts'
import { projectPath } from '@/lib/urn'

const INTENT_ID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i

type ProjectRouteProps = {
  params: Promise<{ urn: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

/** `<chainSlug>:<projectId>`, e.g. `op:11`. Anything else is not a project address. */
function projectRoute(urn: string) {
  let decoded: string
  try { decoded = decodeURIComponent(urn) } catch { notFound() }
  const match = /^([a-z]+):([1-9]\d*)$/.exec(decoded)
  if (!match || match[2].length > 78) notFound()
  const chainId = displayChainId(match[1])
  if (chainId === null || !(FUND_CHAIN_IDS as readonly number[]).includes(chainId) || BigInt(match[2]) >= 1n << 256n) notFound()
  return { chainId: chainId as JBChainId, projectId: match[2] }
}

export async function generateMetadata({ params }: Pick<ProjectRouteProps, 'params'>): Promise<Metadata> {
  const { chainId, projectId } = projectRoute((await params).urn)
  return {
    title: `FUND ${projectId} on ${displayChainName(chainId)}`,
    description: 'Fund an asset and manage your FUND holdings through verified Juicebox contracts.',
    alternates: { canonical: `https://homerun.money${projectPath(chainId, projectId)}` },
  }
}

export default async function ProjectPage({ params, searchParams }: ProjectRouteProps) {
  const route = projectRoute((await params).urn)
  const query = await searchParams
  const intent = typeof query.intent === 'string' && INTENT_ID.test(query.intent) ? query.intent : undefined
  return <FundProject key={`${route.chainId}:${route.projectId}`} {...route} intentId={intent} />
}
