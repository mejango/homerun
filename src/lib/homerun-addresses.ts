import type { JBChainId } from '@bananapus/nana-sdk-core'
import type { Address } from 'viem'

const CHAIN_IDS = [1, 10, 8453, 42161, 84532, 421614, 11155111, 11155420] as const satisfies readonly JBChainId[]
const onEveryChain = (address: Address): Partial<Record<JBChainId, Address>> =>
  Object.fromEntries(CHAIN_IDS.map(chainId => [chainId, address]))

/** Source: deployments/<network>/verified.json. One CREATE2 address on every chain. */
export const HOMERUN_ALLOWLIST_HOOK = onEveryChain('0x8eB05510db1658F3d369b6Eb097C8Ae713C6548d')
export const HOMERUN_DEPLOYER = onEveryChain('0x19Ce092bc3f9662E40C4670C68ff03C8322D0E76')
