/** Opens a review in the site's own dialog exactly as core's prompt does, through the handler its provider registers. */
import { TransactionReviewCancelledError, type TransactionReviewRequest } from '@bananapus/nana-sdk-core/review'
import { promptReviewForTests } from '@bananapus/nana-sdk-core/testing'

/** Resolves once the dialog confirms; a close rejects as core's cancelled review does. */
export async function openReview(request: TransactionReviewRequest, signal?: AbortSignal): Promise<void> {
  if ((await promptReviewForTests(request, signal ? { signal } : {}).outcome) !== 'confirmed') throw new TransactionReviewCancelledError()
}
