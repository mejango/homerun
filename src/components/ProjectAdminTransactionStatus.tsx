'use client'

import { useId, useState } from 'react'
import type { Hex } from 'viem'
import type { ProjectAdminTx } from '@/hooks/useProjectAdminTx'
import { explorerTxUrl } from '@/lib/chainDisplay'

/** Shared recovery stays available in every administrative tab while its saved update is pending. */
export function ProjectAdminTransactionStatus({ tx }: { tx: ProjectAdminTx }) {
  const [executionHash, setExecutionHash] = useState('')
  const id = useId()
  const explorer = tx.hash ? explorerTxUrl(tx.chainId, tx.hash) : null
  const validHash = /^0x[\da-f]{64}$/i.test(executionHash.trim())
  if (!tx.error && !tx.status && !tx.pending && !tx.busy) return null
  return <div className="mt-4 space-y-3 text-sm" aria-live="polite">
    {tx.pending && <p>{tx.pendingLabel ?? 'Project update'} is pending. {tx.safe ? 'Check Safe for signatures and execution.' : 'Wait for its execution before submitting another project update.'}</p>}
    {!tx.pending && tx.busy && <p>{tx.phase === 'review' ? 'Review the project update…' : tx.phase === 'signing' ? 'Confirm in your wallet…' : 'Checking the project update…'}</p>}
    {tx.status && <p role="status">{tx.status}</p>}
    {tx.error && <p role="alert">{tx.error}</p>}
    {explorer && <a className="underline" href={explorer} target="_blank" rel="noopener noreferrer">View transaction</a>}
    {tx.pending && <details>
      <summary className="cursor-pointer underline">Check an execution transaction</summary>
      <div className="mt-3 space-y-2">
        <label className="block" htmlFor={id}>Execution transaction hash</label>
        <input className="min-h-12 w-full rounded border border-[#bfc9b5] bg-transparent px-3 text-base" id={id} value={executionHash} onChange={event => setExecutionHash(event.target.value)} placeholder="0x…" autoComplete="off" spellCheck={false} />
        <p>Paste the mined transaction hash from your wallet or explorer{tx.safe ? ', after the Safe proposal executes' : ''}.</p>
        <button type="button" className="btn-secondary min-h-11 px-5" disabled={!validHash || tx.recovering} onClick={() => void tx.recover(executionHash.trim() as Hex)}>Check execution</button>
      </div>
    </details>}
  </div>
}
