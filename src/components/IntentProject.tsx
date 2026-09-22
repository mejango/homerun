'use client'

import { useQuery } from '@tanstack/react-query'
import Image from 'next/image'
import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import { jbCenterClient } from '@/lib/jbcenter-client'
import { multisigReview } from '@/lib/create-multisig'
import { decodeFundIntent } from '@/lib/fund-intent'
import { fetchFundProjectMetadata } from '@/lib/fund-project-metadata'
import { displayChainName } from '@/lib/chainDisplay'
import { DeployChains } from '@/components/DeployChains'

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
  return <div className="grid gap-7">
    <section className="grid gap-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="grid min-w-0 gap-2">
          <h1 className="text-5xl sm:text-6xl">{name}</h1>
          {details.data?.location && <p className="text-sm">{details.data.location}</p>}
        </div>
        {details.data?.logoUrl && <Image unoptimized src={details.data.logoUrl} width={112} height={112} alt={`${name} logo`} />}
      </div>
      <ul className="m-0 flex list-none flex-wrap gap-4 p-0 text-sm">
        <li>Status: Deploys on first use</li>
        <li>Networks: {terms.chainIds.map(displayChainName).join(', ')}</li>
        <li>FUND token: {terms.tokenName} ({terms.ticker})</li>
        <li>Contributions open: {terms.mustStartAtOrAfter * 1000 > Date.now() ? new Date(terms.mustStartAtOrAfter * 1000).toLocaleString() : 'as soon as it is created'}</li>
      </ul>
      <p className="break-all text-sm">Owner: {terms.owner}</p>
    </section>

    {intent.data && <DeployChains intent={intent.data} heading="Deploy" chainIds={terms.chainIds}
      onDeployed={() => { void intent.refetch() }} onRunningChange={setRunning} />}

    {terms.safes.length > 0 && <section className="rounded-md border border-[#c4cdbb] bg-[#fffefa] p-5 sm:p-7">
      <h2 className="mb-5 text-3xl">Multisigs</h2>
      <p>Juicebox Center’s sponsor creates these Safes on {terms.chainIds.map(displayChainName).join(', ')} along with the project. Each address is fixed by its owners, its approval policy and its salt, so the project is theirs whether the Safe exists yet or not.</p>
      <p className="mt-5 whitespace-pre-line break-all text-sm">{multisigReview(terms.safes)}</p>
    </section>}

    <section className="rounded-md border border-[#c4cdbb] bg-[#fffefa] p-5 sm:p-7">
      <h2 className="mb-5 text-3xl">About</h2>
      {details.isError && <p className="mb-5 text-sm">The project details could not be loaded. The terms above are read from the signed project creation.</p>}
      <p className="whitespace-pre-line">{details.data?.description ?? 'Fund an asset with a FUND Juicebox created on first use.'}</p>
      {details.data?.coverUrl && <Image unoptimized src={details.data.coverUrl} width={1200} height={675} alt={`${name} cover`} className="mt-5 max-h-[480px] w-full rounded-md object-cover" />}
      {details.data?.owner && <div className="mt-7 grid gap-2">
        <h3 className="text-2xl">Owner</h3>
        {details.data.owner.photoUrl && <Image unoptimized src={details.data.owner.photoUrl} width={96} height={96} alt={details.data.owner.name ? `${details.data.owner.name} picture` : 'Owner picture'} />}
        {details.data.owner.name && <p>{details.data.owner.name}</p>}
        {details.data.owner.introduction && <p className="whitespace-pre-line text-sm">{details.data.owner.introduction}</p>}
      </div>}
    </section>
  </div>
}
