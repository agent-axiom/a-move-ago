import { createHash } from "node:crypto";
import { expect, type Page, type TestInfo, test } from "@playwright/test";
import { installApiMock } from "./api-mock";
import { selectCapturedPiece } from "./game-controls";
import { setLanguage } from "./menu-controls";

test.skip(process.env.UI_PREVIEW !== "true", "Screenshots run only in the UI review workflow.");

async function openSyntheticCase(page: Page) {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await installApiMock(page);
  await page.goto("./?case=2026-08-03");
  await expect(page.getByRole("heading", { name: "Daily case", exact: true })).toBeVisible();
}

async function capture(page: Page, info: TestInfo, name: string, fullPage = true) {
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  const path = info.outputPath(`review-${name}.png`);
  const png = await page.screenshot({ path, fullPage, animations: "disabled" });
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
  const smallTargets = await page
    .locator("button, select, a[href], summary")
    .evaluateAll((elements) =>
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
  await page.locator(".advanced-move-details > summary").click();
  await page.getByLabel("Captured piece", { exact: true }).selectOption("p");
  await expect(page.getByRole("button", { name: "Check move", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Check move", exact: true }).hover();
  await expect(page.getByRole("button", { name: "Check move", exact: true })).toHaveCSS(
    "background-color",
    "rgb(233, 196, 152)",
  );
  await capture(page, info, "desktop-configured");
  await checkLayout(page);

  await page.getByRole("button", { name: "Reveal clue · 100 → 50 points", exact: true }).click();
  await expect(page.locator(".unlocked-clue")).toHaveText("A pawn vanished");
  await expect(page.locator(".clue-prompt")).toHaveText(
    "The last move was a white pawn capture. Retract it.",
  );
  await expect(page.locator(".score-potential")).toHaveText("Available: 50 points");
  await capture(page, info, "desktop-clue");
  await checkLayout(page);
  await page.getByRole("button", { name: "Check move", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Solved", exact: true })).toBeVisible();
  await expect(page.locator(".solution-reward strong")).toHaveText("+50 points earned");
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
    const actions = await page.locator(".composer-dock").boundingBox();
    const navigation = await page.locator(".app-nav").boundingBox();
    expect(actions).not.toBeNull();
    expect(navigation).not.toBeNull();
    if (!actions || !navigation) throw new Error("Game controls are unavailable");
    expect(actions.y, "Check stays within reach on phones").toBeGreaterThanOrEqual(0);
    expect(actions.y + actions.height, "Check does not overlap navigation").toBeLessThanOrEqual(
      navigation.y + 1,
    );
    expect(navigation.y + navigation.height).toBeLessThanOrEqual(845);
    await expect(page.locator(".game-support")).toBeVisible();
    await expect(page.locator(".advanced-move-details")).not.toHaveAttribute("open", "");
  }
  await page.setViewportSize({ width: 360, height: 640 });
  await page.getByRole("button", { name: "Dismiss introduction", exact: true }).click();
  await page.evaluate(() => window.scrollTo(0, 0));
  await capture(page, info, "mobile-360x640", false);
  await checkLayout(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("gridcell", { name: "d5, white pawn", exact: true }).click();
  await page.getByRole("gridcell", { name: "e4, empty", exact: true }).click();
  await page.locator(".advanced-move-details > summary").click();
  await page.getByLabel("Captured piece", { exact: true }).selectOption("p");
  await page.locator(".advanced-move-details > summary").click();
  await expect(page.locator(".advanced-move-summary")).toBeVisible();
  await expect(page.getByRole("button", { name: "Check move", exact: true })).toBeEnabled();
  await capture(page, info, "mobile-configured");
  await checkLayout(page);
  await page.getByRole("button", { name: "Reveal clue · 100 → 50 points", exact: true }).click();
  await expect(page.locator(".unlocked-clue")).toHaveText("A pawn vanished");
  await expect(page.locator(".clue-prompt")).toHaveText(
    "The last move was a white pawn capture. Retract it.",
  );
  await capture(page, info, "mobile-clue");
  await checkLayout(page);
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
  const labels =
    locale === "ru"
      ? {
          archiveButton: "Архив",
          archive: "Архив задач",
          progress: "Прогресс",
          statistics: "Статистика",
        }
      : { archiveButton: "档案", archive: "谜题档案", progress: "进度", statistics: "统计" };
  test(`${locale} daily, archive and progress remain readable on desktop and small phones`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await installApiMock(page, { archive: true });
    await page.goto("./?case=2026-09-10");
    await setLanguage(page, locale);
    await expect(
      page.getByRole("heading", {
        name: locale === "ru" ? "Задача дня" : "每日棋题",
        exact: true,
      }),
    ).toBeVisible();
    await capture(page, info, `${locale}-desktop-daily`);
    await checkLayout(page);
    await expect(page.getByRole("button", { name: "Check move", exact: true })).toHaveCount(0);
    for (const width of [320, 390, 768]) {
      await page.setViewportSize({ width, height: 844 });
      await checkLayout(page);
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await capture(page, info, `${locale}-mobile-daily`);
    await page
      .getByRole("button", {
        name: locale === "ru" ? "Открыть улику · 100 → 50 очков" : "揭示线索 · 100 → 50 分",
        exact: true,
      })
      .click();
    await expect(page.locator(".unlocked-clue")).toHaveText(
      locale === "ru" ? "Исчезнувшая пешка" : "一枚兵消失了",
    );
    await expect(page.locator(".clue-prompt")).toHaveText(
      locale === "ru"
        ? "Последним ходом белых было взятие пешкой. Отмените его."
        : "白方上一步用兵吃子。请撤回这一步。",
    );
    await capture(page, info, `${locale}-mobile-clue`);
    await checkLayout(page);
    await page.setViewportSize({ width: 320, height: 844 });
    await checkLayout(page);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await capture(page, info, `${locale}-desktop-clue`);
    await checkLayout(page);
    await page.setViewportSize({ width: 390, height: 844 });

    await page.getByRole("button", { name: labels.archiveButton, exact: true }).click();
    await expect(page.getByRole("heading", { name: labels.archive, exact: true })).toBeVisible();
    await page
      .locator("select")
      .filter({ has: page.locator('option[value="2026-09"]') })
      .selectOption("2026-09");
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

test("mobile tutorial and earned solution review remain usable on small phones", async ({
  page,
}, info) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 390, height: 844 });
  const observed = await installApiMock(page);
  await page.goto("./?case=2026-08-03");
  await page.getByRole("button", { name: "Learn in one move", exact: true }).click();
  const lesson = page.getByRole("dialog", { name: "Your first move back", exact: true });
  await expect(lesson).toBeVisible();
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await checkLayout(page);
    const dimensions = await lesson.evaluate((element) => ({
      content: element.scrollWidth,
      available: element.clientWidth,
    }));
    expect(dimensions.content).toBeLessThanOrEqual(dimensions.available + 1);
    await capture(page, info, `mobile-tutorial-${width}`);
  }
  await lesson.getByRole("gridcell", { name: "e4, white pawn", exact: true }).click();
  await lesson.getByRole("gridcell", { name: "e2, empty", exact: true }).click();
  await lesson.getByRole("button", { name: "Check move", exact: true }).click();
  await expect(
    lesson.getByRole("heading", { name: "You’ve gone one move back.", exact: true }),
  ).toBeVisible();
  await checkLayout(page);
  await capture(page, info, "mobile-tutorial-complete");
  expect(observed.attemptBodies).toHaveLength(0);
  expect(observed.clueRequests).toHaveLength(0);
  expect(observed.hintRequests).toHaveLength(0);
  await lesson.getByRole("button", { name: "Start solving", exact: true }).click();
  await expect(lesson).toHaveCount(0);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("gridcell", { name: "d5, white pawn", exact: true }).click();
  await page.getByRole("gridcell", { name: "e4, empty", exact: true }).click();
  await selectCapturedPiece(page, "p");
  await page.getByRole("button", { name: "Check move", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Solved", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("button", { name: "Review solution", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Solution review", exact: true })).toBeVisible();
  await expect(page.locator(".solved-review .solution-actions .button-primary")).toBeEnabled();
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await checkLayout(page);
    await capture(page, info, `mobile-solution-review-${width}`);
  }
  expect(observed.attemptBodies).toHaveLength(1);
  expect(observed.revealRequests).toHaveLength(1);
  await expect(page.locator(".solved-review .solution-reward")).toHaveCount(0);
});
