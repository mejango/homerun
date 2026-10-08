import { createJBCenterRpcProvider, createPacedJBCenterLimiter } from '@bananapus/nana-sdk-core/jbcenter'
import { createPublicClient, custom, http, type PublicClient, type Transport } from 'viem'
import { SUPPORTED_CHAINS } from '@/lib/chains'
import { jbCenterAppOrigin, jbCenterBaseUrl } from '@/lib/jbcenter-config'

const FIXTURE_NETWORKS: Record<number, string> = {
  1: 'mainnet',
  10: 'optimism-mainnet',
  8453: 'base-mainnet',
  42161: 'arbitrum-mainnet',
  11155111: 'sepolia',
  11155420: 'optimism-sepolia',
  84532: 'base-sepolia',
  421614: 'arbitrum-sepolia',
}

const serverFetch: typeof fetch = (input, init) => {
  const headers = new Headers(init?.headers)
  headers.set('Origin', jbCenterAppOrigin())
  return fetch(input, { ...init, headers })
}

const browserLimiter = createPacedJBCenterLimiter()
const browserFetch: typeof fetch = (input, init) => window.fetch(input, init)

/** Center's RPC for `chainId`. Center load balances reads across nodes that
 * import blocks at slightly different times, so a read pinned to a block one
 * node has imported can land on one that has not, which answers JSON-RPC
 * -32001 ("Requested resource not found." in viem). The SDK's provider asks
 * again after 250, 500, 1,000, 2,000 and 2,000 ms: reading `latest` instead
 * would read state older than the block the read pins. The read's signal goes
 * with every try, and a wait between tries ends the moment it aborts. */
export function jbCenterRpcTransport(
  chainId: number,
  timeoutMs = 15_000,
): Transport {
  if (process.env.NEXT_PUBLIC_DETERMINISTIC_BROWSER === 'true') {
    const network = FIXTURE_NETWORKS[chainId]
    const origin =
      process.env.NEXT_PUBLIC_BROWSER_FIXTURE_ORIGIN ??
      'http://127.0.0.1:4399'
    return network ? http(`${origin}/rpc/${network}`) : http()
  }
  return custom(
    createJBCenterRpcProvider(chainId, {
      baseUrl: jbCenterBaseUrl(),
      fetch: typeof window === 'undefined' ? serverFetch : browserFetch,
      ...(typeof window === 'undefined' ? {} : { limiter: browserLimiter }),
      timeoutMs,
    }),
    { retryCount: 1 },
  )
}

const publicClients = new Map<number, PublicClient>()

/** One cached Center reader per chain. Multicall batching needs the chain's
 * multicall3 address; without `chain` viem quietly sends every read on its own,
 * and those bursts hit the one rate limit Center applies across all chains. */
export function jbCenterPublicClient(chainId: number): PublicClient {
  let client = publicClients.get(chainId)
  if (!client) {
    client = createPublicClient({
      chain: SUPPORTED_CHAINS.find(chain => chain.id === chainId),
      transport: jbCenterRpcTransport(chainId, 60_000),
      batch: { multicall: true },
    }) as PublicClient
    publicClients.set(chainId, client)
  }
  return client
}
