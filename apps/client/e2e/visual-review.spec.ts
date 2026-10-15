import { createHash } from "node:crypto";
import { expect, type Page, type TestInfo, test } from "@playwright/test";
import { installApiMock } from "./api-mock";

test.skip(process.env.UI_PREVIEW !== "true", "Screenshots run only in the UI review workflow.");

async function openSyntheticCase(page: Page) {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await installApiMock(page);
  await page.goto("./?case=2026-08-03");
  await expect(page.getByRole("heading", { name: "The missing pawn", exact: true })).toBeVisible();
}

async function capture(page: Page, info: TestInfo, name: string) {
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  const path = info.outputPath(`review-${name}.png`);
  const png = await page.screenshot({ path, fullPage: true, animations: "disabled" });
  await info.attach(name, { path, contentType: "image/png" });

  // Synthetic fixtures only. Small log chunks allow review when artifact downloads are unavailable.
  const encoded = png.toString("base64");
  let count = 0;
  for (let offset = 0; offset < encoded.length; offset += 10_000) {
    console.log(`UI_PNG ${name} ${count} ${encoded.slice(offset, offset + 10_000)}`);
    count += 1;
  }
  console.log(`UI_PNG_END ${name} ${count} ${createHash("sha256").update(png).digest("hex")}`);
}

async function checkLayout(page: Page) {
  const widths = await page.evaluate(() => ({
    document: document.documentElement.scrollWidth,
    viewport: window.innerWidth,
  }));
  expect(widths.document, "Page must fit without horizontal scrolling").toBeLessThanOrEqual(
    widths.viewport + 1,
  );
  const smallTargets = await page.locator("button, select, a[href]").evaluateAll((elements) =>
    elements.flatMap((element) => {
      if (element.closest(".chessboard")) return [];
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      if (rect.width === 0 || rect.height === 0 || style.visibility === "hidden") return [];
      return rect.width >= 44 && rect.height >= 44
        ? []
        : [
            {
              label: element.getAttribute("aria-label") ?? element.textContent?.trim(),
              width: rect.width,
              height: rect.height,
            },
          ];
    }),
  );
  expect(smallTargets, "Non-board controls need 44px touch targets").toEqual([]);
}

test("desktop daily, configured move and solution reveal", async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await openSyntheticCase(page);
  await capture(page, info, "desktop-daily");
  await checkLayout(page);

  await page.getByRole("gridcell", { name: "d5, white pawn", exact: true }).click();
  await page.getByRole("gridcell", { name: "e4, empty", exact: true }).click();
  await page.getByLabel("Captured piece", { exact: true }).selectOption("p");
  await expect(page.getByRole("button", { name: "Check move", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Check move", exact: true }).hover();
  await expect(page.getByRole("button", { name: "Check move", exact: true })).toHaveCSS(
    "background-color",
    "rgb(233, 196, 152)",
  );
  await capture(page, info, "desktop-configured");
  await checkLayout(page);

  await page.getByRole("button", { name: "Check move", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Solved", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue", exact: true })).toBeEnabled();
  await capture(page, info, "desktop-reveal");
  await checkLayout(page);
});

test("mobile and tablet daily stay usable at 390, 320 and 768 pixels", async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openSyntheticCase(page);
  await capture(page, info, "mobile-daily");
  for (const width of [390, 320, 768]) {
    await page.setViewportSize({ width, height: 844 });
    await checkLayout(page);
    const grid = page.getByRole("grid", { name: "Interactive retraction board" });
    const board = await grid.boundingBox();
    expect(board).not.toBeNull();
    if (!board) throw new Error("Interactive board is unavailable");
    expect(board.width).toBeGreaterThanOrEqual(Math.min(width - 72, 550));
    expect(Math.abs(board.height - board.width)).toBeLessThanOrEqual(2);
  }
});

test("desktop guest progress", async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await openSyntheticCase(page);
  await page.getByRole("button", { name: "Progress", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Progress", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Statistics", exact: true })).toBeVisible();
  await capture(page, info, "desktop-progress");
  await checkLayout(page);
});

test("archive remains readable on desktop and mobile", async ({ page }, info) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await installApiMock(page, { archive: true });
  await page.goto("./?view=archive");
  await expect(page.getByRole("heading", { name: "The archive", exact: true })).toBeVisible();
  await page.getByLabel("Archive month", { exact: true }).selectOption({ label: "September 2026" });
  await capture(page, info, "desktop-archive");
  await checkLayout(page);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByLabel("Archive month", { exact: true }).selectOption({ label: "October 2026" });
  await capture(page, info, "mobile-archive");
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await checkLayout(page);
  }
});

for (const locale of ["ru", "zh"] as const) {
  const labels = locale === "ru"
    ? { archiveButton: "Архив", archive: "Архив задач",
        progress: "Прогресс", statistics: "Статистика" }
    : { archiveButton: "档案", archive: "谜题档案",
        progress: "进度", statistics: "统计" };
  test(`${locale} daily, archive and progress remain readable on desktop and small phones`, async ({ page }, info) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await installApiMock(page, { archive: true });
    await page.goto("./?case=2026-09-10");
    await page.getByLabel("Language", { exact: true }).selectOption(locale);
    await expect(page.getByRole("heading", {
      name: locale === "ru" ? "Тихое начало" : "安静的开始", exact: true,
    })).toBeVisible();
    await capture(page, info, `${locale}-desktop-daily`);
    await checkLayout(page);
    await expect(page.getByRole("button", { name: "Check move", exact: true })).toHaveCount(0);
    for (const width of [320, 390, 768]) {
      await page.setViewportSize({ width, height: 844 });
      await checkLayout(page);
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await capture(page, info, `${locale}-mobile-daily`);

    await page.getByRole("button", { name: labels.archiveButton, exact: true }).click();
    await expect(page.getByRole("heading", { name: labels.archive, exact: true })).toBeVisible();
    await page.locator("select").filter({ has: page.locator('option[value="2026-09"]') }).selectOption("2026-09");
    await capture(page, info, `${locale}-mobile-archive`);
    await checkLayout(page);
    await page.setViewportSize({ width: 320, height: 844 });
    await checkLayout(page);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await capture(page, info, `${locale}-desktop-archive`);
    await checkLayout(page);

    await page.getByRole("button", { name: labels.progress, exact: true }).click();
    await expect(page.getByRole("heading", { name: labels.statistics, exact: true })).toBeVisible();
    await capture(page, info, `${locale}-desktop-progress`);
    await checkLayout(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await capture(page, info, `${locale}-mobile-progress`);
    await checkLayout(page);
    await page.setViewportSize({ width: 320, height: 844 });
    await checkLayout(page);
  });
}
