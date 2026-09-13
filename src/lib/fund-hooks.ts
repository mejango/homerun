/** Canonical stock NFT hooks are independent of FUND's project-token ownership. */
import { jb721TiersHookAbi, jb721TiersHookStoreAbi, type JBChainId } from '@bananapus/nana-sdk-core'
import { v6Address } from '@bananapus/nana-sdk-core/v6'
import { isAddressEqual, parseAbi, zeroAddress, type Address, type PublicClient } from 'viem'

export type VerifiedProject721Hook = {
  address: Address
  verified: true
  hasTiers: boolean
}

const registryAbi = parseAbi(['function deployerOf(address addr) view returns (address)'])

export class UnsupportedProject721HookError extends Error {
  constructor() {
    super('The NFT hook has no verified canonical stock deployment.')
  }
}

/**
 * Interface responses alone cannot prove that an unknown contract is a stock
 * hook. The canonical registry proves deployment by the canonical clone factory;
 * all mutable project/ownership bindings are then checked at the same block.
 * FUND deployers bind ownership to the project NFT. REVDeployer instead binds
 * the hook directly to REVOwner, selected explicitly by `ownership: 'address'`.
 */
export async function readVerifiedProject721Hook(client: PublicClient, input: {
  chainId: JBChainId
  projectId: bigint
  owner: Address
  hook: Address
  blockNumber: bigint
  ownership?: 'project' | 'address'
}): Promise<VerifiedProject721Hook> {
  const { chainId, projectId, owner, hook, blockNumber } = input
  const at = { blockNumber }
  const deployer = await client.readContract({
    address: v6Address('JBAddressRegistry', chainId), abi: registryAbi,
    functionName: 'deployerOf', args: [hook], ...at,
  })
  if (isAddressEqual(hook, zeroAddress) || !isAddressEqual(deployer, v6Address('JB721TiersHookDeployer', chainId))) {
    throw new UnsupportedProject721HookError()
  }
  const [store, directory, projects, hookProjectId, scope, hookOwner] = await Promise.all([
    client.readContract({ address: hook, abi: jb721TiersHookAbi, functionName: 'STORE', ...at }),
    client.readContract({ address: hook, abi: jb721TiersHookAbi, functionName: 'DIRECTORY', ...at }),
    client.readContract({ address: hook, abi: jb721TiersHookAbi, functionName: 'PROJECTS', ...at }),
    client.readContract({ address: hook, abi: jb721TiersHookAbi, functionName: 'projectId', ...at }),
    client.readContract({ address: hook, abi: jb721TiersHookAbi, functionName: 'jbOwner', ...at }),
    client.readContract({ address: hook, abi: jb721TiersHookAbi, functionName: 'owner', ...at }),
  ])
  const scoped = input.ownership === 'address'
    ? scope[1] === 0n && isAddressEqual(scope[0], owner)
    : scope[1] === projectId
  if (!isAddressEqual(store, v6Address('JB721TiersHookStore', chainId)) ||
    !isAddressEqual(directory, v6Address('JBDirectory', chainId)) ||
    !isAddressEqual(projects, v6Address('JBProjects', chainId)) || hookProjectId !== projectId ||
    !scoped || !isAddressEqual(hookOwner, owner)) {
    throw new Error('The NFT hook is not scoped to this project and its current owner.')
  }
  const maximumTier = await client.readContract({ address: store, abi: jb721TiersHookStoreAbi, functionName: 'maxTierIdOf', args: [hook], ...at })
  return { address: hook, verified: true, hasTiers: maximumTier !== 0n }
}

/** Only evidence for the exact attached hook can authorize a lifecycle write. */
export function isVerifiedProject721Hook(hook: VerifiedProject721Hook | undefined, address: Address): boolean {
  return Boolean(hook?.verified === true && !isAddressEqual(address, zeroAddress) && isAddressEqual(hook.address, address))
}
