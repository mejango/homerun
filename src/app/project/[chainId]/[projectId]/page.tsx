import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import type { JBChainId } from '@bananapus/nana-sdk-core'
import { FundProject } from '@/components/FundProject'
import { displayChainName } from '@/lib/chainDisplay'
import { FUND_CHAIN_IDS } from '@/lib/fund-contracts'

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

export async function generateMetadata({ params }: Pick<ProjectRouteProps, 'params'>): Promise<Metadata> {
  const route = await params
  const { chainId, projectId } = projectRoute(route.chainId, route.projectId)
  return {
    title: `FUND ${projectId} on ${displayChainName(chainId)}`,
    description: 'Fund an asset and manage your FUND holdings through verified Juicebox contracts.',
    alternates: { canonical: `https://homerun.money/project/${chainId}/${projectId}` },
  }
}

export default async function ProjectPage({ params, searchParams }: ProjectRouteProps) {
  const route = await params
  const query = await searchParams
  const intent = typeof query.intent === 'string' && INTENT_ID.test(query.intent) ? query.intent : undefined
  return <FundProject key={`${route.chainId}:${route.projectId}`} {...projectRoute(route.chainId, route.projectId)} intentId={intent} />
}
