'use client'

import { useQuery } from '@tanstack/react-query'
import Image from 'next/image'
import { useRouter } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'
import {
  EnsureDeployedError, describeCenterRefusal, ensureDeployed, isFullyDeployed, isSponsorable,
  type EnsureDeployedStep,
} from '@bananapus/nana-sdk-core/jbcenter'
import { jbCenterClient } from '@/lib/jbcenter-client'
import { decodeFundIntent, watchDeployRefusal } from '@/lib/fund-intent'
import { fetchFundProjectMetadata } from '@/lib/fund-project-metadata'
import { displayChainName } from '@/lib/chainDisplay'

const STEP_LABELS: Record<EnsureDeployedStep['status'], string> = {
  queued: 'queued at Juicebox Center',
  sent: 'sent onchain',
  confirmed: 'created',
  failed: 'could not be created',
  'self-paid': 'recorded',
}

/** Neither a provider, a gateway nor Center's own request text reaches a reader. */
const DEPLOY_UNAVAILABLE = 'Center could not start this deploy right now. Try again shortly.'
const DEPLOY_FAILED = 'Juicebox Center could not deploy this project. Try again in a few minutes.'
const UNSPONSORED = 'This project’s networks are not sponsored. It has to be created with a transaction.'
/** Center keeps a failed chain as a failed chain: this page cannot send it again. */
const deployStopped = (chainId: number) =>
  `Juicebox Center could not create this project on ${displayChainName(chainId)}. It cannot be deployed from here; create it again.`

/** Everything shown here comes from the signed calls and the pinned metadata; no chain is read. */
export function IntentProject({ intentId }: { intentId: string }) {
  const router = useRouter()
  const [deploying, setDeploying] = useState(false)
  const [steps, setSteps] = useState<string[]>([])
  const [error, setError] = useState('')
  const [stopped, setStopped] = useState(false)
  const [startedHere, setStartedHere] = useState(false)
  const intent = useQuery({
    queryKey: ['intent', intentId],
    queryFn: () => jbCenterClient.getIntent(intentId),
    staleTime: 30_000,
    retry: 1,
  })
  const run = useRef<AbortController | null>(null)
  useEffect(() => () => run.current?.abort(), [])
  const deployment = intent.data?.deployments[0]
  const everyChainCreated = !!intent.data && isFullyDeployed(intent.data)
  useEffect(() => {
    if (!deployment) return
    // A reader who arrives at a project that already exists opens it. A deploy
    // started on this page keeps its per-chain progress until the last chain
    // is created, so a linked project never opens on half of itself.
    if (startedHere && !everyChainCreated) return
    run.current?.abort()
    router.replace(`/project/${deployment.chainId}/${deployment.projectId}`)
  }, [deployment, everyChainCreated, startedHere, router])

  let terms: ReturnType<typeof decodeFundIntent> | null = null
  let undecodable = ''
  if (intent.data) {
    try { terms = decodeFundIntent(intent.data) } catch (cause) { undecodable = cause instanceof Error ? cause.message : '' }
  }
  const details = useQuery({
    queryKey: ['intent-metadata', terms?.projectUri],
    enabled: !!terms?.projectUri,
    queryFn: () => fetchFundProjectMetadata(terms!.projectUri),
    staleTime: 300_000,
    retry: 1,
  })

  async function deploy() {
    if (!intent.data) return
    setDeploying(true); setStartedHere(true); setError(''); setSteps([])
    const watcher = watchDeployRefusal(jbCenterClient)
    const controller = new AbortController()
    run.current?.abort()
    run.current = controller
    try {
      await ensureDeployed({
        client: watcher.client,
        intent: intent.data,
        timeoutMs: 600_000,
        signal: controller.signal,
        // Read the intent back on every reported step, so the created project
        // opens as soon as Center records it rather than a poll interval later.
        onStep: step => {
          setSteps(current => [...current, `${displayChainName(step.chainId)}: ${STEP_LABELS[step.status]}`])
          void intent.refetch()
        },
      })
      await intent.refetch()
    } catch (cause) {
      // A run this page abandoned, by unmounting or by opening the created
      // project, is not a failure to report.
      if (controller.signal.aborted) return
      // Center recorded a failed chain. That row is the end of this project's
      // sponsored creation, so say so and stop offering Deploy.
      if (cause instanceof EnsureDeployedError && cause.chainId !== undefined) {
        setStopped(true); setError(deployStopped(cause.chainId)); return
      }
      const refused = describeCenterRefusal(watcher.refusal())
      setError(refused?.message ?? (cause instanceof EnsureDeployedError ? DEPLOY_FAILED : DEPLOY_UNAVAILABLE))
    } finally {
      if (run.current === controller) run.current = null
      setDeploying(false)
    }
  }

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

    {isSponsorable(terms.chainIds)
      ? <section className="rounded-md border border-[#c4cdbb] bg-[#eef1e7] p-5 sm:p-7">
        <h2 className="mb-5 text-3xl">Deploy this project</h2>
        <p>Juicebox Center sends the creation on {terms.chainIds.map(displayChainName).join(', ')} and pays its creation fee. Anyone can start it, and the terms above cannot change.</p>
        <button type="button" className="btn-primary mt-5" disabled={deploying || stopped} onClick={() => void deploy()}>{deploying ? 'Deploying…' : 'Deploy'}</button>
        {steps.length > 0 && <ul className="m-0 mt-5 grid list-none gap-2 p-0 text-sm" aria-label="Deployment progress">{steps.map((step, index) => <li key={`${step}:${index}`} role="status">{step}</li>)}</ul>}
        {error && <p role="alert" className="mt-5 text-sm">{error}</p>}
        {stopped && deployment && <p className="mt-3 text-sm"><a className="underline" href={`/project/${deployment.chainId}/${deployment.projectId}`}>Open the project created on {displayChainName(deployment.chainId)}</a></p>}
      </section>
      : <p className="rounded-md border border-[#c4cdbb] bg-[#eef1e7] p-5 sm:p-7">{UNSPONSORED}</p>}

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
