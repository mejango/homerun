import { describe, expect, it, vi } from 'vitest'
import { getAddress, zeroAddress } from 'viem'

const ADDRESSES = vi.hoisted(() => ({ distributor: '0x0000000000000000000000000000000000000100' as const, launcher: '0x0000000000000000000000000000000000000200' as const }))
vi.mock('@bananapus/nana-sdk-core', async importOriginal => {
  const actual = await importOriginal<typeof import('@bananapus/nana-sdk-core')>()
  return { ...actual, jbContractAddress: { ...actual.jbContractAddress, '6': { ...actual.jbContractAddress['6'], JBTokenDistributor: { 8453: ADDRESSES.distributor }, HomerunDeployer: { 8453: ADDRESSES.launcher } } } }
})
import {
  allocateInitialIncome, buildIncomeRewardActivation, buildIncomeRewardClaim,
  buildProtectedIncomeBorrow, incomeRepayCeiling,
  INITIAL_INCOME_SUPPLY, protectedIncomeMinimum, registeredHomerunDeployer, registeredIncomeDistributor,
} from '../src/lib/income-contracts'

const first = getAddress('0x0000000000000000000000000000000000000011')
const second = getAddress('0x0000000000000000000000000000000000000022')
const third = getAddress('0x0000000000000000000000000000000000000033')
const token = getAddress('0x0000000000000000000000000000000000000044')

describe('INCOME ownership and economics', () => {
  it('allocates initial tokens across complete combined FUND balances, including the completed owner share', () => {
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
})

describe('registry lookups', () => {
  it('does not invent missing add-on deployments', () => {
    expect(registeredIncomeDistributor(8453)).toBe(ADDRESSES.distributor)
    expect(registeredHomerunDeployer(8453)).toBe(ADDRESSES.launcher)
    expect(registeredIncomeDistributor(1)).toBeNull()
    expect(registeredHomerunDeployer(1)).toBeNull()
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
