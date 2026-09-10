'use client'

import { useQuery } from '@tanstack/react-query'
import { useId, useState } from 'react'
import { formatUnits } from 'viem'
import { displayChainName, explorerAddressUrl } from '@/lib/chainDisplay'
import {
  formatParticipantBalance,
  getProjectParticipants,
  indexedParticipantProjectId,
} from '@/lib/project-participants'

function TokenBalance({ value }: { value: string }) {
  return <span className="break-words tabular-nums" title={formatUnits(BigInt(value), 18)}>{formatParticipantBalance(value)}</span>
}

function ParticipantsList({ chainId, projectId, tokenLabel }: { chainId: number; projectId: number; tokenLabel: string }) {
  const heading = useId()
  const [offsets, setOffsets] = useState([0])
  const offset = offsets.at(-1) ?? 0
  const query = useQuery({
    queryKey: ['project-participants', chainId, projectId, offset],
    queryFn: () => getProjectParticipants(chainId, projectId, offset),
    staleTime: 30_000,
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
    retry: 1,
  })
  const page = query.data

  return <section aria-labelledby={heading} className="contract-panel min-w-0">
    <div className="flex flex-wrap items-baseline justify-between gap-3">
      <h2 id={heading}>{tokenLabel} holders</h2>
      <button type="button" className="btn-secondary" disabled={query.isFetching} onClick={() => void query.refetch()}>{query.isFetching ? 'Refreshing…' : 'Refresh holders'}</button>
    </div>
    <p className="my-4 text-sm">{displayChainName(chainId)} / Project {projectId}. Balances include wallet tokens and unclaimed credits. Recent changes may take time to appear.</p>
    {query.isPending && <p role="status">Loading {tokenLabel} holders…</p>}
    {query.isError && <p role="status">{page ? 'Holder balances could not refresh. Showing the last indexed page.' : 'Holder balances are temporarily unavailable. Refresh to try again.'}</p>}
    {page && <>
      <p role="status" className="my-3 text-sm">{page.totalCount.toLocaleString()} indexed {page.totalCount === 1 ? 'account' : 'accounts'}{page.items.length ? ` / Showing ${offset + 1}–${offset + page.items.length}` : ''}</p>
      {page.items.length > 0 ? <ul className="m-0 list-none p-0">
        {page.items.map(holder => <li key={holder.address.toLowerCase()} className="grid min-w-0 gap-3 border-b border-[#d5dccd] py-4 last:border-0 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] sm:items-center">
          <a className="break-all text-sm underline underline-offset-4" href={explorerAddressUrl(chainId, holder.address)!} target="_blank" rel="noopener noreferrer" title={holder.address}>{holder.address.slice(0, 6)}…{holder.address.slice(-4)}<span className="sr-only"> — {holder.address}</span> ↗</a>
          <dl className="m-0 grid min-w-0 grid-cols-3 gap-3 text-sm">
            <div className="min-w-0"><dt className="mb-1 text-xs">Total {tokenLabel}</dt><dd className="m-0 font-medium"><TokenBalance value={holder.balance} /></dd></div>
            <div className="min-w-0"><dt className="mb-1 text-xs">Wallet tokens</dt><dd className="m-0"><TokenBalance value={holder.erc20Balance} /></dd></div>
            <div className="min-w-0"><dt className="mb-1 text-xs">Unclaimed credits</dt><dd className="m-0"><TokenBalance value={holder.creditBalance} /></dd></div>
          </dl>
        </li>)}
      </ul> : <p>{offset === 0 ? 'No positive balances are indexed yet.' : 'There are no accounts on this page. Return to the first page to refresh the list.'}</p>}
    </>}
    {(offset > 0 || page?.nextOffset !== null && page?.nextOffset !== undefined) && <nav aria-label={`${tokenLabel} holder pages`} className="mt-5 flex flex-wrap items-center gap-3">
      {offset > 0 && <button type="button" className="btn-secondary" onClick={() => setOffsets([0])}>First page</button>}
      <button type="button" className="btn-secondary" disabled={offset === 0 || query.isFetching} onClick={() => setOffsets(current => current.slice(0, -1))}>Previous</button>
      <button type="button" className="btn-secondary" disabled={query.isFetching || !page || page.nextOffset === null} onClick={() => { if (page?.nextOffset !== null && page?.nextOffset !== undefined) setOffsets(current => [...current, page.nextOffset!]) }}>Next</button>
    </nav>}
  </section>
}

/** Indexed display only. FUND and verified linked INCOME projects are separate scopes. */
export function ProjectParticipants({ chainId, projectId, tokenLabel = 'FUND' }: { chainId: number; projectId: string | number | bigint; tokenLabel?: string }) {
  const id = indexedParticipantProjectId(chainId, projectId)
  if (id === null) return <section className="contract-panel"><h2>{tokenLabel} holders</h2><p>This project identity is not supported by the index.</p></section>
  return <ParticipantsList key={`${chainId}:${id}:${tokenLabel}`} chainId={chainId} projectId={id} tokenLabel={tokenLabel} />
}
