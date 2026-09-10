import test from 'node:test';
import assert from 'node:assert/strict';
import { ownershipAtMonth } from '../web/create-income-preview.mjs';

const close = (actual, expected, tolerance = 1e-7) => {
  assert.ok(Number.isFinite(actual));
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} differs from ${expected}`);
};
const noCosts = { monthlyCosts: 0, rentGrowthPercent: 0, costGrowthPercent: 0 };
const tokens = state => state.groups.map(group => group.tokens);

test('purchase starts with the initial INCOME allocated across operator and contributor FUND ownership', () => {
  const state = ownershipAtMonth({}, 0);
  assert.equal(state.totalSupply, 500_000);
  assert.equal(state.revenue, 0);
  assert.deepEqual(state.groups.map(group => group.percent), [20, 80, 0]);
  assert.deepEqual(tokens(state), [100_000, 400_000, 0]);
});

test('holder rewards are counted once and the operators include rewards from their FUND share', () => {
  const state = ownershipAtMonth(noCosts, 1);
  // $10,000 issues 100,000: 75,000 direct to operators plus their 20% of
  // the 15,000 holder allocation. The other holders receive the remaining 12,000.
  assert.equal(state.revenue, 10_000);
  assert.equal(state.totalSupply, 600_000);
  assert.deepEqual(tokens(state), [178_000, 412_000, 10_000]);
  close(state.groups.reduce((sum, group) => sum + group.percent, 0), 100);
});

test('the timeline uses quarterly issuance cuts and stops cutting after two years', () => {
  const thirdMonth = ownershipAtMonth(noCosts, 3);
  // Months 1 and 2 mint 100,000; month 3 mints 95,000.
  assert.equal(thirdMonth.totalSupply, 795_000);
  assert.deepEqual(tokens(thirdMonth), [330_100, 435_400, 29_500]);
  assert.equal(thirdMonth.revenue, 30_000);
  close(ownershipAtMonth(noCosts, 2).issuanceRate, 10);
  close(thirdMonth.issuanceRate, 9.5);
  close(ownershipAtMonth(noCosts, 6).issuanceRate, 9.025);
  close(ownershipAtMonth(noCosts, 24).issuanceRate, 10 * 0.95 ** 8);
  close(ownershipAtMonth(noCosts, 60).issuanceRate, 10 * 0.95 ** 8);
});

test('the first month preserves operator ownership while the reserve covers expenses', () => {
  const state = ownershipAtMonth({}, 1);
  assert.equal(state.totalSupply, 600_000);
  assert.deepEqual(tokens(state), [178_000, 412_000, 10_000]);
  const exhausted = ownershipAtMonth({ opsReserve: 0 }, 1);
  close(exhausted.groups[0].tokens, 0.4);
  close(exhausted.totalSupply, 422_000.4);
});

test('revenue, allocation, and initial operator ownership assumptions all affect the preview', () => {
  const state = ownershipAtMonth({
    ...noCosts,
    operatorFundPercent: 10,
    monthlyRent: 2_000,
    operatorSplitPercent: 60,
    ongoingOperatorSplitPercent: 60,
    stickySplitPercent: 20,
  }, 1);
  assert.equal(state.revenue, 2_000);
  // 50,000 initial + 12,000 direct + 400 holder rewards to operators.
  assert.deepEqual(tokens(state), [62_400, 453_600, 4_000]);
  assert.equal(state.totalSupply, 520_000);
});

test('cumulative revenue includes the entered growth assumptions', () => {
  const state = ownershipAtMonth({ ...noCosts, monthlyRent: 100, rentGrowthPercent: 10 }, 13);
  assert.equal(state.revenue, 1_310);
});

test('no revenue retains the initial pie and zero supply has finite empty shares', () => {
  const noRevenue = { monthlyRent: 0, monthlyCosts: 0 };
  assert.deepEqual(tokens(ownershipAtMonth(noRevenue, 60)), [100_000, 400_000, 0]);
  const empty = ownershipAtMonth({ ...noRevenue, revenuePremint: 0 }, 60);
  assert.equal(empty.totalSupply, 0);
  assert.equal(empty.revenue, 0);
  assert.deepEqual(empty.groups.map(group => group.percent), [0, 0, 0]);
  assert.deepEqual(tokens(empty), [0, 0, 0]);
});

test('personal contribution and obsolete staking settings cannot omit holders from the pie', () => {
  const state = ownershipAtMonth({
    ...noCosts,
    investment: 999_999_999,
    fundRewardMode: 'staking',
    personalStakePercent: 0,
    otherStakePercent: 0,
    stickyVestingMonths: 36,
  }, 1);
  assert.deepEqual(tokens(state), [178_000, 412_000, 10_000]);
  close(state.groups.reduce((sum, group) => sum + group.percent, 0), 100);
});

test('invalid assumptions and timeline positions do not silently create misleading projections', () => {
  for (const month of [-1, 61, 1.5, NaN, Infinity, '12']) {
    assert.throws(() => ownershipAtMonth({}, month), RangeError);
  }
  for (const value of [null, false, [], '']) assert.throws(() => ownershipAtMonth(value, 0), TypeError);
  assert.throws(() => ownershipAtMonth({ monthlyRent: -1 }, 12), RangeError);
  assert.throws(() => ownershipAtMonth({ operatorSplitPercent: 90, stickySplitPercent: 20 }, 12), RangeError);
});
