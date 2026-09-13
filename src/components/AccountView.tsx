'use client'

import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import { isAddress, type Address } from 'viem'
import { AccountProjectSections } from '@/components/AccountProjects'
import { useAccountIdentity } from '@/hooks/useAccountIdentity'
import { useWallet } from '@/hooks/useWallet'
import {
  getAccountActivity,
  getAccountNfts,
  getOperatorGrants,
  getProjectsByRefs,
  type BsAccountActivityEvent,
  type BsAccountNft,
  type BsActivityEvent,
  type BsProject,
} from '@/lib/bendystraw'
import { displayChainName, displayChainSlug, explorerAddressUrl, explorerTxUrl } from '@/lib/chainDisplay'
import styles from './AccountView.module.css'

type Network = 'mainnet' | 'testnet'
const TABS = ['Activity', 'Holdings', 'Projects'] as const
type Tab = typeof TABS[number]
const NETWORK_CHAINS = { mainnet: [1, 10, 8453, 42161], testnet: [11155111, 11155420, 84532, 421614] }
const INDEX_QUERY = { staleTime: 30_000, refetchInterval: 60_000, retry: 1 } as const
const PAGE_SIZE = 25
const ACTIVITY_LABELS: Partial<Record<keyof BsActivityEvent, string>> = {
  payEvent: 'Payment', cashOutTokensEvent: 'Tokens cashed out', addToBalanceEvent: 'Treasury funded',
  mintTokensEvent: 'Project tokens issued', sendPayoutsEvent: 'Treasury payout', sendPayoutToSplitEvent: 'Payout',
  sendReservedTokensToSplitsEvent: 'Reserved tokens distributed', sendReservedTokensToSplitEvent: 'Reserved tokens sent',
  autoIssueEvent: 'Scheduled tokens issued', borrowLoanEvent: 'Loan opened', repayLoanEvent: 'Loan repaid',
  liquidateLoanEvent: 'Loan liquidated', mintNftEvent: 'Store item minted', deployErc20Event: 'Token deployed',
  projectCreateEvent: 'Project created', rulesetQueuedEvent: 'Ruleset queued', setUriEvent: 'Project details updated',
  projectTransferEvent: 'Project ownership transferred', operatorPermissionsSetEvent: 'Permissions updated',
  addNftTierEvent: 'Store item added', removeNftTierEvent: 'Store item removed', swapEvent: 'Tokens swapped',
  buybackPoolEvent: 'Buyback pool configured', bridgeClaimEvent: 'Bridged tokens claimed',
}

function projectKey(ref: { chainId: number; projectId: number }) { return `${ref.chainId}:${ref.projectId}` }
function activityKey(event: BsAccountActivityEvent) { return `${event.chainId}:${event.version}:${event.id}` }
function validProject(ref: { chainId: number; projectId: number }) {
  return Number.isSafeInteger(ref.projectId) && ref.projectId > 0 && displayChainSlug(ref.chainId) !== null
}
function projectHref(ref: { chainId: number; projectId: number }, isRevnet?: boolean | null) {
  if (!validProject(ref) || typeof isRevnet !== 'boolean') return null
  return `/${isRevnet ? 'income' : 'project'}/${ref.chainId}/${ref.projectId}`
}
function shortAddress(address: string) { return `${address.slice(0, 6)}…${address.slice(-4)}` }

function QueryNotice({ failed, hasData, loading, noun, retry }: {
  failed: boolean; hasData: boolean; loading: boolean; noun: string; retry: () => void
}) {
  if (failed) return <div role="status" className={styles.notice}>
    <p>{hasData ? `Could not refresh ${noun}. Showing the last available data.` : `Could not load ${noun}.`}</p>
    <button type="button" className={styles.action} onClick={retry}>Retry {noun}</button>
  </div>
  return loading && !hasData ? <p role="status" className={styles.muted}>Loading {noun}…</p> : null
}

function AccountActivityRow({ event }: { event: BsAccountActivityEvent }) {
  const label = Object.entries(ACTIVITY_LABELS).find(([key]) => event[key as keyof BsActivityEvent])?.[1] ?? 'Project activity'
  const href = projectHref(event, event.project?.isRevnet)
  const txUrl = /^0x[\da-f]{64}$/i.test(event.txHash) ? explorerTxUrl(event.chainId, event.txHash) : null
  const date = new Date(event.timestamp * 1_000)
  const memo = event.payEvent?.memo || event.addToBalanceEvent?.memo
  return <li className={styles.card}>
    <div className={styles.row}>
      <strong>{label}</strong>
      {Number.isFinite(date.getTime()) && <time className={styles.date} dateTime={date.toISOString()}>{date.toLocaleString()}</time>}
    </div>
    <div className={styles.row}>
      {href ? <Link href={href} prefetch={false} className={styles.link}>{event.project?.name?.trim() || `Project ${event.projectId}`}</Link>
        : <span>{event.project?.name?.trim() || `Project ${event.projectId}`}</span>}
      <span className={styles.muted}>{displayChainName(event.chainId)}</span>
    </div>
    {memo && <p className={styles.memo}>{memo}</p>}
    {txUrl && <a href={txUrl} target="_blank" rel="noopener noreferrer" className={`${styles.link} ${styles.muted}`}>View transaction ↗</a>}
  </li>
}

function AccountActivity({ account, network }: { account: string; network: Network }) {
  const activity = useInfiniteQuery({
    ...INDEX_QUERY,
    queryKey: ['account-view', 'activity', network, account],
    initialPageParam: 0,
    queryFn: ({ pageParam }) => getAccountActivity(account, { network, limit: PAGE_SIZE, offset: pageParam }),
    getNextPageParam: (last, pages) => {
      const loaded = pages.reduce((count, page) => count + page.items.length, 0)
      return last.items.length > 0 && loaded < last.totalCount ? loaded : undefined
    },
  })
  const events = [...new Map((activity.data?.pages.flatMap(page => page.items) ?? []).map(event => [activityKey(event), event])).values()]
  return <section className={styles.section} aria-label="Account activity">
    <div className={styles.sectionHeader}>
      <h2>Activity</h2>
      <button type="button" className={styles.action} disabled={activity.isFetching} onClick={() => void activity.refetch()}>{activity.isRefetching ? 'Refreshing…' : 'Refresh'}</button>
    </div>
    <QueryNotice failed={activity.isError} hasData={activity.data !== undefined} loading={activity.isPending} noun="activity" retry={() => void activity.refetch()} />
    {activity.isSuccess && !events.length && <p className={styles.empty}>No account activity on {network} yet.</p>}
    {events.length > 0 && <ol className={styles.list}>{events.map(event => <AccountActivityRow key={activityKey(event)} event={event} />)}</ol>}
    {activity.hasNextPage && <div><button type="button" className={styles.action} disabled={activity.isFetching} onClick={() => void activity.fetchNextPage()}>{activity.isFetchingNextPage ? 'Loading…' : 'Load more activity'}</button></div>}
  </section>
}

function itemName(item: BsAccountNft): string {
  let metadata = item.tier?.metadata
  if (!metadata && item.tier?.resolvedUri && item.tier.resolvedUri.length <= 100_000) {
    try {
      const uri = item.tier.resolvedUri
      const json = uri.startsWith('data:application/json,') ? decodeURIComponent(uri.slice(22))
        : uri.startsWith('data:application/json;base64,') ? atob(uri.slice(29)) : uri.startsWith('{') ? uri : null
      if (json) metadata = JSON.parse(json)
    } catch { /* Display an item number when indexed metadata is unavailable. */ }
  }
  const name = metadata?.name
  return typeof name === 'string' && name.trim() ? name.trim().slice(0, 160) : `Item #${item.tierId}`
}

function AccountStoreItems({ account, network }: { account: string; network: Network }) {
  const [limit, setLimit] = useState(PAGE_SIZE)
  const holdings = useQuery({
    ...INDEX_QUERY,
    queryKey: ['account-view', 'store-items', network, account],
    queryFn: () => getAccountNfts(account, { network }),
  })
  const rows = (holdings.data?.items ?? []).filter(validProject)
  const refs = [...new Map(rows.map(row => [projectKey(row), { chainId: row.chainId, projectId: row.projectId, version: 6 }])).values()]
  const projects = useQuery({
    ...INDEX_QUERY,
    queryKey: ['account-view', 'store-projects', network, account, refs],
    queryFn: () => getProjectsByRefs(refs, { network }),
    enabled: refs.length > 0,
  })
  const byRef = new Map((projects.data ?? []).filter(project => project.version === 6).map(project => [projectKey(project), project]))
  // Item numbers restart with each store contract; keep replaced stores distinct.
  const groups = new Map<string, { item: BsAccountNft; count: number }>()
  for (const item of rows) {
    const key = `${projectKey(item)}:${item.hook?.address.toLowerCase() ?? 'unknown'}:${item.tierId}`
    const group = groups.get(key)
    if (group) group.count += 1
    else groups.set(key, { item, count: 1 })
  }
  return <section className={styles.section} aria-label="Store items">
    <h3>Store items</h3>
    <QueryNotice failed={holdings.isError} hasData={holdings.data !== undefined} loading={holdings.isPending} noun="store items" retry={() => void holdings.refetch()} />
    {holdings.isSuccess && !rows.length && <p className={styles.empty}>No store items held on {network}.</p>}
    {rows.length > 0 && <>
      <QueryNotice failed={projects.isError} hasData={projects.data !== undefined} loading={projects.isPending} noun="store details" retry={() => void projects.refetch()} />
      <ul className={styles.list}>{[...groups].slice(0, limit).map(([key, { item, count }]) => {
        const project = byRef.get(projectKey(item))
        const href = projectHref(item, project?.isRevnet)
        return <li key={key} className={styles.card}>
          <div className={styles.row}><strong>{itemName(item)}</strong><span>{count} owned</span></div>
          <div className={styles.row}>
            {href ? <Link className={styles.link} href={`${href}#shop`} prefetch={false}>{project?.name?.trim() || `Project ${item.projectId}`}</Link>
              : <span>{project?.name?.trim() || `Project ${item.projectId}`}</span>}
            <span className={styles.muted}>{displayChainName(item.chainId)}</span>
          </div>
        </li>
      })}</ul>
      {groups.size > limit && <div><button type="button" className={styles.action} onClick={() => setLimit(value => value + PAGE_SIZE)}>Show more store items</button></div>}
      {(holdings.data?.totalCount ?? 0) > rows.length && <p className={styles.muted}>Showing {rows.length} of {holdings.data?.totalCount} indexed store items.</p>}
    </>}
  </section>
}

function AccountDelegatedProjects({ account, network }: { account: string; network: Network }) {
  const grants = useQuery({
    ...INDEX_QUERY,
    queryKey: ['account-view', 'grants', network, account],
    queryFn: () => getOperatorGrants(account, { network }),
  })
  const rows = (grants.data ?? []).filter(grant => grant.version === 6 && grant.operator.toLowerCase() === account && grant.permissions.length > 0)
  const refs = [...new Map(rows.filter(validProject).map(row => [projectKey(row), { chainId: row.chainId, projectId: row.projectId, version: 6 }])).values()]
  const projects = useQuery({
    ...INDEX_QUERY,
    queryKey: ['account-view', 'delegated-projects', network, account, refs],
    queryFn: () => getProjectsByRefs(refs, { network }),
    enabled: refs.length > 0,
  })
  const byRef = new Map((projects.data ?? []).filter(project => project.version === 6).map(project => [projectKey(project), project]))
  return <section className={styles.section} aria-label="Delegated access">
    <h3>Delegated access</h3>
    <QueryNotice failed={grants.isError} hasData={grants.data !== undefined} loading={grants.isPending} noun="delegated access" retry={() => void grants.refetch()} />
    {grants.isSuccess && !rows.length && <p className={styles.empty}>No delegated project access on {network}.</p>}
    {rows.length > 0 && <>
      <QueryNotice failed={projects.isError && refs.length > 0} hasData={projects.data !== undefined} loading={projects.isPending && refs.length > 0} noun="project details" retry={() => void projects.refetch()} />
      <ul className={styles.list}>{rows.map(grant => {
        const project: BsProject | undefined = byRef.get(projectKey(grant))
        const href = projectHref(grant, project?.isRevnet)
        const title = grant.projectId === 0 ? 'All projects' : project?.name?.trim() || `Project ${grant.projectId}`
        return <li key={`${projectKey(grant)}:${grant.account}`} className={styles.card}>
          <div className={styles.row}>{href ? <Link href={href} prefetch={false} className={styles.link}>{title}</Link> : <strong>{title}</strong>}<span className={styles.muted}>{displayChainName(grant.chainId)}</span></div>
          <p className={styles.muted}>Access granted by {isAddress(grant.account, { strict: false }) ? <Link href={`/account/${grant.account}${network === 'testnet' ? '?network=testnet' : ''}#projects`} prefetch={false} className={styles.link}>{shortAddress(grant.account)}</Link> : grant.account}</p>
          <p className={styles.muted}>{grant.isRevnetOperator ? 'Revnet operator / ' : ''}{grant.permissions.length} {grant.permissions.length === 1 ? 'permission' : 'permissions'}</p>
        </li>
      })}</ul>
    </>}
  </section>
}

/** Public, read-only account overview. The connected wallet never changes whose data is shown. */
export function AccountView({ address, initialNetwork = 'mainnet' }: { address: Address; initialNetwork?: Network }) {
  const wallet = useWallet()
  const identity = useAccountIdentity(address)
  const searchParams = useSearchParams()
  const account = address.toLowerCase()
  const isSelf = wallet.isConnected && wallet.address?.toLowerCase() === account
  const network: Network = searchParams ? searchParams.get('network') === 'testnet' ? 'testnet' : 'mainnet' : initialNetwork
  const [tab, setTab] = useState<Tab>('Activity')
  const [copyStatus, setCopyStatus] = useState<{ address: string; text: string } | null>(null)
  const id = useId()
  const tabButtons = useRef<(HTMLButtonElement | null)[]>([])
  useEffect(() => {
    const sync = () => setTab(TABS.find(value => `#${value.toLowerCase()}` === window.location.hash) ?? 'Activity')
    sync()
    window.addEventListener('hashchange', sync)
    window.addEventListener('popstate', sync)
    return () => {
      window.removeEventListener('hashchange', sync)
      window.removeEventListener('popstate', sync)
    }
  }, [address, searchParams])

  function selectTab(value: Tab) {
    setTab(value)
    // Let Next preserve its own history fields and publish the new URL to navigation hooks.
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}#${value.toLowerCase()}`)
  }
  function onTabKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const next = event.key === 'ArrowRight' ? (index + 1) % TABS.length
      : event.key === 'ArrowLeft' ? (index + TABS.length - 1) % TABS.length
        : event.key === 'Home' ? 0 : event.key === 'End' ? TABS.length - 1 : null
    if (next === null) return
    event.preventDefault()
    selectTab(TABS[next])
    tabButtons.current[next]?.focus()
  }
  async function copyAddress() {
    try { await navigator.clipboard.writeText(address); setCopyStatus({ address, text: 'Address copied.' }) }
    catch { setCopyStatus({ address, text: 'Could not copy. Select the address above to copy it.' }) }
  }

  return <div className={styles.account}>
    <div className={styles.header}>
      <div className={styles.identity}>
        <span aria-hidden="true" className={styles.avatar} style={{ background: `linear-gradient(135deg, #${account.slice(2, 8)}, #${account.slice(-6)})` }} />
        <div className={styles.identityText}>
          <h1>{identity.name || (isSelf ? 'Your account' : identity.label)}</h1>
          <p className={styles.address}>{address}</p>
          {isSelf && <span className={styles.self}>Signed in to this account</span>}
        </div>
      </div>
      <div className={styles.actions}>
        <button type="button" className={styles.action} onClick={() => void copyAddress()}>Copy address</button>
        <details className={styles.explorers}>
          <summary className={styles.action}>View on explorer</summary>
          <div className={styles.explorerLinks}>{NETWORK_CHAINS[network].map(chainId => <a key={chainId} href={explorerAddressUrl(chainId, address)!} target="_blank" rel="noopener noreferrer">{displayChainName(chainId)} ↗</a>)}</div>
        </details>
        <span role="status" className={styles.copyStatus}>{copyStatus?.address === address ? copyStatus.text : ''}</span>
      </div>
    </div>
    <div className={styles.toolbar}>
      <div role="tablist" aria-label="Account sections" className={styles.tabs}>{TABS.map((value, index) => <button
        key={value} ref={node => { tabButtons.current[index] = node }} type="button" role="tab" className={styles.tab}
        id={`${id}-${value}`} aria-controls={`${id}-${value}-panel`} aria-selected={tab === value} tabIndex={tab === value ? 0 : -1}
        onClick={() => selectTab(value)} onKeyDown={event => onTabKeyDown(event, index)}
      >{value}</button>)}</div>
      <label className={styles.network}>Network<select aria-label="Account network" value={network} onChange={event => {
        const selected = event.target.value as Network
        const url = new URL(window.location.href)
        if (selected === 'testnet') url.searchParams.set('network', 'testnet')
        else url.searchParams.delete('network')
        window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`)
      }}><option value="mainnet">Mainnet</option><option value="testnet">Testnet</option></select></label>
    </div>
    {TABS.map(value => <div key={value} role="tabpanel" id={`${id}-${value}-panel`} aria-labelledby={`${id}-${value}`} hidden={tab !== value} className={styles.panel} tabIndex={0}>
      {tab === value && (value === 'Activity' ? <AccountActivity key={`${network}:${account}`} account={account} network={network} />
        : value === 'Holdings' ? <><section className={styles.section}><AccountProjectSections key={`tokens:${network}:${account}`} account={account} network={network} section="holdings" /></section><AccountStoreItems key={`store:${network}:${account}`} account={account} network={network} /></>
          : <><section className={styles.section}><AccountProjectSections key={`owned:${network}:${account}`} account={account} network={network} section="projects" /></section><AccountDelegatedProjects key={`grants:${network}:${account}`} account={account} network={network} /><div><Link href="/projects" className={styles.link}>Find a project ↗</Link></div></>)}
    </div>)}
    <p className={styles.footnote}>Juicebox V6 and Revnet activity across {network === 'mainnet' ? 'Ethereum, Optimism, Base, and Arbitrum' : 'supported test networks'}. Recent transactions and balances may take a moment to appear.</p>
  </div>
}
