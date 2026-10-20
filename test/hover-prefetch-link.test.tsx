import { act, type AnchorHTMLAttributes } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'

const runtime = vi.hoisted(() => ({ prefetch: vi.fn(), linkPrefetch: [] as unknown[] }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ prefetch: runtime.prefetch }) }))
vi.mock('next/link', () => ({ default: ({ prefetch, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { prefetch?: unknown }) => {
  runtime.linkPrefetch.push(prefetch)
  return <a {...props} />
} }))

import { HoverPrefetchLink } from '@/components/HoverPrefetchLink'

it('prefetches a heavy route on hover, focus or touch, never on view', async () => {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  await act(async () => root.render(<HoverPrefetchLink href="/create">Begin</HoverPrefetchLink>))
  expect(runtime.linkPrefetch).toEqual([false])
  expect(runtime.prefetch).not.toHaveBeenCalled()
  const link = host.querySelector('a')!
  await act(async () => link.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })))
  await act(async () => link.focus())
  await act(async () => link.dispatchEvent(new Event('touchstart', { bubbles: true })))
  expect(runtime.prefetch.mock.calls).toEqual([['/create'], ['/create'], ['/create']])
  await act(async () => root.unmount())
  host.remove()
})
