/** Native Next/React project regression checks. Start npm run dev first. */
import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect } from "@playwright/test";
import { CREATE_DEFAULTS, CREATED_PROJECTS_KEY } from '../web/create-model.mjs';

const { chromium } = await import(
  (process.env.PLAYWRIGHT_MODULE
    ? pathToFileURL(process.env.PLAYWRIGHT_MODULE)
    : new URL(
        "../../../webclients/juicescan/node_modules/playwright/index.mjs",
        import.meta.url,
      )
  ).href
);
const browser = await chromium.launch({
  executablePath:
    process.env.CHROME_PATH ||
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
});
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  acceptDownloads: true,
  reducedMotion: "reduce",
});
const page = await context.newPage();
const base = process.env.BASE_URL || "http://localhost:3010";
const demoURL = new URL("/founderhaus", base).href;
const errors = [];
const failures = [];
let checks = 0;
page.on("pageerror", (error) => errors.push(error.message));
page.on("response", (response) => {
  if (response.status() >= 400 && !response.url().endsWith("/favicon.ico"))
    errors.push(`HTTP ${response.status()} ${response.url()}`);
});
page.setDefaultTimeout(15_000);
page.setDefaultNavigationTimeout(120_000);

async function check(name, callback) {
  checks++;
  try {
    await callback();
    console.log(`PASS ${name}`);
  } catch (error) {
    failures.push(name);
    console.error(`FAIL ${name}: ${error.message}`);
  }
}
async function open() {
  const response = await page.goto(demoURL, { waitUntil: "domcontentloaded" });
  assert.equal(response.status(), 200);
  await expect(page.locator('.simulator')).toHaveAttribute('data-ready', 'true');
  await expect(page.locator("#scenario-title")).toHaveText("Raise the money.");
}
async function phase(name) {
  const stage = ["earning", "liquidated"].includes(name) ? name : "raising";
  await page
    .locator(`.preview-base-buttons button[data-journey-phase="${stage}"]`)
    .click();
  if (stage === "raising") await page.locator(`[data-phase="${name}"]`).click();
  await expect(page.locator("#project-journey")).toHaveAttribute(
    "data-journey-phase",
    name,
  );
}
async function reveal(selector) {
  const locator = page.locator(selector);
  const ancestors = locator.locator("xpath=ancestor::details");
  for (let i = 0; i < (await ancestors.count()); i++) {
    const detail = ancestors.nth(i);
    if ((await detail.getAttribute("open")) === null)
      await detail.locator(":scope > summary").click();
  }
  return locator;
}
async function field(key, value) {
  const input = page.locator(`#field-${key}`);
  if (
    ["rentGrowthPercent", "costGrowthPercent"].includes(key) &&
    (await page.locator("#assumptions-body").isHidden())
  )
    await page.locator("#toggle-assumptions").click();
  await input.fill(String(value));
  if (value !== "")
    await expect(input).toHaveAttribute("aria-invalid", "false");
}
async function dollars(selector) {
  const value = await page.locator(selector).textContent();
  const match = value.match(/\$([\d,]+(?:\.\d+)?)/);
  assert.ok(match, `${selector} should contain a dollar amount.`);
  return Number(match[1].replaceAll(",", ""));
}
async function tokens(selector) {
  return Number(
    (await page.locator(selector).textContent())
      .match(/[\d,.]+/)[0]
      .replaceAll(",", ""),
  );
}
async function dismiss(id) {
  await page.keyboard.press("Escape");
  await expect(page.locator(id)).toHaveCount(0);
}
async function screenshot(name) {
  if (!process.env.BROWSER_SCREENSHOT_DIR) return;
  await mkdir(process.env.BROWSER_SCREENSHOT_DIR, { recursive: true });
  await page.screenshot({
    path: join(process.env.BROWSER_SCREENSHOT_DIR, name),
    fullPage: true,
  });
}
async function download(selector) {
  const [file] = await Promise.all([
    page.waitForEvent("download"),
    page.locator(selector).click(),
  ]);
  const text = await readFile(await file.path(), "utf8");
  await file.delete();
  return { name: file.suggestedFilename(), text };
}

try {
  await check(
    "The complete project body is server-rendered without JavaScript",
    async () => {
      const noJS = await browser.newContext({ javaScriptEnabled: false });
      const staticPage = await noJS.newPage();
      const response = await staticPage.goto(demoURL);
      assert.equal(response.status(), 200);
      await expect(staticPage.locator("h1")).toHaveText("Founder Haus");
      await expect(staticPage.locator("#scenario-title")).toHaveText(
        "Raise the money.",
      );
      await expect(staticPage.locator("#project-goal")).toHaveText(
        "$615,384.62",
      );
      await expect(staticPage.locator("#pay-output")).toHaveText("100,000,000");
      await noJS.close();
    },
  );
  await check(
    "The initial model preserves the asset budget, reserve and contribution",
    async () => {
      await open();
      await expect(page.locator("#project-raised")).toHaveText("$369,230.77");
      await expect(page.locator("#project-goal")).toHaveText("$615,384.62");
      await expect(page.locator("#project-funded")).toHaveText("60%");
      assert.equal(await page.locator(".brand-ball svg").count(), 1);
      assert.equal(
        await page.locator(".preview-workbench > .assumptions").count(),
        1,
      );
      assert.equal(
        await page.locator("#pay-panel #contribution-section").count(),
        1,
      );
      assert.equal(
        await page.locator("#fund-position-preview").getAttribute("open"),
        null,
      );
      await reveal("#your-fund-tokens");
      await expect(page.locator("#your-fund-tokens")).toHaveText(
        "100,000,000 FUND",
      );
      assert.equal(await dollars("#your-fund-cashout"), 9027.08);
      await expect(page.locator("link[rel=canonical]")).toHaveAttribute(
        "href",
        "https://homerun.money/founderhaus",
      );
      await expect(page.locator('meta[property="og:image"]')).toHaveAttribute(
        "content",
        "https://homerun.money/assets/homerun-share.png",
      );
    },
  );
  await check(
    "Asset inputs update project totals and annual growth is optional",
    async () => {
      await open();
      await field("raisedPercent", 40);
      await expect(page.locator("#project-raised")).toHaveText("$246,153.85");
      await field("purchaseBudget", 400000);
      await expect(page.locator("#project-goal")).toHaveText("$512,820.52");
      await expect(page.locator("#assumptions-body")).toBeHidden();
      await field("rentGrowthPercent", 4);
      await expect(page.locator("#assumptions-body")).toBeVisible();
      await phase("earning");
      await expect(page.locator("#project-funded")).toHaveText("100%");
      await expect(page.locator("#project-raise-stats")).toContainText(
        "Originally raised",
      );
    },
  );
  await check(
    "All six lifecycle stages have accessible baseball indicators",
    async () => {
      await open();
      for (const name of [
        "raising",
        "funded",
        "refunding",
        "refunded",
        "earning",
        "liquidated",
      ]) {
        await phase(name);
        const current =
          name === "earning"
            ? "earning"
            : name === "liquidated"
              ? "liquidated"
              : "raising";
        await expect(
          page.locator(".pj-stage[aria-current=step]"),
        ).toHaveAttribute("data-journey-phase", current);
        assert.equal(await page.locator(".pj-stage").count(), 3);
        assert.equal(await page.locator("#project-journey button").count(), 0);
        await expect(page.locator(".pj-description")).not.toBeEmpty();
      }
    },
  );
  await check(
    "FUND payments change personal quotes without moving modeled project cash",
    async () => {
      await open();
      const raised = await dollars("#project-raised");
      await page.locator("#pay-amount").fill("500");
      await expect(page.locator("#pay-output")).toHaveText("5,000,000");
      assert.equal(await dollars("#project-raised"), raised);
      await page.locator("#pay-review").click();
      await expect(page.locator("#pay-dialog[open]")).toBeVisible();
      await expect(page.locator("#pay-dialog")).toContainText("5,000,000 FUND");
      await expect(page.locator("#pay-dialog")).toContainText(
        "Nothing is signed, paid, redeemed, or changed",
      );
      await dismiss("#pay-dialog");
      await expect(page.locator("#pay-review")).toBeFocused();
      assert.equal(await dollars("#project-raised"), raised);
    },
  );
  await check(
    "ETH previews use the stated conversion and preserve USDC contribution value",
    async () => {
      await open();
      await page.locator("#pay-currency").selectOption("ETH");
      await page.locator("#pay-amount").fill("0.2");
      await expect(page.locator("#pay-output")).toHaveText("5,000,000");
      await expect(page.locator(".pay-conversion")).toContainText("2,500 USDC");
      await page.locator("#pay-currency").selectOption("USDC");
      await expect(page.locator("#pay-amount")).toHaveValue("500");
    },
  );
  await check(
    "Invalid payments disable review and recover without losing focus",
    async () => {
      await open();
      for (const value of ["", "-1", "abc", "0.001"]) {
        await page.locator("#pay-amount").fill(value);
        await expect(page.locator("#pay-review")).toBeDisabled();
        await expect(page.locator("#pay-error")).not.toBeEmpty();
        await expect(page.locator("#pay-amount")).toBeFocused();
      }
      await page.locator("#pay-amount").fill("100");
      await expect(page.locator("#pay-review")).toBeEnabled();
    },
  );
  await check(
    "Closed raises and completed refunds disable payment; remaining refunds remain reviewable",
    async () => {
      await open();
      await phase("funded");
      await expect(page.locator("#pay-review")).toBeDisabled();
      await expect(page.locator("#pay-amount")).toHaveCount(0);
      assert.equal(await dollars("#escrow-cash"), 615384.62);
      await phase("refunding");
      await expect(page.locator("#pay-output")).toHaveText("10,000");
      await page.locator("#pay-review").click();
      await expect(page.locator("#pay-dialog")).toContainText("10,000");
      await dismiss("#pay-dialog");
      await phase("refunded");
      await expect(page.locator("#pay-review")).toBeDisabled();
      await expect(page.locator("#scenario-title")).toHaveText(
        "Refunds complete.",
      );
    },
  );
  await check(
    "Gallery images load, keyboard navigation works and focus returns",
    async () => {
      await open();
      await page.locator("#open-house-gallery").click();
      await expect(page.locator("#house-gallery[open]")).toBeVisible();
      await page.locator('[data-house-photo="1"]').click();
      await expect(page.locator("#house-gallery-image")).toHaveAttribute(
        "src",
        /rooftop/,
      );
      await page.keyboard.press("ArrowRight");
      await expect(page.locator("#house-gallery-image")).toHaveAttribute(
        "src",
        /community/,
      );
      await page
        .locator("#house-gallery-image")
        .evaluate((image) => image.decode());
      await dismiss("#house-gallery");
      await expect(page.locator("#open-house-gallery")).toBeFocused();
    },
  );
  await check(
    "INCOME payments keep their amount and preserve historical FUND holdings",
    async () => {
      await open();
      await page.locator("#pay-amount").fill("12000");
      await phase("earning");
      await reveal("#your-fund-tokens");
      const fund = await tokens("#your-fund-tokens");
      const income = await tokens("#your-rev-tokens");
      const pool = await dollars("#cash-in-pool");
      await page.locator("#pay-amount").fill("250.50");
      const expected = new Intl.NumberFormat("en-US", {
        maximumFractionDigits: 6,
      }).format(250.5 * 10 * 0.95 ** 4 * 0.1);
      await expect(page.locator("#pay-output")).toHaveText(expected);
      assert.equal(await tokens("#your-fund-tokens"), fund);
      assert.equal(await tokens("#your-rev-tokens"), income);
      assert.equal(await dollars("#cash-in-pool"), pool);
      await page.locator("#income-payment-results > details > summary").click();
      await expect(page.locator("#income-payment-results")).toContainText(
        "historical FUND position stays unchanged",
      );
      assert.equal(
        await page
          .locator("[data-income-payment-chart=allocation] svg")
          .count(),
        1,
      );
      await phase("raising");
      await expect(page.locator("#pay-amount")).toHaveValue("12000");
      await phase("earning");
      await expect(page.locator("#pay-amount")).toHaveValue("250.50");
    },
  );
  await check(
    "Success separates initial holder INCOME from eligible Sticky rewards",
    async () => {
      await open();
      await phase("earning");
      await reveal("#your-rev-tokens");
      assert.equal(await tokens("#your-fund-tokens"), 100000000);
      assert.ok((await tokens("#your-premint-tokens")) > 0);
      assert.ok((await tokens("#your-sticky-tokens")) > 0);
      await expect(page.locator("#fund-details")).toContainText(
        "Initial INCOME claims are separate and require no activation, staking or vesting",
      );
      await page.locator("#fund-ownership-preview > summary").click();
      for (const token of ["fund", "income"]) {
        const chart = page.locator(`[data-ownership-chart="${token}"]`);
        const total = Number(await chart.getAttribute("data-ownership-total"));
        const parts = await chart
          .locator("[data-owner]")
          .evaluateAll((nodes) =>
            nodes.map((node) => Number(node.dataset.ownerTokens)),
          );
        assert.ok(
          Math.abs(parts.reduce((sum, value) => sum + value, 0) - total) <=
            Math.max(0.00001, total * 1e-10),
        );
      }
    },
  );
  await check(
    "Quarterly issuance cuts stop after two years and both month controls stay linked",
    async () => {
      await open();
      await phase("earning");
      await reveal("#quote-month");
      for (const month of [13, 23, 24, 25]) {
        await page.locator("#quote-month").fill(String(month));
        await expect(page.locator("#field-revenueMonths")).toHaveValue(
          String(month),
        );
        const expected = new Intl.NumberFormat("en-US", {
          maximumFractionDigits: 6,
        }).format(100 * 10 * 0.95 ** Math.min(8, Math.floor(month / 3)) * 0.1);
        await expect(page.locator("#pay-output")).toHaveText(expected);
      }
      await page.locator("#add-rent-month").click();
      await expect(page.locator("#field-revenueMonths")).toHaveValue("26");
    },
  );
  await check(
    "Revenue backs INCOME while the reserve pays expenses first",
    async () => {
      await open();
      await phase("earning");
      assert.equal(await dollars("#cash-in-pool"), 120000);
      assert.equal(await dollars("#ops-reserve-cash"), 28000);
      await reveal("#monthly-rent-in");
      assert.equal(await dollars("#monthly-rent-in"), 10000);
      assert.equal(await dollars("#ops-reserve-used"), 6000);
      await expect(page.locator("#rev-payment-split")).toContainText("75%");
      await expect(page.locator("#rev-payment-split")).toContainText("15%");
    },
  );
  await check(
    "Zero revenue and exhausted reserves show unavailable loans and unpaid costs",
    async () => {
      await open();
      await phase("earning");
      await field("monthlyRent", 0);
      await reveal("#your-loan-cash");
      await expect(page.locator("#your-loan-cash")).toHaveText("$0");
      await expect(page.locator("#loan-status")).toContainText("No cash");
      await field("opsReserve", 0);
      await expect(page.locator("#phase-panel")).toContainText(
        "$72,000 of costs remain unpaid",
      );
    },
  );
  await check(
    "Reserve stress tables stay open when assumptions change",
    async () => {
      await open();
      await phase("earning");
      await reveal("#reserve-stress");
      await page.locator("#reserve-stress > summary").click();
      await expect(page.locator("#reserve-stress tbody tr")).toHaveCount(4);
      await field("opsReserve", 1000);
      await expect(page.locator("#reserve-stress")).toHaveAttribute("open", "");
      await expect(
        page.locator("#reserve-stress tbody tr").first(),
      ).toContainText("Unpaid costs from month 1");
    },
  );
  await check(
    "Sale proceeds pay FUND while existing INCOME liquidity remains separate",
    async () => {
      await open();
      await phase("earning");
      const cash = await dollars("#cash-in-pool");
      await phase("liquidated");
      assert.equal(await dollars("#fund-sale-cash"), 503000);
      assert.equal(await dollars("#cash-in-pool"), cash);
      await reveal("#your-fund-sale");
      assert.equal(await dollars("#your-fund-sale"), 6538.99);
      assert.equal(await dollars("#combined-cashout"), 7188.81);
      await field("salePrice", 600000);
      await expect(page.locator("#fund-sale-cash")).toHaveText("$598,000");
      await page.locator("#pay-review").click();
      await expect(page.locator("#pay-dialog")).toContainText(
        "Nothing is signed",
      );
      await dismiss("#pay-dialog");
    },
  );
  await check(
    "Owner drafts expose blockers and preserve review before a scenario change",
    async () => {
      await open();
      await page.locator("#owner-tools > summary").click();
      await page.locator("[data-owner-action=close_raise]").click();
      await expect(page.locator("#owner-dialog")).toContainText(
        "Prerequisites not met",
      );
      await expect(page.locator("#preview-owner-state")).toBeDisabled();
      await expect(page.locator("#project-journey")).toHaveAttribute(
        "data-journey-phase",
        "raising",
      );
      const draft = JSON.parse((await download("#download-owner-draft")).text);
      assert.equal(draft.executable, false);
      await dismiss("#owner-dialog");
      await field("raisedPercent", 100);
      await page.locator("[data-owner-action=close_raise]").click();
      await expect(page.locator("#preview-owner-state")).toBeEnabled();
      await page.locator("#preview-owner-state").click();
      await expect(page.locator("#project-journey")).toHaveAttribute(
        "data-journey-phase",
        "funded",
      );
    },
  );
  await check(
    "Purchase, refund and sale drafts are downloadable without executing transactions",
    async () => {
      for (const [stage, action] of [
        ["funded", "complete_purchase"],
        ["raising", "enable_refunds"],
        ["earning", "enable_sale_redemptions"],
      ]) {
        await open();
        await phase(stage);
        await page.locator("#owner-tools > summary").click();
        await page.locator(`[data-owner-action="${action}"]`).click();
        await expect(page.locator("#owner-dialog")).toContainText(
          "Nothing is signed, submitted, queued or changed on-chain",
        );
        const draft = JSON.parse(
          (await download("#download-owner-draft")).text,
        );
        assert.equal(draft.executable, false);
        assert.ok(draft.steps.length > 0);
        await dismiss("#owner-dialog");
      }
    },
  );
  await check(
    "Invalid assumptions disable review; reset also resets partially typed inputs",
    async () => {
      await open();
      await field("purchaseBudget", "");
      await expect(page.locator("#field-purchaseBudget")).toHaveAttribute(
        "aria-invalid",
        "true",
      );
      await expect(page.locator("#pay-review")).toBeDisabled();
      await expect(page.locator("#download-scenario")).toBeDisabled();
      await page.locator("#reset-example").click();
      await expect(page.locator("#field-purchaseBudget")).toHaveValue(
        "500,000",
      );
      await expect(page.locator("#pay-review")).toBeEnabled();
      await expect(page.locator("#project-goal")).toHaveText("$615,384.62");
    },
  );
  await check(
    "Downloads contain the actual edited scenario and separate token balances",
    async () => {
      await open();
      await field("monthlyRent", 12345);
      await phase("earning");
      const file = await download("#download-scenario");
      assert.equal(file.name, "homerun-scenario.json");
      const data = JSON.parse(file.text);
      assert.equal(data.mode, "illustrative-preview");
      assert.equal(data.inputs.monthlyRent, 12345);
      assert.equal(data.phase, "earning");
      assert.ok(data.projection.personalFundTokens > 0);
      assert.ok(data.projection.personalRevTokens > 0);
    },
  );
  await check(
    "Field help supports keyboard, dismissal and narrow viewports",
    async () => {
      await open();
      await page.locator("#field-purchaseBudget").focus();
      await expect(page.locator("#help-purchaseBudget")).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.locator("#help-purchaseBudget")).toBeHidden();
      await page.setViewportSize({ width: 320, height: 900 });
      await page
        .getByRole("button", { name: "Explain Monthly expenses", exact: true })
        .click();
      await expect(page.locator("#help-monthlyCosts")).toBeVisible();
      const bounds = await page.locator("#help-monthlyCosts").boundingBox();
      assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 320);
      await page.locator("h1").click();
      await expect(page.locator("#help-monthlyCosts")).toBeHidden();
      await page.setViewportSize({ width: 1440, height: 1000 });
    },
  );
  await check(
    "Native SVG charts expose readable histories without changing the selected month",
    async () => {
      await open();
      assert.equal(
        await page.locator("[data-projection-chart=budget]").count(),
        1,
      );
      await phase("earning");
      await reveal("[data-chart-kind=loan]");
      for (const name of ["cash", "loan"]) {
        const chart = page.locator(`[data-chart-kind="${name}"]`);
        assert.ok((await chart.locator("svg").count()) > 0);
        const sliders = chart.locator("input[type=range]");
        if (await sliders.count()) await sliders.fill("5");
        await expect(page.locator("#field-revenueMonths")).toHaveValue("12");
        await chart.locator("details > summary").click();
        assert.equal(await chart.locator("tbody tr").count(), 13);
      }
    },
  );
  await check(
    "AI integration handoff separates initial claims and ongoing Sticky rewards",
    async () => {
      await open();
      await field("monthlyRent", 12345);
      await page.locator(".site-integration > summary").click();
      await expect(
        page.locator(".site-integration textarea").first(),
      ).toContainText("Initial claims require no activation, staking or vesting");
      const file = await download(
        '.site-integration button:has-text("Download instructions")',
      );
      assert.match(file.text, /12345/);
      assert.match(file.text, /Wagmi\/Viem/);
    },
  );
  await check(
    "All stages and dialogs fit phones, with the house above the baseball pitch",
    async () => {
      for (const width of [390, 320]) {
        await page.setViewportSize({ width, height: 900 });
        await open();
        for (const stage of [
          "raising",
          "funded",
          "refunding",
          "refunded",
          "earning",
          "liquidated",
        ]) {
          await phase(stage);
          const bounds = await page.evaluate(() => ({
            scroll: document.documentElement.scrollWidth,
            photo: document.querySelector(".deal-image").getBoundingClientRect()
              .bottom,
            pitch: document
              .querySelector("#project-journey")
              .getBoundingClientRect().top,
          }));
          assert.ok(
            bounds.scroll <= width + 1,
            `${stage} overflows ${width}px`,
          );
          assert.ok(
            bounds.photo <= bounds.pitch,
            "House photo precedes lifecycle pitch on mobile.",
          );
          if (stage === "earning") {
            await reveal("#your-loan-cash");
            assert.ok(
              (await page.evaluate(
                () => document.documentElement.scrollWidth,
              )) <=
                width + 1,
            );
          }
          if (["raising", "refunding", "liquidated"].includes(stage)) {
            await page.locator("#pay-review").click();
            const box = await page.locator("#pay-dialog").boundingBox();
            assert.ok(box.width <= width);
            await dismiss("#pay-dialog");
          }
        }
        await screenshot(`homerun-demo-${width}.png`);
      }
    },
  );
  await check('Saved local previews keep prospective payments separate from their displayed raise', async () => {
    const id = '3f1b300a-1e01-4cb4-a0aa-711ec3c9fd50';
    const entry = { id, createdAt: new Date().toISOString(), values: { ...CREATE_DEFAULTS, name: 'Neighborhood equipment', assetType: 'equipment', operatorWallet: '0x1111111111111111111111111111111111111111' } };
    await page.evaluate(({ key, value }) => localStorage.setItem(key, JSON.stringify([value])), { key: CREATED_PROJECTS_KEY, value: entry });
    await page.goto(new URL(`/project?id=${id}`, base).href);
    await expect(page.locator('.simulator')).toHaveAttribute('data-ready', 'true');
    await expect(page.locator('h1')).toHaveText('Neighborhood equipment');
    await expect(page.locator('#project-raised')).toHaveText('$0');
    await page.locator('#pay-amount').fill('2500');
    await expect(page.locator('#pay-output')).toHaveText('25,000,000');
    await expect(page.locator('#project-raised')).toHaveText('$0');
    await expect(page.locator('.created-project-note')).toContainText('Local project preview');
    assert.ok(await page.locator('#created-asset-sketch').evaluate(canvas => canvas.width > 0 && canvas.height > 0));
    await page.evaluate(key => localStorage.removeItem(key), CREATED_PROJECTS_KEY);
  });
  await check(
    "Legacy project links have an honest missing-preview state",
    async () => {
      await page.goto(new URL("/project?id=not-a-real-id", base).href);
      await expect(
        page.getByRole("heading", { name: "Project preview not found" }),
      ).toBeVisible();
      await expect(page.locator("main")).toContainText("saved in the browser");
    },
  );
  await check(
    "No JavaScript or application resource errors occurred",
    async () => assert.deepEqual(errors, []),
  );
} finally {
  await browser.close();
}
console.log(`${checks - failures.length}/${checks} browser checks passed.`);
if (failures.length) process.exitCode = 1;
