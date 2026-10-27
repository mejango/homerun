'use client'

import { ReviewLineError, viemWalletAdapter, type ReviewedSendDeps, type WalletAdapter } from '@bananapus/nana-sdk-core/review'
import type { WalletClient } from 'viem'
import { getAccount, getWalletClient, switchChain } from '@wagmi/core'
import type { JBChainId } from '@bananapus/nana-sdk-core'
import { isSafeConnection } from '@/lib/safe-connector'
import { getViewAs, VIEW_AS_WRITE_BLOCKED } from '@/lib/viewAs'
import { chainName } from '@/lib/urn'
import { publicClient } from '@/lib/wallet-core'
import { holds } from '@/lib/write-hold'
import { wagmiConfig } from '@/providers/Providers'

/**
 * Homerun's wallet as core's reviewed sends use it: core's adapter over the connected wagmi
 * connector, switched to the chain each call is on. View-as and the Center wallet are refused,
 * with core's own checks, as each request reaches the wallet.
 */
export const walletAdapter: WalletAdapter = viemWalletAdapter({
  walletClient: () => {
    const { address, chainId, connector } = getAccount(wagmiConfig)
    return getWalletClient(wagmiConfig, { account: address, chainId: chainId as JBChainId, connector }) as Promise<WalletClient>
  },
  account: () => getAccount(wagmiConfig).address,
  chainId: () => getAccount(wagmiConfig).chainId,
  isSafe: () => isSafeConnection(wagmiConfig),
  switchChain: chainId => switchChain(wagmiConfig, { chainId: chainId as JBChainId }).catch(() => {
    throw new ReviewLineError(`Switch your wallet to ${chainName(chainId)} to continue.`)
  }),
  connector: () => getAccount(wagmiConfig).connector?.uid,
  check: () => {
    if (getViewAs()) throw new ReviewLineError(VIEW_AS_WRITE_BLOCKED)
    if (getAccount(wagmiConfig).connector?.id === 'juicebox-center') throw new ReviewLineError('Wallet connection changed. Review the transaction again.')
  },
})

/** What every reviewed send goes through: the wallet, each chain's client, and the app's one write hold. */
export const reviewedSendDeps: ReviewedSendDeps = {
  adapter: walletAdapter,
  clientFor: chainId => publicClient(chainId as JBChainId),
  hold: holds,
}
