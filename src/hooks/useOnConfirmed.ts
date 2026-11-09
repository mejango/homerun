'use client'

import { useEffect, useRef } from 'react'
import type { TransactionReceipt } from 'viem'

/** Runs `onConfirmed` once per receipt of a confirmed write, once `ready` (its receipt verified, say). */
export function useOnConfirmed(tx: { phase: string; receipt: TransactionReceipt | null }, onConfirmed: (receipt: TransactionReceipt) => void, ready = true) {
  const latest = useRef(onConfirmed)
  latest.current = onConfirmed
  const seen = useRef(new Set<string>())
  const receipt = tx.phase === 'success' && ready ? tx.receipt : null
  useEffect(() => {
    if (!receipt || seen.current.has(receipt.transactionHash)) return
    seen.current.add(receipt.transactionHash)
    latest.current(receipt)
  }, [receipt])
}
