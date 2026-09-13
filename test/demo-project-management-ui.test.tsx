import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/components/ui/ModalShell', () => ({
  ModalShell: ({ title, children, footer }: { title: ReactNode; children: ReactNode; footer: ReactNode }) => <div role="dialog"><h2>{title}</h2>{children}{footer}</div>,
}))
import { DemoProjectControl, DemoProjectDetailsEditor, DemoProjectPermissions, DemoProjectSplits, useDemoProjectManagement } from '../src/components/DemoProjectManagement'
import { demoProjectManagementKey, type DemoProjectManagement } from '../src/lib/demo-project-management'

const owner = '0x1111111111111111111111111111111111111111'
const replacement = '0x2222222222222222222222222222222222222222'
const initial: DemoProjectManagement = {
  version: 1,
  details: { name: 'Founder Haus', location: 'Florianópolis', description: 'A place to gather.', photo: '', ownerName: 'Owner', ownerIntroduction: 'Asset owner', ownerPhoto: '', operatorName: 'Operator', operatorIntroduction: 'Local hosts', operatorPhoto: '' },
  ownerAddress: owner, operatorAddress: owner, delegates: [], splits: { fund: [], income: [] },
}
let root: Root
let host: HTMLDivElement

function Harness({ reset = 0 }: { reset?: number }) {
  const management = useDemoProjectManagement('test-project', initial, reset)
  const props = { state: management.state, ready: management.ready, onSave: management.save }
  return <><h1>{management.state.details.name}</h1><output aria-label="Current Operator">{management.state.operatorAddress}</output><DemoProjectDetailsEditor {...props} /><DemoProjectControl {...props} /><DemoProjectPermissions {...props} /><DemoProjectSplits {...props} /></>
}

async function click(label: string) {
  const button = Array.from(host.querySelectorAll('button')).find(element => element.textContent?.trim() === label)
  if (!button) throw new Error(`Missing button: ${label}`)
  await act(async () => button.click())
}

async function change(label: string, value: string) {
  const node = Array.from(host.querySelectorAll('label')).find(element => element.textContent?.trim() === label)
  if (!node) throw new Error(`Missing label: ${label}`)
  const element = document.getElementById(node.htmlFor) as HTMLInputElement | HTMLTextAreaElement
  await act(async () => {
    const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value)
    element.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

beforeEach(async () => {
  localStorage.clear()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => root.render(<Harness />))
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); localStorage.clear() })

describe('local project management controls', () => {
  it('reviews metadata before saving and restores edits from the project scope', async () => {
    await click('Edit project details')
    await change('Project name', 'Updated Haus')
    await click('Review changes')
    expect(host.querySelector('h1')?.textContent).toBe('Founder Haus')
    expect(localStorage.getItem(demoProjectManagementKey('test-project'))).toBeNull()
    await click('Save demo changes')
    expect(host.querySelector('h1')?.textContent).toBe('Updated Haus')
    await act(async () => root.render(<Harness reset={1} />))
    expect(host.querySelector('h1')?.textContent).toBe('Updated Haus')
  })

  it('synchronizes the displayed Operator only after reviewing its replacement', async () => {
    await click('Replace Operator')
    await change('New Operator address', replacement)
    await click('Review changes')
    expect(host.querySelector('output')?.textContent).toBe(owner)
    await click('Save demo changes')
    expect(host.querySelector('output')?.textContent).toBe(replacement)
    const stored = JSON.parse(localStorage.getItem(demoProjectManagementKey('test-project'))!)
    expect(stored.details.operatorName).toBe('')
    expect(stored.details.operatorIntroduction).toBe('')
  })

  it('previews explicit delegated permissions and clears them on ownership transfer', async () => {
    await click('Edit permissions')
    await click('Add account')
    await change('Account 1 address', replacement)
    await act(async () => (host.querySelector('input[type="checkbox"]') as HTMLInputElement).click())
    await click('Review changes')
    await click('Save demo changes')
    expect(JSON.parse(localStorage.getItem(demoProjectManagementKey('test-project'))!).delegates).toEqual([{ address: replacement, permissions: ['Edit project details'] }])
    await click('Transfer project ownership')
    await change('New Owner address', replacement)
    await click('Review changes')
    await click('Save demo changes')
    expect(JSON.parse(localStorage.getItem(demoProjectManagementKey('test-project'))!).delegates).toEqual([])
  })

  it('saves a recipient preview and resets to the initial project after its storage is cleared', async () => {
    await click('Edit FUND splits')
    await click('Add recipient')
    await change('Recipient 1 address', replacement)
    await change('Recipient 1 percent', '25.5')
    await click('Review changes')
    expect(host.textContent).toContain('Modeling inputs and token balances stay the same.')
    await click('Save demo changes')
    const stored = JSON.parse(localStorage.getItem(demoProjectManagementKey('test-project'))!)
    expect(stored.splits).toEqual({ fund: [{ address: replacement, percent: '25.5' }], income: [] })
    localStorage.removeItem(demoProjectManagementKey('test-project'))
    await act(async () => root.render(<Harness reset={1} />))
    expect(host.textContent).toContain('No FUND recipient preview saved.')
  })
})
