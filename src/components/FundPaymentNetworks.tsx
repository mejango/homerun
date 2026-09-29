'use client'

import { useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { PublicClient } from 'viem'
import { usePublicClient } from 'wagmi'
import { readFundPayNetwork } from '@/lib/fund-pay-networks'
import type { FundProjectState } from '@/lib/fund-state'
import { jbCenterPublicClient } from '@/lib/jbcenter-rpc'
import { displayChainName } from '@/lib/chainDisplay'
import { PaymentChainSelect } from '@/components/PaymentChainSelect'

/** Like Juicebox Money's Pay card: every linked chain is listed at once, and a
 * chain's project is read and verified only when the payer picks it. */
export function FundPaymentNetworks({ state, children }: {
  state: FundProjectState
  children: (state: FundProjectState, client: PublicClient, selector: ReactNode, busy: (value: boolean) => void) => ReactNode
}) {
  const [selected, setSelected] = useState<number>(state.chainId)
  const [busy, setBusy] = useState(false)
  const home = selected === state.chainId
  const remote = useQuery({
    queryKey: ['fund-pay-network', state.chainId, state.projectId.toString(), selected, state.account ?? null],
    queryFn: () => readFundPayNetwork(jbCenterPublicClient, state, selected),
    enabled: !home,
    staleTime: 60_000,
    retry: false,
  })
  const active = home ? state : remote.data
  const client = usePublicClient({ chainId: selected }) as PublicClient | undefined
  const chainIds = [...new Set([state.chainId, ...(state.linkedPeers ?? []).map(peer => peer.chainId)])]
  const selector = <div className="mb-5">
    <label className="payment-chain-label">Fund on
      <PaymentChainSelect label="Fund on" disabled={busy} value={selected} options={chainIds.map(chainId => ({ chainId, name: displayChainName(chainId) }))} onChange={setSelected} />
    </label>
  </div>
  if (active && client) return <div key={`${active.chainId}:${active.projectId}`}>{children(active, client, selector, setBusy)}</div>
  return <div className="pay-panel">{selector}{remote.isError
    ? <p className="text-sm" role="status">This project isn’t ready for payments on {displayChainName(selected)} yet. <button type="button" className="underline" onClick={() => void remote.refetch()}>Check again</button></p>
    : <p className="text-sm" role="status" aria-busy="true">Checking {displayChainName(selected)}…</p>}</div>
}
