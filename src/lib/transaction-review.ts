'use client'

import {
  buildTransactionDebugPrompt as buildDebugPrompt,
  buildTransactionReviewPrompt as buildReviewPrompt,
  TransactionReviewCancelledError,
  type ReviewModel,
  type TransactionReviewRequest,
} from '@bananapus/nana-sdk-core/review'
import { displayChainName, explorerOrigin } from '@/lib/chainDisplay'

export {
  fundingChainLabel,
  registerFundingChainSelectionHandler,
  requireFundingChainSelection,
  TransactionReviewCancelledError,
  transactionReviewJson,
  type FundingChainOption,
  type TransactionReviewCall,
  type TransactionReviewRequest,
} from '@bananapus/nana-sdk-core/review'

const display = { chainName: displayChainName, explorerOrigin }

export function buildTransactionDebugPrompt(
  calls: { chainId: number; txHash: string }[],
): string {
  return buildDebugPrompt(calls, display)
}

export function buildTransactionReviewPrompt(
  request: TransactionReviewRequest | ReviewModel,
): string {
  return buildReviewPrompt(request, display)
}

// ponytail: SDK 4.0.0 dropped this boolean review queue (3.5.2 reviewQueue.ts and transactionReview.ts, same
// behavior). It stays here only until the last caller sends through core's reviewed paths, which delete it.

type TransactionReviewHandler = (request: TransactionReviewRequest) => Promise<boolean>

const transactionReviewHandlers: TransactionReviewHandler[] = []

/** The provider registers the only UI that can approve a transaction. */
export function registerTransactionReviewHandler(handler: TransactionReviewHandler): () => void {
  transactionReviewHandlers.push(handler)
  return () => {
    const index = transactionReviewHandlers.lastIndexOf(handler)
    if (index >= 0) transactionReviewHandlers.splice(index, 1)
  }
}

export async function requestTransactionReview(request: TransactionReviewRequest): Promise<boolean> {
  if (!request.calls.length && !request.authorization) throw new Error('There is no transaction to review.')
  const handler = transactionReviewHandlers[transactionReviewHandlers.length - 1]
  if (!handler) throw new Error('Transaction review is unavailable. Reload the page before continuing.')
  return handler(request)
}

export async function requireTransactionReview(request: TransactionReviewRequest): Promise<void> {
  if (!(await requestTransactionReview(request))) throw new TransactionReviewCancelledError()
}
