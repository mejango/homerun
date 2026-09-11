import assert from 'node:assert/strict'
import { chromium, expect } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'

const base = process.env.BASE_URL || 'http://localhost:3014'
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true })
const context = await browser.newContext({ reducedMotion: 'reduce' })
const page = await context.newPage()
page.setDefaultTimeout(30000)
page.setDefaultNavigationTimeout(180000)
const errors = []
page.on('pageerror', error => errors.push(error.message))
const tabs = page.getByRole('tablist', { name: 'Project sections', exact: true })
async function tab(name) {
  if (['Extras', 'Operators'].includes(name)) {
    const more = page.getByRole('button', { name: 'More project sections', exact: true })
    if (await more.getAttribute('aria-expanded') !== 'true') await more.click()
    await page.getByRole('menuitemradio', { name, exact: true }).click()
    await expect(more).toHaveAttribute('aria-expanded', 'false')
    await expect(page.locator('.homerun-project-layout')).toHaveAttribute('data-project-tab', name.toLowerCase())
    await expect(page.getByRole('tabpanel', { name, exact: true })).toBeVisible()
    return
  }
  await tabs.getByRole('tab', { name, exact: true }).click()
  await expect(tabs.getByRole('tab', { name, exact: true })).toHaveAttribute('aria-selected', 'true')
}
async function fits() {
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Page fits the viewport')
}
async function accessible(label) {
  const result = await new AxeBuilder({ page }).exclude('nextjs-portal').withTags(['wcag2a', 'wcag2aa']).analyze()
  assert.deepEqual(result.violations.map(v => ({ id: v.id, targets: v.nodes.map(n => n.target) })), [], label)
}
try {
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 960 })
    await page.goto(`${base}/founderhaus`, { waitUntil: 'domcontentloaded' })
    await expect(page.locator('.simulator')).toHaveAttribute('data-ready', 'true', { timeout: 120000 })
    await expect(tabs.getByRole('tab', { name: 'Overview', exact: true })).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByRole('heading', { name: 'About', exact: true })).toBeVisible()
    await expect(page.locator('#open-house-gallery')).toBeVisible()
    await expect(page.locator('.demo-overview-progress').getByRole('heading', { name: 'Progress', exact: true })).toBeVisible()
    const logo = await page.locator('.hpl-logo').boundingBox()
    assert.equal(logo.width, width > 800 ? 192 : 104, 'Project logo has the requested size')
    assert.equal(logo.height, logo.width, 'Project logo remains square')
    const funding = page.getByRole('progressbar', { name: 'Funding goal progress', exact: true })
    await expect(funding).toBeVisible()
    assert.ok(Math.abs(Number(await funding.getAttribute('aria-valuenow')) - 60) < 0.00001, 'Funding graph shows the modeled 60% raise')
    await expect(funding).toHaveAttribute('aria-valuetext', /\$369,230\.77 raised of \$615,384\.62 goal/)
    await expect(tabs.getByRole('tab', { name: 'Extras', exact: true })).toHaveCount(0)
    await expect(tabs.getByRole('tab', { name: 'Operators', exact: true })).toHaveCount(0)
    const more = page.getByRole('button', { name: 'More project sections', exact: true })
    await more.focus()
    await page.keyboard.press('ArrowDown')
    await expect(page.getByRole('menuitemradio', { name: 'Extras', exact: true })).toBeFocused()
    await page.keyboard.press('ArrowDown')
    await expect(page.getByRole('menuitemradio', { name: 'Operators', exact: true })).toBeFocused()
    await accessible(`Overflow menu ${width}`)
    await page.keyboard.press('Escape')
    await expect(more).toBeFocused()
    await expect(more).toHaveAttribute('aria-expanded', 'false')
    await page.locator('#pay-amount').fill('2500')
    await page.evaluate(() => { window.layoutPaymentInput = document.querySelector('#pay-amount') })
    await fits()
    await accessible(`Overview ${width}`)
    await page.screenshot({ path: `/tmp/homerun-project-layout-${width}.png`, fullPage: true })
    for (const name of ['Stages', 'Owners', 'Shop', 'Extras', 'Operators']) {
      await tab(name)
      await fits()
      await accessible(`${name} ${width}`)
      await expect(page.locator('#pay-amount')).toHaveValue('2500')
      assert.ok(await page.evaluate(() => window.layoutPaymentInput === document.querySelector('#pay-amount')), 'Payment keeps the same DOM node across tabs')
    }
    await tab('Owners')
    const ownerTabs = page.getByRole('tablist', { name: 'Ownership sections', exact: true })
    await ownerTabs.getByRole('tab', { name: 'Accounts', exact: true }).click()
    await expect(page.getByRole('tablist', { name: 'Accounts', exact: true })).toHaveCount(0)
    await expect(page.locator('[data-account-section="you"]')).toBeVisible()
    await expect(page.locator('[data-account-section="all"]')).toBeVisible()
    assert.equal(new URL(page.url()).hash, '#owners/accounts')
    await tab('Overview')
    await tab('Owners')
    await expect(ownerTabs.getByRole('tab', { name: 'Accounts', exact: true })).toHaveAttribute('aria-selected', 'true')
    await expect(page.locator('[data-account-section="you"]')).toBeVisible()
    await expect(page.locator('[data-account-section="all"]')).toBeVisible()
    for (const name of ['Market', 'Settlement', 'Splits', 'Loans']) {
      await ownerTabs.getByRole('tab', { name, exact: true }).click()
      await fits()
      await accessible(`Owners ${name} ${width}`)
    }
    await tab('Stages')
    await page.locator('.preview-base-buttons button[data-journey-phase="earning"]').click()
    await expect(page.locator('#scenario-title')).toHaveText('Collect revenue. Pay the bills.')
    await expect(page.getByRole('heading', { name: 'Looking ahead', exact: true })).toBeVisible()
    await page.getByRole('group', { name: 'Projection horizon' }).getByRole('button', { name: '3 years', exact: true }).click()
    await fits()
    await accessible(`Stages income ${width}`)
    await page.screenshot({ path: `/tmp/homerun-project-stages-${width}.png`, fullPage: true })
    if (width < 801) {
      await tab('Activity')
      await expect(page.getByRole('region', { name: 'Scenario activity', exact: true })).toBeVisible()
      await fits()
      await accessible(`Activity ${width}`)
    }
    console.log(`PASS ${width}px: six project sections, simultaneous accounts, overflow menu, funding graph, logo, retained payment, projections and accessibility`)
  }
  await page.goto(`${base}/founderhaus?layout=check#owners/accounts/all`, { waitUntil: 'domcontentloaded' })
  await expect(page.locator('[data-account-section=all]')).toBeVisible({ timeout: 120000 })
  await expect(page.locator('[data-account-section=you]')).toBeVisible()
  await tab('Stages')
  assert.equal(new URL(page.url()).search, '?layout=check')
  await page.goBack()
  await expect(page.locator('[data-account-section=all]')).toBeVisible()
  await expect(page.locator('[data-account-section=you]')).toBeVisible()
  await page.goForward()
  await expect(page.locator('#scenario-title')).toBeVisible()
  await tabs.getByRole('tab', { name: 'Stages', exact: true }).focus()
  await page.keyboard.press('ArrowRight')
  await expect(tabs.getByRole('tab', { name: 'Owners', exact: true })).toBeFocused()
  assert.deepEqual(errors, [])
  console.log('PASS shareable nested tabs, history, keyboard navigation and no JavaScript errors')
} finally {
  await browser.close()
}
