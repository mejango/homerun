import assert from 'node:assert/strict'
import { chromium, expect } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'

const base = process.env.BASE_URL || 'http://localhost:3014'
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
})
const context = await browser.newContext({ reducedMotion: 'reduce' })
const page = await context.newPage()
const errors = []
page.on('pageerror', error => errors.push(error.message))
page.setDefaultTimeout(30000)
page.setDefaultNavigationTimeout(120000)

const globalCta = page.getByRole('button', { name: 'Available transactions', exact: true })
const createDialog = page.getByRole('dialog', { name: 'Available transactions', exact: true })
const guide = section => page.locator(`[data-action-section="${section}"]:visible`)
const entry = (section, id) => guide(section).locator(`[data-project-action="${id}"]`)

async function projectTab(name) {
  await page.getByRole('tablist', { name: 'Project sections', exact: true }).getByRole('tab', { name, exact: true }).click()
}
async function ownersTab(name) {
  await projectTab('Owners')
  await page.getByRole('tablist', { name: 'Ownership sections', exact: true }).getByRole('tab', { name, exact: true }).click()
}
async function operatorsTab() {
  await page.getByRole('button', { name: 'More project sections', exact: true }).click()
  const menu = page.getByRole('menu', { name: 'More project sections', exact: true })
  await expect(menu).toBeVisible()
  await menu.getByRole('menuitemradio', { name: 'Operators', exact: true }).click()
  await expect(menu).toBeHidden()
  await expect(page.locator('.homerun-project-layout')).toHaveAttribute('data-project-tab', 'operators')
}
async function selectPhase(phase) {
  await projectTab('Stages')
  const controls = page.locator('.demo-modeling-controls')
  if (!await controls.evaluate(element => element.open)) await controls.locator(':scope > summary').click()
  const primary = ['earning', 'liquidated'].includes(phase) ? phase : 'raising'
  await page.locator(`.preview-base-buttons button[data-journey-phase="${primary}"]`).click()
  if (primary === 'raising') await page.locator(`.phase-buttons button[data-phase="${phase}"]`).click()
}
async function fits(selector = '[data-action-section]:visible') {
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Page must not overflow horizontally')
  for (const region of await page.locator(selector).all()) {
    const bounds = await region.boundingBox()
    assert.ok(bounds && bounds.x >= -1 && bounds.x + bounds.width <= page.viewportSize().width + 1, `${selector} fits the viewport`)
  }
}
async function openOther(section) {
  const details = guide(section).locator(':scope > details.pag-other')
  if (await details.count() && !await details.evaluate(element => element.open)) await details.locator(':scope > summary').click()
}
async function inspect(section, id) {
  const action = entry(section, id)
  await expect(action).toBeVisible()
  const details = action.locator(':scope > details')
  if (await details.count() && !await details.evaluate(element => element.open)) await details.locator(':scope > summary').click()
  await expect(action.locator('.pag-description')).toBeVisible()
  return action
}
async function accessible(selector) {
  const result = await new AxeBuilder({ page }).include(selector).withTags(['wcag2a', 'wcag2aa']).analyze()
  assert.deepEqual(result.violations.map(item => ({ id: item.id, description: item.description, nodes: item.nodes.map(node => node.target) })), [])
}

try {
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 960 })
    await page.goto(`${base}/founderhaus`, { waitUntil: 'domcontentloaded' })
    await expect(page.locator('.simulator')).toHaveAttribute('data-ready', 'true', { timeout: 60000 })
    await expect(globalCta).toHaveCount(0)

    // Each journey phase surfaces a short, relevant next-action list in place.
    const phases = {
      raising: ['contribute', 'fund-cashout', 'close'],
      funded: ['allowance', 'withdraw', 'income-launch'],
      refunding: ['refund', 'return', 'fail'],
      refunded: [],
      earning: ['income-pay', 'initial-income', 'stake'],
      liquidated: ['unstake', 'sale-claim', 'collect'],
    }
    for (const [phase, expected] of Object.entries(phases)) {
      await selectPhase(phase)
      if (expected.length) {
        await expect(guide('stages')).toHaveAttribute('data-action-stage', phase)
        assert.deepEqual(await guide('stages').locator('[data-project-action]').evaluateAll(nodes => nodes.map(node => node.dataset.projectAction)), expected)
        await expect(guide('stages').getByRole('heading', { name: 'Next actions', exact: true })).toBeVisible()
      } else {
        await expect(guide('stages')).toHaveCount(0)
      }
      await expect(globalCta).toHaveCount(0)
      await fits()
    }

    // A functional operator shortcut opens a review without changing the preview stage.
    await selectPhase('raising')
    await operatorsTab()
    const close = await inspect('operators', 'close')
    await close.getByRole('button', { name: 'Preview in demo', exact: true }).click()
    const ownerDialog = page.getByRole('dialog', { name: 'Close the raise', exact: true })
    await expect(ownerDialog).toBeVisible()
    await expect(ownerDialog).toContainText('Review only.')
    await expect(guide('operators')).toHaveAttribute('data-action-stage', 'raising')
    await page.keyboard.press('Escape')
    await expect(ownerDialog).toHaveCount(0)
    await expect(guide('operators')).toHaveAttribute('data-action-stage', 'raising')

    // Stages take the user to the existing payment, account and operator areas.
    await selectPhase('funded')
    await entry('stages', 'withdraw').getByRole('link', { name: 'Operators', exact: true }).click()
    await expect(page.locator('.homerun-project-layout')).toHaveAttribute('data-project-tab', 'operators')
    await expect(guide('operators')).toHaveAttribute('data-action-stage', 'funded')
    await inspect('operators', 'withdraw')
    await openOther('operators')
    const operatorShare = await inspect('operators', 'operator-share')
    await expect(operatorShare).toContainText('Issue the operator’s FUND share')
    await expect(guide('operators').locator('[data-project-action="fund-transfer"]')).toHaveCount(0)
    await expect(entry('operators', 'operator-share').getByRole('button', { name: 'Preview in demo', exact: true })).toHaveCount(0)
    await accessible('[data-action-section="operators"]')
    await fits()

    await selectPhase('earning')
    await entry('stages', 'income-pay').getByRole('link', { name: 'Payment panel', exact: true }).click()
    await expect(page.locator('#pay-panel')).toBeVisible()
    await expect(page).toHaveURL(/#pay-panel$/)
    await entry('stages', 'initial-income').getByRole('link', { name: 'Accounts', exact: true }).click()
    await expect(page.locator('.homerun-project-layout')).toHaveAttribute('data-project-tab', 'owners')
    await expect(page.locator('[data-account-section="you"]')).toBeVisible()
    await expect(page.locator('[data-account-section="all"]')).toBeVisible()
    await expect(guide('accounts')).toHaveCount(1)
    const initial = await inspect('accounts', 'initial-income')
    await expect(initial).toContainText('Snapshot recipient')
    await expect(initial).toContainText('Inactive balances and credits count.')
    await inspect('accounts', 'stake')
    await openOther('accounts')
    await inspect('accounts', 'fund-transfer')
    await inspect('accounts', 'income-transfer')
    await expect(guide('accounts').locator('[data-project-action="borrow"]')).toHaveCount(0)
    await accessible('[data-action-section="accounts"]')
    await fits()

    await ownersTab('Market')
    await inspect('market', 'income-cashout')
    await expect(guide('market').locator('[data-project-action="fund-cashout"]')).toHaveCount(0)
    await ownersTab('Settlement')
    await inspect('settlement', 'fund-bridge')
    await inspect('settlement', 'income-bridge')
    await ownersTab('Splits')
    const reserved = await inspect('splits', 'reserved')
    await expect(reserved).toContainText('Anyone')
    await openOther('splits')
    await inspect('splits', 'scheduled')
    await ownersTab('Loans')
    await inspect('loans', 'borrow')
    await inspect('loans', 'repay')
    await openOther('loans')
    await inspect('loans', 'refinance')
    await inspect('loans', 'transfer-loan')
    await accessible('[data-action-section="loans"]')
    await fits()

    // Refunds and asset sales show the corresponding cash-out controls in Market.
    await selectPhase('refunding')
    await entry('stages', 'refund').getByRole('link', { name: 'Market', exact: true }).click()
    await inspect('market', 'refund')
    await expect(guide('market').locator('[data-project-action="income-cashout"]')).toHaveCount(0)
    await selectPhase('liquidated')
    await entry('stages', 'sale-claim').getByRole('link', { name: 'Market', exact: true }).click()
    await inspect('market', 'sale-claim')
    await inspect('market', 'income-cashout')
    await operatorsTab()
    await expect(guide('operators')).toHaveAttribute('data-action-stage', 'liquidated')
    await inspect('operators', 'sale')
    await fits()

    await selectPhase('funded')
    await guide('stages').scrollIntoViewIfNeeded()
    await accessible('[data-action-section="stages"]')
    await page.screenshot({ path: `/tmp/homerun-project-actions-${width}.png` })
    console.log(`PASS ${width}px: contextual stage links, owner action sections, operator overflow navigation, accessible disclosures, and layout`)
  }

  // The Create catalogue remains unavailable until hydration, then works on the first click.
  let releaseScripts
  const scriptsReady = new Promise(resolve => { releaseScripts = resolve })
  await page.route('**/_next/static/**/*.js', async route => {
    await scriptsReady
    await route.continue()
  })
  try {
    await page.goto(`${base}/create`, { waitUntil: 'commit' })
    await expect(page.locator('#create-name')).toBeVisible()
    await expect(globalCta).toBeDisabled()
  } finally {
    releaseScripts()
  }
  await expect(globalCta).toBeEnabled({ timeout: 60000 })
  await globalCta.click()
  await expect(createDialog.getByRole('combobox', { name: 'Lifecycle stage', exact: true })).toHaveValue('create')
  await expect(createDialog.locator('[data-transaction="create"]')).toBeVisible()
  await expect(createDialog.getByRole('status')).toHaveText('1 action')
  await fits('dialog[open] [data-modal-card]')
  await accessible('dialog[open]')
  await page.keyboard.press('Escape')
  await expect(page.locator('[data-step-panel]')).toHaveAttribute('data-step-panel', '0')
  await expect(globalCta).toBeFocused()
  await page.locator('#create-name').fill('Transaction guide check')
  await page.locator('#create-next').click()
  await expect(page.locator('[data-step-panel]')).toHaveAttribute('data-step-panel', '1')
  await expect(page.getByRole('group', { name: 'Contractual Settings', exact: true })).toBeVisible()
  await page.locator('#create-next').click()
  await expect(page.locator('[data-step-panel]')).toHaveAttribute('data-step-panel', '2')
  await expect(page.getByRole('group', { name: 'Contractual Settings', exact: true })).toBeVisible()
  console.log('PASS Create: hydration guard, immediate catalogue, focus return, and matching Contractual Settings headings')
  assert.deepEqual(errors, [])
  console.log('PASS no JavaScript errors, wallet requests, or transactions required')
} finally {
  await browser.close()
}
