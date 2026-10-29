import assert from 'node:assert/strict'

/** HTML-only checks use the built app's real responses, without app-response or wallet mocks. */
export async function checkFramingPolicy(browser, base) {
  const appOrigin = new URL(base).origin
  const cases = [
    ['https://untrusted.example', '/founderhaus', false],
    ['https://app.safe.global', '/founderhaus', true],
    ['https://app.5afe.dev', '/founderhaus', true],
    [appOrigin, '/founderhaus', false],
    [appOrigin, '/center/callback', true],
    [appOrigin, '/center/callback/', true],
    ['https://untrusted.example', '/center/callback', false],
    ['https://app.safe.global', '/center/callback', false],
    [appOrigin, '/center/callbackfoo', false],
  ]

  for (const [parentOrigin, path, allowed] of cases) {
    const context = await browser.newContext({ serviceWorkers: 'block' })
    try {
      const page = await context.newPage()
      const violations = []
      page.on('console', message => {
        if (/frame-ancestors|refused to frame/i.test(message.text())) violations.push(message.text())
      })
      const parentUrl = `${parentOrigin}/framing-policy-proof`
      const target = appOrigin + path
      await page.route('**/*', route => {
        const request = route.request()
        if (request.url() === parentUrl) {
          return route.fulfill({ contentType: 'text/html', body: `<!doctype html><iframe src="${target}"></iframe>` })
        }
        return request.resourceType() === 'document' ? route.continue() : route.abort()
      })
      await page.goto(parentUrl, { waitUntil: 'load' })
      const frame = page.frames().find(candidate => candidate !== page.mainFrame() && candidate.url().startsWith(appOrigin))
      const rendered = !!frame && await frame.locator('main').count() > 0
      assert.equal(rendered, allowed, `${parentOrigin} framing ${path}`)
      if (!allowed) assert.ok(violations.length > 0, `CSP must reject ${parentOrigin} framing ${path}`)
    } finally {
      await context.close()
    }
  }
  console.log(`PASS Homerun framing: ${cases.length} foreign, Safe, callback and near-match cases`)
}
