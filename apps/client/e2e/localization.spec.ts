import { expect, test } from "@playwright/test";
import { installApiMock } from "./api-mock";
import { selectCapturedPiece } from "./game-controls";
import { closeMenu, languageSelect, openMenu, setLanguage } from "./menu-controls";

// A browser's own language must not silently change the product's English default.
test.use({ locale: "zh-CN" });

test("English is the default and language changes preserve the selected date and move draft", async ({
  page,
}) => {
  const observed = await installApiMock(page, { archive: true });
  await page.goto("./?case=2026-09-10");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await openMenu(page);
  await expect(languageSelect(page)).toHaveValue("en");
  await expect(languageSelect(page).locator("option")).toHaveText(["English", "Русский", "中文"]);
  await closeMenu(page);
  await expect(page.getByRole("heading", { name: "Daily case", exact: true })).toBeVisible();
  await page.getByRole("gridcell", { name: "d5, white pawn", exact: true }).click();
  await page.getByRole("gridcell", { name: "e4, empty", exact: true }).click();
  await selectCapturedPiece(page, "p");
  const requests = observed.dailyDates.length;

  await setLanguage(page, "ru");
  await expect(page.locator("html")).toHaveAttribute("lang", "ru");
  await expect(page.getByRole("heading", { name: "Задача дня", exact: true })).toBeVisible();
  await expect(page.locator(".puzzle-prompt")).toHaveText("Восстановите последний ход.");
  await expect(page.locator(".clue-prompt")).toHaveCount(0);
  await expect(
    page.getByRole("gridcell", { name: "d5, белая пешка", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(page.getByLabel("Взятая фигура", { exact: true })).toHaveValue("p");
  await expect(page.getByRole("button", { name: "Проверить ход", exact: true })).toBeEnabled();
  expect(new URL(page.url()).searchParams.get("case")).toBe("2026-09-10");

  await setLanguage(page, "zh");
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
  await expect(page.getByRole("heading", { name: "每日棋题", exact: true })).toBeVisible();
  await expect(page.locator(".puzzle-prompt")).toHaveText("还原上一步棋。");
  await expect(page.locator(".clue-prompt")).toHaveCount(0);
  await expect(page.getByLabel("被吃的棋子", { exact: true })).toHaveValue("p");
  await expect(page.getByRole("button", { name: "检查走法", exact: true })).toBeEnabled();
  expect(observed.dailyDates.length).toBe(requests);
  expect(observed.attemptBodies).toEqual([]);

  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
  await openMenu(page);
  await expect(languageSelect(page)).toHaveValue("zh");
  await closeMenu(page);
  await expect(page.getByRole("heading", { name: "每日棋题", exact: true })).toBeVisible();
  expect(new URL(page.url()).searchParams.get("case")).toBe("2026-09-10");
  await setLanguage(page, "en");
  await expect(page.getByRole("heading", { name: "Daily case", exact: true })).toBeVisible();
});

test("authorized hints and solution explanations translate without restarting an attempt", async ({
  page,
}) => {
  const observed = await installApiMock(page, { loseFirstHint: true });
  const publicResponses: unknown[] = [];
  page.on("response", (response) => {
    if (new URL(response.url()).pathname === "/v1/daily") {
      void response.json().then((body) => publicResponses.push(body));
    }
  });
  await page.goto("./?case=2026-08-03");
  await page.getByRole("gridcell", { name: "d5, white pawn", exact: true }).click();
  await page.getByRole("gridcell", { name: "c4, empty", exact: true }).click();
  await selectCapturedPiece(page, "p");
  await page.getByRole("button", { name: "Check move", exact: true }).click();
  await expect(
    page.getByText("That does not explain the missing pawn.", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: /^Get hint/, exact: true }).click();
  await expect(page.getByRole("button", { name: "Retry hint", exact: true })).toBeVisible();

  await setLanguage(page, "ru");
  await expect(
    page.getByText("Этот ход не объясняет исчезновение пешки.", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Повторить загрузку подсказки", exact: true }).click();
  await expect(page.getByText("Пешка сменила вертикаль.", { exact: true })).toBeVisible();
  expect(observed.hintRequests).toEqual([
    { attemptId: "33333333-3333-4333-8333-333333333333", level: 1 },
    { attemptId: "33333333-3333-4333-8333-333333333333", level: 1 },
  ]);
  await setLanguage(page, "zh");
  await expect(page.getByText("一枚兵换了纵线。", { exact: true })).toBeVisible();
  await expect(page.getByText("这一步无法解释兵为何消失。", { exact: true })).toBeVisible();
  expect(observed.attemptBodies).toHaveLength(1);

  await page.getByRole("button", { name: "重置", exact: true }).click();
  await page.getByRole("gridcell", { name: "d5, 白兵", exact: true }).click();
  await page.getByRole("gridcell", { name: "e4, 空格", exact: true }).click();
  await selectCapturedPiece(page, "p", "zh");
  await page.getByRole("button", { name: "检查走法", exact: true }).click();
  await expect(page.getByRole("heading", { name: "已解答", exact: true })).toBeVisible();
  await expect(page.getByText("白方 e 线的兵吃掉了 d5 格的黑兵。", { exact: true })).toBeVisible();
  await setLanguage(page, "ru");
  await expect(page.getByRole("heading", { name: "Решено", exact: true })).toBeVisible();
  await expect(
    page.getByText("Белая пешка с вертикали e взяла чёрную пешку на d5.", { exact: true }),
  ).toBeVisible();
  await setLanguage(page, "en");
  await expect(page.getByRole("heading", { name: "Solved", exact: true })).toBeVisible();
  await expect(
    page.getByText("The white e-pawn captured the black pawn on d5.", { exact: true }),
  ).toBeVisible();
  expect(observed.attemptBodies).toHaveLength(2);
  expect(observed.statsRequests).toBe(0);
  await expect.poll(() => publicResponses.length).toBe(1);
  const publicJson = JSON.stringify(publicResponses);
  for (const field of ["previousFen", "explanation", "acceptedSolutions", "hints"]) {
    expect(publicJson).not.toContain(`"${field}"`);
  }
});

test("archive month, progress navigation and historical links remain selected across languages", async ({
  page,
}) => {
  await installApiMock(page, { archive: true });
  await page.goto("./?view=archive&month=2026-09");
  await expect(page.getByRole("heading", { name: "The archive", exact: true })).toBeVisible();
  await expect(page.getByLabel("Archive month", { exact: true })).toHaveValue("2026-09");
  await setLanguage(page, "ru");
  await expect(page.getByRole("heading", { name: "Архив задач", exact: true })).toBeVisible();
  await expect(page.getByLabel("Месяц архива", { exact: true })).toHaveValue("2026-09");
  await expect(page.locator(".archive-cases")).toContainText("Задача дня");
  await expect(page.locator(".archive-cases")).not.toContainText("A quiet beginning");
  await page
    .locator(".archive-cases li")
    .filter({
      has: page.locator('time[datetime="2026-09-10"]'),
    })
    .getByRole("button")
    .click();
  await expect(page.getByRole("heading", { name: "Задача дня", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Прогресс", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Статистика", exact: true })).toBeVisible();
  await setLanguage(page, "zh");
  await expect(page.getByRole("heading", { name: "统计", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "返回谜题", exact: true }).click();
  await expect(page.getByRole("heading", { name: "每日棋题", exact: true })).toBeVisible();
  expect(new URL(page.url()).searchParams.get("case")).toBe("2026-09-10");
  await page.getByRole("button", { name: "档案", exact: true }).click();
  await expect(page.getByRole("heading", { name: "谜题档案", exact: true })).toBeVisible();
});

test("a retried attempt keeps its idempotency key when the language changes offline", async ({
  page,
}) => {
  const observed = await installApiMock(page, { loseFirstAttempt: true });
  await page.goto("./?case=2026-08-03");
  await page.getByRole("gridcell", { name: "d5, white pawn", exact: true }).click();
  await page.getByRole("gridcell", { name: "e4, empty", exact: true }).click();
  await selectCapturedPiece(page, "p");
  await page.getByRole("button", { name: "Check move", exact: true }).click();
  await expect(page.getByRole("button", { name: "Retry attempt", exact: true })).toBeVisible();
  await setLanguage(page, "ru");
  await page.getByRole("button", { name: "Повторить проверку", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Решено", exact: true })).toBeVisible();
  expect(observed.attemptBodies).toHaveLength(2);
  expect(observed.attemptBodies[1]).toEqual(observed.attemptBodies[0]);
});
