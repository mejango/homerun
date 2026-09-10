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
const cta = page.getByRole('button', { name: 'Available transactions', exact: true })
const dialog = page.getByRole('dialog', { name: 'Available transactions', exact: true })
async function selectPhase(phase) {
  await page.getByRole('tablist', { name: 'Project sections', exact: true }).getByRole('tab', { name: 'Stages', exact: true }).click()
  const primary = ['earning', 'liquidated'].includes(phase) ? phase : 'raising'
  await page.locator(`.preview-base-buttons button[data-journey-phase="${primary}"]`).click()
  if (primary === 'raising') await page.locator(`.phase-buttons button[data-phase="${phase}"]`).click()
}
async function fits() {
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1))
  const bounds = await dialog.locator('[data-modal-card]').boundingBox()
  assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= page.viewportSize().width + 1)
}
try {
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 960 })
    await page.goto(`${base}/founderhaus`, { waitUntil: 'domcontentloaded' })
    await expect(page.locator('.simulator')).toHaveAttribute('data-ready', 'true', { timeout: 60000 })
    for (const phase of ['raising', 'funded', 'refunding', 'refunded', 'earning', 'liquidated']) {
      await selectPhase(phase)
      await expect(cta).toBeVisible()
      await cta.click()
      await expect(dialog).toBeVisible()
      await expect(dialog.getByRole('combobox', { name: 'Lifecycle stage', exact: true })).toHaveValue(phase)
      await expect(dialog.getByRole('list', { name: 'Transaction guide' })).toBeVisible()
      await fits()
      await page.keyboard.press('Escape')
      await expect(dialog).toHaveCount(0)
      await expect(cta).toBeFocused()
    }
    await selectPhase('funded')
    await cta.click()
    await dialog.getByRole('combobox', { name: 'Role', exact: true }).selectOption('operator')
    await expect(dialog.getByRole('heading', { name: 'Issue the operator’s FUND share', exact: true })).toBeVisible()
    await expect(dialog.locator('[data-transaction="fund-transfer"]')).toHaveCount(0)
    await dialog.getByRole('combobox', { name: 'Lifecycle stage', exact: true }).selectOption('earning')
    await dialog.getByRole('combobox', { name: 'Role', exact: true }).selectOption('fund')
    await expect(dialog.locator('[data-transaction="initial-income"]')).toBeVisible()
    await expect(dialog.locator('[data-transaction="stake"]')).toBeVisible()
    await expect(dialog.locator('[data-transaction="reserved"]')).toBeVisible()
    await expect(dialog.locator('[data-transaction="borrow"]')).toHaveCount(0)
    await dialog.getByRole('combobox', { name: 'Lifecycle stage', exact: true }).selectOption('all')
    await dialog.getByRole('combobox', { name: 'Role', exact: true }).selectOption('all')
    await expect(dialog.locator('[data-transaction="borrow"]')).toBeVisible()
    await expect(dialog.locator('[data-transaction="sale-claim"]')).toBeVisible()
    await expect(dialog.getByRole('link', { name: 'Find a live project' })).toHaveAttribute('href', '/projects')
    await fits()
    const accessibility = await new AxeBuilder({ page }).include('dialog[open]').withTags(['wcag2a', 'wcag2aa']).analyze()
    assert.deepEqual(accessibility.violations.map(item => ({ id: item.id, description: item.description })), [])
    await page.screenshot({ path: `/tmp/homerun-transactions-${width}.png` })
    await page.keyboard.press('Escape')
    await selectPhase('funded')
    await cta.scrollIntoViewIfNeeded()
    await page.screenshot({ path: `/tmp/homerun-transactions-cta-${width}.png` })
    console.log(`PASS ${width}px: six stages, role filters, full catalogue, focus return, links, layout and accessibility`)
  }
  let releaseScripts
  const scriptsReady = new Promise(resolve => { releaseScripts = resolve })
  await page.route('**/_next/static/**/*.js', async route => {
    await scriptsReady
    await route.continue()
  })
  try {
    await page.goto(`${base}/create`, { waitUntil: 'commit' })
    await expect(page.locator('#create-name')).toBeVisible()
    await expect(cta).toBeDisabled()
  } finally {
    releaseScripts()
  }
  await expect(cta).toBeEnabled({ timeout: 60000 })
  await cta.click()
  await expect(dialog.getByRole('combobox', { name: 'Lifecycle stage', exact: true })).toHaveValue('create')
  await expect(dialog.locator('[data-transaction="create"]')).toBeVisible()
  await expect(dialog.getByRole('status')).toHaveText('1 action')
  await page.keyboard.press('Escape')
  await expect(page.locator('[data-step-panel]')).toHaveAttribute('data-step-panel', '0')
  await expect(cta).toBeFocused()
  console.log('PASS Create: waits for JavaScript, then works on the first click before filling or submitting the form')
  assert.deepEqual(errors, [])
  console.log('PASS no JavaScript errors or wallet required')
} finally {
  await browser.close()
}
