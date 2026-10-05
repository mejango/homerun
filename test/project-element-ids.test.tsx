import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/components/WalletButton', () => ({ WalletButton: () => <span>Wallet</span> }))

import { DemoProjectPage, type ProjectPhase } from '../src/components/ProjectPage'
import { CREATE_DEFAULTS, saveCreatedProject } from '../web/create-model.mjs'

let root: Root
let host: HTMLDivElement

const phases: ProjectPhase[] = ['raising', 'funded', 'refunding', 'refunded', 'earning', 'liquidated']

async function click(button: HTMLButtonElement) {
  await act(async () => button.click())
}

/** A panel stays mounted once its tab has been opened, so opening every tab puts every panel in one document. */
async function tab(label: string, list = 'Project sections') {
  if (list === 'Project sections' && (label === 'Extras' || label === 'Operators')) {
    const more = host.querySelector<HTMLButtonElement>('.hpl-overflow-trigger')!
    if (more.getAttribute('aria-expanded') !== 'true') await click(more)
  }
  const button = [...host.querySelectorAll<HTMLButtonElement>(`[role="tablist"][aria-label="${list}"] [role="tab"]`)]
    .find(element => element.textContent === label)
  expect(button, `Missing ${label} tab`).toBeDefined()
  await click(button!)
}

function ownerSections() {
  return [...host.querySelectorAll('[role="tablist"][aria-label="Ownership sections"] [role="tab"]')]
    .map(element => element.textContent!)
}

async function selectPhase(phase: ProjectPhase) {
  await tab('Stages')
  const stage = phase === 'earning' || phase === 'liquidated' ? phase : 'raising'
  await click(host.querySelector<HTMLButtonElement>(`.preview-base-buttons button[data-journey-phase="${stage}"]`)!)
  if (stage === 'raising') await click(host.querySelector<HTMLButtonElement>(`[data-phase="${phase}"]`)!)
  expect(host.querySelector('[data-project-phase]')?.getAttribute('data-project-phase')).toBe(phase)
}

function duplicateIds() {
  const counts = new Map<string, number>()
  for (const element of host.querySelectorAll('[id]')) counts.set(element.id, (counts.get(element.id) ?? 0) + 1)
  return [...counts].filter(([, count]) => count > 1).map(([id, count]) => `${id} x${count}`)
}

beforeEach(() => {
  localStorage.clear()
  window.history.replaceState(null, '', '/')
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
  HTMLElement.prototype.scrollIntoView = vi.fn()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
})

describe.each([['the demo', false], ['a local preview', true]] as const)('element ids on %s', (_page, custom) => {
  it.each(phases)('stay unique in the %s stage once every project tab and Owners section has been opened', async phase => {
    const project = custom
      ? saveCreatedProject({ ...CREATE_DEFAULTS, ownerMode: 'existing', operatorMode: 'existing', name: 'Community house', photo: 'data:image/png;base64,aW1hZ2U=' })
      : undefined
    await act(async () => root.render(<DemoProjectPage project={project} />))
    await selectPhase(phase)
    for (const label of ['Overview', 'Shop', 'Extras', 'Operators', 'Owners']) await tab(label)
    const sections = ownerSections()
    expect(sections).toContain('Accounts')
    for (const section of sections) await tab(section, 'Ownership sections')
    expect(duplicateIds()).toEqual([])
  })
})
