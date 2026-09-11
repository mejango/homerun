import React, { act } from 'react'
import { hydrateRoot } from 'react-dom/client'
import { renderToString } from 'react-dom/server'
import { expect, it } from 'vitest'
import { DemoPaymentResult } from '@/components/DemoPaymentResult'
import { demoPaymentResult } from '@/lib/demo-payment-result'
import { DEFAULT_NETWORK, projectNetwork } from '../web/network-model.mjs'

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
