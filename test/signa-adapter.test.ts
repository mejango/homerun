import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { encodeFunctionData, erc20Abi, type Address } from 'viem'
import { USDC_ADDRESSES } from '@bananapus/nana-sdk-core'
import { v6Address } from '@bananapus/nana-sdk-core/v6'
import { buildReviewModel, registerReviewHandler, sendReviewed, type ReviewModel } from '@bananapus/nana-sdk-core/review'
import { signaPayCall, signaPaymentAdapter } from '@/lib/center-payment'

const account = '0x1111111111111111111111111111111111111111' as Address
const hash = `0x${'ab'.repeat(32)}` as const
const call = signaPayCall({ projectId: 7n, amount: 5_000_000n, beneficiary: account, minimumReturnedTokens: 97n, metadata: '0x1234' })
const context = [{ label: 'Payment', value: '5 USDC' }]

describe('Signa as a self-reviewing wallet', () => {
  let prompts: number, unregister: () => void
  const payment = { prepare: vi.fn(), submit: vi.fn() }
  const approve = vi.fn<(url: string) => Promise<boolean>>(), beforeSubmit = vi.fn(async () => {})
  const send = (calls: Parameters<typeof sendReviewed>[0]['calls'], onPreview?: (model: ReviewModel) => void) => sendReviewed(
    { account, calls, title: 'Pay with Juicebox wallet', context },
    { adapter: signaPaymentAdapter({ account: () => account, payment, approve, beforeSubmit, quote: { returnPath: '/project/8453/7', slippageBps: 250 } }),
      clientFor: () => { throw new Error('no chain read') }, hold: {} as never, onPreview })
  beforeEach(() => {
    prompts = 0; unregister = registerReviewHandler(async () => { prompts += 1; return null })
    payment.prepare.mockReset().mockResolvedValue({ status: 'reviewing', approvalUrl: 'https://signa.center/wallet/payment?review=1' })
    payment.submit.mockReset().mockResolvedValue({ status: 'pending', transactionHash: hash })
    approve.mockReset().mockResolvedValue(true); beforeSubmit.mockClear()
  })
  afterEach(() => unregister())

  it('no in-app prompt, raw calls reach Signa, preview is the core model', async () => {
    let preview: ReviewModel | undefined
    await expect(send([call], model => { preview = model })).resolves.toMatchObject({ status: 'done', hashes: [hash] })
    expect(prompts).toBe(0)
    expect(payment.prepare).toHaveBeenCalledWith({ projectId: '7', token: USDC_ADDRESSES[8453], terminal: v6Address('JBMultiTerminal', 8453),
      amount: '5000000', minimumReturnedTokens: '97', metadata: '0x1234', returnPath: '/project/8453/7', slippageBps: 250 })
    expect(approve).toHaveBeenCalledWith('https://signa.center/wallet/payment?review=1')
    expect(beforeSubmit.mock.invocationCallOrder[0]).toBeLessThan(payment.submit.mock.invocationCallOrder[0]!)
    expect(preview).toEqual(buildReviewModel({ calls: [{ ...call, from: account }], title: 'Pay with Juicebox wallet', context }))
    expect(preview!.calls[0]).toMatchObject({ functionName: 'pay', data: call.data, warnings: [] })
  })

  it('a closed review is a rejection, and a user operation without a hash yet is not', async () => {
    approve.mockResolvedValueOnce(false)
    await expect(send([call])).rejects.toMatchObject({ code: 4001 })
    expect(payment.submit).not.toHaveBeenCalled()
    payment.submit.mockResolvedValueOnce({ status: 'pending' })
    await expect(send([call])).rejects.toThrow('Submitted. Waiting for confirmation.')
  })

  it('a non-pay call is refused before Signa', async () => {
    const usdc = USDC_ADDRESSES[8453]!
    const refusals = [
      [{ chainId: 8453, to: usdc, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [account, 1n] }) }],
      [call, call],
      [{ ...call, chainId: 1 }],
      [{ ...call, value: 1n }],
      [signaPayCall({ projectId: 7n, amount: 1n, beneficiary: '0x2222222222222222222222222222222222222222', minimumReturnedTokens: 0n, metadata: '0x' })],
    ]
    for (const calls of refusals) await expect(send(calls)).rejects.toThrow('Nothing was sent.')
    expect(payment.prepare).not.toHaveBeenCalled()
    expect(prompts).toBe(0)
  })
})
