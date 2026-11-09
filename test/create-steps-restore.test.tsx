import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }))
vi.mock('next/image', () => ({ default: ({ alt, src }: { alt: string; src: string }) => <img alt={alt} src={src} /> }))

import { CREATE_DRAFT_KEY } from '../web/create-model.mjs'
import { FULL_SETUP } from './fixtures/full-setup'
import CreateFlow from '../src/components/CreateFlow'

let host: HTMLDivElement, root: Root
beforeEach(() => { localStorage.clear(); vi.stubGlobal('requestAnimationFrame', (run: () => void) => { run(); return 0 }); vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }); host = document.createElement('div'); document.body.append(host); root = createRoot(host) })
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals() })
const stepButton = (index: number) => host.querySelector<HTMLButtonElement>(`[data-create-step="${index}"]`)!
async function mount() { await act(async () => root.render(<CreateFlow renderDeploy={() => null} />)) }

it('keeps the steps already reached open after a reload from an earlier step', async () => {
  localStorage.setItem(CREATE_DRAFT_KEY, JSON.stringify({ raw: FULL_SETUP, step: 3, incomeDefaultsVersion: 3 }))
  await mount()
  expect(stepButton(3).getAttribute('aria-current')).toBe('step')
  await act(async () => stepButton(1).click())
  expect(stepButton(1).getAttribute('aria-current')).toBe('step')
  await act(async () => root.unmount())
  root = createRoot(host)
  await mount()
  expect(stepButton(1).getAttribute('aria-current')).toBe('step')
  expect(stepButton(3).disabled).toBe(false)
  expect(stepButton(4).disabled).toBe(true)
})
