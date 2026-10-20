import type { Address } from 'viem'

/**
 * Registry entries for the SDK's `jbV6ContractAddress` lookup, until verified
 * Homerun contracts enter the SDK registry itself. These are the real deployed
 * addresses from src/lib/homerun-addresses.ts: one CREATE2 address on every chain.
 */
export const HOMERUN_DEPLOYER = '0x19Ce092bc3f9662E40C4670C68ff03C8322D0E76' as Address
export const HOMERUN_ALLOWLIST_HOOK = '0x8eB05510db1658F3d369b6Eb097C8Ae713C6548d' as Address

export function withHomerunDeployer<T extends { jbV6ContractAddress: Record<string, unknown> }>(actual: T, chainIds: readonly number[] = [1, 10, 8453, 42161, 11155111, 11155420, 84532, 421614]): T {
  return { ...actual, jbV6ContractAddress: { ...actual.jbV6ContractAddress, HomerunDeployer: Object.fromEntries(chainIds.map(id => [id, HOMERUN_DEPLOYER])), HomerunAllowlistHook: Object.fromEntries(chainIds.map(id => [id, HOMERUN_ALLOWLIST_HOOK])) } }
}
