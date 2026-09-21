/** Exact V6 transaction adapters. Wallet review and onchain verification live above these builders. */
import { jbContractAddress, revLoansAbi, type JBChainId } from '@bananapus/nana-sdk-core'
import {
  buildAutoIssueTx, buildBorrowTx, buildRepayLoanTx, v6Address,
  MIN_PREPAID_FEE_PERCENT, MAX_PREPAID_FEE_PERCENT,
} from '@bananapus/nana-sdk-core/v6'
import { getAddress, isAddress, parseAbi, zeroAddress, type Address } from 'viem'
import type { FundTransaction } from './fund-contracts'

export const INITIAL_INCOME_SUPPLY = 500_000n * 10n ** 18n
export const INCOME_INITIAL_ISSUANCE = 10n * 10n ** 18n
/** A quarter is one fourth of a 365-day year. Issuance cuts 2% every quarter, indefinitely. */
export const INCOME_QUARTER_SECONDS = 7_884_000
export const INCOME_CUT_PERCENT = 20_000_000
export const INCOME_CASH_OUT_TAX_RATE = 1000
export const INCOME_SLIPPAGE_BPS = 100n

/** Source: HomerunDeployer.sol. Enabled only after a verified deployment enters the SDK registry. */
export const homerunDeployerAbi = parseAbi([
  'struct InitialAllocation { uint32 chainId; uint256 fundProjectId; uint256 snapshotBlockNumber; bytes32 snapshotBlockHash; uint104 incomeAmount; }',
  'struct InitialSnapshot { bytes32 sourceSetHash; uint256 totalFundSupply; bytes32 manifestHash; string manifestUri; InitialAllocation[] allocations; }',
  'struct SuckerMapping { address localToken; uint32 minGas; bytes32 remoteToken; }',
  'struct SuckerDeployerConfig { address deployer; bytes32 peer; SuckerMapping[] mappings; }',
  'struct SuckerConfiguration { SuckerDeployerConfig[] deployerConfigurations; bytes32 salt; }',
  'function LAUNCH_VERSION() view returns (uint256)',
  'function FUND_WEIGHT() view returns (uint112)',
  'function FUND_CASH_OUT_TAX_RATE() view returns (uint16)',
  'function INCOME_INITIAL_ISSUANCE() view returns (uint112)',
  'function INCOME_CUT_PERCENT() view returns (uint32)',
  'function INCOME_CASH_OUT_TAX_RATE() view returns (uint16)',
  'function TERMINAL() view returns (address)',
  'function ROUTER_TERMINAL_REGISTRY() view returns (address)',
  'function ALLOWLIST_HOOK() view returns (address)',
  'function isFund(uint256 projectId) view returns (bool)',
  'function launchFundFor(address owner, string projectUri, string name, string ticker, uint48 mustStartAtOrAfter, bytes32 salt, address[] peerSuckerDeployers) payable returns (uint256 projectId, address token)',
  'event FundLaunched(uint256 indexed projectId, address indexed owner, address caller)',
  'function CONTROLLER() view returns (address)',
  'function DIRECTORY() view returns (address)',
  'function PROJECTS() view returns (address)',
  'function TOKENS() view returns (address)',
  'function REV_DEPLOYER() view returns (address)',
  'function REV_OWNER() view returns (address)',
  'function SUCKER_REGISTRY() view returns (address)',
  'function USDC() view returns (address)',
  'function OMNICHAIN_DEPLOYER() view returns (address)',
  'function PROTOCOL_CONFIG_HASH() view returns (bytes32)',
  'function usdcOf(uint32 chainId) view returns (address)',
  'function incomeProjectIdOf(uint256 fundProjectId) view returns (uint256)',
  'function configurationSaltFor(InitialSnapshot snapshot, bytes32 launchSalt) pure returns (bytes32)',
  'function deployIncome(uint256 fundProjectId, InitialSnapshot snapshot, (string name, string ticker, string uri, bytes32 salt) description, uint16 reservedBps, uint48 startsAtOrAfter, SuckerConfiguration suckerConfiguration) payable returns (uint256 incomeProjectId)',
  'event IncomeDeployed(uint256 indexed fundProjectId, uint256 indexed incomeProjectId, address indexed owner, address fundToken)',
  'function mintInitialAllocation(uint256 fundProjectId)',
  'event InitialAllocationMinted(uint256 indexed fundProjectId, uint256 indexed incomeProjectId, address indexed owner, uint256 incomeAmount, address caller)',
])

/** Source: HomerunAllowlistHook.sol. Gates FUND payment beneficiaries; the FUND owner manages it. */
export const homerunAllowlistHookAbi = parseAbi([
  'function PROJECTS() view returns (address)',
  'function isOpen(uint256 projectId) view returns (bool)',
  'function isAllowed(uint256 projectId, address account) view returns (bool)',
  'function canPay(uint256 projectId, address account) view returns (bool)',
  'function setOpen(uint256 projectId, bool open)',
  'function setAllowed(uint256 projectId, address[] accounts, bool allowed)',
  'event OpenSet(uint256 indexed projectId, bool open, address caller)',
  'event AllowedSet(uint256 indexed projectId, address indexed account, bool allowed, address caller)',
])

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

export function registeredAllowlistHook(chainId: JBChainId): Address | null {
  const contracts = jbContractAddress['6'] as Record<string, Partial<Record<JBChainId, Address>>>
  const result = contracts.HomerunAllowlistHook?.[chainId]
  return result && isAddress(result) && result.toLowerCase() !== zeroAddress ? getAddress(result) : null
}

export function registeredHomerunDeployer(chainId: JBChainId): Address | null {
  const contracts = jbContractAddress['6'] as Record<string, Partial<Record<JBChainId, Address>>>
  const result = contracts.HomerunDeployer?.[chainId]
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
