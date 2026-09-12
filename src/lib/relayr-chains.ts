// Relayr /v1/chains supports both Juicebox chain families. A funding review
// stays within its destination family so testnet actions cannot spend mainnet ETH.
const MAINNETS = [1, 10, 8453, 42161] as const
const TESTNETS = [11155111, 11155420, 84532, 421614] as const

export function relayrSupportsChain(chainId: number): boolean {
  return [...MAINNETS, ...TESTNETS].some(chain => chain === chainId)
}

export function relayrSupportsChains(chainIds: readonly number[]): boolean {
  return chainIds.length > 0 && new Set(chainIds).size === chainIds.length &&
    [MAINNETS, TESTNETS].some(family => chainIds.every(chainId => family.some(chain => chain === chainId)))
}

export function relayrPaymentChains(chainIds: readonly number[]): number[] {
  if (!relayrSupportsChains(chainIds)) return []
  return MAINNETS.some(chain => chain === chainIds[0]) ? [...MAINNETS] : [...TESTNETS]
}
