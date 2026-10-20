import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Address } from 'viem'

const runtime = vi.hoisted(() => ({
  pending: null as null | { intent: Record<string, unknown>; submitted: boolean; status: Record<string, unknown> | null; accountId?: string },
  prepare: vi.fn(), clear: vi.fn(), quote: vi.fn(), verify: vi.fn(),
}))
vi.mock('wagmi', () => ({ usePublicClient: () => ({}) }))
vi.mock('@/hooks/useWallet', () => ({ useWallet: () => ({ address: '0x1111111111111111111111111111111111111111' }) }))
vi.mock('@/providers/wallet-config', () => ({ CENTER_WALLET_CONFIG: { issuer: 'https://signa.center' } }))
vi.mock('@/providers/center-runtime', () => ({ centerWalletClient: () => ({}) }))
vi.mock('@/lib/project-pay-quote', () => ({ prepareProjectPayQuote: runtime.quote }))
vi.mock('@/lib/center-payment', async importOriginal => ({
  ...await importOriginal<typeof import('@/lib/center-payment')>(),
  createHomerunPayment: () => ({ pending: () => runtime.pending, prepare: runtime.prepare, clear: runtime.clear, refresh: vi.fn(), submit: vi.fn(), complete: vi.fn() }),
}))

import CenterProjectPayment from '@/components/CenterProjectPayment'

const SHORTFALL = 'This payment would get fewer tokens than your minimum, so lower your minimum or try again.'
const intent = { projectId: '7', token: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', terminal: '0x2222222222222222222222222222222222222222', amount: '5000000', minimumReturnedTokens: '99', returnPath: '/project/8453/7' }
const OWNER = 'eip155:8453:0x1111111111111111111111111111111111111111'
const reverted = (observation: Record<string, unknown>) => ({ status: 'reverted', expectedPayment: { minimumReturnedTokens: '99' }, transactionHash: `0x${'ab'.repeat(32)}`, observation: { state: 'reverted', ...observation } })

describe('Juicebox wallet payment failure', () => {
  let host: HTMLDivElement, root: Root
  beforeEach(() => {
    runtime.pending = null
    runtime.prepare.mockReset().mockResolvedValue({ approvalUrl: 'https://signa.center/wallet/payment?review=next' })
    runtime.clear.mockReset().mockImplementation(() => { runtime.pending = null })
    runtime.quote.mockReset().mockResolvedValue({ minimumTokenCount: 97n, metadata: '0x' })
    runtime.verify.mockReset().mockResolvedValue({ blockNumber: 1n })
    host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  })
  afterEach(async () => { await act(async () => root.unmount()); host.remove() })
  async function render() {
    await act(async () => root.render(<CenterProjectPayment chainId={8453} projectId={7n} tokenLabel="FUND" title="Contribute" paused={false} verify={runtime.verify as (account: Address) => Promise<{ blockNumber: bigint }>} />))
  }
  const buttons = () => [...host.querySelectorAll('button')].map(button => button.textContent)

  it("shows Signa's reason for a reverted payment and prepares it again with the looser minimum", async () => {
    runtime.pending = { intent, submitted: true, accountId: OWNER, status: reverted({ payFailure: { reason: 'TERMINAL_UNDER_MIN', received: '98', minimum: '99', adjustable: 'minimum', message: SHORTFALL } }) }
    await render()
    expect(host.textContent).toContain(SHORTFALL)
    expect(host.textContent).not.toContain('The payment reverted.')
    expect(host.querySelector<HTMLInputElement>('input[type="number"]')?.value).toBe('2.5')
    const again = [...host.querySelectorAll('button')].find(button => button.textContent === 'Review again')!
    await act(async () => again.click())
    await vi.waitFor(() => expect(runtime.prepare).toHaveBeenCalled())
    expect(runtime.clear).toHaveBeenCalledOnce()
    expect(runtime.quote).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ amount: 5_000_000n, slippageBps: 250n, directTerminalOnly: true }))
    expect(runtime.prepare).toHaveBeenCalledWith(expect.objectContaining({ amount: '5000000', minimumReturnedTokens: '97', slippageBps: 250 }))
    await vi.waitFor(() => expect(host.querySelector('iframe')).not.toBeNull())
  })

  it('says a payment reverted when Signa sends no reason, and prepares it again', async () => {
    runtime.pending = { intent, submitted: true, accountId: OWNER, status: reverted({}) }
    await render()
    expect(host.textContent).toContain('The payment reverted.')
    expect(host.querySelector('input[type="number"]')).toBeNull()
    expect(buttons()).toContain('Close payment')
    await act(async () => [...host.querySelectorAll('button')].find(button => button.textContent === 'Review again')!.click())
    await vi.waitFor(() => expect(runtime.prepare).toHaveBeenCalled())
    // Prepared again at the payment's own tolerance: the fresh preparation says why, if it fails again.
    expect(runtime.quote).toHaveBeenCalledWith(expect.anything(), expect.not.objectContaining({ slippageBps: expect.anything() }))
    expect(runtime.prepare.mock.calls[0]![0]).not.toHaveProperty('slippageBps')
  })

  it("offers no lower minimum for a reason a minimum can't fix", async () => {
    runtime.pending = { intent, submitted: true, accountId: OWNER, status: reverted({ payFailure: { reason: 'PAYMENTS_PAUSED', message: 'This project has paused payments.' } }) }
    await render()
    expect(host.textContent).toContain('This project has paused payments.')
    expect(buttons()).not.toContain('Review again')
  })
  it("offers another wallet no retry of the payment it didn't make", async () => {
    runtime.pending = { intent, submitted: true, accountId: 'eip155:8453:0x9999999999999999999999999999999999999999', status: reverted({ payFailure: { reason: 'TERMINAL_UNDER_MIN', received: '98', minimum: '99', adjustable: 'minimum', message: SHORTFALL } }) }
    await render()
    expect(host.textContent).toContain(SHORTFALL)
    expect(buttons()).not.toContain('Review again')
    expect(host.querySelector('input[type="number"]')).toBeNull()
  })
  it('says a payment would return no tokens, and offers no minimum of zero', async () => {
    runtime.pending = { intent, submitted: true, accountId: OWNER, status: reverted({ payFailure: { reason: 'TERMINAL_UNDER_MIN', received: '0', minimum: '99', zeroFill: true, message: 'This payment would return no tokens.' } }) }
    await render()
    expect(host.textContent).toContain('This payment would return no tokens.')
    expect(buttons()).not.toContain('Review again')
  })
  it("offers no looser minimum when Signa doesn't say the minimum is adjustable", async () => {
    runtime.pending = { intent, submitted: true, accountId: OWNER, status: reverted({ payFailure: { reason: 'TERMINAL_UNDER_MIN', received: '98', minimum: '99', message: SHORTFALL } }) }
    await render()
    expect(host.textContent).toContain(SHORTFALL)
    expect(host.querySelector('input[type="number"]')).toBeNull()
  })
})
