'use client'

import type { ProjectAdminTx } from '@/hooks/useProjectAdminTx'
import { HeldWriteExit } from '@/components/ui/HeldWriteExit'
import { explorerTxUrl } from '@/lib/chainDisplay'

/** Where a project update stands, in every administrative tab: a held write shows its one exit. */
export function ProjectAdminTransactionStatus({ tx }: { tx: ProjectAdminTx }) {
  const explorer = tx.hash ? explorerTxUrl(tx.chainId, tx.hash) : null
  if (!tx.error && !tx.status && !tx.notice && !tx.pending && !tx.busy) return null
  return <div className="mt-4 space-y-3 text-sm" aria-live="polite">
    {tx.notice ? <p role="status">{tx.notice}</p> : tx.pending && <p>{tx.pendingLabel ?? 'Project update'} is pending. {tx.safe ? 'Check Safe for signatures and execution.' : 'Wait for it to confirm before sending another.'}</p>}
    {!tx.pending && tx.busy && <p>{tx.phase === 'review' ? 'Review the project update…' : tx.phase === 'signing' ? 'Confirm in your wallet…' : 'Checking the project update…'}</p>}
    {tx.status && tx.status !== tx.notice && <p role="status">{tx.status}</p>}
    {tx.error && <p role="alert">{tx.error}</p>}
    {tx.pending && !tx.hash && tx.submissionHash && <p className="break-all">{tx.safe ? 'Safe proposal' : 'Submitted transaction'}: <code>{tx.submissionHash}</code></p>}
    {explorer && <a className="underline" href={explorer} target="_blank" rel="noopener noreferrer">View transaction</a>}
    <HeldWriteExit held={tx.held} />
  </div>
}
