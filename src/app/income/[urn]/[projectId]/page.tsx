import { permanentRedirect } from 'next/navigation'
import { projectFromIds } from '@/lib/project-route'
import { projectPath } from '@/lib/urn'

/** The older `/income/<chainId>/<projectId>` form; the first segment is a chain ID here. */
export default async function LegacyIncomeAddress({ params }: { params: Promise<{ urn: string; projectId: string }> }) {
  const route = await params
  const { chainId, projectId } = projectFromIds(route.urn, route.projectId)
  permanentRedirect(projectPath(chainId, projectId))
}
