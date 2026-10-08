'use client'

import { useQuery } from '@tanstack/react-query'
import { useRouter } from 'next/navigation'
import { useEffect } from 'react'
import type { PublicClient } from 'viem'
import { usePublicClient } from 'wagmi'
import type { JBChainId } from '@bananapus/nana-sdk-core'
import { FundProject } from '@/components/FundProject'
import { IncomeProject } from '@/components/IncomeProject'
import { ProjectPageShell } from '@/components/ProjectPage'
import { getProject } from '@/lib/bendystraw'
import { readIncomeFundBinding } from '@/lib/income-fund-binding'
import { projectPath } from '@/lib/urn'
import type { ProjectSeed } from '@/lib/project-seed'
import { PERSIST } from '@/lib/query-persist'
import { useHydrated } from '@/hooks/useHydrated'

/**
 * One address per Homerun project: its FUND's. An INCOME project's own address
 * forwards to the FUND it was launched from, which shows INCOME in its tabs. The
 * index says which kind a project is; the chain says which FUND an INCOME belongs to.
 */
export function ProjectAddress({ chainId, projectId, intentId, seed, incomeFund }: {
  chainId: JBChainId; projectId: string; intentId?: string; seed?: ProjectSeed
  /** The server's answer for a revnet: null when it has no Homerun FUND; undefined when unknown. */
  incomeFund?: string | null
}) {
  const hydrated = useHydrated()
  const router = useRouter()
  const client = usePublicClient({ chainId }) as PublicClient | undefined
  const indexed = useQuery({
    queryKey: ['indexed-project', chainId, Number(projectId)],
    meta: PERSIST,
    enabled: Number.isSafeInteger(Number(projectId)),
    queryFn: ({ signal }) => getProject(chainId, Number(projectId), { signal }),
    initialData: seed?.indexed ?? undefined,
    staleTime: 30_000,
    retry: 1,
  })
  const row = hydrated ? indexed.data : seed?.indexed
  const income = row?.version === 6 && row.chainId === chainId && String(row.projectId) === projectId && row.isRevnet === true
  const seededFundId = incomeFund === undefined ? undefined : incomeFund === null ? null : BigInt(incomeFund)
  const fund = useQuery({
    queryKey: ['income-fund-binding', chainId, projectId],
    enabled: income && !!client,
    queryFn: () => readIncomeFundBinding(client!, { chainId, incomeProjectId: BigInt(projectId) }),
    initialData: seededFundId,
    // Fixed at launch: a found binding never needs reading again.
    staleTime: Infinity,
    meta: PERSIST,
    retry: 1,
  })
  const fundId = hydrated ? fund.data : seededFundId
  useEffect(() => {
    if (fundId) router.replace(`${projectPath(chainId, fundId)}${window.location.hash}`)
  }, [fundId, chainId, router])
  if (!income) return <FundProject chainId={chainId} projectId={projectId} intentId={intentId} seed={seed} />
  // An INCOME with no Homerun FUND behind it has only this address.
  if (fundId === null || hydrated && fund.isError) return <IncomeProject chainId={chainId} projectId={BigInt(projectId)} />
  return <ProjectPageShell><p className="mx-auto max-w-[1220px] px-5 py-10 text-sm text-[var(--muted)]" role="status">Opening this project…</p></ProjectPageShell>
}
