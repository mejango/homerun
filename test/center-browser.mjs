// Actual enabled Next app and pinned Center SDK. Center responses are explicitly
// modeled here; this is not server authorization, passkey or chain evidence.
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { chromium } from 'playwright'
import { expect } from '@playwright/test'
const base = process.env.BASE_URL || 'http://localhost:54064'
const issuer = 'https://signa.center', audience = 'https://api.signa.center'
const wallet = '0x1111111111111111111111111111111111111111'
// The modeled issuer is a public https origin while the app is on localhost; Chrome's local network access
// checks would otherwise block the frame's navigation from the one to the other, which production never has.
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true,
  args: ['--disable-features=LocalNetworkAccessChecks,LocalNetworkAccessForNavigations,PrivateNetworkAccessForNavigations'] })
const context = await browser.newContext({ viewport: { width: 1200, height: 900 }, reducedMotion: 'reduce' })
const page = await context.newPage(), errors = []
page.on('pageerror', error => errors.push(error.name))
page.setDefaultTimeout(15000)
const intentId = randomBytes(32).toString('base64url'), code = randomBytes(32).toString('base64url')
let request, originalExchange, grant, exchanges = 0, launches = 0, held, release, holdExchange, releaseExchange
const prepared = new Promise(resolve => { held = resolve })
const continuing = new Promise(resolve => { release = resolve })
const exchangeStarted = new Promise(resolve => { holdExchange = resolve })
const continueExchange = new Promise(resolve => { releaseExchange = resolve })
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
    return route.fulfill({ contentType: 'text/html', body: `<h1>Modeled Center approval</h1><a href="${callback.href.replaceAll('&', '&amp;')}">Return to Homerun</a>
      <script>addEventListener('message',event=>{if(event.source===parent&&event.origin===${JSON.stringify(base)}&&event.data?.type==='juicebox-center:theme'){
        const font=event.data.theme?.headingFont;if(typeof font==='string')document.documentElement.dataset.headingFont=font;
      }});parent.postMessage({type:'juicebox-center:size',height:240},${JSON.stringify(base)});</script>` })
  }
  if (url.pathname === '/wallet/launch') {
    assert.equal(http.method(), 'POST');assert.equal(http.headers().origin, base)
    // The launch form is submitted into the frame the dialog shows, never into this page or a popup.
    assert.equal(http.isNavigationRequest(), true);assert.equal(http.resourceType(), 'document')
    assert.equal(http.frame().name(), 'juicebox-center-frame')
    const form = new URLSearchParams(http.postData())
    assert.deepEqual([...form.keys()].sort(), ['intentId', 'signature']);assert.equal(form.get('intentId'), intentId)
    assert.match(form.get('signature'), /^0x[0-9a-f]{130}$/);launches++
    // Use a new navigation to keep the modeled issuer entirely intercepted;
    // Playwright routes only the first request in an HTTP redirect chain.
    return route.fulfill({contentType:'text/html',body:'<script>location.replace('+JSON.stringify(issuer+'/wallet?intent='+intentId)+')</script>'})
  }
  if (url.pathname === '/wallet/handoff/exchange') {
    assert.equal(http.headers().cookie, undefined)
    // The exchange runs in the original page after the frame handed its callback up.
    assert.equal(page.url(), base + '/founderhaus', 'the page never left for the exchange')
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
    if (exchanges === 1) { holdExchange(); await continueExchange; return route.abort('failed') }
    return json({ grant, replayed: true })
  }
  return route.fulfill({ status: 404 })
})
try {
  const callback = await context.request.get(base + '/center/callback')
  assert.equal(callback.headers()['cache-control'], 'no-store')
  assert.equal(callback.headers()['referrer-policy'], 'strict-origin')
  await page.goto(base + '/founderhaus')
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.locator('.jb-connect-powered')).toHaveText('with Signa')
  const close = page.getByRole('button', { name: 'Cancel', exact: true })
  const closeBox = await close.boundingBox(), titleBox = await page.getByRole('heading', { name: 'Sign in', exact: true }).boundingBox()
  const dialogBox = await page.getByRole('dialog').boundingBox()
  assert.ok(closeBox && titleBox && dialogBox && closeBox.width >= 44 && closeBox.height >= 44 &&
    closeBox.y < titleBox.y + titleBox.height && closeBox.x > dialogBox.x + dialogBox.width / 2 &&
    closeBox.x + closeBox.width <= dialogBox.x + dialogBox.width,
    'the accessible cancellation control is a full-size top-right X')
  await close.focus(); await expect(close).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeFocused()
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await page.locator('.jb-connect-primary').click()
  await prepared
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  release()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await page.waitForTimeout(300)
  assert.equal(page.url(), base + '/founderhaus', 'closing the chooser cancels delayed navigation')
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await page.locator('.jb-connect-primary').click()
  // Center opens in a frame inside the dialog; the page stays on the project and opens no window.
  const frame = page.frameLocator('iframe[name="juicebox-center-frame"]')
  await frame.getByRole('heading', { name: 'Modeled Center approval' }).waitFor()
  const headingFont = await page.getByRole('heading', { name: 'Sign in', exact: true }).evaluate(node => getComputedStyle(node).fontFamily)
  await expect(frame.locator('html')).toHaveAttribute('data-heading-font', headingFont)
  assert.equal(page.url(), base + '/founderhaus')
  assert.equal(context.pages().length, 1, 'no popup opened')
  await expect(page.getByRole('dialog')).toBeVisible()
  await frame.getByRole('link', { name: 'Return to Homerun' }).click()
  await exchangeStarted
  await expect(frame.getByRole('status')).toContainText('Done. You can close this window.')
  await expect.poll(() => frame.locator('main').evaluate(node => getComputedStyle(node).paddingTop)).toBe('24px')
  await expect.poll(() => page.locator('iframe[name="juicebox-center-frame"]').evaluate(node => node.getBoundingClientRect().height)).toBeLessThan(200)
  releaseExchange()
  // The callback page inside the frame hands its URL up to the page; the lost first exchange shows there.
  await expect(page.locator('.jb-connect-error')).toContainText('Retry the pending connection')
  await expect(page.locator('iframe[name="juicebox-center-frame"]')).toHaveCount(0)
  await page.locator('.jb-connect-primary').click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page).toHaveURL(base + '/founderhaus')
  await expect(page.getByRole('button', { name: /^Signed in as/ })).toBeVisible()
  assert.equal(exchanges, 2)
  assert.equal(launches, 1)
  assert.equal(context.pages().length, 1, 'no window was opened')
  // A callback page reached without an opener scrubs its address before anything else, then completes on its own.
  const direct = await context.newPage()
  await direct.goto(base + '/center/callback?code=' + code + '&state=x&iss=' + encodeURIComponent(issuer))
  await expect(direct.getByRole('status')).toContainText(/no matching wallet callback/i)
  assert.equal(await direct.locator('main').evaluate(node => getComputedStyle(node).paddingTop), '64px', 'full-page callback keeps its own spacing')
  assert.equal(await direct.evaluate(() => location.href), base + '/center/callback', 'callback secrets are scrubbed')
  await direct.close()
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
    evidence: 'real Next app and packaged SDK; modeled Center responses', delayedRedirectCancelled: true, framedSignIn: true,
    originalExchangeRecovered: true, callbackScrubbed: true, reloadRestored: true, disconnectCleared: true, signedFormLaunch: true, launches, exchanges, pageErrors: errors }, null, 2))
  console.log('PASS enabled Homerun: chooser cancellation, framed sign-in, callback hand-up and scrubbing, exact retry in the page, reload and disconnect')
} finally { await browser.close() }
