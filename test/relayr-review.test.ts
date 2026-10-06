/** The gas a relayed request signs and the gas the Relayr payment sends are the gas the review shows, and the payment is proven from the chain. */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { decodeFunctionData, type Address, type Hex } from 'viem'
import { erc2771ForwarderAbi } from '@bananapus/nana-sdk-core'
import {
  RELAYR_NATIVE_TOKEN,
  RELAYR_PAYMENT_ADDRESS,
  RELAYR_PAYMENT_SELECTOR,
  RelayrPaymentRetryError,
  RelayrPaymentRevertedError,
  RelayrProofError,
  type RelayrPayment,
} from '@bananapus/nana-sdk-core/review/relayr'

const m = vi.hoisted(() => ({
  account: '0x1111111111111111111111111111111111111111' as `0x${string}`,
  safe: false,
  review: vi.fn(),
  send: vi.fn(),
  signTypedData: vi.fn(),
}))

vi.mock('@wagmi/core', () => ({ getAccount: () => ({ address: m.account }) }))
vi.mock('@/providers/Providers', () => ({ wagmiConfig: {} }))
vi.mock('@/lib/transaction-review', async importOriginal => ({
  ...await importOriginal<typeof import('@/lib/transaction-review')>(), requireTransactionReview: m.review,
}))
vi.mock('@/lib/safe-connector', () => ({ isSafeConnection: () => m.safe }))
const client = vi.hoisted(() => ({
  readContract: vi.fn(async ({ functionName }: { functionName: string }) => functionName === 'nonces'
    ? 0n : ['0x0f', 'ERC2771Forwarder', '1', 1n, '0x0000000000000000000000000000000000000000', `0x${'00'.repeat(32)}`, []]),
  getCode: vi.fn(),
  request: vi.fn(async () => '0x'),
  waitForTransactionReceipt: vi.fn(),
  getTransaction: vi.fn(),
  getTransactionReceipt: vi.fn(),
  getBlock: vi.fn(),
}))
vi.mock('@/lib/wallet-core', () => ({
  publicClient: () => client,
  connectedWallet: async () => ({ wallet: { sendTransaction: m.send, signTypedData: m.signTypedData }, account: m.account }),
}))

import {
  prepareForwardedTx,
  relayrPay,
  RelayrPaymentSubmittedError,
} from '@/lib/relayr'
import { MAX_RELAYR_SENT_PAYMENTS, type RelayrSentPayment } from '@/lib/relayr-payments'

const TARGET = '0x2222222222222222222222222222222222222222' as Address
const BUNDLE = '00000000-0000-0000-0000-000000000001'
const FIRST = `0x${'aa'.repeat(32)}` as Hex
const MINED = `0x${'bb'.repeat(32)}` as Hex
const EARLIER = `0x${'ee'.repeat(32)}` as Hex
const BLOCK = `0x${'cc'.repeat(32)}` as Hex
/** The runtime code Relayr's payment contract has, whose hash the payment's chain must report. */
const PAYMENT_RUNTIME = '0x608060405260043610156010575f80fd5b5f3560e01c63103903a7146022575f80fd5b604036600319011260ef576004356fffffffffffffffffffffffffffffffff19811680910360ef5760243564ffffffffff811680910360ef5780421160ce575f341560c6575b5f8080809373755ff2f75a0a586ecfa2b9a3c959cb662458a1053491f11560bb5760407fb96b060a9c075a83da0cf1f9405deeb5df21df681a762de16c3d5eaf99531cd8918151903482526020820152a2005b6040513d5f823e3d90fd5b506108fc6068565b90630f01bd8760e21b5f5260045260245264ffffffffff421660445260645ffd5b5f80fdfea26469706673582212206ea0d2ba1e0cb26cc9293b24f1a7aecc1de7e328ca83d6b3bf5382ac44c7390064736f6c634300081a0033' as Hex

beforeEach(() => {
  m.safe = false
  m.review.mockResolvedValue(undefined)
  m.send.mockResolvedValue(FIRST)
  m.signTypedData.mockResolvedValue(`0x${'dd'.repeat(65)}`)
  client.getCode.mockResolvedValue(PAYMENT_RUNTIME)
})

describe('relayed request review', () => {
  it.each([[4_000_000n, 4_000_000n], [undefined, 500_000n]])('shows the forwarder gas the wallet signs (%s)', async (gas, signed) => {
    const prepared = await prepareForwardedTx({ chainId: 1, target: TARGET, data: '0x1234', gas }, m.account)
    expect(prepared.review.calls[0].gas).toBe(signed)
    expect((prepared.review.authorization as { message: { gas: bigint } }).message.gas).toBe(signed)
    const entry = await prepared.sign()
    const request = decodeFunctionData({ abi: erc2771ForwarderAbi, data: entry.data }).args[0] as { gas: bigint }
    expect(request.gas).toBe(signed)
    expect(m.signTypedData.mock.calls[0][0].message.gas).toBe(signed)
  })
})

describe('Relayr payment', () => {
  const deadline = Math.floor(Date.now() / 1000) + 600
  const calldata = `${RELAYR_PAYMENT_SELECTOR}${BUNDLE.replaceAll('-', '').padEnd(64, '0')}${deadline.toString(16).padStart(64, '0')}` as Hex
  const payment: RelayrPayment = {
    chain: 8453, amount: '200', target: RELAYR_PAYMENT_ADDRESS, token: RELAYR_NATIVE_TOKEN, payment_deadline: deadline, calldata,
  }
  /** The payment as it was sent, under `hash`. */
  const sentUnder = (hash: Hex): RelayrSentPayment => ({
    chainId: 8453, target: RELAYR_PAYMENT_ADDRESS, calldata, amount: '200', deadline: String(deadline), bundleUuid: BUNDLE, hash,
  })
  const pay = (options: Partial<Parameters<typeof relayrPay>[0]> = {}) =>
    relayrPay({ payment, account: m.account, bundleUuid: BUNDLE, destinationChainIds: [1, 10], ...options })
  /** The chain holds the reviewed payment under each hash, sent from `from`, mined with `status`. */
  function chainHolds(statuses: Record<string, 'success' | 'reverted'>, { from = m.account, to = RELAYR_PAYMENT_ADDRESS }: { from?: Address; to?: Address } = {}) {
    client.getTransaction.mockImplementation(async ({ hash }: { hash: Hex }) => {
      if (!statuses[hash]) throw new Error('Transaction not found')
      return { hash, chainId: 8453, from, to, input: calldata, value: 200n, blockHash: BLOCK, blockNumber: 123n }
    })
    client.getTransactionReceipt.mockImplementation(async ({ hash }: { hash: Hex }) => {
      if (!statuses[hash]) throw new Error('Transaction not found')
      return { transactionHash: hash, to, blockHash: BLOCK, blockNumber: 123n, status: statuses[hash] }
    })
    client.getBlock.mockResolvedValue({ hash: BLOCK })
  }
  /** Relayr reports the bundle as `body` says, by default unpaid with its one call pending. */
  function relayrReports(body: Record<string, unknown> = {}) {
    vi.mocked(fetch).mockImplementation(async () => new Response(JSON.stringify({ bundle_uuid: BUNDLE, payment_received: false,
      transactions: [{ tx_uuid: '00000000-0000-4000-8000-000000000001', status: { state: 'Pending' } }], ...body }), { status: 200 }))
  }

  beforeEach(() => {
    client.waitForTransactionReceipt.mockImplementation(async ({ hash }: { hash: Hex }) => ({ status: 'success', transactionHash: hash }))
    chainHolds({ [FIRST]: 'success', [MINED]: 'success' })
  })

  it('shows the gas limit it sends', async () => {
    await pay()
    const reviewed = m.review.mock.calls[0][0].calls[0]
    expect(reviewed.gas).toBe(150_000n)
    expect(reviewed).not.toHaveProperty('safeTxGas')
    expect(m.send.mock.calls[0][0].gas).toBe(reviewed.gas)
  })

  it('refuses a Safe connection before a review opens or anything is sent', async () => {
    m.safe = true
    await expect(pay()).rejects.toThrow('ordinary wallet')
    expect(m.review).not.toHaveBeenCalled()
    expect(m.send).not.toHaveBeenCalled()
  })

  it('takes its payment details from the SDK, and refuses an option that is not Relayr\'s payment', async () => {
    await expect(pay({ payment: { ...payment, target: TARGET } })).rejects.toThrow('unrecognized payment contract')
    await expect(pay({ payment: { ...payment, amount: '-1' } })).rejects.toThrow('invalid payment amount')
    await expect(pay({ destinationChainIds: [1, 11155111] })).rejects.toThrow('same network family')
    expect(m.send).not.toHaveBeenCalled()
  })

  it('stops when the quote changed between the review and the wallet', async () => {
    m.review.mockImplementation(async () => { payment.amount = '201' })
    try {
      await expect(pay()).rejects.toThrow('payment changed')
    } finally {
      payment.amount = '200'
    }
    expect(m.send).not.toHaveBeenCalled()
  })

  it('proves the payment from the chain, and resolves with the hash it was sent under and every payment sent', async () => {
    const onSent = vi.fn()
    const result = await pay({ onSent })
    expect(result).toEqual({ hash: FIRST, payments: [sentUnder(FIRST)] })
    expect(onSent).toHaveBeenCalledExactlyOnceWith([sentUnder(FIRST)])
    expect(client.getTransaction).toHaveBeenCalledWith({ hash: FIRST })
  })

  it('proves a sped-up payment on the hash it was mined under, and remembers that hash', async () => {
    client.waitForTransactionReceipt.mockResolvedValue({ status: 'success', transactionHash: MINED })
    const onSent = vi.fn()
    const result = await pay({ onSent })
    expect(result).toEqual({ hash: MINED, payments: [sentUnder(MINED)] })
    // First under the hash the wallet returned, then under the hash the chain mined it with.
    expect(onSent.mock.calls).toEqual([[[sentUnder(FIRST)]], [[sentUnder(MINED)]]])
    expect(client.getTransaction).toHaveBeenCalledExactlyOnceWith({ hash: MINED })
  })

  it('refuses a payment that mined as another transaction, however its receipt reads', async () => {
    chainHolds({ [FIRST]: 'success' }, { to: TARGET })
    await expect(pay()).rejects.toThrow(RelayrProofError)
    await expect(pay()).rejects.toThrow('does not match the reviewed Relayr payment')
    chainHolds({ [FIRST]: 'success' }, { from: TARGET })
    await expect(pay()).rejects.toThrow('does not match the reviewed Relayr payment')
  })

  it('throws a payment that reverted onchain as the SDK\'s reverted error, saved under its hash first', async () => {
    chainHolds({ [FIRST]: 'reverted' })
    const onSent = vi.fn()
    const error = await pay({ onSent }).catch((thrown: unknown) => thrown)
    expect(error).toBeInstanceOf(RelayrPaymentRevertedError)
    expect(error).toMatchObject({ hash: FIRST, chainId: 8453 })
    expect(onSent).toHaveBeenCalledWith([sentUnder(FIRST)])
  })

  it('keeps a payment whose proof cannot be read yet as sent, never as failed', async () => {
    client.getTransaction.mockRejectedValue(new Error('node unavailable'))
    const error = await pay().catch((thrown: unknown) => thrown)
    expect(error).toBeInstanceOf(RelayrPaymentSubmittedError)
    expect(error).toMatchObject({ hash: FIRST, chainId: 8453 })
    expect(m.send).toHaveBeenCalledOnce()
  })

  it('keeps a payment sent when its receipt cannot be read, or its hash cannot be saved', async () => {
    client.waitForTransactionReceipt.mockRejectedValue(new Error('node unavailable'))
    await expect(pay()).rejects.toBeInstanceOf(RelayrPaymentSubmittedError)
    await expect(pay({ onSent: () => { throw new Error('storage is full') } })).rejects.toBeInstanceOf(RelayrPaymentSubmittedError)
    expect(client.getTransaction).not.toHaveBeenCalled()
  })

  it('says a wallet that failed after it may have sent never signed, and a rejection never sent', async () => {
    m.send.mockRejectedValue(new Error('wallet disconnected'))
    await expect(pay()).rejects.toThrow('may have sent the Relayr payment')
    const rejection = Object.assign(new Error('Rejected'), { code: 4001 })
    m.send.mockRejectedValue(rejection)
    await expect(pay()).rejects.toBe(rejection)
  })

  describe('a quote paid before', () => {
    beforeEach(() => {
      chainHolds({ [EARLIER]: 'reverted', [FIRST]: 'success' })
      relayrReports()
    })

    it('is paid again when the SDK\'s retry rule clears it: every payment reverted, Relayr reporting it unpaid', async () => {
      const result = await pay({ sent: [sentUnder(EARLIER)] })
      expect(result.payments).toEqual([sentUnder(EARLIER), sentUnder(FIRST)])
      expect(vi.mocked(fetch)).toHaveBeenCalledWith(`https://api.relayr.ba5ed.com/v1/bundle/${BUNDLE}`, expect.objectContaining({ cache: 'no-store' }))
      expect(m.send).toHaveBeenCalledOnce()
    })

    it('asks the rule right before the wallet opens, after the review', async () => {
      const order: string[] = []
      m.review.mockImplementation(async () => { order.push('review') })
      vi.mocked(fetch).mockImplementation(async () => {
        order.push('retry rule')
        return new Response(JSON.stringify({ bundle_uuid: BUNDLE, payment_received: false, transactions: [{ tx_uuid: '00000000-0000-4000-8000-000000000001', status: { state: 'Pending' } }] }))
      })
      m.send.mockImplementation(async () => { order.push('wallet'); return FIRST })
      await pay({ sent: [sentUnder(EARLIER)] })
      expect(order).toEqual(['review', 'retry rule', 'wallet'])
    })

    it('is never paid again, and the wallet never opens, when Relayr reports the bundle paid', async () => {
      relayrReports({ payment_received: true })
      const error = await pay({ sent: [sentUnder(EARLIER)] }).catch((thrown: unknown) => thrown)
      expect(error).toBeInstanceOf(RelayrPaymentRetryError)
      expect(error).toMatchObject({ reason: 'paid' })
      expect(m.send).not.toHaveBeenCalled()
    })

    it('is never paid again when one of its payments succeeded onchain', async () => {
      chainHolds({ [EARLIER]: 'reverted', [MINED]: 'success' })
      const error = await pay({ sent: [sentUnder(EARLIER), sentUnder(MINED)] }).catch((thrown: unknown) => thrown)
      expect(error).toMatchObject({ reason: 'paid' })
      expect(m.send).not.toHaveBeenCalled()
    })

    it('is never paid again while a payment cannot be read, or Relayr cannot be', async () => {
      client.getTransaction.mockRejectedValue(new Error('node unavailable'))
      await expect(pay({ sent: [sentUnder(EARLIER)] })).rejects.toMatchObject({ reason: 'unknown' })
      chainHolds({ [EARLIER]: 'reverted' })
      vi.mocked(fetch).mockRejectedValue(new Error('offline'))
      await expect(pay({ sent: [sentUnder(EARLIER)] })).rejects.toMatchObject({ reason: 'unknown' })
      expect(m.send).not.toHaveBeenCalled()
    })

    it('is never paid again when a saved payment belongs to another bundle', async () => {
      await expect(pay({ sent: [{ ...sentUnder(EARLIER), bundleUuid: '00000000-0000-0000-0000-000000000002' }] }))
        .rejects.toThrow('belongs to another bundle')
      expect(m.send).not.toHaveBeenCalled()
    })

    it('is never paid beyond the most payments a quote keeps', async () => {
      const full = Array.from({ length: MAX_RELAYR_SENT_PAYMENTS }, () => sentUnder(EARLIER))
      await expect(pay({ sent: full })).rejects.toThrow('paid too many times')
      expect(m.send).not.toHaveBeenCalled()
    })
  })
})
