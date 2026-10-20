'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import type { ReactNode } from 'react'

/** A link to a heavy route: not prefetched when it scrolls into view, only on hover, focus or touch ahead of a click. */
export function HoverPrefetchLink({ href, className, children }: { href: string; className?: string; children: ReactNode }) {
  const router = useRouter()
  const prefetch = () => router.prefetch(href)
  return <Link href={href} prefetch={false} className={className} onMouseEnter={prefetch} onFocus={prefetch} onTouchStart={prefetch}>{children}</Link>
}
