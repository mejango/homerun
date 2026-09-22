'use client'

import { useQuery } from '@tanstack/react-query'
import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import { jbCenterClient } from '@/lib/jbcenter-client'
import { multisigReview } from '@/lib/create-multisig'
import { decodeFundIntent } from '@/lib/fund-intent'
import { fetchFundProjectMetadata } from '@/lib/fund-project-metadata'
import { DeployChains } from '@/components/DeployChains'
import { IntentProjectView } from '@/components/IntentProjectView'

/** Everything shown here comes from the signed calls and the pinned metadata; no chain is read. */
export function IntentProject({ intentId }: { intentId: string }) {
  const router = useRouter()
  const [running, setRunning] = useState(false)
  const intent = useQuery({
    queryKey: ['intent', intentId],
    queryFn: () => jbCenterClient.getIntent(intentId),
    staleTime: 30_000,
    retry: 1,
  })

  let terms: ReturnType<typeof decodeFundIntent> | null = null
  let undecodable = ''
  if (intent.data) {
    try { terms = decodeFundIntent(intent.data) } catch (cause) { undecodable = cause instanceof Error ? cause.message : '' }
  }

  const deployment = terms ? intent.data?.deployments.find(item => item.chainId === terms.chainIds.find(chainId =>
    intent.data?.deployments.some(row => row.chainId === chainId))) ?? intent.data?.deployments[0] : undefined
  useEffect(() => {
    // A reader who arrives at a project that already exists opens it. A deploy
    // started here keeps its per-chain progress until that run resolves, so a
    // linked project never opens on half of itself.
    if (!deployment || running) return
    router.replace(`/project/${deployment.chainId}/${deployment.projectId}?intent=${intentId}`)
  }, [deployment, running, router, intentId])

  const details = useQuery({
    queryKey: ['intent-metadata', terms?.projectUri],
    enabled: !!terms?.projectUri,
    queryFn: () => fetchFundProjectMetadata(terms!.projectUri),
    staleTime: 300_000,
    retry: 1,
  })

  if (intent.isPending) return <p role="status">Reading this project from Juicebox Center…</p>
  if (intent.isError) return <div role="alert" className="grid justify-items-start gap-4">
    <p>This project could not be read from Juicebox Center.</p>
    <button type="button" className="btn-secondary" onClick={() => void intent.refetch()}>Try again</button>
  </div>
  if (!terms) return <p role="alert">{undecodable || 'This project was not created by Homerun.'}</p>

  const name = details.data?.name ?? intent.data?.name ?? 'FUND project'
  return <IntentProjectView
    display={{
      name, location: details.data?.location, logoUrl: details.data?.logoUrl, coverUrl: details.data?.coverUrl,
      description: details.data?.description, detailsUnavailable: details.isError,
      owner: terms.owner, ownerProfile: details.data?.owner ?? undefined,
      chainIds: terms.chainIds, tokenName: terms.tokenName, ticker: terms.ticker,
      mustStartAtOrAfter: terms.mustStartAtOrAfter, status: 'Deploys on first use',
      multisigs: terms.safes.length ? multisigReview(terms.safes) : undefined,
    }}
    actions={intent.data && <DeployChains intent={intent.data} heading="Deploy" chainIds={terms.chainIds}
      onDeployed={() => { void intent.refetch() }} onRunningChange={setRunning} />}
  />
}
