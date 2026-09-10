import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import type { JBChainId } from '@bananapus/nana-sdk-core'
import { Brand } from '@/components/Brand'
import { IncomeProject } from '@/components/IncomeProject'
import { WalletButton } from '@/components/WalletButton'
import { displayChainName } from '@/lib/chainDisplay'
import { FUND_CHAIN_IDS } from '@/lib/fund-contracts'

type IncomeRouteProps = {
  params: Promise<{ chainId: string; projectId: string }>
  searchParams: Promise<{ fund?: string | string[] }>
}

function projectRoute(chainId: string, projectId: string) {
  if (!/^[1-9]\d*$/.test(chainId) || !/^[1-9]\d*$/.test(projectId) || projectId.length > 78) notFound()
  const chain = Number(chainId)
  if (!(FUND_CHAIN_IDS as readonly number[]).includes(chain) || BigInt(projectId) >= 1n << 256n) notFound()
  return { chainId: chain as JBChainId, projectId: BigInt(projectId) }
}

function fundId(value: string | string[] | undefined) {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value) || value.length > 78 || BigInt(value) >= 1n << 256n) notFound()
  return BigInt(value)
}

export async function generateMetadata({ params }: IncomeRouteProps): Promise<Metadata> {
  const route = await params
  const { chainId, projectId } = projectRoute(route.chainId, route.projectId)
  return {
    title: `INCOME ${projectId} on ${displayChainName(chainId)}`,
    description: 'Use your INCOME tokens, rewards, and loans through verified Juicebox V6 revnet contracts.',
    alternates: { canonical: `https://homerun.money/income/${chainId}/${projectId}` },
  }
}

export default async function IncomePage({ params, searchParams }: IncomeRouteProps) {
  const [route, search] = await Promise.all([params, searchParams])
  const { chainId, projectId } = projectRoute(route.chainId, route.projectId)
  // This parameter only requests a reward-route check. Contract splits must
  // independently prove the FUND token before its rewards become available.
  const fundProjectId = fundId(search.fund)
  return <div className="project-page live-contract-page">
    <a className="skip-link" href="#main">Skip to content</a>
    <header className="site-header flex items-center justify-between gap-5"><Brand /><WalletButton /></header>
    <main id="main" className="mx-auto max-w-[1220px] px-5 py-10 sm:py-14" tabIndex={-1}>
      <p className="mb-3 text-sm">{displayChainName(chainId)}</p>
      <h1 className="mb-5 text-5xl sm:text-6xl">Revenue project {projectId.toString()}</h1>
      <IncomeProject key={`${chainId}:${projectId}`} chainId={chainId} projectId={projectId} fundProjectId={fundProjectId} />
    </main>
  </div>
}
