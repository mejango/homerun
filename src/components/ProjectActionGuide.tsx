'use client'

import { useId, useRef, useState, useSyncExternalStore } from 'react'
import { projectActionsFor, projectActionSections, type ProjectActionSection, type ProjectGuideAction } from '@/lib/project-action-guide'
import type { TransactionStage } from '@/lib/transaction-catalog'
import { ModalShell } from '@/components/ui/ModalShell'
import './project-action-guide.css'

export type ProjectActionGuideProps = {
  stage: TransactionStage
  section: ProjectActionSection
  /** Only list IDs here when onAction opens an existing, functioning demo review. */
  actionIds?: readonly string[]
  /** Limit controls to the balances or operation beside this group. */
  onlyIds?: readonly string[]
  ownerActionIds?: Readonly<Record<string, string>>
  onAction?: (id: string) => void
  onNavigate?: (section: ProjectActionSection, actionId: string) => void
}

const subscribeToReadiness = () => () => {}
const readyOnClient = () => true
const readyOnServer = () => false
const actionLabels: Readonly<Record<string, string>> = {
  contribute: 'Fund', pause: 'Pause or resume', close: 'Close raise', fail: 'Open refunds',
  return: 'Return funds', allowance: 'Set purchase allowance', withdraw: 'Withdraw for purchase',
  'enable-minting': 'Enable FUND minting', offchain: 'Issue offchain FUND', 'operator-share': 'Issue operator share',
  'disable-minting': 'Finish FUND minting', erc20: 'Deploy FUND token', 'sticky-setup': 'Create staking pool',
  'income-launch': 'Launch INCOME', sale: 'Open sale claims',
  'fund-credit': 'Claim FUND', 'fund-transfer': 'Transfer FUND', 'fund-bridge': 'Bridge FUND',
  'fund-burn': 'Burn FUND', 'fund-cashout': 'Cash out FUND', refund: 'Claim refund', 'sale-claim': 'Claim sale proceeds',
  'initial-income': 'Claim initial INCOME', stake: 'Stake FUND', unstake: 'Unstake FUND',
  vest: 'Start reward vesting', collect: 'Collect rewards', 'income-pay': 'Pay INCOME',
  reserved: 'Distribute INCOME', 'income-credit': 'Claim INCOME', 'income-transfer': 'Transfer INCOME',
  'income-bridge': 'Bridge INCOME', 'income-burn': 'Burn INCOME', 'income-cashout': 'Cash out INCOME',
  borrow: 'Borrow', repay: 'Repay loan', refinance: 'Refinance loan', 'transfer-loan': 'Transfer loan',
  scheduled: 'Collect scheduled allocation',
}
const tokenAccountActions = new Set(['fund-credit', 'fund-transfer', 'income-credit', 'income-transfer'])

/** Contextual demo controls. All signing stays in the verified live action forms. */
export function ProjectActionGuide({ stage, section, actionIds = [], onlyIds, ownerActionIds, onAction, onNavigate }: ProjectActionGuideProps) {
  const id = useId()
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const ready = useSyncExternalStore(subscribeToReadiness, readyOnClient, readyOnServer)
  const contextKey = `${stage}:${section}:${onlyIds?.join(',') ?? '*'}`
  const [view, setView] = useState<{ contextKey: string; moreOpen: boolean; selected: ProjectGuideAction | null }>({ contextKey, moreOpen: false, selected: null })
  // Changing stage or group dismisses its dialog instead of leaving stale controls open.
  if (view.contextKey !== contextKey) setView({ contextKey, moreOpen: false, selected: null })
  const current = view.contextKey === contextKey ? view : { contextKey, moreOpen: false, selected: null }
  const groups = projectActionsFor(stage, section)
  const candidates = [...groups.primary, ...groups.other].filter(entry => !onlyIds || onlyIds.includes(entry.id))
  // Filter before the final priority split so each token keeps its own Claim / Transfer controls.
  const primary = onlyIds
    ? candidates.filter(entry => groups.primary.some(chosen => chosen.id === entry.id) || (section === 'accounts' && tokenAccountActions.has(entry.id))).slice(0, 3)
    : groups.primary
  const other = candidates.filter(entry => !primary.some(chosen => chosen.id === entry.id))
  const selected = current.selected && candidates.find(entry => entry.id === current.selected?.id)
  if (!candidates.length) return null

  const control = (entry: ProjectGuideAction) => {
    const review = onAction && actionIds.includes(entry.id)
    const label = actionLabels[entry.id] ?? entry.title
    if (section === 'stages' && !review) return <a
      key={entry.id}
      className="outline-button pag-control"
      data-project-action={entry.id}
      href={entry.href}
      onClick={onNavigate ? event => { event.preventDefault(); onNavigate(entry.section, entry.id) } : undefined}
    >{label}</a>
    return <button
      key={entry.id}
      className="outline-button pag-control"
      type="button"
      disabled={!ready}
      aria-haspopup="dialog"
      data-project-action={entry.id}
      data-owner-action={review ? ownerActionIds?.[entry.id] : undefined}
      onClick={event => {
        if (review) onAction(entry.id)
        else {
          triggerRef.current = event.currentTarget
          setView({ ...current, selected: entry })
        }
      }}
    >{label}</button>
  }

  return <section className="project-action-guide" aria-labelledby={id} data-action-section={section} data-action-stage={stage}>
    <span className="pag-group-label" id={id}>{projectActionSections[section].title}</span>
    <div className="pag-actions">
      {primary.map(control)}
      {other.length > 0 && <>
        <button className="pag-more" type="button" disabled={!ready} aria-expanded={current.moreOpen} aria-controls={`${id}-more`} onClick={() => setView({ ...current, moreOpen: !current.moreOpen })}>
          More actions <span aria-hidden="true">{current.moreOpen ? '−' : '+'}</span>
        </button>
        <div className="pag-extra-actions" id={`${id}-more`} hidden={!current.moreOpen}>{other.map(control)}</div>
      </>}
    </div>
    {selected && <ModalShell title={selected.title} subtitle={`${selected.roleLabel}. Demo preview.`} onClose={() => {
      const trigger = triggerRef.current
      setView({ ...current, selected: null })
      requestAnimationFrame(() => { if (trigger?.isConnected) trigger.focus({ preventScroll: true }) })
    }}>
      <div className="pag-dialog-detail">
        <p className="pag-description">{selected.description}</p>
        {selected.setup && <p className="pag-setup">Requires verified INCOME / Sticky setup.</p>}
        <p className="pag-demo-note">No transaction is submitted from this demo.</p>
      </div>
    </ModalShell>}
  </section>
}
