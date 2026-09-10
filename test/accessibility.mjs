/** Automated WCAG 2 A/AA checks. Start npm run dev, then npm run test:a11y.
 * Uses workspace Playwright/axe and macOS Chrome. Overrides: BASE_URL,
 * PLAYWRIGHT_MODULE, AXE_MODULE, CHROME_PATH. Reduced motion avoids transient
 * animation contrast. These checks do not replace manual accessibility review.
 */
import { pathToFileURL } from 'node:url';
const moduleURL = (override, fallback) => override ? pathToFileURL(override) : new URL(fallback, import.meta.url);
const { chromium } = await import(moduleURL(process.env.PLAYWRIGHT_MODULE, '../../../webclients/juicescan/node_modules/playwright/index.mjs').href);
const { default: AxeBuilder } = await import(moduleURL(process.env.AXE_MODULE, '../../../webclients/juicescan/node_modules/@axe-core/playwright/dist/index.mjs').href);
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
const page = await context.newPage();
const demoURL = new URL('/founderhause', process.env.BASE_URL || 'http://127.0.0.1:3010/').href;
const homeURL = new URL('/', demoURL).href;
let violations = 0;
let checks = 0;
async function phase(value) {
  if (['earning', 'liquidated'].includes(value)) {
    await page.locator(`button[data-journey-phase="${value}"]`).click();
  } else {
    if (await page.locator(`[data-phase="${value}"]`).isHidden()) {
      await page.locator('button[data-journey-phase="raising"]').click();
    }
    await page.locator(`[data-phase="${value}"]`).click();
  }
}
async function reveal(locator) {
  if (await locator.locator('xpath=ancestor::*[@id="assumptions-body"]').count() && await page.locator('#assumptions-body').isHidden()) await page.locator('#toggle-assumptions').click();
  const ancestors = locator.locator('xpath=ancestor::details');
  for (let index = 0; index < await ancestors.count(); index++) {
    const details = ancestors.nth(index);
    if (await details.getAttribute('open') === null) await details.locator(':scope > summary').click();
  }
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
  await page.goto(homeURL);
  await page.locator('#ballpark').waitFor();
  await analyze('homepage');
  await page.setViewportSize({ width: 320, height: 844 });
  await analyze('mobile homepage');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(demoURL);
  await page.locator('#scenario-title').waitFor();
  await page.locator('#open-house-gallery').click();
  await page.locator('#house-gallery-image').evaluate(image => image.decode());
  await analyze('Founder Haus photo gallery');
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 320, height: 844 });
  await page.locator('#open-house-gallery').click();
  await analyze('mobile Founder Haus photo gallery');
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 1440, height: 1000 });
  for (const value of ['raising', 'funded', 'refunding', 'refunded', 'earning', 'liquidated']) {
    await phase(value);
    await analyze(value);
  }
  for (const value of ['raising', 'earning', 'refunding', 'liquidated']) {
    await phase(value);
    await page.locator('#pay-review').click();
    await page.locator('#pay-dialog').waitFor({ state: 'visible' });
    await analyze(`payment review: ${value}`);
    await page.keyboard.press('Escape');
  }
  await phase('earning');
  await reveal(page.locator('[data-income-payment-value="payer-tokens"]'));
  await reveal(page.locator('[data-income-payment-value="cashout"]'));
  await analyze('expanded independent INCOME ownership and liquidity');
  await page.locator('#pay-amount').fill('250');
  await analyze('reactive independent INCOME payment details');
  await page.locator('#pay-amount').fill('1.001');
  await analyze('invalid independent INCOME payment amount');
  await page.locator('#pay-amount').fill('100');
  await phase('liquidated');
  await reveal(page.locator('[data-chart-kind="loan"] [data-chart-month]'));
  await page.locator('[data-chart-kind="loan"] [data-chart-month]').focus();
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
  await reveal(page.locator('#your-loan-principal'));
  await reveal(page.locator('#operator-rev-percent'));
  await reveal(page.locator('#reserve-stress > summary'));
  await reveal(page.locator('#staking-terms > summary'));
  await analyze('expanded token and loan terms');
  await reveal(page.locator('#field-rentGrowthPercent'));
  await analyze('expanded growth assumptions');
  await page.locator('#field-revenueMonths').fill('1');
  await analyze('immediate automatic FUND-holder rewards');
  await page.locator('#quote-month').fill('-1');
  await analyze('invalid quote month');
  await page.locator('#reset-example').click();
  for (const [value, action] of [['raising', 'close_raise'], ['raising', 'enable_refunds'], ['funded', 'complete_purchase'], ['earning', 'enable_sale_redemptions']]) {
    await phase(value);
    await reveal(page.locator(`[data-owner-action="${action}"]`));
    await page.locator(`[data-owner-action="${action}"]`).click();
    await analyze(`owner draft: ${action}`);
    await page.locator('#close-owner-dialog').click();
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await phase('earning');
  await reveal(page.locator('#your-loan-principal'));
  await analyze('mobile earning with loan terms');
  await page.locator('#pay-amount').focus();
  await analyze('mobile independent INCOME payment input');
  await page.keyboard.press('Escape');
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    for (const value of ['raising', 'earning', 'refunding', 'liquidated']) {
      await phase(value);
      await page.locator('button[data-journey-phase][aria-pressed="true"]').focus();
      await analyze(`${width}px journey and ${value} payment panel`);
      await page.locator('#pay-review').click();
      await page.locator('#pay-dialog').waitFor({ state: 'visible' });
      await analyze(`${width}px payment review: ${value}`);
      await page.keyboard.press('Escape');
      if (value === 'earning') {
        await reveal(page.locator('[data-income-payment-value="payer-tokens"]'));
        await reveal(page.locator('[data-income-payment-value="cashout"]'));
        await analyze(`${width}px expanded INCOME payment details`);
      }
    }
  }
} finally { await browser.close(); }
process.stdout.write(`\n${checks} accessibility states checked; ${violations} automated WCAG 2 A/AA violations.\n`);
if (violations) process.exitCode = 1;
