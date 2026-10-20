import type { PayFailure } from '@bananapus/nana-sdk-core/v6'

/** prepareUserPay's own default tolerance on its quote and fallback minimum. */
export const PAY_DEFAULT_SLIPPAGE_BPS = 100
/** A payer's loosened tolerance stays below this, so the minimum never nears zero. */
export const PAY_SLIPPAGE_LIMIT_PERCENT = 50

/** A shortfall the payer's tolerance controls (the terminal's minimum or the buyback hook's), with its amounts when both are bigints. */
function minimumShortfall(failure: PayFailure | null): { received?: bigint; minimum?: bigint } | null {
  if (failure?.reason !== 'TERMINAL_UNDER_MIN' && failure?.reason !== 'BUYBACK_SLIPPAGE_EXCEEDED') return null
  const { received, minimum } = failure
  return typeof received === 'bigint' && typeof minimum === 'bigint' ? { received, minimum } : {}
}

/** The one line a failed payment shows: the SDK's, unless the payment would get no tokens at all. */
export function payFailureMessage(failure: PayFailure): string {
  return minimumShortfall(failure)?.received === 0n ? 'This payment would return no tokens.' : failure.message
}

/**
 * The tolerance that would have let a payment through which fell short of the
 * minimum prepareUserPay set from `currentBps`, rounded up to a half percent,
 * or null when a lower minimum is not the fix (the hook's own TWAP floor, the
 * router's own quote, a payment that would get no tokens, or no shortfall). A
 * router quotes for itself, so only the terminal's and the buyback hook's
 * minimums answer to this tolerance.
 */
export function payRetrySlippageBps(failure: PayFailure | null, currentBps: number): number | null {
  const shortfall = minimumShortfall(failure)
  if (!shortfall || shortfall.received === 0n) return null
  const { received, minimum } = shortfall
  const shortfallBps =
    received !== undefined && minimum !== undefined && minimum > 0n && received < minimum
      ? Number(((minimum - received) * 10_000n + minimum - 1n) / minimum)
      : 100
  const limit = PAY_SLIPPAGE_LIMIT_PERCENT * 100 - 50
  const next = Math.min(Math.ceil((currentBps + shortfallBps) / 50) * 50, limit)
  // At the limit already, a retry would quote the same minimum again.
  return next > currentBps ? next : null
}
