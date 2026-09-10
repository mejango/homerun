'use client'

import type { JBChainId } from '@bananapus/nana-sdk-core'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { useId, useState, type KeyboardEvent } from 'react'
import { usePublicClient } from 'wagmi'
import type { PublicClient } from 'viem'
import { useWallet } from '@/hooks/useWallet'
import { explorerAddressUrl, explorerTokenUrl } from '@/lib/chainDisplay'
import { readProjectShop, readShopCustomers, shopTierAvailability, shopTierName, shopTierPrice, type ProjectShopState } from '@/lib/project-shop'

/** Uses the same canonical shop resolver as Juicebox and Revnet. */
export function ProjectShop({ chainId, projectId, tokenLabel = 'project' }: { chainId: JBChainId; projectId: bigint; tokenLabel?: string }) {
  const client = usePublicClient({ chainId }) as PublicClient | undefined
  const [tab, setTab] = useState<'inventory' | 'customers'>('inventory')
  const id = useId()
  const shop = useQuery({
    queryKey: ['project-shop', chainId, projectId.toString()], enabled: !!client,
    queryFn: () => readProjectShop(client!, { chainId, projectId }), staleTime: 30_000, retry: 1,
  })
  function onKey(event: KeyboardEvent<HTMLButtonElement>, next: 'inventory' | 'customers') {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const selected = event.key === 'Home' ? 'inventory' : event.key === 'End' ? 'customers' : next
    setTab(selected)
    document.getElementById(`${id}-${selected}`)?.focus()
  }
  return <section aria-label={`${tokenLabel} shop`} className="min-w-0">
    <div role="tablist" aria-label="Shop" className="mb-6 flex gap-6 border-b border-[#d7ddcf]">
      {(['inventory', 'customers'] as const).map(value => <button key={value} type="button" role="tab" id={`${id}-${value}`} aria-controls={`${id}-${value}-panel`} aria-selected={tab === value} tabIndex={tab === value ? 0 : -1} onClick={() => setTab(value)} onKeyDown={event => onKey(event, value === 'inventory' ? 'customers' : 'inventory')} className={`min-h-11 border-b-2 px-1 py-3 text-sm ${tab === value ? 'border-[#42664d] text-[#2d4035]' : 'border-transparent text-[#687562]'}`}>{value === 'inventory' ? 'Inventory' : 'Customers'}</button>)}
    </div>
    {shop.isPending && <p role="status" className="text-sm">Reading the project’s shop…</p>}
    {shop.isError && <div role="alert" className="text-sm"><p>The shop could not be verified. Inventory is unavailable until the reads recover.</p><button type="button" className="btn-secondary mt-4" onClick={() => void shop.refetch()}>Try again</button></div>}
    {!shop.isPending && !shop.isError && shop.data === null && <div className="rounded-md border border-[#d7ddcf] p-6"><h2 className="mb-3 text-3xl">No shop items yet</h2><p className="text-sm">This {tokenLabel === 'project' ? 'project' : `${tokenLabel} project`} has no NFT shop configured. {tokenLabel === 'FUND' ? 'The initial FUND raise accepts contributions without selling shop items.' : 'Items will appear here when a shop is configured.'}</p></div>}
    <div id={`${id}-inventory-panel`} role="tabpanel" aria-labelledby={`${id}-inventory`} hidden={tab !== 'inventory'}>
      {shop.data && !shop.isError && <Inventory shop={shop.data} />}
    </div>
    <div id={`${id}-customers-panel`} role="tabpanel" aria-labelledby={`${id}-customers`} hidden={tab !== 'customers'}>
      {shop.data && !shop.isError && tab === 'customers' && <Customers chainId={chainId} projectId={projectId} shop={shop.data} />}
    </div>
  </section>
}

function Inventory({ shop }: { shop: ProjectShopState }) {
  return <div>
    <div className="mb-6 flex flex-wrap items-start justify-between gap-4"><p className="max-w-lg text-sm">Shop prices and availability come from this project’s contracts. Choose items and complete checkout on Juicebox.</p><a className="btn-secondary" href={shop.checkoutUrl} target="_blank" rel="noreferrer">Open shop on Juicebox ↗</a></div>
    {shop.tiers.length === 0 ? <p className="text-sm">The shop is configured, but it has no items yet.</p> : <ul className="grid list-none gap-4 p-0 sm:grid-cols-2">
      {shop.tiers.map(tier => <li key={tier.id} className="min-w-0 rounded-md border border-[#d7ddcf] bg-[#fffefa] p-5"><p className="mb-2 text-xs text-[#687562]">Item #{tier.id}{tier.category ? ` | Category ${tier.category}` : ''}</p><h3 className="mb-4 break-words text-2xl">{shopTierName(tier)}</h3><p className="break-words text-lg">{shopTierPrice(tier, shop.pricing)}</p><p className="mt-2 text-sm text-[#687562]">{shopTierAvailability(tier)}</p>{tier.discountPercent > 0 && <p className="mt-2 text-sm">Includes {tier.discountPercent / 2}% discount</p>}</li>)}
    </ul>}
    {shop.truncated && <p className="mt-5 text-sm">Showing the first {shop.tiers.length} items. Open the full shop on Juicebox to browse all inventory.</p>}
    <p className="mt-5 text-xs text-[#687562]">Read at block {shop.blockNumber.toString()}. Checkout verifies the current price and stock.</p>
  </div>
}

function Customers({ chainId, projectId, shop }: { chainId: JBChainId; projectId: bigint; shop: ProjectShopState }) {
  const { address } = useWallet()
  const [scope, setScope] = useState<'all' | 'you'>('all')
  const owner = scope === 'you' ? address : undefined
  const items = useInfiniteQuery({
    queryKey: ['shop-customers', chainId, projectId.toString(), shop.hook, scope, owner ?? null],
    initialPageParam: 0, enabled: scope === 'all' || !!owner,
    queryFn: ({ pageParam }) => readShopCustomers({ chainId, projectId, hook: shop.hook, owner, offset: pageParam }),
    getNextPageParam: page => page.nextOffset ?? undefined, staleTime: 30_000, retry: 1,
  })
  const rows = items.data?.pages.flatMap(page => page.items) ?? []
  const skipped = items.data?.pages.some(page => page.skipped > 0)
  const tokenUrl = explorerTokenUrl(chainId, shop.hook)
  return <div>
    <div aria-label="Customer accounts" className="mb-5 flex gap-3">{(['all', 'you'] as const).map(value => <button key={value} type="button" aria-pressed={scope === value} onClick={() => setScope(value)} className={`min-h-11 rounded border px-4 text-sm ${scope === value ? 'border-[#42664d] bg-[#eef1e7]' : 'border-[#d7ddcf]'}`}>{value === 'all' ? 'All' : 'You'}</button>)}</div>
    <p className="mb-5 text-sm">Current item owners from indexed transfers. Recent purchases and transfers may take a moment to appear.</p>
    {scope === 'you' && !owner ? <p className="text-sm">Connect a wallet to see your shop items.</p> : <>
      {items.isPending && <p role="status" className="text-sm">Loading shop owners…</p>}
      {items.isError && <div role="alert" className="text-sm"><p>Shop owners could not be loaded.</p><button type="button" className="btn-secondary mt-3" onClick={() => void items.refetch()}>Try again</button></div>}
      {items.data && rows.length === 0 && <p className="text-sm">No items from this shop appear in the loaded records{scope === 'you' ? ' for your account' : ''}.</p>}
      {rows.length > 0 && <ul className="list-none divide-y divide-[#d7ddcf] p-0">{rows.map(row => <li key={`${row.hook.address}:${row.tokenId}`} className="flex flex-wrap items-center justify-between gap-3 py-4 text-sm"><div className="min-w-0"><p className="mb-1">Item #{row.tierId} | Token #{row.tokenId}</p><a className="break-all underline" href={explorerAddressUrl(chainId, row.owner) ?? undefined} target="_blank" rel="noreferrer">{row.owner}</a></div>{tokenUrl && <a className="shrink-0 underline" href={`${tokenUrl}?a=${row.tokenId}`} target="_blank" rel="noreferrer">View item ↗</a>}</li>)}</ul>}
      {skipped && <p className="mt-4 text-xs text-[#687562]">Records from other project collections and burned items are omitted.</p>}
      {items.hasNextPage && <button type="button" className="btn-secondary mt-5" disabled={items.isFetchingNextPage} onClick={() => void items.fetchNextPage()}>{items.isFetchingNextPage ? 'Loading…' : 'Load more items'}</button>}
    </>}
  </div>
}
