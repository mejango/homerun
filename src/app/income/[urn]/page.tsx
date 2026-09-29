import { permanentRedirect } from 'next/navigation'
import { projectFromUrn } from '@/lib/project-route'
import { projectPath } from '@/lib/urn'

/** A project has one address, its FUND's; `/<chain>:<id>` forwards an INCOME ID there. */
export default async function IncomeAddress({ params }: { params: Promise<{ urn: string }> }) {
  const { chainId, projectId } = projectFromUrn((await params).urn)
  permanentRedirect(projectPath(chainId, projectId))
}
