import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chromium } from '@playwright/test';

const baseUrl = process.env.BASE_URL ?? 'http://localhost:3010';
const systemChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const executablePath = process.env.CHROME_PATH ?? (existsSync(systemChrome) ? systemChrome : undefined);
const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
const errors = [];

async function canvasSignature(page) {
  return page.locator('#ballpark').evaluate(canvas => {
    const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    let signature = 0;
    for (let index = 0; index < pixels.length; index += 256) signature = (signature * 31 + pixels[index]) >>> 0;
    return signature;
  });
}

async function waitForMotion(page, state) {
  await page.waitForSelector(`#ballpark[data-ready="true"][data-motion="${state}"]`);
}

try {
  // A real route must deliver its content before React or wallet providers hydrate.
  const staticContext = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 390, height: 844 } });
  const staticPage = await staticContext.newPage();
  const response = await staticPage.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  assert.equal(response?.status(), 200);
  assert.equal(await staticPage.getByRole('heading', { name: 'Fund an asset. Share what it earns.' }).isVisible(), true);
  assert.equal(await staticPage.getByRole('link', { name: 'Begin', exact: true }).getAttribute('href'), '/create');
  assert.equal(await staticPage.getByRole('link', { name: 'See Founder Haus demo' }).getAttribute('href'), '/founderhaus');
  assert.equal(await staticPage.locator('#color-mode').inputValue(), 'shapes');
  assert.equal(await staticPage.locator('#color-intensity').inputValue(), '100');
  assert.equal(await staticPage.locator('#color-pace').inputValue(), '2.5');
  assert.equal(await staticPage.locator('#color-grouping').inputValue(), '11');
  assert.match(await staticPage.locator('meta[property="og:image"]').getAttribute('content'), /homerun-share\.png$/);
  await staticContext.close();

  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error' && /hydration|server rendered|did not match/i.test(message.text())) errors.push(message.text());
  });
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await waitForMotion(page, 'running');

  for (const width of [320, 390, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    // Wait for the resize observer's cached drawing to finish.
    await page.waitForFunction(width => {
      const canvas = document.querySelector('#ballpark');
      return Math.abs(canvas.width / Math.min(devicePixelRatio, 2) - Math.min(width, 1600)) < 1;
    }, width);
    const layout = await page.evaluate(() => {
      const word = document.querySelector('.brand-word').getBoundingClientRect();
      const headline = document.querySelector('#home-title');
      return {
        overflow: document.documentElement.scrollWidth > innerWidth,
        wordCenterDelta: Math.abs(word.x + word.width / 2 - innerWidth / 2),
        headerHeight: document.querySelector('.site-header').getBoundingClientRect().height,
        heroHeight: document.querySelector('.ballpark-hero').getBoundingClientRect().height,
        headlineSize: parseFloat(getComputedStyle(headline).fontSize),
        serif: getComputedStyle(headline).fontFamily,
      };
    });
    assert.equal(layout.overflow, false, `No horizontal overflow at ${width}px`);
    assert.match(layout.serif, /Georgia/);
    assert.equal(layout.headerHeight, width <= 760 ? 68 : 76, 'Network header spacing is preserved');
    if (width <= 760) {
      assert.ok(layout.wordCenterDelta < 1, `Homerun itself is centered at ${width}px`);
      assert.equal(layout.heroHeight, 724);
      assert.ok(layout.headlineSize >= 32 && layout.headlineSize <= 48);
    }
  }

  await page.setViewportSize({ width: 390, height: 1000 });
  await waitForMotion(page, 'running');
  const drifting = await canvasSignature(page);
  await page.waitForTimeout(400);
  assert.notEqual(await canvasSignature(page), drifting, 'Shapes color drift changes pixels');
  await page.getByRole('button', { name: 'Pause color drift' }).click();
  await waitForMotion(page, 'paused');
  const paused = await canvasSignature(page);
  await page.waitForTimeout(250);
  assert.equal(await canvasSignature(page), paused, 'Pause holds the rendered artwork still');

  await page.locator('#color-mode').selectOption('acid');
  assert.notEqual(await canvasSignature(page), paused, 'Acid applies a different color formula');
  await page.locator('#color-intensity').fill('35');
  await page.locator('#color-pace').fill('3.5');
  await page.locator('#color-grouping').fill('27');
  assert.equal(await page.locator('#color-intensity-value').textContent(), '35');
  assert.equal(await page.locator('#color-pace-value').textContent(), '3.5×');
  assert.equal(await page.locator('#color-grouping-value').textContent(), '27');

  // Next client navigation must release the canvas and mount a fresh renderer on return.
  await page.evaluate(() => { window.previousBallpark = document.querySelector('#ballpark'); });
  await page.getByRole('link', { name: 'Begin', exact: true }).click();
  await page.getByRole('heading', { name: 'Design the rules', exact: true }).waitFor({ timeout: 120_000 });
  assert.deepEqual(await page.evaluate(() => ({
    connected: window.previousBallpark.isConnected,
    ready: window.previousBallpark.dataset.ready ?? null,
    motion: window.previousBallpark.dataset.motion ?? null,
  })), { connected: false, ready: null, motion: null });
  await page.getByRole('link', { name: 'Homerun home', exact: true }).click();
  await waitForMotion(page, 'running');
  assert.equal(await page.locator('#color-mode').inputValue(), 'acid');
  assert.equal(await page.locator('#color-intensity').inputValue(), '35');
  assert.equal(await page.locator('#color-pace').inputValue(), '3.5');
  assert.equal(await page.locator('#color-grouping').inputValue(), '27');

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await waitForMotion(page, 'reduced');
  const reduced = await canvasSignature(page);
  await page.waitForTimeout(250);
  assert.equal(await canvasSignature(page), reduced);
  await page.getByRole('button', { name: 'Play color drift' }).click();
  await waitForMotion(page, 'running');
  const playing = await canvasSignature(page);
  await page.waitForTimeout(400);
  assert.notEqual(await canvasSignature(page), playing, 'Explicit play works with reduced motion');

  assert.deepEqual(errors, [], 'No application or hydration errors');
  console.log('Next homepage: SSR without JavaScript, three viewport layouts, color controls, pause, route cleanup, persistence and reduced motion passed.');
  await context.close();
} finally {
  await browser.close();
}
