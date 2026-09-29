'use client'

import { useSyncExternalStore } from 'react'
import type { Hex } from 'viem'
import type { Config, Connector } from 'wagmi'
import { getAccount, getPublicClient, watchAccount } from 'wagmi/actions'
import {
  isSafeWalletPeer,
  waitForSafeExecutionHash as waitForSafeExecution,
} from '@bananapus/nana-sdk-core/safe-service'

export {
  SAFE_NONCE_GUIDANCE,
  SAFE_PREFIX,
  SAFE_SERVICE_PREFIX,
  safeQueueUrl,
  safeServiceBase,
  swapDeadline,
} from '@bananapus/nana-sdk-core/safe-service'

/** The config `watchSafeWalletPeer` follows; Safe tracking reads each chain through it. */
let watched: Config | undefined
/** Whether the connected WalletConnect peer is Safe{Wallet}. */
let safeWalletPeer = false
/** Counts session reads, so a slower read of an earlier connection never overwrites a newer answer. */
let reads = 0
const listeners = new Set<() => void>()

/**
 * Whether the connected wallet proposes to a Safe instead of sending: the Safe
 * app, or Safe{Wallet} over WalletConnect. Both make the gas a dapp sends the
 * proposal's safeTxGas and reply with a safeTxHash.
 */
export function isSafeConnection(config: Config): boolean {
  try {
    const id = getAccount(config).connector?.id
    return id === 'safe' || (id === 'walletConnect' && safeWalletPeer)
  } catch {
    return false
  }
}

/** `isSafeConnection` for rendering: it renders again once the WalletConnect peer is known. */
export function useSafeConnection(config: Config): boolean {
  return useSyncExternalStore(subscribe, () => isSafeConnection(config), () => false)
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * Follows `config`'s connection and records whether its WalletConnect peer is
 * Safe{Wallet}, which only the WalletConnect session tells. Safe tracking also
 * reads chains through `config` from now on. Returns the unwatch.
 */
export function watchSafeWalletPeer(config: Config): () => void {
  watched = config
  const check = async (connector: Connector | undefined) => {
    const read = ++reads
    let peer = false
    if (connector?.id === 'walletConnect') {
      try {
        const provider = (await connector.getProvider()) as
          | { session?: { peer?: { metadata?: { url?: string } } } }
          | undefined
        peer = isSafeWalletPeer(provider?.session?.peer?.metadata?.url)
      } catch {
        // A session that cannot be read is not known to be Safe{Wallet}.
      }
    }
    if (read !== reads) return
    safeWalletPeer = peer
    for (const listener of listeners) listener()
  }
  void check(getAccount(config).connector)
  return watchAccount(config, { onChange: account => void check(account.connector) })
}

/**
 * The SDK's wait for a Safe proposal's execution, with the chain's client from
 * the watched config: over WalletConnect, Safe{Wallet} replies with the
 * execution's own hash when the owner executes at once. An explicit `client` wins.
 */
export function waitForSafeExecutionHash(
  chainId: number,
  safeTxHash: Hex,
  options: NonNullable<Parameters<typeof waitForSafeExecution>[2]> = {},
): Promise<Hex> {
  return waitForSafeExecution(chainId, safeTxHash, {
    ...options,
    client: options.client ?? (watched && getPublicClient(watched, { chainId })),
  })
}
