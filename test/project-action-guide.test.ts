import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ProjectActionGuide, type ProjectActionGuideProps } from '../src/components/ProjectActionGuide'
import { projectActionIds, projectActionsFor, type ProjectActionSection } from '../src/lib/project-action-guide'
import { transactionCatalog, transactionStages } from '../src/lib/transaction-catalog'

describe('contextual project action placement', () => {
  it('places every project action once, keeping creation in the create flow', () => {
    const placed = Object.values(projectActionIds).flat()
    expect(new Set(placed).size).toBe(placed.length)
    expect([...placed].sort()).toEqual(transactionCatalog.filter(entry => entry.id !== 'create').map(entry => entry.id).sort())
  })

  it('only shows actions appropriate to the selected stage', () => {
    for (const { id: stage } of transactionStages) {
      for (const section of Object.keys(projectActionIds) as ProjectActionSection[]) {
        const actions = projectActionsFor(stage, section)
        for (const entry of [...actions.primary, ...actions.other]) expect(entry.stages).toContain(stage)
        if (section === 'stages') expect(actions.primary.length).toBeLessThanOrEqual(3)
      }
    }
  })

  it('keeps cash-outs beside account balances and removes payment shortcuts from Stages', () => {
    for (const [stage, ids] of [
      ['raising', ['fund-cashout']],
      ['refunding', ['refund']],
      ['earning', ['income-cashout']],
      ['liquidated', ['sale-claim', 'income-cashout']],
    ] as const) {
      const accounts = projectActionsFor(stage, 'accounts')
      for (const id of ids) {
        const entry = [...accounts.primary, ...accounts.other].find(entry => entry.id === id)
        expect(entry?.section).toBe('accounts')
        expect(entry?.href).toBe('#owners/accounts')
      }
      expect(projectActionsFor(stage, 'market')).toEqual({ primary: [], other: [] })
    }
    for (const { id: stage } of transactionStages) {
      expect(projectActionsFor(stage, 'stages').primary.some(entry => ['contribute', 'income-pay', 'fund-cashout', 'refund', 'sale-claim'].includes(entry.id))).toBe(false)
    }
  })

  it('changes the raise guidance at the goal without changing catalog permissions or other sections', () => {
    const ids = (stage: 'raising' | 'funded', goalReached = false) => projectActionsFor(stage, 'stages', goalReached).primary.map(entry => entry.id)
    expect(ids('raising')).toEqual(['pause', 'fail', 'return'])
    expect(ids('raising', true)).toEqual(['pause', 'withdraw', 'offchain'])
    expect(ids('funded')).toEqual(['pause', 'withdraw', 'offchain'])
    expect(ids('raising', false)).toEqual(['pause', 'fail', 'return'])
    for (const id of ['withdraw', 'offchain']) expect(transactionCatalog.find(entry => entry.id === id)?.stages).not.toContain('raising')
    for (const section of ['operators', 'accounts', 'market'] as const) {
      expect(projectActionsFor('raising', section, true)).toEqual(projectActionsFor('raising', section, false))
    }
  })

  it('keeps both refund phases free of raise controls even when the goal was reached', () => {
    for (const stage of ['refunding', 'refunded'] as const) {
      for (const goalReached of [false, true]) expect(projectActionsFor(stage, 'stages', goalReached)).toEqual({ primary: [], other: [] })
    }
    expect(projectActionsFor('earning', 'stages').primary.map(entry => entry.id)).toEqual(['initial-income', 'stake'])
    expect(projectActionsFor('liquidated', 'stages').primary.map(entry => entry.id)).toEqual(['unstake', 'collect'])
  })

  it('keeps burns and less frequent loan operations out of the primary actions', () => {
    const accounts = projectActionsFor('earning', 'accounts')
    expect(accounts.primary.some(entry => entry.id.endsWith('burn'))).toBe(false)
    expect(accounts.other.map(entry => entry.id)).toContain('fund-burn')
    expect(accounts.other.map(entry => entry.id)).toContain('income-burn')
    expect(projectActionsFor('earning', 'loans').other.map(entry => entry.id)).toEqual(['refinance', 'transfer-loan'])
  })

  it('preserves initial claims and earned rewards after the sale without assuming current FUND ownership', () => {
    const accounts = projectActionsFor('liquidated', 'accounts')
    expect(accounts.primary.map(entry => entry.id)).toEqual(['unstake', 'collect', 'initial-income'])
    expect(accounts.primary.find(entry => entry.id === 'initial-income')?.roleLabel).toBe('Snapshot recipient')
    expect(accounts.primary.find(entry => entry.id === 'collect')?.roleLabel).toBe('Reward recipient')
    expect(projectActionsFor('liquidated', 'loans').primary[0].id).toBe('repay')
    expect(projectActionsFor('refunded', 'stages').primary).toEqual([])
  })

  it('shows the purchase workflow before less likely operator actions and preserves setup conditions', () => {
    const actions = projectActionsFor('funded', 'operators')
    expect(actions.primary.map(entry => entry.id)).toEqual(['allowance', 'withdraw', 'enable-minting'])
    expect(actions.other.find(entry => entry.id === 'income-launch')?.setup).toBe(true)
    expect(actions.other.find(entry => entry.id === 'income-launch')?.description).toBe(transactionCatalog.find(entry => entry.id === 'income-launch')?.description)
  })
})

describe('contextual action controls', () => {
  const render = (props: ProjectActionGuideProps) => {
    const host = document.createElement('div')
    host.innerHTML = renderToStaticMarkup(createElement(ProjectActionGuide, props))
    return host
  }

  it('renders exact operator labels as dialog buttons and keeps account shortcuts as links', () => {
    for (const [goalReached, labels] of [
      [false, ['Pause raise', 'Open refunds', 'Inject funds']],
      [true, ['Pause raise', 'Withdraw funds', 'Mint tokens for offchain contributions']],
    ] as const) {
      const host = render({ stage: 'raising', section: 'stages', goalReached })
      const controls = [...host.querySelectorAll('[data-project-action]')]
      expect(controls.map(control => control.textContent)).toEqual(labels)
      expect(controls.every(control => control.tagName === 'BUTTON' && control.getAttribute('aria-haspopup') === 'dialog')).toBe(true)
      expect(host.querySelector('[data-action-stage]')?.getAttribute('data-action-stage')).toBe('raising')
    }
    const income = render({ stage: 'earning', section: 'stages' })
    expect([...income.querySelectorAll('[data-project-action]')].map(control => [control.tagName, control.getAttribute('href')])).toEqual([
      ['A', '#owners/accounts'], ['A', '#owners/accounts'],
    ])
  })

  it('honors each balance’s requested order with cash-out promoted and burning kept secondary', () => {
    const host = render({ stage: 'raising', section: 'accounts', onlyIds: ['fund-cashout', 'fund-transfer', 'fund-credit', 'fund-burn'] })
    expect([...host.querySelectorAll('.pag-actions > [data-project-action]')].map(control => control.getAttribute('data-project-action'))).toEqual(['fund-cashout', 'fund-transfer', 'fund-credit'])
    expect(host.querySelector('.pag-extra-actions[hidden] [data-project-action="fund-burn"]')).not.toBeNull()
    expect(host.querySelector('[data-project-action="fund-cashout"]')?.tagName).toBe('BUTTON')
  })

  it('preserves supplied callbacks and does not promote every filtered operator action', () => {
    const review = render({ stage: 'raising', section: 'stages', actionIds: ['fail'], ownerActionIds: { fail: 'enable_refunds' }, onAction: () => {} })
    expect(review.querySelector('[data-project-action="fail"]')?.getAttribute('data-owner-action')).toBe('enable_refunds')
    const advanced = render({ stage: 'funded', section: 'operators', onlyIds: ['operator-share', 'disable-minting', 'income-launch'] })
    expect(advanced.querySelectorAll('.pag-actions > [data-project-action]')).toHaveLength(0)
    expect(advanced.querySelectorAll('.pag-extra-actions[hidden] [data-project-action]')).toHaveLength(3)
  })
})
