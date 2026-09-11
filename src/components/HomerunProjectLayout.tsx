'use client'

import { useEffect, useId, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode } from 'react'
import { ProjectOverflowIcon, ProjectTabIcon } from './ProjectTabIcon'

export type ProjectTab = 'overview' | 'stages' | 'owners' | 'shop' | 'extras' | 'operators'
type OwnerTab = 'accounts' | 'market' | 'settlement' | 'splits' | 'loans'
type NavigationTab = ProjectTab | 'activity'

const PROJECT_TABS: { key: ProjectTab; label: string }[] = [
  { key: 'overview', label: 'Overview' },
  { key: 'stages', label: 'Stages' },
  { key: 'owners', label: 'Owners' },
  { key: 'shop', label: 'Shop' },
  { key: 'extras', label: 'Extras' },
  { key: 'operators', label: 'Operators' },
]
const OWNER_TABS: { key: OwnerTab; label: string }[] = [
  { key: 'accounts', label: 'Accounts' },
  { key: 'market', label: 'Market' },
  { key: 'settlement', label: 'Settlement' },
  { key: 'splits', label: 'Splits' },
  { key: 'loans', label: 'Loans' },
]
const NAVIGATION_EVENT = 'homerun:project-navigation'
const subscribeToReadiness = () => () => {}

function hashParts() {
  return window.location.hash.slice(1).split('/').map((part) => part.toLowerCase())
}

/** Tabs are local state. Keep Next's route and transaction providers mounted. */
function navigateHash(parts: string[]) {
  const url = new URL(window.location.href)
  url.hash = parts.join('/')
  if (url.href === window.location.href) return
  const nativePush = Object.getPrototypeOf(window.history)?.pushState as History['pushState'] | undefined
  if (nativePush) nativePush.call(window.history, window.history.state, '', url.href)
  else window.history.pushState(window.history.state, '', url.href)
  window.dispatchEvent(new Event(NAVIGATION_EVENT))
}

function useNavigationListener(listener: () => void) {
  const callback = useRef(listener)
  callback.current = listener
  useEffect(() => {
    const apply = () => callback.current()
    apply()
    window.addEventListener('hashchange', apply)
    window.addEventListener('popstate', apply)
    window.addEventListener(NAVIGATION_EVENT, apply)
    return () => {
      window.removeEventListener('hashchange', apply)
      window.removeEventListener('popstate', apply)
      window.removeEventListener(NAVIGATION_EVENT, apply)
    }
  }, [])
}

function TabStrip<T extends string>({
  id, label, tabs, active, onSelect, level = 'main',
}: {
  id: string
  label: string
  tabs: { key: T; label: string; mobileOnly?: boolean }[]
  active: T
  onSelect: (key: T) => void
  level?: 'main' | 'owners'
}) {
  const ready = useSyncExternalStore(subscribeToReadiness, () => true, () => false)
  const overflowTabs = level === 'main' ? tabs.filter((item) => item.key === 'extras' || item.key === 'operators') : []
  const visibleTabs = tabs.filter((item) => !overflowTabs.includes(item))
  const overflowSelected = overflowTabs.some((item) => item.key === active)
  const fallbackFocus = visibleTabs.find((item) => !item.mobileOnly)?.key
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const overflowRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const requestedMenuFocus = useRef<'first' | 'last' | 'active'>('active')

  useEffect(() => {
    if (!menuOpen) return
    const buttons = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') ?? [])
    const selected = buttons.find((button) => button.getAttribute('aria-checked') === 'true')
    const target = requestedMenuFocus.current === 'last' ? buttons.at(-1)
      : requestedMenuFocus.current === 'first' ? buttons[0] : selected ?? buttons[0]
    target?.focus({ preventScroll: true })
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !overflowRef.current?.contains(event.target)) setMenuOpen(false)
    }
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      setMenuOpen(false)
      triggerRef.current?.focus({ preventScroll: true })
    }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('pointerdown', outside)
      document.removeEventListener('keydown', escape)
    }
  }, [menuOpen])

  const openMenu = (focus: 'first' | 'last' | 'active') => {
    requestedMenuFocus.current = focus
    setMenuOpen(true)
  }
  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Tab') {
      setMenuOpen(false)
      triggerRef.current?.focus({ preventScroll: true })
      return
    }
    if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return
    const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'))
    const index = buttons.indexOf(event.target as HTMLButtonElement)
    if (index < 0) return
    event.preventDefault()
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
      : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
    buttons[next].focus({ preventScroll: true })
  }
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
      .filter((button) => !button.disabled && button.getClientRects().length > 0)
    const index = buttons.indexOf(event.target as HTMLButtonElement)
    if (index < 0 || buttons.length === 0) return
    event.preventDefault()
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
      : (index + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length
    buttons[next].focus({ preventScroll: true })
    buttons[next].scrollIntoView({ block: 'nearest', inline: 'nearest' })
    buttons[next].click()
  }
  return (
    <div className={`hpl-navigation-bar hpl-navigation-${level}`}>
    <div className={`hpl-tabs hpl-tabs-${level}`} role="tablist" aria-label={label} aria-orientation="horizontal" aria-busy={!ready} onKeyDown={onKeyDown}>
      {visibleTabs.map((item) => (
        <button
          key={item.key}
          id={`${id}-tab-${item.key}`}
          type="button"
          role="tab"
          aria-selected={active === item.key}
          aria-controls={`${id}-panel-${item.key}`}
          tabIndex={active === item.key || (overflowSelected && item.key === fallbackFocus) ? 0 : -1}
          disabled={!ready}
          className={`hpl-tab${item.mobileOnly ? ' hpl-mobile-tab' : ''}`}
          onClick={() => onSelect(item.key)}
        >{level === 'main' && <ProjectTabIcon label={item.label} />}<span>{item.label}</span></button>
      ))}
    </div>
    {overflowTabs.length > 0 && <div className="hpl-overflow" ref={overflowRef}>
      <button
        ref={triggerRef}
        type="button"
        className="hpl-overflow-trigger"
        aria-label="More project sections"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        aria-controls={`${id}-overflow-menu`}
        data-active={overflowSelected || undefined}
        disabled={!ready}
        onClick={() => menuOpen ? setMenuOpen(false) : openMenu('active')}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
          event.preventDefault()
          openMenu(event.key === 'ArrowUp' ? 'last' : 'first')
        }}
      >
        {overflowSelected && <span className="hpl-overflow-current">{overflowTabs.find((item) => item.key === active)?.label}</span>}
        <ProjectOverflowIcon />
      </button>
      <div
        id={`${id}-overflow-menu`}
        ref={menuRef}
        role="menu"
        aria-label="More project sections"
        className="hpl-overflow-menu"
        hidden={!menuOpen}
        onKeyDown={onMenuKeyDown}
      >{overflowTabs.map((item) => <button
        key={item.key}
        type="button"
        role="menuitemradio"
        aria-checked={active === item.key}
        tabIndex={-1}
        onClick={() => {
          setMenuOpen(false)
          onSelect(item.key)
          triggerRef.current?.focus({ preventScroll: true })
        }}
      ><ProjectTabIcon label={item.label} /><span>{item.label}</span></button>)}</div>
      {overflowTabs.map((item) => <span key={item.key} id={`${id}-tab-${item.key}`} className="hpl-overflow-label">{item.label}</span>)}
    </div>}
    </div>
  )
}

/** Shared project shell. Slots contain the existing model or verified live controls. */
export function HomerunProjectLayout({
  title, logo, metadata = [], notice, actions, payment, activity,
  overview, stages, owners, shop, extras, operators, defaultTab = 'overview', tab, onTabChange,
}: {
  title: ReactNode
  logo?: ReactNode
  metadata?: ReactNode[]
  notice?: ReactNode
  actions?: ReactNode
  payment: ReactNode
  activity: ReactNode
  overview: ReactNode
  stages: ReactNode
  owners: ReactNode
  shop: ReactNode
  extras: ReactNode
  operators: ReactNode
  defaultTab?: ProjectTab
  tab?: ProjectTab
  onTabChange?: (tab: ProjectTab) => void
}) {
  const id = useId()
  const [selected, setSelected] = useState<ProjectTab>(tab ?? defaultTab)
  const [activitySelected, setActivitySelected] = useState(false)
  const [singleColumn, setSingleColumn] = useState(false)
  const visited = useRef(new Set<ProjectTab>())
  const remembered = useRef<Partial<Record<ProjectTab, string[]>>>({})
  const lastControlledTab = useRef(tab)
  const current = tab ?? selected
  visited.current.add(current)

  useNavigationListener(() => {
    const [parent, ...children] = hashParts()
    if (parent === 'activity') {
      setActivitySelected(true)
      return
    }
    const found = PROJECT_TABS.find((item) => item.key === parent)
    if (!found && parent) return // Other page anchors are not project navigation.
    const next = found?.key ?? defaultTab
    remembered.current[next] = children
    setActivitySelected(false)
    setSelected(next)
    onTabChange?.(next)
  })

  useEffect(() => {
    const query = window.matchMedia('(max-width: 800px)')
    const apply = () => setSingleColumn(query.matches)
    apply()
    query.addEventListener('change', apply)
    return () => query.removeEventListener('change', apply)
  }, [])

  useEffect(() => {
    if (tab === lastControlledTab.current) return
    lastControlledTab.current = tab
    if (!tab) return
    setSelected(tab)
    setActivitySelected(false)
    if (hashParts()[0] !== tab) navigateHash([tab, ...(remembered.current[tab] ?? [])])
  }, [tab])

  const choose = (next: NavigationTab) => {
    const [previous, ...children] = hashParts()
    if (PROJECT_TABS.some((item) => item.key === previous)) remembered.current[previous as ProjectTab] = children
    if (next === 'activity') {
      setActivitySelected(true)
      navigateHash(['activity'])
      return
    }
    setActivitySelected(false)
    setSelected(next)
    onTabChange?.(next)
    navigateHash([next, ...(remembered.current[next] ?? [])])
  }
  const activityActive = singleColumn && activitySelected
  const panels: Record<ProjectTab, ReactNode> = { overview, stages, owners, shop, extras, operators }
  const items = metadata.filter((item) => item !== null && item !== undefined && item !== false)

  return (
    <div className="homerun-project-layout" data-project-tab={activityActive ? 'activity' : current}>
      <header className="hpl-header">
        <div className="hpl-heading-row">
          <div className="hpl-project-heading">
            {logo && <div className="hpl-logo">{logo}</div>}
            <div className="hpl-identity">
              <h1 className="hpl-title">{title}</h1>
              {items.length > 0 && <div className="hpl-metadata">
                {items.map((item, index) => <span className="hpl-metadata-item" key={index}>
                  {index > 0 && <span className="hpl-pip" aria-hidden="true">|</span>}{item}
                </span>)}
              </div>}
            </div>
          </div>
          {actions && <div className="hpl-header-actions">{actions}</div>}
        </div>
        {notice && <div className="hpl-notice">{notice}</div>}
      </header>
      <div className="hpl-columns">
        <aside className="hpl-sidebar" aria-label="Payments and activity">
          <div className="hpl-payment">{payment}</div>
          <div
            id={`${id}-panel-activity`}
            className={`hpl-activity${activityActive ? ' hpl-activity-selected' : ''}`}
            role={singleColumn ? 'tabpanel' : undefined}
            aria-labelledby={singleColumn ? `${id}-tab-activity` : undefined}
            tabIndex={singleColumn ? 0 : undefined}
          >{activity}</div>
        </aside>
        <div className="hpl-main">
          <div className="hpl-main-navigation">
            <TabStrip<NavigationTab>
              id={id}
              label="Project sections"
              tabs={[{ key: 'activity', label: 'Activity', mobileOnly: true }, ...PROJECT_TABS]}
              active={activityActive ? 'activity' : current}
              onSelect={choose}
            />
          </div>
          <div className={`hpl-panels${activityActive ? ' hpl-panels-inactive' : ''}`}>
            {PROJECT_TABS.map(({ key }) => <div
              key={key}
              id={`${id}-panel-${key}`}
              role="tabpanel"
              aria-labelledby={`${id}-tab-${key}`}
              tabIndex={0}
              hidden={current !== key}
              className="hpl-panel"
            >{visited.current.has(key) ? panels[key] : null}</div>)}
          </div>
        </div>
      </div>
    </div>
  )
}

/** Both token types share the same account, market and settlement navigation. */
export function OwnersTabs({ accountsYou, accountsAll, market, settlement, splits, loans }: {
  accountsYou: ReactNode
  accountsAll: ReactNode
  market: ReactNode
  settlement: ReactNode
  splits: ReactNode
  loans: ReactNode
}) {
  const id = useId()
  const [selected, setSelected] = useState<OwnerTab>('accounts')
  const visited = useRef(new Set<OwnerTab>())
  visited.current.add(selected)

  useNavigationListener(() => {
    // Older /accounts/you and /accounts/all links both open the full account view.
    const [parent, child] = hashParts()
    if (parent !== 'owners') return
    const next = OWNER_TABS.find((item) => item.key === child)?.key ?? 'accounts'
    setSelected(next)
  })
  const chooseOwner = (next: OwnerTab) => {
    setSelected(next)
    navigateHash(['owners', next])
  }
  const panels: Record<OwnerTab, ReactNode> = {
    accounts: <div className="hpl-accounts-stack">
      <div className="hpl-account-section" data-account-section="you">{accountsYou}</div>
      <div className="hpl-account-section" data-account-section="all">{accountsAll}</div>
    </div>,
    market, settlement, splits, loans,
  }
  return <div className="hpl-owners">
    <TabStrip id={id} label="Ownership sections" tabs={OWNER_TABS} active={selected} onSelect={chooseOwner} level="owners" />
    {OWNER_TABS.map(({ key }) => <div
      key={key}
      id={`${id}-panel-${key}`}
      role="tabpanel"
      aria-labelledby={`${id}-tab-${key}`}
      tabIndex={0}
      hidden={selected !== key}
      className="hpl-owner-panel"
    >{visited.current.has(key) ? panels[key] : null}</div>)}
  </div>
}
