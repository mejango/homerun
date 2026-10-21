import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Address } from 'viem'

const runtime = vi.hoisted(() => ({
  pending: null as null | { intent: Record<string, unknown>; submitted: boolean; status: Record<string, unknown> | null; accountId?: string },
  prepare: vi.fn(), clear: vi.fn(), quote: vi.fn(), verify: vi.fn(), submit: vi.fn(), retire: vi.fn(), refresh: vi.fn(),
}))
vi.mock('wagmi', () => ({ usePublicClient: () => ({}) }))
vi.mock('@/hooks/useWallet', () => ({ useWallet: () => ({ address: '0x1111111111111111111111111111111111111111' }) }))
vi.mock('@/providers/wallet-config', () => ({ CENTER_WALLET_CONFIG: { issuer: 'https://signa.center' } }))
vi.mock('@/providers/center-runtime', () => ({ centerWalletClient: () => ({}) }))
vi.mock('@/lib/project-pay-quote', () => ({ prepareProjectPayQuote: runtime.quote }))
vi.mock('@/lib/center-payment', async importOriginal => ({
  ...await importOriginal<typeof import('@/lib/center-payment')>(),
  createHomerunPayment: () => ({ pending: () => runtime.pending, prepare: runtime.prepare, clear: runtime.clear, refresh: runtime.refresh, submit: runtime.submit, retire: runtime.retire, complete: vi.fn() }),
}))

import CenterProjectPayment from '@/components/CenterProjectPayment'

const SHORTFALL = 'This payment would get fewer tokens than your minimum, so lower your minimum or try again.'
const intent = { projectId: '7', token: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', terminal: '0x2222222222222222222222222222222222222222', amount: '5000000', minimumReturnedTokens: '99', returnPath: '/project/8453/7' }
const OWNER = 'eip155:8453:0x1111111111111111111111111111111111111111'
// Signa's client attaches the SDK's own PayFailure (bigint amounts, zeroFill and adjustable) to a reverted status.
const reverted = (fields: Record<string, unknown>) => ({ status: 'reverted', expectedPayment: { minimumReturnedTokens: '99' }, transactionHash: `0x${'ab'.repeat(32)}`, observation: { state: 'reverted' }, ...fields })
const UNDER_MIN = { reason: 'TERMINAL_UNDER_MIN', received: 98n, minimum: 99n, zeroFill: false, adjustable: 'minimum', message: SHORTFALL }

describe('Juicebox wallet payment failure', () => {
  let host: HTMLDivElement, root: Root
  beforeEach(() => {
    runtime.pending = null
    runtime.prepare.mockReset().mockResolvedValue({ approvalUrl: 'https://signa.center/wallet/payment?review=next' })
    runtime.clear.mockReset().mockImplementation(() => { runtime.pending = null })
    runtime.quote.mockReset().mockResolvedValue({ minimumTokenCount: 97n, metadata: '0x' })
    runtime.verify.mockReset().mockResolvedValue({ blockNumber: 1n })
    runtime.submit.mockReset(); runtime.retire.mockReset(); runtime.refresh.mockReset()
    host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  })
  afterEach(async () => { await act(async () => root.unmount()); host.remove() })
  async function render() {
    await act(async () => root.render(<CenterProjectPayment chainId={8453} projectId={7n} tokenLabel="FUND" title="Contribute" paused={false} verify={runtime.verify as (account: Address) => Promise<{ blockNumber: bigint }>} />))
  }
  const buttons = () => [...host.querySelectorAll('button')].map(button => button.textContent)

  it("shows Signa's reason for a reverted payment and prepares it again with the looser minimum", async () => {
    runtime.pending = { intent, submitted: true, accountId: OWNER, status: reverted({ payFailure: UNDER_MIN }) }
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

  it("offers no lower minimum for a reason a minimum can't fix, only a fresh review", async () => {
    runtime.pending = { intent, submitted: true, accountId: OWNER, status: reverted({ payFailure: { reason: 'PAYMENTS_PAUSED', message: 'This project has paused payments.' } }) }
    await render()
    expect(host.textContent).toContain('This project has paused payments.')
    // Prepared again at the same tolerance: the fresh preparation says whether it still fails.
    expect(buttons()).toContain('Review again')
    expect(host.querySelector('input[type="number"]')).toBeNull()
  })
  it("offers another wallet no retry of the payment it didn't make", async () => {
    runtime.pending = { intent, submitted: true, accountId: 'eip155:8453:0x9999999999999999999999999999999999999999', status: reverted({ payFailure: UNDER_MIN }) }
    await render()
    expect(host.textContent).toContain(SHORTFALL)
    expect(buttons()).not.toContain('Review again')
    expect(host.querySelector('input[type="number"]')).toBeNull()
  })
  it('says a payment would return no tokens, and offers no minimum of zero', async () => {
    runtime.pending = { intent, submitted: true, accountId: OWNER, status: reverted({ payFailure: { reason: 'TERMINAL_UNDER_MIN', received: 0n, minimum: 99n, zeroFill: true, message: 'This payment would return no tokens.' } }) }
    await render()
    expect(host.textContent).toContain('This payment would return no tokens.')
    expect(host.querySelector('input[type="number"]')).toBeNull()
    expect(buttons()).toContain('Review again')
  })
  it("offers no looser minimum for a shortfall the SDK doesn't call adjustable", async () => {
    const FLOOR = "The token's price moved too fast to buy safely, so wait a few minutes and try again."
    runtime.pending = { intent, submitted: true, accountId: OWNER, status: reverted({ payFailure: { reason: 'BUYBACK_DERIVED_FLOOR_NOT_MET', received: 98n, minimum: 99n, zeroFill: false, message: FLOOR } }) }
    await render()
    expect(host.textContent).toContain(FLOOR)
    expect(host.querySelector('input[type="number"]')).toBeNull()
    expect(buttons()).toContain('Review again')
  })
  it("shows why Signa refused a send, and reviews a fresh payment at once with the looser minimum", async () => {
    runtime.pending = { intent, submitted: false, accountId: OWNER, status: { status: 'approved', expectedPayment: { minimumReturnedTokens: '99' } } }
    runtime.submit.mockImplementationOnce(async () => {
      runtime.pending = { intent, submitted: true, accountId: OWNER, status: { status: 'refused', expectedPayment: { minimumReturnedTokens: '99' } } }
      throw Object.assign(new Error('Signa refused to send this payment.'), { code: 'WALLET_OPERATION_REFUSED', payFailure: UNDER_MIN })
    })
    await render()
    await act(async () => [...host.querySelectorAll('button')].find(button => button.textContent === 'Submit payment')!.click())
    // One line: the SDK's reason, not Signa's refusal text beside it.
    await vi.waitFor(() => expect(host.textContent).toContain(SHORTFALL))
    expect(host.textContent).not.toContain('Signa refused to send this payment.')
    expect(host.querySelector('[role="alert"]')).toBeNull()
    expect(host.querySelector<HTMLInputElement>('input[type="number"]')?.value).toBe('2.5')
    await act(async () => [...host.querySelectorAll('button')].find(button => button.textContent === 'Review again')!.click())
    await vi.waitFor(() => expect(runtime.prepare).toHaveBeenCalledWith(expect.objectContaining({ slippageBps: 250 })))
    expect(runtime.clear).toHaveBeenCalledOnce()
  })
  it('says a refused payment was never sent, and prepares it again at once', async () => {
    runtime.pending = { intent, submitted: true, accountId: OWNER, status: { status: 'refused', expectedPayment: { minimumReturnedTokens: '99' } } }
    await render()
    expect(host.textContent).toContain('Signa did not send this payment, so nothing was charged. Review it again.')
    expect(buttons()).toContain('Review again')
    expect(buttons()).toContain('Close payment')
    await act(async () => [...host.querySelectorAll('button')].find(button => button.textContent === 'Review again')!.click())
    await vi.waitFor(() => expect(runtime.prepare).toHaveBeenCalled())
    expect(runtime.clear).toHaveBeenCalledOnce()
  })
  it('retires an unknown send, then offers the fresh review when Signa never sent it', async () => {
    runtime.pending = { intent, submitted: true, accountId: OWNER, status: { status: 'unknown', expectedPayment: { minimumReturnedTokens: '99' } } }
    runtime.retire.mockImplementationOnce(async () => {
      runtime.pending = { intent, submitted: true, accountId: OWNER, status: { status: 'refused', expectedPayment: { minimumReturnedTokens: '99' } } }
    })
    await render()
    await act(async () => [...host.querySelectorAll('button')].find(button => button.textContent === 'Check payment status')!.click())
    await vi.waitFor(() => expect(buttons()).toContain('Review again'))
    expect(runtime.retire).toHaveBeenCalledOnce()
    expect(runtime.refresh).not.toHaveBeenCalled()
  })
})
