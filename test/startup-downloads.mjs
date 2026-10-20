// The route budget reads each page's HTML; this covers what a page downloads on its own once it hydrates. Without an
// interaction, no vendor wallet SDK downloads. Runs against the production build test:center serves.
import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { vendorWallets } from '../scripts/lib/vendor-wallets.mjs'
import { centerPort } from './support/browser-suites.mjs'

const base = process.env.BASE_URL || `http://127.0.0.1:${centerPort}`
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, headless: true })
let failed = 0
try {
  // Positive control: every vendor still ships its markers in some chunk, so a renamed marker cannot pass silently.
  if (process.env.STARTUP_CHUNKS_DIR) {
    const dir = process.env.STARTUP_CHUNKS_DIR
    const files = (await readdir(dir, { recursive: true })).filter(file => file.endsWith('.js'))
    const all = await Promise.all(files.map(file => readFile(join(dir, file), 'utf8')))
    for (const [label, markers] of vendorWallets) assert.ok(all.some(source => markers.some(marker => source.includes(marker))), `${label} markers match no built chunk`)
  }
  for (const path of ['/', '/founderhaus']) {
    const page = await browser.newPage()
    const bodies = []
    page.on('response', response => { if (response.url().includes('/_next/static/chunks/')) bodies.push(response.text().catch(() => '')) })
    await page.goto(base + path, { waitUntil: 'load' })
    await page.waitForLoadState('networkidle')
    // Idle preloads (project panels, sign-in) start after load; give them time to land.
    await page.waitForTimeout(3000)
    const sources = await Promise.all(bodies)
    try {
      assert.ok(sources.length > 0, 'no chunks were seen')
      for (const [label, markers] of vendorWallets) {
        const eager = sources.filter(source => markers.some(marker => source.includes(marker)))
        assert.equal(eager.length, 0, `${label} SDK downloaded at startup`)
      }
      console.log(`PASS ${path} downloads no vendor wallet SDK before an interaction`)
    } catch (error) {
      failed++
      console.log(`FAIL ${path}: ${error.message}`)
    }
    await page.close()
  }
} finally {
  await browser.close()
}
process.exitCode = failed ? 1 : 0
