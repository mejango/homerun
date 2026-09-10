import { beforeEach, describe, expect, it, vi } from 'vitest'
import { USDC_ADDRESSES } from '@bananapus/nana-sdk-core'
import { v6Address } from '@bananapus/nana-sdk-core/v6'
import { zeroAddress, zeroHash, type Address, type Hex, type PublicClient } from 'viem'
import { INITIAL_INCOME_SUPPLY, registeredIncomeDeployer, registeredIncomeDistributor } from '../src/lib/income-contracts'
import { buildFundGlobalDistributionId } from '../src/lib/fund-global-manifest'
import { buildFundDistributionId } from '../src/lib/fund-snapshot-merkle'
import { readIncomeProjectState, type IncomeProjectState } from '../src/lib/income-state'
import { readInitialIncomeAllocation } from '../src/lib/income-allocation-state'

const registry = vi.hoisted(() => ({ sticky: '0x0000000000000000000000000000000000000100' as Address }))
vi.mock('@bananapus/nana-sdk-core', async importOriginal => {
  const actual = await importOriginal<typeof import('@bananapus/nana-sdk-core')>()
  return { ...actual, jbContractAddress: { ...actual.jbContractAddress, '6': { ...actual.jbContractAddress['6'], JBStickyDeployer: { 1: registry.sticky } } } }
})
vi.mock('../src/lib/income-contracts', async importOriginal => ({
  ...await importOriginal<typeof import('../src/lib/income-contracts')>(),
  registeredIncomeDeployer: vi.fn(), registeredIncomeDistributor: vi.fn(),
}))
vi.mock('../src/lib/income-state', async importOriginal => ({
  ...await importOriginal<typeof import('../src/lib/income-state')>(), readIncomeProjectState: vi.fn(),
}))

const HOLDER = '0x1111111111111111111111111111111111111111' as const
const HELPER = '0x2222222222222222222222222222222222222222' as const
const VAULT = '0x3333333333333333333333333333333333333333' as const
const TOKEN = '0x4444444444444444444444444444444444444444' as const
const DISTRIBUTOR = '0x5555555555555555555555555555555555555555' as const
const CHAIN = 1
const INCOME_ID = 7n
const FUND_ID = 9n
const BLOCK = 12345n
const SNAPSHOT_BLOCK = 12000n
const BLOCK_HASH = `0x${'ab'.repeat(32)}` as Hex
const SNAPSHOT_HASH = `0x${'bc'.repeat(32)}` as Hex
const SALT = `0x${'cd'.repeat(32)}` as Hex
const ROOT = `0x${'de'.repeat(32)}` as Hex
const MANIFEST_HASH = `0x${'ef'.repeat(32)}` as Hex
const SOURCE_SET_HASH = `0x${'fa'.repeat(32)}` as Hex
const TOTAL_FUND = 6_000n * 10n ** 18n
const CLAIMED = 100n * 10n ** 18n
const LOCAL_SUPPLY = 200_000n * 10n ** 18n
const DOMAIN = { chainId: CHAIN, helper: HELPER, fundProjectId: FUND_ID, sourceSetHash: SOURCE_SET_HASH, totalFundSupply: TOTAL_FUND, launchSalt: SALT }
const DISTRIBUTION = buildFundGlobalDistributionId(DOMAIN)
const INPUT = { chainId: CHAIN, incomeProjectId: INCOME_ID, fundProjectId: FUND_ID, account: HOLDER }
type ReadRequest = { address: Address; functionName: string; args?: readonly unknown[]; blockNumber?: bigint }

function fixture(options: { values?: Record<string, unknown>; fail?: string; missingCode?: Address; reorg?: boolean; unavailableOldHeader?: boolean } = {}) {
  const state = { chainId: CHAIN, projectId: INCOME_ID, tokenAddress: TOKEN, blockNumber: BLOCK, blockHash: BLOCK_HASH, blockTimestamp: 1_800_000_000n, totalSupply: INITIAL_INCOME_SUPPLY - CLAIMED } as IncomeProjectState
  vi.mocked(readIncomeProjectState).mockResolvedValue(state)
  const helperValues = {
    CONTROLLER: v6Address('JBController', CHAIN), DIRECTORY: v6Address('JBDirectory', CHAIN), PROJECTS: v6Address('JBProjects', CHAIN),
    TOKENS: v6Address('JBTokens', CHAIN), REV_DEPLOYER: v6Address('REVDeployer', CHAIN), REV_OWNER: v6Address('REVOwner', CHAIN),
    SUCKER_REGISTRY: v6Address('JBSuckerRegistry', CHAIN), TOKEN_DISTRIBUTOR: DISTRIBUTOR, STICKY_DEPLOYER: registry.sticky,
    OMNICHAIN_DEPLOYER: v6Address('JBOmnichainDeployer', CHAIN), USDC: USDC_ADDRESSES[CHAIN], incomeProjectIdOf: INCOME_ID, initialAllocationVaultOf: VAULT,
  }
  const vaultValues = {
    FACTORY: HELPER, INCOME_TOKEN: TOKEN, INCOME_PROJECT_ID: INCOME_ID, FUND_PROJECT_ID: FUND_ID,
    SNAPSHOT_BLOCK_NUMBER: SNAPSHOT_BLOCK, SNAPSHOT_BLOCK_HASH: SNAPSHOT_HASH, SOURCE_SET_HASH, TOTAL_FUND_SUPPLY: TOTAL_FUND,
    LAUNCH_SALT: SALT, MERKLE_ROOT: ROOT, LEAF_COUNT: 1000n, MANIFEST_HASH, DISTRIBUTION_ID: DISTRIBUTION,
    INITIAL_INCOME_SUPPLY, LOCAL_INITIAL_INCOME_SUPPLY: LOCAL_SUPPLY, manifestUri: 'ipfs://bafypublicsnapshot/manifest.json', totalClaimed: CLAIMED,
  }
  const readContract = vi.fn(async (request: ReadRequest): Promise<unknown> => {
    expect(request.blockNumber).toBe(BLOCK)
    const name = request.functionName
    if (options.fail === name) throw new Error(`RPC unavailable: ${name}`)
    if (Object.hasOwn(options.values ?? {}, name)) return options.values![name]
    if (name === 'balanceOf') { expect(request.address).toBe(TOKEN); expect(request.args).toEqual([VAULT]); return LOCAL_SUPPLY - CLAIMED }
    if (Object.hasOwn(helperValues, name)) {
      expect(request.address).toBe(HELPER)
      if (name === 'incomeProjectIdOf' || name === 'initialAllocationVaultOf') expect(request.args).toEqual([FUND_ID])
      return helperValues[name as keyof typeof helperValues]
    }
    if (Object.hasOwn(vaultValues, name)) { expect(request.address).toBe(VAULT); return vaultValues[name as keyof typeof vaultValues] }
    throw new Error(`Unexpected read ${name}`)
  })
  const getCode = vi.fn(async (request: { address: Address; blockNumber: bigint }) => {
    expect(request.blockNumber).toBe(BLOCK)
    expect([HELPER, VAULT]).toContain(request.address)
    if (options.fail === 'getCode') throw new Error('RPC unavailable: getCode')
    return options.missingCode === request.address ? '0x' : '0x1234'
  })
  const getBlock = vi.fn(async ({ blockNumber }: { blockNumber: bigint }) => {
    if (options.fail === 'getBlock') throw new Error('RPC unavailable: getBlock')
    if (options.unavailableOldHeader && blockNumber === SNAPSHOT_BLOCK) throw new Error('Historical snapshot header is unavailable.')
    expect([BLOCK, SNAPSHOT_BLOCK]).toContain(blockNumber)
    const hash = blockNumber === SNAPSHOT_BLOCK ? SNAPSHOT_HASH : options.reorg ? zeroHash : BLOCK_HASH
    return { number: blockNumber, hash }
  })
  const client = { readContract, getCode, getBlock } as unknown as PublicClient
  return { client, state, readContract, getCode, getBlock }
}

beforeEach(() => {
  vi.mocked(registeredIncomeDeployer).mockReturnValue(HELPER)
  vi.mocked(registeredIncomeDistributor).mockReturnValue(DISTRIBUTOR)
})

describe('initial INCOME allocation verification', () => {
  it('returns only a fully funded immutable vault bound through the canonical registered launcher', async () => {
    const f = fixture()
    const result = await readInitialIncomeAllocation(f.client, INPUT)
    expect(readIncomeProjectState).toHaveBeenCalledWith(f.client, { chainId: CHAIN, projectId: INCOME_ID, account: HOLDER })
    expect(result).toEqual({ chainId: CHAIN, incomeProjectId: INCOME_ID, fundProjectId: FUND_ID, account: HOLDER,
      blockNumber: BLOCK, blockHash: BLOCK_HASH, blockTimestamp: 1_800_000_000n, deployer: HELPER, vault: VAULT, incomeToken: TOKEN,
      snapshotBlockNumber: SNAPSHOT_BLOCK, snapshotBlockHash: SNAPSHOT_HASH, sourceSetHash: SOURCE_SET_HASH, totalFundSupply: TOTAL_FUND, launchSalt: SALT,
      merkleRoot: ROOT, leafCount: 1000n, manifestHash: MANIFEST_HASH, distributionId: DISTRIBUTION,
      manifestUri: 'ipfs://bafypublicsnapshot/manifest.json', initialIncomeSupply: INITIAL_INCOME_SUPPLY, localInitialIncomeSupply: LOCAL_SUPPLY,
      totalClaimed: CLAIMED, vaultBalance: LOCAL_SUPPLY - CLAIMED, remainingUnclaimed: LOCAL_SUPPLY - CLAIMED,
    })
    expect(f.getBlock.mock.calls).toEqual([[{ blockNumber: BLOCK }]])
    expect(f.readContract.mock.calls.some(([request]) => request.functionName === 'isClaimed')).toBe(false)
  })

  it('does not require current FUND holdings, self-delegation or an unburned 500k current INCOME supply', async () => {
    const f = fixture()
    vi.mocked(readIncomeProjectState).mockResolvedValue({ ...f.state, totalSupply: 1n, totalBalance: 0n, rewards: null })
    const result = await readInitialIncomeAllocation(f.client, { ...INPUT, account: undefined })
    expect(result?.account).toBeNull()
    expect(result?.remainingUnclaimed).toBe(LOCAL_SUPPLY - CLAIMED)
    expect(f.readContract.mock.calls.some(([request]) => ['getVotes', 'delegates', 'totalSupplyOf'].includes(request.functionName))).toBe(false)
  })

  it('allows donated token surplus and an entirely claimed allocation', async () => {
    await expect(readInitialIncomeAllocation(fixture({ values: { balanceOf: INITIAL_INCOME_SUPPLY + 1n } }).client, INPUT)).resolves.toMatchObject({ vaultBalance: INITIAL_INCOME_SUPPLY + 1n })
    await expect(readInitialIncomeAllocation(fixture({ values: { totalClaimed: LOCAL_SUPPLY, balanceOf: 0n } }).client, INPUT)).resolves.toMatchObject({ remainingUnclaimed: 0n, vaultBalance: 0n })
  })

  it('backs only this chain’s local cap while retaining the global 500k allocation', async () => {
    await expect(readInitialIncomeAllocation(fixture().client, INPUT)).resolves.toMatchObject({ initialIncomeSupply: INITIAL_INCOME_SUPPLY, localInitialIncomeSupply: LOCAL_SUPPLY, remainingUnclaimed: LOCAL_SUPPLY - CLAIMED })
    await expect(readInitialIncomeAllocation(fixture({ values: { LOCAL_INITIAL_INCOME_SUPPLY: INITIAL_INCOME_SUPPLY, balanceOf: INITIAL_INCOME_SUPPLY - CLAIMED } }).client, INPUT)).resolves.toMatchObject({ localInitialIncomeSupply: INITIAL_INCOME_SUPPLY, remainingUnclaimed: INITIAL_INCOME_SUPPLY - CLAIMED })
  })

  it('allows an empty local allocation with no root, leaves, cap, claims or required balance', async () => {
    const f = fixture({ values: { MERKLE_ROOT: zeroHash, LEAF_COUNT: 0n, LOCAL_INITIAL_INCOME_SUPPLY: 0n, totalClaimed: 0n, balanceOf: 0n } })
    await expect(readInitialIncomeAllocation(f.client, INPUT)).resolves.toMatchObject({ initialIncomeSupply: INITIAL_INCOME_SUPPLY, localInitialIncomeSupply: 0n, merkleRoot: zeroHash, leafCount: 0n, totalClaimed: 0n, remainingUnclaimed: 0n, vaultBalance: 0n })
  })

  it('allows committed local holders whose allocations round down to zero', async () => {
    const f = fixture({ values: { LOCAL_INITIAL_INCOME_SUPPLY: 0n, totalClaimed: 0n, balanceOf: 0n } })
    await expect(readInitialIncomeAllocation(f.client, INPUT)).resolves.toMatchObject({ merkleRoot: ROOT, leafCount: 1000n, localInitialIncomeSupply: 0n, remainingUnclaimed: 0n })
  })

  it('returns no allocation for an unregistered launcher without probing caller-provided targets', async () => {
    const f = fixture()
    vi.mocked(registeredIncomeDeployer).mockReturnValue(null)
    expect(await readInitialIncomeAllocation(f.client, INPUT)).toBeNull()
    expect(f.getCode).not.toHaveBeenCalled()
    expect(f.readContract).not.toHaveBeenCalled()
  })

  it('requires registered dependencies even when the launcher address exists', async () => {
    vi.mocked(registeredIncomeDistributor).mockReturnValue(null)
    await expect(readInitialIncomeAllocation(fixture().client, INPUT)).rejects.toThrow(/dependencies.*registered/)
  })

  it('returns no allocation only when both verified launcher bindings are empty', async () => {
    const f = fixture({ values: { incomeProjectIdOf: 0n, initialAllocationVaultOf: zeroAddress } })
    expect(await readInitialIncomeAllocation(f.client, INPUT)).toBeNull()
    expect(f.getCode.mock.calls).toEqual([[{ address: HELPER, blockNumber: BLOCK }]])
    expect(f.getBlock).toHaveBeenCalledWith({ blockNumber: BLOCK })
  })

  it.each([{ incomeProjectIdOf: 8n }, { incomeProjectIdOf: 0n }, { initialAllocationVaultOf: zeroAddress }, { incomeProjectIdOf: (1n << 256n) - 1n }])('rejects a conflicting/incomplete launcher binding %o', async values => {
    await expect(readInitialIncomeAllocation(fixture({ values }).client, INPUT)).rejects.toThrow(/matching INCOME/)
  })

  it.each(['CONTROLLER', 'DIRECTORY', 'PROJECTS', 'TOKENS', 'REV_DEPLOYER', 'REV_OWNER', 'SUCKER_REGISTRY', 'TOKEN_DISTRIBUTOR', 'STICKY_DEPLOYER', 'OMNICHAIN_DEPLOYER', 'USDC'])('rejects an incorrect canonical launcher %s dependency', async key => {
    await expect(readInitialIncomeAllocation(fixture({ values: { [key]: HOLDER } }).client, INPUT)).rejects.toThrow(/registered V6/)
  })

  it.each([{ FACTORY: HOLDER }, { INCOME_TOKEN: HOLDER }, { INCOME_PROJECT_ID: FUND_ID }, { FUND_PROJECT_ID: INCOME_ID }])('rejects inconsistent vault identities %o', async values => {
    await expect(readInitialIncomeAllocation(fixture({ values }).client, INPUT)).rejects.toThrow(/factory, token, or project identities/)
  })

  it.each([
    { SNAPSHOT_BLOCK_NUMBER: 0n }, { SNAPSHOT_BLOCK_NUMBER: BLOCK }, { SNAPSHOT_BLOCK_HASH: zeroHash }, { SOURCE_SET_HASH: zeroHash }, { TOTAL_FUND_SUPPLY: 0n },
    { LAUNCH_SALT: zeroHash }, { MERKLE_ROOT: zeroHash }, { LEAF_COUNT: 0n }, { LEAF_COUNT: (1n << 160n) + 1n },
    { MERKLE_ROOT: zeroHash, LEAF_COUNT: 0n, LOCAL_INITIAL_INCOME_SUPPLY: 1n },
    { MANIFEST_HASH: zeroHash }, { manifestUri: ' ' },
  ])('rejects missing or impossible immutable commitments %o', async values => {
    await expect(readInitialIncomeAllocation(fixture({ values }).client, INPUT)).rejects.toThrow(/immutable snapshot/)
  })

  it.each([
    { DISTRIBUTION_ID: ROOT },
    { DISTRIBUTION_ID: buildFundGlobalDistributionId({ ...DOMAIN, chainId: 10 }) },
    { DISTRIBUTION_ID: buildFundGlobalDistributionId({ ...DOMAIN, helper: HOLDER }) },
    { DISTRIBUTION_ID: buildFundGlobalDistributionId({ ...DOMAIN, fundProjectId: INCOME_ID }) },
    { DISTRIBUTION_ID: buildFundGlobalDistributionId({ ...DOMAIN, sourceSetHash: ROOT }) },
    { DISTRIBUTION_ID: buildFundGlobalDistributionId({ ...DOMAIN, totalFundSupply: TOTAL_FUND + 1n }) },
    { DISTRIBUTION_ID: buildFundDistributionId({ destinationChainId: CHAIN, helper: HELPER, fundProjectId: FUND_ID, snapshotBlockNumber: SNAPSHOT_BLOCK, snapshotBlockHash: SNAPSHOT_HASH, totalFundSupply: TOTAL_FUND, launchSalt: SALT }) },
    { LAUNCH_SALT: ROOT }, { SOURCE_SET_HASH: ROOT }, { TOTAL_FUND_SUPPLY: TOTAL_FUND + 1n },
  ])('rejects commitments not bound to this deployment domain %o', async values => {
    await expect(readInitialIncomeAllocation(fixture({ values }).client, INPUT)).rejects.toThrow(/distribution ID/)
  })

  it.each([
    { INITIAL_INCOME_SUPPLY: INITIAL_INCOME_SUPPLY - 1n }, { LOCAL_INITIAL_INCOME_SUPPLY: INITIAL_INCOME_SUPPLY + 1n },
    { totalClaimed: LOCAL_SUPPLY + 1n }, { balanceOf: LOCAL_SUPPLY - CLAIMED - 1n },
    { LOCAL_INITIAL_INCOME_SUPPLY: 0n, totalClaimed: 1n },
    { MERKLE_ROOT: zeroHash, LEAF_COUNT: 0n, LOCAL_INITIAL_INCOME_SUPPLY: 0n, totalClaimed: 1n },
  ])('rejects an underfunded or inconsistent allocation %o', async values => {
    await expect(readInitialIncomeAllocation(fixture({ values }).client, INPUT)).rejects.toThrow(/inconsistent|not fully funded/)
  })

  it.each([HELPER, VAULT])('requires deployed code at the registered helper and bound vault %s', async missingCode => {
    await expect(readInitialIncomeAllocation(fixture({ missingCode }).client, INPUT)).rejects.toThrow(/no deployed code/)
  })

  it.each(['incomeProjectIdOf', 'initialAllocationVaultOf', 'OMNICHAIN_DEPLOYER', 'FACTORY', 'INCOME_TOKEN', 'SOURCE_SET_HASH', 'LOCAL_INITIAL_INCOME_SUPPLY', 'MERKLE_ROOT', 'MANIFEST_HASH', 'totalClaimed', 'balanceOf', 'getCode', 'getBlock'])('propagates required %s read failure instead of inventing an allocation', async fail => {
    await expect(readInitialIncomeAllocation(fixture({ fail }).client, INPUT)).rejects.toThrow(/RPC unavailable/)
  })

  it('propagates canonical project/chain identity errors before vault reads', async () => {
    const f = fixture()
    vi.mocked(readIncomeProjectState).mockRejectedValueOnce(new Error('RPC endpoint returned a different chain.'))
    await expect(readInitialIncomeAllocation(f.client, INPUT)).rejects.toThrow(/different chain/)
    expect(f.readContract).not.toHaveBeenCalled()
  })

  it('rejects a reorg at the observed head', async () => {
    await expect(readInitialIncomeAllocation(fixture({ reorg: true }).client, INPUT)).rejects.toThrow(/chain changed/)
  })

  it('keeps perpetual claims readable without old snapshot-header RPC availability', async () => {
    const f = fixture({ unavailableOldHeader: true })
    await expect(readInitialIncomeAllocation(f.client, INPUT)).resolves.toMatchObject({ snapshotBlockNumber: SNAPSHOT_BLOCK, snapshotBlockHash: SNAPSHOT_HASH, distributionId: DISTRIBUTION })
    expect(f.getBlock.mock.calls).toEqual([[{ blockNumber: BLOCK }]])
  })

  it('rejects malformed project identities before touching RPC', async () => {
    const f = fixture()
    await expect(readInitialIncomeAllocation(f.client, { ...INPUT, fundProjectId: INCOME_ID })).rejects.toThrow(/distinct/)
    await expect(readInitialIncomeAllocation(f.client, { ...INPUT, incomeProjectId: 0n })).rejects.toThrow(/positive/)
    expect(f.readContract).not.toHaveBeenCalled()
  })
})
