import { TransactionNotFoundError, type PublicClient } from 'viem'
import type { ReviewedWriteRecoveryRecord } from '@bananapus/nana-sdk-core/review'

/** What a returned hash that is still pending says: the wallet is where it is sped up or cancelled. */
export const WRITE_STILL_PENDING_LINE = 'Still pending in your wallet. Speed it up or cancel it there.'

/**
 * A returned hash is proven dropped when the node no longer knows it and the account's nonce moved
 * past it at a finalized block. Until then it may still be mined: the wallet is where it is sped up.
 */
export async function provenDropped(client: Pick<PublicClient, 'getTransaction' | 'getTransactionCount'>, record: ReviewedWriteRecoveryRecord): Promise<boolean> {
  const used = record.sentNonce ?? record.nonce
  if (!record.hash || record.safe || used === undefined) return false
  try {
    await client.getTransaction({ hash: record.hash })
    return false
  } catch (reason) { if (!(reason instanceof TransactionNotFoundError)) return false }
  try {
    const count = await client.getTransactionCount({ address: record.account, blockTag: 'finalized' })
    return count > Number(used)
  } catch { return false }
}
