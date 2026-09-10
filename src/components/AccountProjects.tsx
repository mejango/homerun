'use client'

import { useQuery } from '@tanstack/react-query'
import Link from 'next/link'
import { useEffect, useId, useState, type ReactNode } from 'react'
import { formatUnits, isAddress } from 'viem'
import { WalletButton } from '@/components/WalletButton'
import { useWallet } from '@/hooks/useWallet'
import {
  getAccountTokenHoldings,
  getProjectsByRefs,
  getProjectsOwnedBy,
  searchProjects,
  type BsAccountTokenHolding,
  type BsProject,
} from '@/lib/bendystraw'
import { displayChainName, displayChainSlug } from '@/lib/chainDisplay'

type Network = 'mainnet' | 'testnet'
const PAGE_SIZE = 24
const INDEX_QUERY = { staleTime: 30_000, refetchInterval: 60_000, retry: 1 } as const

function refKey(ref: { chainId: number; projectId: number }) {
  return `${ref.chainId}:${ref.projectId}`
}

function validRef(ref: { chainId: number; projectId: number }) {
  return Number.isSafeInteger(ref.projectId) && ref.projectId > 0 && displayChainSlug(ref.chainId) !== null
}

function projectRows(projects: BsProject[] | undefined) {
  const seen = new Set<string>()
  return (projects ?? []).filter(project => {
    if (project.version !== 6 || !validRef(project) || seen.has(refKey(project))) return false
    seen.add(refKey(project))
    return true
  })
}

function tokenBalance(value: string): bigint {
  try { return /^\d+$/.test(value) ? BigInt(value) : 0n } catch { return 0n }
}

function ProjectRow({ project, holding }: { project?: BsProject; holding?: BsAccountTokenHolding }) {
  const ref = project ?? holding!
  const name = project?.name?.trim() || `Project ${ref.projectId}`
  // An unresolved type must not silently route an INCOME holder to a FUND page.
  const href = project?.isRevnet === true ? `/income/${ref.chainId}/${ref.projectId}`
    : project?.isRevnet === false ? `/project/${ref.chainId}/${ref.projectId}` : null
  return <li className="grid min-w-0 gap-2 rounded-md border border-[#c4cdbb] bg-[#fffefa] p-4">
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      {href ? <Link href={href} prefetch={false} className="min-w-0 break-words text-lg underline underline-offset-4">{name}</Link>
        : <span className="min-w-0 break-words text-lg">{name}</span>}
      {project?.isRevnet !== null && project?.isRevnet !== undefined && <span className="text-xs">{project.isRevnet ? 'INCOME / Revnet' : 'Juicebox project'}</span>}
    </div>
    <p className="text-sm">{displayChainName(ref.chainId)} / Project {ref.projectId}</p>
    {project?.projectTagline && <p className="break-words text-sm">{project.projectTagline}</p>}
    {holding && <div className="grid gap-1 text-sm">
      {/* tokenSymbol is the project's payment currency in Bendystraw, not its owned token's ticker. */}
      <span className="break-words">{formatUnits(tokenBalance(holding.balance), 18)} project tokens</span>
      <span className="break-words">{formatUnits(tokenBalance(holding.creditBalance), 18)} credits / {formatUnits(tokenBalance(holding.erc20Balance), 18)} ERC-20</span>
    </div>}
    {!href && <p className="text-sm">Project details are still being indexed. Refresh to open its page.</p>}
  </li>
}

function QueryNotice({ failed, hasData, loading, noun, refresh }: {
  failed: boolean; hasData: boolean; loading: boolean; noun: string; refresh: () => void
}) {
  if (failed) return <div role="status" className="grid justify-items-start gap-2 text-sm">
    <p>{hasData ? `Could not refresh ${noun}. Showing the last indexed data.` : `Could not load ${noun} from the index.`}</p>
    <button type="button" className="btn-secondary" onClick={refresh}>Retry {noun}</button>
  </div>
  return loading && !hasData ? <p role="status" className="text-sm">Loading {noun}…</p> : null
}

function ProjectSection({ title, children }: { title: string; children: ReactNode }) {
  const headingId = useId()
  return <section aria-labelledby={headingId} className="grid min-w-0 content-start gap-4">
    <h3 id={headingId}>{title}</h3>
    {children}
  </section>
}

function WalletProjects({ account, network }: { account: string; network: Network }) {
  const [ownedLimit, setOwnedLimit] = useState(PAGE_SIZE)
  const [heldLimit, setHeldLimit] = useState(PAGE_SIZE)
  const owned = useQuery({
    ...INDEX_QUERY,
    queryKey: ['account-projects', 'owned', network, account],
    queryFn: () => getProjectsOwnedBy([account], { network }),
  })
  const holdings = useQuery({
    ...INDEX_QUERY,
    queryKey: ['account-projects', 'holdings', network, account],
    queryFn: () => getAccountTokenHoldings(account, { network }),
  })
  const heldRows = (holdings.data?.items ?? []).filter(row => validRef(row) && tokenBalance(row.balance) > 0n)
  const refs = heldRows.map(row => ({ chainId: row.chainId, projectId: row.projectId, version: 6 }))
  const heldProjects = useQuery({
    ...INDEX_QUERY,
    queryKey: ['account-projects', 'holding-details', network, account, refs],
    queryFn: () => getProjectsByRefs(refs, { network }),
    enabled: refs.length > 0,
  })
  // Index ownership is only discovery. Action permissions are read from contracts on the project page.
  const ownedRows = projectRows(owned.data).filter(project => project.owner?.toLowerCase() === account)
  const byRef = new Map(projectRows(heldProjects.data).map(project => [refKey(project), project]))
  return <div className="grid min-w-0 gap-7 lg:grid-cols-2">
    <ProjectSection title="Owned by this account">
      <QueryNotice failed={owned.isError} hasData={owned.data !== undefined} loading={owned.isPending} noun="owned projects" refresh={() => void owned.refetch()} />
      {owned.data !== undefined && !ownedRows.length && <p className="text-sm">No owned projects indexed for this account on {network}.</p>}
      {ownedRows.length > 0 && <ul className="m-0 grid list-none gap-3 p-0">{ownedRows.slice(0, ownedLimit).map(project => <ProjectRow key={refKey(project)} project={project} />)}</ul>}
      {ownedRows.length > ownedLimit && <button type="button" className="btn-secondary" onClick={() => setOwnedLimit(value => value + PAGE_SIZE)}>Show more owned projects</button>}
    </ProjectSection>
    <ProjectSection title="Token holdings">
      <QueryNotice failed={holdings.isError} hasData={holdings.data !== undefined} loading={holdings.isPending} noun="token holdings" refresh={() => void holdings.refetch()} />
      {holdings.data !== undefined && !heldRows.length && <p className="text-sm">No token holdings indexed for this account on {network}.</p>}
      {heldRows.length > 0 && <>
        <QueryNotice failed={heldProjects.isError} hasData={heldProjects.data !== undefined} loading={heldProjects.isPending} noun="holding details" refresh={() => void heldProjects.refetch()} />
        <ul className="m-0 grid list-none gap-3 p-0">{heldRows.slice(0, heldLimit).map(holding => <ProjectRow key={refKey(holding)} holding={holding} project={byRef.get(refKey(holding))} />)}</ul>
        {heldRows.length > heldLimit && <button type="button" className="btn-secondary" onClick={() => setHeldLimit(value => value + PAGE_SIZE)}>Show more token holdings</button>}
        {(holdings.data?.totalCount ?? 0) > heldRows.length && <p className="text-sm">Showing {heldRows.length} of {holdings.data?.totalCount} indexed holdings.</p>}
      </>}
    </ProjectSection>
  </div>
}

function ProjectSearch({ network }: { network: Network }) {
  const [text, setText] = useState('')
  const [debouncedText, setDebouncedText] = useState('')
  const inputId = useId()
  const normalized = text.trim()
  useEffect(() => {
    const timeout = setTimeout(() => setDebouncedText(normalized), 300)
    return () => clearTimeout(timeout)
  }, [normalized])
  const ready = debouncedText.length >= 2 || /^\d$/.test(debouncedText)
  const current = normalized === debouncedText
  const search = useQuery({
    queryKey: ['account-projects', 'search', network, debouncedText],
    queryFn: () => searchProjects(debouncedText, PAGE_SIZE, { network }),
    enabled: ready,
    staleTime: 30_000,
    retry: 1,
  })
  const rows = projectRows(search.data).slice(0, PAGE_SIZE)
  return <ProjectSection title="Find a project">
    <div className="grid gap-2">
      <label htmlFor={inputId}>Project name, token ticker, or ID</label>
      <input id={inputId} type="search" autoComplete="off" maxLength={120} value={text} onChange={event => setText(event.target.value)} placeholder="Search Juicebox projects and revnets" />
    </div>
    {normalized && !ready && current && <p className="text-sm">Enter at least two characters or a project ID.</p>}
    {!current && <p role="status" className="text-sm">Waiting to search…</p>}
    {current && ready && <>
      <QueryNotice failed={search.isError} hasData={search.data !== undefined} loading={search.isPending} noun="search results" refresh={() => void search.refetch()} />
      {search.data !== undefined && !rows.length && <p className="text-sm">No matching projects indexed on {network}.</p>}
      {rows.length > 0 && <ul className="m-0 grid list-none gap-3 p-0 sm:grid-cols-2">{rows.map(project => <ProjectRow key={refKey(project)} project={project} />)}</ul>}
      {rows.length === PAGE_SIZE && <p className="text-sm">Showing up to {PAGE_SIZE} matches. Refine your search to find a specific project.</p>}
    </>}
  </ProjectSection>
}

/** V6 discovery only; every linked page independently verifies balances and transaction permissions. */
export function AccountProjects({ account, initialNetwork = 'mainnet' }: { account?: string | null; initialNetwork?: Network }) {
  const wallet = useWallet()
  const [network, setNetwork] = useState<Network>(initialNetwork)
  const networkId = useId()
  const suppliedAccount = account === undefined ? wallet.isConnected ? wallet.address : null : account
  const normalizedAccount = suppliedAccount && isAddress(suppliedAccount.trim(), { strict: false }) ? suppliedAccount.trim().toLowerCase() : null
  return <section aria-label="Project discovery" className="contract-panel">
    <div className="grid gap-7">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="grid min-w-0 gap-3">
          <h2>Your projects</h2>
          {normalizedAccount && <p className="break-all text-sm">{normalizedAccount}</p>}
        </div>
        <div>
          <label htmlFor={networkId}>Network</label>
          <select id={networkId} value={network} onChange={event => setNetwork(event.target.value as Network)}>
            <option value="mainnet">Mainnet</option><option value="testnet">Testnet</option>
          </select>
        </div>
      </div>
      <p className="text-sm">Indexed Juicebox V6 projects and revnets. New projects, balances, and ownership changes can take time to appear. Project pages verify the current contracts before transactions.</p>
      {normalizedAccount ? <WalletProjects key={`${network}:${normalizedAccount}`} account={normalizedAccount} network={network} />
        : suppliedAccount ? <p role="status">This account address is invalid.</p>
          : <div className="grid justify-items-start gap-3"><p>Connect your wallet to find projects you own and tokens you hold.</p><WalletButton /></div>}
      <ProjectSearch key={network} network={network} />
    </div>
  </section>
}
