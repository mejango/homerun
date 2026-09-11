import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { LiveProjectActions } from '@/components/LiveProjectActions'

describe('contextual live project actions', () => {
  it('waits for verified state before suggesting actions', () => {
    expect(renderToStaticMarkup(<LiveProjectActions token="FUND" />)).toBe('')
    expect(renderToStaticMarkup(<LiveProjectActions token="INCOME" />)).toBe('')
  })

  it('does not turn a payment pause into a purchase or failure claim', () => {
    const html = renderToStaticMarkup(<LiveProjectActions token="FUND" state={{ paymentsPaused: true, cashOutsEnabled: true, mintingEnabled: true, hasLinkedIncome: false }} />)
    expect(html).toContain('Cash out FUND')
    expect(html).not.toMatch(/Issue FUND|purchase|refund|sale|initial INCOME/)
  })

  it('suggests issuance only with contributions and cash-outs both closed', () => {
    const html = renderToStaticMarkup(<LiveProjectActions token="FUND" state={{ paymentsPaused: true, cashOutsEnabled: false, mintingEnabled: true, hasLinkedIncome: true }} />)
    expect(html).toContain('Issue FUND')
    expect(html).toContain('Manage treasury withdrawals')
    expect(html).toContain('Check initial INCOME allocation')
    expect(html).not.toContain('Cash out FUND')
  })

  it('keeps loan management discoverable while new cash-outs are locked', () => {
    const html = renderToStaticMarkup(<LiveProjectActions token="INCOME" state={{ cashOutsEnabled: false, hasInitialAllocation: false }} />)
    expect(html).toContain('href="#owners/loans"')
    expect(html).toContain('Manage loans')
    expect(html).not.toMatch(/Cash out INCOME|initial INCOME/)
  })
})
