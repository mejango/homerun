import { act, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/components/WalletButton', () => ({ WalletButton: () => <span>Wallet</span> }))

import { DemoProjectPage, type ProjectPhase } from '../src/components/ProjectPage'
import { demoShopStorageKey, newDemoShopItem, type DemoShopPhase } from '../src/lib/demo-shop'
import { CREATE_DEFAULTS, saveCreatedProject } from '../web/create-model.mjs'

let root: Root
let host: HTMLDivElement
type CreatedProject = ComponentProps<typeof DemoProjectPage>['project']

function preview(custom: boolean): CreatedProject {
  return custom ? saveCreatedProject({
    ...CREATE_DEFAULTS, ownerMode: 'existing', operatorMode: 'existing', ownerIsOperator: false,
    name: 'Community house',
    photo: 'data:image/png;base64,aW1hZ2U=',
  }) : undefined
}

function saveInventory(projectKey: string, phase: DemoShopPhase, name: string) {
  const key = demoShopStorageKey(projectKey, phase)
  const inventory = JSON.stringify({
    version: 1,
    currency: 'USD',
    items: [{ ...newDemoShopItem(), name, price: '25' }],
  })
  localStorage.setItem(key, inventory)
  return [key, inventory] as const
}

async function tab(label: string) {
  const button = [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
    .find(element => element.textContent === label)
  expect(button, `Missing ${label} tab`).toBeDefined()
  await act(async () => button!.click())
}

async function selectPhase(phase: ProjectPhase) {
  await tab('Stages')
  if (phase === 'earning' || phase === 'liquidated') {
    await act(async () => host.querySelector<HTMLButtonElement>(`button[data-journey-phase="${phase}"]`)!.click())
  } else {
    await act(async () => host.querySelector<HTMLButtonElement>('button[data-journey-phase="raising"]')!.click())
    await act(async () => host.querySelector<HTMLButtonElement>(`[data-phase="${phase}"]`)!.click())
  }
  expect(host.querySelector('[data-project-phase]')?.getAttribute('data-project-phase')).toBe(phase)
  await tab('Shop')
}

function itemNames() {
  return [...host.querySelectorAll('.ds-item-card h3')].map(element => element.textContent)
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

describe('demo project phase stores', () => {
  it.each([false, true])('uses the Juicebox store throughout fundraising and the Revnet store after purchase (custom project: %s)', async custom => {
    const project = preview(custom)
    const projectKey = project?.id ?? 'founderhaus'
    const saved = [
      saveInventory(projectKey, 'fund', 'Fundraising membership'),
      saveInventory(projectKey, 'income', 'Income day pass'),
    ]
    await act(async () => root.render(<DemoProjectPage project={project} />))
    await tab('Shop')
    expect(itemNames()).toEqual(['Fundraising membership'])

    for (const [phase, expected] of [
      ['funded', 'Fundraising membership'],
      ['earning', 'Income day pass'],
      ['liquidated', 'Income day pass'],
      ['refunding', 'Fundraising membership'],
      ['refunded', 'Fundraising membership'],
      ['raising', 'Fundraising membership'],
      ['earning', 'Income day pass'],
    ] as const) {
      await selectPhase(phase)
      expect(itemNames(), phase).toEqual([expected])
      for (const [key, inventory] of saved) expect(localStorage.getItem(key)).toBe(inventory)
    }
  })

  it.each([
    { custom: false, visitShop: false },
    { custom: false, visitShop: true },
    { custom: true, visitShop: false },
    { custom: true, visitShop: true },
  ])('resets both stores for this project only ($custom, Shop visited: $visitShop)', async ({ custom, visitShop }) => {
    const project = preview(custom)
    const projectKey = project?.id ?? 'founderhaus'
    const saved = [
      saveInventory(projectKey, 'fund', 'Fundraising membership'),
      saveInventory(projectKey, 'income', 'Income day pass'),
    ]
    const otherProject = custom ? 'founderhaus' : 'other-project'
    const untouched = [
      saveInventory(otherProject, 'fund', 'Other fundraising item'),
      saveInventory(otherProject, 'income', 'Other income item'),
    ]
    localStorage.setItem('unrelated-setting', 'keep me')
    await act(async () => root.render(<DemoProjectPage project={project} />))
    if (visitShop) {
      await selectPhase('earning')
      expect(itemNames()).toEqual(['Income day pass'])
    } else {
      expect(host.querySelector('.demo-project-shop')).toBeNull()
    }

    await act(async () => host.querySelector<HTMLButtonElement>('#reset-example')!.click())
    expect(host.querySelector('[data-project-phase]')?.getAttribute('data-project-phase')).toBe('raising')
    for (const [key] of saved) expect(localStorage.getItem(key)).toBeNull()
    for (const [key, inventory] of untouched) expect(localStorage.getItem(key)).toBe(inventory)
    expect(localStorage.getItem('unrelated-setting')).toBe('keep me')

    await tab('Shop')
    expect(itemNames()).toEqual([])
    await selectPhase('earning')
    expect(itemNames()).toEqual([])
  })
})
