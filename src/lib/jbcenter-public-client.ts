import { createPublicClient, type PublicClient } from 'viem'
import { SUPPORTED_CHAINS } from '@/lib/chains'
import { jbCenterRpcTransport } from '@/lib/jbcenter-rpc'

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
