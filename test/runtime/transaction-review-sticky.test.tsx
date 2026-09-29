// @vitest-environment jsdom

/** A Sticky split reads as the holder group it pays, not as an opaque project ID and hook. Same as Juicebox Money's review. */

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { encodeFunctionData, type Address } from 'viem'
import { jbControllerAbi } from '@bananapus/nana-sdk-core'
import { stickyDistributorAddress, v6Address } from '@bananapus/nana-sdk-core/v6'

vi.mock('wagmi', () => ({ useAccount: () => ({ address: undefined, chainId: undefined }) }))
vi.mock('next/image', () => ({ default: (props: Record<string, unknown>) => createElement('img', { ...props, src: 'asset' }) }))

import { TransactionReviewProvider } from '@/components/TransactionReviewProvider'
import { requireTransactionReview } from '@/lib/transaction-review'
import '../dialog-shim'

let container: HTMLDivElement
let root: Root
beforeEach(() => { container = document.createElement('div'); document.body.append(container); root = createRoot(container) })
afterEach(() => { act(() => root.unmount()); container.remove() })

it('labels a Sticky split by its holder group and distributor', async () => {
  const chainId = 84532
  const distributor = stickyDistributorAddress(chainId)
  const stickyToken = '0x5ca15ca15ca15ca15ca15ca15ca15ca15ca15ca1' as Address
  const args = [7n, 1n, [{ groupId: 1n, splits: [
    { percent: 500_000_000, projectId: 0n, beneficiary: stickyToken, preferAddToBalance: false, lockedUntil: 0, hook: distributor },
    { percent: 500_000_000, projectId: 0n, beneficiary: '0x1111111111111111111111111111111111111111' as Address, preferAddToBalance: false, lockedUntil: 0, hook: '0x0000000000000000000000000000000000000000' as Address },
  ] }]] as const
  act(() => root.render(<TransactionReviewProvider>{null}</TransactionReviewProvider>))
  await act(async () => {
    requireTransactionReview({ calls: [{
      chainId, to: v6Address('JBController', chainId),
      data: encodeFunctionData({ abi: jbControllerAbi, functionName: 'setSplitGroupsOf', args }),
      abi: jbControllerAbi, functionName: 'setSplitGroupsOf', args,
    }] }).catch(() => {})
  })
  await act(async () => { await vi.dynamicImportSettled() })
  const text = document.querySelector('dialog')?.textContent ?? ''
  expect(text).toContain(`via StickyDistributor ${distributor}`)
  expect(text).toContain('→ Sticky token')
  expect(text).not.toContain(`via hook ${distributor}`)
})
