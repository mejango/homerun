// @vitest-environment jsdom
import type { FeeReviewState } from '@bananapus/nana-sdk-core/v6/fee-buyback'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FeeBuybackNotice } from '../src/components/FeeBuybackNotice'

// The review itself (checks, block refreshes, confirm) is the SDK's useFeeBuybackReview, tested there.
const fee = { key: 'base:6', projectId: 6n, received: 9429n * 10n ** 18n, route: 'fallback' as const }
const state = (change: Partial<FeeReviewState>) => ({
  enabled: true, status: 'fallback', result: { status: 'fallback', fees: [fee] }, busy: false, settled: true,
  waiting: false, autoRefresh: true, confirmLabel: undefined, confirm: vi.fn(), retry: vi.fn(), wait: vi.fn(), ...change,
}) as Parameters<typeof FeeBuybackNotice>[0]['review']

let root: Root | undefined
let host: HTMLDivElement
afterEach(() => {
  if (root) act(() => root!.unmount())
  host?.remove()
})
function render(review: Parameters<typeof FeeBuybackNotice>[0]['review']) {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  act(() => root!.render(<FeeBuybackNotice review={review} />))
}
const button = (label: string) => [...host.querySelectorAll('button')].find(b => b.textContent === label)

describe('fee return notice', () => {
  it('offers to wait for a better rate and shows the received amount', () => {
    const review = state({})
    render(review)
    expect(host.textContent).toContain('9,429')
    expect(host.textContent).toContain('Checking new blocks automatically')
    act(() => button('Wait for better rate')!.click())
    expect(review.wait).toHaveBeenCalledOnce()
  })
  it('shows a pending first check as checking, never as unavailable', () => {
    render(state({ busy: true, settled: false, status: 'checking', result: { status: 'unknown', fees: [] } }))
    expect(host.textContent).toContain('Checking fee return…')
    expect(host.textContent).not.toContain('unavailable')
    expect(button('Retry now')).toBeUndefined()
  })
  it('offers retry when the return is unknown and blocks cannot be watched', () => {
    const review = state({ status: 'unknown', result: { status: 'unknown', fees: [] }, autoRefresh: false })
    render(review)
    expect(host.textContent).toContain('Automatic checks unavailable. Retry now.')
    act(() => button('Retry now')!.click())
    expect(review.retry).toHaveBeenCalledOnce()
  })
  it('shows nothing when no call pays a fee', () => {
    render(state({ enabled: false }))
    expect(host.textContent).toBe('')
  })
})
