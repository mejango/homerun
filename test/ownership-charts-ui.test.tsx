import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { OwnershipCharts } from '@/components/ProjectCharts'
import { projectNetwork } from '../web/network-model.mjs'
import { ownershipCharts } from '../web/ownership-charts.mjs'

type Projection = ReturnType<typeof projectNetwork>
const renderers = [
  { name: 'React saved-project preview', render: (projection: Projection) => renderToStaticMarkup(<OwnershipCharts projection={projection} />) },
  { name: 'retained prototype preview', render: ownershipCharts },
]

describe.each(renderers)('$name ownership accounting', ({ render }) => {
  it('shows the Owner separately and accounts for all tokens before and after Operator cash-outs', () => {
    for (const month of [0, 1, 24, 60]) {
      const projection = projectNetwork({ separateOwnerOperator: true, revenueMonths: month }, 'earning')
      const host = document.createElement('div')
      host.innerHTML = render(projection)
      for (const token of ['fund', 'income']) {
        const chart = host.querySelector(`[data-ownership-chart="${token}"]`)!
        const total = Number(chart.getAttribute('data-ownership-total'))
        const shown = [...chart.querySelectorAll('[data-owner-tokens]')].reduce((sum, row) => sum + Number(row.getAttribute('data-owner-tokens')), 0)
        expect(shown).toBeCloseTo(total, 5)
        const owner = chart.querySelector('[data-owner="owner"]')!
        expect(owner.textContent).toContain('Owner')
        expect(Number(owner.getAttribute('data-owner-tokens'))).toBeCloseTo(token === 'fund' ? projection.fundOwnerMint : projection.revOwnerTokens, 5)
      }
      expect(host.querySelector('[data-ownership-chart="fund"] [data-owner="operators"]')).toBeNull()
      if (month === 0) {
        expect(host.querySelector('[data-ownership-chart="income"] [data-owner="operators"]')).toBeNull()
        expect(projection.revOwnerTokens).toBe(100_000)
      }
    }
  })

  it('retains the combined Operator cohort in the Founder Haus demo', () => {
    const host = document.createElement('div')
    host.innerHTML = render(projectNetwork({ revenueMonths: 0 }, 'earning'))
    expect(host.querySelector('[data-owner="owner"]')).toBeNull()
    expect(host.querySelectorAll('[data-owner="operators"]')).toHaveLength(2)
    expect(host.textContent).toContain('Includes the operators’ allocation at purchase.')
  })
})
