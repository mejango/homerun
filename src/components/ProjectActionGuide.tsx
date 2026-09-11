'use client'

import { useId } from 'react'
import { projectActionsFor, projectActionSections, type ProjectActionSection, type ProjectGuideAction } from '@/lib/project-action-guide'
import type { TransactionStage } from '@/lib/transaction-catalog'
import './project-action-guide.css'

export type ProjectActionGuideProps = {
  stage: TransactionStage
  section: ProjectActionSection
  /** Only list IDs here when onAction opens an existing, functioning demo review. */
  actionIds?: readonly string[]
  onAction?: (id: string) => void
  onNavigate?: (section: ProjectActionSection, actionId: string) => void
}

/** Inline demo guidance. All signing stays in the verified live action forms. */
export function ProjectActionGuide({ stage, section, actionIds = [], onAction, onNavigate }: ProjectActionGuideProps) {
  const id = useId()
  const { primary, other } = projectActionsFor(stage, section)
  if (!primary.length && !other.length) return null
  const stages = section === 'stages'

  const navigate = (entry: ProjectGuideAction) => (
    <a className="pag-link" href={entry.href} onClick={onNavigate ? event => { event.preventDefault(); onNavigate(entry.section, entry.id) } : undefined}>
      {projectActionSections[entry.section].tabLabel} <span aria-hidden="true">→</span>
    </a>
  )

  const content = (entry: ProjectGuideAction) => <>
    <p className="pag-description">{entry.description}</p>
    {entry.setup && <p className="pag-setup">Requires verified INCOME / Sticky setup.</p>}
    {onAction && actionIds.includes(entry.id) && <button className="pag-review" type="button" onClick={() => onAction(entry.id)}>Preview in demo <span aria-hidden="true">→</span></button>}
    {stages && navigate(entry)}
  </>

  const row = (entry: ProjectGuideAction) => <li key={entry.id} data-project-action={entry.id}>
    {stages ? <div className="pag-next-action">
      <div className="pag-action-heading"><h4>{entry.title}</h4><span className="pag-role">{entry.roleLabel}</span></div>
      {content(entry)}
    </div> : <details className="pag-action">
      <summary><span>{entry.title}</span><span className="pag-role">{entry.roleLabel}</span></summary>
      <div className="pag-action-content">{content(entry)}</div>
    </details>}
  </li>

  return <section className="project-action-guide" aria-labelledby={id} data-action-section={section} data-action-stage={stage}>
    <h3 id={id}>{projectActionSections[section].title}</h3>
    <p className="pag-note">{stages && stage === 'funded' ? 'Complete the purchase and FUND allocations before launching INCOME.' : 'Demo previews. Live actions depend on the project and your permissions.'}</p>
    {primary.length > 0 && <ul className="pag-actions">{primary.map(row)}</ul>}
    {other.length > 0 && <details className="pag-other">
      <summary>Other actions <span className="pag-count">{other.length}</span></summary>
      <ul className="pag-actions">{other.map(row)}</ul>
    </details>}
  </section>
}
