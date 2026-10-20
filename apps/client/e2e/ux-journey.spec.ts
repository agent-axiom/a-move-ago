import { expect, type Page, test } from "@playwright/test";
import { installApiMock } from "./api-mock";
import { selectCapturedPiece } from "./game-controls";
import { openMenu, setLanguage } from "./menu-controls";

test.use({ viewport: { width: 390, height: 844 } });

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
});

async function composeCapture(page: Page, previous: "c4" | "e4") {
  await page.getByRole("gridcell", { name: "d5, white pawn", exact: true }).click();
  await page.getByRole("gridcell", { name: `${previous}, empty`, exact: true }).click();
  await selectCapturedPiece(page, "p");
}

test("the guided first move is free, remembers completion and can be reopened from help", async ({
  page,
}) => {
  const observed = await installApiMock(page);
  await page.goto("./?case=2026-08-03");
  await page.getByRole("button", { name: "Learn in one move", exact: true }).click();
  const lesson = page.getByRole("dialog", { name: "Your first move back", exact: true });
  await expect(lesson).toBeVisible();
  await expect(lesson.getByRole("button", { name: "Check move", exact: true })).toBeDisabled();
  await lesson.getByRole("gridcell", { name: "e4, white pawn", exact: true }).click();
  await lesson.getByRole("gridcell", { name: "e3, empty", exact: true }).click();
  await lesson.getByRole("button", { name: "Check move", exact: true }).click();
  await expect(lesson).toContainText("Select e2 and try again — practice is free.");
  await lesson.getByRole("gridcell", { name: "e2, empty", exact: true }).click();
  await lesson.getByRole("button", { name: "Check move", exact: true }).click();
  await expect(
    lesson.getByRole("heading", { name: "You’ve gone one move back.", exact: true }),
  ).toBeVisible();
  await lesson.getByRole("button", { name: "Start solving", exact: true }).click();
  await expect(lesson).toHaveCount(0);
  await expect(page.locator(".score-attempt")).toHaveText("Attempt 1");
  await expect(page.locator(".score-potential")).toHaveText("Available: 100 points");
  await page.reload();
  await expect(page.locator(".score-potential")).toHaveText("Available: 100 points");
  await expect(page.getByRole("button", { name: "Learn in one move", exact: true })).toHaveCount(0);
  await openMenu(page);
  await page.locator(".how-to-play > summary").click();
  await expect(page.locator(".help-panel")).toBeVisible();
  await page.locator(".app-menu-learn").click();
  await expect(lesson).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(lesson).toHaveCount(0);
  expect(observed.attemptBodies).toEqual([]);
  expect(observed.clueRequests).toEqual([]);
  expect(observed.hintRequests).toEqual([]);
  expect(observed.revealRequests).toEqual([]);
});

test("an unfinished capture survives navigation, reload and language changes without spending an attempt", async ({
  page,
}) => {
  const observed = await installApiMock(page, { archive: true });
  await page.goto("./?case=2026-09-10");
  await expect(page.getByRole("grid")).toBeVisible();
  await expect(page.getByLabel("Captured piece", { exact: true })).toBeHidden();
  await composeCapture(page, "e4");
  await page.getByRole("button", { name: "Progress", exact: true }).click();
  await page.getByRole("button", { name: "Back to case", exact: true }).click();
  await expect(page.getByLabel("Captured piece", { exact: true })).toHaveValue("p");
  await expect(page.getByRole("gridcell", { name: "d5, white pawn", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await page.reload();
  await expect(page.getByLabel("Captured piece", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Captured piece", { exact: true })).toHaveValue("p");
  await setLanguage(page, "ru");
  await expect(page.getByLabel("Взятая фигура", { exact: true })).toHaveValue("p");
  await expect(page.getByRole("button", { name: "Проверить ход", exact: true })).toBeEnabled();
  await expect(page.locator(".score-potential")).toHaveText("Доступно: 100 очков");
  expect(new URL(page.url()).searchParams.get("case")).toBe("2026-09-10");
  expect(observed.attemptBodies).toEqual([]);
  expect(observed.clueRequests).toEqual([]);
  expect(observed.hintRequests).toEqual([]);
  await page.getByRole("button", { name: "Проверить ход", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Решено", exact: true })).toBeVisible();
  expect(observed.attemptBodies).toHaveLength(1);
  expect(observed.attemptBodies[0]?.retraction).toEqual({
    currentSquare: "d5",
    previousSquare: "e4",
    movedPiece: { color: "w", type: "p" },
    restoredPiece: { color: "b", type: "p", square: "d5" },
    special: "normal",
  });
});

test("a lost attempt response survives a restart and retries its original move and UUID once", async ({
  page,
}) => {
  const observed = await installApiMock(page, { loseFirstAttempt: true });
  await page.goto("./?case=2026-08-03");
  await composeCapture(page, "c4");
  await page.getByRole("button", { name: "Check move", exact: true }).click();
  await expect(page.getByRole("button", { name: "Retry attempt", exact: true })).toBeVisible();
  const frozenAttempt = structuredClone(observed.attemptBodies[0]);
  expect(frozenAttempt).toBeDefined();
  await page.reload();
  await expect(page.getByRole("button", { name: "Retry attempt", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Check move", exact: true })).toBeDisabled();
  expect(observed.attemptBodies).toHaveLength(1);
  await setLanguage(page, "ru");
  await page.getByRole("button", { name: "Повторить проверку", exact: true }).click();
  await expect(
    page.getByText("Этот ход не объясняет исчезновение пешки.", { exact: true }),
  ).toBeVisible();
  expect(observed.attemptBodies).toHaveLength(2);
  expect(observed.attemptBodies[1]).toEqual(frozenAttempt);
  await expect(page.locator(".score-attempt")).toHaveText("Попытка 2");
  await expect(page.locator(".score-potential")).toHaveText("Доступно: 70 очков");
  expect(observed.clueRequests).toEqual([]);
  expect(observed.hintRequests).toEqual([]);
});

test("a committed solve with a lost response is recovered on reload without sending another attempt", async ({
  page,
}) => {
  const observed = await installApiMock(page, { loseFirstAttempt: true });
  await page.goto("./?case=2026-08-03");
  await composeCapture(page, "e4");
  await page.getByRole("button", { name: "Check move", exact: true }).click();
  await expect(page.getByRole("button", { name: "Retry attempt", exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "Case complete", exact: true })).toBeVisible();
  await expect(page.locator(".personal-rating-total strong")).toHaveText("100");
  await expect(page.getByRole("button", { name: "Retry attempt", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Review solution", exact: true }).click();
  await expect(
    page.getByText("The white e-pawn captured the black pawn on d5.", { exact: true }),
  ).toBeVisible();
  expect(observed.attemptBodies).toHaveLength(1);
  expect(observed.revealRequests).toHaveLength(1);
});

test("finishing an archive case opens the latest published unsolved case with a fresh reward", async ({
  page,
}) => {
  const observed = await installApiMock(page, { archive: true });
  await page.goto("./?case=2026-09-10");
  await composeCapture(page, "e4");
  await page.getByRole("button", { name: "Check move", exact: true }).click();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.locator(".personal-rating-total strong")).toHaveText("100");
  await page.getByRole("button", { name: "Next unsolved puzzle", exact: true }).click();
  await expect(page.locator(".score-potential")).toHaveText("Available: 100 points");
  await expect(page.locator(".score-attempt")).toHaveText("Attempt 1");
  expect(new URL(page.url()).searchParams.get("case")).toBe("2026-10-15");
  expect(observed.dailyDates.at(-1)).toBe("2026-10-15");
  expect(observed.attemptBodies).toHaveLength(1);
  expect(observed.revealRequests).toEqual([]);
  expect(observed.clueRequests).toEqual([]);
});

test("a solved case can be reviewed after reload and translated without another attempt or reward", async ({
  page,
}) => {
  const observed = await installApiMock(page, { archive: true });
  await page.goto("./?case=2026-09-10");
  await composeCapture(page, "e4");
  await page.getByRole("button", { name: "Check move", exact: true }).click();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.locator(".personal-rating-total strong")).toHaveText("100");
  await page.reload();
  await page.getByRole("button", { name: "Review solution", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Solution review", exact: true })).toBeVisible();
  await expect(
    page.getByText("The white e-pawn captured the black pawn on d5.", { exact: true }),
  ).toBeVisible();
  await expect(page.locator(".solution-reward")).toHaveCount(0);
  await setLanguage(page, "ru");
  await expect(
    page.getByText("Белая пешка с вертикали e взяла чёрную пешку на d5.", { exact: true }),
  ).toBeVisible();
  await setLanguage(page, "zh");
  await expect(page.getByText("白方 e 线的兵吃掉了 d5 格的黑兵。", { exact: true })).toBeVisible();
  expect(observed.revealRequests).toEqual([
    { caseId: "case-2026-09-10", puzzleId: "p-case-2026-09-10-1-v1" },
  ]);
  await setLanguage(page, "en");
  await page.getByRole("button", { name: "Back to case", exact: true }).first().click();
  await expect(page.locator(".personal-rating-total strong")).toHaveText("100");
  await expect(page.getByRole("button", { name: "Review solution", exact: true })).toBeVisible();
  expect(observed.attemptBodies).toHaveLength(1);
  expect(observed.clueRequests).toEqual([]);
  expect(observed.hintRequests).toEqual([]);
});

test("reviewing an earlier act preserves the current act's move, hints and remaining reward", async ({
  page,
}) => {
  const observed = await installApiMock(page, { archive: true });
  await page.goto("./?case=2026-10-14");
  await expect(page.getByText("Act 2 of 2", { exact: true })).toBeVisible();
  await composeCapture(page, "c4");
  await page.getByRole("button", { name: "Check move", exact: true }).click();
  await page.getByRole("button", { name: /^Get hint/ }).click();
  await expect(page.getByText("A pawn changed files.", { exact: true })).toBeVisible();
  await expect(page.locator(".score-potential")).toHaveText("Available: 35 points");
  await page.getByRole("button", { name: "Review solution · Act 1 of 2", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Solution review", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Back to case", exact: true }).first().click();
  await expect(page.locator(".score-potential")).toBeVisible();
  await expect(page.locator(".score-potential")).toHaveText("Available: 35 points");
  await expect(page.locator(".score-attempt")).toHaveText("Attempt 2");
  await expect(page.getByText("A pawn changed files.", { exact: true })).toBeVisible();
  await expect(page.locator(".move-summary")).toContainText("c4");
  await expect(page.getByLabel("Captured piece", { exact: true })).toHaveValue("p");
  expect(observed.attemptBodies).toHaveLength(1);
  expect(observed.hintRequests).toHaveLength(1);
  expect(observed.revealRequests).toEqual([
    { caseId: "case-2026-10-14", puzzleId: "p-case-2026-10-14-1-v1" },
  ]);
});
