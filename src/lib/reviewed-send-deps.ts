'use client'

import { ReviewLineError, viemWalletAdapter, type ReviewedSendDeps } from '@bananapus/nana-sdk-core/review'
import { getAccount, getWalletClient, switchChain } from '@wagmi/core'
import type { JBChainId } from '@bananapus/nana-sdk-core'
import { isSafeConnection } from '@/lib/safe-connector'
import { getViewAs, VIEW_AS_WRITE_BLOCKED } from '@/lib/viewAs'
import { chainName } from '@/lib/urn'
import { publicClient } from '@/lib/wallet-core'
import { holds } from '@/lib/write-hold'
import { wagmiConfig } from '@/providers/Providers'

/** Homerun's wallet as core's reviewed sends use it: the connected wagmi wallet, switched to the chain each call is on. */
export const walletAdapter = viemWalletAdapter({
  // Core rechecks the account, chain and Safe mode around this; view-as and the Center wallet are homerun's own.
  walletClient: async () => {
    const client = await getWalletClient(wagmiConfig)
    if (getViewAs()) throw new ReviewLineError(VIEW_AS_WRITE_BLOCKED)
    if (getAccount(wagmiConfig).connector?.id === 'juicebox-center') throw new ReviewLineError('Wallet connection changed. Review the transaction again.')
    return client
  },
  account: () => getAccount(wagmiConfig).address,
  chainId: () => getAccount(wagmiConfig).chainId,
  isSafe: () => isSafeConnection(wagmiConfig),
  switchChain: chainId => switchChain(wagmiConfig, { chainId: chainId as JBChainId }).catch(() => {
    throw new ReviewLineError(`Switch your wallet to ${chainName(chainId)} to continue.`)
  }),
})

/** What every reviewed send goes through: the wallet, each chain's client, and the app's one write hold. */
export const reviewedSendDeps: ReviewedSendDeps = {
  adapter: walletAdapter,
  clientFor: chainId => publicClient(chainId as JBChainId),
  hold: holds,
}

