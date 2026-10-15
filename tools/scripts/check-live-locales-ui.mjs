import assert from "node:assert/strict";
import { chromium } from "@playwright/test";

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
  pageUrl.searchParams.set("case", "2026-09-10");
  pageUrl.searchParams.set("release", process.env.GITHUB_SHA ?? "current");
  browser = await chromium.launch();
  // Navigator preference intentionally differs from the required English default.
  const context = await browser.newContext({
    locale: "zh-CN",
    viewport: { width: 390, height: 844 },
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  let attempts = 0;
  let dailyRequests = 0;
  let clueRequests = 0;
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (request.method() === "POST" && path.startsWith("/v1/attempts")) attempts += 1;
    if (request.method() === "GET" && path === "/v1/daily") dailyRequests += 1;
    if (request.method() === "POST" && path.endsWith("/clue")) clueRequests += 1;
  });
  function language() {
    return page
      .locator("select")
      .filter({ has: page.getByRole("option", { name: "English", exact: true }) });
  }
  async function layout() {
    for (const width of [320, 390, 1440]) {
      await page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 });
      assert.ok(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
      );
      const tooSmall = await page.locator("button, select, a[href], summary").evaluateAll((elements) =>
        elements.some((element) => {
          if (element.closest(".chessboard")) return false;
          const rect = element.getBoundingClientRect();
          const style = window.getComputedStyle(element);
          return (
            rect.width > 0 &&
            rect.height > 0 &&
            style.visibility !== "hidden" &&
            (rect.width < 44 || rect.height < 44)
          );
        }),
      );
      assert.equal(tooSmall, false);
    }
  }
  async function scoring(locale) {
    const labels = {
      en: ["Daily case", "Available: 100 points", "Reveal clue · 100 → 50 points"],
      ru: ["Задача дня", "Доступно: 100 очков", "Открыть улику · 100 → 50 очков"],
      zh: ["每日棋题", "可得：100 分", "揭示线索 · 100 → 50 分"],
    }[locale];
    await page.locator(".puzzle-score").waitFor();
    assert.equal(await page.locator("h1").innerText(), labels[0]);
    assert.equal(await page.locator(".score-potential").innerText(), labels[1]);
    await page.getByRole("button", { name: labels[2], exact: true }).waitFor();
    assert.equal(await page.locator(".unlocked-clue").count(), 0);
    assert.ok((await page.locator(".puzzle-prompt").innerText()).trim().length > 0);
  }
  stage = "ENGLISH_DEFAULT";
  await page.goto(pageUrl.href, { waitUntil: "domcontentloaded" });
  await page.getByRole("grid").waitFor();
  assert.equal(await page.locator("html").getAttribute("lang"), "en");
  assert.equal(await language().inputValue(), "en");
  assert.deepEqual(await language().locator("option").allTextContents(), [
    "English",
    "Русский",
    "中文",
  ]);
  await page.getByRole("button", { name: "Check move", exact: true }).waitFor();
  const originalTitle = await page.locator("h1").innerText();
  await scoring("en");
  await layout();
  stage = "ENGLISH_RATING";
  await page.getByRole("button", { name: "Progress", exact: true }).click();
  await page.getByRole("heading", { name: "Personal rating", exact: true }).waitFor();
  assert.equal(await page.locator(".personal-rating-total strong").innerText(), "0");
  await layout();
  await page.getByRole("button", { name: "Back to case", exact: true }).click();
  await page.getByRole("grid").waitFor();
  const originalDailyRequests = dailyRequests;

  stage = "RUSSIAN_CASE";
  await language().selectOption("ru");
  await page.getByRole("button", { name: "Проверить ход", exact: true }).waitFor();
  assert.equal(await page.locator("html").getAttribute("lang"), "ru");
  assert.match(await page.locator("h1").innerText(), /\p{Script=Cyrillic}/u);
  assert.equal(new URL(page.url()).searchParams.get("case"), "2026-09-10");
  assert.equal(dailyRequests, originalDailyRequests);
  await scoring("ru");
  await layout();
  stage = "RUSSIAN_PROGRESS";
  await page.getByRole("button", { name: "Прогресс", exact: true }).click();
  await page.getByRole("heading", { name: "Статистика", exact: true }).waitFor();
  await page.getByRole("heading", { name: "Личный рейтинг", exact: true }).waitFor();
  assert.equal(await page.locator(".personal-rating-total strong").innerText(), "0");
  await layout();

  stage = "CHINESE_PROGRESS";
  await language().selectOption("zh");
  await page.getByRole("heading", { name: "统计", exact: true }).waitFor();
  await page.getByRole("heading", { name: "个人评分", exact: true }).waitFor();
  assert.equal(await page.locator(".personal-rating-total strong").innerText(), "0");
  assert.equal(await page.locator("html").getAttribute("lang"), "zh-CN");
  await layout();
  await page.getByRole("button", { name: "返回谜题", exact: true }).click();
  await page.getByRole("button", { name: "检查走法", exact: true }).waitFor();
  assert.match(await page.locator("h1").innerText(), /\p{Script=Han}/u);
  await scoring("zh");
  assert.equal(new URL(page.url()).searchParams.get("case"), "2026-09-10");
  await layout();
  stage = "PERSISTED_CHINESE";
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "检查走法", exact: true }).waitFor();
  assert.equal(await language().inputValue(), "zh");
  assert.equal(await page.locator("html").getAttribute("lang"), "zh-CN");

  stage = "CHINESE_ARCHIVE";
  await page.getByRole("button", { name: "档案", exact: true }).click();
  await page.getByRole("heading", { name: "谜题档案", exact: true }).waitFor();
  await page.getByLabel("档案月份", { exact: true }).selectOption("2026-09");
  await page.locator('.archive-cases time[datetime="2026-09-10"]').waitFor();
  assert.match(await page.locator(".archive-cases").innerText(), /\p{Script=Han}/u);
  await layout();
  stage = "RUSSIAN_ARCHIVE";
  await language().selectOption("ru");
  await page.getByRole("heading", { name: "Архив задач", exact: true }).waitFor();
  assert.equal(await page.getByLabel("Месяц архива", { exact: true }).inputValue(), "2026-09");
  assert.match(await page.locator(".archive-cases").innerText(), /\p{Script=Cyrillic}/u);
  await layout();
  stage = "ENGLISH_RESTORED";
  await language().selectOption("en");
  await page.getByRole("heading", { name: "The archive", exact: true }).waitFor();
  await page
    .locator(".archive-cases li")
    .filter({
      has: page.locator('time[datetime="2026-09-10"]'),
    })
    .getByRole("button")
    .click();
  await page.getByRole("grid").waitFor();
  assert.equal(await page.locator("h1").innerText(), originalTitle);
  assert.equal(attempts, 0);
  assert.equal(clueRequests, 0);
  // No traces, screenshots, response bodies, puzzle text or storage are exported.
  console.log(
    JSON.stringify({
      ok: true,
      locales: ["en", "ru", "zh"],
      englishDefault: true,
      selectedDatePreserved: true,
      persistedChoice: true,
      archiveAndProgress: true,
      clueHidden: true,
      assistanceCostShown: true,
      personalRatingVerified: true,
      viewports: [320, 390, 1440],
      submittedAttempts: attempts,
    }),
  );
} catch {
  console.error(JSON.stringify({ ok: false, code: `LIVE_LOCALES_UI_${stage}_FAILED` }));
  process.exitCode = 1;
} finally {
  await browser?.close();
}
