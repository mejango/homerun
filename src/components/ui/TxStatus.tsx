'use client'

import { explorerTxUrl } from '@/lib/chainDisplay'
import { HeldNotice, retiringExit, type HeldWrite } from '@/components/ui/HeldWriteExit'

/** What every card's status line says for each phase of its write. */
export const TX_STATUS_LINES = {
  review: 'Review the exact transaction before continuing.',
  pending: 'Submitted. Waiting for onchain confirmation…',
  success: 'Confirmed onchain.',
  safeProposal: 'Safe proposal:',
  viewTransaction: 'View transaction',
} as const

export type TxStatusTx = {
  phase: string
  notice: string | null
  held: HeldWrite | null
  error: string | null
  hash: string | null
  safeProposalHash: string | null
  submissionHash?: string | null
}

/**
 * A card's write status under its controls. `hideError` drops an error the card already explains or that
 * belongs to another attempt; `retire` retires a saved attempt when the user takes the held write's exit.
 */
export function TxStatus({ tx, chainId, hideError = false, retire, className = 'mt-4' }: {
  tx: TxStatusTx
  chainId: number
  hideError?: boolean
  retire?: (reason: { by: 'exit' }) => Promise<unknown>
  className?: string
}) {
  const explorer = tx.hash && !tx.safeProposalHash ? explorerTxUrl(chainId, tx.hash) : null
  return <div role="status" aria-live="polite" className={`${className} break-words text-sm`.trim()}>
    {tx.phase === 'submitted' ? <HeldNotice tx={{ notice: tx.notice, held: retire ? retiringExit(tx.held, retire) : tx.held }} />
      : tx.phase === 'pending' ? <p>{TX_STATUS_LINES.pending}</p>
        : tx.phase === 'success' ? <p>{TX_STATUS_LINES.success}</p>
          : tx.phase === 'review' ? <p>{TX_STATUS_LINES.review}</p> : null}
    {tx.error && !hideError && <p className="text-red-800">{tx.error}</p>}
    {tx.submissionHash && !tx.hash && <p className="break-all">{TX_STATUS_LINES.safeProposal} <code>{tx.submissionHash}</code></p>}
    {explorer && <a className="underline" href={explorer} target="_blank" rel="noreferrer">{TX_STATUS_LINES.viewTransaction}</a>}
  </div>
}
