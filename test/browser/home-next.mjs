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
  assert.equal(await staticPage.getByRole('heading', { name: "Run your home's investments and revenues" }).isVisible(), true);
  assert.equal(await staticPage.locator('.home-asset-line.is-current').textContent(), "Run your home's");
  assert.equal(await staticPage.locator('.brand-tagline').count(), 0, 'The homepage uses its large headline instead of repeating the slogan under the logo');
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
  await page.waitForSelector('.home-title-subject[data-rotating="true"]');
  assert.equal(await page.locator('.home-title-subject').getAttribute('data-current-asset'), 'home');

  // The first five assets appear in the requested order without moving the headline or CTAs.
  const heroGeometry = () => page.locator('.home-copy').evaluate(element => {
    const heading = element.querySelector('h1').getBoundingClientRect();
    const actions = element.querySelector('.home-actions').getBoundingClientRect();
    return { height: heading.height, top: heading.top, actionsTop: actions.top };
  });
  const initialGeometry = await heroGeometry();
  const prefix = await page.locator('.home-title-prefix').elementHandle();
  for (const asset of ['farms', 'business', 'equipment', 'energy']) {
    // Start observing before the noun changes so the first painted position is captured.
    const frames = await page.evaluate(({ prefix, asset }) => new Promise((resolve, reject) => {
      const subject = document.querySelector('.home-title-subject');
      const frames = [];
      let previous;
      let started;
      let frame;
      const timeout = setTimeout(() => {
        cancelAnimationFrame(frame);
        reject(new Error(`Timed out sampling the prefix transition to ${asset}`));
      }, 6000);
      const sample = time => {
        const current = document.querySelector('.home-title-prefix');
        const bounds = current.getBoundingClientRect();
        const ancestors = [];
        for (let node = current; node; node = node.parentElement) {
          const style = getComputedStyle(node);
          ancestors.push({ opacity: Number(style.opacity), visible: style.visibility === 'visible' && style.display !== 'none' });
        }
        const measured = { x: bounds.x, y: bounds.y, sameNode: current === prefix && prefix.isConnected, ancestors };
        if (subject.dataset.currentAsset === asset && started === undefined) {
          started = time;
          if (previous) frames.push(previous);
        }
        if (started !== undefined) frames.push(measured);
        if (started !== undefined && time - started >= 450) {
          clearTimeout(timeout);
          resolve(frames);
          return;
        }
        previous = measured;
        frame = requestAnimationFrame(sample);
      };
      frame = requestAnimationFrame(sample);
    }), { prefix, asset });
    assert.ok(frames.every(frame => frame.sameNode), `Run your keeps the same DOM node when rotating to ${asset}`);
    assert.ok(frames.every(frame => frame.ancestors.every(ancestor => ancestor.opacity === 1 && ancestor.visible)), `Run your and its ancestors remain fully visible throughout ${asset}'s transition`);
    const start = frames[0];
    const end = frames.at(-1);
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const distanceSquared = dx * dx + dy * dy;
    assert.ok(distanceSquared > 4, `The prefix changes position to center the different width of ${asset}`);
    const intermediatePositions = new Set(frames.filter(frame => {
      const progress = ((frame.x - start.x) * dx + (frame.y - start.y) * dy) / distanceSquared;
      return progress > .005 && progress < .995;
    }).map(frame => `${frame.x.toFixed(2)},${frame.y.toFixed(2)}`));
    assert.ok(intermediatePositions.size >= 2, `The prefix interpolates through multiple painted positions instead of snapping for ${asset}`);
    assert.deepEqual(await heroGeometry(), initialGeometry, `No layout shift when rotating to ${asset}`);
  }
  await prefix.dispose();

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
  await page.getByRole('button', { name: 'Pause animations' }).click();
  await waitForMotion(page, 'paused');
  const paused = await canvasSignature(page);
  const pausedAsset = await page.locator('.home-title-subject').getAttribute('data-current-asset');
  await page.waitForTimeout(3400);
  assert.equal(await canvasSignature(page), paused, 'Pause holds the rendered artwork still');
  assert.equal(await page.locator('.home-title-subject').getAttribute('data-current-asset'), pausedAsset, 'Pause also holds the headline still');
  assert.equal(await page.locator('.home-title-subject').getAttribute('data-rotating'), 'false');

  await page.locator('#color-mode').selectOption('acid');
  assert.notEqual(await canvasSignature(page), paused, 'Acid applies a different color formula');
  assert.equal(await page.locator('#color-intensity').inputValue(), '20', 'First Acid selection starts at intensity 20');
  assert.equal(await page.locator('#color-grouping').inputValue(), '20', 'First Acid selection starts at color grouping 20');
  assert.equal(await page.locator('#color-pace').inputValue(), '2.5', 'Selecting Acid preserves pace');
  await page.locator('#color-intensity').fill('35');
  await page.locator('#color-pace').fill('3.5');
  await page.locator('#color-grouping').fill('27');
  assert.equal(await page.locator('#color-intensity-value').textContent(), '35');
  assert.equal(await page.locator('#color-pace-value').textContent(), '3.5×');
  assert.equal(await page.locator('#color-grouping-value').textContent(), '27');

  await page.locator('#color-mode').selectOption('shapes');
  await page.locator('#color-intensity').fill('90');
  await page.locator('#color-grouping').fill('65');
  await page.locator('#color-mode').selectOption('acid');
  assert.equal(await page.locator('#color-intensity').inputValue(), '35', 'Returning to Acid restores its edited intensity');
  assert.equal(await page.locator('#color-grouping').inputValue(), '27', 'Shapes edits do not replace remembered Acid grouping');
  await page.locator('#color-mode').selectOption('shapes');
  await page.locator('#color-intensity').fill('90');
  await page.locator('#color-grouping').fill('65');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForMotion(page, 'running');
  assert.equal(await page.locator('#color-mode').inputValue(), 'shapes');
  assert.equal(await page.locator('#color-intensity').inputValue(), '90');
  assert.equal(await page.locator('#color-grouping').inputValue(), '65');
  await page.locator('#color-mode').selectOption('acid');
  assert.equal(await page.locator('#color-intensity').inputValue(), '35', 'Acid intensity is remembered across reloads in another mode');
  assert.equal(await page.locator('#color-grouping').inputValue(), '27', 'Acid grouping is remembered across reloads in another mode');

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
  const reducedAsset = await page.locator('.home-title-subject').getAttribute('data-current-asset');
  await page.waitForTimeout(3400);
  assert.equal(await canvasSignature(page), reduced);
  assert.equal(await page.locator('.home-title-subject').getAttribute('data-current-asset'), reducedAsset, 'Reduced motion keeps the headline still');
  assert.equal(await page.locator('.home-title-subject').getAttribute('data-rotating'), 'false');
  await page.getByRole('button', { name: 'Play animations' }).click();
  await waitForMotion(page, 'running');
  const playing = await canvasSignature(page);
  await page.waitForTimeout(400);
  assert.notEqual(await canvasSignature(page), playing, 'Explicit play works with reduced motion');
  await page.waitForFunction(previous => document.querySelector('.home-title-subject').dataset.currentAsset !== previous, reducedAsset, { timeout: 6000 });

  // The headline pauses while scrolled out of view, even when the artwork is still visible.
  await page.setViewportSize({ width: 390, height: 400 });
  await page.evaluate(() => window.scrollTo(0, 450));
  await page.waitForSelector('.home-title-subject[data-rotating="false"]');
  const offscreenAsset = await page.locator('.home-title-subject').getAttribute('data-current-asset');
  await page.waitForTimeout(3400);
  assert.equal(await page.locator('.home-title-subject').getAttribute('data-current-asset'), offscreenAsset, 'An offscreen headline does not keep cycling');
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForSelector('.home-title-subject[data-rotating="true"]');

  // Background tabs pause too. The visibility event is simulated because headless Chrome
  // does not reliably background a page when another Playwright page is brought forward.
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForSelector('.home-title-subject[data-rotating="false"]');
  const backgroundAsset = await page.locator('.home-title-subject').getAttribute('data-current-asset');
  await page.waitForTimeout(3400);
  assert.equal(await page.locator('.home-title-subject').getAttribute('data-current-asset'), backgroundAsset, 'A background headline does not keep cycling');
  await page.evaluate(() => {
    delete document.hidden;
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForSelector('.home-title-subject[data-rotating="true"]');

  assert.deepEqual(errors, [], 'No application or hydration errors');
  await context.close();

  // Existing users who saved Acid before separate mode preferences existed keep their values.
  const legacyContext = await browser.newContext({ viewport: { width: 390, height: 1000 }, reducedMotion: 'reduce' });
  await legacyContext.addInitScript(() => {
    localStorage.setItem('homerun:color-mode', 'acid');
    localStorage.setItem('homerun:color-intensity', '67');
    localStorage.setItem('homerun:color-grouping', '43');
    localStorage.setItem('homerun:color-pace', '1.75');
  });
  const legacyPage = await legacyContext.newPage();
  await legacyPage.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await waitForMotion(legacyPage, 'reduced');
  assert.equal(await legacyPage.locator('#color-intensity').inputValue(), '67', 'Saved legacy Acid intensity is preserved');
  assert.equal(await legacyPage.locator('#color-grouping').inputValue(), '43', 'Saved legacy Acid grouping is preserved');
  await legacyPage.locator('#color-mode').selectOption('shapes');
  await legacyPage.locator('#color-intensity').fill('100');
  await legacyPage.locator('#color-grouping').fill('11');
  await legacyPage.locator('#color-mode').selectOption('acid');
  assert.equal(await legacyPage.locator('#color-intensity').inputValue(), '67', 'Legacy Acid intensity is remembered on later selections');
  assert.equal(await legacyPage.locator('#color-grouping').inputValue(), '43', 'Legacy Acid grouping is remembered on later selections');
  assert.equal(await legacyPage.locator('#color-pace').inputValue(), '1.75');
  await legacyContext.close();
  console.log('Next homepage: SSR, three viewports, stable headline rotation, shared pause, offscreen/background pause, first-use Acid defaults, remembered/legacy Acid settings, color controls, route cleanup, persistence and reduced motion passed.');
} finally {
  await browser.close();
}
