'use client'

import { ReviewLineError, viemWalletAdapter, type ReviewedSendDeps } from '@bananapus/nana-sdk-core/review'
import { getAccount, getWalletClient, switchChain } from '@wagmi/core'
import type { JBChainId } from '@bananapus/nana-sdk-core'
import { isSafeConnection } from '@/lib/safe-connector'
import { chainName } from '@/lib/urn'
import { publicClient } from '@/lib/wallet-core'
import { holds } from '@/lib/write-hold'
import { wagmiConfig } from '@/providers/Providers'

/** Homerun's wallet as core's reviewed sends use it: the connected wagmi wallet, switched to the chain each call is on. */
export const walletAdapter = viemWalletAdapter({
  walletClient: () => getWalletClient(wagmiConfig),
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

