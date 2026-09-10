/** Verified immutable initial-allocation state. Current FUND ownership does not change snapshot entitlements. */
import { jbContractAddress, USDC_ADDRESSES, type JBChainId } from '@bananapus/nana-sdk-core'
import { v6Address } from '@bananapus/nana-sdk-core/v6'
import { erc20Abi, getAddress, isAddress, isAddressEqual, parseAbi, zeroAddress, zeroHash, type Address, type Hex, type PublicClient } from 'viem'
import { homerunIncomeDeployerAbi as allocationLauncherViewAbi, INITIAL_INCOME_SUPPLY, registeredIncomeDeployer, registeredIncomeDistributor } from './income-contracts'
import { buildFundGlobalDistributionId } from './fund-global-manifest'
import { readIncomeProjectState } from './income-state'

/** Source: HomerunInitialIncomeVault.sol. Claims are perpetual and permissionless to the committed beneficiary. */
export const homerunInitialIncomeVaultAbi = parseAbi([
  'function FACTORY() view returns (address)',
  'function INCOME_TOKEN() view returns (address)',
  'function INCOME_PROJECT_ID() view returns (uint256)',
  'function FUND_PROJECT_ID() view returns (uint256)',
  'function SNAPSHOT_BLOCK_NUMBER() view returns (uint256)',
  'function SNAPSHOT_BLOCK_HASH() view returns (bytes32)',
  'function TOTAL_FUND_SUPPLY() view returns (uint256)',
  'function SOURCE_SET_HASH() view returns (bytes32)',
  'function LOCAL_INITIAL_INCOME_SUPPLY() view returns (uint256)',
  'function LAUNCH_SALT() view returns (bytes32)',
  'function MERKLE_ROOT() view returns (bytes32)',
  'function LEAF_COUNT() view returns (uint256)',
  'function MANIFEST_HASH() view returns (bytes32)',
  'function DISTRIBUTION_ID() view returns (bytes32)',
  'function INITIAL_INCOME_SUPPLY() view returns (uint256)',
  'function manifestUri() view returns (string)',
  'function totalClaimed() view returns (uint256)',
  'function isClaimed(uint256 index) view returns (bool)',
  'function leafHash(uint256 index, address beneficiary, uint256 fundBalance, uint256 incomeAmount) view returns (bytes32)',
  'function claim(uint256 index, address beneficiary, uint256 fundBalance, uint256 incomeAmount, bytes32[] proof)',
  'event Claimed(uint256 indexed index, address indexed beneficiary, uint256 fundBalance, uint256 incomeAmount, address caller)',
])

export type InitialIncomeAllocationState = {
  chainId: JBChainId; incomeProjectId: bigint; fundProjectId: bigint; account: Address | null
  blockNumber: bigint; blockHash: Hex; blockTimestamp: bigint
  deployer: Address; vault: Address; incomeToken: Address
  snapshotBlockNumber: bigint; snapshotBlockHash: Hex; sourceSetHash: Hex; totalFundSupply: bigint; launchSalt: Hex
  merkleRoot: Hex; leafCount: bigint; manifestHash: Hex; distributionId: Hex; manifestUri: string
  initialIncomeSupply: bigint; localInitialIncomeSupply: bigint; totalClaimed: bigint; vaultBalance: bigint; remainingUnclaimed: bigint
}

function positiveId(value: bigint, label: string) {
  if (value <= 0n || value >= 1n << 256n) throw new Error(`A positive ${label} is required.`)
}

async function assertCanonicalBlock(client: PublicClient, blockNumber: bigint, blockHash: Hex) {
  const block = await client.getBlock({ blockNumber })
  if (block.number !== blockNumber || !block.hash || block.hash.toLowerCase() !== blockHash.toLowerCase()) throw new Error('The chain changed during the initial INCOME allocation read. Refresh and retry.')
}

/**
 * Returns null only when the verified deployment is absent or has no allocation
 * binding. RPC failures and conflicting bindings never become a plausible empty
 * allocation. The caller must verify the public manifest/proof against these
 * immutable commitments before offering a claim.
 */
export async function readInitialIncomeAllocation(client: PublicClient, input: {
  chainId: number; incomeProjectId: bigint; fundProjectId: bigint; account?: Address
}): Promise<InitialIncomeAllocationState | null> {
  positiveId(input.incomeProjectId, 'INCOME project ID')
  positiveId(input.fundProjectId, 'FUND project ID')
  if (input.incomeProjectId === input.fundProjectId) throw new Error('FUND and INCOME must be distinct projects.')
  if (!Number.isSafeInteger(input.chainId) || input.chainId <= 0) throw new Error('A supported chain is required.')
  const chainId = input.chainId as JBChainId
  const deployer = registeredIncomeDeployer(chainId)
  if (!deployer) return null
  const distributor = registeredIncomeDistributor(chainId)
  const sticky = (jbContractAddress['6'] as Record<string, Partial<Record<JBChainId, Address>>>).JBStickyDeployer?.[chainId]
  if (!distributor || !sticky || !isAddress(sticky) || isAddressEqual(sticky, zeroAddress)) throw new Error('The initial INCOME launcher’s dependencies are not all registered on this chain.')

  const project = await readIncomeProjectState(client, { chainId, projectId: input.incomeProjectId, account: input.account })
  if (!project.tokenAddress) throw new Error('The INCOME ERC-20 must be deployed before its initial allocation can be verified.')
  const { blockNumber, blockHash, blockTimestamp } = project
  const at = { blockNumber }
  const expectedWiring = {
    CONTROLLER: v6Address('JBController', chainId), DIRECTORY: v6Address('JBDirectory', chainId),
    PROJECTS: v6Address('JBProjects', chainId), TOKENS: v6Address('JBTokens', chainId),
    REV_DEPLOYER: v6Address('REVDeployer', chainId), REV_OWNER: v6Address('REVOwner', chainId),
    SUCKER_REGISTRY: v6Address('JBSuckerRegistry', chainId), TOKEN_DISTRIBUTOR: distributor,
    STICKY_DEPLOYER: sticky, OMNICHAIN_DEPLOYER: v6Address('JBOmnichainDeployer', chainId), USDC: USDC_ADDRESSES[chainId],
  } as const
  const [deployerCode, actualWiring, binding, vault] = await Promise.all([
    client.getCode({ address: deployer, ...at }),
    Promise.all(Object.entries(expectedWiring).map(async ([key, expected]) => ({ expected, actual: await client.readContract({ address: deployer, abi: allocationLauncherViewAbi, functionName: key as keyof typeof expectedWiring, ...at }) }))),
    client.readContract({ address: deployer, abi: allocationLauncherViewAbi, functionName: 'incomeProjectIdOf', args: [input.fundProjectId], ...at }),
    client.readContract({ address: deployer, abi: allocationLauncherViewAbi, functionName: 'initialAllocationVaultOf', args: [input.fundProjectId], ...at }),
  ])
  if (!deployerCode || deployerCode === '0x') throw new Error('The registered INCOME launcher has no deployed code.')
  if (actualWiring.some(({ expected, actual }) => !isAddressEqual(expected, actual))) throw new Error('The initial INCOME launcher does not match the registered V6 contracts.')
  if (binding === 0n && isAddressEqual(vault, zeroAddress)) {
    await assertCanonicalBlock(client, blockNumber, blockHash)
    return null
  }
  if (binding !== input.incomeProjectId || isAddressEqual(vault, zeroAddress)) throw new Error('This FUND has no matching INCOME project and initial-allocation vault binding.')

  const [vaultCode, factory, incomeToken, incomeProjectId, fundProjectId, snapshotBlockNumber, snapshotBlockHash, totalFundSupply, sourceSetHash, launchSalt, merkleRoot, leafCount, manifestHash, distributionId, initialIncomeSupply, localInitialIncomeSupply, manifestUri, totalClaimed] = await Promise.all([
    client.getCode({ address: vault, ...at }),
    client.readContract({ address: vault, abi: homerunInitialIncomeVaultAbi, functionName: 'FACTORY', ...at }),
    client.readContract({ address: vault, abi: homerunInitialIncomeVaultAbi, functionName: 'INCOME_TOKEN', ...at }),
    client.readContract({ address: vault, abi: homerunInitialIncomeVaultAbi, functionName: 'INCOME_PROJECT_ID', ...at }),
    client.readContract({ address: vault, abi: homerunInitialIncomeVaultAbi, functionName: 'FUND_PROJECT_ID', ...at }),
    client.readContract({ address: vault, abi: homerunInitialIncomeVaultAbi, functionName: 'SNAPSHOT_BLOCK_NUMBER', ...at }),
    client.readContract({ address: vault, abi: homerunInitialIncomeVaultAbi, functionName: 'SNAPSHOT_BLOCK_HASH', ...at }),
    client.readContract({ address: vault, abi: homerunInitialIncomeVaultAbi, functionName: 'TOTAL_FUND_SUPPLY', ...at }),
    client.readContract({ address: vault, abi: homerunInitialIncomeVaultAbi, functionName: 'SOURCE_SET_HASH', ...at }),
    client.readContract({ address: vault, abi: homerunInitialIncomeVaultAbi, functionName: 'LAUNCH_SALT', ...at }),
    client.readContract({ address: vault, abi: homerunInitialIncomeVaultAbi, functionName: 'MERKLE_ROOT', ...at }),
    client.readContract({ address: vault, abi: homerunInitialIncomeVaultAbi, functionName: 'LEAF_COUNT', ...at }),
    client.readContract({ address: vault, abi: homerunInitialIncomeVaultAbi, functionName: 'MANIFEST_HASH', ...at }),
    client.readContract({ address: vault, abi: homerunInitialIncomeVaultAbi, functionName: 'DISTRIBUTION_ID', ...at }),
    client.readContract({ address: vault, abi: homerunInitialIncomeVaultAbi, functionName: 'INITIAL_INCOME_SUPPLY', ...at }),
    client.readContract({ address: vault, abi: homerunInitialIncomeVaultAbi, functionName: 'LOCAL_INITIAL_INCOME_SUPPLY', ...at }),
    client.readContract({ address: vault, abi: homerunInitialIncomeVaultAbi, functionName: 'manifestUri', ...at }),
    client.readContract({ address: vault, abi: homerunInitialIncomeVaultAbi, functionName: 'totalClaimed', ...at }),
  ])
  if (!vaultCode || vaultCode === '0x') throw new Error('The initial INCOME vault has no deployed code.')
  if (!isAddressEqual(factory, deployer) || !isAddressEqual(incomeToken, project.tokenAddress) || incomeProjectId !== input.incomeProjectId || fundProjectId !== input.fundProjectId) throw new Error('The initial INCOME vault does not match its verified factory, token, or project identities.')
  if (snapshotBlockNumber <= 0n || snapshotBlockNumber >= blockNumber || snapshotBlockHash === zeroHash || sourceSetHash === zeroHash || totalFundSupply <= 0n || launchSalt === zeroHash || (merkleRoot === zeroHash) !== (leafCount === 0n) || leafCount < 0n || leafCount > 1n << 160n || (leafCount === 0n && localInitialIncomeSupply !== 0n) || manifestHash === zeroHash || !manifestUri.trim()) throw new Error('The initial INCOME vault has invalid immutable snapshot commitments.')
  const expectedDistributionId = buildFundGlobalDistributionId({ chainId, helper: deployer, fundProjectId, sourceSetHash, totalFundSupply, launchSalt })
  if (distributionId.toLowerCase() !== expectedDistributionId.toLowerCase()) throw new Error('The initial INCOME distribution ID does not bind this chain, launcher, global FUND source set, supply, and launch salt.')
  if (initialIncomeSupply !== INITIAL_INCOME_SUPPLY || localInitialIncomeSupply < 0n || localInitialIncomeSupply > initialIncomeSupply || totalClaimed < 0n || totalClaimed > localInitialIncomeSupply) throw new Error('The initial INCOME supply, local allocation cap, or claimed total is inconsistent with the global 500,000-token allocation.')
  const remainingUnclaimed = localInitialIncomeSupply - totalClaimed
  const vaultBalance = await client.readContract({ address: incomeToken, abi: erc20Abi, functionName: 'balanceOf', args: [vault], ...at })
  // Current revnet supply may be below the original allocation after holders burn
  // tokens; only the vault's remaining obligations must still be fully backed.
  if (vaultBalance < remainingUnclaimed) throw new Error('The initial INCOME vault is not fully funded for its unclaimed allocations.')
  // The launch manifest was reconciled against its historical snapshot before
  // deployment. Perpetual claims prove the immutable root, so they must not
  // depend on an RPC still serving that old snapshot header or historical state.
  await assertCanonicalBlock(client, blockNumber, blockHash)
  return { chainId, incomeProjectId, fundProjectId, account: input.account ? getAddress(input.account) : null, blockNumber, blockHash, blockTimestamp, deployer, vault, incomeToken, snapshotBlockNumber, snapshotBlockHash, sourceSetHash, totalFundSupply, launchSalt, merkleRoot, leafCount, manifestHash, distributionId, manifestUri, initialIncomeSupply, localInitialIncomeSupply, totalClaimed, vaultBalance, remainingUnclaimed }
}
