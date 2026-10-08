'use client'

import { useQuery } from '@tanstack/react-query'
import { useId, useState } from 'react'
import { formatUnits } from 'viem'
import { ChainIcon } from '@/components/ChainIcon'
import { getProject, getSuckerGroupProjects, resolveProjectDeployments } from '@/lib/bendystraw'
import { displayChainName, explorerAddressUrl } from '@/lib/chainDisplay'
import {
  PROJECT_PARTICIPANTS_PAGE_SIZE,
  formatParticipantBalance,
  getProjectHolders,
  indexedParticipantProjectId,
} from '@/lib/project-participants'
import { PERSIST } from '@/lib/query-persist'
import { useHydrated } from '@/hooks/useHydrated'

function TokenBalance({ value }: { value: bigint }) {
  return <span className="break-words tabular-nums" title={formatUnits(value, 18)}>{formatParticipantBalance(value.toString())}</span>
}

/** The project's chains, as Juicebox Money resolves them: the index row's sucker group, checked against this route. */
function useDeployments(chainId: number, projectId: number) {
  const hydrated = useHydrated()
  const home = useQuery({
    queryKey: ['indexed-project', chainId, projectId],
    meta: PERSIST,
    queryFn: ({ signal }) => getProject(chainId, projectId, { signal }),
    staleTime: 30_000,
    retry: 1,
  })
  const row = hydrated && home.data?.version === 6 && home.data.chainId === chainId && home.data.projectId === projectId ? home.data : null
  const group = useQuery({
    queryKey: ['sucker-group-projects', row?.suckerGroupId],
    enabled: !!row?.suckerGroupId,
    meta: PERSIST,
    queryFn: ({ signal }) => getSuckerGroupProjects(row!.suckerGroupId!, chainId, { signal }),
    staleTime: 300_000,
    retry: 1,
  })
  // An unindexed or ungrouped project, or a failed group read, still lists this chain's holders.
  const settled = hydrated && (!home.isPending || home.isError) && (!row?.suckerGroupId || !group.isPending || group.isError)
  const deployments = row ? resolveProjectDeployments(row, group.data ?? []) : [{ chainId, projectId }]
  return { hydrated, settled, refs: deployments.map(item => [item.chainId, item.projectId] as const) }
}

function ParticipantsList({ chainId, projectId, tokenLabel }: { chainId: number; projectId: number; tokenLabel: string }) {
  const heading = useId()
  const [page, setPage] = useState(0)
  const { hydrated, settled, refs } = useDeployments(chainId, projectId)
  const refsKey = refs.map(([chain, id]) => `${chain}:${id}`).join(',')
  const query = useQuery({
    // Starts with this chain and project, so post-transaction refreshes (refreshIndexedProject) reach it.
    queryKey: ['project-participants', chainId, projectId, refsKey],
    enabled: settled,
    meta: PERSIST,
    queryFn: ({ signal }) => getProjectHolders(refs, { signal }),
    staleTime: 30_000,
    retry: 1,
  })
  const holders = hydrated ? query.data?.holders : undefined
  const pageCount = Math.max(1, Math.ceil((holders?.length ?? 0) / PROJECT_PARTICIPANTS_PAGE_SIZE))
  const current = Math.min(page, pageCount - 1)
  const offset = current * PROJECT_PARTICIPANTS_PAGE_SIZE
  const visible = holders?.slice(offset, offset + PROJECT_PARTICIPANTS_PAGE_SIZE) ?? []
  const count = holders ? `${holders.length.toLocaleString()}${query.data!.complete ? '' : '+'} ${holders.length === 1 && query.data!.complete ? 'holder' : 'holders'}` : ''

  return <section aria-labelledby={heading} className="demo-section min-w-0">
    <h2 id={heading}>{tokenLabel} holders</h2>
    {(query.isPending || !settled) && !holders && <p role="status">Loading {tokenLabel} holders…</p>}
    {hydrated && query.isError && <p role="status">{holders ? 'Holder balances could not refresh. Showing the last list.' : 'Holder balances are temporarily unavailable.'}</p>}
    {holders && (holders.length === 0 ? <p>No one holds {tokenLabel} yet. Holders show up here after they pay.</p> : <>
      <p>Balances include wallet tokens and unclaimed credits{refs.length > 1 ? `, across ${refs.length} chains` : ''}.</p>
      <p role="status" className="my-3 text-sm">{count}{holders.length > PROJECT_PARTICIPANTS_PAGE_SIZE ? ` / Showing ${offset + 1}–${offset + visible.length}` : ''}</p>
      <ul className="m-0 list-none p-0">
        {visible.map(holder => <li key={holder.address.toLowerCase()} className="grid min-w-0 gap-3 border-b border-[#d5dccd] py-4 last:border-0 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] sm:items-center">
          <span className="flex min-w-0 flex-wrap items-center gap-2">
            <a className="break-all text-sm underline underline-offset-4" href={explorerAddressUrl(holder.chains[0], holder.address)!} target="_blank" rel="noopener noreferrer" title={holder.address}>{holder.address.slice(0, 6)}…{holder.address.slice(-4)}<span className="sr-only"> — {holder.address}</span> ↗</a>
            {refs.length > 1 && <span className="flex items-center gap-1" aria-label={`Holds on ${holder.chains.map(displayChainName).join(', ')}`}>{holder.chains.map(chain => <ChainIcon key={chain} chainId={chain} size={14} />)}</span>}
          </span>
          <dl className="m-0 grid min-w-0 grid-cols-3 gap-3 text-sm">
            <div className="min-w-0"><dt className="mb-1 text-xs">Total {tokenLabel}</dt><dd className="m-0 font-medium"><TokenBalance value={holder.balance} /></dd></div>
            <div className="min-w-0"><dt className="mb-1 text-xs">Wallet tokens</dt><dd className="m-0"><TokenBalance value={holder.erc20Balance} /></dd></div>
            <div className="min-w-0"><dt className="mb-1 text-xs">Unclaimed credits</dt><dd className="m-0"><TokenBalance value={holder.creditBalance} /></dd></div>
          </dl>
        </li>)}
      </ul>
    </>)}
    {pageCount > 1 && <nav aria-label={`${tokenLabel} holder pages`} className="mt-5 flex flex-wrap items-center gap-3">
      {current > 0 && <button type="button" className="btn-secondary" onClick={() => setPage(0)}>First page</button>}
      <button type="button" className="btn-secondary" disabled={current === 0} onClick={() => setPage(current - 1)}>Previous</button>
      <button type="button" className="btn-secondary" disabled={current >= pageCount - 1} onClick={() => setPage(current + 1)}>Next</button>
    </nav>}
  </section>
}

/** Indexed display only. FUND and verified linked INCOME projects are separate scopes. */
export function ProjectParticipants({ chainId, projectId, tokenLabel = 'FUND' }: { chainId: number; projectId: string | number | bigint; tokenLabel?: string }) {
  const id = indexedParticipantProjectId(chainId, projectId)
  if (id === null) return <section className="demo-section"><h2>{tokenLabel} holders</h2><p>This project identity is not supported by the index.</p></section>
  return <ParticipantsList key={`${chainId}:${id}:${tokenLabel}`} chainId={chainId} projectId={id} tokenLabel={tokenLabel} />
}
