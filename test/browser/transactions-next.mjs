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
  const more = page.getByRole('button', { name: /^More project sections/ })
  if (await more.getAttribute('aria-expanded') !== 'true') await more.click()
  await expect(more).toHaveAttribute('aria-expanded', 'true')
  const operators = page.getByRole('tablist', { name: 'Project sections', exact: true }).getByRole('tab', { name: 'Operators', exact: true })
  await operators.click()
  await expect(operators).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByRole('menuitemradio')).toHaveCount(0)
  await expect(page.locator('.homerun-project-layout')).toHaveAttribute('data-project-tab', 'operators')
}
async function selectPhase(phase) {
  await projectTab('Stages')
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
  for (const more of await guide(section).getByRole('button', { name: /^More actions/ }).all()) {
    if (await more.getAttribute('aria-expanded') !== 'true') await more.click()
    await expect(more).toHaveAttribute('aria-expanded', 'true')
  }
}
async function inspect(section, id, text = [], keyboard = false) {
  const action = entry(section, id)
  await expect(action).toBeVisible()
  assert.equal(await action.evaluate(element => element.tagName), 'BUTTON', 'An available action is itself a button')
  if (keyboard) {
    await action.focus()
    await page.keyboard.press('Enter')
  } else await action.click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  await expect(dialog).toHaveAccessibleName(/\S/)
  assert.ok(await dialog.evaluate(element => element.contains(document.activeElement)), 'Opening a dialog moves focus inside')
  await expect(dialog.locator('.pag-description')).toBeVisible()
  for (const expected of text) await expect(dialog).toContainText(expected)
  await expect(dialog.getByRole('button', { name: 'Preview in demo', exact: true })).toHaveCount(0)
  if (keyboard) {
    await accessible('dialog[open]')
    await page.keyboard.press('Tab')
    assert.ok(await dialog.evaluate(element => element.contains(document.activeElement)), 'Tab keeps focus in the open dialog')
    await page.keyboard.press('Escape')
  } else await dialog.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect(action).toBeFocused()
}
async function stageActions(phase, expected) {
  await expect(page.locator('.demo-stage-history [data-project-action]')).toHaveCount(0)
  await expect(page.locator('.demo-stage-history [data-action-section]')).toHaveCount(0)
  const raise = ['raising', 'funded'].includes(phase)
  await expect(page.locator('[data-raise-actions]')).toHaveCount(raise ? 1 : 0)
  if (!expected.length) {
    await expect(guide('stages')).toHaveCount(0)
    return
  }
  await expect(guide('stages')).toHaveAttribute('data-action-stage', phase)
  assert.deepEqual(await guide('stages').locator('[data-project-action]').evaluateAll(nodes => nodes.map(node => node.dataset.projectAction)), expected)
  await expect(guide('stages').getByRole('heading')).toHaveCount(0)
  await expect(guide('stages').locator('[data-project-action="contribute"], [data-project-action="income-pay"]')).toHaveCount(0)
  if (raise) {
    await expect(page.locator('.phase-panel + [data-raise-actions] [data-action-section="stages"]')).toBeVisible()
  } else {
    await expect(page.locator('.phase-panel + [data-action-section="stages"]')).toBeVisible()
  }
  assert.ok(await guide('stages').locator('[data-project-action]').evaluateAll((nodes, tag) => nodes.every(node => node.tagName === tag), raise ? 'BUTTON' : 'A'), raise ? 'Raise actions open local review dialogs' : 'Holder stage actions navigate to account controls')
}
async function accountAction(id, token) {
  const action = entry('accounts', id)
  await expect(action).toBeVisible()
  await expect(action.locator('xpath=ancestor::*[@data-account-section][1]')).toHaveAttribute('data-account-section', 'you')
  await expect(action.locator('xpath=ancestor::dl[1]')).toHaveClass(/demo-account-balances/)
  await expect(action.locator('xpath=ancestor::dd[1]/parent::div/dt')).toHaveText(token)
}
async function marketWithoutActions() {
  await ownersTab('Market')
  const market = page.getByRole('tabpanel', { name: 'Market', exact: true })
  await expect(market.getByRole('heading', { name: 'FUND', exact: true })).toBeVisible()
  await expect(market.getByRole('heading', { name: 'INCOME', exact: true })).toBeVisible()
  await expect(market.locator('[data-project-action]')).toHaveCount(0)
  await expect(guide('market')).toHaveCount(0)
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

    // Actions belong below the current phase card, never inside the history.
    const phases = {
      raising: ['pause', 'fail', 'return'],
      funded: ['pause', 'withdraw', 'offchain'],
      refunding: [],
      refunded: [],
      earning: ['initial-income', 'stake'],
      liquidated: ['unstake', 'collect'],
    }
    for (const [phase, expected] of Object.entries(phases)) {
      await selectPhase(phase)
      await stageActions(phase, expected)
      await expect(globalCta).toHaveCount(0)
      await fits()
    }

    // Reaching the goal changes guidance without changing the modeled phase.
    await selectPhase('raising')
    const progress = page.locator('#field-raisedPercent')
    await progress.fill('60')
    await stageActions('raising', phases.raising)
    assert.deepEqual(await guide('stages').getByRole('button').allTextContents(), ['Pause raise', 'Open refunds', 'Inject funds'])
    await inspect('stages', 'pause', [], true)
    await inspect('stages', 'return')
    const refunds = entry('stages', 'fail')
    await expect(refunds).toHaveAttribute('data-owner-action', 'enable_refunds')
    await refunds.focus()
    await page.keyboard.press('Enter')
    const refundDialog = page.getByRole('dialog', { name: 'Enable refunds', exact: true })
    await expect(refundDialog).toBeVisible()
    await expect(refundDialog).toContainText('Review only.')
    await page.keyboard.press('Escape')
    await expect(refundDialog).toHaveCount(0)
    await expect(refunds).toBeFocused()
    await stageActions('raising', phases.raising)
    await page.locator('[data-raise-actions]').scrollIntoViewIfNeeded()
    await accessible('[data-raise-actions]')
    await page.screenshot({ path: `/tmp/homerun-raise-actions-${width}.png` })

    await progress.fill('100')
    await stageActions('raising', phases.funded)
    await expect(page.locator('.phase-buttons button[data-phase="raising"]')).toHaveAttribute('aria-pressed', 'true')
    await expect(entry('stages', 'withdraw')).toHaveText('Withdraw funds')
    await expect(entry('stages', 'offchain')).toHaveText('Mint tokens for offchain contributions')
    await inspect('stages', 'withdraw')
    await inspect('stages', 'offchain')
    await progress.fill('60')
    await stageActions('raising', phases.raising)

    // Refund scenarios do not regain purchase controls even at 100% raised.
    for (const phase of ['refunding', 'refunded']) {
      await selectPhase(phase)
      await progress.fill('100')
      await stageActions(phase, [])
    }
    await selectPhase('raising')
    await progress.fill('60')

    // Cash-out controls sit first beside the corresponding balance under You.
    await ownersTab('Accounts')
    await accountAction('fund-cashout', 'FUND')
    assert.deepEqual(await entry('accounts', 'fund-cashout').locator('xpath=ancestor::section[@data-action-section][1]').locator('[data-project-action]:visible').evaluateAll(nodes => nodes.map(node => node.dataset.projectAction)), ['fund-cashout', 'fund-credit', 'fund-transfer'])
    await inspect('accounts', 'fund-cashout')
    await marketWithoutActions()

    // Fundraise controls are not duplicated in the back office.
    await operatorsTab()
    for (const id of ['pause', 'close', 'fail', 'return', 'withdraw', 'offchain']) await expect(entry('operators', id)).toHaveCount(0)

    await selectPhase('funded')
    await stageActions('funded', phases.funded)
    await inspect('stages', 'withdraw', [], true)
    await guide('stages').scrollIntoViewIfNeeded()
    await accessible('[data-raise-actions]')
    await page.screenshot({ path: `/tmp/homerun-funded-actions-${width}.png` })
    await operatorsTab()
    await expect(guide('operators')).toHaveAttribute('data-action-stage', 'funded')
    for (const id of ['pause', 'close', 'fail', 'return', 'withdraw', 'offchain']) await expect(entry('operators', id)).toHaveCount(0)
    await page.getByRole('button', { name: 'Prepare purchase & allocation', exact: true }).click()
    const purchaseDialog = page.getByRole('dialog', { name: 'Complete purchase and issue revenue tokens', exact: true })
    await expect(purchaseDialog).toBeVisible()
    await expect(purchaseDialog).toContainText('Review only.')
    await page.keyboard.press('Escape')
    await expect(purchaseDialog).toHaveCount(0)
    await expect(guide('operators')).toHaveAttribute('data-action-stage', 'funded')
    await openOther('operators')
    await inspect('operators', 'operator-share', ['Issue the Owner’s FUND share'])
    await expect(guide('operators').locator('[data-project-action="fund-transfer"]')).toHaveCount(0)
    assert.equal(await entry('operators', 'operator-share').getAttribute('data-owner-action'), null)
    await accessible('[data-action-section="operators"]')
    await fits()

    await selectPhase('earning')
    await entry('stages', 'initial-income').click()
    await expect(page.locator('.homerun-project-layout')).toHaveAttribute('data-project-tab', 'owners')
    await expect(page.locator('[data-account-section="you"]')).toBeVisible()
    await expect(page.locator('[data-account-section="all"]')).toBeVisible()
    await expect(guide('accounts')).toHaveCount(3)
    await accountAction('fund-transfer', 'FUND')
    await accountAction('income-cashout', 'INCOME')
    await expect(entry('accounts', 'fund-cashout')).toHaveCount(0)
    await expect(entry('accounts', 'stake').locator('xpath=ancestor::dl')).toHaveCount(0)
    await inspect('accounts', 'income-cashout', [], true)
    await inspect('accounts', 'initial-income', ['Claim the initial INCOME allocation', 'Snapshot recipient', 'Inactive balances and credits count.'])
    await inspect('accounts', 'stake')
    await openOther('accounts')
    await accountAction('income-transfer', 'INCOME')
    await inspect('accounts', 'fund-transfer')
    await inspect('accounts', 'income-transfer')
    await expect(guide('accounts').locator('[data-project-action="borrow"]')).toHaveCount(0)
    await accessible('[data-action-section="accounts"]')
    await fits()
    await page.locator('[data-account-section="you"]').scrollIntoViewIfNeeded()
    await page.screenshot({ path: `/tmp/homerun-account-actions-${width}.png` })

    await marketWithoutActions()
    await ownersTab('Settlement')
    await inspect('settlement', 'fund-bridge')
    await inspect('settlement', 'income-bridge')
    await ownersTab('Splits')
    await inspect('splits', 'reserved', ['Anyone'])
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

    // Refund and sale claims stay beside FUND; INCOME retains its separate cash-out.
    await selectPhase('refunding')
    await ownersTab('Accounts')
    await accountAction('refund', 'FUND')
    await inspect('accounts', 'refund')
    await expect(entry('accounts', 'income-cashout')).toHaveCount(0)
    await marketWithoutActions()
    await selectPhase('liquidated')
    await entry('stages', 'unstake').click()
    await accountAction('sale-claim', 'FUND')
    await accountAction('income-cashout', 'INCOME')
    await inspect('accounts', 'sale-claim')
    await inspect('accounts', 'income-cashout')
    await marketWithoutActions()
    await operatorsTab()
    await expect(guide('operators')).toHaveAttribute('data-action-stage', 'liquidated')
    await inspect('operators', 'sale')
    await fits()

    await selectPhase('funded')
    await guide('stages').scrollIntoViewIfNeeded()
    await accessible('[data-action-section="stages"]')
    await page.screenshot({ path: `/tmp/homerun-project-actions-${width}.png` })
    console.log(`PASS ${width}px: raise footer actions, goal-aware guidance, refund exclusions, per-token account cash-outs, review dialogs, operator deduplication, and accessibility`)
  }

  // Create renders its own setup flow without the old global action catalogue,
  // before or after JavaScript hydrates the native form.
  let releaseScripts
  const scriptsReady = new Promise(resolve => { releaseScripts = resolve })
  await page.route('**/_next/static/**/*.js', async route => {
    await scriptsReady
    await route.continue()
  })
  try {
    await page.goto(`${base}/create`, { waitUntil: 'commit' })
    await expect(page.locator('#create-name')).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Design the rules', exact: true })).toBeVisible()
    await expect(globalCta).toHaveCount(0)
  } finally {
    releaseScripts()
  }
  await expect(page.locator('#draft-status')).toHaveText('Draft saved in this browser', { timeout: 60000 })
  await expect(globalCta).toHaveCount(0)
  await expect(page.locator('[data-step-panel]')).toHaveAttribute('data-step-panel', '0')
  await page.locator('#create-name').fill('Transaction guide check')
  await expect(page.locator('#draft-name')).toHaveText('Transaction guide check')
  await page.locator('#create-next').click()
  await expect(page.locator('[data-step-panel]')).toHaveAttribute('data-step-panel', '1')
  const contractualSettings = page.getByRole('group', { name: 'Contractual settings', exact: true })
  await expect(contractualSettings).toBeVisible()
  await expect(contractualSettings.locator('#create-operatorFundPercent')).toBeVisible()
  await expect(page.getByRole('group', { name: 'Modeling inputs', exact: true }).locator('#create-purchaseBudget')).toBeVisible()
  await page.locator('#create-next').click()
  await expect(page.locator('[data-step-panel]')).toHaveAttribute('data-step-panel', '2')
  await expect(contractualSettings).toBeVisible()
  await expect(contractualSettings.locator('#create-operatorSplitPercent')).toBeVisible()
  await expect(contractualSettings.locator('#create-stickySplitPercent')).toBeVisible()
  await page.locator('#create-next').click()
  await expect(page.locator('[data-step-panel]')).toHaveAttribute('data-step-panel', '3')
  await expect(page.getByRole('heading', { name: 'Launch the FUND raise', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Save metadata and prepare deployment', exact: true })).toBeDisabled()
  await expect(globalCta).toHaveCount(0)
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await fits('#create-workspace')
  console.log('PASS Create: no global catalogue before/after hydration, native setup steps, contextual settings and wallet-gated FUND preparation')
  assert.deepEqual(errors, [])
  console.log('PASS no JavaScript errors, wallet requests, or transactions required')
} finally {
  await browser.close()
}
