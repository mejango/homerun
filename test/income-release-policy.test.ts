// @vitest-environment node
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { assertIncomeReleaseSource, incomeReleasePolicy } from '../scripts/prepare-income-release.mts'

const helper = readFileSync(new URL('../src/HomerunDeployer.sol', import.meta.url), 'utf8')

describe('offline INCOME release policy', () => {
  it('accepts the current owner-managed shop source and records the new release identity', () => {
    expect(() => assertIncomeReleaseSource(helper)).not.toThrow()
    expect(incomeReleasePolicy).toMatchObject({
      helperSaltText: 'homerun.deployer.global.v4',
      splitLockedUntil: '0',
      economics: { incomeCutPercentPerQuarter: 2, incomeCashOutTaxBps: 1000, stages: 1 },
      shop: { currency: 2, decimals: 6, ownerCanAdjustTiers: true, newTiersWithOwnerMinting: false },
    })
  })

  it.each([
    ['incentive recipient gaining authority', 'configuration.operator = _msgSender();', 'configuration.operator = operator;'],
    ['owner check removed', 'if (PROJECTS.ownerOf(fundProjectId) != _msgSender()) revert HomerunDeployer_Unauthorized(_msgSender());', ''],
    ['FUND gate removed', 'if (!isFund[fundProjectId]) revert HomerunDeployer_UnsupportedFund(fundProjectId);', ''],
    ['FUND issuance changed', 'FUND_WEIGHT = 10_000e18;', 'FUND_WEIGHT = 1e18;'],
    ['forwarder credited for the creation fee', 'originalPayer = JBPayerTrackerLib.resolve(_msgSender());', 'originalPayer = msg.sender;'],
    ['INCOME cut changed', 'INCOME_CUT_PERCENT = 20_000_000;', 'INCOME_CUT_PERCENT = 50_000_000;'],
    ['INCOME cash-out tax removed', 'INCOME_CASH_OUT_TAX_RATE = 1000;', 'INCOME_CASH_OUT_TAX_RATE = 0;'],
    ['second stage reintroduced', 'new REVStageConfig[](1);', 'new REVStageConfig[](2);'],
    ['reserved split redirected away from the owner', 'beneficiary: payable(_msgSender()),', 'beneficiary: payable(address(0)),'],
    ['controller no longer derived from the revnet deployer', 'CONTROLLER = REV_DEPLOYER.CONTROLLER();', ''],
    ['router registry no longer derived from the revnet deployer', 'ROUTER_TERMINAL_REGISTRY = REV_DEPLOYER.ROUTER_TERMINAL_REGISTRY();', ''],
    ['FUND token no longer deployed at launch', 'token = address(CONTROLLER.deployERC20For({projectId: projectId, name: name, symbol: ticker, salt: scopedSalt}));', 'token = address(0);'],
    ['token salt no longer scoped to the launcher', 'keccak256(abi.encode(_msgSender(), owner, salt))', 'salt'],
    ['initial allocation no longer paid to the current owner', 'address owner = PROJECTS.ownerOf(fundProjectId);', 'address owner = _msgSender();'],
    ['allowlist hook no longer installed', 'rulesetConfigurations[0].metadata.dataHook = address(ALLOWLIST_HOOK);', ''],
    ['inventory edits disabled', 'tiered721HookConfiguration.preventOperatorAdjustingTiers = false;', 'tiered721HookConfiguration.preventOperatorAdjustingTiers = true;'],
    ['owner minting allowed', 'tiered721HookConfiguration.preventOperatorMinting = true;', 'tiered721HookConfiguration.preventOperatorMinting = false;'],
    ['reserves allowed', 'flags.noNewTiersWithReserves = true;', 'flags.noNewTiersWithReserves = false;'],
    ['wrong shop denomination', 'tiersConfig.currency = JBCurrencyIds.USD;', 'tiersConfig.currency = 1;'],
  ])('rejects release evidence with %s', (_label, before, after) => {
    expect(helper).toContain(before)
    expect(() => assertIncomeReleaseSource(helper.replaceAll(before, after))).toThrow(/release profile/)
  })

  it('rejects a lock on the owner reserved split', () => {
    let index = 0
    const changed = helper.replace(/lockedUntil: 0/g, () => { index++; return 'lockedUntil: type(uint48).max' })
    expect(index).toBe(1)
    expect(() => assertIncomeReleaseSource(changed)).toThrow(/release profile/)
  })
})
