/** Exact V6 transaction adapters. Wallet review and onchain verification live above these builders. */
import { jbContractAddress, revLoansAbi, USDC_ADDRESSES, USD_CURRENCY_ID, type JBChainId } from '@bananapus/nana-sdk-core'
import {
  buildAccountingContext, buildDeployRevnetTx, buildRevnetStageConfig, buildAutoIssueTx,
  buildBorrowTx, buildRepayLoanTx, RULESET_WEIGHT_INHERIT, v6Address,
  MIN_PREPAID_FEE_PERCENT, MAX_PREPAID_FEE_PERCENT, type REVAutoIssuance, type REVStageConfig,
} from '@bananapus/nana-sdk-core/v6'
import { getAddress, isAddress, parseAbi, zeroAddress, zeroHash, type Address, type Hex } from 'viem'
import type { FundTransaction } from './fund-contracts'

export const INITIAL_INCOME_SUPPLY = 500_000n * 10n ** 18n
export const INCOME_INITIAL_ISSUANCE = 10n * 10n ** 18n
/** A quarter is one fourth of a 365-day year. Eight cuts, then a permanent fixed rate. */
export const INCOME_QUARTER_SECONDS = 7_884_000
export const INCOME_CUT_PERCENT = 50_000_000
export const INCOME_SLIPPAGE_BPS = 100n
/** Every new split remains editable by the Owner through the stock controller. */
export const INCOME_SPLIT_LOCK = 0
export const INCOME_OPERATOR_SPLIT_LOCK = INCOME_SPLIT_LOCK
/** Older deployments may retain permanent locks; existing transactions remain recoverable. */
export const LEGACY_INCOME_SPLIT_LOCK = 2 ** 48 - 1

/** Source: HomerunIncomeDeployer.sol. Enabled only after a verified deployment enters the SDK registry. */
export const homerunIncomeDeployerAbi = parseAbi([
  'struct InitialAllocation { uint32 chainId; uint256 fundProjectId; uint256 snapshotBlockNumber; bytes32 snapshotBlockHash; bytes32 merkleRoot; uint256 leafCount; uint104 incomeAmount; }',
  'struct InitialSnapshot { bytes32 sourceSetHash; uint256 totalFundSupply; bytes32 manifestHash; string manifestUri; InitialAllocation[] allocations; }',
  'struct SuckerMapping { address localToken; uint32 minGas; bytes32 remoteToken; }',
  'struct SuckerDeployerConfig { address deployer; bytes32 peer; SuckerMapping[] mappings; }',
  'struct SuckerConfiguration { SuckerDeployerConfig[] deployerConfigurations; bytes32 salt; }',
  'function LAUNCH_VERSION() view returns (uint256)',
  'function CONTROLLER() view returns (address)',
  'function DIRECTORY() view returns (address)',
  'function PROJECTS() view returns (address)',
  'function TOKENS() view returns (address)',
  'function REV_DEPLOYER() view returns (address)',
  'function REV_OWNER() view returns (address)',
  'function SUCKER_REGISTRY() view returns (address)',
  'function TOKEN_DISTRIBUTOR() view returns (address)',
  'function USDC() view returns (address)',
  'function STICKY_DEPLOYER() view returns (address)',
  'function OMNICHAIN_DEPLOYER() view returns (address)',
  'function PROTOCOL_CONFIG_HASH() view returns (bytes32)',
  'function usdcOf(uint32 chainId) view returns (address)',
  'function incomeProjectIdOf(uint256 fundProjectId) view returns (uint256)',
  'function initialAllocationVaultOf(uint256 fundProjectId) view returns (address)',
  'function distributionIdFor(uint256 fundProjectId, InitialSnapshot snapshot, bytes32 salt) view returns (bytes32)',
  'function configurationSaltFor(InitialSnapshot snapshot, bytes32 launchSalt) pure returns (bytes32)',
  'function deployIncome(uint256 fundProjectId, InitialSnapshot snapshot, (string name, string ticker, string uri, bytes32 salt) description, uint16 operatorBps, uint16 fundHoldersBps, uint256 stickyProjectId, uint48 startsAtOrAfter, SuckerConfiguration suckerConfiguration, address operator) payable returns (uint256 incomeProjectId)',
  'event IncomeDeployed(uint256 indexed fundProjectId, uint256 indexed incomeProjectId, address indexed operator, address fundToken, address initialAllocationVault, address rewardToken, bytes32 merkleRoot)',
])

/** Decode old saved submissions without changing the calldata whose execution must be verified. */
export const legacyHomerunIncomeDeployerAbi = homerunIncomeDeployerAbi.map(entry => {
  if (entry.type !== 'function' || entry.name !== 'deployIncome') return entry
  const [fund, snapshot, description, operatorBps, fundHolderBps, sticky, start, suckers] = entry.inputs
  return { ...entry, inputs: [fund, snapshot, description, operatorBps, fundHolderBps, sticky, start, suckers] as const }
})
export const homerunIncomeRecoveryAbi = [...homerunIncomeDeployerAbi, ...legacyHomerunIncomeDeployerAbi.filter(entry => entry.type === 'function' && entry.name === 'deployIncome')] as const

/** Source: nana-core-v6 JBERC20 / IJBActiveVotes. No token custody or approval is involved. */
export const fundVotesAbi = parseAbi([
  'function delegate(address delegatee)',
  'function delegates(address account) view returns (address)',
  'function getVotes(address account) view returns (uint256)',
  'function getPastVotes(address account, uint256 timepoint) view returns (uint256)',
  'function getPastTotalActiveVotes(uint256 timepoint) view returns (uint256)',
  'function clock() view returns (uint48)',
  'function CLOCK_MODE() view returns (string)',
])

/** Source: nana-distributor-v6 IJBDistributor, JBDistributor and JBTokenDistributor. */
export const incomeDistributorAbi = parseAbi([
  'function DIRECTORY() view returns (address)',
  'function CONTROLLER() view returns (address)',
  'function REV_LOANS() view returns (address)',
  'function REV_OWNER() view returns (address)',
  'function ROUND_DURATION() view returns (uint256)',
  'function STARTING_TIMESTAMP() view returns (uint256)',
  'function VESTING_ROUNDS() view returns (uint256)',
  'function CLAIM_DURATION() view returns (uint48)',
  'function currentRound() view returns (uint256)',
  'function roundSnapshotBlock(uint256 round) view returns (uint256)',
  'function roundStartTimestamp(uint256 round) view returns (uint256)',
  'function rewardRoundOf(address hook, uint256 groupId, address token, uint256 round) view returns ((uint208 amount, uint48 snapshotBlock, uint208 claimedAmount, uint48 claimDeadline, uint208 totalStake))',
  'function collectableFor(address hook, uint256 tokenId, address token) view returns (uint256)',
  'function claimedFor(address hook, uint256 tokenId, address token) view returns (uint256)',
  'function balanceOf(address hook, address token) view returns (uint256)',
  'function beginVesting(address hook, uint256[] tokenIds, address[] tokens)',
  'function collectVestedRewards(address hook, uint256[] tokenIds, address[] tokens, address beneficiary)',
  'function fund(address hook, address token, uint256 amount) payable',
  'function recycleExpiredRewards(address hook, address token, uint256[] rounds) returns (uint256)',
])

function checkedAddress(value: Address, label: string): Address {
  if (!isAddress(value) || value.toLowerCase() === zeroAddress) throw new Error(`A valid ${label} address is required.`)
  return getAddress(value)
}

/** Add-ons must be published in the deployment registry before they become transaction targets. */
export function registeredIncomeDistributor(chainId: JBChainId): Address | null {
  const contracts = jbContractAddress['6'] as Record<string, Partial<Record<JBChainId, Address>>>
  const result = contracts.JBTokenDistributor?.[chainId]
  return result && isAddress(result) && result.toLowerCase() !== zeroAddress ? getAddress(result) : null
}

export function registeredIncomeDeployer(chainId: JBChainId): Address | null {
  const contracts = jbContractAddress['6'] as Record<string, Partial<Record<JBChainId, Address>>>
  const result = contracts.HomerunIncomeDeployer?.[chainId]
  return result && isAddress(result) && result.toLowerCase() !== zeroAddress ? getAddress(result) : null
}

export function protectedIncomeMinimum(quote: bigint, slippageBps = INCOME_SLIPPAGE_BPS): bigint {
  if (quote <= 0n) throw new Error('A positive live quote is required.')
  if (slippageBps < 0n || slippageBps >= 10_000n) throw new Error('Invalid slippage tolerance.')
  const minimum = quote * (10_000n - slippageBps) / 10_000n
  return minimum > 0n ? minimum : 1n
}

/** Integer allocation with deterministic dust. Completeness must be independently checked against chain supply. */
export function allocateInitialIncome(holders: readonly { holder: Address; balance: bigint }[], totalFundSupply: bigint): { beneficiary: Address; count: bigint }[] {
  if (totalFundSupply <= 0n || !holders.length) throw new Error('A complete, nonempty FUND ownership snapshot is required.')
  const seen = new Set<string>()
  const normalized = holders.map(entry => {
    if (!isAddress(entry.holder)) throw new Error('A valid FUND holder address is required.')
    const beneficiary = getAddress(entry.holder)
    if (seen.has(beneficiary.toLowerCase())) throw new Error('Duplicate FUND holder in the snapshot.')
    seen.add(beneficiary.toLowerCase())
    if (entry.balance <= 0n) throw new Error('Snapshot balances must be positive.')
    return { beneficiary, balance: entry.balance }
  }).sort((a, b) => a.beneficiary.toLowerCase().localeCompare(b.beneficiary.toLowerCase()))
  if (normalized.reduce((sum, entry) => sum + entry.balance, 0n) !== totalFundSupply) throw new Error('The holder snapshot does not cover the entire FUND supply, including credits and the owner allocation.')
  const allocations = normalized.map(entry => ({ beneficiary: entry.beneficiary, count: INITIAL_INCOME_SUPPLY * entry.balance / totalFundSupply }))
  const remainder = INITIAL_INCOME_SUPPLY - allocations.reduce((sum, entry) => sum + entry.count, 0n)
  // Match the public manifest: at most holders.length - 1 atoms go to the lowest address, including zero.
  allocations[0].count += remainder
  return allocations
}

export function incomeReservedSplits(operator: Address, fundToken: Address, distributor: Address, operatorBps = 7_000, fundHolderBps = 1_000): REVStageConfig['splits'] {
  checkedAddress(operator, 'operator'); checkedAddress(fundToken, 'FUND token'); checkedAddress(distributor, 'reward distributor')
  if (![operatorBps, fundHolderBps].every(value => Number.isInteger(value) && value >= 0) || operatorBps + fundHolderBps > 10_000 || fundHolderBps === 0) throw new Error('INCOME allocation must include FUND holders and total no more than 100%.')
  const reserved = operatorBps + fundHolderBps
  const operatorPercent = Math.floor(operatorBps * 1_000_000_000 / reserved)
  const base = { preferAddToBalance: false, lockedUntil: INCOME_SPLIT_LOCK, projectId: 0n }
  return [
    ...(operatorPercent ? [{ ...base, lockedUntil: INCOME_OPERATOR_SPLIT_LOCK, percent: operatorPercent, beneficiary: getAddress(operator), hook: zeroAddress }] : []),
    { ...base, percent: 1_000_000_000 - operatorPercent, beneficiary: getAddress(fundToken), hook: getAddress(distributor) },
  ]
}

export function incomeStageConfigurations(input: {
  startTimestamp: number; operator: Address; fundToken: Address; distributor: Address;
  initialAllocations: readonly REVAutoIssuance[]; operatorBps?: number; fundHolderBps?: number;
}): REVStageConfig[] {
  if (!Number.isSafeInteger(input.startTimestamp) || input.startTimestamp <= 0 || input.startTimestamp + INCOME_QUARTER_SECONDS * 8 >= 2 ** 48) throw new Error('Use a valid absolute INCOME start timestamp.')
  const operatorBps = input.operatorBps ?? 7_000
  const fundHolderBps = input.fundHolderBps ?? 1_000
  const shared = {
    splitPercent: operatorBps + fundHolderBps,
    splits: incomeReservedSplits(input.operator, input.fundToken, input.distributor, operatorBps, fundHolderBps),
    cashOutTaxRate: 0,
    // Keep the canonical revnet extension/retry path available in every stage.
    allowSuckerDeployment: true,
  }
  return [
    buildRevnetStageConfig({ ...shared, startsAtOrAfter: input.startTimestamp, initialIssuance: INCOME_INITIAL_ISSUANCE, issuanceCutFrequency: INCOME_QUARTER_SECONDS, issuanceCutPercent: INCOME_CUT_PERCENT, autoIssuances: input.initialAllocations }),
    buildRevnetStageConfig({ ...shared, startsAtOrAfter: input.startTimestamp + INCOME_QUARTER_SECONDS * 8, initialIssuance: RULESET_WEIGHT_INHERIT, issuanceCutFrequency: 0, issuanceCutPercent: 0 }),
  ]
}

/**
 * Reviewable canonical call, NOT a safe standalone launch: deployment records
 * auto-issuances without minting them. The launch coordinator must atomically
 * materialize all initial allocations before public payments/loans can run.
 */
export function buildIncomeDeployPlan(input: {
  chainId: JBChainId; name: string; projectUri: string; salt: Hex; creationFee: bigint;
  startTimestamp: number; owner: Address; operator: Address; fundToken: Address;
  initialAllocations: readonly REVAutoIssuance[]; operatorBps?: number; fundHolderBps?: number;
}) {
  const distributor = registeredIncomeDistributor(input.chainId)
  if (!distributor) throw new Error('The verified deployment registry does not yet include a FUND reward distributor on this chain.')
  if (!input.name.trim() || input.name.length > 160) throw new Error('An INCOME project name is required.')
  if (!/^ipfs:\/\/[^\s/?#]+(?:\/[^\s]*)?$/.test(input.projectUri)) throw new Error('Publish the INCOME metadata to IPFS first.')
  if (!/^0x[\da-fA-F]{64}$/.test(input.salt) || input.salt === zeroHash) throw new Error('A nonzero bytes32 deployment salt is required.')
  if (input.creationFee < 0n) throw new Error('Read the current project creation fee.')
  if (input.initialAllocations.reduce((sum, entry) => sum + entry.count, 0n) !== INITIAL_INCOME_SUPPLY) throw new Error('Initial allocations must total exactly 500,000 INCOME.')
  const seen = new Set<string>()
  for (const entry of input.initialAllocations) {
    checkedAddress(entry.beneficiary, 'initial INCOME beneficiary')
    if (Number(entry.chainId) !== input.chainId) throw new Error('This launch plan supports a single chain. Every initial allocation must be on that chain.')
    const key = `${entry.chainId}:${entry.beneficiary.toLowerCase()}`
    if (seen.has(key) || entry.count <= 0n || entry.count >= 1n << 104n) throw new Error('Initial allocations contain duplicate beneficiaries or invalid amounts.')
    seen.add(key)
  }
  const baseCurrency = USD_CURRENCY_ID(6)
  const request = buildDeployRevnetTx({
    chainId: input.chainId,
    config: {
      description: { name: input.name.trim(), ticker: 'INCOME', uri: input.projectUri, salt: input.salt },
      baseCurrency, operator: checkedAddress(input.owner, 'owner'), scopeCashOutsToLocalBalances: false,
      stageConfigurations: incomeStageConfigurations({ ...input, distributor }),
    },
    accountingContexts: [buildAccountingContext(USDC_ADDRESSES[input.chainId], 6)],
    suckerConfig: { salt: input.salt, deployerConfigurations: [] },
    creationFee: input.creationFee,
    // Match Revnet Money's explicit empty store. The 4-arg default uses the wrong USD price precision.
    tiered721Config: {
      baseline721HookConfiguration: {
        name: `${input.name.trim()} Store`, symbol: 'INCOMESTORE', baseUri: 'ipfs://', tokenUriResolver: zeroAddress,
        contractUri: input.projectUri,
        tiersConfig: { tiers: [], currency: baseCurrency, decimals: 6 },
        flags: { noNewTiersWithReserves: true, noNewTiersWithVotes: true, noNewTiersWithOwnerMinting: true, preventOverspending: false },
      },
      salt: input.salt,
      preventOperatorAdjustingTiers: true, preventOperatorUpdatingMetadata: true,
      preventOperatorMinting: true, preventOperatorIncreasingDiscountPercent: true,
    },
    allowedPosts: [],
  })
  return {
    ...request,
    abi: request.abi.filter(item => item.type !== 'function' || item.name !== 'deployFor' || item.inputs.length === 6),
  } satisfies FundTransaction
}

export function buildIncomeRewardActivation(chainId: JBChainId, fundToken: Address, holder: Address): FundTransaction {
  return { chainId, address: checkedAddress(fundToken, 'FUND token'), abi: fundVotesAbi, functionName: 'delegate', args: [checkedAddress(holder, 'holder')] }
}

export function buildIncomeRewardClaim(input: { chainId: JBChainId; fundToken: Address; incomeToken: Address; holder: Address; collect: boolean }): FundTransaction {
  const distributor = registeredIncomeDistributor(input.chainId)
  if (!distributor) throw new Error('No verified reward distributor is registered on this chain.')
  const holder = checkedAddress(input.holder, 'holder')
  const args = [checkedAddress(input.fundToken, 'FUND token'), [BigInt(holder)], [checkedAddress(input.incomeToken, 'INCOME token')]] as const
  return { chainId: input.chainId, address: distributor, abi: incomeDistributorAbi, functionName: input.collect ? 'collectVestedRewards' : 'beginVesting', args: input.collect ? [...args, holder] : args }
}

export function buildProtectedIncomeBorrow(input: {
  chainId: JBChainId; revnetId: bigint; token: Address; quotedBorrowAmount: bigint; collateralCount: bigint;
  beneficiary: Address; holder: Address; prepaidFeePercent?: bigint;
}): FundTransaction {
  const prepaidFeePercent = input.prepaidFeePercent ?? MIN_PREPAID_FEE_PERCENT
  if (input.revnetId <= 0n || input.collateralCount <= 0n) throw new Error('A verified revnet and positive INCOME collateral are required.')
  if (prepaidFeePercent < MIN_PREPAID_FEE_PERCENT || prepaidFeePercent > MAX_PREPAID_FEE_PERCENT) throw new Error('The prepaid fee must be between 2.5% and 50%.')
  return buildBorrowTx({ ...input, beneficiary: checkedAddress(input.beneficiary, 'beneficiary'), holder: checkedAddress(input.holder, 'holder'), prepaidFeePercent, minBorrowAmount: protectedIncomeMinimum(input.quotedBorrowAmount) })
}

export function incomeRepayCeiling(principal: bigint, accruedFee: bigint): bigint {
  if (principal <= 0n || accruedFee < 0n) throw new Error('Read a positive outstanding principal and its current fee.')
  return principal + accruedFee + principal / 1_000n
}

export { buildAutoIssueTx, buildRepayLoanTx, revLoansAbi, v6Address }
