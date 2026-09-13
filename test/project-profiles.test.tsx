import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getAddress } from 'viem'

vi.mock('@/components/WalletButton', () => ({ WalletButton: () => <span>Wallet</span> }))

import { OperatorProfile } from '../src/components/OperatorProfile'
import { DemoProjectPage } from '../src/components/ProjectPage'
import { CREATE_DEFAULTS, saveCreatedProject } from '../web/create-model.mjs'

let root: Root
let host: HTMLDivElement

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

describe('project Owner and Operator profiles', () => {
  it('renders distinct saved descriptions and full account links in a project preview', async () => {
    const owner = getAddress(`0x${'b2'.repeat(20)}`)
    const operator = getAddress(`0x${'a1'.repeat(20)}`)
    const project = saveCreatedProject({ ...CREATE_DEFAULTS, name: 'Community house', photo: 'data:image/png;base64,aW1hZ2U=', ownerWallet: owner, operatorWallet: operator,
      ownerName: 'Community trust', ownerIntroduction: 'The trust holds and maintains the house.',
      operatorName: 'Local hosts', operatorIntroduction: 'We welcome members and manage events.' })
    await act(async () => root.render(<DemoProjectPage project={project} />))
    const ownership = host.querySelector('[aria-label="Owner introduction"]')!
    const operations = host.querySelector('[aria-label="Operator introduction"]')!
    expect(ownership.textContent).toContain('Community trust')
    expect(ownership.textContent).toContain('The trust holds and maintains the house.')
    expect(ownership.querySelector('a')?.getAttribute('href')).toBe(`/account/${owner}`)
    expect(operations.textContent).toContain('Local hosts')
    expect(operations.textContent).toContain('We welcome members and manage events.')
    expect(operations.querySelector('a')?.textContent).toBe(operator)
    expect(operations.querySelector('a')?.getAttribute('href')).toBe(`/account/${operator}`)
  })

  it('keeps both roles visible when a demo has no configured wallet addresses', async () => {
    const project = saveCreatedProject({ ...CREATE_DEFAULTS, name: 'Community house', photo: 'data:image/png;base64,aW1hZ2U=' })
    await act(async () => root.render(<DemoProjectPage project={project} />))
    for (const role of ['Owner', 'Operator']) {
      const profile = host.querySelector(`[aria-label="${role} introduction"]`)!
      expect(profile.querySelector('h2')?.textContent).toBe(role)
      expect(profile.textContent).toContain('Address not specified')
      expect(profile.querySelector('a')).toBeNull()
    }
  })

  it.each(['javascript:alert(1)', '0x0000000000000000000000000000000000000000'])('does not link an invalid or zero wallet (%s)', async address => {
    await act(async () => root.render(<OperatorProfile role="Owner" address={address} />))
    expect(host.textContent).toContain('Address not specified')
    expect(host.querySelector('a')).toBeNull()
  })

  it.each([11155111, 11155420, 84532, 421614])('preserves testnet when opening accounts on chain %s', async chainId => {
    const address = '0x1111111111111111111111111111111111111111'
    await act(async () => root.render(<OperatorProfile role="Owner" address={address} chainId={chainId} />))
    expect(host.querySelector('a')?.getAttribute('href')).toBe(`/account/${address}?network=testnet`)
  })
})
