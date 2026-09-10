'use client'

import { useState } from 'react'
import { parseAbi } from 'viem'
import { requireContractTransactionReview } from '@/lib/transaction-review'

const abi = parseAbi(['function transfer(address recipient, uint256 amount)'])

/** Deterministic browser fixture: review-only, with no wallet-write boundary. */
export function TransactionReviewBrowserFixture() {
  const [result, setResult] = useState('No review opened.')
  async function openReview() {
    setResult('Review open.')
    try {
      await requireContractTransactionReview({
        chainId: 10,
        address: '0x1111111111111111111111111111111111111111',
        account: '0x3333333333333333333333333333333333333333',
        abi,
        functionName: 'transfer',
        args: ['0x2222222222222222222222222222222222222222', 5n],
        value: 0n,
      }, { title: 'Review fixture transaction', label: 'Transfer test tokens' })
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
