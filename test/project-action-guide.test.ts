import { describe, expect, it } from 'vitest'
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

  it('links payments to the persistent payment panel and cash-outs to Market', () => {
    const stage = projectActionsFor('raising', 'stages').primary
    expect(stage.find(entry => entry.id === 'contribute')?.href).toBe('#pay-panel')
    expect(stage.find(entry => entry.id === 'fund-cashout')?.href).toBe('#owners/market')
    expect(projectActionsFor('raising', 'market').primary.map(entry => entry.id)).toEqual(['fund-cashout'])
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
