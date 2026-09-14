// Actual enabled Next app and pinned Center SDK. Center responses are explicitly
// modeled here; this is not server authorization, passkey or chain evidence.
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { chromium } from 'playwright'
import { expect } from '@playwright/test'
const base = process.env.BASE_URL || 'http://localhost:54064'
const issuer = 'https://wallet.homerun.test', audience = 'https://api.homerun.test'
const wallet = '0x1111111111111111111111111111111111111111'
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true })
const context = await browser.newContext({ viewport: { width: 1200, height: 900 }, reducedMotion: 'reduce' })
const page = await context.newPage(), errors = []
page.on('pageerror', error => errors.push(error.name))
page.setDefaultTimeout(15000)
const intentId = randomBytes(32).toString('base64url'), code = randomBytes(32).toString('base64url')
let request, originalExchange, grant, exchanges = 0, held, release
const prepared = new Promise(resolve => { held = resolve })
const continuing = new Promise(resolve => { release = resolve })
const cors = { 'access-control-allow-origin': base, 'access-control-allow-headers': 'content-type,x-center-wallet-request',
  'access-control-allow-methods': 'GET,POST,OPTIONS', 'cache-control': 'no-store' }
await context.route(issuer + '/**', async route => {
  const http = route.request(), url = new URL(http.url())
  if (http.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors })
  const json = value => route.fulfill({ json: value, headers: cors })
  if (url.pathname === '/wallet/config') return json({ version: 'center-wallet-v1', issuer, audience, rpId: new URL(issuer).hostname,
    app: { origin: base, callbackUris: [base + '/center/callback'], generation: 1 } })
  if (url.pathname === '/wallet/handoff/prepare') {
    assert.equal(http.headers().cookie, undefined)
    request = http.postDataJSON().request
    assert.equal(request.callbackUri, base + '/center/callback')
    assert.equal(request.origin, base); assert.equal(request.issuer, issuer)
    assert.match(request.requestKey, /^0x[0-9a-f]{40}$/)
    held(); await continuing
    return json({ id: intentId, request, state: 'prepared', createdAtMs: Date.now(), expiresAtMs: request.expiresAtMs })
  }
  if (url.pathname === '/wallet') {
    assert.equal(url.searchParams.get('intent'), intentId)
    const callback = new URL(base + '/center/callback')
    callback.searchParams.set('code', code); callback.searchParams.set('state', request.state); callback.searchParams.set('iss', issuer)
    return route.fulfill({ contentType: 'text/html', body: `<h1>Modeled Center approval</h1><a href="${callback.href.replaceAll('&', '&amp;')}">Return to Homerun</a>` })
  }
  if (url.pathname === '/wallet/handoff/exchange') {
    assert.equal(http.headers().cookie, undefined)
    assert.equal(page.url(), base + '/center/callback', 'callback secrets are scrubbed before exchange')
    const body = http.postDataJSON()
    if (originalExchange) assert.deepEqual(body, originalExchange, 'retry preserves the exact signed exchange')
    else originalExchange = body
    assert.equal(body.intentId, intentId); assert.equal(body.code, code); assert.deepEqual(body.request, request)
    exchanges++
    if (!grant) {
      const now = Math.floor(Date.now() / 1000)
      grant = { kind: 'wallet-app', id: randomUUID(), incarnation: '1', accountId: 'eip155:8453:' + wallet,
        signerAddress: request.requestKey, scopes: ['read', 'plan', 'relay'], origin: base, callbackUri: base + '/center/callback',
        audience, appGeneration: 1, authorityEpoch: '1', sessionEpoch: '1', createdAt: now, expiresAt: now + 3600, revokedAt: null, retainUntil: now + 3600 + 86400 }
    }
    if (exchanges === 1) return route.abort('failed')
    return json({ grant, replayed: true })
  }
  return route.fulfill({ status: 404 })
})
try {
  const callback = await context.request.get(base + '/center/callback')
  assert.equal(callback.headers()['cache-control'], 'no-store')
  assert.equal(callback.headers()['referrer-policy'], 'no-referrer')
  await page.goto(base + '/founderhaus')
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await page.getByRole('button', { name: 'Continue with a passkey' }).click()
  await prepared
  await page.getByRole('button', { name: 'Close', exact: true }).click()
  release()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await page.waitForTimeout(300)
  assert.equal(page.url(), base + '/founderhaus', 'closing the chooser cancels delayed navigation')
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await page.getByRole('button', { name: 'Continue with a passkey' }).click()
  await page.getByRole('heading', { name: 'Modeled Center approval' }).waitFor()
  await page.getByRole('link', { name: 'Return to Homerun' }).click()
  await page.getByRole('button', { name: 'Retry', exact: true }).click()
  await expect(page).toHaveURL(base + '/founderhaus')
  await expect(page.getByRole('button', { name: /^Signed in as/ })).toBeVisible()
  assert.equal(exchanges, 2)
  await page.reload()
  await expect(page.getByRole('button', { name: /^Signed in as/ })).toBeVisible()
  const account = await page.evaluate(() => JSON.parse(sessionStorage.getItem(Object.keys(sessionStorage).find(key => key.startsWith('center.wallet.connection.v1:')))).grant.accountId)
  assert.equal(account, 'eip155:8453:' + wallet)
  await page.getByRole('button', { name: /^Signed in as/ }).click()
  await page.getByRole('menuitem', { name: 'Sign out' }).click()
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible()
  assert.equal(await page.evaluate(() => Object.keys(sessionStorage).filter(key => key.startsWith('center.wallet.connection.v1:')).length), 0)
  assert.deepEqual(errors, [])
  await mkdir('test-results/center-wallet', { recursive: true })
  await page.screenshot({ path: 'test-results/center-wallet/homerun.png', fullPage: true })
  await writeFile('test-results/center-wallet/summary.json', JSON.stringify({ passed: true, browser: browser.version(),
    evidence: 'real Next app and packaged SDK; modeled Center responses', delayedRedirectCancelled: true,
    originalExchangeRecovered: true, callbackScrubbed: true, reloadRestored: true, disconnectCleared: true, exchanges, pageErrors: errors }, null, 2))
  console.log('PASS enabled Homerun: chooser cancellation, SDK handoff, callback scrubbing, exact retry, original-page restoration, reload and disconnect')
} finally { await browser.close() }
