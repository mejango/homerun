/** Create-flow browser checks. Start npm run dev first. Uses workspace Playwright/axe and Chrome. */
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const moduleURL = (override, fallback) => override ? pathToFileURL(override) : new URL(fallback, import.meta.url);
const { chromium } = await import(moduleURL(process.env.PLAYWRIGHT_MODULE, '../../../webclients/juicescan/node_modules/playwright/index.mjs').href);
const { default: AxeBuilder } = await import(moduleURL(process.env.AXE_MODULE, '../../../webclients/juicescan/node_modules/@axe-core/playwright/dist/index.mjs').href);
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce', acceptDownloads: true });
const page = await context.newPage();
const home = process.env.BASE_URL || 'http://127.0.0.1:3010/';
const errors = [], failures = [];
let checks = 0, projectURL;
page.setDefaultTimeout(7000);
page.on('pageerror', error => errors.push(error.message));
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
page.on('response', response => { if (response.status() >= 400) errors.push(`HTTP ${response.status()} ${response.url()}`); });
async function check(name, callback) {
  checks++;
  try { await callback(); process.stdout.write(`PASS ${name}\n`); }
  catch (error) { failures.push(name); process.stdout.write(`FAIL ${name}: ${error.message}\n`); }
}
const input = name => page.locator(`#create-${name}`);
const next = () => page.locator('#create-next').click();
const network = id => page.locator(`#create-networks [data-network="${id}"]`);
const environment = id => page.locator(`#create-networkEnvironment [data-environment="${id}"]`);
const selectedNetworks = () => page.locator('#create-networks [aria-pressed="true"]').evaluateAll(buttons => buttons.map(button => button.dataset.network));
const operatorWallet = `0x${'a1'.repeat(20)}`;
const networkIDs = ['ethereum', 'optimism', 'base', 'arbitrum'];
const revenuePlan = 'Members pay for tool hire and repairs.\nWeekend <workshops> earn extra revenue & support maintenance.';
async function downloadSetup() {
  const pending = page.waitForEvent('download');
  await page.locator('#download-setup').click();
  const result = await pending;
  const setup = JSON.parse(await readFile(await result.path(), 'utf8'));
  await result.delete();
  return setup;
}
async function currentStep(index) {
  await page.locator(`.create-step[data-step-panel="${index}"]`).waitFor({ state: 'visible' });
  await page.locator(`[data-create-step="${index}"][aria-current="step"]`).waitFor({ state: 'visible' });
  assert.equal(await page.locator(`.create-step[data-step-panel="${index}"]`).isVisible(), true);
  assert.equal(await page.locator(`[data-create-step="${index}"]`).getAttribute('aria-current'), 'step');
}
async function shot(name) {
  if (!process.env.BROWSER_SCREENSHOT_DIR) return;
  await mkdir(process.env.BROWSER_SCREENSHOT_DIR, { recursive: true });
  await page.screenshot({ path: join(process.env.BROWSER_SCREENSHOT_DIR, name), fullPage: true });
}
async function a11y(label) {
  const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  await check(`Accessibility: ${label}`, async () => assert.deepEqual(result.violations.map(v => ({ id: v.id, nodes: v.nodes.map(n => n.target) })), [], label));
}
async function noOverflow() {
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'No horizontal page overflow.');
}

try {
  await check('Homepage starts a fresh local creation flow', async () => {
    await page.goto(home);
    assert.equal((await page.locator('.create-homerun').textContent()).trim(), 'Begin');
    await page.locator('.create-homerun').click();
    assert.match(page.url(), /\/create\/?$/);
    await currentStep(0);
    assert.equal(await page.locator('.create-intro h1').textContent(), 'Design the rules');
    assert.equal(await page.locator('label[for="create-name"]').textContent(), 'Title');
    assert.equal(await page.locator('.draft-preview .create-eyebrow').count(), 0);
    assert.equal(await page.locator('#create-raiseDays').count(), 0);
    assert.equal(await page.locator('[data-create-step="1"]').isDisabled(), true);
    await a11y('Create asset form');
    await shot('create-asset-desktop.png');
  });
  await check('Blank names receive a default and Back keeps editable asset details', async () => {
    await next();
    await currentStep(1);
    assert.equal(await input('name').inputValue(), 'Untitled');
    assert.equal(await page.locator('#step-title-1').evaluate(node => node === document.activeElement), true);
    await page.locator('#create-back').click();
    await currentStep(0);
    await input('name').fill('Neighborhood Workshop');
    await input('assetType').selectOption('equipment');
    await input('location').fill('Florianópolis');
    await input('description').fill('Shared tools that earn revenue through community use.');
    assert.equal(await page.locator('#draft-name').textContent(), 'Neighborhood Workshop');
    await next();
    await currentStep(1);
    assert.equal(await page.locator('#step-title-1').evaluate(node => node === document.activeElement), true);
  });
  await check('Funding validates amounts and operator ownership', async () => {
    await input('purchaseBudget').fill('');
    await next();
    await currentStep(2);
    assert.equal(await input('purchaseBudget').inputValue(), '500,000');
    await page.locator('#create-back').click();
    await input('purchaseBudget').fill('0');
    await next();
    await currentStep(1);
    assert.equal(await input('purchaseBudget').getAttribute('aria-invalid'), 'true');
    await input('purchaseBudget').fill('1000.001');
    await next();
    assert.match(await page.locator('#purchaseBudget-error').textContent(), /whole cents/);
    await input('purchaseBudget').fill('1000');
    await input('opsReserve').fill('0');
    await input('operatorFundPercent').fill('100');
    await next();
    assert.equal(await input('operatorFundPercent').getAttribute('aria-invalid'), 'true');
    await input('operatorFundPercent').fill('20');
    assert.equal(await page.locator('#create-raise-goal').textContent(), '$1,025.65');
    await a11y('Valid funding form');
    await shot('create-fundraise-desktop.png');
    await next();
    await currentStep(2);
  });
  await check('Back navigation and reload retain draft values and current step', async () => {
    await page.locator('#create-back').click();
    await currentStep(1);
    assert.equal(await input('purchaseBudget').inputValue(), '1,000');
    await page.reload();
    await currentStep(1);
    assert.equal(await input('purchaseBudget').inputValue(), '1,000');
    assert.equal(await page.locator('#draft-name').textContent(), 'Neighborhood Workshop');
    await next();
  });
  await check('Revenue plans are optional and entered text survives blur, navigation, and reload', async () => {
    assert.equal(await input('revenueDescription').inputValue(), '');
    await next();
    await currentStep(3);
    assert.equal(await page.locator('#create-review .revenue-description').count(), 0);
    await page.locator('#create-back').click();
    await currentStep(2);
    await input('revenueDescription').fill(revenuePlan);
    await input('monthlyRent').click();
    assert.equal(await input('revenueDescription').inputValue(), revenuePlan);
    assert.equal(await input('revenueDescription').getAttribute('inputmode'), null);
    await page.locator('#create-back').click();
    await currentStep(1);
    await next();
    assert.equal(await input('revenueDescription').inputValue(), revenuePlan);
    await page.reload();
    await currentStep(2);
    assert.equal(await input('revenueDescription').inputValue(), revenuePlan);
  });
  await check('INCOME allocations prevent over-allocation and show the customer remainder', async () => {
    assert.equal(await page.locator('label[for="create-stickySplitPercent"]').textContent(), 'To FUND holders');
    assert.match(await page.locator('[data-step-panel="2"] .create-note').textContent(), /Customers receive the remaining new tokens/);
    await input('monthlyRent').fill('200');
    await input('monthlyCosts').fill('50');
    await input('operatorSplitPercent').fill('90');
    await input('stickySplitPercent').fill('15');
    await next();
    await currentStep(2);
    assert.equal(await input('operatorSplitPercent').getAttribute('aria-invalid'), 'true');
    await a11y('Invalid INCOME allocation');
    await input('operatorSplitPercent').fill('70');
    await input('stickySplitPercent').fill('20');
    const shares = await page.locator('#create-income-split li strong').allTextContents();
    assert.deepEqual(shares, ['70%', '20%', '10%']);
    await a11y('Valid INCOME allocation');
    await shot('create-income-desktop.png');
    await next();
    await currentStep(3);
  });
  await check('Allocation labels follow proportional segments and small shares remain readable', async () => {
    await page.locator('[data-create-step="2"]').click();
    await input('operatorSplitPercent').fill('75');
    await input('stickySplitPercent').fill('15');
    const aligned = await page.locator('#create-income-split').evaluate(root => {
      const bars = [...root.querySelectorAll('.create-split-bar span')];
      const labels = [...root.querySelectorAll('li')];
      return bars.every((bar, index) => Math.abs(bar.getBoundingClientRect().x - labels[index].getBoundingClientRect().x) < 1);
    });
    assert.equal(aligned, true, 'Desktop labels begin at the same x position as their proportional segments.');
    await shot('create-income-proportional-desktop.png');
    await page.setViewportSize({ width: 320, height: 844 });
    for (const [operators, stakers, expected] of [[0, 100, ['100%']], [1, 99, ['1%', '99%']]]) {
      await input('operatorSplitPercent').fill(String(operators));
      await input('stickySplitPercent').fill(String(stakers));
      assert.deepEqual(await page.locator('#create-income-split li strong').allTextContents(), expected);
      assert.match(await page.locator('#create-income-split .zero-shares').textContent(), /0% Customers/);
      assert.equal(await page.locator('#create-income-split .create-split-bar').isHidden(), true);
      await noOverflow();
      await a11y(`320px ${operators}/${stakers}/0 INCOME split`);
      await shot(`create-income-${operators}-${stakers}-320.png`);
    }
    await input('operatorSplitPercent').fill('70');
    await input('stickySplitPercent').fill('20');
    await page.setViewportSize({ width: 1440, height: 1000 });
    await next();
  });
  await check('Review defaults to all production networks with accessible icon-only choices', async () => {
    assert.match(await page.locator('#create-review').textContent(), /Neighborhood Workshop/);
    assert.match(await page.locator('#create-review').textContent(), /\$1,025\.65/);
    assert.equal(await page.locator('#create-next').textContent(), 'Preview');
    assert.equal(await environment('production').getAttribute('aria-pressed'), 'true');
    assert.equal(await environment('testnet').getAttribute('aria-pressed'), 'false');
    assert.deepEqual(await selectedNetworks(), networkIDs);
    for (const [id, name] of [['ethereum', 'Ethereum'], ['optimism', 'Optimism'], ['base', 'Base'], ['arbitrum', 'Arbitrum']]) {
      assert.equal(await network(id).getAttribute('aria-label'), name);
      assert.equal((await network(id).textContent()).trim(), '');
      assert.equal(await network(id).locator('img').evaluate(img => img.complete && img.naturalWidth > 0 && img.src.endsWith('.svg')), true);
    }
    assert.equal(await input('revnetOperatorEnabled').isChecked(), true);
    assert.equal(await input('operatorWallet').isVisible(), true);
    const setup = await downloadSetup();
    assert.equal(setup.schemaVersion, 2);
    assert.equal(setup.networkEnvironment, 'production');
    assert.deepEqual(setup.plannedNetworks.map(chain => chain.chainId), [1, 10, 8453, 42161]);
    assert.equal(Object.hasOwn(setup, 'plannedNetwork'), false);
    assert.equal(setup.revnetOperator.enabled, true);
    assert.equal(setup.income.revenueDescription, revenuePlan);
    assert.equal(Object.hasOwn(setup.operator, 'wallet'), false);
    await a11y('Production networks and shared operator address');
    await shot('create-review-production-desktop.png');
  });
  await check('Network environment switching resets all four and subsets persist through reload', async () => {
    await network('optimism').click();
    assert.deepEqual(await selectedNetworks(), ['ethereum', 'base', 'arbitrum']);
    await environment('testnet').click();
    assert.deepEqual(await selectedNetworks(), networkIDs);
    for (const id of networkIDs) assert.match(await network(id).getAttribute('aria-label'), /Sepolia/);
    await network('optimism').click();
    await network('arbitrum').click();
    assert.deepEqual(await selectedNetworks(), ['ethereum', 'base']);
    await page.reload();
    await currentStep(3);
    assert.equal(await environment('testnet').getAttribute('aria-pressed'), 'true');
    assert.deepEqual(await selectedNetworks(), ['ethereum', 'base']);
    const setup = await downloadSetup();
    assert.equal(setup.networkEnvironment, 'testnet');
    assert.deepEqual(setup.plannedNetworks.map(chain => chain.chainId), [11155111, 84532]);
    await network('ethereum').click();
    await network('base').click();
    await next();
    await currentStep(3);
    assert.equal(await input('networks').getAttribute('aria-invalid'), 'true');
    assert.match(await page.locator('#networks-error').textContent(), /at least one/);
    assert.equal(await page.locator('#create-success').isHidden(), true);
    await a11y('Empty network selection validation');
    await environment('production').click();
    assert.deepEqual(await selectedNetworks(), networkIDs);
    await environment('testnet').click();
    await network('optimism').click();
    await network('arbitrum').click();
    assert.equal(await input('networks').getAttribute('aria-invalid'), 'false');
  });
  await check('One operator address serves FUND ownership and optional INCOME controls', async () => {
    assert.equal(await input('revnetOperatorEnabled').isHidden(), true);
    assert.equal(await input('operatorWallet').isVisible(), true);
    let setup = await downloadSetup();
    assert.equal(setup.revnetOperator.enabled, true);
    assert.equal(setup.revnetOperator.status, 'not-specified');
    assert.equal(setup.revnetOperator.address, null);
    await input('operatorWallet').fill('not-a-wallet');
    await next();
    await currentStep(3);
    assert.equal(await input('operatorWallet').getAttribute('aria-invalid'), 'true');
    await input('operatorWallet').fill('0x0000000000000000000000000000000000000000');
    await next();
    assert.equal(await input('operatorWallet').getAttribute('aria-invalid'), 'true');
    await input('operatorWallet').fill(operatorWallet);
    setup = await downloadSetup();
    assert.equal(setup.funding.ownerAddress, operatorWallet);
    assert.equal(setup.revnetOperator.enabled, true);
    assert.equal(setup.revnetOperator.address, operatorWallet);
    assert.equal(setup.revnetOperator.status, 'specified');
    assert.equal(await input('revnetOperatorEnabled').isHidden(), true);
    assert.equal(await input('operatorWallet').inputValue(), operatorWallet);
    await input('operatorWallet').fill(operatorWallet);
    setup = await downloadSetup();
    assert.deepEqual(setup.operator, { address: operatorWallet, fundOwnershipPercentAfterPurchase: 20 });
    assert.equal(setup.funding.ownerAddress, setup.revnetOperator.address);
    assert.equal(setup.revnetOperator.address, operatorWallet);
    assert.equal(setup.revnetOperator.scope, 'INCOME');
    assert.equal(setup.revnetOperator.permissionsAssigned, false);
    assert.deepEqual(setup.revnetOperator.chainIds, [11155111, 84532]);
    assert.equal(setup.execution.enabled, false);
    assert.equal(setup.asset.name, 'Neighborhood Workshop');
    assert.equal(Object.hasOwn(setup.funding, 'durationDays'), false);
    assert.equal(await page.locator('#create-success').isHidden(), true);
    await page.reload();
    await currentStep(3);
    assert.equal(await input('revnetOperatorEnabled').isChecked(), true);
    assert.equal(await input('operatorWallet').inputValue(), operatorWallet);
    assert.deepEqual(await selectedNetworks(), ['ethereum', 'base']);
    await a11y('Review plan with testnet subset and revnet operator');
    await shot('create-review-desktop.png');
  });
  await check('All setup stages remain usable on narrow screens', async () => {
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      for (let step = 0; step < 4; step++) {
        await page.locator(`[data-create-step="${step}"]`).click();
        await currentStep(step);
        await noOverflow();
        await a11y(`${width}px setup step ${step + 1}`);
        await shot(`create-step-${step + 1}-${width}.png`);
      }
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
  });
  await check('Photo upload is previewed and persisted with the draft', async () => {
    await page.locator('[data-create-step="0"]').click();
    await input('photo').setInputFiles(new URL('../web/assets/founder-haus/exterior.jpg', import.meta.url).pathname);
    await page.locator('#draft-photo').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#draft-photo').evaluate(img => img.complete && img.naturalWidth > 0), true);
    await page.reload();
    await currentStep(0);
    await page.locator('#draft-photo').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#draft-photo').evaluate(img => img.complete && img.naturalWidth > 0), true);
    await page.locator('#remove-photo').click();
    assert.equal(await page.locator('#draft-photo').isHidden(), true);
    for (let index = 0; index < 3; index++) await next();
  });
  await check('Creation saves a local project and a non-executing deployment draft', async () => {
    await next();
    await page.locator('#create-success').waitFor({ state: 'visible' });
    assert.match(await page.locator('#create-success').textContent(), /Nothing has been deployed on-chain/);
    assert.equal(await page.locator('#success-title').evaluate(node => node === document.activeElement), true);
    projectURL = new URL(await page.locator('#open-created-project').getAttribute('href'), home).href;
    assert.match(projectURL, /\/project\/\?id=[a-f\d-]+/);
    const download = page.waitForEvent('download');
    await page.locator('#download-deployment').click();
    const result = await download;
    const draft = JSON.parse(await readFile(await result.path(), 'utf8'));
    await result.delete();
    assert.equal(draft.asset.name, 'Neighborhood Workshop');
    assert.equal(draft.execution.enabled, false);
    assert.equal(draft.execution.status, 'not-deployed');
    assert.equal(draft.funding.startingAmountRaised, 0);
    assert.equal(draft.funding.raiseGoal, 1025.65);
    assert.equal(draft.schemaVersion, 2);
    assert.equal(draft.networkEnvironment, 'testnet');
    assert.deepEqual(draft.plannedNetworks.map(chain => chain.chainId), [11155111, 84532]);
    assert.equal(Object.hasOwn(draft, 'plannedNetwork'), false);
    assert.equal(draft.revnetOperator.address, operatorWallet);
    assert.equal(draft.revnetOperator.permissionsAssigned, false);
    assert.deepEqual(draft.income.issuanceAllocationPercent, { operators: 70, fundHolders: 20, customers: 10 });
    assert.equal(draft.income.issuanceCutPercentAssumption, 5);
    assert.equal(draft.income.issuanceCutPeriodMonthsAssumption, 3);
    assert.equal(draft.income.issuanceCutDurationYearsAssumption, 2);
    assert.equal(draft.income.numberOfIssuanceCutsAssumption, 8);
    assert.equal(draft.income.holderRewards.requiresStaking, false);
    assert.equal(draft.income.holderRewards.vestingMonths, 0);
    assert.equal(draft.income.revenueDescription, revenuePlan);
    assert.equal(await page.evaluate(() => localStorage.getItem('homerun:create-draft:v1')), null);
    await a11y('Created local preview');
    await shot('create-success-desktop.png');
  });
  if (process.env.CREATE_PROJECT_CHECKS !== '0') {
    await check('Created project starts empty and previews a first contribution without changing its balance', async () => {
      await page.goto(projectURL);
      await page.locator('#scenario-title').waitFor();
      assert.equal((await page.locator('.deal-heading h1').textContent()).trim(), 'Neighborhood Workshop');
      assert.equal(await page.locator('#open-house-gallery').count(), 0);
      assert.equal(await page.locator('#created-asset-sketch').count(), 1);
      assert.equal(await page.locator('#field-purchaseBudget').inputValue(), '1,000');
      assert.match(await page.locator('.created-project-note').textContent(), /Testnets/);
      assert.deepEqual(await page.locator('.created-network-symbols img').evaluateAll(images => images.map(img => img.alt)), ['Sepolia', 'Base Sepolia']);
      assert.equal(await page.locator('#field-monthlyRent').inputValue(), '200');
      assert.equal(await page.locator('#field-raisedPercent').inputValue(), '0');
      assert.equal(await page.locator('#project-raised').textContent(), '$0');
      assert.equal(await page.locator('#pay-amount').isEnabled(), true);
      await page.locator('#pay-amount').fill('100');
      assert.equal(await page.locator('#pay-output').textContent(), '1,000,000');
      assert.equal(await page.locator('#pay-output-unit').textContent(), 'FUND');
      assert.equal(await page.locator('#pay-review').isEnabled(), true);
      await page.locator('#pay-review').click();
      await page.locator('#pay-dialog').waitFor({ state: 'visible' });
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('#field-raisedPercent').inputValue(), '0');
      assert.equal(await page.locator('#project-raised').textContent(), '$0');
      await page.locator('#pay-amount').fill('200');
      assert.equal(await page.locator('#pay-output').textContent(), '2,000,000');
      assert.equal(await page.locator('#project-raised').textContent(), '$0');
      await page.locator('#pay-amount').fill('1025.66');
      assert.equal(await page.locator('#pay-review').isDisabled(), true);
      assert.match(await page.locator('#pay-error').textContent(), /cannot exceed/);
      await page.locator('#pay-amount').fill('0');
      assert.equal(await page.locator('#pay-review').isDisabled(), true);
      await page.locator('#pay-amount').fill('100');
      assert.equal(await page.locator('#pay-review').isEnabled(), true);
      await a11y('Created project');
      await shot('created-project-desktop.png');
      await page.reload();
      assert.equal((await page.locator('.deal-heading h1').textContent()).trim(), 'Neighborhood Workshop');
      assert.equal(await page.locator('#field-purchaseBudget').inputValue(), '1,000');
    });
    await check('Created-project income terms, reset, and mobile layouts use its own setup', async () => {
      await page.goto(projectURL);
      await page.locator('#scenario-title').waitFor();
      await page.locator('button[data-journey-phase="earning"]').click();
      assert.equal(await page.locator('#phase-panel .revenue-description').textContent(), revenuePlan);
      assert.equal(await page.locator('#phase-panel .revenue-description').evaluate(node => node.children.length), 0);
      assert.ok(['pre-line', 'pre-wrap', 'break-spaces'].includes(await page.locator('#phase-panel .revenue-description').evaluate(node => getComputedStyle(node).whiteSpace)));
      assert.match(await page.locator('#rev-payment-split').textContent(), /70%/);
      assert.match(await page.locator('#rev-payment-split').textContent(), /20%/);
      await page.locator('#reset-example').click();
      assert.equal(await page.locator('#field-purchaseBudget').inputValue(), '1,000');
      assert.equal(await page.locator('#field-raisedPercent').inputValue(), '0');
      assert.deepEqual(await page.locator('.created-network-symbols img').evaluateAll(images => images.map(img => img.alt)), ['Sepolia', 'Base Sepolia']);
      await page.locator('button[data-journey-phase="earning"]').click();
      assert.equal(await page.locator('#phase-panel .revenue-description').textContent(), revenuePlan);
      await page.locator('#reset-example').click();
      for (const width of [390, 320]) {
        await page.setViewportSize({ width, height: 844 });
        await noOverflow();
        await a11y(`${width}px created project`);
        await shot(`created-project-${width}.png`);
      }
      await page.setViewportSize({ width: 1440, height: 1000 });
    });
    await check('Founder Haus remains isolated from created projects', async () => {
      await page.goto(new URL('/founderhaus', home).href);
      await page.locator('#scenario-title').waitFor();
      assert.equal((await page.locator('.deal-heading h1').textContent()).trim(), 'Founder Haus');
      assert.equal(await page.locator('#field-purchaseBudget').inputValue(), '500,000');
      assert.equal(await page.locator('#field-raisedPercent').inputValue(), '60');
    });
    await check('A missing local preview has a clear recovery route', async () => {
      await page.goto(new URL('/project/?id=missing', home).href);
      assert.equal(await page.locator('.missing-project h1').textContent(), 'Project preview not found.');
      assert.equal(await page.locator('.missing-project a').first().getAttribute('href'), '/create/');
      await a11y('Missing project');
    });
  }
  await check('A fresh draft is independent and keeps earlier created projects', async () => {
    await page.goto(new URL('/create', home).href);
    await currentStep(0);
    assert.equal(await input('name').inputValue(), '');
    assert.equal(await input('purchaseBudget').inputValue(), '500,000');
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('homerun:created-projects:v1')).length), 1);
    await input('name').fill('Another project');
    await page.locator('#start-over').click();
    assert.equal(await input('name').inputValue(), '');
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('homerun:created-projects:v1')).length), 1);
    for (let index = 0; index < 3; index++) await next();
    assert.deepEqual(await selectedNetworks(), networkIDs);
    assert.equal(await environment('production').getAttribute('aria-pressed'), 'true');
    assert.equal(await input('revnetOperatorEnabled').isChecked(), true);
  });
  await check('Legacy draft network and operator preferences migrate and reset to new defaults', async () => {
    await page.evaluate(wallet => localStorage.setItem('homerun:create-draft:v1', JSON.stringify({
      raw: { name: 'Legacy preview', network: 'base', operatorWallet: wallet }, step: 3,
    })), operatorWallet);
    await page.reload();
    await currentStep(3);
    assert.deepEqual(await selectedNetworks(), ['base']);
    assert.equal(await environment('production').getAttribute('aria-pressed'), 'true');
    assert.equal(await input('revnetOperatorEnabled').isChecked(), true);
    assert.equal(await input('operatorWallet').inputValue(), operatorWallet);
    const setup = await downloadSetup();
    assert.deepEqual(setup.plannedNetworks.map(chain => chain.chainId), [8453]);
    assert.equal(setup.revnetOperator.address, operatorWallet);
    await page.locator('#start-over').click();
    await currentStep(0);
    for (let index = 0; index < 3; index++) await next();
    assert.deepEqual(await selectedNetworks(), networkIDs);
    assert.equal(await input('revnetOperatorEnabled').isChecked(), true);
    assert.equal(await input('operatorWallet').isVisible(), true);
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('homerun:created-projects:v1')).length), 1);
  });
  await check('Earlier default allocations migrate once while custom and newly saved splits remain intact', async () => {
    for (const [operators, holders, version, expected] of [[75, 15, null, [70, 10]], [81, 6, null, [70, 10]], [68, 13, 2, [70, 10]], [70, 20, null, [70, 20]], [75, 15, 2, [75, 15]], [68, 13, 3, [68, 13]]]) {
      await page.evaluate(({ operators, holders, version }) => localStorage.setItem('homerun:create-draft:v1', JSON.stringify({
        raw: { name: 'Saved example', operatorSplitPercent: String(operators), stickySplitPercent: String(holders) },
        step: 2, incomeDefaultsVersion: version,
      })), { operators, holders, version });
      await page.reload();
      await currentStep(2);
      assert.equal(await input('operatorSplitPercent').inputValue(), String(expected[0]));
      assert.equal(await input('stickySplitPercent').inputValue(), String(expected[1]));
      await input('operatorSplitPercent').fill('75');
      await input('stickySplitPercent').fill('15');
      await page.reload();
      assert.equal(await input('operatorSplitPercent').inputValue(), '75');
      assert.equal(await input('stickySplitPercent').inputValue(), '15');
    }
  });
  await check('No browser exceptions, failed requests, or console errors', async () => assert.deepEqual(errors, []));
} finally { await browser.close(); }
process.stdout.write(`\n${checks - failures.length}/${checks} create-flow checks passed.\n`);
if (failures.length) process.exitCode = 1;
