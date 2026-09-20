import type { Address } from 'viem'

/** Stand-in registry entries until verified Homerun contracts enter the SDK registry. */
export const HOMERUN_DEPLOYER = '0x4444444444444444444444444444444444444444' as Address
export const HOMERUN_ALLOWLIST_HOOK = '0x4545454545454545454545454545454545454545' as Address

export function withHomerunDeployer<T extends { jbContractAddress: Record<string, Record<string, unknown>> }>(actual: T, chainIds: readonly number[] = [1, 10, 8453, 42161, 11155111, 11155420, 84532, 421614]): T {
  return { ...actual, jbContractAddress: { ...actual.jbContractAddress, '6': { ...actual.jbContractAddress['6'], HomerunDeployer: Object.fromEntries(chainIds.map(id => [id, HOMERUN_DEPLOYER])), HomerunAllowlistHook: Object.fromEntries(chainIds.map(id => [id, HOMERUN_ALLOWLIST_HOOK])) } } }
}
