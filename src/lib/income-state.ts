/** Block-consistent reads for canonical V6 revnets and unstaked FUND rewards. */
import {
  NATIVE_TOKEN, USDC_ADDRESSES, jbContractAddress, jbControllerAbi, jbDirectoryAbi, jbMultiTerminalAbi,
  jbProjectsAbi, jbSplitsAbi, jbTerminalStoreAbi, jbTokensAbi, revOwnerAbi, type JBChainId,
} from '@bananapus/nana-sdk-core'
import { RESERVED_TOKEN_SPLIT_GROUP_ID, v6Address, type JBRuleset, type JBRulesetMetadata } from '@bananapus/nana-sdk-core/v6'
import { erc20Abi, getAddress, isAddressEqual, keccak256, zeroAddress, type Address, type ContractFunctionReturnType, type Hex, type PublicClient } from 'viem'
import { fundVotesAbi, incomeDistributorAbi, incomeRepayCeiling, registeredIncomeDistributor, revLoansAbi } from './income-contracts'

export type IncomeAccountingContext = {
  token: Address; decimals: number; currency: number; terminal: Address; primaryTerminal: Address
  isPrimary: boolean; balance: bigint; surplus: bigint; symbol: string
}
export type IncomeRewardsState = {
  distributor: Address; fundProjectId: bigint; fundToken: Address
  /** False for distributors that deliberately disable borrowing against uncollected vesting rewards. */
  supportsVestingLoans: boolean
  fundCreditBalance: bigint; fundErc20Balance: bigint
  delegate: Address | null; votes: bigint; collectable: bigint; claimed: bigint
  round: bigint; roundStart: bigint; nextRoundStart: bigint; snapshotBlock: bigint
  roundDuration: bigint; vestingRounds: bigint; claimDuration: bigint
}
type Snapshot = { chainId: JBChainId; projectId: bigint; blockNumber: bigint; blockHash: Hex; blockTimestamp: bigint }
export type IncomeProjectState = Snapshot & {
  owner: Address; operator: Address | null; account: Address | null; controller: Address
  ruleset: JBRuleset; metadata: JBRulesetMetadata; projectUri: string
  tokenAddress: Address | null; tokenSymbol: string; tokenDecimals: number
  totalSupply: bigint; totalCreditSupply: bigint; pendingReservedTokens: bigint; totalSupplyWithReservedTokens: bigint
  creditBalance: bigint; erc20Balance: bigint; totalBalance: bigint
  terminals: readonly Address[]; accountingContexts: IncomeAccountingContext[]
  cashOutDelay: bigint; cashOutsAvailable: boolean; isOperator: boolean
  rewards: IncomeRewardsState | null; rewardIssue: string | null; issues: readonly string[]
}
export type IncomeLoan = ContractFunctionReturnType<typeof revLoansAbi, 'view', 'loanOf'>
export type IncomeLoanState = Snapshot & {
  loanId: bigint; owner: Address; loan: IncomeLoan; sourceContext: IncomeAccountingContext
  accruedFee: bigint; repayCeiling: bigint
}
export type IncomeAutoIssuanceState = Snapshot & {
  stageId: bigint; beneficiary: Address; amount: bigint; owner: Address; controller: Address
}

function positiveId(value: bigint, name: string) {
  if (value <= 0n || value >= 1n << 256n) throw new Error(`A positive ${name} is required.`)
}

async function beginSnapshot(client: PublicClient, chainId: number, projectId: bigint): Promise<Snapshot> {
  positiveId(projectId, 'project ID')
  if (!Number.isSafeInteger(chainId) || chainId <= 0) throw new Error('A supported chain is required.')
  if (client.chain && client.chain.id !== chainId) throw new Error('The RPC client is connected to a different chain.')
  if (await client.getChainId() !== chainId) throw new Error('The RPC endpoint returned a different chain.')
  // Resolve registry entries before any project-specific reads.
  v6Address('REVOwner', chainId as JBChainId)
  const block = await client.getBlock({ blockTag: 'latest' })
  if (block.number === null || !block.hash) throw new Error('The RPC did not return a mined block.')
  return { chainId: chainId as JBChainId, projectId, blockNumber: block.number, blockHash: block.hash, blockTimestamp: block.timestamp }
}

async function finishSnapshot(client: PublicClient, snapshot: Snapshot) {
  const block = await client.getBlock({ blockNumber: snapshot.blockNumber })
  if (block.hash !== snapshot.blockHash) throw new Error('The chain changed during the INCOME read. Refresh and try again.')
}

async function readIdentity(client: PublicClient, snapshot: Snapshot) {
  const { chainId, projectId, blockNumber } = snapshot
  const owner = v6Address('REVOwner', chainId)
  const controller = v6Address('JBController', chainId)
  const [projectOwner, activeController, ownerController] = await Promise.all([
    client.readContract({ address: v6Address('JBProjects', chainId), abi: jbProjectsAbi, functionName: 'ownerOf', args: [projectId], blockNumber }),
    client.readContract({ address: v6Address('JBDirectory', chainId), abi: jbDirectoryAbi, functionName: 'controllerOf', args: [projectId], blockNumber }),
    client.readContract({ address: owner, abi: revOwnerAbi, functionName: 'CONTROLLER', blockNumber }),
  ])
  if (!isAddressEqual(projectOwner, owner)) throw new Error('This project is not owned by the registered V6 REVOwner.')
  if (!isAddressEqual(activeController, controller) || !isAddressEqual(ownerController, controller)) throw new Error('The revnet controller does not match the verified V6 controller.')
  return { owner, controller }
}

async function readAccountingContexts(client: PublicClient, snapshot: Snapshot): Promise<{ terminals: readonly Address[]; accountingContexts: IncomeAccountingContext[] }> {
  const { chainId, projectId, blockNumber } = snapshot
  const terminal = v6Address('JBMultiTerminal', chainId)
  const directory = v6Address('JBDirectory', chainId)
  const terminals = await client.readContract({ address: directory, abi: jbDirectoryAbi, functionName: 'terminalsOf', args: [projectId], blockNumber })
  const registry = (jbContractAddress['6'] as Record<string, Partial<Record<JBChainId, Address>>>).JBRouterTerminalRegistry?.[chainId]
  // REVDeployer registers the treasury terminal plus an optional router registry
  // with no accounting contexts. The router never becomes a treasury/loan source.
  const uniqueTerminals = new Set(terminals.map(entry => entry.toLowerCase()))
  if (terminals.length < 1 || terminals.length > 2 || uniqueTerminals.size !== terminals.length ||
    !terminals.some(entry => isAddressEqual(entry, terminal)) ||
    terminals.some(entry => !isAddressEqual(entry, terminal) && (!registry || isAddressEqual(registry, zeroAddress) || !isAddressEqual(entry, registry)))) {
    throw new Error('This INCOME project has unsupported, duplicate, or missing payment terminals.')
  }
  const contexts = await client.readContract({ address: terminal, abi: jbMultiTerminalAbi, functionName: 'accountingContextsOf', args: [projectId], blockNumber })
  if (!contexts.length || contexts.length > 32 || new Set(contexts.map(context => context.token.toLowerCase())).size !== contexts.length) throw new Error('The INCOME accounting contexts are missing, duplicated, or exceed the supported limit.')
  const accountingContexts = await Promise.all(contexts.map(async context => {
    const [primaryTerminal, balance, surplus] = await Promise.all([
      client.readContract({ address: directory, abi: jbDirectoryAbi, functionName: 'primaryTerminalOf', args: [projectId, context.token], blockNumber }),
      client.readContract({ address: v6Address('JBTerminalStore', chainId), abi: jbTerminalStoreAbi, functionName: 'balanceOf', args: [terminal, projectId, context.token], blockNumber }),
      client.readContract({ address: terminal, abi: jbMultiTerminalAbi, functionName: 'currentSurplusOf', args: [projectId, [context.token], BigInt(context.decimals), BigInt(context.currency)], blockNumber }),
    ])
    const symbol = isAddressEqual(context.token, NATIVE_TOKEN) ? 'ETH'
      : isAddressEqual(context.token, USDC_ADDRESSES[chainId]) ? 'USDC'
        : await client.readContract({ address: context.token, abi: erc20Abi, functionName: 'symbol', blockNumber }).catch(() => 'Token')
    return { ...context, terminal, primaryTerminal, isPrimary: isAddressEqual(primaryTerminal, terminal), balance, surplus, symbol }
  }))
  return { terminals, accountingContexts }
}

async function readRewards(client: PublicClient, snapshot: Snapshot, fundProjectId: bigint, incomeToken: Address, rulesetId: bigint, account?: Address): Promise<IncomeRewardsState> {
  positiveId(fundProjectId, 'FUND project ID')
  const { chainId, projectId, blockNumber } = snapshot
  const distributor = registeredIncomeDistributor(chainId)
  if (!distributor) throw new Error('A verified FUND reward distributor is not registered on this chain yet.')
  const at = { blockNumber }
  const fundToken = await client.readContract({ address: v6Address('JBTokens', chainId), abi: jbTokensAbi, functionName: 'tokenOf', args: [fundProjectId], ...at })
  if (isAddressEqual(fundToken, zeroAddress)) throw new Error('The linked FUND project has no ERC-20 to activate for rewards.')
  const [implementation, tokenCode] = await Promise.all([
    client.readContract({ address: v6Address('JBTokens', chainId), abi: jbTokensAbi, functionName: 'TOKEN', ...at }),
    client.getCode({ address: fundToken, ...at }),
  ])
  // JBTokens.deployERC20For uses the exact ERC-1167 runtime from OZ Clones.
  // A custom token exposing the same view methods need not give delegate() the
  // vanilla, noncustodial semantics promised by the reward activation screen.
  const expectedCode = `0x363d3d373d3d3d363d73${implementation.slice(2)}5af43d82803e903d91602b57fd5bf3` as Hex
  if (isAddressEqual(implementation, zeroAddress) || !tokenCode || keccak256(tokenCode) !== keccak256(expectedCode)) throw new Error('FUND reward activation requires the canonical Juicebox ERC-20 clone. This project uses a custom or unsupported token.')
  const splits = await client.readContract({ address: v6Address('JBSplits', chainId), abi: jbSplitsAbi, functionName: 'splitsOf', args: [projectId, rulesetId, RESERVED_TOKEN_SPLIT_GROUP_ID], ...at })
  if (!splits.some(split => split.percent > 0 && isAddressEqual(split.hook, distributor) && isAddressEqual(split.beneficiary, fundToken))) throw new Error('The INCOME reserved splits do not route rewards to this FUND token through the verified distributor.')
  const [directory, controller, loans, owner, clockMode, clock, round, roundDuration, vestingRounds, claimDuration] = await Promise.all([
    client.readContract({ address: distributor, abi: incomeDistributorAbi, functionName: 'DIRECTORY', ...at }),
    client.readContract({ address: distributor, abi: incomeDistributorAbi, functionName: 'CONTROLLER', ...at }),
    client.readContract({ address: distributor, abi: incomeDistributorAbi, functionName: 'REV_LOANS', ...at }),
    client.readContract({ address: distributor, abi: incomeDistributorAbi, functionName: 'REV_OWNER', ...at }),
    client.readContract({ address: fundToken, abi: fundVotesAbi, functionName: 'CLOCK_MODE', ...at }),
    client.readContract({ address: fundToken, abi: fundVotesAbi, functionName: 'clock', ...at }),
    client.readContract({ address: distributor, abi: incomeDistributorAbi, functionName: 'currentRound', ...at }),
    client.readContract({ address: distributor, abi: incomeDistributorAbi, functionName: 'ROUND_DURATION', ...at }),
    client.readContract({ address: distributor, abi: incomeDistributorAbi, functionName: 'VESTING_ROUNDS', ...at }),
    client.readContract({ address: distributor, abi: incomeDistributorAbi, functionName: 'CLAIM_DURATION', ...at }),
  ])
  const supportsVestingLoans = isAddressEqual(loans, v6Address('REVLoans', chainId)) && isAddressEqual(owner, v6Address('REVOwner', chainId))
  const vestingLoansDisabled = isAddressEqual(loans, zeroAddress) && isAddressEqual(owner, zeroAddress)
  // Production distributors may deliberately leave both optional loan dependencies
  // disabled. A mixed or foreign pair must never be presented as a supported setup.
  if (!isAddressEqual(directory, v6Address('JBDirectory', chainId)) || !isAddressEqual(controller, v6Address('JBController', chainId)) || (!supportsVestingLoans && !vestingLoansDisabled)) throw new Error('The distributor dependencies do not match the verified V6 contracts.')
  // IVotes uses the token's clock, which is an L1-origin height on Arbitrum.
  // Keep the RPC read pinned to its separate L2 blockNumber.
  const checkpointClock = BigInt(clock)
  if (new URLSearchParams(clockMode).get('mode') !== 'blocknumber' || roundDuration <= 0n) throw new Error('The FUND voting clock or reward round duration is unsupported.')
  // Prove the active-vote extension exists; ERC20Votes alone is insufficient.
  if (checkpointClock <= 0n) throw new Error('FUND vote history is not available yet.')
  await client.readContract({ address: fundToken, abi: fundVotesAbi, functionName: 'getPastTotalActiveVotes', args: [checkpointClock - 1n], ...at })
  const [roundStart, nextRoundStart, snapshotBlock, delegate, votes, collectable, claimed, fundCreditBalance, fundErc20Balance, fundTotalBalance, fundTotalSupply] = await Promise.all([
    client.readContract({ address: distributor, abi: incomeDistributorAbi, functionName: 'roundStartTimestamp', args: [round], ...at }),
    client.readContract({ address: distributor, abi: incomeDistributorAbi, functionName: 'roundStartTimestamp', args: [round + 1n], ...at }),
    client.readContract({ address: distributor, abi: incomeDistributorAbi, functionName: 'roundSnapshotBlock', args: [round], ...at }),
    account ? client.readContract({ address: fundToken, abi: fundVotesAbi, functionName: 'delegates', args: [account], ...at }) : null,
    account ? client.readContract({ address: fundToken, abi: fundVotesAbi, functionName: 'getVotes', args: [account], ...at }) : 0n,
    account ? client.readContract({ address: distributor, abi: incomeDistributorAbi, functionName: 'collectableFor', args: [fundToken, BigInt(account), incomeToken], ...at }) : 0n,
    account ? client.readContract({ address: distributor, abi: incomeDistributorAbi, functionName: 'claimedFor', args: [fundToken, BigInt(account), incomeToken], ...at }) : 0n,
    account ? client.readContract({ address: v6Address('JBTokens', chainId), abi: jbTokensAbi, functionName: 'creditBalanceOf', args: [account, fundProjectId], ...at }) : 0n,
    account ? client.readContract({ address: fundToken, abi: erc20Abi, functionName: 'balanceOf', args: [account], ...at }) : 0n,
    account ? client.readContract({ address: v6Address('JBTokens', chainId), abi: jbTokensAbi, functionName: 'totalBalanceOf', args: [account, fundProjectId], ...at }) : 0n,
    client.readContract({ address: v6Address('JBTokens', chainId), abi: jbTokensAbi, functionName: 'totalSupplyOf', args: [fundProjectId], ...at }),
  ])
  if (fundCreditBalance + fundErc20Balance !== fundTotalBalance || fundTotalBalance > fundTotalSupply) throw new Error('The RPC returned inconsistent FUND reward balances.')
  if (nextRoundStart - roundStart !== roundDuration || snapshotBlock >= checkpointClock) throw new Error('The reward distributor returned inconsistent round timing.')
  return { distributor, fundProjectId, fundToken, supportsVestingLoans, fundCreditBalance, fundErc20Balance, delegate, votes, collectable, claimed, round, roundStart, nextRoundStart, snapshotBlock, roundDuration, vestingRounds, claimDuration: BigInt(claimDuration) }
}

export async function readIncomeProjectState(client: PublicClient, { chainId, projectId, account, fundProjectId }: { chainId: number; projectId: bigint; account?: Address; fundProjectId?: bigint }): Promise<IncomeProjectState> {
  const snapshot = await beginSnapshot(client, chainId, projectId)
  const { owner, controller } = await readIdentity(client, snapshot)
  const at = { blockNumber: snapshot.blockNumber }
  const tokens = v6Address('JBTokens', snapshot.chainId)
  const [current, token, totalSupply, totalCreditSupply, pendingReservedTokens, totalSupplyWithReservedTokens, cashOutDelay, isOperator, accounting] = await Promise.all([
    client.readContract({ address: controller, abi: jbControllerAbi, functionName: 'currentRulesetOf', args: [projectId], ...at }),
    client.readContract({ address: tokens, abi: jbTokensAbi, functionName: 'tokenOf', args: [projectId], ...at }),
    client.readContract({ address: tokens, abi: jbTokensAbi, functionName: 'totalSupplyOf', args: [projectId], ...at }),
    client.readContract({ address: tokens, abi: jbTokensAbi, functionName: 'totalCreditSupplyOf', args: [projectId], ...at }),
    client.readContract({ address: controller, abi: jbControllerAbi, functionName: 'pendingReservedTokenBalanceOf', args: [projectId], ...at }),
    client.readContract({ address: controller, abi: jbControllerAbi, functionName: 'totalTokenSupplyWithReservedTokensOf', args: [projectId], ...at }),
    client.readContract({ address: owner, abi: revOwnerAbi, functionName: 'cashOutDelayOf', args: [projectId], ...at }),
    account ? client.readContract({ address: owner, abi: revOwnerAbi, functionName: 'isOperatorOf', args: [projectId, account], ...at }) : false,
    readAccountingContexts(client, snapshot),
  ])
  const [ruleset, metadata] = current
  if (!ruleset.id || !isAddressEqual(metadata.dataHook, owner) || !metadata.useDataHookForPay || !metadata.useDataHookForCashOut) throw new Error('The current INCOME ruleset is not governed by the registered REVOwner hook.')
  const tokenAddress = isAddressEqual(token, zeroAddress) ? null : token
  const [tokenSymbol, tokenDecimals, projectUri, creditBalance, erc20Balance, totalBalance] = await Promise.all([
    tokenAddress ? client.readContract({ address: tokenAddress, abi: erc20Abi, functionName: 'symbol', ...at }).catch(() => 'INCOME') : 'INCOME',
    tokenAddress ? client.readContract({ address: tokenAddress, abi: erc20Abi, functionName: 'decimals', ...at }) : 18,
    client.readContract({ address: controller, abi: jbControllerAbi, functionName: 'uriOf', args: [projectId], ...at }).catch(() => ''),
    account ? client.readContract({ address: tokens, abi: jbTokensAbi, functionName: 'creditBalanceOf', args: [account, projectId], ...at }) : 0n,
    account && tokenAddress ? client.readContract({ address: tokenAddress, abi: erc20Abi, functionName: 'balanceOf', args: [account], ...at }) : 0n,
    account ? client.readContract({ address: tokens, abi: jbTokensAbi, functionName: 'totalBalanceOf', args: [account, projectId], ...at }) : 0n,
  ])
  if (creditBalance + erc20Balance !== totalBalance || totalSupply + pendingReservedTokens !== totalSupplyWithReservedTokens || totalCreditSupply > totalSupply) throw new Error('The RPC returned inconsistent INCOME token accounting.')
  if (tokenDecimals !== 18) throw new Error('The INCOME token does not use the supported 18-decimal accounting.')
  let rewards: IncomeRewardsState | null = null
  let rewardIssue: string | null = null
  if (fundProjectId !== undefined) {
    if (!tokenAddress) rewardIssue = 'The INCOME ERC-20 must exist before FUND rewards can be read.'
    else {
      try { rewards = await readRewards(client, snapshot, fundProjectId, tokenAddress, BigInt(ruleset.id), account) }
      catch (error) { rewardIssue = error instanceof Error ? error.message : 'FUND rewards could not be verified.' }
    }
  }
  await finishSnapshot(client, snapshot)
  return { ...snapshot, ...accounting, owner, controller, operator: isOperator && account ? getAddress(account) : null, account: account ?? null, ruleset, metadata, projectUri, tokenAddress, tokenSymbol, tokenDecimals, totalSupply, totalCreditSupply, pendingReservedTokens, totalSupplyWithReservedTokens, creditBalance, erc20Balance, totalBalance, cashOutDelay, cashOutsAvailable: cashOutDelay <= snapshot.blockTimestamp, isOperator, rewards, rewardIssue, issues: [] }
}

/** Full repayment only. Quote principal plus the live fee, never derive its ceiling from a simulation. */
export async function readIncomeLoan(client: PublicClient, { chainId, projectId, loanId, account }: { chainId: number; projectId: bigint; loanId: bigint; account: Address }): Promise<IncomeLoanState> {
  positiveId(loanId, 'loan ID')
  const snapshot = await beginSnapshot(client, chainId, projectId)
  await readIdentity(client, snapshot)
  const loans = v6Address('REVLoans', snapshot.chainId)
  const at = { blockNumber: snapshot.blockNumber }
  const [owner, loan, loanProjectId, liquidationDuration, accounting] = await Promise.all([
    client.readContract({ address: loans, abi: revLoansAbi, functionName: 'ownerOf', args: [loanId], ...at }),
    client.readContract({ address: loans, abi: revLoansAbi, functionName: 'loanOf', args: [loanId], ...at }),
    client.readContract({ address: loans, abi: revLoansAbi, functionName: 'revnetIdOfLoanWith', args: [loanId], ...at }),
    client.readContract({ address: loans, abi: revLoansAbi, functionName: 'LOAN_LIQUIDATION_DURATION', ...at }),
    readAccountingContexts(client, snapshot),
  ])
  if (!isAddressEqual(owner, account)) throw new Error('Only the connected loan NFT owner can repay this loan here.')
  if (loanProjectId !== projectId) throw new Error('This loan belongs to a different INCOME project.')
  if (loan.amount <= 0n || loan.collateral <= 0n || BigInt(loan.createdAt) > snapshot.blockTimestamp || snapshot.blockTimestamp - BigInt(loan.createdAt) > liquidationDuration) throw new Error('This loan is repaid, liquidated, or no longer repayable.')
  const sourceContext = accounting.accountingContexts.find(context => isAddressEqual(context.token, loan.sourceToken) && context.isPrimary)
  if (!sourceContext) throw new Error('The loan source token has no verified primary accounting context.')
  const accruedFee = await client.readContract({ address: loans, abi: revLoansAbi, functionName: 'determineSourceFeeAmount', args: [loan, loan.amount], ...at })
  await finishSnapshot(client, snapshot)
  return { ...snapshot, loanId, owner, loan, sourceContext, accruedFee, repayCeiling: incomeRepayCeiling(loan.amount, accruedFee) }
}

export async function readIncomeAutoIssuance(client: PublicClient, { chainId, projectId, stageId, beneficiary }: { chainId: number; projectId: bigint; stageId: bigint; beneficiary: Address }): Promise<IncomeAutoIssuanceState> {
  positiveId(stageId, 'stage ID')
  if (isAddressEqual(beneficiary, zeroAddress)) throw new Error('An auto-issuance beneficiary is required.')
  const snapshot = await beginSnapshot(client, chainId, projectId)
  const { owner, controller } = await readIdentity(client, snapshot)
  const at = { blockNumber: snapshot.blockNumber }
  const [[ruleset], amount] = await Promise.all([
    client.readContract({ address: controller, abi: jbControllerAbi, functionName: 'getRulesetOf', args: [projectId, stageId], ...at }),
    client.readContract({ address: owner, abi: revOwnerAbi, functionName: 'amountToAutoIssue', args: [projectId, stageId, beneficiary], ...at }),
  ])
  if (BigInt(ruleset.id) !== stageId) throw new Error('This INCOME stage does not exist.')
  if (BigInt(ruleset.start) > snapshot.blockTimestamp) throw new Error('This auto issuance is still locked until the stage starts.')
  if (amount <= 0n) throw new Error('This allocation has already been issued or was never configured.')
  await finishSnapshot(client, snapshot)
  return { ...snapshot, owner, controller, stageId, beneficiary, amount }
}
