'use client'

import { useState } from 'react'
import { encodeFunctionData, parseAbi } from 'viem'
import { requireTransactionReview } from '@/lib/transaction-review'

const abi = parseAbi(['function transfer(address recipient, uint256 amount)'])

/** Deterministic browser fixture: review-only, with no wallet-write boundary. */
export function TransactionReviewBrowserFixture() {
  const [result, setResult] = useState('No review opened.')
  async function openReview() {
    setResult('Review open.')
    try {
      const args = ['0x2222222222222222222222222222222222222222', 5n] as const
      await requireTransactionReview({
        title: 'Review fixture transaction',
        calls: [{
          chainId: 10,
          to: '0x1111111111111111111111111111111111111111',
          from: '0x3333333333333333333333333333333333333333',
          data: encodeFunctionData({ abi, functionName: 'transfer', args }),
          value: 0n,
          abi,
          functionName: 'transfer',
          args,
          label: 'Transfer test tokens',
        }],
      })
      setResult('Review approved. No wallet action requested.')
    } catch {
      setResult('Review cancelled. No wallet action requested.')
    }
  }
  return <section className="contract-panel">
    <h1>Transaction review fixture</h1>
    <p>This fixture opens a review without submitting a transaction.</p>
    <button type="button" onClick={() => void openReview()}>Open fixture review</button>
    <p role="status">{result}</p>
    <a href="#background" id="background">Background focus target</a>
  </section>
}
