import type { Address } from 'viem'

export const REVIEWED_ACCOUNT_CHANGED = 'The connected account changed. Review again.'

/**
 * A request is built for the account that reviewed it (its beneficiary,
 * holder or recipient), so no other connected account may send it. A
 * reviewed send leaves this check to the SDK.
 */
export function assertReviewedAccountConnected(
  reviewed: Address,
  connected: Address | undefined,
  message = REVIEWED_ACCOUNT_CHANGED,
): void {
  if (connected?.toLowerCase() !== reviewed.toLowerCase()) throw new Error(message)
}
