'use client'

import Image from 'next/image'
import type { ReactNode } from 'react'
import { DEFAULT_NETWORK, projectNetwork } from '../../web/network-model.mjs'
import { FundingProgress } from './FundingProgress'
import { HomerunProjectLayout } from './HomerunProjectLayout'
import { OperatorProfile } from './OperatorProfile'
import { displayChainName } from '@/lib/chainDisplay'
import type { FundProjectMetadata } from '@/lib/fund-project-metadata'

export type PlannedProjectPlan = NonNullable<FundProjectMetadata['plan']>

export type PlannedProfile = {
  name?: string | null
  introduction?: string | null
  photoUrl?: string | null
}

export type PlannedProjectDisplay = {
  name: string
  location?: string | null
  logoUrl?: string | null
  coverUrl?: string | null
  description?: string | null
  detailsUnavailable?: boolean
  /** The owner the signed creation carries, or how the setup describes it. */
  owner: string
  /** An address to link, when the owner is one this page already knows. */
  ownerAddress?: string | null
  operatorAddress?: string | null
  ownerProfile?: PlannedProfile
  operatorProfile?: PlannedProfile
  chainIds: readonly number[]
  tokenName: string
  ticker: string
  mustStartAtOrAfter: number
  status: string
  multisigs?: string
  plan?: PlannedProjectPlan | null
}

const money = (value: number) => new Intl.NumberFormat('en-US', {
  style: 'currency', currency: 'USD', maximumFractionDigits: Number.isInteger(value) ? 0 : 2,
}).format(value)

/** The raise the published terms add up to: the asset, its reserve and the payout fee. */
export function plannedRaiseGoal(plan?: PlannedProjectPlan | null): number | null {
  if (!plan || plan.purchaseBudget === null || plan.purchaseBudget <= 0) return null
  try {
    return projectNetwork({
      ...DEFAULT_NETWORK,
      purchaseBudget: plan.purchaseBudget,
      opsReserve: plan.opsReserve ?? 0,
      investment: 0,
      raisedPercent: 0,
      salePrice: plan.purchaseBudget,
    }, 'raising').raiseGoal as number
  } catch { return null }
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return <section className="rounded-md border border-[#c4cdbb] bg-[#eef1e7] p-5 sm:p-7">
    <h2 className="mb-5 text-3xl">{title}</h2>{children}
  </section>
}

const PLAN_INTRO = 'Published estimates from the project metadata. These values do not set withdrawal rights, mint permissions, or confirm an asset purchase.'

export function PlannedIncome({ plan, intro = PLAN_INTRO }: { plan: PlannedProjectPlan; intro?: string }) {
  const amount = (value: number | null) => value === null ? 'Not specified' : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(value)
  return <section className="mt-7 rounded-md border border-[#cbd7db] bg-[#edf2f4] p-5 text-[#3f5b66] sm:p-7">
    <h2 className="mb-4 text-3xl">The project plan</h2>
    <p className="mb-5 text-sm">{intro}</p>
    {(plan.ownerWallet || plan.operatorWallet) && <dl className="mb-5 grid gap-5 sm:grid-cols-2"><div><dt className="text-sm">Published Owner wallet: program control and FUND allocation</dt><dd className="mt-2 break-all text-sm">{plan.ownerWallet ?? 'Not specified'}</dd></div><div><dt className="text-sm">Published initial Operator wallet: INCOME incentives</dt><dd className="mt-2 break-all text-sm">{plan.operatorWallet ?? 'Not specified'}</dd></div></dl>}
    <dl className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4"><div><dt className="text-sm">Asset price</dt><dd className="mt-2 text-xl">{amount(plan.purchaseBudget)}</dd></div><div><dt className="text-sm">Cash reserve</dt><dd className="mt-2 text-xl">{amount(plan.opsReserve)}</dd></div><div><dt className="text-sm">Monthly revenue estimate</dt><dd className="mt-2 text-xl">{amount(plan.monthlyRent)}</dd></div><div><dt className="text-sm">Monthly expense estimate</dt><dd className="mt-2 text-xl">{amount(plan.monthlyCosts)}</dd></div></dl>
    <div className="mt-5"><h3 className="text-xl">Minimum monthly revenue</h3><p className="mt-2">{plan.minimumRevenue === 0 ? 'No minimum set' : amount(plan.minimumRevenue)}</p>{plan.minimumRevenueConsequences && <><h4 className="mt-4 font-medium">If revenue falls below the minimum</h4><p className="mt-2 whitespace-pre-line text-sm">{plan.minimumRevenueConsequences}</p></>}<p className="mt-3 text-sm">This is a published operating commitment. It does not automatically change token allocations or contract settings; any program changes must be executed by the Owner.</p></div>
    <p className="mt-5 text-sm">Planned Owner FUND share: {plan.operatorFundPercent === null ? 'not specified' : `${plan.operatorFundPercent}%`}. The Owner may distribute these FUND tokens at their discretion. Current balances and supply determine actual ownership.</p>
    <h3 className="mb-3 mt-7 text-2xl">Planned INCOME allocation</h3>
    <p className="text-sm">The initial 500,000 INCOME is allocated to all FUND holders at the published snapshot, including wallet tokens and unclaimed credits. Claiming that allocation does not require staking.</p>
    {plan.operatorSplitPercent !== null && plan.fundHolderSplitPercent !== null && plan.operatorSplitPercent + plan.fundHolderSplitPercent <= 100 && <p className="mt-3 text-sm">Planned new INCOME allocation: {plan.operatorSplitPercent}% operators / {plan.fundHolderSplitPercent}% eligible FUND stakers / {100 - plan.operatorSplitPercent - plan.fundHolderSplitPercent}% customers.</p>}
  </section>
}

/**
 * The project page a creation will publish, rendered from the setup a browser
 * saved or from an intent's signed calls and pinned details. No chain is read:
 * every figure here is a term, not a balance.
 */
export function PlannedProjectView({ display, banner, actions, planIntro }: {
  display: PlannedProjectDisplay
  banner?: ReactNode
  actions?: ReactNode
  planIntro?: string
}) {
  const { name, chainIds, plan } = display
  const networks = chainIds.map(displayChainName).join(', ')
  const goal = plannedRaiseGoal(plan)
  const opensLater = display.mustStartAtOrAfter * 1000 > Date.now()
  const opens = opensLater ? new Date(display.mustStartAtOrAfter * 1000).toLocaleString() : 'as soon as it is created'
  const hero = display.logoUrl ?? display.coverUrl

  return <HomerunProjectLayout
    title={name}
    location={display.location}
    logo={hero && <Image unoptimized src={hero} width={192} height={192} alt={display.logoUrl ? `${name} logo` : ''} />}
    metadata={[
      <span key="status" id="project-status" className="project-status" role="status">Status: {display.status}</span>,
      `Networks: ${networks}`,
      `FUND token: ${display.tokenName} (${display.ticker})`,
      `Contributions open: ${opens}`,
      goal !== null && `Raised: ${money(0)} of ${money(goal)}`,
      goal !== null && 'Funded: 0%',
    ].filter(Boolean)}
    headerProgress={goal !== null && <FundingProgress raised={0} goal={goal} compact />}
    payment={<div className="grid gap-5">{banner}{actions}</div>}
    activity={<Section title="Activity"><p>Contributions and transfers appear here once this project is created.</p></Section>}
    overview={<div className="grid gap-7">
      <Section title="About">
        {display.detailsUnavailable && <p className="mb-5 text-sm">The project details could not be loaded. The terms above are read from the signed project creation.</p>}
        <p className="whitespace-pre-line">{display.description ?? 'Fund an asset with a FUND Juicebox created on first use.'}</p>
        {display.coverUrl && <Image unoptimized src={display.coverUrl} width={1200} height={675} alt={`${name} cover`} className="mt-5 max-h-[480px] w-full rounded-md object-cover" />}
      </Section>
      {goal !== null && <section className="rounded-md border border-[#c4cdbb] p-5 sm:p-7" aria-label="Fundraising overview">
        <h2 className="mb-5 text-3xl">Progress</h2>
        <dl className="grid gap-5 sm:grid-cols-2">
          <div><dt className="text-sm">Raised</dt><dd className="mt-2 text-xl">{money(0)}</dd></div>
          <div><dt className="text-sm">Raise goal</dt><dd className="mt-2 text-xl">{money(goal)}</dd></div>
        </dl>
        <div className="mt-5"><FundingProgress raised={0} goal={goal} /></div>
        <p className="mt-5"><strong>0%</strong> funded</p>
      </section>}
      <Section title="Representation">
        <div className="grid gap-5 sm:grid-cols-2">
          <div><h3 className="text-2xl">FUND</h3><p className="mt-2">A share of the net proceeds when the asset is sold.</p></div>
          <div><h3 className="text-2xl">INCOME</h3><p className="mt-2">A share of ongoing revenues, owned by FUND holders, operators, and customers.</p></div>
        </div>
      </Section>
      <OperatorProfile role="Owner" name={display.ownerProfile?.name} introduction={display.ownerProfile?.introduction} photoUrl={display.ownerProfile?.photoUrl} address={display.ownerAddress ?? undefined} chainId={chainIds[0]} />
      <OperatorProfile name={display.operatorProfile?.name} introduction={display.operatorProfile?.introduction} photoUrl={display.operatorProfile?.photoUrl} address={display.operatorAddress ?? undefined} chainId={chainIds[0]} />
    </div>}
    stages={<div className="grid gap-7">
      <Section title="The project journey">
        <ol className="grid gap-5">
          <li><h3 className="text-2xl">1. Fundraise</h3><p className="mt-2">{opensLater ? `Contributions open ${opens}.` : 'Contributions open as soon as this project is created.'} FUND represents participation in the asset raise and its eventual net sale proceeds.</p>{goal !== null && <p className="mt-2">The raise goal is {money(goal)}.</p>}</li>
          <li><h3 className="text-2xl">2. Income</h3><p className="mt-2 whitespace-pre-line">{plan?.revenueDescription ?? 'After a successful purchase, the operator can launch INCOME and its initial holder allocation.'}</p></li>
          <li><h3 className="text-2xl">3. Asset sale</h3><p className="mt-2">Net proceeds return to the FUND treasury. Holders use the cash-out terms active at that time.</p></li>
        </ol>
        <p className="mt-5 text-sm">Contract settings do not verify an offchain purchase, campaign failure, or asset sale.</p>
      </Section>
      {plan && <PlannedIncome plan={plan} intro={planIntro} />}
    </div>}
    owners={<div className="grid gap-7">
      <Section title="Owner">
        <p className="break-all">Owner: {display.owner}</p>
        <p className="mt-3 text-sm">The Owner holds the project, changes its rules, and moves its treasury.</p>
      </Section>
      {display.multisigs && <section className="rounded-md border border-[#c4cdbb] bg-[#fffefa] p-5 sm:p-7">
        <h2 className="mb-5 text-3xl">Multisigs</h2>
        <p>Juicebox Center’s sponsor creates these Safes on {networks} along with the project. Each address is fixed by its owners, its approval policy and its salt, so the project is theirs whether the Safe exists yet or not.</p>
        <p className="mt-5 whitespace-pre-line break-all text-sm">{display.multisigs}</p>
      </section>}
      <Section title="Holders"><p>FUND holders appear here once this project is created and contributions begin.</p></Section>
    </div>}
    shop={<Section title="Shop"><p>The shop opens once this project is created.</p></Section>}
    extras={<Section title="Extras"><p>Payer addresses and contract details appear once this project is created.</p></Section>}
    operators={<Section title="Operators"><p>Operator actions appear once this project is created.</p></Section>}
  />
}
