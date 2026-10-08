import { transactionMessage } from '@bananapus/nana-sdk-core/review'

/**
 * A reader-facing sentence for a failure. viem's full `message` carries request
 * details (calldata, RPC URLs that may embed keys, library versions), so only its
 * `shortMessage` is shown. The app's own errors are already written for readers.
 */
export function readableError(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) return fallback
  const short = (error as { shortMessage?: unknown }).shortMessage
  return transactionMessage(typeof short === 'string' && short ? short : error.message || fallback)
}
