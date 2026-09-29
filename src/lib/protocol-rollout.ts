import snapshot from './protocol-rollout.json'

type ChainRecord = {
  alias: string
  contracts: Record<string, string | null>
  history: Record<string, { previous: string | null; v1: string | null }>
}

/**
 * Juicebox Money's deployment snapshot (its scripts/generate-protocol-rollout.mjs output,
 * copied with its source commit): each chain's current and earlier hook and terminal
 * generations, which the fee buyback review trusts. Replace with the SDK's once it carries them.
 */
export function rolloutChain(chainId: number): ChainRecord | undefined {
  return (snapshot.chains as Record<string, ChainRecord>)[chainId]
}
