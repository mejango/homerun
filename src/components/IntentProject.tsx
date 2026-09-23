'use client'

import { useQuery } from '@tanstack/react-query'
import { useRouter } from 'next/navigation'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Brand } from '@/components/Brand'
import { WalletButton } from '@/components/WalletButton'
import { jbCenterClient } from '@/lib/jbcenter-client'
import { multisigReview } from '@/lib/create-multisig'
import { displayChainName } from '@/lib/chainDisplay'
import { decodeFundIntent } from '@/lib/fund-intent'
import { fetchFundProjectMetadata, type FundProjectMetadata } from '@/lib/fund-project-metadata'
import { DeployChains } from '@/components/DeployChains'
import { DemoProjectPage, type CreatedProject } from '@/components/ProjectPage'
import type { CreateValues } from '@/components/CreateFlow'
import { CREATE_DEFAULTS, modelCreatedProject } from '../../web/create-model.mjs'
import { networkSelectionForChainIds } from '../../web/create-networks.mjs'

const STATUS = 'Status: Deploys on first use'
const UNREADABLE = 'The project details could not be loaded. The terms below are read from the signed project creation.'

type Terms = ReturnType<typeof decodeFundIntent>

const shell = (children: ReactNode) => <>
  <a className="skip-link" href="#main">Skip to content</a>
  <header className="site-header"><Brand /><WalletButton /></header>
  <main id="main" className="mx-auto max-w-[1220px] px-5 py-10 sm:py-14" tabIndex={-1}>{children}</main>
</>

/**
 * The page a published project models: its own signed terms, the setup it
 * pinned, and the pictures that publication pinned with it. No chain is read.
 */
function modelIntent(id: string, terms: Terms, details?: FundProjectMetadata): CreatedProject | null {
  const selection = networkSelectionForChainIds([...terms.chainIds]) as
    { networks: string[]; networkEnvironment: 'production' | 'testnet' } | null
  if (!selection) return null
  const published = details?.setup
  const ownerSafe = terms.safes.find(safe => safe.role === 'owner')
  const operatorSafe = terms.safes.find(safe => safe.role === 'operator')
  const values: CreateValues = {
    ...(published ?? CREATE_DEFAULTS as unknown as CreateValues),
    name: (details?.name ?? published?.name ?? 'FUND project').slice(0, 60),
    description: details?.description ?? published?.description ?? '',
    location: details?.location ?? published?.location ?? '',
    fundTokenName: terms.tokenName, fundTicker: terms.ticker,
    ownerName: details?.owner?.name ?? '', ownerIntroduction: details?.owner?.introduction ?? '',
    operatorName: details?.operator?.name ?? '', operatorIntroduction: details?.operator?.introduction ?? '',
    // The signed calls, not the pinned setup, say who owns this project.
    ownerMode: ownerSafe ? 'create' : 'existing',
    ownerSigners: ownerSafe ? [...ownerSafe.owners] : [],
    ownerThreshold: ownerSafe?.threshold ?? 1,
    ownerWallet: ownerSafe ? '' : terms.owner,
    ownerIsOperator: !operatorSafe,
    operatorMode: operatorSafe ? 'create' : 'existing',
    operatorSigners: operatorSafe ? [...operatorSafe.owners] : [],
    operatorThreshold: operatorSafe?.threshold ?? 1,
    operatorWallet: operatorSafe ? '' : terms.owner,
    ...selection,
  }
  // A setup carries its own picture bytes and never a remote reference, so the
  // pins this publication made are given to the page beside the model.
  try { return modelCreatedProject({ ...values, photo: '', ownerPhoto: '', operatorPhoto: '' }, id) as CreatedProject }
  catch { return null }
}

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

  let terms: Terms | null = null
  let undecodable = ''
  if (intent.data) {
    try { terms = decodeFundIntent(intent.data) } catch (cause) { undecodable = cause instanceof Error ? cause.message : '' }
  }

  const deployment = terms ? intent.data?.deployments.find(item => item.chainId === terms.chainIds.find(chainId =>
    intent.data?.deployments.some(row => row.chainId === chainId))) : undefined
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
  const name = details.data?.name ?? intent.data?.name ?? undefined
  const model = useMemo(
    () => terms ? modelIntent(intentId, { ...terms, tokenName: terms.tokenName }, details.data ?? (name ? { name } as FundProjectMetadata : undefined)) : null,
    // The model follows the signed terms and the details this page could read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [intentId, intent.data, details.data, name],
  )

  // The page models the published setup, so it waits for that setup to resolve
  // rather than modeling defaults and rebuilding itself underneath the reader.
  if (intent.isPending || details.isLoading) return shell(<p role="status">Reading this project from Juicebox Center…</p>)
  if (intent.isError) return shell(<div role="alert" className="grid justify-items-start gap-4">
    <p>This project could not be read from Juicebox Center.</p>
    <button type="button" className="btn-secondary" onClick={() => void intent.refetch()}>Try again</button>
  </div>)
  if (!terms) return shell(<p role="alert">{undecodable || 'This project was not created by Homerun.'}</p>)
  if (!model) return shell(<p role="alert">This project’s terms could not be read.</p>)

  const safes = terms.safes.length ? multisigReview(terms.safes) : ''
  const opens = terms.mustStartAtOrAfter * 1000 > Date.now()
    ? new Date(terms.mustStartAtOrAfter * 1000).toLocaleString()
    : 'as soon as it is created'
  return <DemoProjectPage project={model} planned={{
    status: 'Deploys on first use',
    payLabel: 'Deploy first',
    pictures: {
      photo: details.data?.coverUrl ?? undefined,
      ownerPhoto: details.data?.owner?.photoUrl ?? undefined,
      operatorPhoto: details.data?.operator?.photoUrl ?? undefined,
    },
    panel: <section className="planned-bar" aria-label="Published project">
      <p role="status">{STATUS}</p>
      {details.isError && <p>{UNREADABLE}</p>}
      <p className="planned-bar-terms">FUND token: {terms.tokenName} ({terms.ticker})</p>
      <p className="planned-bar-terms">Contributions open: {opens}</p>
      {safes && <>
        <p className="planned-bar-terms">{safes}</p>
        <p className="planned-bar-terms">Juicebox Center’s sponsor creates these Safes on {terms.chainIds.map(displayChainName).join(', ')} along with the project. Each address is fixed by its owners, its approval policy and its salt, so the project is theirs whether the Safe exists yet or not.</p>
      </>}
      {intent.data && <DeployChains intent={intent.data} heading="Deploy" chainIds={terms.chainIds}
        onDeployed={() => { void intent.refetch() }} onRunningChange={setRunning} />}
    </section>,
  }} />
}
