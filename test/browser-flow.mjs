/**
 * UI regression checks for the FUND/INCOME network. Start npm run dev first.
 * npm run test:browser uses workspace Playwright and macOS Chrome.
 * Overrides: BASE_URL, PLAYWRIGHT_MODULE, CHROME_PATH, BROWSER_SCREENSHOT_DIR.
 * Local browser spawning may require sandbox escalation. The former lifecycle
 * financial engine and its unit tests remain separate reference artifacts.
 */
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const { chromium } = await import((process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE) : new URL('../../../webclients/juicescan/node_modules/playwright/index.mjs', import.meta.url)).href);
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true, reducedMotion: 'reduce' });
const page = await context.newPage();
const demoURL = new URL('/founderhaus', process.env.BASE_URL || 'http://127.0.0.1:3010/').href;
const homeURL = new URL('/', demoURL).href;
const phases = ['raising', 'funded', 'refunding', 'refunded', 'earning', 'liquidated'];
const errors = [];
const failures = [];
// Four quarterly 5% cuts have happened at months 12 and 13. Customers receive
// 10% of issuance; independently derive this single-payment expectation.
const month12IssuanceRate = 10 * 0.95 ** 4;
const displayedPayerTokens = amount => Number(new Intl.NumberFormat('en-US', { maximumFractionDigits: 6 })
  .format(amount * month12IssuanceRate * 0.1).replaceAll(',', ''));
let checks = 0;
page.on('pageerror', error => errors.push(error.message));
page.on('console', message => { if (message.type() === 'error') errors.push(`${message.text()} ${message.location().url || ''}`.trim()); });
page.on('response', response => { if (response.status() >= 400) errors.push(`HTTP ${response.status()} ${response.url()}`); });
page.setDefaultTimeout(7000);
async function check(name, callback) {
  checks++;
  try { await callback(); process.stdout.write(`PASS ${name}\n`); }
  catch (error) { failures.push(name); process.stdout.write(`FAIL ${name}: ${error.message}\n`); }
}
async function open(hash = '') {
  let response = await page.goto(`${demoURL}${hash ? `#${hash}` : ''}`);
  if (!response) response = await page.reload();
  assert.equal(response.status(), 200);
  await page.locator('#scenario-title').waitFor();
}
async function phase(name) {
  if (['earning', 'liquidated'].includes(name)) {
    await page.locator(`button[data-journey-phase="${name}"]`).click();
  } else {
    if (await page.locator(`[data-phase="${name}"]`).isHidden()) {
      await page.locator('button[data-journey-phase="raising"]').click();
    }
    await page.locator(`[data-phase="${name}"]`).click();
  }
}
async function reveal(locator) {
  if (await locator.locator('xpath=ancestor::*[@id="assumptions-body"]').count() && await page.locator('#assumptions-body').isHidden()) await page.locator('#toggle-assumptions').click();
  const details = locator.locator('xpath=ancestor::details');
  for (let index = 0; index < await details.count(); index++) {
    const ancestor = details.nth(index);
    if (await ancestor.getAttribute('open') === null) await ancestor.locator(':scope > summary').click();
  }
}
async function text(selector) { return (await page.locator(selector).textContent()).trim(); }
async function dollars(selector) {
  const value = await text(selector);
  const match = value.match(/\$([\d,]+(?:\.\d+)?)/);
  assert.ok(match, `Expected money at ${selector}: ${value}`);
  return Number(match[1].replaceAll(',', ''));
}
async function units(selector) {
  const value = await text(selector);
  const match = value.match(/([\d,]+(?:\.\d+)?)/);
  assert.ok(match, `Expected a token amount at ${selector}: ${value}`);
  return Number(match[1].replaceAll(',', ''));
}
async function singleLine(selector) {
  const measure = await page.locator(selector).evaluate(element => {
    const style = getComputedStyle(element);
    return { height: element.getBoundingClientRect().height, lineHeight: parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.2 };
  });
  assert.ok(measure.height <= measure.lineHeight + 1, `${selector} should fit on one line.`);
}
async function ownership(token) {
  const chart = page.locator(`[data-ownership-chart="${token}"]`);
  const total = Number(await chart.getAttribute('data-ownership-total'));
  const parts = await chart.locator('[data-owner]').evaluateAll(items => Object.fromEntries(items.map(item => [item.dataset.owner, Number(item.dataset.ownerTokens)])));
  const sum = Object.values(parts).reduce((value, amount) => value + amount, 0);
  assert.ok(Math.abs(sum - total) <= Math.max(0.00001, total * 1e-10), `${token} ownership partitions outstanding supply.`);
  return { total, parts };
}
async function headerAlignment() {
  await page.evaluate(() => document.fonts.ready);
  const starts = await page.evaluate(() => {
    const start = selector => {
      const range = document.createRange();
      range.selectNodeContents(document.querySelector(selector));
      const box = range.getBoundingClientRect();
      return document.body.classList.contains('home-page') && innerWidth <= 760 ? box.x + box.width / 2 : box.x;
    };
    return { word: start('.brand-word'), tagline: start('.brand-tagline') };
  });
  assert.ok(Math.abs(starts.word - starts.tagline) <= 1, 'Tagline aligns with the wordmark: centered on mobile home, left-aligned elsewhere.');
}
async function field(name, amount) {
  if (name === 'investment') {
    const previous = await page.locator('#project-journey').getAttribute('data-journey-phase');
    if (previous !== 'raising') await phase('raising');
    await page.locator('#pay-amount').fill(String(amount));
    if (previous !== 'raising') await phase(previous);
    return;
  }
  const input = page.locator(`#field-${name}`);
  await reveal(input);
  await input.fill(String(amount));
}
async function journeyCurrent(name) {
  const buttons = page.locator('#project-journey .pj-stage[data-journey-phase]');
  assert.equal(await buttons.count(), 3);
  assert.deepEqual(await buttons.evaluateAll(items => items.map(item => item.dataset.journeyPhase)), ['raising', 'earning', 'liquidated']);
  for (const candidate of ['raising', 'earning', 'liquidated']) {
    const button = page.locator(`.pj-stage[data-journey-phase="${candidate}"]`);
    const selected = (await button.getAttribute('aria-current')) === 'step'
      || (await button.getAttribute('aria-pressed')) === 'true';
    assert.equal(selected, candidate === name, `${candidate} has the correct accessible current-base state.`);
    assert.ok((await button.ariaSnapshot()).length > 12, 'Every base has an accessible name.');
    assert.equal(await page.locator(`.preview-base-buttons button[data-journey-phase="${candidate}"]`).getAttribute('aria-pressed'), String(candidate === name));
  }
}
async function download(button = '#download-scenario') {
  const pending = page.waitForEvent('download');
  await page.locator(button).click();
  const result = await pending;
  assert.match(result.suggestedFilename(), /^homerun-founder-haus-[a-z_-]+\.json$/);
  const json = JSON.parse(await readFile(await result.path(), 'utf8'));
  await result.delete();
  return json;
}
async function screenshot(name, fullPage = true) {
  if (!process.env.BROWSER_SCREENSHOT_DIR) return;
  await mkdir(process.env.BROWSER_SCREENSHOT_DIR, { recursive: true });
  await page.screenshot({ path: join(process.env.BROWSER_SCREENSHOT_DIR, name), fullPage });
}
async function ownerAction(action) {
  await reveal(page.locator(`[data-owner-action="${action}"]`));
  await page.locator(`[data-owner-action="${action}"]`).click();
  assert.equal(await page.locator('#owner-dialog').isVisible(), true);
  assert.match(await text('#owner-dialog'), /Nothing is signed, submitted, queued or changed on-chain/);
}

try {
  await check('The ballpark homepage fits each screen and links to the working demo', async () => {
    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      const response = await page.goto(homeURL);
      assert.equal(response.status(), 200);
      await page.locator('#ballpark').waitFor();
      assert.equal(await page.locator('#ballpark').evaluate(canvas => canvas instanceof HTMLCanvasElement && canvas.width > 0 && canvas.height > 0), true);
      assert.equal(await page.locator('.see-demo').getAttribute('href'), './founderhaus');
      assert.equal(await page.getByRole('link', { name: 'See Founder Haus demo', exact: true }).count(), 1);
      assert.equal(await page.locator('link[rel="canonical"]').getAttribute('href'), 'https://homerun.money/');
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth) <= width + 1, `Homepage overflows ${width}px`);
      await headerAlignment();
      await screenshot(`homerun-home-${width}.png`);
      await page.locator('.see-demo').click();
      await page.locator('#scenario-title').waitFor();
      assert.match(new URL(page.url()).pathname, /\/founderhaus\/?$/);
      assert.equal(await dollars('#raise-goal'), 615384.62);
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    for (const pathname of ['/founderhaus/', '/demo.html']) {
      await page.goto(new URL(pathname, homeURL).href);
      await page.locator('#scenario-title').waitFor();
      assert.match(new URL(page.url()).pathname, /\/founderhaus\/?$/);
      assert.equal(await page.locator('.brand').getAttribute('href'), '/');
      const currentPath = new URL(page.url()).pathname;
      await page.locator('.skip-link').focus();
      await page.keyboard.press('Enter');
      assert.equal(new URL(page.url()).pathname, currentPath);
      assert.equal(await page.evaluate(() => document.activeElement.id), 'main');
      await page.locator('#open-house-gallery img').evaluate(image => image.decode());
      assert.equal(await dollars('#raise-goal'), 615384.62);
    }
  });
  await check('The initial raise includes the asset, actual reserve and closing fee', async () => {
    await open();
    assert.match(await text('h1'), /Founder Haus/);
    assert.equal(await page.locator('.deal-heading > #project-journey').count(), 1);
    assert.equal(await page.locator('.preview-workbench > .assumptions').count(), 1);
    assert.equal(await page.locator('.preview-workbench > #preview-controls').count(), 1);
    assert.equal(await page.evaluate(() => Boolean(document.querySelector('.preview-workbench').compareDocumentPosition(document.querySelector('.deal-heading')) & Node.DOCUMENT_POSITION_FOLLOWING)), true);
    assert.equal(await page.locator('#field-investment').count(), 1);
    assert.equal(await page.locator('#projection-form #field-investment').count(), 0);
    assert.equal(await page.locator('#contribution-form #field-investment').count(), 1);
    assert.equal(await page.locator('#pay-panel #contribution-section').count(), 1);
    assert.equal(await page.evaluate(() => Boolean(document.querySelector('#pay-form').compareDocumentPosition(document.querySelector('#contribution-section')) & Node.DOCUMENT_POSITION_FOLLOWING)), true);
    assert.equal(await page.locator('#field-investment').isHidden(), true);
    assert.equal(await page.locator('#pay-amount').isVisible(), true);
    for (const id of ['fund-position-preview', 'fund-ownership-preview']) {
      assert.equal(await page.locator(`#pay-panel #${id}`).getAttribute('open'), null, `${id} starts collapsed below Pay.`);
    }
    assert.equal(await text('.brand'), '⚾︎ Homerun');
    assert.equal(await text('.brand-tagline'), 'Fund and earn together');
    assert.equal(await page.locator('footer > span').count(), 1);
    assert.match(await text('footer'), /FUND:.*INCOME:/s);
    await headerAlignment();
    assert.match(await page.title(), /^Homerun ⚾︎ — Founder Haus/);
    assert.equal(await page.locator('link[rel="canonical"]').getAttribute('href'), 'https://homerun.money/founderhaus');
    assert.equal(await page.locator('meta[property="og:site_name"]').getAttribute('content'), 'Homerun ⚾︎');
    assert.equal(await page.locator('meta[property="og:url"]').getAttribute('content'), 'https://homerun.money/founderhaus');
    assert.equal(await dollars('#property-budget'), 500000);
    assert.equal(await dollars('#raise-goal'), 615384.62);
    assert.equal(await dollars('#escrow-cash'), 369230.77);
    assert.equal(await dollars('#your-fund-cashout'), 9027.08);
    assert.equal((await ownership('income')).total, 0);
    assert.equal((await ownership('fund')).parts.operators, undefined);
    assert.match(await text('#your-fund-tokens'), /100,000,000 FUND/);
    assert.equal(await page.locator('[data-phase]').count(), 6);
    assert.equal(await page.locator('#preview-controls [data-phase]').count(), 6);
    assert.equal(await text('#state-label'), 'Preview fundraising');
    assert.equal(await text('.assumptions h2'), 'Asset assumptions');
    assert.equal(await text('label[for="field-monthlyRent"]'), 'Monthly revenue');
    for (const key of ['raisedPercent', 'revenueMonths', 'salePrice']) {
      assert.equal(await page.locator(`#preview-controls #field-${key}`).count(), 1, `${key} belongs to the stage preview.`);
      assert.equal(await page.locator(`#projection-form #field-${key}`).count(), 0);
    }
    for (const key of ['purchaseBudget', 'opsReserve', 'monthlyRent', 'monthlyCosts', 'rentGrowthPercent', 'costGrowthPercent']) assert.equal(await page.locator(`#projection-form #field-${key}`).count(), 1, `${key} belongs to asset assumptions.`);
    assert.equal(await page.locator('#preview-controls #raise-input').isVisible(), true);
    assert.equal(await page.locator('#preview-controls #revenue-input').isHidden(), true);
    assert.equal(await page.locator('#preview-controls #sale-scenario').isHidden(), true);
    assert.equal(await page.locator('#assumptions-body').isHidden(), true);
    for (const key of ['purchaseBudget', 'opsReserve', 'monthlyRent', 'monthlyCosts']) assert.equal(await page.locator(`#field-${key}`).isVisible(), true);
    for (const key of ['operatorFundPercent', 'revenuePremint', 'revPrice', 'stickySplitPercent', 'operatorSplitPercent', 'ongoingOperatorSplitPercent', 'issuanceCutPercent', 'issuanceCutYears', 'otherStakePercent', 'stickyVestingMonths', 'renterCashoutPercent', 'revCashoutFeePercent', 'payoutFeePercent', 'personalStakePercent', 'closingCosts', 'precloseSpent', 'saleCostPercent', 'saleDebt']) assert.equal(await page.locator(`#field-${key}`).count(), 0, `${key} is a fixed project term.`);
    await journeyCurrent('raising');
    assert.equal(await page.locator('#preview-controls [data-phase]:visible').count(), 4);
    assert.equal(await page.locator('#your-loan-cash').count(), 0);
    await screenshot('rooftop-simple-raising.png');
  });
  await check('Project header figures follow the raise and distinguish completed fundraising', async () => {
    await open();
    assert.equal(await dollars('#project-raised'), 369230.77);
    assert.equal(await dollars('#project-goal'), 615384.62);
    assert.equal(await text('#project-funded'), '60%');
    await field('raisedPercent', 40);
    assert.equal(await dollars('#project-raised'), 246153.85);
    assert.equal(await text('#project-funded'), '40%');
    await field('purchaseBudget', 400000);
    assert.equal(await dollars('#project-goal'), 512820.52);
    assert.equal(await dollars('#project-raised'), 205128.21);
    await phase('earning');
    assert.equal(await text('#project-raised-label'), 'Originally raised');
    assert.equal(await text('#project-funded'), '100%');
    assert.equal(await dollars('#project-raised'), await dollars('#project-goal'));
    await phase('refunded');
    assert.equal(await text('#project-raised-label'), 'Originally raised');
    assert.equal(await text('#project-funded'), '40%');
    await page.locator('#field-purchaseBudget').fill('');
    for (const id of ['project-raised', 'project-goal', 'project-funded']) assert.equal(await text(`#${id}`), '—');
    await page.locator('#reset-example').click();
    assert.equal(await text('#project-funded'), '60%');
    assert.equal(await text('#project-raised-label'), 'Raised');
  });
  await check('The three bases distinguish fundraising variants, income and the optional sale', async () => {
    await open();
    assert.equal(await page.locator('#project-journey canvas').getAttribute('aria-hidden'), 'true');
    assert.equal(await page.locator('#project-journey button, #project-journey [tabindex]').count(), 0);
    const indicator = await page.locator('.pj-stage[data-journey-phase="earning"]').boundingBox();
    await page.mouse.click(indicator.x + indicator.width / 2, indicator.y + 14);
    await journeyCurrent('raising');
    assert.equal(await page.locator('#preview-controls .preview-base-buttons button').count(), 3);
    for (const [name, current, states] of [
      ['raising', 'raising', ['current', 'upcoming', 'upcoming']],
      ['funded', 'raising', ['complete', 'upcoming', 'upcoming']],
      ['refunding', 'raising', ['refunding', 'skipped', 'skipped']],
      ['refunded', 'raising', ['refunded', 'skipped', 'skipped']],
      ['earning', 'earning', ['complete', 'current', 'upcoming']],
      ['liquidated', 'liquidated', ['complete', 'complete', 'complete']],
    ]) {
      await phase(name);
      await journeyCurrent(current);
      assert.deepEqual(await page.locator('.pj-stage[data-journey-phase]').evaluateAll(buttons => buttons.map(button => button.dataset.journeyStatus)), states);
      assert.equal(await page.locator('#project-journey .pj-description').getAttribute('role'), 'status');
      assert.equal(await page.locator('#preview-controls [data-phase]:visible').count(), current === 'raising' ? 4 : 0);
    }
    await page.locator('button[data-journey-phase="raising"]').focus();
    await page.keyboard.press('Enter');
    await journeyCurrent('raising');
    await page.locator('button[data-journey-phase="earning"]').focus();
    await page.keyboard.press('Space');
    await journeyCurrent('earning');
    assert.equal(await dollars('#your-loan-cash'), 610.83);
  });
  await check('FUND Pay edits the contribution preview and reviews without moving escrow cash', async () => {
    await open();
    assert.equal(await text('#pay-route'), 'FUND');
    assert.equal(await page.locator('#pay-panel').getAttribute('data-pay-kind'), 'payment');
    assert.equal(await units('#pay-output'), 100000000);
    const escrow = await dollars('#escrow-cash');
    await page.locator('#fund-position-label').click();
    await page.locator('#fund-ownership-label').click();
    const amount = page.locator('#pay-amount');
    await amount.focus();
    await page.keyboard.press('ControlOrMeta+A');
    await page.keyboard.type('12000', { delay: 20 });
    assert.equal(await amount.inputValue(), '12000');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'pay-amount');
    assert.equal(Number((await page.locator('#field-investment').inputValue()).replaceAll(',', '')), 12000);
    assert.equal(await units('#pay-output'), 120000000);
    assert.equal(await units('#your-fund-tokens'), 120000000);
    assert.equal(await dollars('#escrow-cash'), escrow);
    assert.notEqual(await page.locator('#fund-position-preview').getAttribute('open'), null);
    assert.notEqual(await page.locator('#fund-ownership-preview').getAttribute('open'), null);
    await page.keyboard.press('Enter');
    await page.locator('#pay-dialog').waitFor({ state: 'visible' });
    assert.equal(await text('#pay-dialog-title'), 'Preview FUND payment');
    assert.match(await text('#pay-dialog-values'), /12,000\.00 USDC.*120,000,000 FUND/s);
    assert.match(await text('#pay-dialog'), /Nothing is signed, paid, redeemed, or changed/);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'pay-dialog-close');
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'pay-dialog-done');
    await page.keyboard.press('Shift+Tab');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'pay-dialog-close');
    await page.keyboard.press('Escape');
    await page.locator('#pay-dialog').waitFor({ state: 'hidden' });
    await page.waitForFunction(() => document.activeElement?.id === 'pay-review');
    assert.equal(await dollars('#escrow-cash'), escrow);
  });
  await check('INCOME Pay keeps its own amount and never changes the original FUND position', async () => {
    await open();
    await page.locator('#pay-amount').fill('12000');
    await phase('earning');
    assert.equal(await text('#pay-route'), 'INCOME');
    assert.equal(await page.locator('#pay-amount').inputValue(), '100');
    const fund = await units('#your-fund-tokens');
    const income = await units('#your-rev-tokens');
    const cash = await dollars('#cash-in-pool');
    const loan = await dollars('#your-loan-cash');
    await page.locator('#pay-amount').fill('250.50');
    assert.equal(await units('#pay-output'), displayedPayerTokens(250.5));
    assert.equal(await text('#pay-output-unit'), 'INCOME');
    assert.equal(await units('#your-fund-tokens'), fund);
    assert.equal(await units('#your-rev-tokens'), income);
    assert.equal(await dollars('#cash-in-pool'), cash);
    assert.equal(await dollars('#your-loan-cash'), loan);
    assert.equal(Number((await page.locator('#field-investment').inputValue()).replaceAll(',', '')), 12000);
    await page.locator('#pay-review').click();
    assert.equal(await text('#pay-dialog-title'), 'Preview INCOME payment');
    assert.match(await text('#pay-dialog-note'), /does not change your FUND contribution or add revenue/);
    await page.locator('#pay-dialog-done').click();
    await page.waitForFunction(() => document.activeElement?.id === 'pay-review');
    await phase('raising');
    assert.equal(Number((await page.locator('#pay-amount').inputValue()).replaceAll(',', '')), 12000);
    await phase('earning');
    assert.equal(Number((await page.locator('#pay-amount').inputValue()).replaceAll(',', '')), 250.5);
    await field('revenueMonths', 13);
    assert.equal(await units('#pay-output'), displayedPayerTokens(250.5));
    assert.equal(await units('#your-fund-tokens'), fund);
    await page.locator('#reset-example').click();
    await phase('earning');
    assert.equal(await page.locator('#pay-amount').inputValue(), '100');
    assert.equal(await units('#your-fund-tokens'), 100000000);
  });
  await check('INCOME payment details react to the new payment while preserving prior FUND history', async () => {
    await open();
    await phase('earning');
    const allocation = page.locator('[data-income-payment-details="allocation"]');
    const liquidity = page.locator('[data-income-payment-details="liquidity"]');
    assert.equal(await allocation.getAttribute('open'), null);
    assert.equal(await liquidity.getAttribute('open'), null);
    assert.equal(await page.locator('#pay-panel [data-income-payment-details]').count(), 2);
    await allocation.locator(':scope > summary').click();
    await liquidity.locator(':scope > summary').click();
    assert.equal(await units('[data-income-payment-value="payer-tokens"]'), displayedPayerTokens(100));
    assert.equal(await dollars('[data-income-payment-value="cash-before"]'), 120000);
    assert.equal(await dollars('[data-income-payment-value="cash-after"]'), 120100);
    assert.equal(await dollars('[data-income-payment-value="cashout"]'), 6.13);
    assert.equal(await dollars('[data-income-payment-value="loan-cash"]'), 5.76);
    assert.equal(await page.locator('[data-income-allocation]').count(), 4);
    const oldCash = await dollars('#cash-in-pool');
    const oldFund = await units('#your-fund-tokens');
    const oldIncome = await units('#your-rev-tokens');
    const oldLoan = await dollars('#your-loan-cash');
    const amount = page.locator('#pay-amount');
    const inputNode = await amount.elementHandle();
    await amount.fill('250');
    assert.equal(await units('[data-income-payment-value="payer-tokens"]'), displayedPayerTokens(250));
    assert.equal(await units('[data-income-allocation="operators"] strong'), 1527.199219);
    assert.equal(await units('[data-income-allocation="stakers"] strong'), 305.439844);
    assert.equal(await dollars('[data-income-payment-value="cash-after"]'), 120250);
    assert.equal(await dollars('[data-income-payment-value="cashout"]'), 15.33);
    assert.equal(await dollars('[data-income-payment-value="loan-cash"]'), 14.41);
    await amount.focus();
    await page.keyboard.press('ControlOrMeta+A');
    await page.keyboard.type('1250', { delay: 20 });
    assert.equal(await amount.inputValue(), '1250');
    assert.equal(await inputNode.evaluate(node => node === document.querySelector('#pay-amount')), true);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'pay-amount');
    assert.equal(await amount.evaluate(node => node.selectionStart), 4);
    assert.notEqual(await allocation.getAttribute('open'), null);
    assert.notEqual(await liquidity.getAttribute('open'), null);
    assert.equal(await units('[data-income-payment-value="payer-tokens"]'), displayedPayerTokens(1250));
    assert.equal(await dollars('[data-income-payment-value="cashout"]'), 76.93);
    assert.equal(await dollars('[data-income-payment-value="loan-cash"]'), 72.31);
    assert.equal(await dollars('#cash-in-pool'), oldCash);
    assert.equal(await units('#your-fund-tokens'), oldFund);
    assert.equal(await units('#your-rev-tokens'), oldIncome);
    assert.equal(await dollars('#your-loan-cash'), oldLoan);
    await amount.fill('');
    assert.equal(await page.locator('#pay-review').isDisabled(), true);
    assert.equal(await page.locator('#income-payment-results').isHidden(), true);
    assert.equal(await page.locator('[data-income-payment-value="cashout"]').isVisible(), false);
    await amount.fill('1250');
    assert.notEqual(await allocation.getAttribute('open'), null, 'Clearing and retyping preserves the allocation dropdown preference.');
    assert.notEqual(await liquidity.getAttribute('open'), null, 'Clearing and retyping preserves the liquidity dropdown preference.');
    await field('revenueMonths', 13);
    assert.equal(await units('[data-income-payment-value="payer-tokens"]'), displayedPayerTokens(1250));
    assert.match(await text('[data-income-payment-details="allocation"]'), /month 13/);
    assert.notEqual(await allocation.getAttribute('open'), null);
    assert.notEqual(await liquidity.getAttribute('open'), null);
    await amount.fill('1.001');
    assert.equal(await page.locator('#pay-review').isDisabled(), true);
    assert.equal(await page.locator('#income-payment-results').isHidden(), true);
    assert.equal(await page.locator('[data-income-payment-value="cashout"]').isVisible(), false);
    await amount.fill('100');
    assert.equal(await page.locator('#pay-review').isEnabled(), true);
    assert.equal(await units('[data-income-payment-value="payer-tokens"]'), displayedPayerTokens(100));
    await phase('raising');
    assert.equal(await page.locator('#income-payment-results').isHidden(), true);
    assert.equal(Number((await amount.inputValue()).replaceAll(',', '')), 10000);
    await inputNode.dispose();
  });
  await check('Pay rejects invalid amounts and recovers while preserving input focus and project balances', async () => {
    await open();
    await phase('earning');
    const cash = await dollars('#cash-in-pool');
    const loan = await dollars('#your-loan-cash');
    for (const raw of ['', '-1', '1.001', '1,00', 'not a number']) {
      await page.locator('#pay-amount').fill(raw);
      assert.equal(await page.locator('#pay-amount').getAttribute('aria-invalid'), 'true');
      assert.equal(await page.locator('#pay-error').isVisible(), true);
      assert.equal(await page.locator('#pay-review').isDisabled(), true);
      assert.equal(await dollars('#cash-in-pool'), cash);
      assert.equal(await dollars('#your-loan-cash'), loan);
    }
    await page.locator('#pay-amount').fill('500.25');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'pay-amount');
    assert.equal(await page.locator('#pay-amount').getAttribute('aria-invalid'), 'false');
    assert.equal(await page.locator('#pay-error').isHidden(), true);
    assert.equal(await page.locator('#pay-review').isEnabled(), true);
    assert.equal(await units('#pay-output'), displayedPayerTokens(500.25));
    await phase('raising');
    await page.locator('#pay-amount').fill('-1');
    assert.equal(await page.locator('#pay-review').isDisabled(), true);
    assert.equal(await page.locator('#pay-error').isVisible(), true);
    assert.ok((await text('#contribution-error')).length > 0);
    await page.locator('#pay-amount').fill('12,500.25');
    assert.equal(await page.locator('#pay-error').isHidden(), true);
    assert.equal(await text('#contribution-error'), '');
    assert.equal(await page.locator('#pay-review').isEnabled(), true);
    assert.equal(await units('#your-fund-tokens'), 125002500);
    await field('purchaseBudget', -1);
    assert.equal(await page.locator('#pay-review').isDisabled(), true);
    assert.equal(await page.locator('#project-journey').getAttribute('data-journey-valid'), 'false');
    assert.equal(await page.locator('.pj-stage[aria-current="step"]').count(), 0);
    await field('purchaseBudget', 500000);
    assert.equal(await page.locator('#pay-review').isEnabled(), true);
    await journeyCurrent('raising');
  });
  await check('Closed and completed raises disable Pay while refunds and sales review separate FUND cash', async () => {
    await open();
    for (const name of ['funded', 'refunded']) {
      await phase(name);
      assert.equal(await page.locator('#pay-review').isDisabled(), true);
      assert.equal(await page.locator('#pay-amount').isDisabled(), true);
      assert.equal(await page.locator('#pay-amount-wrap').isHidden(), true);
    }
    await phase('refunding');
    assert.equal(await page.locator('#pay-panel').getAttribute('data-pay-kind'), 'refund');
    assert.equal(await units('#pay-output'), await dollars('#your-refund'));
    assert.equal(await text('#pay-route'), 'FUND → USDC');
    const refundCash = await dollars('#refundable-cash');
    await page.locator('#pay-review').click();
    assert.equal(await text('#pay-dialog-title'), 'Preview FUND refund');
    assert.match(await text('#pay-dialog-note'), /no refund cash-out tax/);
    await page.locator('#pay-dialog-close').click();
    await page.waitForFunction(() => document.activeElement?.id === 'pay-review');
    assert.equal(await dollars('#refundable-cash'), refundCash);
    await phase('liquidated');
    assert.equal(await page.locator('#pay-panel').getAttribute('data-pay-kind'), 'sale');
    assert.equal(await units('#pay-output'), await dollars('#your-fund-sale'));
    const saleCash = await dollars('#fund-sale-cash');
    const incomeCash = await dollars('#cash-in-pool');
    await page.locator('#pay-review').click();
    assert.equal(await text('#pay-dialog-title'), 'Preview FUND cash-out');
    assert.match(await text('#pay-dialog-values'), /Separate INCOME cash-out estimate/);
    assert.match(await text('#pay-dialog-note'), /INCOME remains separate/);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.activeElement?.id === 'pay-review');
    assert.equal(await dollars('#fund-sale-cash'), saleCash);
    assert.equal(await dollars('#cash-in-pool'), incomeCash);
  });
  await check('Official Founder Haus photos load, cycle by keyboard and return focus to the demo', async () => {
    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 });
      await open();
      const opener = page.locator('#open-house-gallery');
      const dialog = page.locator('#house-gallery');
      const frame = await opener.evaluate(element => {
        const style = getComputedStyle(element);
        const imageStyle = getComputedStyle(element.querySelector('img'));
        const rotation = transform => {
          const matrix = new DOMMatrixReadOnly(transform === 'none' ? undefined : transform);
          return Math.atan2(matrix.b, matrix.a);
        };
        return {
          rotation: rotation(style.transform), imageRotation: rotation(imageStyle.transform),
          borders: ['Top', 'Right', 'Bottom', 'Left'].map(side => parseFloat(style[`border${side}Width`])),
        };
      });
      assert.ok(Math.abs(frame.rotation) < 1e-6 && Math.abs(frame.imageRotation) < 1e-6, 'Source photos remain straight.');
      assert.deepEqual(frame.borders, [0, 0, 0, 0], 'The project photo has no decorative border.');
      await opener.locator('img').evaluate(image => image.decode());
      assert.ok(await opener.locator('img').evaluate(image => image.naturalWidth) > 200);
      await screenshot(`homerun-founder-haus-header-${width}.png`, false);
      await opener.click();
      await dialog.waitFor({ state: 'visible' });
      assert.equal(await dialog.getAttribute('aria-labelledby'), 'house-gallery-title');
      assert.equal(await dialog.locator('[data-house-photo]').count(), 3);
      assert.equal(await dialog.locator('.house-source a').getAttribute('href'), 'https://founderhaus.club/');
      for (let index = 0; index < 3; index++) {
        await page.locator(`[data-house-photo="${index}"]`).click();
        const photo = page.locator('#house-gallery-image');
        await photo.evaluate(image => image.decode());
        assert.ok(await photo.evaluate(image => image.naturalWidth) > 200);
        assert.ok((await photo.getAttribute('alt')).length > 20);
        assert.equal(await page.locator(`[data-house-photo="${index}"]`).getAttribute('aria-pressed'), 'true');
        if (width === 1440) assert.equal((await page.request.get(await photo.evaluate(image => image.currentSrc))).status(), 200);
      }
      await page.keyboard.press('ArrowRight');
      assert.equal(await page.locator('[data-house-photo="0"]').getAttribute('aria-pressed'), 'true');
      await page.locator('#house-gallery-image').evaluate(image => image.decode());
      assert.ok(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1));
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth) <= width + 1);
      await screenshot(`homerun-founder-haus-gallery-${width}.png`, false);
      await page.keyboard.press('ArrowLeft');
      assert.equal(await page.locator('[data-house-photo="2"]').getAttribute('aria-pressed'), 'true');
      await page.keyboard.press('Escape');
      await dialog.waitFor({ state: 'hidden' });
      assert.equal(await page.evaluate(() => document.activeElement.id), 'open-house-gallery');
      assert.equal(await dollars('#escrow-cash'), 369230.77);
      await opener.press('Enter');
      await dialog.waitFor({ state: 'visible' });
      await page.locator('#close-house-gallery').click();
      assert.equal(await page.evaluate(() => document.activeElement.id), 'open-house-gallery');
      await phase('earning');
      assert.equal(await dollars('#your-loan-cash'), 610.83);
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
  });
  await check('Closing the raise leaves cash in escrow and precedes the INCOME allocation', async () => {
    await open();
    await page.locator('#next-state').click();
    assert.equal(await dollars('#escrow-cash'), 615384.62);
    assert.equal(await dollars('#closing-fee'), 15384.62);
    assert.equal((await ownership('fund')).parts.operators, undefined);
    assert.equal((await ownership('income')).total, 0);
    await journeyCurrent('raising');
    assert.equal(await page.locator('[data-phase="funded"]').getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('#your-rev-tokens').count(), 0);
    assert.equal(await page.locator('#your-loan-cash').count(), 0);
  });
  await check('Refunds share remaining cash and never allocate operator FUND or INCOME', async () => {
    await open();
    await phase('refunding');
    assert.equal(await dollars('#refundable-cash'), 369230.77);
    assert.equal(await dollars('#your-refund'), 10000);
    assert.equal((await ownership('fund')).parts.operators, undefined);
    assert.equal((await ownership('income')).total, 0);
    await journeyCurrent('raising');
    assert.equal(await page.locator('[data-phase="refunding"]').getAttribute('aria-pressed'), 'true');
    const available = await dollars('#refundable-cash');
    await page.locator('#next-state').click();
    assert.equal(await dollars('#refunded-cash'), available);
    assert.equal((await ownership('fund')).total, 0);
    assert.equal((await ownership('income')).total, 0);
    assert.equal(await page.locator('#your-rev-tokens').count(), 0);
    assert.equal(await page.locator('#your-loan-cash').count(), 0);
    assert.equal(await page.locator('#next-state').isDisabled(), true);
  });
  await check('Successful purchase retains FUND and separately allocates INCOME', async () => {
    await open();
    await phase('earning');
    await journeyCurrent('earning');
    assert.equal(await page.locator('#preview-controls [data-phase]:visible').count(), 0);
    assert.match(await text('#your-fund-tokens'), /100,000,000 FUND/);
    assert.equal(await text('#your-fund-percent'), '1.3%');
    assert.match(await text('#your-rev-tokens'), /8,634\.11 INCOME/);
    assert.equal(await dollars('#cash-in-pool'), 120000);
    assert.equal(await dollars('#your-cashout'), 649.82);
    assert.equal(await dollars('#your-loan-cash'), 610.83);
    assert.equal(await dollars('#your-loan-fees'), 38.99);
    assert.equal(await dollars('#ops-reserve-cash'), 28000);
    const fundOwnership = await ownership('fund');
    const incomeOwnership = await ownership('income');
    assert.equal(fundOwnership.parts.you, 100000000);
    assert.ok(Math.abs(fundOwnership.parts.operators / fundOwnership.total - 0.2) < 1e-10);
    assert.ok(Math.abs((fundOwnership.parts.you + fundOwnership.parts.investors) / fundOwnership.total - 0.8) < 1e-10);
    assert.equal(await text('[data-ownership-chart="fund"] [data-owner="operators"] strong'), '20%');
    assert.equal(incomeOwnership.parts.pending, undefined);
    assert.equal(await page.locator('#your-pending-sticky-tokens, #your-staked-fund').count(), 0);
    assert.ok(Math.abs(incomeOwnership.parts.you - await units('#your-rev-tokens')) < 0.01);
    for (const id of ['project-details', 'rent-details', 'owner-tools']) assert.equal(await page.locator(`#${id}`).getAttribute('open'), null, `${id} starts collapsed`);
    await reveal(page.locator('#your-loan-cash'));
    assert.equal(await page.locator('#your-loan-cash').isVisible(), true);
    assert.equal(await page.locator('#your-cashout').isVisible(), true);
    await screenshot('rooftop-simple-desktop.png');
  });
  await check('Gross revenue enters INCOME and the operating reserve pays expenses first', async () => {
    await open();
    await phase('earning');
    await field('revenueMonths', 1);
    assert.equal(await dollars('#monthly-rent-in'), 10000);
    assert.equal(await dollars('#ops-rev-cash'), 0);
    assert.equal(await dollars('#ops-reserve-used'), 6000);
    assert.equal(await dollars('#cash-in-pool'), 10000);
    assert.equal(await dollars('#ops-reserve-cash'), 94000);
  });
  await check('Every FUND holder receives immediately usable INCOME without staking', async () => {
    await open();
    await phase('earning');
    await field('revenueMonths', 0);
    const atPurchase = await ownership('income');
    assert.equal(atPurchase.total, 500000);
    assert.equal(atPurchase.parts.operators, 100000);
    assert.ok(Math.abs(atPurchase.parts.you + atPurchase.parts.investors - 400000) < 0.00001);
    assert.equal(atPurchase.parts.pending, undefined);
    assert.equal(await dollars('#your-cashout'), 0);
    await field('revenueMonths', 1);
    const initial = await units('#your-premint-tokens');
    const firstReward = await units('#your-sticky-tokens');
    // $10,000 revenue creates 100,000 INCOME. Holders get 15,000; this
    // contributor owns about 1.3% of FUND after the operator's 20% mint.
    assert.equal(initial, 6500);
    assert.equal(firstReward, 195);
    assert.equal(await units('#your-rev-tokens'), 6695);
    assert.equal(await dollars('#your-cashout'), 111.58);
    assert.equal(await dollars('#your-loan-cash'), 104.88);
    assert.equal(await page.locator('#your-pending-sticky-tokens, #your-staked-fund').count(), 0);
    assert.match(await text('#staking-terms'), /automatically among all FUND holders.*available immediately/s);
    assert.equal((await ownership('income')).parts.pending, undefined);
    assert.equal(await units('#your-fund-tokens'), 100000000, 'Receiving rewards preserves the FUND holding.');
    await reveal(page.locator('#add-rent-month'));
    await page.locator('#add-rent-month').click();
    assert.equal(await units('#your-sticky-tokens'), firstReward * 2);
    assert.equal(await units('#your-rev-tokens'), 6890);
    assert.equal(await dollars('#your-loan-cash'), 185.03);
    await page.locator('#add-rent-month').click();
    assert.equal(await units('#your-sticky-tokens'), 575.25, 'Month 3 immediately adds the first reduced quarterly reward: 195 × 0.95.');
    assert.equal(await units('#your-rev-tokens'), 7075.25);
    const thirdMonth = await ownership('income');
    assert.equal(thirdMonth.parts.pending, undefined);
    assert.equal(thirdMonth.parts.unallocated, undefined);
    assert.ok(Math.abs(thirdMonth.parts.you - 7075.25) < 0.0001);
  });
  await check('Quarterly issuance cuts stop after two years and future quotes stay reactive', async () => {
    await open();
    await phase('earning');
    assert.equal(await dollars('#next-month-loan'), 642.04);
    await reveal(page.locator('#add-rent-month'));
    await page.locator('#add-rent-month').click();
    assert.equal(Number(await page.locator('#field-revenueMonths').inputValue()), 13);
    assert.equal(await dollars('#your-loan-cash'), 642.04);
    assert.equal(await dollars('#monthly-rent-in'), 10300);
    await reveal(page.locator('#operator-rev-percent'));
    assert.equal(await text('#operator-rev-percent'), '75%');
    assert.equal(await text('#rev-issuance-rate'), '8.15');
    assert.match(await text('#project-details'), /falls 5% each quarter for 2 years, then stays fixed/);
    assert.match(await text('#rev-payment-split'), /75%.*15%.*10%/s);
    assert.equal(await page.locator('#quote-month').inputValue(), '13');
    await page.locator('#quote-month').fill('12');
    assert.equal(Number(await page.locator('#field-revenueMonths').inputValue()), 12);
    assert.equal(await dollars('#your-loan-cash'), 610.83);
    for (const [month, rate, payerOutput] of [[23, '6.98', 69.83373], [24, '6.63', 66.342043], [25, '6.63', 66.342043]]) {
      await page.locator('#quote-month').fill(String(month));
      assert.equal(await text('#rev-issuance-rate'), rate);
      assert.equal(await units('#pay-output'), payerOutput, 'After eight cuts the token output stops decreasing.');
    }
    await page.locator('#quote-month').focus();
    await page.keyboard.press('ControlOrMeta+A');
    await page.keyboard.type('36', { delay: 20 });
    assert.equal(await page.locator('#quote-month').inputValue(), '36');
    assert.equal(Number(await page.locator('#field-revenueMonths').inputValue()), 36);
    await page.locator('#quote-month').fill('120');
    await page.keyboard.press('ControlOrMeta+A');
    await page.keyboard.type('240', { delay: 20 });
    assert.equal(await page.locator('#quote-month').inputValue(), '240');
    assert.equal(Number(await page.locator('#field-revenueMonths').inputValue()), 240);
    await page.keyboard.press('ArrowUp');
    assert.equal(Number(await page.locator('#field-revenueMonths').inputValue()), 241);
    await page.locator('#quote-month').fill('12');
    await page.locator('#quote-month').fill('-1');
    assert.ok((await text('#quote-month-error')).length > 0);
    assert.equal(await page.locator('#download-scenario').isDisabled(), true);
    assert.equal(await dollars('#your-loan-cash'), 610.83);
    await page.locator('#quote-month').fill('13');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'quote-month');
    await page.keyboard.press('ArrowUp');
    assert.equal(Number(await page.locator('#field-revenueMonths').inputValue()), 14);
    await page.locator('#quote-month').fill('13');
    assert.equal(Number(await page.locator('#field-revenueMonths').inputValue()), 13);
    assert.equal(await dollars('#your-loan-cash'), 642.04);
    assert.equal((await download()).inputs.revenueMonths, 13);
    await field('monthlyRent', 20000);
    assert.ok(await dollars('#your-loan-cash') > 642.04);
    assert.equal(await text('#projection-error'), '');
  });
  await check('Zero revenue leaves no INCOME loan and exhausted reserves disclose unpaid costs', async () => {
    await open();
    await phase('earning');
    await field('monthlyRent', 0);
    assert.equal(await dollars('#cash-in-pool'), 0);
    assert.equal(await dollars('#your-cashout'), 0);
    assert.equal(await dollars('#your-loan-cash'), 0);
    assert.match(await text('#loan-status'), /No cash/);
    await field('opsReserve', 0);
    assert.equal(await dollars('#ops-reserve-cash'), 0);
    assert.equal(await dollars('#ops-shortfall'), 72000);
  });
  await check('Reserve stress shows the full horizon and stays open while assumptions change', async () => {
    await open();
    await phase('earning');
    await reveal(page.locator('#reserve-stress > summary'));
    assert.equal(await text('#reserve-horizon'), '120');
    assert.match(await text('#reserve-stress tbody tr:first-child'), /\$0No unpaid costs/);
    assert.equal(await page.locator('#reserve-stress tbody tr').count(), 4);
    await field('opsReserve', 1000);
    assert.notEqual(await page.locator('#reserve-stress').getAttribute('open'), null);
    assert.match(await text('#reserve-stress tbody tr:first-child'), /Unpaid costs from month 1/);
  });
  await check('An asset sale pays FUND while preserving the separate INCOME pool', async () => {
    await open();
    await phase('earning');
    const revCash = await dollars('#cash-in-pool');
    const loan = await dollars('#your-loan-cash');
    assert.equal(await page.locator('#sale-scenario').isHidden(), true);
    await phase('liquidated');
    assert.equal(await page.locator('#sale-scenario').isVisible(), true);
    assert.equal(await page.locator('#sale-scenario #field-salePrice').isVisible(), true);
    assert.equal(await page.locator('#projection-form #field-salePrice').count(), 0);
    await screenshot('homerun-sold-desktop.png');
    assert.equal(await dollars('#fund-sale-cash'), 503000);
    assert.equal(await dollars('#your-fund-sale'), 6538.99);
    assert.equal(await dollars('#combined-cashout'), 7188.81);
    assert.match(await text('#combined-difference'), /below.*before fees/i);
    assert.equal(await dollars('#cash-in-pool'), revCash);
    assert.equal(await dollars('#your-loan-cash'), loan);
    assert.equal(await page.locator('#add-rent-month').count(), 0);
    await journeyCurrent('liquidated');
    await field('salePrice', 600000);
    assert.equal(await dollars('#fund-sale-cash'), 598000);
    await field('salePrice', 500000);
    assert.equal(await dollars('#fund-sale-cash'), 503000);
    assert.equal(await dollars('#cash-in-pool'), revCash);
  });
  await check('Owner closing drafts report blockers and never advance without an explicit preview', async () => {
    await open();
    await ownerAction('close_raise');
    assert.equal(await page.locator('#draft-blocked').isVisible(), true);
    assert.equal(await page.locator('#preview-owner-state').isDisabled(), true);
    const blocked = await download('#download-owner-draft');
    assert.equal(blocked.executable, false);
    assert.equal(blocked.eligible, false);
    await page.keyboard.press('Escape');
    await field('raisedPercent', 100);
    await ownerAction('close_raise');
    const draft = await download('#download-owner-draft');
    assert.equal(draft.executable, false);
    assert.equal(draft.eligible, true);
    assert.equal(draft.toPhase, 'funded');
    assert.equal(await page.locator('[data-phase="raising"]').getAttribute('aria-pressed'), 'true');
    await page.locator('#preview-owner-state').click();
    assert.equal(await page.locator('[data-phase="funded"]').getAttribute('aria-pressed'), 'true');
  });
  await check('The purchase draft preserves FUND and reviews the one separate INCOME allocation', async () => {
    await open();
    await phase('funded');
    await ownerAction('complete_purchase');
    const draft = await download('#download-owner-draft');
    assert.equal(draft.executable, false);
    assert.equal(draft.eligible, true);
    assert.equal(draft.changes.revenueAllocation.fundTokensBurned, 0);
    assert.equal(draft.changes.revenueAllocation.totalRevenuePremint, 500000);
    assert.equal(draft.changes.operatorPostMintPercent, 20);
    assert.equal(draft.changes.revenueAllocation.operatorShareOfPremintPercent, 20);
    assert.equal(draft.changes.revenueAllocation.repeatAllocationAllowed, false);
    assert.equal(draft.changes.fundSticky, undefined);
    assert.equal(draft.changes.fundHolderRewards.mode, 'automatic_fund_holders');
    assert.equal(draft.changes.fundHolderRewards.implementationStatus, 'unimplemented_specification');
    assert.equal(draft.changes.fundHolderRewards.requiresStaking, false);
    assert.equal(draft.changes.fundHolderRewards.createsCustodyProject, false);
    assert.equal(draft.changes.fundHolderRewards.modeledVestingMonths, 0);
    assert.equal(draft.changes.fundHolderRewards.integration.distributor, null);
    assert.equal(draft.changes.fundHolderRewards.integration.existingStickyRouteSupportsThis, false);
    assert.equal(draft.changes.revenuePolicy.stages[0].totalReservedTokenPercent, 90);
    assert.equal(draft.changes.revenuePolicy.issuanceCutMonths, 3);
    assert.equal(draft.changes.revenuePolicy.numberOfIssuanceCuts, 8);
    assert.equal(draft.changes.revenuePolicy.stages.length, 9);
    assert.ok(draft.steps.some(step => step.id === 'specify_holder_distribution'));
    assert.ok(draft.steps.some(step => step.id === 'configure_holder_reward_route'));
    assert.ok(draft.steps.every(step => !/sticky/i.test(step.id)));
    assert.match(await text('#owner-dialog-content'), /automatic pro-rata delivery to current FUND holders/i);
    assert.ok(draft.steps.length > 3);
    await page.locator('#preview-owner-state').click();
    assert.match(await text('#your-fund-tokens'), /100,000,000 FUND/);
    assert.match(await text('#your-rev-tokens'), /8,634\.11 INCOME/);
  });
  await check('Refund and sale owner drafts remain reviewable, non-executable state previews', async () => {
    await open();
    await ownerAction('enable_refunds');
    const refund = await download('#download-owner-draft');
    assert.equal(refund.executable, false);
    assert.equal(refund.changes.operatorFundMint, 0);
    assert.equal(refund.changes.revenuePremint, 0);
    await page.locator('#preview-owner-state').click();
    assert.equal(await page.locator('[data-phase="refunding"]').getAttribute('aria-pressed'), 'true');
    await phase('earning');
    await ownerAction('enable_sale_redemptions');
    const sale = await download('#download-owner-draft');
    assert.equal(sale.executable, false);
    assert.equal(sale.changes.saleDeposit.mintsFund, false);
    await page.locator('#preview-owner-state').click();
    assert.equal(await dollars('#fund-sale-cash'), 503000);
  });
  await check('Invalid assumptions remove quotes and recovering or resetting restores the scenario', async () => {
    await open();
    await field('purchaseBudget', -1);
    assert.ok((await text('#projection-error')).length > 0);
    assert.equal(await page.locator('#next-state').isDisabled(), true);
    assert.equal(await page.locator('#download-scenario').isDisabled(), true);
    assert.equal(await page.locator('#escrow-cash').count(), 0);
    await field('purchaseBudget', 600000);
    assert.ok(await dollars('#raise-goal') > 615384.62);
    await phase('earning');
    await page.locator('#reset-example').click();
    assert.equal(await dollars('#raise-goal'), 615384.62);
    assert.equal(Number(await page.locator('#field-revenueMonths').inputValue()), 12);
    await journeyCurrent('raising');
  });
  await check('Scenario downloads contain the distinct holdings and edited assumptions', async () => {
    await open();
    await phase('earning');
    const projectCash = await dollars('#cash-in-pool');
    await field('investment', -1);
    assert.ok((await text('#contribution-error')).length > 0);
    assert.equal(await text('#projection-error'), '');
    assert.equal(await dollars('#cash-in-pool'), projectCash);
    assert.equal(await page.locator('#your-loan-cash').count(), 0);
    await field('investment', 20000);
    assert.equal(await page.locator('#field-investment').isHidden(), true);
    await journeyCurrent('earning');
    assert.equal(await text('#contribution-error'), '');
    const result = await download();
    assert.equal(result.product, 'Homerun');
    assert.equal(result.asset, 'Founder Haus');
    assert.equal(result.architecture, 'FH-FUND and FH-INCOME');
    assert.equal(result.phase, 'earning');
    assert.equal(result.inputs.investment, 20000);
    assert.equal(result.projection.revenuePremint, 500000);
    assert.equal(result.projection.operatorFundPercent, 20);
    assert.equal(result.projection.stickySplitPercent, 15);
    assert.equal(result.projection.personalFundTokens, 200000000);
    assert.ok(result.projection.personalRevTokens > 17000);
    assert.equal(result.illustrative, true);
    assert.equal(result.liveOffering, false);
    await phase('raising');
    await field('raisedPercent', 1);
    assert.equal(await dollars('#escrow-cash'), 6153.85);
    assert.ok((await text('#contribution-error')).length > 0);
    assert.equal(await text('#projection-error'), '');
    assert.equal(await page.locator('#your-fund-cashout').count(), 0);
    await field('investment', 1000);
    assert.equal(await text('#contribution-error'), '');
    assert.ok(await dollars('#your-fund-cashout') > 0);
  });
  await check('Field explanations support hover, keyboard focus and dismissal', async () => {
    await open();
    assert.match(await text('label[for="field-raisedPercent"]'), /Fundraising progress/i);
    assert.match(await text('#help-raisedPercent'), /60%.*369,230.77.*615,384.62/s);
    await field('raisedPercent', 50);
    assert.match(await text('#help-raisedPercent'), /50%.*307,692.31.*615,384.62/s);
    await page.locator('h1').click();
    for (const input of await page.locator('[data-input]:not(#field-investment)').all()) {
      const key = await input.getAttribute('data-input');
      assert.ok((await input.getAttribute('aria-describedby') || '').split(/\s+/).includes(`help-${key}`));
      assert.equal(await page.locator(`#help-${key}`).getAttribute('role'), 'tooltip');
      assert.ok((await text(`#help-${key}`)).length > 15);
    }
    const container = page.locator('.projection-field').filter({ has: page.locator('#field-purchaseBudget') });
    const help = container.locator('button.field-help');
    const tooltip = page.locator('#help-purchaseBudget');
    assert.equal(await help.getAttribute('aria-controls'), 'help-purchaseBudget');
    await container.hover();
    await tooltip.waitFor({ state: 'visible' });
    await screenshot('rooftop-help-desktop.png');
    await page.keyboard.press('Escape');
    assert.equal(await tooltip.isHidden(), true);
    await page.mouse.move(0, 0);
    await help.focus();
    await tooltip.waitFor({ state: 'visible' });
    await page.keyboard.press('Escape');
    assert.equal(await tooltip.isHidden(), true);
    await page.locator('h1').click();
    await container.hover();
    await tooltip.waitFor({ state: 'visible' });
    await page.locator('h1').click();
    assert.equal(await tooltip.isHidden(), true);
  });
  await check('Charts explain the budget and inspect monthly cash and borrowing without changing the scenario', async () => {
    await open();
    const budget = page.locator('[data-projection-chart="budget"]');
    assert.equal(await budget.isVisible(), true);
    await budget.locator('button[data-budget-part="0"]').focus();
    assert.match((await budget.locator('.pc-tooltip').textContent()).trim(), /\$500,000.*81.2%/s);
    assert.equal(await budget.locator('.pc-tooltip').isVisible(), true);
    await page.keyboard.press('Escape');
    assert.equal(await budget.locator('.pc-tooltip').isHidden(), true);
    assert.equal(await page.locator('[data-chart-kind="loan"]').count(), 0);
    await phase('earning');
    const cash = page.locator('[data-chart-kind="cash"]');
    const loan = page.locator('[data-chart-kind="loan"]');
    const slider = cash.locator('[data-chart-month]');
    await slider.focus();
    assert.equal(await slider.getAttribute('max'), '12');
    assert.match(await slider.getAttribute('aria-valuetext'), /Month 12.*120,000.*28,000/s);
    await page.keyboard.press('Home');
    assert.equal(await slider.inputValue(), '0');
    assert.equal(await dollars('[data-chart-kind="cash"] [data-chart-tooltip-value="0"]'), 0);
    assert.equal(await dollars('[data-chart-kind="cash"] [data-chart-tooltip-value="1"]'), 100000);
    await page.keyboard.press('ArrowRight');
    assert.equal(await slider.inputValue(), '1');
    assert.equal(await dollars('[data-chart-kind="cash"] [data-chart-tooltip-value="0"]'), 10000);
    assert.equal(await dollars('#cash-in-pool'), 120000);
    assert.equal(Number(await page.locator('#field-revenueMonths').inputValue()), 12);
    await reveal(loan.locator('[data-chart-month]'));
    await loan.locator('[data-chart-month]').focus();
    await page.keyboard.press('End');
    assert.equal(await dollars('[data-chart-kind="loan"] [data-chart-tooltip-value="0"]'), await dollars('#your-loan-cash'));
    await field('revenueMonths', 13);
    assert.equal(await loan.locator('[data-chart-month]').getAttribute('max'), '13');
    assert.equal(await dollars('[data-chart-kind="loan"] [data-chart-tooltip-value="0"]'), 642.04);
    await field('monthlyRent', 20000);
    assert.equal(await dollars('[data-chart-kind="loan"] [data-chart-tooltip-value="0"]'), await dollars('#your-loan-cash'));
    assert.ok(await dollars('#your-loan-cash') > 642.04);
  });
  await check('Touch field help stays within a 320px viewport and dismisses outside', async () => {
    const touchContext = await browser.newContext({ viewport: { width: 320, height: 640 }, hasTouch: true, isMobile: true, reducedMotion: 'reduce' });
    try {
      const touchPage = await touchContext.newPage();
      touchPage.on('pageerror', error => errors.push(error.message));
      touchPage.on('console', message => { if (message.type() === 'error') errors.push(`${message.text()} ${message.location().url || ''}`.trim()); });
      touchPage.on('response', response => { if (response.status() >= 400) errors.push(`HTTP ${response.status()} ${response.url()}`); });
      await touchPage.goto(demoURL);
      await touchPage.locator('#scenario-title').waitFor();
      const help = touchPage.locator('.projection-field').filter({ has: touchPage.locator('#field-purchaseBudget') }).locator('button.field-help');
      const tooltip = touchPage.locator('#help-purchaseBudget');
      await help.tap();
      await tooltip.waitFor({ state: 'visible' });
      const box = await tooltip.boundingBox();
      assert.ok(box.x >= 0 && box.x + box.width <= 321, 'Touch help must stay within viewport width.');
      assert.ok(box.y >= 0 && box.y + box.height <= 641, 'Touch help must stay within viewport height.');
      if (process.env.BROWSER_SCREENSHOT_DIR) {
        await mkdir(process.env.BROWSER_SCREENSHOT_DIR, { recursive: true });
        await touchPage.screenshot({ path: join(process.env.BROWSER_SCREENSHOT_DIR, 'rooftop-help-touch320.png') });
      }
      await touchPage.locator('#scenario-title').tap();
      assert.equal(await tooltip.isHidden(), true, 'Tapping outside must dismiss the field help.');
      assert.ok(await touchPage.evaluate(() => document.documentElement.scrollWidth) <= 321);
      await touchPage.locator('button[data-journey-phase="earning"]').tap();
      const plot = touchPage.locator('[data-chart-kind="loan"] [data-chart-plot]');
      await reveal(plot);
      await plot.tap();
      const chartTooltip = touchPage.locator('[data-chart-kind="loan"] .pc-tooltip');
      assert.equal(await chartTooltip.isVisible(), true, 'Tapping a chart must reveal its selected month.');
      const chartBox = await chartTooltip.boundingBox();
      assert.ok(chartBox.x >= 0 && chartBox.x + chartBox.width <= 321, 'Chart inspection must fit a touch viewport.');
      assert.ok(await touchPage.evaluate(() => document.documentElement.scrollWidth) <= 321);
    } finally { await touchContext.close(); }
  });
  await check('Keyboard selection and old links reach the one-page network', async () => {
    await open();
    await page.locator('button[data-journey-phase="earning"]').focus();
    await page.keyboard.press('Enter');
    assert.equal(await dollars('#your-loan-cash'), 610.83);
    for (const hash of ['story', 'numbers', 'underwrite', 'mechanism', 'playbook', 'cashout-lab', 'paid_off']) {
      await open(hash);
      assert.equal(await page.locator('#projection-form').isVisible(), true);
      assert.equal(await page.locator('[data-phase="paid_off"]').count(), 0);
    }
  });
  await check('All phases, expanded terms and owner drafts fit mobile screens', async () => {
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      await open();
      await headerAlignment();
      for (const name of phases) {
        await phase(name);
        assert.equal(await page.locator('#raise-input').isVisible(), ['raising', 'refunding', 'refunded'].includes(name));
        assert.equal(await page.locator('#revenue-input').isVisible(), ['earning', 'liquidated'].includes(name));
        assert.equal(await page.locator('#sale-scenario').isVisible(), name === 'liquidated');
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth) <= width + 1, `${name} overflows ${width}px`);
        for (const button of await page.locator('button[data-journey-phase], [data-phase]:visible').all()) {
          const box = await button.boundingBox();
          assert.ok(box.x >= 0 && box.x + box.width <= width + 1);
        }
        if (name === 'liquidated') await screenshot(`homerun-sold-mobile${width}.png`);
        if (name === 'raising') await screenshot(`rooftop-simple-raising-mobile${width}.png`);
        if (name === 'earning') {
          await reveal(page.locator('#your-loan-cash'));
          assert.equal(await page.locator('#your-loan-cash').isVisible(), true);
          await screenshot(`rooftop-simple-mobile${width}.png`);
          for (const id of ['your-premint-tokens', 'your-sticky-tokens', 'your-sticky-share']) {
            await reveal(page.locator(`#${id}`));
            assert.equal(await page.locator(`#${id}`).isVisible(), true, id);
          }
          await singleLine('#cash-in-pool');
          await reveal(page.locator('#monthly-rent-in'));
          for (const id of ['monthly-rent-in', 'ops-rev-cash', 'ops-reserve-used']) await singleLine(`#${id}`);
          await reveal(page.locator('#your-loan-principal'));
          assert.ok(await page.evaluate(() => document.documentElement.scrollWidth) <= width + 1, `Expanded details overflow ${width}px`);
        }
      }
      await phase('earning');
      await field('monthlyRent', 12000);
      assert.ok(await dollars('#your-loan-cash') > 610.83);
      await ownerAction('enable_sale_redemptions');
      assert.ok(await page.locator('#owner-dialog').evaluate(element => element.scrollWidth <= element.clientWidth + 1));
      await page.locator('#close-owner-dialog').click();
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth) <= width + 1);
    }
  });
  await check('The three-base journey, Pay panel and redemption dialogs fit desktop and mobile', async () => {
    for (const width of [1440, 1024, 900, 390, 320]) {
      await page.setViewportSize({ width, height: width >= 900 ? 1000 : 844 });
      await open();
      for (const name of ['raising', 'earning', 'refunding', 'liquidated']) {
        await phase(name);
        await page.evaluate(() => window.scrollTo(0, 0));
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth) <= width + 1, `${name} project page overflows ${width}px.`);
        for (const target of ['#project-journey', '#pay-panel']) {
          const box = await page.locator(target).boundingBox();
          assert.ok(box.width > 0 && box.x >= 0 && box.x + box.width <= width + 1, `${target} fits ${width}px.`);
        }
        if (width >= 900) {
          const title = await page.locator('h1').boundingBox();
          const journey = await page.locator('#project-journey').boundingBox();
          const photo = await page.locator('#open-house-gallery').boundingBox();
          assert.ok(title.x + title.width <= journey.x + 1, `The journey follows the title at ${width}px.`);
          assert.ok(journey.x + journey.width <= photo.x + 1, `The journey precedes the photo at ${width}px.`);
        }
        await screenshot(`homerun-project-${width}-${name}.png`, false);
        if (name === 'earning') {
          for (const detail of ['allocation', 'liquidity']) {
            const section = page.locator(`[data-income-payment-details="${detail}"]`);
            await section.locator(':scope > summary').click();
            await section.evaluate(element => element.scrollIntoView({ block: 'start' }));
            assert.ok(await page.evaluate(() => document.documentElement.scrollWidth) <= width + 1, `Expanded INCOME ${detail} overflows ${width}px.`);
            await screenshot(`homerun-project-${width}-income-${detail}.png`, false);
          }
        }
        if (width === 390 && name === 'earning') {
          for (const chart of ['cash', 'loan']) {
            await reveal(page.locator(`[data-chart-kind="${chart}"]`));
            await page.locator(`[data-chart-kind="${chart}"]`).scrollIntoViewIfNeeded();
            await screenshot(`homerun-project-390-earning-${chart}-chart.png`, false);
          }
        }
        await page.locator('#pay-review').click();
        const dialog = page.locator('#pay-dialog');
        await dialog.waitFor({ state: 'visible' });
        const box = await dialog.boundingBox();
        assert.ok(box.x >= 0 && box.x + box.width <= width + 1, `Payment dialog fits ${width}px.`);
        assert.ok(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1), `Payment dialog contents fit ${width}px.`);
        await screenshot(`homerun-project-${width}-${name}-review.png`, false);
        await page.keyboard.press('Escape');
        await page.waitForFunction(() => document.activeElement?.id === 'pay-review');
      }
    }
  });
  await check('No JavaScript, console or resource errors occurred', async () => assert.deepEqual(errors, []));
} finally { await browser.close(); }
process.stdout.write(`\n${checks - failures.length}/${checks} browser checks passed.\n`);
if (failures.length) process.exitCode = 1;
