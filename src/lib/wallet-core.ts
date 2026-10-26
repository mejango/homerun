'use client'

import {
  getAccount,
  getPublicClient,
  getWalletClient,
  switchChain,
} from '@wagmi/core'
import type { JBChainId } from '@bananapus/nana-sdk-core'
import type { Address, PublicClient } from 'viem'
import { wagmiConfig } from '@/providers/Providers'
import { chainName } from '@/lib/urn'
import { assertReviewedAccountConnected } from '@/lib/contract-write'
import { assertNoViewAs } from '@/lib/viewAs'
import { isSafeConnection } from '@/lib/safe-connector'

/**
 * Shared wagmi identity plumbing for transaction and signature boundaries.
 * Product journals and execution policy remain in their owning adapters.
 */

/** The live account, chain and execution route must match the reviewed request. */
export function assertReviewedWallet({ account, chainId, safe, allowCenter = false }: {
  account: Address; connectorUid: string | undefined; chainId?: number; safe: boolean; allowCenter?: boolean
}, message = 'Wallet connection changed. Review the transaction again.'): void {
  assertNoViewAs()
  const current = getAccount(wagmiConfig)
  assertReviewedAccountConnected(account, current.address, message)
  if ((chainId !== undefined && current.chainId !== chainId) ||
      isSafeConnection(wagmiConfig) !== safe || (!allowCenter && current.connector?.id === 'juicebox-center')) {
    throw new Error(message)
  }
}

/** Acquire the live connector after preparation, then invoke without another await. */
export async function withReviewedWallet<T>(
  authority: Parameters<typeof assertReviewedWallet>[0],
  invoke: (wallet: Awaited<ReturnType<typeof getWalletClient>>) => T,
  message?: string,
): Promise<Awaited<T>> {
  for (let attempt = 0; attempt < 3; attempt++) {
    assertReviewedWallet(authority, message)
    const connection = getAccount(wagmiConfig)
    const wallet = await getWalletClient(wagmiConfig, {
      account: authority.account, connector: connection.connector,
      ...(authority.chainId !== undefined ? { chainId: authority.chainId as JBChainId } : {}),
    })
    assertReviewedWallet(authority, message)
    if (getAccount(wagmiConfig).connector?.uid !== connection.connector?.uid) continue
    return await invoke(wallet)
  }
  throw new Error(message ?? 'Wallet connection changed. Review the transaction again.')
}

export function publicClient(chainId: JBChainId): PublicClient {
  const client = getPublicClient(wagmiConfig, { chainId })
  if (!client) throw new Error(`No RPC client is configured for chain ${chainId}.`)
  return client as PublicClient
}

/**
 * The connected wallet client on `chainId`, switching chains when needed.
 * Throws `changedError` if the account is missing afterwards, differs from
 * `expected`, or (with `requireUnchanged`) differs from the account that was
 * connected before the switch.
 */
export async function connectedWallet(
  chainId: JBChainId,
  {
    expected,
    requireUnchanged = false,
    changedError,
  }: {
    expected?: Address
    requireUnchanged?: boolean
    changedError: string
  },
) {
  const before = getAccount(wagmiConfig)
  const safe = isSafeConnection(wagmiConfig)
  if (!before.address) throw new Error('Connect a wallet first.')
  if (before.chainId !== chainId) {
    await switchChain(wagmiConfig, { chainId }).catch(error => {
      // Safe apps cannot switch chains; the wagmi error only names the connector.
      throw /does not support chain switching/.test(String(error))
        ? new Error(`This wallet cannot switch chains. Open it on ${chainName(chainId)} and try again.`)
        : error
    })
  }
  const wallet = await getWalletClient(wagmiConfig, { chainId })
  const account = getAccount(wagmiConfig).address
  if (
    !account ||
    (requireUnchanged &&
      account.toLowerCase() !== before.address.toLowerCase()) ||
    (expected && account.toLowerCase() !== expected.toLowerCase())
  ) {
    throw new Error(changedError)
  }
  assertReviewedWallet({ account: expected ?? (requireUnchanged ? before.address : account), connectorUid: before.connector?.uid, chainId, safe }, changedError)
  return { wallet, account }
}
