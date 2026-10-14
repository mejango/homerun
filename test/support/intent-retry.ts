import { encodeFunctionData } from 'viem'
import { expect, vi } from 'vitest'
import { createHeldWriteStorage, createWriteHold, WriteHeldError } from '@bananapus/nana-sdk-core/review'
import type { TxRequest, TxSendOptions } from '@/hooks/useSafeTx'
import { installRecoveryLocks } from '../runtime/write-recovery-fixture'
import { wallet } from './fake-wallet'

/** One attempt at a write, as a flow handed it to useSafeTx. */
export type SentWrite = { request: TxRequest; options: TxSendOptions }

const callOf = (request: TxRequest) => ({
  to: request.address,
  data: encodeFunctionData({ abi: request.abi, functionName: request.functionName, args: request.args as unknown[] }),
  value: request.value ?? 0n,
})

/**
 * Two attempts at one write whose calldata is rebuilt on retry: both carry `namespace`, their
 * calldata differs (the volatile field regenerated), and the SDK's write hold, run on exactly these
 * calls, refuses the retry before the wallet opens while the first is held after a lost wallet reply.
 */
export async function expectRetryHeldByIntent(first: SentWrite, retry: SentWrite, namespace: string): Promise<void> {
  expect(first.options.recoveryNamespace).toBe(namespace)
  expect(retry.options.recoveryNamespace).toBe(namespace)
  const calls = [callOf(first.request), callOf(retry.request)] as const
  expect(calls[1]).not.toEqual(calls[0])
  installRecoveryLocks()
  localStorage.clear()
  const holds = createWriteHold({ storage: createHeldWriteStorage() })
  const input = (sent: SentWrite, call: (typeof calls)[number]) =>
    ({ chainId: sent.request.chainId, account: sent.options.reviewedAccount, safe: false, namespace, call })
  try {
    // The first attempt's wallet reply is lost: it may have been sent, so it stays held.
    await expect(holds.open(input(first, calls[0])).send(wallet.client as never, async gate => {
      await gate.beforeSend()
      throw new Error('Wallet reply was lost after broadcast')
    })).rejects.toThrow('Wallet reply was lost')
    // The retry, with its regenerated field, is refused before its wallet step.
    const opened = vi.fn()
    await expect(holds.open(input(retry, calls[1])).send(wallet.client as never, async () => { opened() }))
      .rejects.toBeInstanceOf(WriteHeldError)
    expect(opened).not.toHaveBeenCalled()
  } finally {
    holds.dispose()
    localStorage.clear()
  }
}
