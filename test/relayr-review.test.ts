/** Homerun's relayed request and payment go through core: these check what homerun adds around core's signer and payer. */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { decodeFunctionData, type Address, type Hex } from 'viem'
import { clearViewAs, setViewAs, VIEW_AS_WRITE_BLOCKED } from '@/lib/viewAs'
import { erc2771ForwarderAbi, JBCoreContracts, jbV6ContractAddress } from '@bananapus/nana-sdk-core'
import {
  RELAYR_NATIVE_TOKEN,
  RELAYR_PAYMENT_ADDRESS,
  RELAYR_PAYMENT_SELECTOR,
  RelayrPaymentRevertedError,
  type RelayrPayment,
  type RelayrSentPayment,
} from '@bananapus/nana-sdk-core/review/relayr'
import { ReviewedCallRevertedError, TransactionReviewCancelledError } from '@bananapus/nana-sdk-core/review'

const m = vi.hoisted(() => ({
  safe: false,
  nonce: 0n,
  sign: vi.fn(),
  pay: vi.fn(),
  retry: vi.fn(),
  verify: vi.fn(),
}))

vi.mock('@/providers/Providers', () => ({ wagmiConfig: {} }))
vi.mock('@/lib/safe-connector', () => ({ isSafeConnection: () => m.safe }))
vi.mock('@/lib/reviewed-send-deps', () => ({ reviewedSendDeps: { adapter: { name: 'adapter' } } }))
vi.mock('@/lib/wallet-core', () => ({ publicClient: () => ({ readContract: async () => m.nonce }) }))
vi.mock('@bananapus/nana-sdk-core/review', async importOriginal => ({
  ...await importOriginal<typeof import('@bananapus/nana-sdk-core/review')>(), signReviewed: m.sign, payRelayrReviewed: m.pay,
}))
vi.mock('@bananapus/nana-sdk-core/review/relayr', async importOriginal => ({
  ...await importOriginal<typeof import('@bananapus/nana-sdk-core/review/relayr')>(), requireRelayrRetry: m.retry, verifyRelayrPayment: m.verify,
}))

import { prepareForwardedTx, relayrPay, relayrRecords, RelayrPaymentSubmittedError } from '@/lib/relayr'

const ACCOUNT = '0x1111111111111111111111111111111111111111' as Address
const TARGET = '0x2222222222222222222222222222222222222222' as Address
const BUNDLE = '00000000-0000-0000-0000-000000000001'
const FIRST = `0x${'aa'.repeat(32)}` as Hex
const MINED = `0x${'bb'.repeat(32)}` as Hex
const EARLIER = `0x${'ee'.repeat(32)}` as Hex
const SIGNATURE = `0x${'dd'.repeat(65)}` as Hex
const PLAN = { id: 'plan' } as never

beforeEach(() => {
  vi.resetAllMocks()
  m.safe = false
  m.nonce = 0n
  m.sign.mockResolvedValue([SIGNATURE])
})

describe('relayed request', () => {
  it.each([[4_000_000n, 4_000_000n], [undefined, 500_000n]])('reviews and signs the exact forwarder request, gas %s, under the plan', async (gas, signed) => {
    const prepared = await prepareForwardedTx({ chainId: 1, target: TARGET, data: '0x1234', value: 17n, gas }, ACCOUNT, 0n)
    expect(prepared.review).toMatchObject({ chainId: 1, from: ACCOUNT, to: TARGET, data: '0x1234', value: 17n, gas: signed })
    const entry = await prepared.sign(PLAN)
    const [[[signature], action, deps]] = m.sign.mock.calls
    expect(signature).toMatchObject({ kind: 'forward-request', chainId: 1, request: { from: ACCOUNT, to: TARGET, value: 17n, gas: signed, nonce: 0n, data: '0x1234' } })
    expect(action).toMatchObject({ account: ACCOUNT, plan: PLAN })
    expect(deps).toEqual({ adapter: { name: 'adapter' } })
    expect(entry.target).toBe(jbV6ContractAddress[JBCoreContracts.ERC2771Forwarder][1])
    const [request] = decodeFunctionData({ abi: erc2771ForwarderAbi, data: entry.data }).args as [{ gas: bigint; deadline: number; signature: Hex }]
    expect(request).toMatchObject({ gas: signed, deadline: signature.request.deadline, signature: SIGNATURE })
    expect(entry.value).toBe('17')
  })

  it('refuses a forwarder nonce that moved, before review and before signing', async () => {
    m.nonce = 1n
    await expect(prepareForwardedTx({ chainId: 1, target: TARGET, data: '0x1234' }, ACCOUNT, 0n)).rejects.toThrow('may have executed')
    const prepared = await prepareForwardedTx({ chainId: 1, target: TARGET, data: '0x1234' }, ACCOUNT, 1n)
    m.nonce = 2n
    await expect(prepared.sign(PLAN)).rejects.toThrow('changed or expired')
    expect(m.sign).not.toHaveBeenCalled()
  })

  it('refuses a request too close to its deadline to be paid', async () => {
    const prepared = await prepareForwardedTx({ chainId: 1, target: TARGET, data: '0x1234' }, ACCOUNT)
    const now = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 24 * 3600_000)
    try {
      await expect(prepared.sign(PLAN)).rejects.toThrow('changed or expired')
      expect(m.sign).not.toHaveBeenCalled()
    } finally { now.mockRestore() }
  })
})

describe('payment', () => {
  const deadline = Math.floor(Date.now() / 1000) + 600
  const calldata = `${RELAYR_PAYMENT_SELECTOR}${BUNDLE.replaceAll('-', '').padEnd(64, '0')}${deadline.toString(16).padStart(64, '0')}` as Hex
  const payment: RelayrPayment = { chain: 8453, amount: '200', target: RELAYR_PAYMENT_ADDRESS, token: RELAYR_NATIVE_TOKEN, payment_deadline: deadline, calldata }
  const quote = { bundle_uuid: BUNDLE, payment_info: [payment], transactions: [], expectedTransactions: [] }
  const sentUnder = (hash: Hex): RelayrSentPayment => ({ chainId: 8453, target: RELAYR_PAYMENT_ADDRESS, calldata, amount: '200', deadline: String(deadline), bundleUuid: BUNDLE, hash })
  const pay = (options: Partial<Parameters<typeof relayrPay>[0]> = {}) =>
    relayrPay({ payment, account: ACCOUNT, quote, destinationChainIds: [1, 10], ...options })
  /** Core opens the wallet (after onSending) and reports `hashes` as the payment is known by them, then `ends` as given. */
  function corePays(hashes: Hex[], ends: () => unknown = () => ({ hash: hashes[hashes.length - 1] })) {
    m.pay.mockImplementation(async (_quote, _chainId, action) => {
      await action.onSending()
      for (const hash of hashes) await action.onSent(hash)
      return ends()
    })
  }

  it('spends the plan\'s fee bound on a first payment, and resolves with every hash it was known by', async () => {
    corePays([FIRST, MINED])
    const onSent = vi.fn()
    const result = await pay({ planned: { plan: PLAN, round: 'launch:x' }, onSent })
    expect(m.pay.mock.calls[0][1]).toBe(8453)
    expect(m.pay.mock.calls[0][2]).toMatchObject({ account: ACCOUNT, plan: PLAN, relayrRound: 'launch:x' })
    expect(result).toEqual({ hash: MINED, payments: [sentUnder(MINED)] })
    expect(onSent.mock.calls.map(([payments]) => payments)).toEqual([[sentUnder(FIRST)], [sentUnder(MINED)]])
    expect(m.retry).not.toHaveBeenCalled()
  })

  it('pays a quote paid before only once the retry rule clears it, and never against the plan', async () => {
    corePays([FIRST])
    const order: string[] = []
    m.retry.mockImplementation(async () => { order.push('retry') })
    await pay({ sent: [sentUnder(EARLIER)], planned: { plan: PLAN, round: 'launch:x' }, onSending: () => { order.push('saved') } })
    expect(m.pay.mock.calls[0][2].plan).toBeUndefined()
    expect(m.retry).toHaveBeenCalledWith(expect.any(Function), { payments: [sentUnder(EARLIER)], from: ACCOUNT, bundleUuid: BUNDLE })
    expect(order).toEqual(['retry', 'saved'])
  })

  it('rechecks the launch right before the wallet, and a refusal there sends nothing', async () => {
    corePays([FIRST])
    const reverify = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('A creation fee changed.'))
    const onSending = vi.fn()
    await expect(pay({ reverify, onSending })).rejects.toThrow('A creation fee changed.')
    expect(reverify).toHaveBeenCalledTimes(2)
    expect(onSending).not.toHaveBeenCalled()
  })

  it('refuses a Safe connection and view-as before core is asked', async () => {
    m.safe = true
    await expect(pay()).rejects.toThrow('ordinary wallet')
    m.safe = false
    setViewAs(TARGET)
    try {
      await expect(pay()).rejects.toThrow(VIEW_AS_WRITE_BLOCKED)
    } finally { clearViewAs() }
    expect(m.pay).not.toHaveBeenCalled()
  })

  it('throws a payment that reverted onchain as the SDK\'s reverted error', async () => {
    corePays([FIRST], () => { throw new ReviewedCallRevertedError(0, FIRST, { status: 'reverted' } as never) })
    m.verify.mockRejectedValue(new RelayrPaymentRevertedError())
    await expect(pay()).rejects.toBeInstanceOf(RelayrPaymentRevertedError)
    expect(m.verify.mock.calls[0][1]).toMatchObject({ hash: FIRST, from: ACCOUNT })
  })

  it('keeps a payment with a hash as sent whatever fails after it', async () => {
    corePays([FIRST], () => { throw new Error('receipt unavailable') })
    await expect(pay()).rejects.toBeInstanceOf(RelayrPaymentSubmittedError)
    corePays([FIRST])
    await expect(pay({ onSent: () => { throw new Error('storage full') } })).rejects.toBeInstanceOf(RelayrPaymentSubmittedError)
  })

  it('passes core\'s refusal through when no hash came back', async () => {
    m.pay.mockRejectedValue(new TransactionReviewCancelledError())
    await expect(pay()).rejects.toBeInstanceOf(TransactionReviewCancelledError)
  })
})

describe('destination records', () => {
  it('keeps the hashes a poll saw when it stops on a chain Relayr failed, though Relayr is unreachable after', async () => {
    const records = [
      { tx_uuid: '00000000-0000-4000-8000-000000000001', status: { state: 'Success', data: { hash: MINED } } },
      { tx_uuid: '00000000-0000-4000-8000-000000000002', status: { state: 'Failed' } },
    ]
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ bundle_uuid: BUNDLE, payment_received: true, transactions: records })))
      .mockRejectedValue(new TypeError('Failed to fetch'))
    vi.stubGlobal('fetch', fetch)
    try {
      expect(await relayrRecords(BUNDLE, 2)).toEqual(records)
    } finally { vi.unstubAllGlobals() }
  })
})
