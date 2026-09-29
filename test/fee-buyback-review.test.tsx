// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  FeeBuybackNotice,
  useFeeBuybackReview,
} from '../src/components/FeeBuybackNotice'
const mocks = vi.hoisted(() => ({
  check: vi.fn(),
  block: undefined as undefined | (() => void),
  stop: vi.fn(),
}))
vi.mock('../src/lib/fee-buyback-client', () => ({
  feeBuybackContext: () => ({
    client: {
      watchBlockNumber: (o: { onBlockNumber: () => void }) => {
        mocks.block = o.onBlockNumber
        return mocks.stop
      },
    },
    options: {},
  }),
}))
vi.mock('../src/lib/fee-buyback', async importOriginal => ({
  ...(await importOriginal<object>()),
  checkFeeBuyback: (...args: unknown[]) => mocks.check(...args),
}))
const calls = [
  {
    chainId: 8453,
    from: '0x3333333333333333333333333333333333333333' as const,
    to: '0x1111111111111111111111111111111111111111' as const,
    data: '0x1234' as const,
    functionName: 'borrowFrom',
  },
]
const fee = {
  key: 'base:6',
  projectId: 6n,
  received: 9429n * 10n ** 18n,
  route: 'fallback',
}
function Host({ sent }: { sent: () => void }) {
  const review = useFeeBuybackReview(calls)
  return (
    <>
      <FeeBuybackNotice review={review} />
      <button
        disabled={review.busy}
        onClick={async () => {
          if (await review.confirm()) sent()
        }}
      >
        {review.confirmLabel ?? 'Confirm'}
      </button>
    </>
  )
}
let root: Root | undefined
let host: HTMLDivElement
afterEach(() => {
  if (root) act(() => root!.unmount())
  host?.remove()
  vi.clearAllMocks()
})
async function render(sent: () => void) {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root!.render(<Host sent={sent} />))
}
function button(label: string) {
  const found = [...host.querySelectorAll('button')].find(
    b => b.textContent === label,
  )
  expect(found, label).toBeTruthy()
  return found!
}
describe('actionable fee review', () => {
  it('waits in place, refreshes on blocks, and never auto-submits when ready', async () => {
    mocks.check.mockResolvedValue({
      status: 'fallback',
      fees: [fee],
      checkedAt: Date.now(),
    })
    const sent = vi.fn()
    await render(sent)
    expect(host.textContent).toContain('9,429')
    await act(async () => button('Wait for better rate').click())
    expect(host.textContent).toContain('Checking new blocks automatically')
    mocks.check.mockResolvedValue({
      status: 'ready',
      fees: [{ ...fee, route: 'swap' }],
      checkedAt: Date.now(),
    })
    await act(async () => mocks.block?.())
    expect(sent).not.toHaveBeenCalled()
    await act(async () => button('Review and submit').click())
    expect(sent).toHaveBeenCalledOnce()
    act(() => root!.unmount())
    root = undefined
    expect(mocks.stop).toHaveBeenCalled()
  })
  it('shows retry when unavailable and makes submitting without an estimate explicit', async () => {
    mocks.check.mockResolvedValue({ status: 'unknown', fees: [] })
    await render(vi.fn())
    button('Retry now')
    button('Submit without estimate')
  })
  it('keeps review open when the submit-time recheck falls back', async () => {
    mocks.check
      .mockResolvedValueOnce({
        status: 'ready',
        fees: [{ ...fee, route: 'swap' }],
      })
      .mockResolvedValue({ status: 'fallback', fees: [fee] })
    const sent = vi.fn()
    await render(sent)
    await act(async () => button('Review and submit').click())
    expect(sent).not.toHaveBeenCalled()
    button('Submit anyway')
    await act(async () => button('Submit anyway').click())
    expect(sent).toHaveBeenCalledOnce()
  })
})
