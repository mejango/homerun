'use client'

import Image from 'next/image'
import type { ReactNode } from 'react'
import { displayChainName } from '@/lib/chainDisplay'

export type IntentProjectDisplay = {
  name: string
  location?: string | null
  logoUrl?: string | null
  coverUrl?: string | null
  description?: string | null
  detailsUnavailable?: boolean
  owner: string
  ownerProfile?: { name?: string | null; introduction?: string | null; photoUrl?: string | null }
  chainIds: readonly number[]
  tokenName: string
  ticker: string
  mustStartAtOrAfter: number
  status: string
  multisigs?: string
}

/** Everything here comes from signed calls or saved setup values; no chain is read. */
export function IntentProjectView({ display, banner, actions }: {
  display: IntentProjectDisplay
  banner?: ReactNode
  actions?: ReactNode
}) {
  const { name } = display
  return <div className="grid gap-7">
    {banner}
    <section className="grid gap-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="grid min-w-0 gap-2">
          <h1 className="text-5xl sm:text-6xl">{name}</h1>
          {display.location && <p className="text-sm">{display.location}</p>}
        </div>
        {display.logoUrl && <Image unoptimized src={display.logoUrl} width={112} height={112} alt={`${name} logo`} />}
      </div>
      <ul className="m-0 flex list-none flex-wrap gap-4 p-0 text-sm">
        <li>Status: {display.status}</li>
        <li>Networks: {display.chainIds.map(displayChainName).join(', ')}</li>
        <li>FUND token: {display.tokenName} ({display.ticker})</li>
        <li>Contributions open: {display.mustStartAtOrAfter * 1000 > Date.now() ? new Date(display.mustStartAtOrAfter * 1000).toLocaleString() : 'as soon as it is created'}</li>
      </ul>
      <p className="break-all text-sm">Owner: {display.owner}</p>
    </section>

    {actions}

    {display.multisigs && <section className="rounded-md border border-[#c4cdbb] bg-[#fffefa] p-5 sm:p-7">
      <h2 className="mb-5 text-3xl">Multisigs</h2>
      <p>Juicebox Center’s sponsor creates these Safes on {display.chainIds.map(displayChainName).join(', ')} along with the project. Each address is fixed by its owners, its approval policy and its salt, so the project is theirs whether the Safe exists yet or not.</p>
      <p className="mt-5 whitespace-pre-line break-all text-sm">{display.multisigs}</p>
    </section>}

    <section className="rounded-md border border-[#c4cdbb] bg-[#fffefa] p-5 sm:p-7">
      <h2 className="mb-5 text-3xl">About</h2>
      {display.detailsUnavailable && <p className="mb-5 text-sm">The project details could not be loaded. The terms above are read from the signed project creation.</p>}
      <p className="whitespace-pre-line">{display.description ?? 'Fund an asset with a FUND Juicebox created on first use.'}</p>
      {display.coverUrl && <Image unoptimized src={display.coverUrl} width={1200} height={675} alt={`${name} cover`} className="mt-5 max-h-[480px] w-full rounded-md object-cover" />}
      {display.ownerProfile && <div className="mt-7 grid gap-2">
        <h3 className="text-2xl">Owner</h3>
        {display.ownerProfile.photoUrl && <Image unoptimized src={display.ownerProfile.photoUrl} width={96} height={96} alt={display.ownerProfile.name ? `${display.ownerProfile.name} picture` : 'Owner picture'} />}
        {display.ownerProfile.name && <p>{display.ownerProfile.name}</p>}
        {display.ownerProfile.introduction && <p className="whitespace-pre-line text-sm">{display.ownerProfile.introduction}</p>}
      </div>}
    </section>
  </div>
}
