'use client'

import { useEffect } from 'react'
import { zeroAddress, type Address } from 'viem'
import { useSafeTx } from '@/hooks/useSafeTx'
import { HeldNotice } from '@/components/ui/HeldWriteExit'

export type HeldIntentOf = { namespace: string; label: string }

/**
 * Whatever a fixed set of actions' holds hold, found from their intents alone and shown with its
 * line and exit, whatever the actions' buttons allow now (another action may have changed the rules).
 */
export function HeldIntents({ chainId, account, intents }: { chainId: number; account: Address | undefined; intents: readonly HeldIntentOf[] }) {
  if (!account) return null
  return <>{intents.map(intent => <HeldIntent key={intent.namespace} chainId={chainId} account={account} {...intent} />)}</>
}

function HeldIntent({ chainId, account, namespace, label }: { chainId: number; account: Address } & HeldIntentOf) {
  const tx = useSafeTx(chainId)
  const { track } = tx
  useEffect(() => {
    void track({ chainId, call: { to: zeroAddress, data: '0x' } }, { reviewedAccount: account, recoveryNamespace: namespace, heldOnly: true })
  }, [account, chainId, namespace, track])
  if (tx.phase !== 'submitted' && tx.phase !== 'pending') return null
  return <div role="status" className="grid gap-2 text-sm">
    <p className="font-medium">{label}</p>
    {tx.phase === 'submitted' ? <HeldNotice tx={tx} /> : <p>Submitted. Waiting for onchain confirmation…</p>}
  </div>
}
