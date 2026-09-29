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
import { ChainIcon } from '@/components/ChainIcon'
import { SkeletonLines } from '@/components/ui/Skeleton'

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

/** Compact age, as Juicebox Money's feed shows it: "now", "5m ago", "3d ago". */
export function activityAge(seconds: number, now = Date.now() / 1_000): string {
  const elapsed = Math.max(0, now - seconds)
  if (elapsed < 60) return 'now'
  for (const [unit, size] of [['y', 31_536_000], ['mo', 2_592_000], ['d', 86_400], ['h', 3_600], ['m', 60]] as const) {
    if (elapsed >= size) return `${Math.floor(elapsed / size)}${unit} ago`
  }
  return 'now'
}

/** Events that say nothing chain-local, so one launch relayed to several chains reads as one row. */
const STRUCTURAL = ['projectCreateEvent', 'rulesetQueuedEvent', 'deployErc20Event', 'projectTransferEvent', 'setUriEvent', 'operatorPermissionsSetEvent'] as const
const CROSS_CHAIN_WINDOW = 6 * 3_600

type ActivityRow = { events: BsActivityEvent[]; chains: { chainId: number; txHash: string }[] }

/**
 * Juicebox Money's feed shape: one row per transaction, and one row for the same
 * structural transaction on several chains. Money events never merge across chains.
 */
export function groupActivity(events: BsActivityEvent[]): ActivityRow[] {
  const byTx = new Map<string, BsActivityEvent[]>()
  for (const event of events) {
    const key = `${event.chainId}:${event.projectId}:${event.txHash}`
    byTx.set(key, [...(byTx.get(key) ?? []), event])
  }
  const rows: (ActivityRow & { signature: string | null })[] = []
  for (const group of byTx.values()) {
    const lead = group[0]
    const structural = group.every(event => STRUCTURAL.some(key => event[key]))
    const signature = structural ? `${lead.from}|${group.map(eventTitle).sort().join('|')}` : null
    const host = signature && rows.find(row => row.signature === signature
      && Math.abs(row.events[0].timestamp - lead.timestamp) <= CROSS_CHAIN_WINDOW
      && !row.chains.some(chain => chain.chainId === lead.chainId))
    if (host) host.chains.push({ chainId: lead.chainId, txHash: lead.txHash })
    else rows.push({ events: group, chains: [{ chainId: lead.chainId, txHash: lead.txHash }], signature })
  }
  return rows.map(({ events, chains }) => ({ events, chains }))
}

function EventRow({ row }: { row: ActivityRow }) {
  const [lead] = row.events
  const titles = [...new Set(row.events.map(eventTitle))]
  const created = titles.indexOf('Project created')
  if (created > 0) titles.unshift(...titles.splice(created, 1))
  const [title, ...actions] = titles
  const txUrl = (chain: { chainId: number; txHash: string }) => /^0x[\da-f]{64}$/i.test(chain.txHash) ? explorerTxUrl(chain.chainId, chain.txHash) : null
  const valid = Number.isFinite(lead.timestamp) && Number.isFinite(new Date(lead.timestamp * 1_000).getTime())
  const when = valid ? new Date(lead.timestamp * 1_000).toLocaleString() : undefined
  const age = valid ? activityAge(lead.timestamp) : ''
  return <li data-event-id={lead.id} className="min-w-0"><div className="py-3.5">
    <div className="flex min-w-0 items-center justify-between gap-3">
      <span className="min-w-0 truncate text-sm text-ink">{title}</span>
      <span className="flex shrink-0 items-center gap-1.5 text-xs text-smoke-500">
        <span title={when} suppressHydrationWarning>{age}</span>
        {row.chains.map(chain => {
          const url = txUrl(chain)
          const mark = <ChainIcon chainId={chain.chainId} size={14} />
          return url
            ? <a key={chain.chainId} href={url} target="_blank" rel="noopener noreferrer" aria-label={`View transaction on ${displayChainName(chain.chainId)}`} className="no-underline opacity-90 hover:opacity-100">{mark}</a>
            : <span key={chain.chainId}>{mark}</span>
        })}
      </span>
    </div>
    {actions.length > 0 && <p className="mt-1 text-xs text-smoke-500">{actions.join(', ')}</p>}
  </div></li>
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

  return <section aria-labelledby={heading} className="demo-activity">
    <div className="demo-activity-heading"><h2 id={heading}>Activity</h2></div>
    {newest.isPending && !events.length && <div role="status" className="mt-4"><span className="sr-only">Loading activity</span><SkeletonLines lines={4} /></div>}
    {newest.isError && <p role="status" className="mt-3 text-sm text-smoke-500">{events.length ? 'Activity could not refresh. Showing the last indexed events.' : 'Activity is temporarily unavailable.'}</p>}
    {!newest.isPending && !newest.isError && events.length === 0 && <p className="mt-3 text-sm text-smoke-500">No activity yet. New transactions can take a minute to appear.</p>}
    {events.length > 0 && <ol className="min-w-0">{groupActivity(events).map(row => <EventRow key={row.events[0].id} row={row} />)}</ol>}
    {loadMoreError && <p role="status" className="mt-3 text-xs text-smoke-500">Could not load more activity.</p>}
    {events.length < total && <button type="button" className="mt-3 min-h-8 text-xs font-medium text-smoke-700 underline underline-offset-2 hover:text-ink disabled:opacity-60" disabled={loadingMore || !newest.data || appliedScope.current !== scope} onClick={() => void loadMore()}>{loadingMore ? 'Loading…' : 'Load more'}</button>}
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
    return <section className="demo-activity"><div className="demo-activity-heading"><h2>Activity</h2></div><p>This project identity is not supported by the index.</p></section>
  }
  return <ProjectActivitySource key={`${chainId}:${id}`} chainId={chainId} projectId={id} />
}
