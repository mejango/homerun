import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Address, Hex } from 'viem'
import { permit2TypedData, type Permit2SignatureAuthorization } from '@bananapus/nana-sdk-core/v6/permit2'

const wallet = vi.hoisted(() => ({
  config: { id: 'reviewed-permit2-test' },
  account: { address: undefined as Address | undefined, chainId: undefined as number | undefined },
  getAccount: vi.fn(),
  signTypedDataAsync: vi.fn(),
  switchChainAsync: vi.fn(),
}))
vi.mock('@wagmi/core', () => ({ getAccount: wallet.getAccount }))
vi.mock('wagmi', () => ({
  useConfig: () => wallet.config,
  useSignTypedData: () => ({ signTypedDataAsync: wallet.signTypedDataAsync }),
  useSwitchChain: () => ({ switchChainAsync: wallet.switchChainAsync }),
}))

import { useReviewedPermit2Signature } from '@/hooks/useReviewedPermit2Signature'
import { registerTransactionReviewHandler, type TransactionReviewRequest } from '@/lib/transaction-review'
import { clearViewAs, setViewAs, VIEW_AS_WRITE_BLOCKED } from '@/lib/viewAs'

const ACCOUNT = '0x1111111111111111111111111111111111111111' as Address
const OTHER = '0x2222222222222222222222222222222222222222' as Address
const SIGNATURE = `0x${'a1'.repeat(65)}` as Hex
const AUTHORIZATION: Permit2SignatureAuthorization = {
  chainId: 8453,
  token: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  spender: '0x6fF5693b99212Da76ad316178A184AB56D299b43',
  amount: 50_000_000n,
  nonce: 7,
  expiration: 1_800_001_800,
  sigDeadline: 1_800_001_800n,
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

describe('reviewed Permit2 signatures', () => {
  let host: HTMLDivElement
  let root: Root
  let hook: ReturnType<typeof useReviewedPermit2Signature>
  let unregister: (() => void) | undefined
  const review = vi.fn<(request: TransactionReviewRequest) => Promise<boolean>>()

  function Harness({ reviewedInParent }: { reviewedInParent?: boolean }) {
    hook = useReviewedPermit2Signature({ reviewedInParent })
    return null
  }

  function installReview() {
    unregister = registerTransactionReviewHandler(review)
  }

  function sign() {
    return hook.signPermit2Async({ authorization: { ...AUTHORIZATION }, expectedAccount: ACCOUNT })
  }

  beforeEach(async () => {
    clearViewAs()
    unregister = undefined
    wallet.account = { address: ACCOUNT, chainId: AUTHORIZATION.chainId }
    wallet.getAccount.mockReset().mockImplementation(() => ({ ...wallet.account }))
    wallet.signTypedDataAsync.mockReset().mockResolvedValue(SIGNATURE)
    wallet.switchChainAsync.mockReset().mockImplementation(async ({ chainId }: { chainId: number }) => {
      wallet.account.chainId = chainId
      return { id: chainId }
    })
    review.mockReset().mockResolvedValue(true)
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    await act(async () => root.render(<Harness />))
  })

  afterEach(async () => {
    unregister?.()
    await act(async () => root.unmount())
    host.remove()
    clearViewAs()
  })

  it('requires the mandatory review provider before any wallet signature', async () => {
    await expect(sign()).rejects.toThrow('Transaction review is unavailable')
    expect(wallet.switchChainAsync).not.toHaveBeenCalled()
    expect(wallet.signTypedDataAsync).not.toHaveBeenCalled()
  })

  it('waits for explicit review approval and signs exactly the reviewed Permit2 typed data', async () => {
    const pending = deferred<boolean>()
    review.mockReturnValue(pending.promise)
    installReview()
    const result = sign()
    const typedData = permit2TypedData(AUTHORIZATION)
    expect(review).toHaveBeenCalledExactlyOnceWith({
      title: 'Sign the swap authorization', calls: [], kind: 'authorization', authorization: typedData,
    })
    expect(wallet.signTypedDataAsync).not.toHaveBeenCalled()
    expect(wallet.switchChainAsync).not.toHaveBeenCalled()
    pending.resolve(true)
    await expect(result).resolves.toBe(SIGNATURE)
    expect(wallet.signTypedDataAsync).toHaveBeenCalledExactlyOnceWith({ account: ACCOUNT, ...typedData })
    expect(wallet.getAccount).toHaveBeenCalledWith(wallet.config)
    expect(typedData.message.details).toEqual({ token: AUTHORIZATION.token, amount: 50_000_000n, expiration: AUTHORIZATION.expiration, nonce: 7 })
    expect(typedData.message.spender).toBe(AUTHORIZATION.spender)
    expect(typedData.domain.chainId).toBe(AUTHORIZATION.chainId)
  })

  it('never requests a signature or chain switch when review is cancelled', async () => {
    wallet.account.chainId = 1
    review.mockResolvedValue(false)
    installReview()
    await expect(sign()).rejects.toThrow('Review closed. Nothing was sent.')
    expect(wallet.switchChainAsync).not.toHaveBeenCalled()
    expect(wallet.signTypedDataAsync).not.toHaveBeenCalled()
  })

  it('propagates review errors without opening wallet prompts', async () => {
    review.mockRejectedValue(new Error('Review unavailable'))
    installReview()
    await expect(sign()).rejects.toThrow('Review unavailable')
    expect(wallet.signTypedDataAsync).not.toHaveBeenCalled()
    expect(wallet.switchChainAsync).not.toHaveBeenCalled()
  })

  it.each([OTHER, undefined])('rejects a changed or disconnected account after review: %s', async address => {
    const pending = deferred<boolean>()
    review.mockReturnValue(pending.promise)
    installReview()
    const result = sign()
    wallet.account.address = address
    pending.resolve(true)
    await expect(result).rejects.toThrow('Connected account changed')
    expect(wallet.signTypedDataAsync).not.toHaveBeenCalled()
    expect(wallet.switchChainAsync).not.toHaveBeenCalled()
  })

  it('switches to the reviewed chain and verifies it before signing', async () => {
    wallet.account.chainId = 1
    installReview()
    await expect(sign()).resolves.toBe(SIGNATURE)
    expect(wallet.switchChainAsync).toHaveBeenCalledExactlyOnceWith({ chainId: AUTHORIZATION.chainId })
    expect(review.mock.invocationCallOrder[0]).toBeLessThan(wallet.switchChainAsync.mock.invocationCallOrder[0])
    expect(wallet.switchChainAsync.mock.invocationCallOrder[0]).toBeLessThan(wallet.signTypedDataAsync.mock.invocationCallOrder[0])
  })

  it.each(['wrong chain', 'different account', 'disconnected'] as const)('does not sign if the wallet changes during chain switching: %s', async change => {
    wallet.account.chainId = 1
    wallet.switchChainAsync.mockImplementation(async () => {
      wallet.account = {
        address: change === 'different account' ? OTHER : change === 'disconnected' ? undefined : ACCOUNT,
        chainId: change === 'wrong chain' ? 10 : AUTHORIZATION.chainId,
      }
    })
    installReview()
    await expect(sign()).rejects.toThrow('Wallet account or network changed. Review the payment again.')
    expect(wallet.signTypedDataAsync).not.toHaveBeenCalled()
  })

  it('propagates a rejected chain switch without requesting a signature', async () => {
    wallet.account.chainId = 1
    wallet.switchChainAsync.mockRejectedValue(new Error('User rejected chain switch'))
    installReview()
    await expect(sign()).rejects.toThrow('User rejected chain switch')
    expect(wallet.signTypedDataAsync).not.toHaveBeenCalled()
  })

  it.each(['wrong chain', 'different account', 'disconnected'] as const)('discards a signature if wallet context changed while signing: %s', async change => {
    wallet.signTypedDataAsync.mockImplementation(async () => {
      wallet.account = {
        address: change === 'different account' ? OTHER : change === 'disconnected' ? undefined : ACCOUNT,
        chainId: change === 'wrong chain' ? 1 : AUTHORIZATION.chainId,
      }
      return SIGNATURE
    })
    installReview()
    await expect(sign()).rejects.toThrow('Wallet account or network changed after signing. Nothing was sent.')
    expect(wallet.signTypedDataAsync).toHaveBeenCalledTimes(1)
  })

  it('propagates wallet signature rejection rather than returning an authorization', async () => {
    wallet.signTypedDataAsync.mockRejectedValue(new Error('User rejected signature'))
    installReview()
    await expect(sign()).rejects.toThrow('User rejected signature')
  })

  it('blocks View as before review or wallet prompts', async () => {
    installReview()
    setViewAs(OTHER)
    await expect(sign()).rejects.toThrow(VIEW_AS_WRITE_BLOCKED)
    expect(review).not.toHaveBeenCalled()
    expect(wallet.switchChainAsync).not.toHaveBeenCalled()
    expect(wallet.signTypedDataAsync).not.toHaveBeenCalled()
  })

  it('blocks View as entered during review before switching chains or signing', async () => {
    wallet.account.chainId = 1
    review.mockImplementation(async () => { setViewAs(OTHER); return true })
    installReview()
    await expect(sign()).rejects.toThrow(VIEW_AS_WRITE_BLOCKED)
    expect(wallet.switchChainAsync).not.toHaveBeenCalled()
    expect(wallet.signTypedDataAsync).not.toHaveBeenCalled()
  })

  it('blocks View as entered during chain switching before signing', async () => {
    wallet.account.chainId = 1
    wallet.switchChainAsync.mockImplementation(async () => {
      wallet.account.chainId = AUTHORIZATION.chainId
      setViewAs(OTHER)
    })
    installReview()
    await expect(sign()).rejects.toThrow(VIEW_AS_WRITE_BLOCKED)
    expect(wallet.signTypedDataAsync).not.toHaveBeenCalled()
  })

  it('discards a signature if View as was entered while the wallet was signing', async () => {
    wallet.signTypedDataAsync.mockImplementation(async () => { setViewAs(OTHER); return SIGNATURE })
    installReview()
    await expect(sign()).rejects.toThrow(VIEW_AS_WRITE_BLOCKED)
    expect(wallet.signTypedDataAsync).toHaveBeenCalledTimes(1)
  })

  it('retains wallet and View as guards when a parent already reviewed the authorization', async () => {
    await act(async () => root.render(<Harness reviewedInParent />))
    await expect(sign()).resolves.toBe(SIGNATURE)
    wallet.signTypedDataAsync.mockClear()
    wallet.account.address = OTHER
    await expect(sign()).rejects.toThrow('Connected account changed')
    expect(wallet.signTypedDataAsync).not.toHaveBeenCalled()
    wallet.account.address = ACCOUNT
    setViewAs(OTHER)
    await expect(sign()).rejects.toThrow(VIEW_AS_WRITE_BLOCKED)
    expect(wallet.signTypedDataAsync).not.toHaveBeenCalled()
  })
})
