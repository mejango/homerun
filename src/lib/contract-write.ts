import { submitReviewedContractWrite as submitReviewed } from '@bananapus/nana-sdk-core/review'
import type { Address } from 'viem'
import { assertNoViewAs } from '@/lib/viewAs'

export const REVIEWED_ACCOUNT_CHANGED = 'The connected account changed. Review again.'

/**
 * A request is built for the account that reviewed it (its beneficiary,
 * holder or recipient), so no other connected account may send it. The
 * Permit2 signature checks it here; a reviewed write leaves it to the SDK.
 */
export function assertReviewedAccountConnected(
  reviewed: Address,
  connected: Address | undefined,
  message = REVIEWED_ACCOUNT_CHANGED,
): void {
  if (connected?.toLowerCase() !== reviewed.toLowerCase()) throw new Error(message)
}

/**
 * The SDK's reviewed write, refused while the site is viewing as another
 * account. A request is built for the account that reviewed it (its
 * beneficiary, holder or recipient), so the SDK refuses any other connected
 * account than `expectedAccount` at each step up to signing, in these words
 * unless a flow names its own.
 */
export const submitReviewedContractWrite: typeof submitReviewed = options =>
  submitReviewed({
    ...options,
    accountChangedError: options.accountChangedError ?? REVIEWED_ACCOUNT_CHANGED,
    guard: assertNoViewAs,
  })
