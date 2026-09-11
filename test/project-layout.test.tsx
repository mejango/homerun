import React, { act, useEffect, useState, type ComponentProps } from 'react'
import { createRoot, hydrateRoot, type Root } from 'react-dom/client'
import { renderToString } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HomerunProjectLayout, OwnersTabs } from '@/components/HomerunProjectLayout'

type LayoutProps = ComponentProps<typeof HomerunProjectLayout>

describe('shared project layout', () => {
  let host: HTMLDivElement
  let root: Root | undefined
  let mobile: boolean
  let mediaListeners: Set<() => void>
  let mounts: Record<string, number>
  let unmounts: Record<string, number>

  function Panel({ name }: { name: string }) {
    const [receipt, setReceipt] = useState('pending')
    useEffect(() => {
      mounts[name] = (mounts[name] ?? 0) + 1
      // Models a live receipt watcher which must remain subscribed while its
      // transaction panel is hidden by navigation.
      const confirmed = () => setReceipt('confirmed')
      window.addEventListener(`receipt:${name}`, confirmed)
      return () => {
        unmounts[name] = (unmounts[name] ?? 0) + 1
        window.removeEventListener(`receipt:${name}`, confirmed)
      }
    }, [name])
    return <div data-content={name}>
      <input aria-label={`${name} draft`} defaultValue={name} />
      <output aria-label={`${name} receipt`}>{receipt}</output>
    </div>
  }

  function props(overrides: Partial<LayoutProps> = {}): LayoutProps {
    return {
      title: 'Founder Haus', metadata: ['Illustrative demo', 'Brazil'],
      payment: <Panel name="payment" />, activity: <Panel name="activity" />,
      overview: <Panel name="overview" />, stages: <Panel name="stages" />,
      owners: <OwnersTabs
        accountsYou={<Panel name="you" />}
        accountsAll={<Panel name="all" />}
        market={<Panel name="market" />}
        settlement={<Panel name="settlement" />}
        splits={<Panel name="splits" />}
        loans={<Panel name="loans" />}
      />,
      shop: <Panel name="shop" />, extras: <Panel name="extras" />,
      operators: <Panel name="operators" />, ...overrides,
    }
  }

  async function render(overrides: Partial<LayoutProps> = {}) {
    root ??= createRoot(host)
    await act(async () => root!.render(<HomerunProjectLayout {...props(overrides)} />))
  }

  function tabs(label: string) {
    const list = host.querySelector(`[role="tablist"][aria-label="${label}"]`)
    expect(list).not.toBeNull()
    return Array.from(list!.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
  }

  function button(label: string, name: string) {
    const result = tabs(label).find(item => item.textContent === name)
    expect(result).toBeDefined()
    return result!
  }

  function selected(label: string) {
    return tabs(label).find(item => item.getAttribute('aria-selected') === 'true')?.textContent
  }

  async function click(label: string, name: string) {
    if (label === 'Project sections' && (name === 'Extras' || name === 'Operators')) {
      await act(async () => host.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')!.click())
      await act(async () => Array.from(host.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')).find(item => item.textContent === name)!.click())
      return
    }
    await act(async () => button(label, name).click())
  }

  function input(name: string) {
    return host.querySelector<HTMLInputElement>(`[aria-label="${name} draft"]`)
  }

  async function traverse(direction: 'back' | 'forward') {
    await act(async () => new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`History ${direction} did not finish`)), 1000)
      window.addEventListener('popstate', () => { clearTimeout(timeout); resolve() }, { once: true })
      window.history[direction]()
    }))
  }

  async function setMobile(value: boolean) {
    await act(async () => {
      mobile = value
      for (const listener of mediaListeners) listener()
    })
  }

  beforeEach(() => {
    host = document.createElement('div')
    document.body.append(host)
    root = undefined
    mobile = false
    mediaListeners = new Set()
    mounts = {}
    unmounts = {}
    window.history.replaceState({ retained: 'route-state' }, '', '/founderhaus?scenario=closed')
    vi.stubGlobal('matchMedia', () => ({
      get matches() { return mobile },
      addEventListener: (_event: string, listener: () => void) => mediaListeners.add(listener),
      removeEventListener: (_event: string, listener: () => void) => mediaListeners.delete(listener),
    }))
    vi.spyOn(HTMLElement.prototype, 'getClientRects').mockImplementation(function (this: HTMLElement) {
      if (this.hidden || (!mobile && this.classList.contains('hpl-mobile-tab'))) return [] as unknown as DOMRectList
      return [new DOMRect(0, 0, 100, 44)] as unknown as DOMRectList
    })
    HTMLElement.prototype.scrollIntoView ??= () => {}
    vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(() => {})
  })

  afterEach(async () => {
    if (root) await act(async () => root!.unmount())
    host.remove()
  })

  it('disables server-rendered tabs until hydration attaches their handlers', async () => {
    const element = <HomerunProjectLayout {...props()} />
    host.innerHTML = renderToString(element)
    expect(tabs('Project sections').every(item => item.disabled)).toBe(true)
    expect(host.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')?.disabled).toBe(true)
    button('Project sections', 'Stages').click()
    expect(window.location.hash).toBe('')
    await act(async () => { root = hydrateRoot(host, element) })
    expect(tabs('Project sections').every(item => !item.disabled)).toBe(true)
    expect(host.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')?.disabled).toBe(false)
    await click('Project sections', 'Stages')
    expect(selected('Project sections')).toBe('Stages')
    expect(window.location.hash).toBe('#stages')
  })

  it('resolves nested account deep links without changing path, query or route state', async () => {
    window.history.replaceState({ retained: 'route-state' }, '', '/founderhaus?scenario=closed#owners/accounts/all')
    await render()
    expect(selected('Project sections')).toBe('Owners')
    expect(selected('Ownership sections')).toBe('Accounts')
    expect(host.querySelector('[role="tablist"][aria-label="Accounts"]')).toBeNull()
    expect(input('you')).not.toBeNull()
    expect(input('all')).not.toBeNull()
    expect(Array.from(host.querySelectorAll('[data-account-section]')).map(item => item.getAttribute('data-account-section'))).toEqual(['you', 'all'])
    await act(async () => {
      window.history.replaceState(window.history.state, '', '#owners/accounts/you')
      window.dispatchEvent(new HashChangeEvent('hashchange'))
    })
    expect(selected('Ownership sections')).toBe('Accounts')
    expect(input('you')).not.toBeNull()
    expect(input('all')).not.toBeNull()
    await click('Ownership sections', 'Loans')
    expect(window.location.pathname).toBe('/founderhaus')
    expect(window.location.search).toBe('?scenario=closed')
    expect(window.history.state).toEqual({ retained: 'route-state' })
    expect(window.location.hash).toBe('#owners/loans')
  })

  it('keeps payment and visited receipt watchers mounted while other panes are active', async () => {
    await render()
    const payment = input('payment')!
    payment.value = '125'
    await click('Project sections', 'Operators')
    const operatorDraft = input('operators')!
    operatorDraft.value = 'reviewed withdrawal'
    await click('Project sections', 'Overview')
    expect(operatorDraft.closest('[role="tabpanel"]')?.hasAttribute('hidden')).toBe(true)
    await act(async () => {
      window.dispatchEvent(new Event('receipt:operators'))
      window.dispatchEvent(new Event('receipt:payment'))
    })
    await click('Project sections', 'Operators')
    expect(input('operators')).toBe(operatorDraft)
    expect(operatorDraft.value).toBe('reviewed withdrawal')
    expect(host.querySelector('[aria-label="operators receipt"]')?.textContent).toBe('confirmed')
    expect(input('payment')).toBe(payment)
    expect(payment.value).toBe('125')
    expect(host.querySelector('[aria-label="payment receipt"]')?.textContent).toBe('confirmed')
    expect(mounts.operators).toBe(1)
    expect(mounts.payment).toBe(1)
    expect(unmounts.operators ?? 0).toBe(0)
    expect(unmounts.payment ?? 0).toBe(0)
  })

  it('mounts both account sections together and preserves their drafts and receipt watchers on return', async () => {
    await render()
    expect(input('loans')).toBeNull()
    expect(input('you')).toBeNull()
    expect(input('all')).toBeNull()
    await click('Project sections', 'Owners')
    expect(selected('Ownership sections')).toBe('Accounts')
    const you = input('you')!
    const all = input('all')!
    you.value = 'reviewed holder operation'
    all.value = 'holder search'
    await click('Ownership sections', 'Market')
    await act(async () => {
      window.dispatchEvent(new Event('receipt:you'))
      window.dispatchEvent(new Event('receipt:all'))
    })
    await click('Ownership sections', 'Accounts')
    expect(selected('Ownership sections')).toBe('Accounts')
    await click('Project sections', 'Extras')
    await click('Project sections', 'Owners')
    expect(selected('Ownership sections')).toBe('Accounts')
    expect(input('you')).toBe(you)
    expect(input('all')).toBe(all)
    expect(you.value).toBe('reviewed holder operation')
    expect(all.value).toBe('holder search')
    expect(host.querySelector('[aria-label="you receipt"]')?.textContent).toBe('confirmed')
    expect(host.querySelector('[aria-label="all receipt"]')?.textContent).toBe('confirmed')
    expect(mounts.you).toBe(1)
    expect(mounts.all).toBe(1)
    expect(unmounts.you ?? 0).toBe(0)
    expect(unmounts.all ?? 0).toBe(0)
    expect(mounts.loans).toBeUndefined()
    expect(window.location.hash).toBe('#owners/accounts')
  })

  it('follows back and forward through main and nested navigation', async () => {
    await render()
    await click('Project sections', 'Owners')
    await click('Ownership sections', 'Loans')
    await click('Project sections', 'Stages')
    await traverse('back')
    expect(selected('Project sections')).toBe('Owners')
    expect(selected('Ownership sections')).toBe('Loans')
    await traverse('back')
    expect(selected('Ownership sections')).toBe('Accounts')
    await traverse('forward')
    expect(selected('Ownership sections')).toBe('Loans')
    await traverse('forward')
    expect(selected('Project sections')).toBe('Stages')
  })

  it('uses roving focus with arrows, Home and End and valid panel relationships', async () => {
    await render()
    await click('Project sections', 'Owners')
    const key = async (name: string) => {
      await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true })))
    }
    button('Ownership sections', 'Accounts').focus()
    await key('ArrowRight')
    expect(selected('Ownership sections')).toBe('Market')
    expect(document.activeElement).toBe(button('Ownership sections', 'Market'))
    await key('End')
    expect(selected('Ownership sections')).toBe('Loans')
    await key('ArrowRight')
    expect(selected('Ownership sections')).toBe('Accounts')
    await key('ArrowLeft')
    expect(selected('Ownership sections')).toBe('Loans')
    await key('Home')
    expect(selected('Ownership sections')).toBe('Accounts')
    expect(tabs('Ownership sections').filter(item => item.tabIndex === 0)).toHaveLength(1)
    expect(button('Ownership sections', 'Accounts').parentElement?.getAttribute('aria-orientation')).toBe('horizontal')
    for (const tab of host.querySelectorAll('[role="tab"]')) {
      const panel = document.getElementById(tab.getAttribute('aria-controls')!)
      expect(panel).not.toBeNull()
      if (!tab.classList.contains('hpl-mobile-tab')) expect(panel?.getAttribute('aria-labelledby')).toBe(tab.id)
    }
  })

  it('keeps overflow deep links and labels available and supports menu keyboard selection', async () => {
    window.history.replaceState(window.history.state, '', '#operators')
    await render()
    expect(tabs('Project sections').map(item => item.textContent)).toEqual(['Activity', 'Overview', 'Stages', 'Owners', 'Shop'])
    expect(tabs('Project sections').filter(item => item.tabIndex === 0)).toEqual([button('Project sections', 'Overview')])
    const trigger = host.querySelector<HTMLButtonElement>('[aria-label="More project sections"][aria-haspopup="menu"]')!
    const menu = host.querySelector<HTMLElement>('[role="menu"]')!
    expect(trigger.dataset.active).toBe('true')
    expect(trigger.textContent).toContain('Operators')
    expect(menu.hidden).toBe(true)
    const operatorPanel = input('operators')!.closest('[role="tabpanel"]')!
    expect(document.getElementById(operatorPanel.getAttribute('aria-labelledby')!)?.textContent).toBe('Operators')
    await act(async () => trigger.click())
    expect(menu.hidden).toBe(false)
    expect(document.activeElement?.textContent).toBe('Operators')
    await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true })))
    expect(document.activeElement?.textContent).toBe('Extras')
    await act(async () => (document.activeElement as HTMLButtonElement).click())
    expect(window.location.hash).toBe('#extras')
    expect(menu.hidden).toBe(true)
    expect(trigger.textContent).toContain('Extras')
    expect(document.activeElement).toBe(trigger)
    expect(host.querySelector('[role="menuitemradio"][aria-checked="true"]')?.textContent).toBe('Extras')
    await traverse('back')
    expect(trigger.textContent).toContain('Operators')
    expect(input('operators')!.closest('[role="tabpanel"]')?.hasAttribute('hidden')).toBe(false)
    expect(mounts.operators).toBe(1)
  })

  it('dismisses overflow with Escape or outside interaction without changing the selected pane', async () => {
    await render()
    const trigger = host.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')!
    const menu = host.querySelector<HTMLElement>('[role="menu"]')!
    await act(async () => trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })))
    expect(menu.hidden).toBe(false)
    expect(document.activeElement?.textContent).toBe('Extras')
    await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(menu.hidden).toBe(true)
    expect(document.activeElement).toBe(trigger)
    await act(async () => trigger.click())
    await act(async () => document.body.dispatchEvent(new Event('pointerdown', { bubbles: true })))
    expect(menu.hidden).toBe(true)
    expect(selected('Project sections')).toBe('Overview')
    expect(window.location.hash).toBe('')
  })

  it('shows mobile Activity without remounting payment or the selected desktop pane', async () => {
    await render()
    await click('Project sections', 'Owners')
    const payment = input('payment')
    const you = input('you')
    await setMobile(true)
    await click('Project sections', 'Activity')
    expect(selected('Project sections')).toBe('Activity')
    expect(host.querySelector('.hpl-activity-selected')).not.toBeNull()
    await setMobile(false)
    expect(selected('Project sections')).toBe('Owners')
    expect(input('payment')).toBe(payment)
    expect(input('you')).toBe(you)
    expect(mounts.payment).toBe(1)
    expect(mounts.activity).toBe(1)
    expect(mounts.you).toBe(1)
  })

  it('accepts controlled navigation and leaves unrelated page anchors intact', async () => {
    const change = vi.fn()
    await render({ tab: 'overview', onTabChange: change })
    await render({ tab: 'stages', onTabChange: change })
    expect(selected('Project sections')).toBe('Stages')
    expect(window.location.hash).toBe('#stages')
    await act(async () => {
      window.history.replaceState(window.history.state, '', '#asset-description')
      window.dispatchEvent(new HashChangeEvent('hashchange'))
    })
    expect(selected('Project sections')).toBe('Stages')
    expect(window.location.hash).toBe('#asset-description')
    expect(window.location.search).toBe('?scenario=closed')
  })
})
