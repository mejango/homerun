// The route budget reads each page's HTML; this covers what a page downloads on its own once it hydrates, idle
// preloads included. Without an interaction, no vendor wallet SDK downloads, and the JavaScript a page fetches by the
// time it is idle stays under its ceiling (KiB of gzip; lower it when a change lands under it). Runs against the
// production build test:center serves.
import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { chromium } from 'playwright'
import { vendorWallets } from '../scripts/lib/vendor-wallets.mjs'
import { centerPort } from './support/browser-suites.mjs'

const base = process.env.BASE_URL || `http://127.0.0.1:${centerPort}`
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, headless: true })
let failed = 0
const idleCeilings = { '/': 214, '/founderhaus': 302, '/create': 430 }
try {
  // Positive control: every vendor still ships its markers in some chunk, so a renamed marker cannot pass silently.
  if (process.env.STARTUP_CHUNKS_DIR) {
    const dir = process.env.STARTUP_CHUNKS_DIR
    const files = (await readdir(dir, { recursive: true })).filter(file => file.endsWith('.js'))
    const all = await Promise.all(files.map(file => readFile(join(dir, file), 'utf8')))
    for (const [label, markers] of vendorWallets) assert.ok(all.some(source => markers.some(marker => source.includes(marker))), `${label} markers match no built chunk`)
  }
  for (const [path, ceiling] of Object.entries(idleCeilings)) {
    const page = await browser.newPage()
    const bodies = new Map()
    page.on('response', response => {
      const url = response.url().split('?')[0]
      if (url.includes('/_next/static/chunks/') && url.endsWith('.js') && !bodies.has(url)) bodies.set(url, response.text().catch(() => ''))
    })
    await page.goto(base + path, { waitUntil: 'load' })
    await page.waitForLoadState('networkidle')
    // Idle preloads start by preloadWhenIdle's 4 s deadline; wait past it, then until no chunk has arrived for 1 s.
    await page.waitForTimeout(4500)
    for (let seen = -1; seen !== bodies.size;) { seen = bodies.size; await page.waitForTimeout(1000) }
    const sources = await Promise.all(bodies.values())
    try {
      assert.ok(sources.length > 0, 'no chunks were seen')
      for (const [label, markers] of vendorWallets) {
        const eager = sources.filter(source => markers.some(marker => source.includes(marker)))
        assert.equal(eager.length, 0, `${label} SDK downloaded at startup`)
      }
      const idle = sources.reduce((sum, source) => sum + gzipSync(source).byteLength, 0) / 1024
      assert.ok(idle <= ceiling, `${idle.toFixed(1)} KiB of JavaScript by idle, over its ${ceiling} KiB ceiling`)
      console.log(`PASS ${path} downloads no vendor wallet SDK before an interaction, ${idle.toFixed(1)} / ${ceiling} KiB of JavaScript by idle`)
    } catch (error) {
      failed++
      console.log(`FAIL ${path}: ${error.message}`)
    }
    await page.close()
  }
  // A browser caches a failed dynamic import, so a retry in the page cannot recover; the failure state must offer a
  // reload, and the reload must recover. Every chunk requested after load fails once here.
  const page = await browser.newPage()
  try {
    let failLazy = false
    await page.route('**/_next/static/chunks/**', route => failLazy ? route.abort('failed') : route.continue())
    await page.goto(base + '/founderhaus', { waitUntil: 'load' })
    failLazy = true
    await page.getByRole('tab', { name: 'Shop' }).click()
    const reload = page.getByRole('button', { name: 'Reload the page to try again' })
    await reload.first().waitFor({ timeout: 15000 })
    assert.equal(await page.locator('.demo-project-shop').count(), 0)
    failLazy = false
    await Promise.all([page.waitForEvent('load'), reload.first().click()])
    await page.getByRole('tab', { name: 'Shop' }).click()
    await page.locator('.demo-project-shop').waitFor({ timeout: 15000 })
    assert.equal(await reload.count(), 0)
    console.log('PASS a lazy chunk that fails offers a reload, and the reload recovers')
  } catch (error) {
    failed++
    console.log(`FAIL lazy chunk failure: ${error.message}`)
  } finally {
    await page.close()
  }
} finally {
  await browser.close()
}
process.exitCode = failed ? 1 : 0
