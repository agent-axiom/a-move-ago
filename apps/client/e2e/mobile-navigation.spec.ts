import { expect, type Locator, test } from "@playwright/test";
import { installApiMock } from "./api-mock";
import { selectCapturedPiece } from "./game-controls";
import { closeMenu, languageSelect, openMenu, setLanguage } from "./menu-controls";

const labels = {
  en: {
    pawn: "d5, white pawn",
    previous: "e4, empty",
    check: "Check move",
    today: "Today",
    archive: "Archive",
    progress: "Progress",
    archiveHeading: "The archive",
  },
  ru: {
    pawn: "d5, белая пешка",
    previous: "e4, пусто",
    check: "Проверить ход",
    today: "Сегодня",
    archive: "Архив",
    progress: "Прогресс",
    archiveHeading: "Архив задач",
  },
  zh: {
    pawn: "d5, 白兵",
    previous: "e4, 空格",
    check: "检查走法",
    today: "今天",
    archive: "档案",
    progress: "进度",
    archiveHeading: "谜题档案",
  },
};

async function expectTouchTarget(locator: Locator) {
  await expect(locator).toBeVisible();
  expect(
    await locator.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
      return {
        visible:
          rect.top >= 0 &&
          rect.bottom <= window.innerHeight + 1 &&
          rect.left >= 0 &&
          rect.right <= window.innerWidth + 1,
        unblocked: hit !== null && element.contains(hit),
        largeEnough: rect.width >= 44 && rect.height >= 44,
      };
    }),
  ).toEqual({ visible: true, unblocked: true, largeEnough: true });
}

for (const locale of ["en", "ru", "zh"] as const) {
  for (const viewport of [
    { width: 320, height: 640 },
    { width: 360, height: 640 },
    { width: 390, height: 844 },
  ]) {
    test(`${locale}: game controls and navigation remain usable at ${viewport.width}px`, async ({
      page,
    }) => {
      await page.setViewportSize(viewport);
      await page.emulateMedia({ reducedMotion: "reduce" });
      const observed = await installApiMock(page, { archive: true });
      await page.goto("./");
      await page.getByRole("button", { name: "Dismiss introduction", exact: true }).click();
      if (locale !== "en") await setLanguage(page, locale);
      const copy = labels[locale];
      const board = page.getByRole("grid");
      await page.evaluate(() => window.scrollTo(0, 0));
      await expect(board).toBeVisible();
      if (viewport.width === 390) {
        const boardBox = await board.boundingBox();
        const composerBox = await page.locator(".composer-dock").boundingBox();
        if (!boardBox || !composerBox) throw new Error("Today's board is unavailable");
        expect(boardBox.y).toBeGreaterThanOrEqual(0);
        expect(
          boardBox.y + boardBox.height,
          "The full daily board is visible above the move controls",
        ).toBeLessThanOrEqual(composerBox.y + 1);
      }
      await board.evaluate((element) => element.scrollIntoView({ block: "center" }));
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
      ).toBe(true);
      await page.getByRole("gridcell", { name: copy.pawn, exact: true }).click();
      await page.getByRole("gridcell", { name: copy.previous, exact: true }).click();
      await selectCapturedPiece(page, "p", locale);
      const check = page.getByRole("button", { name: copy.check, exact: true });
      await expect(check).toBeEnabled();
      await expectTouchTarget(check);

      const navigation = page.locator(".app-nav");
      const today = navigation.getByRole("button", { name: copy.today, exact: true });
      const archive = navigation.getByRole("button", { name: copy.archive, exact: true });
      const progress = navigation.getByRole("button", { name: copy.progress, exact: true });
      for (const button of [today, archive, progress]) await expectTouchTarget(button);
      const checkBox = await check.boundingBox();
      const navBox = await navigation.boundingBox();
      expect(checkBox).not.toBeNull();
      expect(navBox).not.toBeNull();
      if (!checkBox || !navBox) throw new Error("Game navigation is unavailable");
      expect(checkBox.y + checkBox.height).toBeLessThanOrEqual(navBox.y + 1);

      await archive.click();
      await expect(
        page.getByRole("heading", { name: copy.archiveHeading, exact: true }),
      ).toBeVisible();
      await expect(archive).toHaveAttribute("aria-current", "page");
      await expect(page.locator(".composer-dock")).toHaveCount(0);
      await today.click();
      await expect(check).toBeEnabled();
      await expect(page.locator(".move-summary")).toContainText("e4");
      await expect(today).toHaveAttribute("aria-current", "page");
      expect(observed.attemptBodies).toEqual([]);
    });
  }
}

test("menu focus and locale changes preserve the current move", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 640 });
  const observed = await installApiMock(page);
  await page.goto("./?case=2026-08-03");
  await page.getByRole("button", { name: "Dismiss introduction", exact: true }).click();
  await page.getByRole("gridcell", { name: "d5, white pawn", exact: true }).click();
  await page.getByRole("gridcell", { name: "e4, empty", exact: true }).click();
  const menu = await openMenu(page);
  expect(await menu.evaluate((element) => element.matches(":modal"))).toBe(true);
  await expect(menu.locator(".app-menu-close")).toBeFocused();
  await languageSelect(page).selectOption("ru");
  await expect(languageSelect(page)).toHaveValue("ru");
  await page.locator(".app-menu-trigger").evaluate((element) => {
    if (element instanceof HTMLElement) element.focus();
  });
  expect(await menu.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  // Native modal dialogs allow Tab to visit browser chrome, but not the inert page.
  // See https://github.com/whatwg/html/issues/8339.
  for (let index = 0; index < 8; index += 1) {
    await page.keyboard.press("Tab");
    expect(
      await menu.evaluate(
        (element) =>
          element.contains(document.activeElement) || document.activeElement === document.body,
      ),
    ).toBe(true);
  }
  expect(await menu.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(page.locator(".app-menu-trigger")).toBeFocused();
  await expect(page.locator(".move-summary")).toContainText("e4");
  await expect(
    page.getByRole("gridcell", { name: "d5, белая пешка", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await openMenu(page);
  await languageSelect(page).selectOption("zh");
  await closeMenu(page);
  await expect(page.locator(".app-menu-trigger")).toBeFocused();
  await expect(page.locator(".move-summary")).toContainText("e4");
  expect(observed.attemptBodies).toEqual([]);
});
