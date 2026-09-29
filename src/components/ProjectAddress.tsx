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
import { PERSIST } from '@/lib/query-persist'

/**
 * One address per Homerun project: its FUND's. An INCOME project's own address
 * forwards to the FUND it was launched from, which shows INCOME in its tabs. The
 * index says which kind a project is; the chain says which FUND an INCOME belongs to.
 */
export function ProjectAddress({ chainId, projectId, intentId }: { chainId: JBChainId; projectId: string; intentId?: string }) {
  const router = useRouter()
  const client = usePublicClient({ chainId }) as PublicClient | undefined
  const indexed = useQuery({
    queryKey: ['indexed-project', chainId, Number(projectId)],
    meta: PERSIST,
    enabled: Number.isSafeInteger(Number(projectId)),
    queryFn: () => getProject(chainId, Number(projectId)),
    staleTime: 30_000,
    retry: 1,
  })
  const row = indexed.data
  const income = row?.version === 6 && row.chainId === chainId && String(row.projectId) === projectId && row.isRevnet === true
  const fund = useQuery({
    queryKey: ['income-fund-binding', chainId, projectId],
    enabled: income && !!client,
    queryFn: () => readIncomeFundBinding(client!, { chainId, incomeProjectId: BigInt(projectId) }),
    staleTime: 300_000,
    retry: 1,
  })
  useEffect(() => {
    if (fund.data) router.replace(`${projectPath(chainId, fund.data)}${window.location.hash}`)
  }, [fund.data, chainId, router])
  if (!income) return <FundProject chainId={chainId} projectId={projectId} intentId={intentId} />
  // An INCOME with no Homerun FUND behind it has only this address.
  if (fund.data === null || fund.isError) return <IncomeProject chainId={chainId} projectId={BigInt(projectId)} />
  return <ProjectPageShell><p className="mx-auto max-w-[1220px] px-5 py-10 text-sm text-[var(--muted)]" role="status">Opening this project…</p></ProjectPageShell>
}
