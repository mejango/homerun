'use client'

import { getAccount, getPublicClient } from '@wagmi/core'
import type { JBChainId } from '@bananapus/nana-sdk-core'
import type { Address, PublicClient } from 'viem'
import { wagmiConfig } from '@/providers/Providers'
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

export function publicClient(chainId: JBChainId): PublicClient {
  const client = getPublicClient(wagmiConfig, { chainId })
  if (!client) throw new Error(`No RPC client is configured for chain ${chainId}.`)
  return client as PublicClient
}
