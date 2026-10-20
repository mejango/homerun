'use client'

import { lazy, Suspense, useState, type ComponentType, type ReactNode } from 'react'
import { ChunkFailed } from '@/components/ChunkFailed'

export type LazyComponent<P> = ComponentType<P> & { preload: () => Promise<unknown> }

/**
 * A component whose code loads on first render or on `preload()`, whichever comes first. Until it arrives `fallback`
 * renders in its place, inside this component's own Suspense boundary so nothing around it is swapped out; a chunk that
 * fails to load renders `failed`. Once loaded, later mounts render it directly: React.lazy would still suspend once
 * per first render and flash the fallback even when an idle preload already fetched the code.
 */
export function lazyComponent<P extends object>(
  load: () => Promise<ComponentType<P>>,
  { fallback, failed = ChunkFailed as ComponentType<P> }: { fallback?: (props: P) => ReactNode; failed?: ComponentType<P> } = {},
): LazyComponent<P> {
  let loaded: ComponentType<P> | undefined
  let pending: Promise<ComponentType<P>> | undefined
  const preload = () => (pending ??= load().catch(() => failed).then(component => (loaded = component)))
  const Lazy = lazy(() => preload().then(component => ({ default: component })))
  function LazyComponent(props: P) {
    // Chosen once per mount, so a preload finishing mid-load never remounts the subtree.
    const [Ready] = useState(() => loaded)
    if (Ready) return <Ready {...props} />
    return <Suspense fallback={fallback?.(props) ?? null}><Lazy {...props} /></Suspense>
  }
  return Object.assign(LazyComponent, { preload })
}
