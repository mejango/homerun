'use client'

import { useEffect, useId, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode } from 'react'

export type ProjectTab = 'overview' | 'stages' | 'owners' | 'shop' | 'extras' | 'operators'
type OwnerTab = 'accounts' | 'market' | 'settlement' | 'splits' | 'loans'
type AccountTab = 'you' | 'all'
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
const ACCOUNT_TABS: { key: AccountTab; label: string }[] = [
  { key: 'you', label: 'You' },
  { key: 'all', label: 'All' },
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
  level?: 'main' | 'owners' | 'accounts'
}) {
  const ready = useSyncExternalStore(subscribeToReadiness, () => true, () => false)
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
    <div className={`hpl-tabs hpl-tabs-${level}`} role="tablist" aria-label={label} aria-busy={!ready} onKeyDown={onKeyDown}>
      {tabs.map((item) => (
        <button
          key={item.key}
          id={`${id}-tab-${item.key}`}
          type="button"
          role="tab"
          aria-selected={active === item.key}
          aria-controls={`${id}-panel-${item.key}`}
          tabIndex={active === item.key ? 0 : -1}
          disabled={!ready}
          className={`hpl-tab${item.mobileOnly ? ' hpl-mobile-tab' : ''}`}
          onClick={() => onSelect(item.key)}
        >{item.label}</button>
      ))}
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
  const accountsId = `${id}-accounts`
  const [selected, setSelected] = useState<OwnerTab>('accounts')
  const [account, setAccount] = useState<AccountTab>('you')
  const visited = useRef(new Set<OwnerTab>())
  const visitedAccounts = useRef(new Set<AccountTab>())
  visited.current.add(selected)
  if (selected === 'accounts') visitedAccounts.current.add(account)

  useNavigationListener(() => {
    const [parent, child, accountChild] = hashParts()
    if (parent !== 'owners') return
    const next = OWNER_TABS.find((item) => item.key === child)?.key ?? 'accounts'
    setSelected(next)
    if (next === 'accounts') setAccount(accountChild === 'all' ? 'all' : 'you')
  })
  const chooseOwner = (next: OwnerTab) => {
    setSelected(next)
    navigateHash(next === 'accounts' ? ['owners', next, account] : ['owners', next])
  }
  const chooseAccount = (next: AccountTab) => {
    setAccount(next)
    navigateHash(['owners', 'accounts', next])
  }
  const panels: Record<OwnerTab, ReactNode> = {
    accounts: <>
      <TabStrip id={accountsId} label="Accounts" tabs={ACCOUNT_TABS} active={account} onSelect={chooseAccount} level="accounts" />
      {ACCOUNT_TABS.map(({ key }) => <div
        key={key}
        id={`${accountsId}-panel-${key}`}
        role="tabpanel"
        aria-labelledby={`${accountsId}-tab-${key}`}
        tabIndex={0}
        hidden={account !== key}
        className="hpl-account-panel"
      >{visitedAccounts.current.has(key) ? key === 'you' ? accountsYou : accountsAll : null}</div>)}
    </>,
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
