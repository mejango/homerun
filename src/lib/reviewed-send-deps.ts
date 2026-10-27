'use client'

import { ReviewLineError, type ReviewedSendDeps, type WalletAdapter } from '@bananapus/nana-sdk-core/review'
import { createWalletClient, custom, type Address } from 'viem'
import { getAccount, getWalletClient, switchChain } from '@wagmi/core'
import type { JBChainId } from '@bananapus/nana-sdk-core'
import { isSafeConnection } from '@/lib/safe-connector'
import { getViewAs, VIEW_AS_WRITE_BLOCKED } from '@/lib/viewAs'
import { chainName } from '@/lib/urn'
import { publicClient } from '@/lib/wallet-core'
import { holds } from '@/lib/write-hold'
import { wagmiConfig } from '@/providers/Providers'

const CHANGED = 'Wallet connection changed. Review the transaction again.'
const CONNECT = 'Connect a wallet first.'
const ACCOUNT_CHANGED = 'The connected account changed. Review again.'
/** Homerun's own refusals keep their line; any other failure before the wallet (a provider's text) gets this one. */
const OWN_LINES = new Set([CHANGED, CONNECT, ACCOUNT_CHANGED, VIEW_AS_WRITE_BLOCKED])
const UNREACHABLE = 'Your wallet could not be reached. Nothing was sent; try again.'
/** The provider requests that sign or send: each one is checked again right as it is forwarded. */
const WALLET_METHODS = new Set([
  'eth_sendTransaction',
  'wallet_sendTransaction',
  'wallet_sendCalls',
  'eth_signTypedData_v4',
  'personal_sign',
])
type Client = Awaited<ReturnType<typeof getWalletClient>>

/** A refusal raised before any wallet request was forwarded: nothing was sent. */
class WalletAcquisitionRefusal extends ReviewLineError {
  readonly walletNotInvoked = true
  constructor(message: string, readonly acquisitionCause: unknown) { super(message) }
}
/** The same refusal for a write, as the 4001 core releases its held step on. Shown through `readableRefusal`. */
class UninvokedWalletWrite extends WalletAcquisitionRefusal {
  readonly code = 4001
}
function unsent(cause: unknown, releaseUnsent: boolean) {
  const message = cause instanceof ReviewLineError && OWN_LINES.has(cause.message) ? cause.message : UNREACHABLE
  return new (releaseUnsent ? UninvokedWalletWrite : WalletAcquisitionRefusal)(message, cause)
}
/** The refusal anywhere in an error's causes (viem wraps what its transport throws). */
function refusalIn(error: unknown): WalletAcquisitionRefusal | undefined {
  let current = error
  for (let depth = 0; depth < 8 && current && typeof current === 'object'; depth += 1) {
    if (current instanceof WalletAcquisitionRefusal) return current
    current = (current as { cause?: unknown }).cause
  }
}

/** Branded locally: a provider cannot classify an invoked request as unsent by setting a field. */
export const isWalletNotInvoked = (error: unknown): boolean => error instanceof WalletAcquisitionRefusal

/** Once core and any journal have classified it, a write refusal is shown as its own line, not a cancellation. */
export function readableRefusal(error: unknown): unknown {
  return error instanceof UninvokedWalletWrite ? new WalletAcquisitionRefusal(error.message, error.acquisitionCause) : error
}
const ENTRY_POINTS = ['sendReviewed', 'resumeReviewed'] as const
/** A loaded core engine whose sends answer an unsent write as its real refusal; every send through this adapter takes it from here. */
export function readableEngine<E extends object>(engine: E): E {
  const wrapped: Record<string, unknown> = { ...(engine as Record<string, unknown>) }
  for (const name of ENTRY_POINTS) {
    const send = (engine as Record<string, unknown>)[name] as ((...args: unknown[]) => Promise<unknown>) | undefined
    if (typeof send === 'function') wrapped[name] = (...args: unknown[]) => send(...args).catch(error => { throw readableRefusal(error) })
  }
  return wrapped as E
}

/**
 * Fetches the live connector's client, then hands the call a client whose every signing or sending
 * request checks the account, chain, Safe mode, view-as, the Center wallet and the connector again
 * as it is forwarded to the provider, with nothing awaited in between: viem awaits its own reads
 * before it sends, so a check before the viem call alone is not the last one. A connector switched
 * while the client was fetched is fetched again, up to three times.
 */
async function invoke<T>(chainId: number | undefined, call: (client: Client, account: Address) => T, releaseUnsent = false): Promise<Awaited<T>> {
  let client: Client | undefined, asked: Address | undefined, check: (() => void) | undefined
  try {
    asked = getAccount(wagmiConfig).address
    if (!asked) throw new ReviewLineError(CONNECT)
    const account = asked, chain = chainId ?? getAccount(wagmiConfig).chainId, safe = isSafeConnection(wagmiConfig)
    const current = () => {
      if (getViewAs()) throw new ReviewLineError(VIEW_AS_WRITE_BLOCKED)
      const live = getAccount(wagmiConfig)
      if (live.address?.toLowerCase() !== account.toLowerCase()) throw new ReviewLineError(ACCOUNT_CHANGED)
      if (live.chainId !== chain || isSafeConnection(wagmiConfig) !== safe || live.connector?.id === 'juicebox-center') throw new ReviewLineError(CHANGED)
      return live.connector
    }
    for (let attempt = 0; attempt < 3 && !client; attempt++) {
      const connector = current()
      const fetched = await getWalletClient(wagmiConfig, { account, connector, ...(chain === undefined ? {} : { chainId: chain as JBChainId }) })
      if (current()?.uid !== connector?.uid) continue
      client = fetched
      check = () => { if (current()?.uid !== connector?.uid) throw new ReviewLineError(CHANGED) }
    }
    if (!client || !check) throw new ReviewLineError(CHANGED)
  } catch (cause) {
    throw unsent(cause, releaseUnsent)
  }
  const inner = client, recheck = check
  let forwarded = false
  const guarded = createWalletClient({
    account: inner.account, chain: inner.chain,
    transport: custom({ request: (args: { method: string; params?: unknown }) => {
      if (WALLET_METHODS.has(args.method)) {
        try { recheck() } catch (cause) {
          // Unsent only while no wallet request of this call has gone out.
          return Promise.reject(forwarded ? new ReviewLineError(CHANGED) : unsent(cause, releaseUnsent))
        }
        forwarded = true
      }
      return inner.request(args as never)
    } }, { retryCount: 0 }),
  }) as unknown as Client
  try {
    return await call(guarded, asked)
  } catch (error) {
    const refusal = refusalIn(error)
    if (refusal) throw refusal
    // viem failed before any wallet request went out (a chain read, a chain mismatch): nothing was sent.
    if (!forwarded) throw unsent(error, releaseUnsent)
    throw error
  }
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

