import { describe, expect, it, vi } from 'vitest'
import { decodeFunctionData, encodeFunctionData, getAddress, zeroAddress, zeroHash } from 'viem'

const ADDRESSES = vi.hoisted(() => ({ distributor: '0x0000000000000000000000000000000000000100' as const, launcher: '0x0000000000000000000000000000000000000200' as const }))
vi.mock('@bananapus/nana-sdk-core', async importOriginal => {
  const actual = await importOriginal<typeof import('@bananapus/nana-sdk-core')>()
  return { ...actual, jbContractAddress: { ...actual.jbContractAddress, '6': { ...actual.jbContractAddress['6'], JBTokenDistributor: { 8453: ADDRESSES.distributor }, HomerunIncomeDeployer: { 8453: ADDRESSES.launcher } } } }
})
import {
  allocateInitialIncome, buildIncomeDeployPlan, buildIncomeRewardActivation, buildIncomeRewardClaim,
  buildProtectedIncomeBorrow, incomeRepayCeiling, incomeReservedSplits, incomeStageConfigurations,
  INCOME_QUARTER_SECONDS, INITIAL_INCOME_SUPPLY, protectedIncomeMinimum, registeredIncomeDeployer, registeredIncomeDistributor,
} from '../src/lib/income-contracts'

const first = getAddress('0x0000000000000000000000000000000000000011')
const second = getAddress('0x0000000000000000000000000000000000000022')
const third = getAddress('0x0000000000000000000000000000000000000033')
const token = getAddress('0x0000000000000000000000000000000000000044')
const salt = `0x${'12'.repeat(32)}` as const

describe('INCOME ownership and economics', () => {
  it('allocates initial tokens across complete combined FUND balances, including the completed operator share', () => {
    expect(allocateInitialIncome([{ holder: second, balance: 80n }, { holder: first, balance: 20n }], 100n)).toEqual([
      { beneficiary: first, count: 100_000n * 10n ** 18n }, { beneficiary: second, count: 400_000n * 10n ** 18n },
    ])
  })
  it('conserves the entire initial supply and puts only integer dust at the first sorted address', () => {
    const allocations = allocateInitialIncome([{ holder: third, balance: 1n }, { holder: first, balance: 1n }, { holder: second, balance: 1n }], 3n)
    expect(allocations.reduce((sum, entry) => sum + entry.count, 0n)).toBe(INITIAL_INCOME_SUPPLY)
    expect(allocations[0].count - allocations[1].count).toBe(INITIAL_INCOME_SUPPLY % 3n)
    expect(allocations.map(entry => entry.beneficiary)).toEqual([first, second, third])
  })
  it.each([
    { holders: [{ holder: first, balance: 1n }], supply: 2n, error: /entire FUND supply/ },
    { holders: [{ holder: first, balance: 1n }, { holder: first, balance: 1n }], supply: 2n, error: /Duplicate/ },
    { holders: [{ holder: first, balance: 0n }], supply: 1n, error: /positive/ },
    { holders: [], supply: 0n, error: /nonempty/ },
  ])('rejects incomplete or ambiguous ownership snapshots %#', ({ holders, supply, error }) => {
    expect(() => allocateInitialIncome(holders, supply)).toThrow(error)
  })
  it('scales 70/10/20 through the 80% reserved bucket without confusing split and total percentages', () => {
    const splits = incomeReservedSplits(first, token, ADDRESSES.distributor)
    expect(splits).toEqual([
      { preferAddToBalance: false, lockedUntil: 2 ** 48 - 1, projectId: 0n, percent: 875_000_000, beneficiary: first, hook: zeroAddress },
      { preferAddToBalance: false, lockedUntil: 2 ** 48 - 1, projectId: 0n, percent: 125_000_000, beneficiary: token, hook: ADDRESSES.distributor },
    ])
  })
  it('leaves the reserved split total exactly 1e9 for fractional division and permits no-operator allocation', () => {
    for (const [operator, fund] of [[3333, 1111], [1234, 333], [0, 1000]]) {
      expect(incomeReservedSplits(first, token, ADDRESSES.distributor, operator, fund).reduce((sum, entry) => sum + entry.percent, 0)).toBe(1_000_000_000)
    }
  })
  it('supports an explicit zero-customer allocation', () => { expect(incomeReservedSplits(first, token, ADDRESSES.distributor, 9000, 1000).map(split => split.percent)).toEqual([900_000_000, 100_000_000]) })
  it.each([[10000, 1], [-1, 1000], [7000.1, 1000], [7000, 0]])('rejects invalid allocation %s/%s', (operator, fund) => {
    expect(() => incomeReservedSplits(first, token, ADDRESSES.distributor, operator, fund)).toThrow()
  })
  it('ends cuts at exactly eight quarters and inherits the cut rate at the boundary', () => {
    const stages = incomeStageConfigurations({ startTimestamp: 1_800_000_000, operator: first, fundToken: token, distributor: ADDRESSES.distributor, initialAllocations: [{ chainId: 8453, beneficiary: first, count: INITIAL_INCOME_SUPPLY }] })
    expect(stages[0]).toMatchObject({ startsAtOrAfter: 1_800_000_000, initialIssuance: 10n * 10n ** 18n, splitPercent: 8000, issuanceCutFrequency: INCOME_QUARTER_SECONDS, issuanceCutPercent: 50_000_000, cashOutTaxRate: 0 })
    expect(stages[1]).toMatchObject({ startsAtOrAfter: 1_800_000_000 + 8 * INCOME_QUARTER_SECONDS, initialIssuance: 1n, issuanceCutFrequency: 0, issuanceCutPercent: 0, cashOutTaxRate: 0, autoIssuances: [] })
    expect(stages[1].splits).toEqual(stages[0].splits)
    expect(stages.flatMap(stage => stage.splits).every(split => split.lockedUntil === 2 ** 48 - 1)).toBe(true)
    expect(stages.map(stage => stage.extraMetadata & 4)).toEqual([4, 4])
  })
})

describe('canonical INCOME deploy plan', () => {
  const input = { chainId: 8453 as const, name: 'Founder Haus INCOME', projectUri: 'ipfs://bafytestmetadata', salt, creationFee: 12n, startTimestamp: 1_800_000_000, operator: first, fundToken: token, initialAllocations: [{ chainId: 8453, count: INITIAL_INCOME_SUPPLY, beneficiary: first }] }
  it('uses one unambiguous six-argument deployFor with USDC token-keyed accounting and a limited USD store', () => {
    const plan = buildIncomeDeployPlan(input)
    const calldata = encodeFunctionData({ abi: plan.abi, functionName: plan.functionName, args: plan.args })
    const decoded = decodeFunctionData({ abi: plan.abi, data: calldata })
    expect(decoded.functionName).toBe('deployFor')
    expect(plan.args).toHaveLength(6)
    expect(plan.value).toBe(12n)
    expect(plan.args[1]).toMatchObject({ baseCurrency: 2, operator: first, scopeCashOutsToLocalBalances: false })
    expect(plan.args[2]).toEqual([{ token: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6, currency: 3181390099 }])
    expect(plan.args[4]).toMatchObject({ baseline721HookConfiguration: { tiersConfig: { currency: 2, decimals: 6, tiers: [] } }, preventOperatorMinting: true, preventOperatorAdjustingTiers: true, preventOperatorUpdatingMetadata: true, preventOperatorIncreasingDiscountPercent: true })
    expect(plan.abi.filter(entry => entry.type === 'function' && entry.name === 'deployFor')).toHaveLength(1)
  })
  it.each([
    { salt: zeroHash }, { projectUri: 'https://untrusted.test/metadata' }, { initialAllocations: [{ chainId: 8453, count: 1n, beneficiary: first }] },
    { initialAllocations: [{ chainId: 10, count: INITIAL_INCOME_SUPPLY, beneficiary: first }] },
    { initialAllocations: [{ chainId: 8453, count: INITIAL_INCOME_SUPPLY / 2n, beneficiary: first }, { chainId: 8453, count: INITIAL_INCOME_SUPPLY / 2n, beneficiary: first }] },
  ])('refuses unresolved or inconsistent deployment input %#', invalid => { expect(() => buildIncomeDeployPlan({ ...input, ...invalid })).toThrow() })
  it('does not invent missing add-on deployments', () => {
    expect(registeredIncomeDistributor(8453)).toBe(ADDRESSES.distributor)
    expect(registeredIncomeDeployer(8453)).toBe(ADDRESSES.launcher)
    expect(registeredIncomeDistributor(1)).toBeNull()
    expect(registeredIncomeDeployer(1)).toBeNull()
    expect(() => buildIncomeDeployPlan({ ...input, chainId: 1 })).toThrow(/registry/)
  })
})

describe('FUND reward activation and claims', () => {
  it('self-delegates vanilla FUND without approving or depositing tokens', () => {
    const request = buildIncomeRewardActivation(8453, token, first)
    expect(request.address).toBe(token)
    expect(request.functionName).toBe('delegate')
    expect(request.args).toEqual([first])
    expect(request.value).toBeUndefined()
  })
  it('uses the holder address as reward identity and always collects to that holder', () => {
    const request = buildIncomeRewardClaim({ chainId: 8453, holder: first, fundToken: token, incomeToken: second, collect: true })
    expect(request.address).toBe(ADDRESSES.distributor)
    expect(request.functionName).toBe('collectVestedRewards')
    expect(request.args).toEqual([token, [BigInt(first)], [second], first])
    expect(buildIncomeRewardClaim({ chainId: 8453, holder: first, fundToken: token, incomeToken: second, collect: false }).args).toEqual([token, [BigInt(first)], [second]])
  })
  it('does not silently route rewards on chains with no verified distributor', () => {
    expect(() => buildIncomeRewardClaim({ chainId: 1, holder: first, fundToken: token, incomeToken: second, collect: true })).toThrow(/verified/)
  })
})

describe('INCOME loan limits', () => {
  it('never turns a positive protected quote into an unlimited zero floor', () => {
    expect(protectedIncomeMinimum(1n)).toBe(1n)
    expect(protectedIncomeMinimum(1000n)).toBe(990n)
    expect(() => protectedIncomeMinimum(0n)).toThrow()
    expect(() => protectedIncomeMinimum(1n, 10_000n)).toThrow()
  })
  it('encodes reviewed collateral, holder and positive output floor using the SDK borrow ABI', () => {
    const request = buildProtectedIncomeBorrow({ chainId: 8453, revnetId: 12n, token, quotedBorrowAmount: 1000n, collateralCount: 20n, holder: first, beneficiary: second })
    expect(request.functionName).toBe('borrowFrom')
    expect(request.args).toEqual([12n, token, 990n, 20n, second, 25n, first])
  })
  it('includes accrued fees plus the refundable 0.1% principal buffer', () => { expect(incomeRepayCeiling(100_000n, 5_000n)).toBe(105_100n) })
  it.each([24n, 501n])('refuses a prepaid source fee outside contract bounds %s', prepaidFeePercent => {
    expect(() => buildProtectedIncomeBorrow({ chainId: 8453, revnetId: 1n, token, quotedBorrowAmount: 100n, collateralCount: 1n, holder: first, beneficiary: first, prepaidFeePercent })).toThrow(/prepaid fee/)
  })
})

describe('complete allocation edge cases', () => {
  it('retains zero-address credit ownership instead of changing the denominator', () => {
    expect(allocateInitialIncome([{ holder: zeroAddress, balance: 1n }, { holder: first, balance: 1n }], 2n)).toEqual([
      { beneficiary: zeroAddress, count: INITIAL_INCOME_SUPPLY / 2n }, { beneficiary: first, count: INITIAL_INCOME_SUPPLY / 2n },
    ])
  })
  it('has no per-transaction holder cap because launch funds one bounded vault', () => {
    const holders = Array.from({ length: 204 }, (_, index) => ({ holder: getAddress(`0x${(index + 1).toString(16).padStart(40, '0')}`), balance: 1n }))
    expect(allocateInitialIncome(holders, 204n).reduce((sum, allocation) => sum + allocation.count, 0n)).toBe(INITIAL_INCOME_SUPPLY)
  })
})
