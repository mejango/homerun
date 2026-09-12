import React, { act } from 'react'
import { hydrateRoot } from 'react-dom/client'
import { renderToString } from 'react-dom/server'
import { expect, it } from 'vitest'
import { DemoPaymentResult } from '@/components/DemoPaymentResult'
import { demoPaymentResult } from '@/lib/demo-payment-result'
import { DEFAULT_NETWORK, projectNetwork } from '../web/network-model.mjs'

it('keeps tiny INCOME allocations on the ring when switching from FUND', async () => {
  const fund = demoPaymentResult(projectNetwork({ ...DEFAULT_NETWORK, investment: 0 }, 'raising'), 10_000, 100_000_000)
  const income = demoPaymentResult(projectNetwork({ ...DEFAULT_NETWORK, investment: 0, revenueMonths: 12 }, 'earning'), 100, 0)
  const host = document.createElement('div')
  host.innerHTML = renderToString(<DemoPaymentResult result={fund} />)
  document.body.append(host)
  let root: ReturnType<typeof hydrateRoot> | undefined
  try {
    await act(async () => { root = hydrateRoot(host, <DemoPaymentResult result={fund} />) })
    await act(async () => { root!.render(<DemoPaymentResult result={income} />) })
    expect(host.querySelectorAll('[data-payment-segment]')).toHaveLength(4)
    let offset = 0
    for (const part of income.allocations) {
      const path = host.querySelector(`[data-payment-segment="${part.key}"]`)!
      expect(path.tagName).toBe('path')
      const coordinates = path.getAttribute('d')!.match(/-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/g)!.map(Number)
      // Start, midpoint, and endpoint stay on the same circle, even below one pixel.
      for (const [index, share] of [[0, offset], [7, offset + part.percent / 2], [14, offset + part.percent]]) {
        const angle = share / 100 * 2 * Math.PI - Math.PI / 2
        expect(coordinates[index]).toBeCloseTo(52 + 40 * Math.cos(angle), 10)
        expect(coordinates[index + 1]).toBeCloseTo(52 + 40 * Math.sin(angle), 10)
      }
      offset += part.percent
    }
    const fresh = document.createElement('div')
    fresh.innerHTML = renderToString(<DemoPaymentResult result={income} />)
    expect(host.querySelector('svg')!.outerHTML).toBe(fresh.querySelector('svg')!.outerHTML)
  } finally {
    await act(async () => root?.unmount())
    host.remove()
  }
})

it('hydrates the ownership chart without changing its accessible SVG title', async () => {
  const baseline = projectNetwork({ ...DEFAULT_NETWORK, investment: 0 }, 'raising')
  const result = demoPaymentResult(baseline, 10_000, 100_000_000)
  const host = document.createElement('div')
  host.innerHTML = renderToString(<DemoPaymentResult result={result} />)
  document.body.append(host)
  const errors: unknown[] = []
  let root: ReturnType<typeof hydrateRoot> | undefined
  try {
    expect(host.querySelector('svg title')!.textContent).toBe('FUND ownership after this payment')
    await act(async () => {
      root = hydrateRoot(host, <DemoPaymentResult result={result} />, { onRecoverableError: error => errors.push(error) })
    })
    expect(errors).toEqual([])
    expect(host.querySelector('svg title')!.textContent).toBe('FUND ownership after this payment')
    expect(host.querySelector('svg')!.getAttribute('aria-label')).toContain('Your new FUND: 100,000,000 tokens')
  } finally {
    await act(async () => root?.unmount())
    host.remove()
  }
})
