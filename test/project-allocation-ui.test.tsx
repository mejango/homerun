import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/components/WalletButton', () => ({ WalletButton: () => <span>Wallet</span> }))

import { DemoProjectPage, type ProjectPhase } from '../src/components/ProjectPage'
import { CREATE_DEFAULTS, creationSummary, saveCreatedProject } from '../web/create-model.mjs'
import { DEFAULT_NETWORK, projectNetwork } from '../web/network-model.mjs'

let root: Root
let host: HTMLDivElement

const values = {
  ...CREATE_DEFAULTS,
  ownerMode: 'existing',
  operatorMode: 'existing',
  name: 'Community house',
  photo: 'data:image/png;base64,aW1hZ2U=',
  operatorSplitPercent: 70,
  stickySplitPercent: 10,
}

async function tab(label: string) {
  const button = [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
    .find(element => element.textContent === label)
  expect(button, `Missing ${label} tab`).toBeDefined()
  await act(async () => button!.click())
}

async function selectPhase(phase: ProjectPhase) {
  await tab('Stages')
  await act(async () => host.querySelector<HTMLButtonElement>(`button[data-journey-phase="${phase}"]`)!.click())
  expect(host.querySelector('[data-project-phase]')?.getAttribute('data-project-phase')).toBe(phase)
}

async function allocation() {
  await tab('Owners')
  await tab('Splits')
  const figure = host.querySelector('.demo-owner-sections .allocation-chart')!
  const split = figure.querySelector('.issuance-split')!
  return {
    note: figure.querySelector('.allocation-planned')?.textContent?.trim() ?? null,
    shares: [...split.querySelectorAll('div')].map(entry => ({
      value: Number(entry.querySelector('strong')!.textContent!.replace('%', '')),
      label: entry.querySelector('span')!.textContent,
    })),
  }
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

describe('new INCOME allocation chart', () => {
  it('shows the planned allocation while the raise is still open', async () => {
    await act(async () => root.render(<DemoProjectPage project={saveCreatedProject(values)} />))
    const { note, shares } = await allocation()
    expect([...host.querySelectorAll('[role="tab"]')].some(tab => tab.textContent === 'Market')).toBe(false)
    const splitsPanel = host.querySelector('[id$="-panel-splits"]')!
    expect(splitsPanel.querySelector('[aria-label="FUND token"]')).toBeNull()
    expect(splitsPanel.textContent).not.toContain('Starting token terms')
    expect(note).toBe('Planned allocation until INCOME starts.')
    expect(shares).toEqual([
      { value: 70, label: 'to operators' },
      { value: 10, label: 'to FUND stakers' },
      { value: 20, label: 'to customers' },
    ])
    expect(shares.reduce((total, share) => total + share.value, 0)).toBe(100)
  })

  it('shows the modeled allocation once INCOME is being issued', async () => {
    await act(async () => root.render(<DemoProjectPage project={saveCreatedProject(values)} />))
    await selectPhase('earning')
    const { note, shares } = await allocation()
    const modeled = projectNetwork({ ...DEFAULT_NETWORK, ...creationSummary(values).networkInputs }, 'earning')
    expect(note).toBe(null)
    expect(shares).toEqual([
      { value: modeled.currentOperatorSplitPercent, label: 'to operators' },
      { value: modeled.currentStickySplitPercent, label: 'to FUND stakers' },
      { value: modeled.currentRenterSplitPercent, label: 'to customers' },
    ])
  })
})
