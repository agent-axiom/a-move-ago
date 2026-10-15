import assert from "node:assert/strict";
import { chromium } from "@playwright/test";

const request = { from: "2026-09-10", through: "2026-10-14" };
let stage = "START";
let browser;

try {
  stage = "SITE_URL";
  const pageUrl = new URL(process.env.WEB_APP_URL ?? "https://agent-axiom.github.io/a-move-ago/");
  assert.ok(
    pageUrl.protocol === "https:" &&
      !pageUrl.username &&
      !pageUrl.password &&
      !pageUrl.search &&
      !pageUrl.hash &&
      pageUrl.pathname.endsWith("/"),
  );
  pageUrl.searchParams.set("view", "archive");
  pageUrl.searchParams.set("release", process.env.GITHUB_SHA ?? "current");
  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  let attempts = 0;
  const customDomain = pageUrl.origin === "https://chess.kosarevsky.dev";
  let failedAssets = 0;
  if (customDomain) {
    const appAsset = (value) => {
      const url = new URL(value);
      return url.origin === pageUrl.origin && url.pathname.startsWith("/assets/");
    };
    page.on("response", (response) => {
      if (appAsset(response.url()) && !response.ok()) failedAssets += 1;
    });
    page.on("requestfailed", (outgoing) => {
      if (appAsset(outgoing.url())) failedAssets += 1;
    });
  }
  page.on("request", (outgoing) => {
    if (
      outgoing.method() === "POST" &&
      new URL(outgoing.url()).pathname.startsWith("/v1/attempts")
    ) {
      attempts += 1;
    }
  });

  stage = "WAIT_FOR_PUBLICATION";
  // Pages and content publish independently. Reloading keeps the same guest and
  // allows the archive catalog to become visible during the concurrent import.
  let ready = false;
  for (let retry = 0; retry < 30; retry += 1) {
    await page.goto(pageUrl.href, { waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { name: "The archive", exact: true }).waitFor();
    const select = page.getByLabel("Archive month", { exact: true });
    await select.waitFor({ state: "visible", timeout: 5_000 }).catch(() => {});
    if (await select.locator(`option[value="${request.from.slice(0, 7)}"]`).count()) {
      await select.selectOption(request.from.slice(0, 7));
      if (await page.locator(`.archive-cases time[datetime="${request.from}"]`).count()) {
        if (await select.locator(`option[value="${request.through.slice(0, 7)}"]`).count()) {
          await select.selectOption(request.through.slice(0, 7));
          if (await page.locator(`.archive-cases time[datetime="${request.through}"]`).count()) {
            await select.selectOption(request.from.slice(0, 7));
            ready = true;
            break;
          }
        }
      }
    }
    await page.waitForTimeout(3_000);
  }
  assert.ok(ready);

  stage = "MOBILE_LAYOUT";
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  stage = "OLDEST_CASE";
  await page
    .locator(`.archive-cases li`)
    .filter({
      has: page.locator(`time[datetime="${request.from}"]`),
    })
    .getByRole("button")
    .click();
  await page.getByRole("grid").waitFor();
  await page.locator(`.case-meta time[datetime="${request.from}"]`).waitFor();
  assert.equal(await page.getByRole("gridcell").count(), 64);
  assert.equal(new URL(page.url()).searchParams.get("case"), request.from);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("grid").waitFor();
  await page.locator(`.case-meta time[datetime="${request.from}"]`).waitFor();
  assert.equal(new URL(page.url()).searchParams.get("case"), request.from);

  stage = "BROWSER_BACK";
  await page.goBack();
  await page.getByRole("heading", { name: "The archive", exact: true }).waitFor();
  const select = page.getByLabel("Archive month", { exact: true });
  await select.waitFor();
  assert.equal(await select.inputValue(), request.from.slice(0, 7));
  stage = "DESKTOP_LAYOUT";
  await page.setViewportSize({ width: 1440, height: 1000 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  stage = "LATEST_HISTORICAL_CASE";
  await select.selectOption(request.through.slice(0, 7));
  await page
    .locator(".archive-cases li")
    .filter({
      has: page.locator(`time[datetime="${request.through}"]`),
    })
    .getByRole("button")
    .click();
  await page.getByRole("grid").waitFor();
  await page.locator(`.case-meta time[datetime="${request.through}"]`).waitFor();
  assert.equal(new URL(page.url()).searchParams.get("case"), request.through);

  stage = "TODAY";
  const todayBefore = new Date().toISOString().slice(0, 10);
  await page.getByRole("button", { name: "Back to today", exact: true }).click();
  await page.getByRole("grid").waitFor();
  await page.waitForFunction((before) => {
    const date = document.querySelector(".case-meta time")?.getAttribute("datetime");
    return date === before || date === new Date().toISOString().slice(0, 10);
  }, todayBefore);
  assert.equal(new URL(page.url()).searchParams.has("case"), false);
  assert.equal(new URL(page.url()).searchParams.has("view"), false);
  if (customDomain) {
    async function checkLegacyRedirect(parameters, ready) {
      const legacy = new URL("https://agent-axiom.github.io/a-move-ago/");
      legacy.search = new URLSearchParams({ ...parameters, keep: "domain-check" }).toString();
      legacy.hash = "main-content";
      await page.goto(legacy.href, { waitUntil: "domcontentloaded" });
      await ready();
      const redirected = new URL(page.url());
      assert.equal(redirected.origin, pageUrl.origin);
      assert.equal(redirected.pathname, "/");
      assert.equal(redirected.searchParams.get("keep"), "domain-check");
      assert.equal(redirected.hash, "#main-content");
      for (const [key, value] of Object.entries(parameters)) {
        assert.equal(redirected.searchParams.get(key), value);
      }
    }
    stage = "LEGACY_CASE_REDIRECT";
    await checkLegacyRedirect({ case: request.from }, async () => {
      await page.getByRole("grid").waitFor();
      await page.locator(`.case-meta time[datetime="${request.from}"]`).waitFor();
    });
    stage = "LEGACY_ARCHIVE_REDIRECT";
    await checkLegacyRedirect({ view: "archive", month: request.from.slice(0, 7) }, async () => {
      await page.getByRole("heading", { name: "The archive", exact: true }).waitFor();
      await select.waitFor();
    });
    assert.equal(await select.inputValue(), request.from.slice(0, 7));
    assert.equal(await select.locator('option[value="2026-08"]').count(), 0);
    stage = "APPLICATION_ASSETS";
    assert.equal(failedAssets, 0);
  }
  assert.equal(attempts, 0);
  // No traces, screenshots, response bodies or browser storage are exported.
  console.log(
    JSON.stringify({
      ok: true,
      from: request.from,
      through: request.through,
      viewports: [390, 1440],
      deepLinkReload: true,
      browserBack: true,
      backToToday: true,
      ...(customDomain
        ? { legacyRedirects: true, queryAndFragmentPreserved: true, sameOriginAssets: true }
        : {}),
      submittedAttempts: attempts,
    }),
  );
} catch {
  console.error(JSON.stringify({ ok: false, code: `LIVE_ARCHIVE_UI_${stage}_FAILED` }));
  process.exitCode = 1;
} finally {
  await browser?.close();
}
