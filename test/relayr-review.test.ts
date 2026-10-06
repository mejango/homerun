/** The gas a relayed request signs and the gas the Relayr payment sends are the gas the review shows. */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { decodeFunctionData, type Address, type Hex } from 'viem'
import { erc2771ForwarderAbi } from '@bananapus/nana-sdk-core'

const m = vi.hoisted(() => ({
  account: '0x1111111111111111111111111111111111111111' as `0x${string}`,
  code: `0x${'fe'.repeat(32)}` as `0x${string}`,
  codeHash: '0x6006b5acadb4cd60aa5c00cb844c34563e182dff83d4f4ff4fde226f7df16fa6' as `0x${string}`,
  safe: false,
  review: vi.fn(),
  send: vi.fn(),
  signTypedData: vi.fn(),
  waitSafe: vi.fn(),
}))

// The payment contract is authenticated by its code hash; stand in for its runtime code.
vi.mock('viem', async importOriginal => {
  const viem = await importOriginal<typeof import('viem')>()
  const keccak256 = ((value: Hex, to?: 'hex') => value === m.code ? m.codeHash : viem.keccak256(value, to)) as typeof viem.keccak256
  return { ...viem, keccak256 }
})
vi.mock('@wagmi/core', () => ({ getAccount: () => ({ address: m.account }) }))
vi.mock('@/providers/Providers', () => ({ wagmiConfig: {} }))
vi.mock('@/lib/transaction-review', async importOriginal => ({
  ...await importOriginal<typeof import('@/lib/transaction-review')>(), requireTransactionReview: m.review,
}))
vi.mock('@/lib/safe-connector', () => ({
  isSafeConnection: () => m.safe, SAFE_NONCE_GUIDANCE: 'Safe nonce guidance',
  waitForSafeExecutionHash: m.waitSafe,
}))
const client = vi.hoisted(() => ({
  readContract: vi.fn(async ({ functionName }: { functionName: string }) => functionName === 'nonces'
    ? 0n : ['0x0f', 'ERC2771Forwarder', '1', 1n, '0x0000000000000000000000000000000000000000', `0x${'00'.repeat(32)}`, []]),
  request: vi.fn(async ({ method }: { method: string }) => method === 'eth_getCode' ? m.code : '0x'),
  waitForTransactionReceipt: vi.fn(async () => ({ status: 'success' })),
}))
vi.mock('@/lib/wallet-core', () => ({
  publicClient: () => client,
  connectedWallet: async () => ({ wallet: { sendTransaction: m.send, signTypedData: m.signTypedData }, account: m.account }),
}))

import {
  prepareForwardedTx,
  relayrPay,
  RelayrPaymentSubmittedError,
  RELAYR_NATIVE_TOKEN,
  RELAYR_PAYMENT_ADDRESS,
  RELAYR_PAYMENT_SELECTOR,
} from '@/lib/relayr'

const TARGET = '0x2222222222222222222222222222222222222222' as Address
const BUNDLE = '00000000-0000-0000-0000-000000000001'
const HASH = `0x${'aa'.repeat(32)}` as Hex

beforeEach(() => {
  m.safe = false
  m.review.mockResolvedValue(undefined)
  m.send.mockResolvedValue(HASH)
  m.signTypedData.mockResolvedValue(`0x${'dd'.repeat(65)}`)
  m.waitSafe.mockImplementation(async (_chainId: number, hash: Hex) => hash)
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

describe('Relayr payment review', () => {
  const deadline = Math.floor(Date.now() / 1000) + 600
  const payment = {
    chain: 8453, amount: '200', target: RELAYR_PAYMENT_ADDRESS, token: RELAYR_NATIVE_TOKEN, payment_deadline: deadline,
    calldata: `${RELAYR_PAYMENT_SELECTOR}${BUNDLE.replaceAll('-', '').padEnd(64, '0')}${deadline.toString(16).padStart(64, '0')}` as Hex,
  }

  it('shows the gas limit it sends', async () => {
    await relayrPay(payment, m.account, BUNDLE, [1, 10])
    const reviewed = m.review.mock.calls[0][0].calls[0]
    expect(reviewed.gas).toBe(150_000n)
    expect(reviewed).not.toHaveProperty('safeTxGas')
    expect(m.send.mock.calls[0][0].gas).toBe(reviewed.gas)
  })

  it('sends a Safe proposal with safeTxGas 0 and shows it', async () => {
    m.safe = true
    await relayrPay(payment, m.account, BUNDLE, [1, 10])
    const reviewed = m.review.mock.calls[0][0].calls[0]
    expect(reviewed.safeTxGas).toBe(0n)
    expect(reviewed).not.toHaveProperty('gas')
    expect(m.send.mock.calls[0][0].gas).toBe(0n)
  })

  it('waits for the Safe to execute the payment with the signal of the flow that sent it', async () => {
    m.safe = true
    const flow = new AbortController()
    await relayrPay(payment, m.account, BUNDLE, [1, 10], undefined, undefined, undefined, flow.signal)
    expect(m.waitSafe).toHaveBeenCalledWith(8453, HASH, { signal: flow.signal })
  })

  it('reads a Safe wait that its flow ends as a payment sent and not yet confirmed, never a failed one', async () => {
    m.safe = true
    m.waitSafe.mockImplementation((_chainId: number, _hash: Hex, options?: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => reject(new DOMException('Safe execution wait aborted', 'AbortError')), { once: true })
      }))
    const flow = new AbortController()
    const submitted = vi.fn()
    const paying = relayrPay(payment, m.account, BUNDLE, [1, 10], submitted, undefined, undefined, flow.signal)
      .catch((error: unknown) => error)
    await vi.waitFor(() => expect(m.waitSafe).toHaveBeenCalledOnce())
    flow.abort()

    const error = await paying
    expect(error).toBeInstanceOf(RelayrPaymentSubmittedError)
    expect(error).toMatchObject({ hash: HASH, chainId: 8453 })
    expect(String(error)).toContain('Do not pay again')
    expect(submitted).toHaveBeenCalledWith(HASH)
    expect(client.waitForTransactionReceipt).not.toHaveBeenCalled()
    expect(m.send).toHaveBeenCalledOnce()
  })
})
