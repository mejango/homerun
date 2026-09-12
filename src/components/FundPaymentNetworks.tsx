'use client'

import { useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { JBChainId } from '@bananapus/nana-sdk-core'
import { createPublicClient, type PublicClient } from 'viem'
import { usePublicClient } from 'wagmi'
import { readFundPayNetworks } from '@/lib/fund-pay-networks'
import type { FundProjectState } from '@/lib/fund-state'
import { jbCenterRpcTransport } from '@/lib/jbcenter-rpc'
import { displayChainName } from '@/lib/chainDisplay'

const clients = new Map<JBChainId, PublicClient>()
function clientFor(chainId: JBChainId) {
  if (!clients.has(chainId)) clients.set(chainId, createPublicClient({ transport: jbCenterRpcTransport(chainId, 60_000) }))
  return clients.get(chainId)!
}

export function FundPaymentNetworks({ state, children }: {
  state: FundProjectState
  children: (state: FundProjectState, client: PublicClient, selector: ReactNode, busy: (value: boolean) => void) => ReactNode
}) {
  const [selected, setSelected] = useState(state.chainId)
  const [busy, setBusy] = useState(false)
  const networks = useQuery({
    queryKey: ['fund-pay-networks', state.chainId, state.projectId.toString(), state.account ?? null, state.blockNumber.toString()],
    queryFn: () => readFundPayNetworks(clientFor, state),
    enabled: !!state.linkedPeers?.length,
    retry: false,
  })
  // Retain the selected identity while discovery refreshes. The payment's own
  // fresh read still gates every signature and transaction.
  const [picked, setPicked] = useState<FundProjectState | null>(null)
  const available = networks.data?.projects ?? [state]
  const active = selected === state.chainId ? state : available.find(project => project.chainId === selected) ?? picked ?? state
  const client = usePublicClient({ chainId: active.chainId }) as PublicClient | undefined
  const options = available.some(project => project.chainId === active.chainId) ? available : [...available, active]
  const selector = <div className="mb-5">
    <label className="payment-chain-label">Fund on
      <select aria-label="Fund on" disabled={busy} className="payment-chain-select" value={active.chainId} onChange={event => {
        const project = available.find(candidate => candidate.chainId === Number(event.target.value))
        if (project) { setPicked(project); setSelected(project.chainId) }
      }}>
        {options.map(project => <option key={project.chainId} value={project.chainId}>{displayChainName(project.chainId)}{project.metadata.pausePay ? ' (payments paused)' : ''}</option>)}
      </select>
    </label>
    {networks.isFetching && <p className="mt-2 text-xs" role="status">Checking available chains…</p>}
    {(networks.isError || !!networks.data?.unavailable) && <p className="mt-2 text-xs">Some linked chains are not available yet. <button type="button" className="underline" onClick={() => void networks.refetch()}>Check again</button></p>}
  </div>
  return client ? <div key={`${active.chainId}:${active.projectId}`}>{children(active, client, selector, setBusy)}</div> : <p>Connecting to the payment network…</p>
}
