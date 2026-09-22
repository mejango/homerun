import type { Address } from 'viem'

/**
 * Registry entries for the SDK's `jbContractAddress['6']` lookup, until verified
 * Homerun contracts enter the SDK registry itself. These are the real deployed
 * addresses from src/lib/homerun-addresses.ts: one CREATE2 address per chain
 * group, the same values the SDK's `decodeDeploymentCall` homerun-fund flavor
 * hardcodes. A fixture value that diverges from those addresses would make
 * every decoded Homerun call read back as "unknown".
 */
export const HOMERUN_DEPLOYER = '0xAC9250654ea223513FfEe25fDB647Dc016873905' as Address
export const HOMERUN_DEPLOYER_TESTNET = '0xe944Fe96765450877f95cC36AA36EC72B4388721' as Address
export const HOMERUN_ALLOWLIST_HOOK = '0x99cC605F86595c55AF5A7e734379c2546796d0f5' as Address
const MAINNETS = new Set([1, 10, 8453, 42161])

export function withHomerunDeployer<T extends { jbContractAddress: Record<string, Record<string, unknown>> }>(actual: T, chainIds: readonly number[] = [1, 10, 8453, 42161, 11155111, 11155420, 84532, 421614]): T {
  return { ...actual, jbContractAddress: { ...actual.jbContractAddress, '6': { ...actual.jbContractAddress['6'], HomerunDeployer: Object.fromEntries(chainIds.map(id => [id, MAINNETS.has(id) ? HOMERUN_DEPLOYER : HOMERUN_DEPLOYER_TESTNET])), HomerunAllowlistHook: Object.fromEntries(chainIds.map(id => [id, HOMERUN_ALLOWLIST_HOOK])) } } }
}
