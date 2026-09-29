'use client'

import { useEffect, useRef, useState } from 'react'
import {
  checkFeeBuyback,
  createFeeWatch,
  feeMessage,
  feeReceipt,
  type FeeCall,
  type FeeResult,
} from '@/lib/fee-buyback'
import { feeBuybackContext } from '@/lib/fee-buyback-client'

type Call = FeeCall & { chainId: number; functionName?: string }
const candidate = (call: Call) =>
  /^(borrowFrom|reallocateCollateralFromLoan|repayLoan|cashOutTokensOf|useAllowanceOf|sendPayoutsOf|processHeldFeesOf|pay)$/.test(
    call.functionName ?? '',
  )
const initial: FeeResult = { status: 'unknown', fees: [] }

export function useFeeBuybackReview(calls: readonly Call[]) {
  const enabled = calls.some(candidate)
  const [result, setResult] = useState<FeeResult>(initial)
  const [busy, setBusy] = useState(enabled)
  const [waiting, setWaiting] = useState(false)
  const [autoRefresh, setAutoRefresh] = useState(false)
  const confirming = useRef(false)
  const watch = useRef<ReturnType<typeof createFeeWatch> | null>(null)
  useEffect(() => {
    if (!enabled) return
    let alive = true
    let stopBlocks: (() => void) | undefined
    const call = calls[0]
    let context: ReturnType<typeof feeBuybackContext> | undefined
    try {
      if (calls.length === 1 && call.from)
        context = feeBuybackContext(call.chainId, call.from)
    } catch {
      /* Unsupported chain. */
    }
    const monitor = createFeeWatch(
      async () =>
        context
          ? checkFeeBuyback(context.client, call, context.options)
          : initial,
      next => {
        if (!alive) return
        setAutoRefresh(!!context)
        setResult(next)
        setBusy(false)
      },
    )
    watch.current = monitor
    void monitor.refresh()
    if (context)
      stopBlocks = context.client.watchBlockNumber({
        pollingInterval: 4000,
        onBlockNumber: () => {
          void monitor.refresh()
        },
        onError: () => {
          if (alive) setResult(initial)
        },
      })
    return () => {
      alive = false
      monitor.stop()
      stopBlocks?.()
      watch.current = null
    }
  }, [calls, enabled])
  async function confirm() {
    if (!enabled) return true
    if (!watch.current || busy || confirming.current) return false
    confirming.current = true
    setBusy(true)
    try {
      return await watch.current.confirm()
    } finally {
      confirming.current = false
      setBusy(false)
    }
  }
  return {
    enabled,
    result,
    busy,
    waiting,
    autoRefresh,
    confirm,
    wait: () => setWaiting(true),
    retry: () => {
      setBusy(true)
      void watch.current?.refresh()
    },
    confirmLabel:
      !enabled || result.status === 'none'
        ? undefined
        : busy
          ? 'Checking fee return…'
          : result.status === 'fallback'
            ? 'Submit anyway'
            : result.status === 'ready'
              ? 'Review and submit'
              : 'Submit without estimate',
  }
}

export function FeeBuybackNotice({
  review,
}: {
  review: ReturnType<typeof useFeeBuybackReview>
}) {
  if (!review.enabled || review.result.status === 'none') return null
  return (
    <section
      aria-label="Fee token return"
      className="my-3 rounded-lg border p-3 text-sm"
    >
      <p role="status">
        {review.busy ? 'Checking fee return…' : feeMessage(review.result)}
      </p>
      {review.result.fees
        .filter(f => f.route !== 'unknown')
        .map(fee => (
          <p key={fee.key}>{feeReceipt(fee)}</p>
        ))}
      <p className="mt-1 text-xs">
        {review.waiting && review.result.status !== 'ready' ? 'Waiting. ' : ''}
        {review.autoRefresh
          ? 'Checking new blocks automatically.'
          : 'Automatic checks unavailable. Retry now.'}{' '}
        {review.result.checkedAt
          ? `Last checked ${new Date(review.result.checkedAt).toLocaleTimeString()}.`
          : ''}
      </p>
      {review.result.status === 'fallback' && !review.waiting ? (
        <button type="button" className="mt-2 underline" onClick={review.wait}>
          Wait for better rate
        </button>
      ) : null}
      {review.result.status === 'unknown' ? (
        <button
          type="button"
          className="mt-2 underline"
          disabled={review.busy}
          onClick={review.retry}
        >
          Retry now
        </button>
      ) : null}
    </section>
  )
}
