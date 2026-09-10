'use client'

import { useQuery } from '@tanstack/react-query'
import { useEffect, useId, useRef, useState } from 'react'
import {
  getProject,
  getProjectActivity,
  getProjectActivityByProject,
  type BsActivityEvent,
} from '@/lib/bendystraw'
import { displayChainName, displayChainSlug, explorerTxUrl } from '@/lib/chainDisplay'

const ACTIVITY_PAGE = 20
const ACTIVITY_POLL_MS = 15_000

/** Same newest-page/older-page merge as Juicebox Money's ActivityList. */
export function mergeActivityEvents<T extends BsActivityEvent>(current: T[], incoming: T[]): T[] {
  const incomingIds = new Set(incoming.map(event => event.id))
  return [...incoming, ...current.filter(event => !incomingIds.has(event.id))].sort(
    (a, b) => b.timestamp - a.timestamp || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
  )
}

function eventTitle(event: BsActivityEvent): string {
  if (event.payEvent) return 'Payment received'
  if (event.cashOutTokensEvent) return 'Tokens cashed out'
  if (event.addToBalanceEvent) return 'Funds added to the treasury'
  if (event.mintTokensEvent) return 'Project tokens minted'
  if (event.sendPayoutsEvent) return 'Treasury payout'
  if (event.sendPayoutToSplitEvent) return 'Payout sent to a recipient'
  if (event.sendReservedTokensToSplitsEvent) return 'Reserved tokens distributed'
  if (event.sendReservedTokensToSplitEvent) return 'Reserved tokens sent to a recipient'
  if (event.autoIssueEvent) return 'Scheduled tokens issued'
  if (event.borrowLoanEvent) return 'Loan opened'
  if (event.repayLoanEvent) return 'Loan repaid'
  if (event.liquidateLoanEvent) return 'Loan liquidated'
  if (event.mintNftEvent) return 'NFT minted'
  if (event.deployErc20Event) return 'ERC-20 token deployed'
  if (event.projectCreateEvent) return 'Project created'
  if (event.rulesetQueuedEvent) return 'Ruleset queued'
  if (event.setUriEvent) return 'Project details updated'
  if (event.projectTransferEvent) return 'Project ownership transferred'
  if (event.operatorPermissionsSetEvent) return 'Operator permissions updated'
  if (event.addNftTierEvent) return 'Shop item added'
  if (event.removeNftTierEvent) return 'Shop item removed'
  if (event.swapEvent) return 'Project tokens swapped'
  if (event.buybackPoolEvent) return 'Buyback pool configured'
  if (event.bridgeClaimEvent) return 'Bridged tokens claimed'
  return 'Project activity'
}

function EventRow({ event }: { event: BsActivityEvent }) {
  const txUrl = /^0x[\da-f]{64}$/i.test(event.txHash) ? explorerTxUrl(event.chainId, event.txHash) : null
  const timestamp = Number.isFinite(event.timestamp) ? new Date(event.timestamp * 1_000) : null
  const validDate = timestamp && Number.isFinite(timestamp.getTime()) ? timestamp : null
  return <li className="grid min-w-0 gap-3 border-b border-[#d5dccd] py-4 last:border-0">
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <span className="font-medium">{eventTitle(event)}</span>
      {validDate && <time className="text-sm" dateTime={validDate.toISOString()}>{validDate.toLocaleString()}</time>}
    </div>
    <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
      <span>{displayChainName(event.chainId)} / Project {event.projectId}</span>
      {txUrl ? <a href={txUrl} target="_blank" rel="noopener noreferrer" className="break-all underline underline-offset-4">View transaction ↗</a>
        : <span>Transaction link unavailable</span>}
    </div>
    <details className="min-w-0 text-sm">
      <summary className="cursor-pointer">Event details</summary>
      <pre className="mt-3 max-h-80 overflow-auto whitespace-pre-wrap break-all rounded border border-[#cbd7db] bg-[#edf2f4] p-3 text-xs">{JSON.stringify(event, null, 2)}</pre>
    </details>
  </li>
}

function ActivityFeed({ chainId, projectId, suckerGroupId }: { chainId: number; projectId: number; suckerGroupId: string | null }) {
  const heading = useId()
  const [events, setEvents] = useState<BsActivityEvent[]>([])
  const [total, setTotal] = useState(0)
  const [loadingMore, setLoadingMore] = useState(false)
  const [loadMoreError, setLoadMoreError] = useState(false)
  const loadLock = useRef(false)
  const mounted = useRef(true)
  const scope = suckerGroupId ?? 'single'
  const scopeRef = useRef(scope)
  const appliedScope = useRef(scope)
  scopeRef.current = scope
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const fetchPage = (offset = 0) => suckerGroupId
    ? getProjectActivity(suckerGroupId, ACTIVITY_PAGE, chainId, offset)
    : getProjectActivityByProject(chainId, projectId, ACTIVITY_PAGE, offset)
  const newest = useQuery({
    queryKey: ['project-activity', chainId, projectId, suckerGroupId],
    queryFn: () => fetchPage(),
    staleTime: 10_000,
    refetchInterval: ACTIVITY_POLL_MS,
    refetchIntervalInBackground: false,
    retry: 1,
  })
  const refresh = newest.refetch
  useEffect(() => {
    if (!newest.data) return
    // Keep the exact-project fallback until the linked feed succeeds. On a
    // scope change, its first page establishes the new pagination offset.
    if (appliedScope.current !== scope) {
      appliedScope.current = scope
      setEvents(newest.data.items)
    } else {
      // Refresh the newest page without discarding older loaded events.
      setEvents(current => mergeActivityEvents(current, newest.data.items))
    }
    setTotal(newest.data.totalCount)
  }, [newest.data, scope])
  // Match the reference's immediate refresh when a background tab becomes visible.
  useEffect(() => {
    const visible = () => { if (document.visibilityState === 'visible') void refresh() }
    document.addEventListener('visibilitychange', visible)
    return () => document.removeEventListener('visibilitychange', visible)
  }, [refresh])

  async function loadMore() {
    if (loadLock.current || !newest.data || appliedScope.current !== scope) return
    const requestScope = scope
    loadLock.current = true; setLoadingMore(true); setLoadMoreError(false)
    try {
      const page = await fetchPage(events.length)
      if (!mounted.current || scopeRef.current !== requestScope) return
      setEvents(current => mergeActivityEvents(current, page.items))
      setTotal(page.totalCount)
    } catch {
      if (mounted.current && scopeRef.current === requestScope) setLoadMoreError(true)
    } finally {
      loadLock.current = false
      if (mounted.current) setLoadingMore(false)
    }
  }

  return <section aria-labelledby={heading} className="contract-panel">
    <div className="flex flex-wrap items-baseline justify-between gap-3">
      <h2 id={heading}>Activity</h2>
      <button type="button" className="btn-secondary" disabled={newest.isFetching} onClick={() => void newest.refetch()}>{newest.isFetching ? 'Refreshing…' : 'Refresh activity'}</button>
    </div>
    <p className="my-4 text-sm">{suckerGroupId ? 'Activity across this project’s linked chains.' : 'Activity on this project’s network.'} Recent transactions can take time to appear in the index.</p>
    {newest.isPending && <p role="status">{events.length ? 'Loading linked-chain activity. Showing this project’s available history.' : 'Loading project activity…'}</p>}
    {newest.isError && <p role="status">{events.length ? 'Activity could not refresh. Showing the last indexed events.' : 'Activity is temporarily unavailable. Refresh to try again.'}</p>}
    {!newest.isPending && !newest.isError && events.length === 0 && <p>No activity indexed yet. A new project may still be catching up.</p>}
    {events.length > 0 && <ol className="m-0 grid min-w-0 list-none p-0">{events.map(event => <EventRow key={event.id} event={event} />)}</ol>}
    {loadMoreError && <p role="status" className="my-3 text-sm">Could not load more activity. Your loaded history is still available.</p>}
    {events.length < total && <button type="button" className="btn-secondary mt-4" disabled={loadingMore || !newest.data || appliedScope.current !== scope} onClick={() => void loadMore()}>{loadingMore ? 'Loading…' : 'Load more activity'}</button>}
  </section>
}

function ProjectActivitySource({ chainId, projectId }: { chainId: number; projectId: number }) {
  const project = useQuery({
    queryKey: ['indexed-project', chainId, projectId],
    queryFn: () => getProject(chainId, projectId),
    staleTime: 30_000,
    refetchInterval: 30_000,
    retry: 1,
  })
  const indexed = project.data
  const group = indexed?.version === 6 && indexed.chainId === chainId && indexed.projectId === projectId
    ? indexed.suckerGroupId : null
  // Discovery is best-effort. Never wait for a group row before reading this project's history.
  return <ActivityFeed chainId={chainId} projectId={projectId} suckerGroupId={group ?? null} />
}

/** Indexed display history only; it never authorizes or confirms a transaction. */
export function ProjectActivity({ chainId, projectId }: { chainId: number; projectId: string | number | bigint }) {
  const id = Number(projectId)
  if (!Number.isSafeInteger(id) || id <= 0 || !/^\d+$/.test(String(projectId)) || displayChainSlug(chainId) === null) {
    return <section className="contract-panel"><h2>Activity</h2><p>This project identity is not supported by the index.</p></section>
  }
  return <ProjectActivitySource key={`${chainId}:${id}`} chainId={chainId} projectId={id} />
}
