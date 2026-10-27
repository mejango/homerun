'use client'

import { ReviewLineError, type ReviewedSendDeps, type WalletAdapter } from '@bananapus/nana-sdk-core/review'
import type { Address } from 'viem'
import { getAccount, getWalletClient, switchChain } from '@wagmi/core'
import type { JBChainId } from '@bananapus/nana-sdk-core'
import { isSafeConnection } from '@/lib/safe-connector'
import { getViewAs, VIEW_AS_WRITE_BLOCKED } from '@/lib/viewAs'
import { chainName } from '@/lib/urn'
import { publicClient } from '@/lib/wallet-core'
import { holds } from '@/lib/write-hold'
import { wagmiConfig } from '@/providers/Providers'

const CHANGED = 'Wallet connection changed. Review the transaction again.'
type Client = Awaited<ReturnType<typeof getWalletClient>>

/** A refusal raised before any wallet method ran: nothing was sent. */
class WalletAcquisitionRefusal extends ReviewLineError {
  readonly walletNotInvoked = true
  constructor(message: string, readonly acquisitionCause: unknown) { super(message) }
}
/** The same refusal for a write, as the 4001 core releases its held step on. Never leaves the engine: see `readableWrite`. */
class UninvokedWalletWrite extends WalletAcquisitionRefusal {
  readonly code = 4001
}

/** Branded locally: a provider cannot classify an invoked request as unsent by setting a field. */
export const isWalletNotInvoked = (error: unknown): boolean => error instanceof WalletAcquisitionRefusal

/** Core has released the step by now; its caller shows the real refusal, not a cancellation. */
async function readableWrite<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (error) {
    if (error instanceof UninvokedWalletWrite) throw new WalletAcquisitionRefusal(error.message, error.acquisitionCause)
    throw error
  }
}
const ENTRY_POINTS = ['sendReviewed', 'resumeReviewed', 'payRelayrReviewed'] as const
/** A loaded core engine whose sends answer an unsent write as its real refusal; every send through this adapter takes it from here. */
export function readableEngine<E extends object>(engine: E): E {
  const wrapped: Record<string, unknown> = { ...(engine as Record<string, unknown>) }
  for (const name of ENTRY_POINTS) {
    const send = (engine as Record<string, unknown>)[name]
    if (typeof send === 'function') wrapped[name] = (...args: unknown[]) => readableWrite(() => (send as (...a: unknown[]) => Promise<unknown>)(...args))
  }
  return wrapped as E
}

/**
 * Fetches the live connector's client and calls the wallet in the same continuation: no await
 * separates the last account, chain, Safe and connector check from the call, so a connector
 * switched in between is fetched again (up to three times) and the old one is never invoked.
 */
async function invoke<T>(chainId: number | undefined, call: (client: Client, account: Address) => T, releaseUnsent = false): Promise<Awaited<T>> {
  let client: Client | undefined, asked: Address | undefined
  try {
    asked = getAccount(wagmiConfig).address
    if (!asked) throw new ReviewLineError('Connect a wallet first.')
    const account = asked, chain = chainId ?? getAccount(wagmiConfig).chainId, safe = isSafeConnection(wagmiConfig)
    const current = () => {
      if (getViewAs()) throw new ReviewLineError(VIEW_AS_WRITE_BLOCKED)
      const live = getAccount(wagmiConfig)
      if (live.address?.toLowerCase() !== account.toLowerCase()) throw new ReviewLineError('The connected account changed. Review again.')
      if (live.chainId !== chain || isSafeConnection(wagmiConfig) !== safe || live.connector?.id === 'juicebox-center') throw new ReviewLineError(CHANGED)
      return live.connector
    }
    for (let attempt = 0; attempt < 3 && !client; attempt++) {
      const connector = current()
      const fetched = await getWalletClient(wagmiConfig, { account, connector, ...(chain === undefined ? {} : { chainId: chain as JBChainId }) })
      if (current()?.uid === connector?.uid) client = fetched
    }
    if (!client) throw new ReviewLineError(CHANGED)
  } catch (cause) {
    // Only this path, before any wallet method ran, proves nothing was sent; the wallet's own errors stay as they are.
    const Refusal = releaseUnsent ? UninvokedWalletWrite : WalletAcquisitionRefusal
    throw new Refusal(cause instanceof Error ? cause.message : CHANGED, cause)
  }
  // No await separates the last check from the call.
  return await call(client, asked)
}
const chainOf = (client: Client, chainId: number) => client.chain?.id === chainId ? client.chain : { id: chainId } as Client['chain']

/** Homerun's wallet as core's reviewed sends use it: the connected wagmi wallet, switched to the chain each call is on. */
export const walletAdapter: WalletAdapter = {
  kind: 'wallet',
  account: () => getAccount(wagmiConfig).address,
  chainId: () => getAccount(wagmiConfig).chainId,
  isSafe: () => isSafeConnection(wagmiConfig),
  switchChain: async chainId => {
    await switchChain(wagmiConfig, { chainId: chainId as JBChainId }).catch(() => {
      throw new ReviewLineError(`Switch your wallet to ${chainName(chainId)} to continue.`)
    })
  },
  sendTransaction: ({ chainId, to, data, value, gas }) => invoke(chainId, (client, account) =>
    client.sendTransaction({ account, chain: chainOf(client, chainId), to, data, value, ...(gas === undefined ? {} : { gas }) }), true),
  // viem does not check the wallet's chain against the domain's; invoke does.
  signTypedData: typedData => invoke(typedData.domain?.chainId === undefined ? undefined : Number(typedData.domain.chainId),
    (client, account) => client.signTypedData({ ...typedData, account } as Parameters<Client['signTypedData']>[0])),
  signMessage: message => invoke(undefined, (client, account) => client.signMessage({ account, message })),
  sendCalls: (chainId, calls) => invoke(chainId, async (client, account) =>
    (await client.sendCalls({ account, chain: chainOf(client, chainId), calls: calls.map(({ to, data, value }) => ({ to, data, value })) })).id, true),
}

/** What every reviewed send goes through: the wallet, each chain's client, and the app's one write hold. */
export const reviewedSendDeps: ReviewedSendDeps = {
  adapter: walletAdapter,
  clientFor: chainId => publicClient(chainId as JBChainId),
  hold: holds,
}

