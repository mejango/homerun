'use client'

import { type JBChainId } from '@bananapus/nana-sdk-core'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { isAddressEqual, type PublicClient } from 'viem'
import Image from 'next/image'
import { usePublicClient } from 'wagmi'
import { Brand } from '@/components/Brand'
import { DeployRemainingChains } from '@/components/DeployRemainingChains'
import { WalletButton } from '@/components/WalletButton'
import { IncomeLaunch } from '@/components/IncomeLaunch'
import { FundBridgeActions } from '@/components/FundBridgeActions'
import { ProjectActivity } from '@/components/ProjectActivity'
import { DisplayTokenAmount } from '@/components/DisplayTokenAmount'
import { HomerunProjectLayout, OwnersTabs } from '@/components/HomerunProjectLayout'
import { ProjectParticipants } from '@/components/ProjectParticipants'
import { ProjectPayerAddresses } from '@/components/ProjectPayerAddresses'
import { ProjectShop } from '@/components/ProjectShop'
import { IncomeProjectRuntime, type IncomeProjectSlots } from '@/components/IncomeProject'
import { LiveProjectActions } from '@/components/LiveProjectActions'
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
import { ActionSection, CashOutPanel, HolderActions, OperatorActions, PaymentPanel, errorMessage } from '@/components/live-transactions'

/** Every displayed balance and every permission is resolved from this chain. */

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
  useEffect(() => { if (query.data) setLastState(query.data) }, [query.data])
  // Keep receipt tracking mounted through a failed refresh or wallet change.
  // Retained reads are display-only until the active account is freshly read.
  const displayState = query.data ?? lastState
  const accountMatches = query.data?.account
    ? !!address && isAddressEqual(query.data.account, address)
    : !address
  const readsUnavailable = query.isError || query.isPlaceholderData || !query.data || query.data.blockNumber < (confirmed.data ?? 0n)
  const writesUnavailable = readsUnavailable || !accountMatches
  const details = useQuery({
    queryKey: ['fund-project-metadata', displayState?.projectUri],
    enabled: !!displayState?.projectUri,
    queryFn: () => fetchFundProjectMetadata(displayState!.projectUri),
    staleTime: 300_000,
    retry: 1,
  })
  const [lastIncomeId, setLastIncomeId] = useState<bigint | undefined>()
  const incomeBinding = useQuery({ queryKey: ['income-binding', chainId, projectId], enabled: !!client, queryFn: () => readIncomeLaunchBinding(client!, chainId, id), staleTime: 10_000, refetchInterval: 15_000, retry: false })
  useEffect(() => { if (incomeBinding.data) setLastIncomeId(incomeBinding.data) }, [incomeBinding.data])
  const incomeId = incomeBinding.data ?? lastIncomeId
  const notice = <>
    {details.isError && <p className="mb-5 text-sm">Project details could not be loaded. The contract balances and permissions below are still read independently.</p>}
    {query.isPending && <p role="status">Reading the project’s confirmed contract state…</p>}
    {query.isError && <div role="alert"><p>Project data could not be verified. Transactions are unavailable until the reads recover.</p><p className="mt-2 text-sm">{errorMessage(query.error)}</p><button type="button" className="btn-secondary mt-4" onClick={() => void query.refetch()}>Try again</button></div>}
    {incomeBinding.isError && <p role="status">The INCOME connection could not be refreshed. FUND balances and permissions are verified independently.</p>}
  </>
  return <IncomeProjectRuntime chainId={chainId} projectId={incomeId} fundProjectId={id} bindingUnavailable={incomeBinding.isPending || incomeBinding.isError || !!lastIncomeId && !incomeBinding.data}>{income => <div className="project-page live-contract-page">
    <a className="skip-link" href="#main">Skip to content</a>
    <header className="site-header flex items-center justify-between gap-5"><Brand /><WalletButton /></header>
    <main id="main" className="mx-auto max-w-[1220px] px-5 py-8 sm:px-8 sm:py-10" tabIndex={-1}>
      <ProjectActions key={`${chainId}:${projectId}`} chainId={chainId} projectId={id} intentId={intentId} state={displayState ?? undefined} client={client} details={details.data} notice={<>{notice}{income.notice}</>} income={income} refreshing={query.isFetching} readsUnavailable={readsUnavailable} writesUnavailable={writesUnavailable} refresh={() => void query.refetch()} />
    </main>
  </div>}</IncomeProjectRuntime>
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
  return <section className="mt-7 rounded-md border border-[#cbd7db] bg-[#edf2f4] p-5 text-[#3f5b66] sm:p-7">
    <h2 className="mb-4 text-3xl">The project plan</h2>
    <p className="mb-5 text-sm">Published estimates from the project metadata. These values do not set withdrawal rights, mint permissions, or confirm an asset purchase.</p>
    {(plan.ownerWallet || plan.operatorWallet) && <dl className="mb-5 grid gap-5 sm:grid-cols-2"><div><dt className="text-sm">Published Owner wallet: program control and FUND allocation</dt><dd className="mt-2 break-all text-sm">{plan.ownerWallet ?? 'Not specified'}</dd></div><div><dt className="text-sm">Published initial Operator wallet: INCOME incentives</dt><dd className="mt-2 break-all text-sm">{plan.operatorWallet ?? 'Not specified'}</dd></div></dl>}
    <dl className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4"><div><dt className="text-sm">Asset price</dt><dd className="mt-2 text-xl">{amount(plan.purchaseBudget)}</dd></div><div><dt className="text-sm">Bootstrap operating budget</dt><dd className="mt-2 text-xl">{amount(plan.opsReserve)}</dd></div><div><dt className="text-sm">Monthly revenue estimate</dt><dd className="mt-2 text-xl">{amount(plan.monthlyRent)}</dd></div><div><dt className="text-sm">Monthly expense estimate</dt><dd className="mt-2 text-xl">{amount(plan.monthlyCosts)}</dd></div><div><dt className="text-sm">Revenue growth per year</dt><dd className="mt-2 text-xl">{rate(plan.rentGrowthPercent)}</dd></div><div><dt className="text-sm">Expense growth per year</dt><dd className="mt-2 text-xl">{rate(plan.costGrowthPercent)}</dd></div></dl>
    <div className="mt-5"><h3 className="text-xl">The revenue plan</h3>{plan.revenueDescription && <p className="mt-2 whitespace-pre-line">{plan.revenueDescription}</p>}<h4 className="mt-4 font-medium">Minimum monthly revenue</h4><p className="mt-2">{plan.minimumRevenue === 0 ? 'No minimum set' : amount(plan.minimumRevenue)}</p>{plan.minimumRevenueConsequences && <><h4 className="mt-4 font-medium">If revenue falls below the minimum</h4><p className="mt-2 whitespace-pre-line text-sm">{plan.minimumRevenueConsequences}</p></>}<p className="mt-3 text-sm">This is a published operating commitment. It does not automatically change token allocations or contract settings; any program changes must be executed by the Owner.</p></div>
    <p className="mt-5 text-sm">The FUND token and the terms its holders start with are under Owners, Splits.</p>
  </section>
}

function ProjectActions({ chainId, projectId, intentId, state, client, details, notice, income, refreshing, readsUnavailable, writesUnavailable, refresh }: {
  chainId: JBChainId; projectId: bigint; intentId?: string; state?: FundProjectState; client?: PublicClient; details?: FundProjectMetadata; notice: ReactNode; income: IncomeProjectSlots
  refreshing: boolean; readsUnavailable: boolean; writesUnavailable: boolean; refresh: () => void
}) {
  const alsoDeploy = <DeployRemainingChains chainId={chainId} projectId={projectId.toString()} owner={state?.owner} intentId={intentId} />
  const { address, isConnected } = useWallet()
  const [contextIndex, setContextIndex] = useState(0)
  const [paymentToken, setPaymentToken] = useState<'fund' | 'income'>('fund')
  const paymentChoice = useRef(false)
  useEffect(() => { if (income.projectId && !paymentChoice.current) setPaymentToken('income') }, [income.projectId])
  if (!state || !client) {
    const pending = <p>Waiting for the project’s confirmed contract state.</p>
    return <HomerunProjectLayout title={details?.name ?? 'FUND project'}
      location={details?.location}
      logo={projectLogo(details, 'Project logo')}
      metadata={[`Network: ${displayChainName(chainId)}`, `FUND: #${projectId}`, 'Status: Verifying contracts']}
      notice={<>{alsoDeploy}{notice}</>}
      payment={<ActionSection title="Pay">{pending}</ActionSection>}
      activity={<ProjectActivity chainId={chainId} projectId={projectId} />}
      overview={<div className="grid gap-7"><ActionSection title="About"><p>{details?.description ?? 'Fund the asset, manage its treasury, and use your FUND tokens.'}</p>{pending}</ActionSection><CurrentOwnerProfile chainId={chainId} owner={undefined} details={details} /><CurrentOperatorProfile chainId={chainId} incomeProjectId={income.projectId} fundDetails={details} bindingUnavailable={income.bindingUnavailable} /></div>}
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
  const verified = <section aria-label="Verified project state" className="rounded-md border border-[#c4cdbb] p-5 sm:p-7">
    <div className="flex flex-wrap justify-between gap-3"><h2 className="text-3xl">The raise</h2><button className="text-sm underline" type="button" disabled={refreshing} onClick={refresh}>{refreshing ? 'Refreshing…' : 'Refresh'}</button></div>
    <dl className="mt-5 grid gap-5 sm:grid-cols-2">
      <div><dt className="text-sm">Contributions</dt><dd className="mt-2 text-xl">{state.metadata.pausePay ? 'Paused' : 'Open'}</dd></div>
      <div><dt className="text-sm">Cash-out tax</dt><dd className="mt-2 text-xl">{state.metadata.cashOutTaxRate === 10_000 ? 'Cash-outs disabled' : `${state.metadata.cashOutTaxRate / 100}%`}</dd></div>
      <div><dt className="text-sm">FUND supply</dt><dd className="mt-2 break-words text-xl"><DisplayTokenAmount value={state.totalSupply} /></dd></div>
      {context && <div><dt className="text-sm">FUND treasury</dt><dd className="mt-2 text-xl"><DisplayTokenAmount value={context.balance} decimals={context.decimals} /> {context.symbol}</dd></div>}
    </dl><p className="mt-5 text-sm">Verified at block {state.blockNumber.toString()}.</p>
  </section>
  const emptyIncome = <ActionSection title="INCOME"><p>INCOME has not been verified for this project yet. Its launch and recovery controls are under Operators.</p></ActionSection>
  return <HomerunProjectLayout
    title={name ?? 'FUND project'}
    location={details?.location}
    logo={projectLogo(details, name ? `${name} logo` : 'Project logo')}
    metadata={[`Network: ${displayChainName(state.chainId)}`, `FUND: #${state.projectId}`, income.projectId && `INCOME: #${income.projectId}`, `Status: ${!supported ? 'Unsupported FUND configuration' : state.metadata.pausePay ? 'Contributions paused' : 'Raising funds'}`, supported && context && <span>FUND treasury: <DisplayTokenAmount value={context.balance} decimals={context.decimals} /> {context.symbol}</span>, supported && <span>FUND supply: <DisplayTokenAmount value={state.totalSupply} /></span>, income.treasuryMetric].filter(Boolean)}
    notice={<>{alsoDeploy}{notice}{!supported && <p role="alert">This project uses contract settings outside Homerun’s verified FUND integration. Transactions are unavailable here. {state.issues.join(' ')}</p>}{!isConnected && <p>Connect your wallet to contribute, use your tokens, or access operator actions.</p>}{writesUnavailable && <p role="status">New transactions are paused while current project permissions and balances are being verified. Submitted transactions continue to be tracked below.</p>}</>}
    payment={<>
      {income.projectId && <div className="mb-5 flex gap-3" role="group" aria-label="Payment token"><button type="button" className={paymentToken === 'fund' ? 'btn-primary' : 'btn-secondary'} aria-pressed={paymentToken === 'fund'} onClick={() => { paymentChoice.current = true; setPaymentToken('fund') }}>FUND</button><button type="button" className={paymentToken === 'income' ? 'btn-primary' : 'btn-secondary'} aria-pressed={paymentToken === 'income'} onClick={() => { paymentChoice.current = true; setPaymentToken('income') }}>INCOME</button></div>}
      <div hidden={paymentToken !== 'fund'} onFocusCapture={() => { paymentChoice.current = true }}>{gate(<>{context ? <FundPaymentNetworks state={state}>{(paymentState, paymentClient, selector, onBusyChange) => <PaymentPanel state={paymentState} client={paymentClient} contextIndex={paymentState.chainId === state.chainId ? contextIndex : 0} chainSelector={selector} onBusyChange={onBusyChange} />}</FundPaymentNetworks> : <p>No supported payment terminal was verified for this project.</p>}</>)}</div>
      <div hidden={paymentToken !== 'income'}>{income.projectId && income.payment}</div>
    </>}
    activity={<><div hidden={paymentToken !== 'fund'}><ProjectActivity chainId={state.chainId} projectId={state.projectId} /></div><div hidden={paymentToken !== 'income'}>{income.activity}</div></>}
    overview={<div className="grid gap-7"><ActionSection title="About"><p className="whitespace-pre-line">{details?.description ?? 'Fund the asset, manage its treasury, and use your FUND tokens.'}</p>{details?.coverUrl && <Image unoptimized src={details.coverUrl} width={1200} height={675} alt={name ? `${name} cover` : 'Project cover'} className="mt-5 max-h-[480px] w-full rounded-md object-cover" />}<div className="mt-5 grid gap-4"><ProjectMetadataEditor chainId={chainId} projectId={projectId} client={client} unavailable={writesUnavailable} label="Edit FUND details" />{income.projectId && <ProjectMetadataEditor chainId={chainId} projectId={income.projectId} client={client} unavailable={income.writesUnavailable} inheritedMetadataUri={state.projectUri} label="Edit INCOME details" />}</div></ActionSection>{verified}{income.overview}<CurrentOwnerProfile chainId={chainId} owner={state.owner} details={details} unavailable={readsUnavailable || !state.knownOwnerWrapper} /><CurrentOperatorProfile chainId={chainId} incomeProjectId={income.projectId} fundDetails={income.details?.plan ? income.details : details} bindingUnavailable={income.bindingUnavailable} /></div>}
    stages={<div className="grid gap-7">{supported && <LiveProjectActions token="FUND" state={{paymentsPaused: state.metadata.pausePay, cashOutsEnabled: state.metadata.cashOutTaxRate < 10_000, mintingEnabled: state.metadata.allowOwnerMinting, hasLinkedIncome: !!income.projectId}} />}<ActionSection title="The project journey"><ol className="grid gap-5"><li><h3 className="text-2xl">1. Fundraise</h3><p className="mt-2">{state.metadata.pausePay ? 'Contributions are paused under the current rules.' : 'Contributions are open under the current rules.'} FUND represents participation in the asset raise and its eventual net sale proceeds.</p></li><li><h3 className="text-2xl">2. Income</h3><p className="mt-2">{income.projectId ? `INCOME project ${income.projectId} is connected on this network.` : 'After a successful purchase, the operator can launch INCOME and its initial holder allocation.'}</p></li><li><h3 className="text-2xl">3. Asset sale</h3><p className="mt-2">Net proceeds return to the FUND treasury. Holders use the cash-out terms active at that time.</p></li></ol><p className="mt-5 text-sm">Contract settings do not verify an offchain purchase, campaign failure, or asset sale. Indexed transactions appear in Activity.</p></ActionSection><ActionSection title="Current and upcoming rules"><p>Current ruleset {state.ruleset.id.toString()}, active since {new Date(Number(state.ruleset.start) * 1000).toLocaleString()}.</p>{state.upcoming && state.upcoming.ruleset.id !== state.ruleset.id ? <p className="mt-3">Ruleset {state.upcoming.ruleset.id.toString()} is scheduled for {new Date(Number(state.upcoming.ruleset.start) * 1000).toLocaleString()}.</p> : <p className="mt-3">No different upcoming ruleset is currently verified.</p>}</ActionSection>{plan && <PlannedIncome plan={plan} />}{income.stages}</div>}
    owners={<OwnersTabs
      accountsYou={<div className="grid gap-7">{gate(<ActionSection title="Your FUND">{address ? <><p className="mb-3 break-words text-2xl"><DisplayTokenAmount value={totalBalance} /> FUND</p><p className="mb-6 text-sm"><DisplayTokenAmount value={state.creditBalance} /> internal credits / <DisplayTokenAmount value={state.erc20Balance} /> ERC-20 tokens. Both count as FUND without staking.</p></> : <p className="mb-5">Connect a wallet to read your holdings.</p>}<fieldset disabled={!address} className="min-w-0 border-0 p-0"><HolderActions state={state} client={client} /></fieldset></ActionSection>)}{gate(context && <>{currency}<CashOutPanel state={state} client={client} contextIndex={contextIndex} /></>)}{income.projectId ? income.accountsYou : emptyIncome}</div>}
      accountsAll={<div className="grid gap-7"><ProjectParticipants chainId={state.chainId} projectId={state.projectId} tokenLabel="FUND" />{income.projectId ? income.accountsAll : emptyIncome}</div>}
      settlement={<div className="grid gap-7">{gate(<FundBridgeActions state={state} />)}{income.projectId && income.settlement}</div>}
      splits={<div className="grid gap-7">{publishedToken}<ProjectSplitsEditor chainId={chainId} projectId={projectId} phase="fund" client={client} unavailable={writesUnavailable} />{income.projectId ? income.splits : emptyIncome}</div>}
      loans={income.projectId ? income.loans : <ActionSection title="Loans"><p>Loans use INCOME as collateral. They become available after a verified INCOME launch under its contract terms.</p></ActionSection>}
      control={<div className="grid gap-7"><ProjectOwnershipEditor chainId={chainId} projectId={projectId} client={client} unavailable={writesUnavailable} />{income.projectId && income.control}</div>}
      permissions={<div className="grid gap-7"><ProjectPermissionsEditor chainId={chainId} projectId={projectId} client={client} unavailable={writesUnavailable} />{income.projectId && income.permissions}</div>}
    />}
    shop={<div className="grid gap-7"><section><h2 className="mb-5 text-3xl">FUND shop</h2><ProjectShop chainId={state.chainId} projectId={state.projectId} tokenLabel="FUND" /></section>{income.projectId && <section><h2 className="mb-5 text-3xl">INCOME shop</h2>{income.shop}</section>}</div>}
    extras={<div className="grid gap-7"><ProjectPayerAddresses chainId={state.chainId} projectId={state.projectId} tokenLabel="FUND" />{income.extras}<ActionSection title="Contracts"><dl className="grid gap-3 break-all"><div><dt>Project owner</dt><dd>{state.owner}</dd></div><div><dt>Operator</dt><dd>{state.operator ?? 'Not verified'}</dd></div><div><dt>Controller</dt><dd>{state.controller}</dd></div>{state.tokenAddress && <div><dt>FUND ERC-20</dt><dd>{state.tokenAddress}</dd></div>}</dl></ActionSection><SiteIntegration configuration={{ mode: 'live-project', source: 'verified contract reads and published project metadata', chainId: state.chainId, fundProjectId: state.projectId.toString(), incomeProjectId: income.projectId?.toString() ?? null, project: { name: name ?? null, location: details?.location ?? null }, publishedPlan: plan ?? null }} /></div>}
    operators={<div className="grid gap-7">{income.projectId ? income.operators : null}{gate(<ActionSection title="Operator actions">{!isOperator && <p className="mb-5">Connect a wallet with verified project permissions to manage this project. Contract permissions are checked again before every transaction.</p>}<fieldset disabled={!isOperator} className="min-w-0 border-0 p-0"><OperatorActions state={state} client={client} contextIndex={contextIndex} /></fieldset></ActionSection>)}<IncomeLaunch state={state} client={client} name={name} plannedAllocation={plan && plan.operatorSplitPercent !== null && plan.fundHolderSplitPercent !== null ? { reservedPercent: plan.operatorSplitPercent + plan.fundHolderSplitPercent } : undefined} launchUnavailable={blocked} embedExistingProject={false} /></div>}
  />
}
