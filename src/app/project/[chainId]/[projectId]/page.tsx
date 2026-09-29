import { permanentRedirect } from 'next/navigation'
import { projectFromIds } from '@/lib/project-route'
import { projectPath } from '@/lib/urn'

const INTENT_ID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i

type ProjectRouteProps = {
  params: Promise<{ chainId: string; projectId: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

/** Project pages live at `/<chain>:<id>`; older links forward there. */
export default async function LegacyProjectPage({ params, searchParams }: ProjectRouteProps) {
  const route = projectFromIds((await params).chainId, (await params).projectId)
  const query = await searchParams
  const intent = typeof query.intent === 'string' && INTENT_ID.test(query.intent) ? `?intent=${query.intent}` : ''
  permanentRedirect(`${projectPath(route.chainId, route.projectId)}${intent}`)
}
