'use client'

import { type JBChainId } from '@bananapus/nana-sdk-core'
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { formatUnits, isAddress, isAddressEqual, type PublicClient } from 'viem'
import Image from 'next/image'
import { usePublicClient } from 'wagmi'
import { DeployRemainingChains } from '@/components/DeployRemainingChains'
import { IncomeLaunch } from '@/components/IncomeLaunch'
import { FundBridgeActions } from '@/components/FundBridgeActions'
import { ProjectActivity } from '@/components/ProjectActivity'
import { DisplayTokenAmount } from '@/components/DisplayTokenAmount'
import { HomerunProjectLayout, OwnersTabs } from '@/components/HomerunProjectLayout'
import { ProjectParticipants } from '@/components/ProjectParticipants'
import { ProjectPayerAddresses } from '@/components/ProjectPayerAddresses'
import { ProjectShop } from '@/components/ProjectShop'
import { IncomeProjectRuntime, type IncomeProjectSlots } from '@/components/IncomeProject'
import { FundPaymentNetworks } from '@/components/FundPaymentNetworks'
import { CurrentOperatorProfile, CurrentOwnerProfile } from '@/components/CurrentOperatorProfile'
import { ProjectMetadataEditor } from '@/components/ProjectMetadataEditor'
import { ProjectOwnershipEditor } from '@/components/ProjectOwnershipEditor'
import { ProjectPermissionsEditor } from '@/components/ProjectPermissionsEditor'
import { ProjectSplitsEditor } from '@/components/ProjectSplitsEditor'
import { FundTokenTermsSection } from '@/components/FundTokenTerms'
import { readIncomeLaunchBinding } from '@/lib/income-launch'
import { money } from '@/lib/money'
import { useWallet } from '@/hooks/useWallet'
import { displayChainName } from '@/lib/chainDisplay'
import { readFundProjectState, type FundProjectState } from '@/lib/fund-state'
import { fetchFundProjectMetadata, type FundProjectMetadata } from '@/lib/fund-project-metadata'
import { SiteIntegration } from './SiteIntegration'
import { getProject } from '@/lib/bendystraw'
import { PERSIST } from '@/lib/query-persist'
import { DemoStageHistory, PhaseCopy, ProjectOverviewView, ProjectPageShell, ProjectPhoto, ProjectRaiseStats } from '@/components/ProjectPage'
import { liveFundPhase } from '@/lib/fund-phase'
import { FundingProgress } from '@/components/FundingProgress'
import { Revalidating } from '@/components/ui/Revalidating'
import { Skeleton, SkeletonLines } from '@/components/ui/Skeleton'
import { ActionSection, CashOutPanel, HolderActions, OperatorActions, PaymentPanel } from '@/components/live-transactions'

/** Every displayed balance and every permission is resolved from this chain. */

/** The project-level part of a verified read: what anyone sees, with every wallet-scoped field reset. */
function projectSnapshot(state: FundProjectState): FundProjectState {
  return {
    ...state,
    account: null, creditBalance: 0n, erc20Balance: 0n, totalBalance: 0n,
    permissions: Object.fromEntries(Object.keys(state.permissions).map(key => [key, false])) as FundProjectState['permissions'],
    allowlist: state.allowlist && { ...state.allowlist, accountAllowed: null },
  }
}

/** Homerun's create form sets a cover photo, not a logo: the cover stands in, as the preview shows it. */
function projectLogo(details: { logoUrl: string | null; coverUrl: string | null } | null | undefined, alt: string) {
  const src = details?.logoUrl ?? details?.coverUrl
  return src ? <Image unoptimized src={src} width={112} height={112} alt={alt} /> : null
}
export function FundProject({ chainId, projectId, intentId }: { chainId: JBChainId; projectId: string; intentId?: string }) {
  const id = BigInt(projectId)
  const client = usePublicClient({ chainId }) as PublicClient | undefined
  const { address } = useWallet()
  const [lastState, setLastState] = useState<FundProjectState | null>(null)
  const confirmed = useQuery<bigint>({ queryKey: ['project-admin-confirmed-block', chainId, projectId], queryFn: async () => 0n, enabled: false, initialData: 0n })
  const query = useQuery({
    queryKey: ['fund-project', chainId, projectId, address ?? null],
    enabled: !!client,
    queryFn: () => readFundProjectState(client!, { chainId, projectId: id, account: address }),
    staleTime: 10_000,
    refetchInterval: 20_000,
    retry: 1,
    placeholderData: keepPreviousData,
  })
  // A return visit shows this project's last verified figures while the fresh read runs.
  // Only the project-level snapshot is persisted: wallet balances and permissions never
  // reach disk, as in Juicebox Money, and a snapshot never enables a write.
  const cache = useQueryClient()
  const snapshotKey = useMemo(() => ['fund-display', chainId, projectId] as const, [chainId, projectId])
  const snapshot = useQuery<FundProjectState | null>({ queryKey: snapshotKey, queryFn: () => null, enabled: false, staleTime: Infinity, meta: PERSIST })
  useEffect(() => { if (!query.data && snapshot.data) setLastState(current => current ?? snapshot.data!) }, [snapshot.data, query.data])
  useEffect(() => { if (query.data) { setLastState(query.data); cache.setQueryData(snapshotKey, projectSnapshot(query.data)) } }, [cache, snapshotKey, query.data])
  // Keep receipt tracking mounted through a failed refresh or wallet change.
  // Retained reads are display-only until the active account is freshly read.
  const displayState = query.data ?? lastState
  const accountMatches = query.data?.account
    ? !!address && isAddressEqual(query.data.account, address)
    : !address
  const readsUnavailable = query.isError || query.isPlaceholderData || !query.data || query.data.blockNumber < (confirmed.data ?? 0n)
  const writesUnavailable = readsUnavailable || !accountMatches
  // The index answers in about a second, the verified contract read in several:
  // its row puts the project's name and pictures on screen first. Verified
  // state replaces the URI as soon as it lands; the index never gates a write.
  const indexed = useQuery({
    queryKey: ['indexed-project', chainId, Number(projectId)],
    enabled: Number.isSafeInteger(Number(projectId)),
    queryFn: () => getProject(chainId, Number(projectId)),
    staleTime: 30_000,
    retry: 1,
    meta: PERSIST,
  })
  const metadataUri = displayState?.projectUri || (indexed.data?.version === 6 && indexed.data.chainId === chainId && String(indexed.data.projectId) === projectId ? indexed.data.metadataUri : null)
  const details = useQuery({
    queryKey: ['fund-project-metadata', metadataUri],
    enabled: !!metadataUri,
    queryFn: () => fetchFundProjectMetadata(metadataUri!),
    staleTime: 300_000,
    meta: PERSIST,
    retry: 1,
  })
  const [lastIncomeId, setLastIncomeId] = useState<bigint | undefined>()
  const incomeBinding = useQuery({ queryKey: ['income-binding', chainId, projectId], enabled: !!client, queryFn: () => readIncomeLaunchBinding(client!, chainId, id), staleTime: 10_000, refetchInterval: 15_000, retry: false })
  useEffect(() => { if (incomeBinding.data) setLastIncomeId(incomeBinding.data) }, [incomeBinding.data])
  const incomeId = incomeBinding.data ?? lastIncomeId
  const notice = <>
    {details.isError && !details.data && <p className="text-sm text-[var(--muted)]">Project details could not be loaded.</p>}
    {query.isError && <p role="alert" className="text-sm">Couldn’t confirm this project against the chain. <button type="button" className="quiet-button" onClick={() => void query.refetch()}>Try again</button></p>}
  </>
  return <IncomeProjectRuntime chainId={chainId} projectId={incomeId} fundProjectId={id} bindingUnavailable={incomeBinding.isPending || incomeBinding.isError || !!lastIncomeId && !incomeBinding.data}>{income => <ProjectPageShell>
      <ProjectActions key={`${chainId}:${projectId}`} chainId={chainId} projectId={id} intentId={intentId} indexedOwner={indexed.data?.owner ?? undefined} state={displayState ?? undefined} client={client} details={details.data} notice={<>{notice}{income.notice}</>} income={income} refreshing={query.isFetching} unconfirmed={!query.data || query.isPlaceholderData} readsUnavailable={readsUnavailable} writesUnavailable={writesUnavailable} refresh={() => void query.refetch()} />
    </ProjectPageShell>}</IncomeProjectRuntime>
}

/** The published setup is the page's first source; a setup that fails its own validation is read through the plan. */
function publishedPlan(details: FundProjectMetadata) {
  const { setup, plan } = details
  if (!setup && !plan) return null
  const pick = <T,>(fromSetup: T | undefined, fromPlan: T | null | undefined): T | null =>
    fromSetup === undefined || fromSetup === '' ? fromPlan ?? null : fromSetup
  return {
    ownerWallet: plan?.ownerWallet ?? null,
    operatorWallet: plan?.operatorWallet ?? null,
    purchaseBudget: pick(setup?.purchaseBudget, plan?.purchaseBudget),
    opsReserve: pick(setup?.opsReserve, plan?.opsReserve),
    monthlyRent: pick(setup?.monthlyRent, plan?.monthlyRent),
    monthlyCosts: pick(setup?.monthlyCosts, plan?.monthlyCosts),
    rentGrowthPercent: pick(setup?.rentGrowthPercent, plan?.rentGrowthPercent),
    costGrowthPercent: pick(setup?.costGrowthPercent, plan?.costGrowthPercent),
    revenueDescription: pick(setup?.revenueDescription, plan?.revenueDescription),
    minimumRevenue: pick(setup?.minimumRevenue, plan?.minimumRevenue),
    minimumRevenueConsequences: pick(setup?.minimumRevenueConsequences, plan?.minimumRevenueConsequences),
    operatorFundPercent: pick(setup?.operatorFundPercent, plan?.operatorFundPercent),
    operatorSplitPercent: pick(setup?.operatorSplitPercent, plan?.operatorSplitPercent),
    fundHolderSplitPercent: pick(setup?.stickySplitPercent, plan?.fundHolderSplitPercent),
    tokenName: pick(setup?.fundTokenName, details.tokens?.name),
    tokenSymbol: pick(setup?.fundTicker, details.tokens?.symbol),
  }
}

function PlannedIncome({ plan }: { plan: NonNullable<ReturnType<typeof publishedPlan>> }) {
  const amount = (value: number | null) => value === null ? 'Not specified' : money(value)
  const rate = (value: number | null) => value === null ? 'Not specified' : `${value}%`
  const rows: [string, string][] = [
    ['Asset price', amount(plan.purchaseBudget)],
    ['Bootstrap operating budget', amount(plan.opsReserve)],
    ['Monthly revenue', amount(plan.monthlyRent)],
    ['Monthly expenses', amount(plan.monthlyCosts)],
    ['Revenue growth per year', rate(plan.rentGrowthPercent)],
    ['Expense growth per year', rate(plan.costGrowthPercent)],
    ['Minimum monthly revenue', plan.minimumRevenue === 0 ? 'No minimum set' : amount(plan.minimumRevenue)],
  ]
  return <section className="demo-section demo-live-plan" aria-label="The project plan">
    <h2>The project plan</h2>
    <p>Published estimates. They do not set contract permissions or confirm a purchase.</p>
    <dl className="demo-live-rows">{rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
    {plan.revenueDescription && <><h3>Revenue plan</h3><p className="whitespace-pre-line">{plan.revenueDescription}</p></>}
    {plan.minimumRevenueConsequences && <><h3>If revenue falls below the minimum</h3><p className="whitespace-pre-line">{plan.minimumRevenueConsequences}</p></>}
  </section>
}

function ProjectActions({ chainId, projectId, intentId, indexedOwner, state, client, details, notice, income, refreshing, unconfirmed, readsUnavailable, writesUnavailable, refresh }: {
  chainId: JBChainId; projectId: bigint; intentId?: string; indexedOwner?: string; state?: FundProjectState; client?: PublicClient; details?: FundProjectMetadata; notice: ReactNode; income: IncomeProjectSlots
  refreshing: boolean; unconfirmed: boolean; readsUnavailable: boolean; writesUnavailable: boolean; refresh: () => void
}) {
  const alsoDeploy = <DeployRemainingChains chainId={chainId} projectId={projectId.toString()} owner={state?.owner ?? (indexedOwner && isAddress(indexedOwner) ? indexedOwner : undefined)} intentId={intentId} />
  const { address } = useWallet()
  const [contextIndex, setContextIndex] = useState(0)
  const [paymentToken, setPaymentToken] = useState<'fund' | 'income'>('fund')
  const [accountAction, setAccountAction] = useState<'cashout' | 'tokens' | null>(null)
  const paymentChoice = useRef(false)
  useEffect(() => { if (income.projectId && !paymentChoice.current) setPaymentToken('income') }, [income.projectId])
  if (!state || !client) {
    // First visit: shapes sized like what they stand for, never a status sentence.
    const pending = <div role="status"><span className="sr-only">Loading project</span><SkeletonLines lines={3} className="max-w-md" /></div>
    return <HomerunProjectLayout title={details?.name ?? <Skeleton as="span" className="inline-block h-[0.9em] w-72 max-w-full align-middle" />}
      location={details?.location}
      logo={projectLogo(details, 'Project logo')}
      metadata={[<span key="status" id="project-status" className="project-status" role="status" aria-busy="true"><span className="sr-only">Loading</span><Skeleton as="span" className="inline-block h-3 w-56" /></span>]}
      notice={<>{alsoDeploy}{notice}</>}
      payment={<div className="pay-panel" aria-busy="true"><Skeleton className="h-4 w-32" /><Skeleton className="mt-5 h-12 w-full rounded" /></div>}
      activity={<ProjectActivity chainId={chainId} projectId={projectId} />}
      overview={<ProjectOverviewView
        about={<p className="whitespace-pre-line">{details?.description ?? ''}</p>}
        photo={details?.coverUrl ? <ProjectPhoto name={details.name ?? 'Project'} photo={details.coverUrl} /> : undefined}
        phase={null}
        progress={<div className="project-raise-stats" aria-busy="true"><div className="flex gap-7"><Skeleton className="h-10 w-32" /><Skeleton className="h-10 w-32" /></div><Skeleton className="mt-5 h-2 w-full rounded-full" /></div>}
        profiles={details ? <><CurrentOwnerProfile chainId={chainId} owner={undefined} details={details} /><CurrentOperatorProfile chainId={chainId} incomeProjectId={income.projectId} fundDetails={details} bindingUnavailable={income.bindingUnavailable} /></> : <SkeletonLines lines={4} className="max-w-md" />}
      />}
      stages={pending}
      owners={<OwnersTabs accountsYou={pending} accountsAll={pending} settlement={pending} splits={pending} loans={pending} control={pending} permissions={pending} />}
      shop={pending} extras={pending} operators={pending}
    />
  }
  const context = state.accountingContexts[contextIndex] ?? state.accountingContexts[0]
  const totalBalance = state.creditBalance + state.erc20Balance
  const isOperator = !!address && Object.values(state.permissions).some(Boolean)
  const supported = state.supportedController && state.supportedTerminals && state.knownOwnerWrapper
  const name = details?.name ?? undefined, plan = details && publishedPlan(details)
  const blocked = writesUnavailable || !supported
  const gate = (children: ReactNode) => <fieldset disabled={blocked} className="grid min-w-0 gap-7 border-0 p-0" aria-label="Project transactions">{children}</fieldset>
  const publishedToken = plan ? <FundTokenTermsSection terms={{
    tokenName: plan.tokenName, tokenSymbol: plan.tokenSymbol, ownerFundPercent: plan.operatorFundPercent,
    operatorSplitPercent: plan.operatorSplitPercent, fundHolderSplitPercent: plan.fundHolderSplitPercent,
  }} /> : null
  const currency = context && <label className="grid gap-2 text-sm">FUND treasury currency<select value={contextIndex} onChange={event => setContextIndex(Number(event.target.value))} className="min-h-11 rounded border border-[#bfc9b5] bg-white px-3 pr-9">{state.accountingContexts.map((item, index) => <option key={`${item.terminal}:${item.token}`} value={index}>{item.symbol}</option>)}</select></label>
  const verified = <section aria-label="Verified project state" className="demo-section">
    <div className="flex flex-wrap items-baseline justify-between gap-3"><h2>Onchain</h2><button className="quiet-button" type="button" disabled={refreshing} onClick={refresh}>{refreshing ? 'Refreshing…' : 'Refresh'}</button></div>
    <Revalidating as="div" pending={unconfirmed}><dl className="demo-live-rows">
      <div><dt>Contributions</dt><dd>{state.metadata.pausePay ? 'Paused' : 'Open'}</dd></div>
      <div><dt>Cash-out tax</dt><dd>{state.metadata.cashOutTaxRate === 10_000 ? 'Cash-outs disabled' : `${state.metadata.cashOutTaxRate / 100}%`}</dd></div>
      <div><dt>FUND supply</dt><dd><DisplayTokenAmount value={state.totalSupply} /></dd></div>
      {context && <div><dt>FUND treasury</dt><dd><DisplayTokenAmount value={context.balance} decimals={context.decimals} /> {context.symbol}</dd></div>}
    </dl></Revalidating>
    <p>Verified at block {state.blockNumber.toString()}.</p>
  </section>
  const live = liveFundPhase({ pausePay: state.metadata.pausePay, cashOutTaxRate: state.metadata.cashOutTaxRate, allowOwnerMinting: state.metadata.allowOwnerMinting, hasIncome: !!income.projectId, supported: !!supported })
  // The goal is published, never enforced, and only comparable to a dollar treasury.
  const goal = plan && plan.purchaseBudget !== null && plan.opsReserve !== null ? plan.purchaseBudget + plan.opsReserve : null
  const dollars = !!context && /^USDC?$/i.test(context.symbol)
  const raised = context ? Number(formatUnits(context.balance, context.decimals)) : 0
  const compact = (value: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: Math.abs(value) < 1_000 ? 2 : 1 }).format(value)
  const raisedMetric = context && (dollars
    ? <span key="raised" data-header-metric="raised" title={`Raised: ${money(raised)}`}>Raised: <Revalidating pending={unconfirmed}>{compact(raised)}</Revalidating></span>
    : <span key="raised" data-header-metric="raised">FUND treasury: <Revalidating pending={unconfirmed}><DisplayTokenAmount value={context.balance} decimals={context.decimals} /> {context.symbol}</Revalidating></span>)
  const progress = context && <Revalidating as="div" pending={unconfirmed}>{dollars && goal
    ? <ProjectRaiseStats raised={raised} goal={goal} historical={live.phase !== 'raising'} goalLabel="Published goal" />
    : <div className="project-raise-stats"><dl><div><dt>FUND treasury</dt><dd><DisplayTokenAmount value={context.balance} decimals={context.decimals} /> {context.symbol}</dd></div><div><dt>FUND supply</dt><dd><DisplayTokenAmount value={state.totalSupply} /></dd></div></dl></div>}</Revalidating>
  const emptyIncome = <ActionSection title="INCOME"><p>INCOME has not been verified for this project yet. Its launch and recovery controls are under Operators.</p></ActionSection>
  return <HomerunProjectLayout
    title={name ?? 'FUND project'}
    location={details?.location}
    logo={projectLogo(details, name ? `${name} logo` : 'Project logo')}
    metadata={[
      <span key="status" id="project-status" className="project-status" data-project-phase={live.phase ?? undefined} role="status">Status: <Revalidating pending={unconfirmed}>{live.status}</Revalidating></span>,
      supported && raisedMetric,
      supported && !dollars && <span key="supply">FUND supply: <Revalidating pending={unconfirmed}><DisplayTokenAmount value={state.totalSupply} /></Revalidating></span>,
      supported && dollars && goal !== null && <span key="goal" data-header-metric="goal" title={`Published goal: ${money(goal)}`}>Goal: {compact(goal)}</span>,
      supported && dollars && goal && <span key="funded" data-header-metric="funded">Funded: <Revalidating pending={unconfirmed}>{Math.round((raised / goal) * 100)}%</Revalidating></span>,
      income.treasuryMetric,
    ].filter(Boolean)}
    headerProgress={supported && dollars && goal ? <FundingProgress raised={raised} goal={goal} historical={live.phase !== 'raising'} compact /> : undefined}
    notice={<>{alsoDeploy}{notice}{!supported && <p role="alert">This project uses contract settings outside Homerun’s verified FUND integration. Transactions are unavailable here. {state.issues.join(' ')}</p>}</>}
    payment={<>
      {income.projectId && <div className="mb-5 flex gap-3" role="group" aria-label="Payment token"><button type="button" className={paymentToken === 'fund' ? 'btn-primary' : 'btn-secondary'} aria-pressed={paymentToken === 'fund'} onClick={() => { paymentChoice.current = true; setPaymentToken('fund') }}>FUND</button><button type="button" className={paymentToken === 'income' ? 'btn-primary' : 'btn-secondary'} aria-pressed={paymentToken === 'income'} onClick={() => { paymentChoice.current = true; setPaymentToken('income') }}>INCOME</button></div>}
      <div hidden={paymentToken !== 'fund'} onFocusCapture={() => { paymentChoice.current = true }}>{gate(<>{context ? <FundPaymentNetworks state={state}>{(paymentState, paymentClient, selector, onBusyChange) => <PaymentPanel state={paymentState} client={paymentClient} contextIndex={paymentState.chainId === state.chainId ? contextIndex : 0} chainSelector={selector} onBusyChange={onBusyChange} />}</FundPaymentNetworks> : <p>No supported payment terminal was verified for this project.</p>}</>)}</div>
      <div hidden={paymentToken !== 'income'}>{income.projectId && income.payment}</div>
    </>}
    activity={<><div hidden={paymentToken !== 'fund'}><ProjectActivity chainId={state.chainId} projectId={state.projectId} /></div><div hidden={paymentToken !== 'income'}>{income.activity}</div></>}
    overview={<ProjectOverviewView
      about={<><p className="whitespace-pre-line">{details?.description ?? 'Fund the asset, manage its treasury, and use your FUND tokens.'}</p><div className="mt-5 grid gap-4"><ProjectMetadataEditor chainId={chainId} projectId={projectId} client={client} unavailable={writesUnavailable} label="Edit FUND details" />{income.projectId && <ProjectMetadataEditor chainId={chainId} projectId={income.projectId} client={client} unavailable={income.writesUnavailable} inheritedMetadataUri={state.projectUri} label="Edit INCOME details" />}</div></>}
      photo={details?.coverUrl ? <ProjectPhoto name={name ?? 'Project'} photo={details.coverUrl} /> : undefined}
      phase={live.phase}
      progress={progress}
      profiles={<><CurrentOwnerProfile chainId={chainId} owner={state.owner} details={details} unavailable={readsUnavailable || !state.knownOwnerWrapper} /><CurrentOperatorProfile chainId={chainId} incomeProjectId={income.projectId} fundDetails={income.details?.plan ? income.details : details} bindingUnavailable={income.bindingUnavailable} /></>}
      after={<>{verified}{income.overview}</>}
    />}
    stages={<div className="demo-stages">
      {live.phase && <DemoStageHistory p={null} phase={live.phase} />}
      {live.phase && <div className="phase-panel"><PhaseCopy phase={live.phase} /></div>}
      <section className="demo-section" aria-label="Rules">
        <h2>Rules</h2>
        <dl className="demo-live-rows">
          <div><dt>Status</dt><dd>{live.status}</dd></div>
          <div><dt>Current rules since</dt><dd>{new Date(Number(state.ruleset.start) * 1000).toLocaleString()}</dd></div>
          <div><dt>Next change</dt><dd>{state.upcoming && state.upcoming.ruleset.id !== state.ruleset.id ? new Date(Number(state.upcoming.ruleset.start) * 1000).toLocaleString() : 'None scheduled'}</dd></div>
        </dl>
        <p>Rules change only by an onchain transaction. They do not confirm an offchain purchase or sale.</p>
      </section>
      {plan && <PlannedIncome plan={plan} />}
      {income.stages}
    </div>}
    owners={<OwnersTabs
      accountsYou={<div className="demo-owner-sections">
        <section className="demo-section demo-account" aria-label="Your FUND">
          <h2>Your position</h2>
          {!address && <p>Connect a wallet to see your FUND and act on it.</p>}
          <dl className="demo-account-balances">
            <div>
              <dt>FUND</dt>
              <dd>{!address ? '—' : state.account && isAddressEqual(state.account, address) ? <Revalidating pending={unconfirmed}><DisplayTokenAmount value={totalBalance} /></Revalidating> : <Skeleton as="span" className="inline-block h-6 w-20 align-middle" />}</dd>
              {address && state.creditBalance > 0n && <dd className="text-xs"><DisplayTokenAmount value={state.creditBalance} /> as unclaimed credits</dd>}
              <dd className="project-action-guide"><div className="pag-actions" role="group" aria-label="FUND actions">
                {context && <button type="button" className="outline-button pag-control" aria-pressed={accountAction === 'cashout'} onClick={() => setAccountAction(accountAction === 'cashout' ? null : 'cashout')}>Cash out FUND</button>}
                <button type="button" className="outline-button pag-control" aria-pressed={accountAction === 'tokens'} onClick={() => setAccountAction(accountAction === 'tokens' ? null : 'tokens')}>Transfer or burn FUND</button>
              </div></dd>
            </div>
            <div>
              <dt>INCOME</dt>
              <dd>{income.projectId ? 'See below' : 'Not issued yet'}</dd>
            </div>
          </dl>
          {/* Hidden, never unmounted: each form tracks its own submitted transaction. */}
          <div hidden={accountAction !== 'cashout'} className="mt-6">{gate(context && <>{currency}<CashOutPanel state={state} client={client} contextIndex={contextIndex} /></>)}</div>
          <div hidden={accountAction !== 'tokens'} className="mt-6">{gate(<fieldset disabled={!address} className="min-w-0 border-0 p-0"><HolderActions state={state} client={client} /></fieldset>)}</div>
        </section>
        {income.projectId && income.accountsYou}
      </div>}
      accountsAll={<div className="demo-owner-sections"><ProjectParticipants chainId={state.chainId} projectId={state.projectId} tokenLabel="FUND" />{income.projectId && income.accountsAll}</div>}
      settlement={<div className="grid gap-7">{gate(<FundBridgeActions state={state} />)}{income.projectId && income.settlement}</div>}
      splits={<div className="grid gap-7">{publishedToken}<ProjectSplitsEditor chainId={chainId} projectId={projectId} phase="fund" client={client} unavailable={writesUnavailable} />{income.projectId ? income.splits : emptyIncome}</div>}
      loans={income.projectId ? income.loans : <ActionSection title="Loans"><p>Loans use INCOME as collateral. They become available after a verified INCOME launch under its contract terms.</p></ActionSection>}
      control={<div className="grid gap-7"><ProjectOwnershipEditor chainId={chainId} projectId={projectId} client={client} unavailable={writesUnavailable} />{income.projectId && income.control}</div>}
      permissions={<div className="grid gap-7"><ProjectPermissionsEditor chainId={chainId} projectId={projectId} client={client} unavailable={writesUnavailable} />{income.projectId && income.permissions}</div>}
    />}
    // The FUND shop keeps its tree position when INCOME appears, so it is never remounted.
    shop={<div className="demo-owner-sections"><section className="demo-section">{income.projectId && <h2>FUND shop</h2>}<ProjectShop chainId={state.chainId} projectId={state.projectId} tokenLabel="FUND" /></section>{income.projectId && <section className="demo-section"><h2>INCOME shop</h2>{income.shop}</section>}</div>}
    extras={<div className="grid gap-7"><ProjectPayerAddresses chainId={state.chainId} projectId={state.projectId} tokenLabel="FUND" />{income.extras}<ActionSection title="Contracts"><dl className="demo-live-rows"><div><dt>Network</dt><dd>{displayChainName(state.chainId)}</dd></div><div><dt>FUND project</dt><dd>#{state.projectId.toString()}</dd></div>{income.projectId && <div><dt>INCOME project</dt><dd>#{income.projectId.toString()}</dd></div>}<div><dt>Project owner</dt><dd>{state.owner}</dd></div><div><dt>Operator</dt><dd>{state.operator ?? 'Not verified'}</dd></div><div><dt>Controller</dt><dd>{state.controller}</dd></div>{state.tokenAddress && <div><dt>FUND ERC-20</dt><dd>{state.tokenAddress}</dd></div>}</dl></ActionSection><SiteIntegration configuration={{ mode: 'live-project', source: 'verified contract reads and published project metadata', chainId: state.chainId, fundProjectId: state.projectId.toString(), incomeProjectId: income.projectId?.toString() ?? null, project: { name: name ?? null, location: details?.location ?? null }, publishedPlan: plan ?? null }} /></div>}
    operators={<div className="grid gap-7">{income.projectId ? income.operators : null}{gate(<ActionSection title="Operator actions">{!isOperator && <p className="mb-5">Connect a wallet with verified project permissions to manage this project. Contract permissions are checked again before every transaction.</p>}<fieldset disabled={!isOperator} className="min-w-0 border-0 p-0"><OperatorActions state={state} client={client} contextIndex={contextIndex} /></fieldset></ActionSection>)}<IncomeLaunch state={state} client={client} name={name} plannedAllocation={plan && plan.operatorSplitPercent !== null && plan.fundHolderSplitPercent !== null ? { reservedPercent: plan.operatorSplitPercent + plan.fundHolderSplitPercent } : undefined} launchUnavailable={blocked} embedExistingProject={false} /></div>}
  />
}
