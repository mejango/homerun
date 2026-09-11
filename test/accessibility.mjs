/** Automated WCAG 2 A/AA checks. Start npm run dev, then npm run test:a11y.
 * Uses installed Playwright/axe and Chrome. Overrides: BASE_URL,
 * PLAYWRIGHT_MODULE, AXE_MODULE, CHROME_PATH. A11Y_SCOPE=project skips homepage checks.
 * Reduced motion avoids transient
 * animation contrast. These checks do not replace manual accessibility review.
 */
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { expect } from '@playwright/test';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : '@playwright/test');
const { default: AxeBuilder } = await import(process.env.AXE_MODULE ? pathToFileURL(process.env.AXE_MODULE).href : '@axe-core/playwright');
const systemChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const executablePath = process.env.CHROME_PATH || (existsSync(systemChrome) ? systemChrome : undefined);
const browser = await chromium.launch({ ...(executablePath ? { executablePath } : {}), headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
const page = await context.newPage();
page.setDefaultTimeout(15_000);
page.setDefaultNavigationTimeout(120_000);
const demoURL = new URL('/founderhaus', process.env.BASE_URL || 'http://localhost:3010/').href;
const homeURL = new URL('/', demoURL).href;
const ownerActions = [['raising', 'enable_refunds'], ['funded', 'complete_purchase'], ['earning', 'enable_sale_redemptions']];
let violations = 0;
let checks = 0;
async function tab(name) {
  if (['Extras', 'Operators'].includes(name)) {
    const more = page.getByRole('button', { name: /^More project sections/ });
    if (await more.getAttribute('aria-expanded') !== 'true') await more.click();
    await page.getByRole('tab', { name, exact: true }).click();
    await expect(more).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('.homerun-project-layout')).toHaveAttribute('data-project-tab', name.toLowerCase());
    await expect(page.getByRole('tabpanel', { name, exact: true })).toBeVisible();
    return;
  }
  const trigger = page.getByRole('tab', { name, exact: true });
  await trigger.click();
  await expect(trigger).toHaveAttribute('aria-selected', 'true');
}
async function owners(account = 'You') {
  await tab('Owners');
  await tab('Accounts');
  await expect(page.locator('[data-account-section=you]')).toBeVisible();
  await expect(page.locator('[data-account-section=all]')).toBeVisible();
  await page.locator(`[data-account-section="${account.toLowerCase()}"]`).scrollIntoViewIfNeeded();
}
async function phase(value) {
  await tab('Stages');
  const stage = ['earning', 'liquidated'].includes(value) ? value : 'raising';
  await page.locator(`.preview-base-buttons button[data-journey-phase="${stage}"]`).click();
  if (stage === 'raising') await page.locator(`[data-phase="${value}"]`).click();
  await expect(page.locator('#project-journey')).toHaveAttribute('data-journey-phase', value);
}
async function closeDialog(id) {
  await page.keyboard.press('Escape');
  await expect(page.locator(id)).toHaveCount(0);
}
async function reveal(selector) {
  if (/enable_refunds|data-raise-actions/.test(selector)) await tab('Stages');
  else if (/data-owner-action|#owner-tools/.test(selector)) await tab('Operators');
  else if (/your-|quote-month|data-chart-kind.*loan/.test(selector)) await owners();
  else if (/field-|reserve-stress|fund-total-supply/.test(selector)) await tab('Stages');
  const locator = page.locator(selector);
  await expect(locator).toHaveCount(1);
  const actionGroup = locator.locator('xpath=ancestor::*[@data-action-section][1]');
  if (await actionGroup.count() && await locator.isHidden()) {
    const more = actionGroup.getByRole('button', { name: /^More actions/ });
    if (await more.count() && await more.getAttribute('aria-expanded') !== 'true') await more.click();
  }
  if (await locator.locator('xpath=ancestor::*[@id="assumptions-body"]').count() && await page.locator('#assumptions-body').isHidden()) await page.locator('#toggle-assumptions').click();
  const ancestors = locator.locator('xpath=ancestor::details');
  for (let index = 0; index < await ancestors.count(); index++) {
    const details = ancestors.nth(index);
    if (await details.getAttribute('open') === null) await details.locator(':scope > summary').click();
  }
  await expect(locator).toBeVisible();
}
async function analyze(label) {
  checks++;
  await page.evaluate(() => document.fonts.ready);
  const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  violations += result.violations.length;
  process.stdout.write(`${result.violations.length ? 'FAIL' : 'PASS'} ${label}: ${result.violations.length} automated WCAG 2 A/AA violations\n`);
  for (const violation of result.violations) process.stdout.write(JSON.stringify({ rule: violation.id, impact: violation.impact, nodes: violation.nodes.map(node => ({ selectors: node.target, summary: node.failureSummary })) }, null, 2) + '\n');
}
try {
  if (process.env.A11Y_SCOPE !== 'project') {
    await page.goto(homeURL);
    await page.locator('#ballpark[data-ready="true"][data-motion="reduced"]').waitFor();
    await analyze('homepage');
    await page.setViewportSize({ width: 320, height: 844 });
    await analyze('mobile homepage');
    await page.setViewportSize({ width: 1440, height: 1000 });
  }
  await page.goto(demoURL, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.simulator')).toHaveAttribute('data-ready', 'true', { timeout: 120_000 });
  await page.getByRole('heading', { name: 'About', exact: true }).waitFor();
  await page.locator('#open-house-gallery').click();
  await page.locator('#house-gallery-image').evaluate(image => image.decode());
  await analyze('Founder Haus photo gallery');
  await closeDialog('#house-gallery');
  await page.setViewportSize({ width: 320, height: 844 });
  await page.locator('#open-house-gallery').click();
  await analyze('mobile Founder Haus photo gallery');
  await closeDialog('#house-gallery');
  await page.setViewportSize({ width: 1440, height: 1000 });
  for (const section of ['Overview', 'Stages', 'Owners', 'Shop', 'Extras', 'Operators']) {
    await tab(section);
    await analyze(`project tab: ${section}`);
  }
  await owners();
  for (const section of ['Accounts', 'Market', 'Settlement', 'Splits', 'Loans']) {
    await tab(section);
    await analyze(`Owners: ${section}`);
  }
  await owners('All');
  await analyze('Owners: Accounts All');
  await owners();
  for (const value of ['raising', 'funded', 'refunding', 'refunded', 'earning', 'liquidated']) {
    await phase(value);
    await analyze(value);
  }
  for (const value of ['raising', 'earning']) {
    await phase(value);
    await expect(page.locator('.demo-payment-result svg[role=img]')).toBeVisible();
    await analyze(`inline payment result: ${value}`);
  }
  for (const value of ['refunding', 'liquidated']) {
    await phase(value);
    await page.locator('#pay-review').click();
    await page.locator('#pay-dialog').waitFor({ state: 'visible' });
    await analyze(`payment review: ${value}`);
    await closeDialog('#pay-dialog');
  }
  await phase('earning');
  await expect(page.locator('.demo-payment-result')).toBeVisible();
  await analyze('independent INCOME ownership and liquidity');
  await page.locator('#pay-amount').fill('250');
  await analyze('reactive independent INCOME payment details');
  await page.locator('#pay-amount').fill('1.001');
  await analyze('invalid independent INCOME payment amount');
  await page.locator('#pay-amount').fill('100');
  await phase('liquidated');
  await reveal('#fund-position-preview [data-chart-kind="loan"] [data-chart-month]');
  await page.locator('#fund-position-preview [data-chart-kind="loan"] [data-chart-month]').focus();
  await analyze('keyboard chart inspection');
  await phase('raising');
  await page.locator('[data-projection-chart="budget"] button[data-budget-part="0"]').focus();
  await analyze('budget explanation');
  await page.keyboard.press('Escape');
  await page.locator('.projection-field').filter({ has: page.locator('#field-purchaseBudget') }).hover();
  await page.locator('#help-purchaseBudget').waitFor({ state: 'visible' });
  await analyze('field explanation');
  await page.keyboard.press('Escape');
  await page.locator('#field-purchaseBudget').fill('-1');
  await analyze('invalid inputs');
  await page.locator('#reset-example').click();
  await phase('earning');
  await reveal('#your-loan-principal');
  await analyze('expanded owner loan terms');
  await reveal('#phase-panel #fund-total-supply');
  await reveal('#reserve-stress table');
  await analyze('expanded token and loan terms');
  await reveal('#field-rentGrowthPercent');
  await analyze('expanded growth assumptions');
  await page.locator('#field-revenueMonths').fill('1');
  await reveal('#your-sticky-tokens');
  await analyze('fully eligible Sticky reward projection');
  await reveal('#quote-month');
  await page.locator('#quote-month').fill('-1');
  await expect(page.locator('#quote-month')).toHaveAttribute('min', '0');
  await analyze('bounded quote month input');
  await page.locator('#reset-example').click();
  for (const [value, action] of ownerActions) {
    await phase(value);
    await reveal(`[data-owner-action="${action}"]`);
    await page.locator(`[data-owner-action="${action}"]`).click();
    await analyze(`owner draft: ${action}`);
    await closeDialog('#owner-dialog');
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await phase('earning');
  await reveal('#your-loan-principal');
  await analyze('mobile earning with loan terms');
  await page.locator('#pay-amount').focus();
  await analyze('mobile independent INCOME payment input');
  await page.keyboard.press('Escape');
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    for (const value of ['raising', 'funded', 'refunding', 'refunded', 'earning', 'liquidated']) {
      await phase(value);
      await page.locator('.preview-base-buttons button[data-journey-phase][aria-pressed="true"]').focus();
      await analyze(`${width}px journey and ${value} payment panel`);
      if (['funded', 'refunded'].includes(value)) {
        await expect(page.locator('#pay-review')).toBeDisabled();
        continue;
      }
      if (['raising', 'earning'].includes(value)) {
        await expect(page.locator('.demo-payment-result svg[role=img]')).toBeVisible();
        await analyze(`${width}px inline payment result: ${value}`);
        continue;
      }
      await page.locator('#pay-review').click();
      await page.locator('#pay-dialog').waitFor({ state: 'visible' });
      await analyze(`${width}px payment review: ${value}`);
      await closeDialog('#pay-dialog');
    }
    for (const [value, action] of ownerActions) {
      await phase(value);
      const trigger = page.locator(`[data-owner-action="${action}"]`);
      await reveal(`[data-owner-action="${action}"]`);
      await trigger.click();
      await expect(page.locator('#owner-dialog[open]')).toBeVisible();
      await analyze(`${width}px owner draft: ${action}`);
      await closeDialog('#owner-dialog');
      await expect(trigger).toBeFocused();
    }
  }
} finally { await browser.close(); }
process.stdout.write(`\n${checks} accessibility states checked; ${violations} automated WCAG 2 A/AA violations.\n`);
if (violations) process.exitCode = 1;
