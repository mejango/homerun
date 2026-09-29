import type { Metadata } from 'next'
import { ProjectAddress } from '@/components/ProjectAddress'
import { displayChainName } from '@/lib/chainDisplay'
import { projectFromUrn } from '@/lib/project-route'
import { projectPath } from '@/lib/urn'
import { loadProjectSeed } from '@/lib/project-seed'

const INTENT_ID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i

type ProjectRouteProps = {
  params: Promise<{ urn: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

export async function generateMetadata({ params }: Pick<ProjectRouteProps, 'params'>): Promise<Metadata> {
  const { chainId, projectId } = projectFromUrn((await params).urn)
  const { indexed, details } = await loadProjectSeed(chainId, projectId)
  const name = details?.name ?? indexed?.name ?? null
  return {
    title: name ?? `Project ${projectId} on ${displayChainName(chainId)}`,
    description: details?.description?.slice(0, 200) || indexed?.projectTagline || 'Fund an asset and manage your FUND holdings through verified Juicebox contracts.',
    alternates: { canonical: `https://homerun.money${projectPath(chainId, projectId)}` },
  }
}

export default async function ProjectPage({ params, searchParams }: ProjectRouteProps) {
  const route = projectFromUrn((await params).urn)
  const query = await searchParams
  const intent = typeof query.intent === 'string' && INTENT_ID.test(query.intent) ? query.intent : undefined
  // The index row and published details render with the page; contract reads follow in the browser.
  const seed = await loadProjectSeed(route.chainId, route.projectId)
  return <ProjectAddress key={`${route.chainId}:${route.projectId}`} {...route} intentId={intent} seed={seed} />
}
