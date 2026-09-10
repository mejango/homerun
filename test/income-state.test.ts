import { beforeEach, describe, expect, it, vi } from 'vitest'
import { USDC_ADDRESSES } from '@bananapus/nana-sdk-core'
import { RESERVED_TOKEN_SPLIT_GROUP_ID, v6Address } from '@bananapus/nana-sdk-core/v6'
import { zeroAddress, type Address, type Hex, type PublicClient } from 'viem'
import { initialFundRuleset } from '../src/lib/fund-contracts'
import { registeredIncomeDistributor } from '../src/lib/income-contracts'
import { readIncomeAutoIssuance, readIncomeLoan, readIncomeProjectState } from '../src/lib/income-state'

vi.mock('../src/lib/income-contracts', async importOriginal => ({
  ...await importOriginal<typeof import('../src/lib/income-contracts')>(),
  registeredIncomeDistributor: vi.fn(() => null),
}))

const HOLDER = '0x1111111111111111111111111111111111111111' as const
const OTHER = '0x2222222222222222222222222222222222222222' as const
const INCOME = '0x3333333333333333333333333333333333333333' as const
const FUND = '0x4444444444444444444444444444444444444444' as const
const DISTRIBUTOR = '0x5555555555555555555555555555555555555555' as const
const TOKEN_IMPLEMENTATION = '0x6666666666666666666666666666666666666666' as const
const FUND_CLONE_CODE = `0x363d3d373d3d3d363d73${TOKEN_IMPLEMENTATION.slice(2)}5af43d82803e903d91602b57fd5bf3` as Hex
const HASH = `0x${'ab'.repeat(32)}` as Hex
const CHAIN = 1
const PROJECT = 7n
const FUND_PROJECT = 9n
const BLOCK = 12345n
const TIMESTAMP = 1_800_000_100n
const STAGE = 71n
const LOAN_ID = 7_000_000_001n
const terminal = v6Address('JBMultiTerminal', CHAIN)
const owner = v6Address('REVOwner', CHAIN)
const controller = v6Address('JBController', CHAIN)
const sourceToken = USDC_ADDRESSES[CHAIN]

type Request = { address: Address; functionName: string; args?: readonly unknown[]; blockNumber?: bigint }
type FixtureOptions = { chainId?: 1 | 42161; fail?: string; values?: Record<string, unknown>; wrongChain?: boolean; reorg?: boolean; fundCode?: Hex | null }

function rpcFixture(options: FixtureOptions = {}) {
  const CHAIN = options.chainId ?? 1
  const terminal = v6Address('JBMultiTerminal', CHAIN)
  const owner = v6Address('REVOwner', CHAIN)
  const controller = v6Address('JBController', CHAIN)
  const sourceToken = USDC_ADDRESSES[CHAIN]
  const metadata = { ...initialFundRuleset().metadata, dataHook: owner, useDataHookForPay: true, useDataHookForCashOut: true }
  const ruleset = { cycleNumber: 2, id: Number(STAGE), basedOnId: 0, start: 1_800_000_000, duration: 7_884_000, weight: 10n ** 19n, weightCutPercent: 50_000_000, approvalHook: zeroAddress, metadata: 0n }
  const context = { token: sourceToken, decimals: 6, currency: 2 }
  const loan = { amount: 100_000n, collateral: 1_000n, createdAt: 1_700_000_000, prepaidFeePercent: 25, prepaidDuration: 15_768_000, sourceToken }
  const readContract = vi.fn(async (request: Request): Promise<unknown> => {
    expect(request.blockNumber).toBe(BLOCK)
    const { functionName, address, args } = request
    const label = functionName === 'balanceOf' ? address.toLowerCase() === INCOME.toLowerCase() ? 'erc20Balance' : address.toLowerCase() === FUND.toLowerCase() ? 'fundErc20Balance' : 'terminalBalance'
      : functionName === 'ownerOf' && address.toLowerCase() === v6Address('REVLoans', CHAIN).toLowerCase() ? 'loanOwner'
        : functionName === 'tokenOf' && args?.[0] === FUND_PROJECT ? 'fundToken'
          : functionName === 'creditBalanceOf' && args?.[1] === FUND_PROJECT ? 'fundCreditBalance'
            : functionName === 'totalBalanceOf' && args?.[1] === FUND_PROJECT ? 'fundTotalBalance'
              : functionName === 'totalSupplyOf' && args?.[0] === FUND_PROJECT ? 'fundTotalSupply'
          : functionName
    if (options.fail === label) throw new Error(`RPC unavailable: ${label}`)
    if (Object.hasOwn(options.values ?? {}, label)) return options.values![label]
    switch (label) {
      case 'ownerOf': expect(args).toEqual([PROJECT]); return owner
      case 'controllerOf': expect(args).toEqual([PROJECT]); return controller
      case 'CONTROLLER': return controller
      case 'currentRulesetOf': expect(args).toEqual([PROJECT]); return [ruleset, metadata]
      case 'tokenOf': return INCOME
      case 'totalSupplyOf': return 1000n
      case 'totalCreditSupplyOf': return 200n
      case 'pendingReservedTokenBalanceOf': return 100n
      case 'totalTokenSupplyWithReservedTokensOf': return 1100n
      case 'cashOutDelayOf': return 0n
      case 'isOperatorOf': expect(args).toEqual([PROJECT, HOLDER]); return true
      case 'terminalsOf': return [terminal]
      case 'accountingContextsOf': expect(address).toBe(terminal); return [context]
      case 'primaryTerminalOf': expect(args).toEqual([PROJECT, sourceToken]); return terminal
      case 'terminalBalance': expect(args).toEqual([terminal, PROJECT, sourceToken]); return 9_000_000n
      case 'currentSurplusOf': expect(args).toEqual([PROJECT, [sourceToken], 6n, 2n]); return 8_000_000n
      case 'symbol': return 'INCOME'
      case 'decimals': return 18
      case 'uriOf': return 'ipfs://income'
      case 'creditBalanceOf': expect(args).toEqual([HOLDER, PROJECT]); return 10n
      case 'erc20Balance': expect(args).toEqual([HOLDER]); return 30n
      case 'totalBalanceOf': expect(args).toEqual([HOLDER, PROJECT]); return 40n
      case 'fundToken': return FUND
      case 'TOKEN': expect(address).toBe(v6Address('JBTokens', CHAIN)); return TOKEN_IMPLEMENTATION
      case 'fundCreditBalance': expect(args).toEqual([HOLDER, FUND_PROJECT]); return 12n
      case 'fundErc20Balance': expect(args).toEqual([HOLDER]); return 30n
      case 'fundTotalBalance': expect(args).toEqual([HOLDER, FUND_PROJECT]); return 42n
      case 'fundTotalSupply': expect(args).toEqual([FUND_PROJECT]); return 1000n
      case 'splitsOf': expect(args).toEqual([PROJECT, STAGE, RESERVED_TOKEN_SPLIT_GROUP_ID]); return [{ percent: 125_000_000, beneficiary: FUND, hook: DISTRIBUTOR, projectId: 0n, preferAddToBalance: false, lockedUntil: 0 }]
      case 'DIRECTORY': return v6Address('JBDirectory', CHAIN)
      case 'REV_LOANS': return v6Address('REVLoans', CHAIN)
      case 'REV_OWNER': return owner
      case 'CLOCK_MODE': return 'mode=blocknumber&from=default'
      case 'clock': return BLOCK
      case 'currentRound': return 10n
      case 'ROUND_DURATION': return 86400n
      case 'VESTING_ROUNDS': return 4n
      case 'CLAIM_DURATION': return 0n
      case 'getPastTotalActiveVotes': expect(args).toEqual([BigInt((options.values?.clock as bigint | undefined) ?? BLOCK) - 1n]); return 300n
      case 'roundStartTimestamp': return args?.[0] === 10n ? 1_800_000_000n : 1_800_000_000n + ((options.values?.ROUND_DURATION as bigint | undefined) ?? 86_400n)
      case 'roundSnapshotBlock': expect(args).toEqual([10n]); return BLOCK - 2n
      case 'delegates': expect(args).toEqual([HOLDER]); return HOLDER
      case 'getVotes': expect(args).toEqual([HOLDER]); return 30n
      case 'collectableFor': expect(args).toEqual([FUND, BigInt(HOLDER), INCOME]); return 8n
      case 'claimedFor': expect(args).toEqual([FUND, BigInt(HOLDER), INCOME]); return 20n
      case 'loanOwner': expect(args).toEqual([LOAN_ID]); return HOLDER
      case 'loanOf': expect(args).toEqual([LOAN_ID]); return loan
      case 'revnetIdOfLoanWith': expect(args).toEqual([LOAN_ID]); return PROJECT
      case 'LOAN_LIQUIDATION_DURATION': return 315_360_000n
      case 'determineSourceFeeAmount': expect(args).toEqual([loan, loan.amount]); return 100n
      case 'getRulesetOf': expect(args).toEqual([PROJECT, STAGE]); return [ruleset, metadata]
      case 'amountToAutoIssue': expect(args).toEqual([PROJECT, STAGE, HOLDER]); return 500n
      default: throw new Error(`Unexpected RPC read: ${address}.${functionName}`)
    }
  })
  const getBlock = vi.fn(async ({ blockNumber }: { blockTag?: string; blockNumber?: bigint }) => ({ number: BLOCK, hash: options.reorg && blockNumber !== undefined ? `0x${'cd'.repeat(32)}` : HASH, timestamp: TIMESTAMP }))
  const getCode = vi.fn(async (request: { address: Address; blockNumber: bigint }) => {
    expect(request).toEqual({ address: FUND, blockNumber: BLOCK })
    if (options.fail === 'fundCode') throw new Error('RPC unavailable: fundCode')
    return options.fundCode === null ? undefined : options.fundCode ?? FUND_CLONE_CODE
  })
  const client = { chain: { id: CHAIN }, getChainId: vi.fn(async () => options.wrongChain ? 10 : CHAIN), getBlock, readContract, getCode } as unknown as PublicClient
  return { chainId: CHAIN, client, readContract, getBlock, getCode, metadata, ruleset, loan, context }
}

beforeEach(() => { vi.mocked(registeredIncomeDistributor).mockReturnValue(null) })
const readProject = (fixture: ReturnType<typeof rpcFixture>, account: Address | undefined = HOLDER, fundProjectId?: bigint) => readIncomeProjectState(fixture.client, { chainId: fixture.chainId, projectId: PROJECT, account, fundProjectId })
const readLoan = (fixture: ReturnType<typeof rpcFixture>) => readIncomeLoan(fixture.client, { chainId: CHAIN, projectId: PROJECT, loanId: LOAN_ID, account: HOLDER })
const readAuto = (fixture: ReturnType<typeof rpcFixture>) => readIncomeAutoIssuance(fixture.client, { chainId: CHAIN, projectId: PROJECT, stageId: STAGE, beneficiary: HOLDER })

describe('INCOME project reads', () => {
  it('reads one canonical block and keeps REVOwner ownership distinct from operator authority', async () => {
    const fixture = rpcFixture()
    const state = await readProject(fixture)
    expect(state).toMatchObject({ chainId: CHAIN, projectId: PROJECT, owner, operator: HOLDER, isOperator: true, controller, account: HOLDER, blockNumber: BLOCK, blockHash: HASH, blockTimestamp: TIMESTAMP, totalSupply: 1000n, totalCreditSupply: 200n, pendingReservedTokens: 100n, totalSupplyWithReservedTokens: 1100n, creditBalance: 10n, erc20Balance: 30n, totalBalance: 40n, tokenSymbol: 'INCOME', tokenDecimals: 18, tokenAddress: INCOME, cashOutsAvailable: true, rewards: null, rewardIssue: null, issues: [] })
    expect(state.accountingContexts).toEqual([{ ...fixture.context, terminal, primaryTerminal: terminal, isPrimary: true, balance: 9_000_000n, surplus: 8_000_000n, symbol: 'USDC' }])
    expect(fixture.getBlock.mock.calls).toEqual([[{ blockTag: 'latest' }], [{ blockNumber: BLOCK }]])
  })

  it('does not invent holder balances or operator identities while disconnected', async () => {
    const fixture = rpcFixture()
    const state = await readIncomeProjectState(fixture.client, { chainId: CHAIN, projectId: PROJECT })
    expect(state).toMatchObject({ account: null, operator: null, isOperator: false, creditBalance: 0n, erc20Balance: 0n, totalBalance: 0n })
    expect(fixture.readContract.mock.calls.some(([request]) => ['creditBalanceOf', 'totalBalanceOf', 'isOperatorOf'].includes(request.functionName))).toBe(false)
  })

  it('reads active delayed cash outs as unavailable without erasing the delay', async () => {
    const state = await readProject(rpcFixture({ values: { cashOutDelayOf: TIMESTAMP + 300n, isOperatorOf: false } }))
    expect(state).toMatchObject({ cashOutDelay: TIMESTAMP + 300n, cashOutsAvailable: false, operator: null, isOperator: false })
  })

  it('accepts REVDeployer’s treasury plus router registry while reading treasury contexts only from the multi terminal', async () => {
    const registry = v6Address('JBRouterTerminalRegistry', CHAIN)
    const fixture = rpcFixture({ values: { terminalsOf: [terminal, registry] } })
    const state = await readProject(fixture)
    expect(state.terminals).toEqual([terminal, registry])
    expect(state.accountingContexts).toHaveLength(1)
    expect(state.accountingContexts[0]).toMatchObject({ terminal, primaryTerminal: terminal, isPrimary: true })
    expect(fixture.readContract.mock.calls.some(([request]) => request.address.toLowerCase() === registry.toLowerCase())).toBe(false)
    // Directory order does not change which terminal owns the treasury.
    await expect(readProject(rpcFixture({ values: { terminalsOf: [registry, terminal] } }))).resolves.toMatchObject({ tokenAddress: INCOME })
  })

  it.each([
    { terminals: [terminal, terminal] },
    { terminals: [terminal, OTHER] },
    { terminals: [v6Address('JBRouterTerminalRegistry', CHAIN)] },
    { terminals: [terminal, v6Address('JBRouterTerminalRegistry', CHAIN), OTHER] },
  ])('rejects duplicate, foreign, or incomplete terminal configuration %o', async ({ terminals }) => {
    await expect(readProject(rpcFixture({ values: { terminalsOf: terminals } }))).rejects.toThrow('This INCOME project has unsupported, duplicate, or missing payment terminals.')
  })

  it.each(['ownerOf', 'controllerOf', 'CONTROLLER', 'currentRulesetOf', 'totalSupplyOf', 'totalCreditSupplyOf', 'pendingReservedTokenBalanceOf', 'totalTokenSupplyWithReservedTokensOf', 'cashOutDelayOf', 'isOperatorOf', 'accountingContextsOf', 'primaryTerminalOf', 'terminalBalance', 'currentSurplusOf', 'decimals', 'creditBalanceOf', 'erc20Balance', 'totalBalanceOf'])('rejects failed required %s reads', async fail => {
    await expect(readProject(rpcFixture({ fail }))).rejects.toThrow(`RPC unavailable: ${fail}`)
  })

  it.each(['ownerOf', 'controllerOf', 'CONTROLLER'])('rejects an unregistered %s dependency', async key => {
    await expect(readProject(rpcFixture({ values: { [key]: OTHER } }))).rejects.toThrow(/REVOwner|controller/)
  })

  it('rejects an unrecognized live ruleset hook', async () => {
    const fixture = rpcFixture()
    await expect(readProject(rpcFixture({ values: { currentRulesetOf: [fixture.ruleset, { ...fixture.metadata, dataHook: OTHER }] } }))).rejects.toThrow(/hook/)
  })

  it.each([{ totalBalanceOf: 41n }, { totalTokenSupplyWithReservedTokensOf: 999n }, { totalCreditSupplyOf: 1001n }])('rejects inconsistent accounting %o', async values => {
    await expect(readProject(rpcFixture({ values }))).rejects.toThrow(/inconsistent INCOME token accounting/)
  })

  it('rejects duplicate or noncanonical payment terminals', async () => {
    await expect(readProject(rpcFixture({ values: { terminalsOf: [terminal, OTHER] } }))).rejects.toThrow(/terminals/)
    const fixture = rpcFixture()
    await expect(readProject(rpcFixture({ values: { accountingContextsOf: [fixture.context, fixture.context] } }))).rejects.toThrow(/duplicated/)
  })

  it.each(['symbol', 'uriOf'])('allows only display metadata fallback for %s', async fail => {
    await expect(readProject(rpcFixture({ fail }))).resolves.toMatchObject({ tokenSymbol: 'INCOME' })
  })

  it('rejects an RPC on the wrong chain and a reorganization during reads', async () => {
    await expect(readProject(rpcFixture({ wrongChain: true }))).rejects.toThrow(/different chain/)
    await expect(readProject(rpcFixture({ reorg: true }))).rejects.toThrow(/chain changed/)
  })
})

describe('unstaked FUND reward reads', () => {
  it('keeps unavailable reward registration separate from working INCOME transactions', async () => {
    const state = await readProject(rpcFixture(), HOLDER, FUND_PROJECT)
    expect(state.rewards).toBeNull()
    expect(state.rewardIssue).toMatch(/not registered/)
    expect(state.totalBalance).toBe(40n)
  })

  it('verifies the reserved split, distributor dependencies and active vote clock before returning rewards', async () => {
    vi.mocked(registeredIncomeDistributor).mockReturnValue(DISTRIBUTOR)
    const fixture = rpcFixture()
    const state = await readProject(fixture, HOLDER, FUND_PROJECT)
    expect(state.rewardIssue).toBeNull()
    expect(fixture.getCode).toHaveBeenCalledWith({ address: FUND, blockNumber: BLOCK })
    expect(state.rewards).toEqual({ distributor: DISTRIBUTOR, fundProjectId: FUND_PROJECT, fundToken: FUND, supportsVestingLoans: true, fundCreditBalance: 12n, fundErc20Balance: 30n, delegate: HOLDER, votes: 30n, collectable: 8n, claimed: 20n, round: 10n, roundStart: 1_800_000_000n, nextRoundStart: 1_800_086_400n, snapshotBlock: BLOCK - 2n, roundDuration: 86400n, vestingRounds: 4n, claimDuration: 0n })
  })

  it('accepts production distributors with vesting loans disabled and preserves their observed round/claim timing', async () => {
    vi.mocked(registeredIncomeDistributor).mockReturnValue(DISTRIBUTOR)
    const state = await readProject(rpcFixture({ values: { REV_LOANS: zeroAddress, REV_OWNER: zeroAddress, ROUND_DURATION: 604_800n, CLAIM_DURATION: 94_608_000n } }), HOLDER, FUND_PROJECT)
    expect(state.rewardIssue).toBeNull()
    expect(state.rewards).toMatchObject({ supportsVestingLoans: false, roundDuration: 604_800n, vestingRounds: 4n, claimDuration: 94_608_000n, nextRoundStart: 1_800_604_800n, collectable: 8n })
  })

  it('uses Arbitrum FUND checkpoint timepoints independently of the pinned L2 RPC height', async () => {
    vi.mocked(registeredIncomeDistributor).mockReturnValue(DISTRIBUTOR)
    const fixture = rpcFixture({ chainId: 42161, values: { clock: 900n, roundSnapshotBlock: 800n } })
    const state = await readProject(fixture, HOLDER, FUND_PROJECT)
    expect(state.rewardIssue).toBeNull()
    expect(state.rewards).toMatchObject({ snapshotBlock: 800n, collectable: 8n })
    expect(state.blockNumber).toBe(BLOCK)
    expect(fixture.readContract).toHaveBeenCalledWith(expect.objectContaining({ functionName: 'getPastTotalActiveVotes', args: [899n], blockNumber: BLOCK }))
    expect(fixture.getBlock).toHaveBeenLastCalledWith({ blockNumber: BLOCK })
  })

  it.each([900n, 1000n])('rejects FUND checkpoint %s outside the native clock past but below the L2 RPC height', async roundSnapshotBlock => {
    vi.mocked(registeredIncomeDistributor).mockReturnValue(DISTRIBUTOR)
    const state = await readProject(rpcFixture({ chainId: 42161, values: { clock: 900n, roundSnapshotBlock } }), HOLDER, FUND_PROJECT)
    expect(state.rewards).toBeNull()
    expect(state.rewardIssue).toMatch(/inconsistent round timing/)
    expect(state.totalBalance).toBe(40n)
  })

  it.each([
    { REV_LOANS: zeroAddress },
    { REV_OWNER: zeroAddress },
    { REV_LOANS: OTHER, REV_OWNER: OTHER },
    { REV_LOANS: zeroAddress, REV_OWNER: OTHER },
  ])('rejects mixed or foreign optional vesting loan dependencies %o', async values => {
    vi.mocked(registeredIncomeDistributor).mockReturnValue(DISTRIBUTOR)
    const state = await readProject(rpcFixture({ values }), HOLDER, FUND_PROJECT)
    expect(state.rewards).toBeNull()
    expect(state.rewardIssue).toMatch(/dependencies/)
    expect(state.totalBalance).toBe(40n)
  })

  it.each([
    { fundCode: '0x1234' as Hex },
    { fundCode: `0x363d3d373d3d3d363d73${OTHER.slice(2)}5af43d82803e903d91602b57fd5bf3` as Hex },
    { fundCode: `${FUND_CLONE_CODE}00` as Hex },
    { fundCode: '0x' as Hex },
    { fundCode: null },
  ])('disables only rewards for a foreign or missing FUND clone: %o', async options => {
    vi.mocked(registeredIncomeDistributor).mockReturnValue(DISTRIBUTOR)
    const state = await readProject(rpcFixture(options), HOLDER, FUND_PROJECT)
    expect(state.rewards).toBeNull()
    expect(state.rewardIssue).toMatch(/canonical Juicebox ERC-20 clone/)
    expect(state.totalBalance).toBe(40n)
    expect(state.issues).toEqual([])
  })

  it.each(['TOKEN', 'fundCode'])('does not authorize rewards when clone verification %s fails', async fail => {
    vi.mocked(registeredIncomeDistributor).mockReturnValue(DISTRIBUTOR)
    const state = await readProject(rpcFixture({ fail }), HOLDER, FUND_PROJECT)
    expect(state.rewards).toBeNull()
    expect(state.rewardIssue).toMatch(/RPC unavailable/)
    expect(state.totalBalance).toBe(40n)
  })

  it.each([{ fundTotalBalance: 41n }, { fundTotalSupply: 40n }])('rejects FUND balances that disagree or exceed total supply: %o', async values => {
    vi.mocked(registeredIncomeDistributor).mockReturnValue(DISTRIBUTOR)
    const state = await readProject(rpcFixture({ values }), HOLDER, FUND_PROJECT)
    expect(state.rewards).toBeNull()
    expect(state.rewardIssue).toMatch(/inconsistent FUND reward balances/)
  })

  it.each(['fundCreditBalance', 'fundErc20Balance', 'fundTotalBalance', 'fundTotalSupply'])('does not fabricate reward activation balances when %s fails', async fail => {
    vi.mocked(registeredIncomeDistributor).mockReturnValue(DISTRIBUTOR)
    const state = await readProject(rpcFixture({ fail }), HOLDER, FUND_PROJECT)
    expect(state.rewards).toBeNull()
    expect(state.rewardIssue).toMatch(/RPC unavailable/)
  })

  it.each([{ splitsOf: [] }, { REV_LOANS: OTHER }, { CLOCK_MODE: 'mode=timestamp' }, { clock: 0n }, { roundSnapshotBlock: BLOCK }, { ROUND_DURATION: 0n }, { fundToken: zeroAddress }])('does not authorize rewards with invalid live configuration %o', async values => {
    vi.mocked(registeredIncomeDistributor).mockReturnValue(DISTRIBUTOR)
    const state = await readProject(rpcFixture({ values }), HOLDER, FUND_PROJECT)
    expect(state.rewards).toBeNull()
    expect(state.rewardIssue).toBeTruthy()
  })

  it('rejects a token lacking active-supply checkpoints, even if it supports ordinary ERC20Votes', async () => {
    vi.mocked(registeredIncomeDistributor).mockReturnValue(DISTRIBUTOR)
    const state = await readProject(rpcFixture({ fail: 'getPastTotalActiveVotes' }), HOLDER, FUND_PROJECT)
    expect(state.rewards).toBeNull()
    expect(state.rewardIssue).toMatch(/getPastTotalActiveVotes/)
  })
})

describe('INCOME full repayment reads', () => {
  it('checks actual loan ownership, project membership and source before calculating a fee-inclusive ceiling', async () => {
    const fixture = rpcFixture()
    const state = await readLoan(fixture)
    expect(state).toMatchObject({ owner: HOLDER, loanId: LOAN_ID, projectId: PROJECT, loan: fixture.loan, accruedFee: 100n, repayCeiling: 100_200n, sourceContext: { token: sourceToken, decimals: 6, currency: 2, isPrimary: true } })
    expect(fixture.getBlock.mock.calls.at(-1)).toEqual([{ blockNumber: BLOCK }])
  })

  it.each([{ loanOwner: OTHER }, { revnetIdOfLoanWith: 8n }, { LOAN_LIQUIDATION_DURATION: 1n }, { primaryTerminalOf: OTHER }])('rejects a loan that cannot be repaid from this project/account: %o', async values => {
    await expect(readLoan(rpcFixture({ values }))).rejects.toThrow()
  })

  it('does not fabricate fees when the live source fee is unavailable', async () => {
    await expect(readLoan(rpcFixture({ fail: 'determineSourceFeeAmount' }))).rejects.toThrow(/RPC unavailable/)
  })

  it('rejects a reorg during the loan quote', async () => {
    await expect(readLoan(rpcFixture({ reorg: true }))).rejects.toThrow(/chain changed/)
  })
})

describe('INCOME auto-issuance reads', () => {
  it('returns only a started stage with pending issuance and current canonical ownership', async () => {
    const state = await readAuto(rpcFixture())
    expect(state).toMatchObject({ owner, controller, stageId: STAGE, beneficiary: HOLDER, amount: 500n, blockNumber: BLOCK })
  })

  it('rejects a nonexistent or not-yet-started stage', async () => {
    const fixture = rpcFixture()
    await expect(readAuto(rpcFixture({ values: { getRulesetOf: [{ ...fixture.ruleset, id: 72 }, fixture.metadata] } }))).rejects.toThrow(/does not exist/)
    await expect(readAuto(rpcFixture({ values: { getRulesetOf: [{ ...fixture.ruleset, start: Number(TIMESTAMP + 1n) }, fixture.metadata] } }))).rejects.toThrow(/still locked/)
  })

  it('rejects already-issued allocations and a reorg', async () => {
    await expect(readAuto(rpcFixture({ values: { amountToAutoIssue: 0n } }))).rejects.toThrow(/already been issued/)
    await expect(readAuto(rpcFixture({ reorg: true }))).rejects.toThrow(/chain changed/)
  })
})
