import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { lazyComponent } from '@/components/lazy-component'

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})

const Panel = ({ label }: { label: string }) => <p data-panel>{label}</p>

describe('lazyComponent', () => {
  it('shows its fallback in place while loading and leaves the content around it alone', async () => {
    let release!: () => void
    const Lazy = lazyComponent(() => new Promise<typeof Panel>(resolve => { release = () => resolve(Panel) }), { fallback: () => <p data-fallback /> })
    await act(async () => root.render(<main><h1>Around</h1><Lazy label="ready" /></main>))
    expect(host.querySelector('h1')?.textContent).toBe('Around')
    expect(host.querySelector('[data-fallback]')).not.toBeNull()
    await act(async () => release())
    expect(host.querySelector('[data-panel]')?.textContent).toBe('ready')
    expect(host.querySelector('[data-fallback]')).toBeNull()
  })

  it('renders a preloaded component at once, without its fallback', async () => {
    const fallback = vi.fn(() => <p data-fallback />)
    const Lazy = lazyComponent(async () => Panel, { fallback })
    await Lazy.preload()
    act(() => root.render(<Lazy label="now" />))
    expect(host.querySelector('[data-panel]')?.textContent).toBe('now')
    expect(fallback).not.toHaveBeenCalled()
  })

  it('offers a reload when the chunk fails, since a retry in the page would reuse the cached failure', async () => {
    const reload = vi.fn()
    vi.stubGlobal('location', { ...window.location, reload })
    const Lazy = lazyComponent<{ label: string }>(() => Promise.reject(new Error('ChunkLoadError')))
    await act(async () => root.render(<Lazy label="never" />))
    const button = [...host.querySelectorAll('button')].find(item => item.textContent === 'Reload the page to try again')
    expect(host.querySelector('[role="alert"]')).not.toBeNull()
    await act(async () => button!.click())
    expect(reload).toHaveBeenCalledTimes(1)
  })
})
