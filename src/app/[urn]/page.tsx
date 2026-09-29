import type { Metadata } from 'next'
import { ProjectAddress } from '@/components/ProjectAddress'
import { displayChainName } from '@/lib/chainDisplay'
import { projectFromUrn } from '@/lib/project-route'
import { projectPath } from '@/lib/urn'

const INTENT_ID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i

type ProjectRouteProps = {
  params: Promise<{ urn: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

export async function generateMetadata({ params }: Pick<ProjectRouteProps, 'params'>): Promise<Metadata> {
  const { chainId, projectId } = projectFromUrn((await params).urn)
  return {
    title: `Project ${projectId} on ${displayChainName(chainId)}`,
    description: 'Fund an asset and manage your FUND holdings through verified Juicebox contracts.',
    alternates: { canonical: `https://homerun.money${projectPath(chainId, projectId)}` },
  }
}

export default async function ProjectPage({ params, searchParams }: ProjectRouteProps) {
  const route = projectFromUrn((await params).urn)
  const query = await searchParams
  const intent = typeof query.intent === 'string' && INTENT_ID.test(query.intent) ? query.intent : undefined
  return <ProjectAddress key={`${route.chainId}:${route.projectId}`} {...route} intentId={intent} />
}
