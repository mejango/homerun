// @vitest-environment node
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { assertIncomeReleaseSource, incomeReleasePolicy } from '../scripts/prepare-income-release.mts'

const helper = readFileSync(new URL('../src/HomerunIncomeDeployer.sol', import.meta.url), 'utf8')
const vault = readFileSync(new URL('../src/HomerunInitialIncomeVault.sol', import.meta.url), 'utf8')

describe('offline INCOME release policy', () => {
  it('accepts the current owner-managed shop source and records the new release identity', () => {
    expect(() => assertIncomeReleaseSource(helper, vault)).not.toThrow()
    expect(incomeReleasePolicy).toMatchObject({
      launchVersion: 3,
      helperSaltText: 'homerun.income-deployer.global.v3',
      splitLockedUntil: '0',
      shop: { currency: 2, decimals: 6, ownerCanAdjustTiers: true, newTiersWithOwnerMinting: false },
    })
  })

  it.each([
    ['old helper version', 'LAUNCH_VERSION = 3;', 'LAUNCH_VERSION = 2;'],
    ['incentive recipient gaining authority', 'config.operator = msg.sender;', 'config.operator = operator;'],
    ['owner check removed', 'if (PROJECTS.ownerOf(fundProjectId) != msg.sender) revert Unauthorized();', ''],
    ['zero incentive recipient allowed', 'operator == address(0)', 'false'],
    ['inventory edits disabled', 'nft.preventOperatorAdjustingTiers = false;', 'nft.preventOperatorAdjustingTiers = true;'],
    ['owner minting allowed', 'nft.preventOperatorMinting = true;', 'nft.preventOperatorMinting = false;'],
    ['reserves allowed', 'flags.noNewTiersWithReserves = true;', 'flags.noNewTiersWithReserves = false;'],
    ['wrong shop denomination', 'tiersConfig.currency = 2;', 'tiersConfig.currency = 1;'],
  ])('rejects release evidence with %s', (_label, before, after) => {
    expect(helper).toContain(before)
    expect(() => assertIncomeReleaseSource(helper.replace(before, after), vault)).toThrow(/release profile/)
  })

  it.each([0, 1])('rejects a lock on reserved split %s independently', selected => {
    let index = 0
    const changed = helper.replace(/lockedUntil: 0/g, value => index++ === selected ? 'lockedUntil: type(uint48).max' : value)
    expect(index).toBe(2)
    expect(() => assertIncomeReleaseSource(changed, vault)).toThrow(/release profile/)
  })
})
