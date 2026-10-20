import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const runtime = vi.hoisted(() => ({ shopLoaded: vi.fn() }))
vi.mock('@/components/ProjectShop', () => {
  runtime.shopLoaded()
  return { ProjectShop: ({ tokenLabel }: { tokenLabel: string }) => <p data-shop>{tokenLabel} shop</p> }
})

import { HomerunProjectLayout } from '@/components/HomerunProjectLayout'
import { ProjectShop } from '@/components/project-panels'

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  window.history.replaceState(null, '', '/')
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})

describe('lazy project tabs', () => {
  it('loads a tab-only panel when its tab first opens, behind a skeleton', async () => {
    await act(async () => root.render(<HomerunProjectLayout
      title="Workshop" payment={null} activity={null} overview={<p>About</p>} stages={null} owners={null}
      shop={<ProjectShop chainId={10} projectId={1n} tokenLabel="FUND" />} extras={null} operators={null}
    />))
    expect(host.textContent).toContain('About')
    expect(runtime.shopLoaded).not.toHaveBeenCalled()

    const shopTab = [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(tab => tab.textContent === 'Shop')!
    act(() => shopTab.click())
    const panel = document.getElementById(shopTab.id.replace('-tab-', '-panel-'))!
    expect(panel.querySelector('.skeleton-shimmer')).not.toBeNull()
    await vi.waitFor(() => expect(panel.querySelector('[data-shop]')?.textContent).toBe('FUND shop'))
    expect(panel.querySelector('.skeleton-shimmer')).toBeNull()
    expect(runtime.shopLoaded).toHaveBeenCalledTimes(1)
  })
})
