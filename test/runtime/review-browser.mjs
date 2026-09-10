import assert from 'node:assert/strict'
import { chromium } from '@playwright/test'

const origin = process.env.REVIEW_BASE_URL || 'http://localhost:3015'
const browser = await chromium.launch({
  headless: true,
  ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
})

try {
  for (const width of [1440, 375]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } })
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(`${origin}/runtime-review-check`, { waitUntil: 'networkidle', timeout: 120_000 })
    await page.getByRole('button', { name: 'Open fixture review' }).click()
    const dialog = page.getByRole('dialog', { name: 'Review fixture transaction' })
    await dialog.waitFor({ state: 'visible' })
    assert.equal(await dialog.getByText('Optimism', { exact: true }).count(), 1)
    const approve = dialog.getByRole('button', { name: 'Agree & continue', exact: true })
    assert.equal(await approve.isDisabled(), true)
    assert.equal(await page.evaluate(() => {
      document.querySelector('#background').focus()
      return Boolean(document.activeElement.closest('dialog[open]'))
    }), true, 'the background remains inert while reviewing')
    const geometry = await dialog.evaluate(element => ({
      width: element.getBoundingClientRect().width,
      headingSize: getComputedStyle(element.querySelector('h2')).fontSize,
      checkboxWidth: element.querySelector('input[type=checkbox]').getBoundingClientRect().width,
      footerDisplay: getComputedStyle(element.querySelector('footer')).display,
      footerWidth: element.querySelector('footer').getBoundingClientRect().width,
    }))
    assert.equal(Math.round(geometry.width), width, 'shared modal fills the viewport')
    assert.equal(geometry.headingSize, '20px', 'legacy dialog typography does not override review')
    assert.equal(geometry.checkboxWidth, 16, 'confirmation checkbox remains usable')
    assert.equal(geometry.footerDisplay, 'block', 'legacy page footer flex does not leak into review')
    assert.ok(geometry.footerWidth <= width, 'confirmation controls remain within the viewport')
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true)
    await dialog.screenshot({ path: `/tmp/homerun-review-${width}.png` })
    await dialog.getByText('Raw transaction payload', { exact: true }).click()
    assert.match(await dialog.locator('pre').innerText(), /0xa9059cbb/)
    await dialog.getByRole('checkbox').check()
    assert.equal(await approve.isEnabled(), true)
    await approve.click()
    await page.getByRole('status').filter({ hasText: 'Review approved.' }).waitFor()
    assert.equal(await page.getByRole('dialog').count(), 0)

    await page.getByRole('button', { name: 'Open fixture review' }).click()
    await dialog.waitFor({ state: 'visible' })
    await page.keyboard.press('Escape')
    await page.getByRole('status').filter({ hasText: 'Review cancelled.' }).waitFor()
    assert.deepEqual(errors, [])
    await page.close()
    console.log(`Transaction review ${width}px: exact payload, explicit approval, cancel, native focus, and layout passed.`)
  }
} finally {
  await browser.close()
}
