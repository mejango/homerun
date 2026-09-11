/** Native Next.js Create regressions. Start npm run dev first. No wallet connection or transaction is signed. */
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const moduleURL = (override, fallback) => override ? pathToFileURL(override) : new URL(fallback, import.meta.url);
const { chromium } = await import(moduleURL(process.env.PLAYWRIGHT_MODULE, '../node_modules/playwright/index.mjs').href);
const { default: AxeBuilder } = await import(moduleURL(process.env.AXE_MODULE, '../node_modules/@axe-core/playwright/dist/index.mjs').href);
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce', acceptDownloads: true });
const page = await context.newPage();
const home = process.env.BASE_URL || 'http://localhost:3010/';
const errors = [], failures = [];
let checks = 0;
page.setDefaultTimeout(15_000);
page.setDefaultNavigationTimeout(180_000);
page.on('pageerror', error => errors.push(error.message));
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
page.on('response', response => { if (response.status() >= 400 && new URL(response.url()).origin === new URL(home).origin) errors.push(`HTTP ${response.status()} ${response.url()}`); });
async function check(name, callback) {
  checks++;
  try { await callback(); process.stdout.write(`PASS ${name}\n`); }
  catch (error) { failures.push(name); process.stdout.write(`FAIL ${name}: ${error.message}\n`); }
}
const input = name => page.locator(`#create-${name}`);
const next = () => page.locator('#create-next').click();
const network = id => page.locator(`#create-networks [data-network="${id}"]`);
const environment = () => page.getByRole('combobox', { name: 'Network environment', exact: true });
const selectedNetworks = () => page.locator('#create-networks [aria-pressed="true"]').evaluateAll(buttons => buttons.map(button => button.dataset.network));
const operatorWallet = `0x${'a1'.repeat(20)}`;
const networkIDs = ['ethereum', 'optimism', 'base', 'arbitrum'];
const revenuePlan = 'Members pay for tool hire and repairs.\nWeekend <workshops> earn extra revenue & support maintenance.';
async function downloadSetup() {
  const details = page.locator('details').filter({ has: page.locator('#download-setup') });
  if (!(await details.evaluate(node => node.open))) await details.locator('summary').click();
  const pending = page.waitForEvent('download');
  await page.locator('#download-setup').click();
  const result = await pending;
  const setup = JSON.parse(await readFile(await result.path(), 'utf8'));
  await result.delete();
  return setup;
}
async function currentStep(index) {
  await page.locator('#draft-status').filter({ hasText: 'Draft saved in this browser' }).waitFor({ state: 'visible' });
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
  const result = await new AxeBuilder({ page }).exclude('nextjs-portal').withTags(['wcag2a', 'wcag2aa']).analyze();
  await check(`Accessibility: ${label}`, async () => assert.deepEqual(result.violations.map(v => ({ id: v.id, nodes: v.nodes.map(n => n.target) })), [], label));
}
async function noOverflow() {
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'No horizontal page overflow.');
}

try {
  await check('Create is rendered on the server before JavaScript runs', async () => {
    const serverContext = await browser.newContext({ javaScriptEnabled: false });
    try {
      const serverPage = await serverContext.newPage();
      const response = await serverPage.goto(new URL('/create', home).href, { timeout: 180_000 });
      assert.equal(response.status(), 200);
      assert.equal(await serverPage.getByRole('heading', { name: 'Design the rules' }).count(), 1);
      assert.equal(await serverPage.getByLabel('Title', { exact: true }).count(), 1);
      assert.equal(await serverPage.locator('.brand-ball svg').count(), 1);
      assert.equal(await serverPage.locator('script[src*="create-app.mjs"]').count(), 0);
    } finally { await serverContext.close(); }
  });
  await check('Homepage starts the native React creation flow', async () => {
    await page.goto(home);
    assert.equal((await page.locator('.create-homerun').textContent()).trim(), 'Begin');
    await page.locator('.create-homerun').click();
    await page.waitForURL(/\/create\/?$/);
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
    assert.equal(await page.locator('#draft-name').textContent(), 'Untitled');
    await page.waitForFunction(() => document.activeElement?.id === 'step-title-1');
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
    await page.waitForFunction(() => document.activeElement?.id === 'step-title-1');
    assert.equal(await page.locator('#step-title-1').evaluate(node => node === document.activeElement), true);
  });
  await check('Funding validates amounts and operator ownership', async () => {
    await input('purchaseBudget').fill('');
    await next();
    await currentStep(2);
    await page.locator('#create-back').click();
    assert.equal(await input('purchaseBudget').inputValue(), '500,000');
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
    await page.reload({ waitUntil: 'domcontentloaded' });
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
    await page.reload({ waitUntil: 'domcontentloaded' });
    await currentStep(2);
    assert.equal(await input('revenueDescription').inputValue(), revenuePlan);
  });
  await check('INCOME allocations prevent over-allocation and show the customer remainder', async () => {
    assert.equal(await page.locator('label[for="create-stickySplitPercent"]').textContent(), 'To FUND stakers');
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
    assert.equal(await page.locator('#create-next').count(), 0);
    await page.getByRole('heading', { name: 'Launch the FUND raise', exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Save metadata and prepare deployment', exact: true }).isDisabled(), true);
    assert.equal(await environment().inputValue(), 'production');
    assert.deepEqual(await environment().locator('option').allTextContents(), ['Production', 'Testnets']);
    assert.deepEqual(await selectedNetworks(), networkIDs);
    for (const [id, name] of [['ethereum', 'Ethereum'], ['optimism', 'Optimism'], ['base', 'Base'], ['arbitrum', 'Arbitrum']]) {
      assert.equal(await network(id).getAttribute('aria-label'), name);
      assert.equal((await network(id).textContent()).trim(), '');
      assert.equal(await network(id).locator('img').evaluate(img => img.complete && img.naturalWidth > 0 && img.src.endsWith('.svg')), true);
    }
    assert.equal(await input('operatorWallet').isVisible(), true);
    const setup = await downloadSetup();
    assert.equal(setup.schemaVersion, 3);
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
    await environment().selectOption('testnet');
    assert.deepEqual(await selectedNetworks(), networkIDs);
    for (const id of networkIDs) assert.match(await network(id).getAttribute('aria-label'), /Sepolia/);
    await network('optimism').click();
    await network('arbitrum').click();
    assert.deepEqual(await selectedNetworks(), ['ethereum', 'base']);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await currentStep(3);
    assert.equal(await environment().inputValue(), 'testnet');
    assert.deepEqual(await selectedNetworks(), ['ethereum', 'base']);
    const setup = await downloadSetup();
    assert.equal(setup.networkEnvironment, 'testnet');
    assert.deepEqual(setup.plannedNetworks.map(chain => chain.chainId), [11155111, 84532]);
    await network('ethereum').click();
    await network('base').click();
    await currentStep(3);
    assert.equal(await input('networks').getAttribute('aria-describedby'), 'networks-error');
    assert.match(await page.locator('#networks-error').textContent(), /at least one/);
    assert.equal(await page.locator('#create-success').count(), 0);
    await a11y('Empty network selection validation');
    await environment().selectOption('production');
    assert.deepEqual(await selectedNetworks(), networkIDs);
    await environment().selectOption('testnet');
    await network('optimism').click();
    await network('arbitrum').click();
    assert.equal(await input('networks').getAttribute('aria-describedby'), null);
  });
  await check('One operator address serves FUND ownership and optional INCOME controls', async () => {
    assert.equal(await input('operatorWallet').isVisible(), true);
    let setup = await downloadSetup();
    assert.equal(setup.revnetOperator.enabled, true);
    assert.equal(setup.revnetOperator.status, 'not-specified');
    assert.equal(setup.revnetOperator.address, null);
    await input('operatorWallet').fill('not-a-wallet');
    await currentStep(3);
    assert.equal(await input('operatorWallet').getAttribute('aria-invalid'), 'true');
    await input('operatorWallet').fill('0x0000000000000000000000000000000000000000');
    assert.equal(await input('operatorWallet').getAttribute('aria-invalid'), 'true');
    await input('operatorWallet').fill(operatorWallet);
    setup = await downloadSetup();
    assert.equal(setup.funding.ownerAddress, operatorWallet);
    assert.equal(setup.revnetOperator.enabled, true);
    assert.equal(setup.revnetOperator.address, operatorWallet);
    assert.equal(setup.revnetOperator.status, 'specified');
    assert.equal(await input('operatorWallet').inputValue(), operatorWallet);
    await input('operatorWallet').fill(operatorWallet);
    setup = await downloadSetup();
    assert.deepEqual(setup.operator, { name: '', introduction: '', photo: '', address: operatorWallet, fundOwnershipPercentAfterPurchase: 20 });
    assert.equal(setup.funding.ownerAddress, setup.revnetOperator.address);
    assert.equal(setup.revnetOperator.address, operatorWallet);
    assert.equal(setup.revnetOperator.scope, 'INCOME');
    assert.equal(setup.revnetOperator.permissionsAssigned, false);
    assert.deepEqual(setup.revnetOperator.chainIds, [11155111, 84532]);
    assert.equal(setup.execution.enabled, false);
    assert.equal(setup.asset.name, 'Neighborhood Workshop');
    assert.equal(Object.hasOwn(setup.funding, 'durationDays'), false);
    assert.equal(await page.locator('#create-success').count(), 0);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await currentStep(3);
    assert.equal(await input('operatorWallet').inputValue(), operatorWallet);
    assert.deepEqual(await selectedNetworks(), ['ethereum', 'base']);
    await a11y('Review plan with testnet subset and revnet operator');
    await shot('create-review-desktop.png');
  });
  await check('Live entry requires a wallet and sign-in cannot create a fake deployment', async () => {
    const prepare = page.getByRole('button', { name: 'Save metadata and prepare deployment', exact: true });
    assert.equal(await prepare.isDisabled(), true);
    assert.match(await page.locator('#create-contract-actions').textContent(), /INCOME.*separate later actions/);
    assert.equal(await page.locator('#create-next').count(), 0);
    assert.equal(await page.locator('#create-success').count(), 0);
    await page.getByRole('button', { name: 'Connect wallet', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.waitFor({ state: 'visible' });
    assert.match(await dialog.textContent(), /Connect your wallet|Sign in/);
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden' });
    assert.equal(await prepare.isDisabled(), true);
    assert.equal(await page.evaluate(() => localStorage.getItem('homerun:fund-launch:v1')), null);
    assert.equal(await page.evaluate(() => localStorage.getItem('homerun:created-projects:v1')), null);
  });
  await check('StrictMode and client navigation preserve the saved review configuration', async () => {
    const before = await page.evaluate(() => JSON.parse(localStorage.getItem('homerun:create-draft:v1')));
    await page.getByRole('link', { name: 'Homerun home', exact: true }).click();
    await page.locator('.create-homerun').click();
    await currentStep(3);
    assert.equal(await input('operatorWallet').inputValue(), operatorWallet);
    assert.deepEqual(await selectedNetworks(), ['ethereum', 'base']);
    const after = await page.evaluate(() => JSON.parse(localStorage.getItem('homerun:create-draft:v1')));
    assert.deepEqual(after.raw, before.raw);
  });
  await check('Modeling panels and FUND pie retain clear field purpose and ownership labels', async () => {
    await page.locator('[data-create-step="1"]').click();
    assert.equal(await page.locator('.fundraise-modeling .create-input').count(), 2);
    assert.equal(await page.getByRole('img', { name: 'Operators 20%, contributors 80%.' }).count(), 1);
    assert.equal(await page.locator('#fund-operator-percent').textContent(), '20%');
    assert.equal(await page.locator('#fund-contributor-percent').textContent(), '80%');
    await page.locator('[data-create-step="2"]').click();
    assert.equal(await page.locator('.modeling-inputs .create-input').count(), 4);
    await input('income-months').fill('24');
    assert.equal(await page.locator('#create-income-month-label').textContent(), 'Month 24');
    assert.notEqual(await page.locator('[data-income-total]').textContent(), '500,000');
    await input('operatorSplitPercent').fill('100');
    await page.locator('[data-create-step="3"]').click();
    await currentStep(2);
    assert.equal(await input('operatorSplitPercent').getAttribute('aria-invalid'), 'true');
    await input('operatorSplitPercent').fill('70');
    await page.locator('[data-create-step="3"]').click();
    await currentStep(3);
    assert.equal(await page.getByText('Income plan', { exact: true }).count(), 0);
  });
  await check('AI handoff separates initial INCOME claims from ongoing Sticky rewards', async () => {
    await page.getByText('Use on your site', { exact: true }).click();
    const prompt = await page.locator('[data-prompt]').inputValue();
    assert.match(prompt, /Next\.js\/React/);
    assert.match(prompt, /all FUND holders, including inactive ERC20 balances and unclaimed token credits/);
    assert.match(prompt, /Initial claims require no activation, staking or vesting/);
    assert.match(prompt, /eligible FUND stakers using Sticky/);
    assert.match(prompt, /four weekly vesting rounds/);
    assert.match(prompt, /Vesting starts in the reward-claim round when the allocation is materialized, not at the FUND deposit/);
    assert.match(prompt, /There is no minimum staking period or stake-age weight boost/);
    assert.match(prompt, /requires a verified deployment/);
    assert.match(prompt, /Neighborhood Workshop/);
    assert.match(prompt, /Safe proposal is not confirmed execution/);
    const pending = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download instructions', exact: true }).click();
    const downloaded = await pending;
    assert.equal(await readFile(await downloaded.path(), 'utf8'), prompt);
    await downloaded.delete();
    await page.getByText('Use on your site', { exact: true }).click();
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
    await page.reload({ waitUntil: 'domcontentloaded' });
    await currentStep(0);
    await page.locator('#draft-photo').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#draft-photo').evaluate(img => img.complete && img.naturalWidth > 0), true);
    await page.locator('#remove-photo').click();
    assert.equal(await page.locator('#draft-photo').count(), 0);
    for (let index = 0; index < 3; index++) await next();
  });
  await check('Operator introductions and compressed pictures survive review, download, and reload', async () => {
    await page.locator('[data-create-step="0"]').click();
    const introduction = 'We run a neighborhood workshop.\nOur <team> looks after the tools & welcomes new members.';
    await input('operatorName').fill('Workshop team');
    await input('operatorIntroduction').fill(introduction);
    await input('operatorPhoto').setInputFiles(new URL('../web/assets/founder-haus/exterior.jpg', import.meta.url).pathname);
    await page.locator('.create-operator-photo-preview').waitFor({ state: 'visible' });
    assert.equal(await page.locator('.create-operator-photo-preview').evaluate(img => img.complete && img.naturalWidth > 0 && img.naturalWidth <= 800 && img.naturalHeight <= 800), true);
    assert.equal(await page.locator('#draft-photo').count(), 0, 'Operator picture does not replace the asset cover.');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await currentStep(0);
    assert.equal(await input('operatorName').inputValue(), 'Workshop team');
    assert.equal(await input('operatorIntroduction').inputValue(), introduction);
    await page.locator('.create-operator-photo-preview').waitFor({ state: 'visible' });
    for (let index = 0; index < 3; index++) await next();
    const profile = page.locator('#create-review .operator-profile');
    assert.equal(await profile.locator('.operator-profile-name').textContent(), 'Workshop team');
    assert.equal(await profile.locator('.operator-profile-introduction').textContent(), introduction);
    assert.equal(await profile.locator('team').count(), 0, 'Introductions remain plain text.');
    const setup = await downloadSetup();
    assert.equal(setup.operator.name, 'Workshop team');
    assert.equal(setup.operator.introduction, introduction);
    assert.match(setup.operator.photo, /^data:image\/jpeg;base64,/);
    assert.equal(setup.operator.address, operatorWallet, 'A public introduction does not change operator permissions.');
    await page.setViewportSize({ width: 320, height: 844 });
    await noOverflow();
    await a11y('Operator profile review on mobile');
    await shot('create-operator-review-mobile.png');
    await page.setViewportSize({ width: 1440, height: 1000 });
  });
  await check('Unsupported operator pictures are rejected without replacing the saved picture', async () => {
    await page.locator('[data-create-step="0"]').click();
    const previous = await page.locator('.create-operator-photo-preview').getAttribute('src');
    await input('operatorPhoto').setInputFiles({ name: 'operator.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>') });
    assert.match(await page.locator('#operatorPhoto-error').textContent(), /JPG, PNG or WebP/);
    assert.equal(await page.locator('.create-operator-photo-preview').getAttribute('src'), previous);
    assert.equal(await page.locator('#create-next').isEnabled(), true);
    await page.locator('#remove-operator-photo').click();
    assert.equal(await page.locator('.create-operator-photo-preview').count(), 0);
    assert.equal(await page.locator('#operatorPhoto-error').count(), 0);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await currentStep(0);
    assert.equal(await page.locator('.create-operator-photo-preview').count(), 0);
    assert.equal(await input('operatorName').inputValue(), 'Workshop team');
  });
  await check('Reset restores the editable draft without creating or overwriting deployments', async () => {
    await page.goto(new URL('/create', home).href);
    await page.locator('#start-over').click();
    await currentStep(0);
    assert.equal(await input('name').inputValue(), '');
    assert.equal(await input('operatorName').inputValue(), '');
    assert.equal(await input('operatorIntroduction').inputValue(), '');
    assert.equal(await page.locator('.create-operator-photo-preview').count(), 0);
    assert.equal(await page.evaluate(() => localStorage.getItem('homerun:fund-launch:v1')), null);
    assert.equal(await page.evaluate(() => localStorage.getItem('homerun:created-projects:v1')), null);
    await input('name').fill('Another project');
    await page.locator('#start-over').click();
    assert.equal(await input('name').inputValue(), '');
    await next(); await currentStep(1);
    assert.equal(await input('purchaseBudget').inputValue(), '500,000');
    await next(); await currentStep(2);
    assert.equal(await input('operatorSplitPercent').inputValue(), '70');
    assert.equal(await input('stickySplitPercent').inputValue(), '10');
    await next(); await currentStep(3);
    assert.deepEqual(await selectedNetworks(), networkIDs);
    assert.equal(await environment().inputValue(), 'production');
  });
  await check('Legacy draft network and operator preferences migrate and reset to new defaults', async () => {
    await page.evaluate(wallet => localStorage.setItem('homerun:create-draft:v1', JSON.stringify({
      raw: { name: 'Legacy preview', network: 'base', operatorWallet: wallet }, step: 3,
    })), operatorWallet);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await currentStep(3);
    assert.deepEqual(await selectedNetworks(), ['base']);
    assert.equal(await environment().inputValue(), 'production');
    assert.equal(await input('operatorWallet').inputValue(), operatorWallet);
    const setup = await downloadSetup();
    assert.deepEqual(setup.plannedNetworks.map(chain => chain.chainId), [8453]);
    assert.equal(setup.revnetOperator.address, operatorWallet);
    await page.locator('#start-over').click();
    await currentStep(0);
    for (let index = 0; index < 3; index++) await next();
    assert.deepEqual(await selectedNetworks(), networkIDs);
    assert.equal(await input('operatorWallet').isVisible(), true);
    assert.equal(await page.evaluate(() => localStorage.getItem('homerun:created-projects:v1')), null);
  });
  await check('Earlier default allocations migrate once while custom and newly saved splits remain intact', async () => {
    for (const [operators, holders, version, expected] of [[75, 15, null, [70, 10]], [81, 6, null, [70, 10]], [68, 13, 2, [70, 10]], [70, 20, null, [70, 20]], [75, 15, 2, [75, 15]], [68, 13, 3, [68, 13]]]) {
      await page.evaluate(({ operators, holders, version }) => localStorage.setItem('homerun:create-draft:v1', JSON.stringify({
        raw: { name: 'Saved example', operatorSplitPercent: String(operators), stickySplitPercent: String(holders) },
        step: 2, incomeDefaultsVersion: version,
      })), { operators, holders, version });
      await page.reload({ waitUntil: 'domcontentloaded' });
      await currentStep(2);
      assert.equal(await input('operatorSplitPercent').inputValue(), String(expected[0]));
      assert.equal(await input('stickySplitPercent').inputValue(), String(expected[1]));
      await input('operatorSplitPercent').fill('75');
      await input('stickySplitPercent').fill('15');
      await page.reload({ waitUntil: 'domcontentloaded' });
      assert.equal(await input('operatorSplitPercent').inputValue(), '75');
      assert.equal(await input('stickySplitPercent').inputValue(), '15');
    }
  });
  await check('No browser exceptions, failed requests, or console errors', async () => assert.deepEqual(errors, []));
} finally { await browser.close(); }
process.stdout.write(`\n${checks - failures.length}/${checks} native Create checks passed.\n`);
if (failures.length) process.exitCode = 1;
