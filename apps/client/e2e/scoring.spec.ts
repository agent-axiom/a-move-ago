import { expect, type Page, test } from "@playwright/test";
import { installApiMock } from "./api-mock";
import { selectCapturedPiece } from "./game-controls";
import { setLanguage } from "./menu-controls";

async function chooseMove(page: Page, previous: "c4" | "e4") {
  await page.getByRole("gridcell", { name: "d5, white pawn", exact: true }).click();
  await page.getByRole("gridcell", { name: `${previous}, empty`, exact: true }).click();
  await selectCapturedPiece(page, "p");
  await page.getByRole("button", { name: "Check move", exact: true }).click();
}
async function postAttempt(page: Page, body: Record<string, unknown>) {
  return page.evaluate(async (input) => {
    const response = await fetch("https://api.test/v1/attempts", {
      method: "POST",
      headers: {
        authorization: `Bearer ${localStorage.getItem("amoveago.session.v1")}`,
        "content-type": "application/json",
        "x-game-progress": "1",
        "x-content-locales": "1",
      },
      body: JSON.stringify(input),
    });
    return {
      status: response.status,
      replayed: response.headers.get("idempotency-replayed"),
      body: await response.json(),
    };
  }, body);
}

test("a fresh unassisted solve awards 100 once across UUID replay, another UUID and reload", async ({
  page,
}) => {
  const observed = await installApiMock(page);
  const daily = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/v1/daily",
  );
  await page.goto("./?case=2026-08-03");
  const publicBody = await (await daily).json();
  expect(publicBody.puzzles[0].id).toBe("p-case-2026-08-03-1-v1");
  expect(JSON.stringify(publicBody)).not.toContain("The missing pawn");
  expect(JSON.stringify(publicBody)).not.toContain("A pawn vanished");
  expect(JSON.stringify(publicBody)).not.toContain("The last move was a white pawn capture.");
  expect(JSON.stringify(publicBody)).not.toContain("Последним ходом белых было взятие пешкой.");
  expect(JSON.stringify(publicBody)).not.toContain("白方上一步用兵吃子。");
  await expect(page.getByRole("heading", { name: "Daily case", exact: true })).toBeVisible();
  await expect(page.locator(".puzzle-prompt")).toHaveText("Reconstruct the last move.");
  await expect(page.locator(".unlocked-clue")).toHaveCount(0);
  await expect(page.locator(".clue-prompt")).toHaveCount(0);
  await expect(page.locator(".score-attempt")).toHaveText("Attempt 1");
  await expect(page.locator(".score-potential")).toHaveText("Available: 100 points");
  await expect(
    page.getByRole("button", { name: "Reveal clue · 100 → 50 points", exact: true }),
  ).toBeVisible();
  await chooseMove(page, "e4");
  await expect(page.locator(".solution-reward strong")).toHaveText("+100 points earned");
  expect(observed.clueRequests).toEqual([]);
  const original = observed.attemptBodies[0];
  expect(original).toBeDefined();
  if (!original) throw new Error("Synthetic attempt was not captured");
  const replay = await postAttempt(page, original);
  expect(replay.status).toBe(200);
  expect(replay.replayed).toBe("true");
  expect(replay.body.progress.earnedPoints).toBe(100);
  const another = await postAttempt(page, {
    ...original,
    attemptUuid: "99999999-9999-4999-8999-999999999999",
  });
  expect(another.status).toBe(201);
  expect(another.body.progress.earnedPoints).toBe(100);
  expect(another.body.progress.awardAttemptId).toBe(replay.body.progress.awardAttemptId);
  expect(another.body.id).not.toBe(another.body.progress.awardAttemptId);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.locator(".personal-rating-total strong")).toHaveText("100");
  await page.reload();
  await expect(page.locator(".personal-rating-total strong")).toHaveText("100");
  await expect(page.getByRole("heading", { name: "Case complete", exact: true })).toBeVisible();
});

test("wrong move and a retried clue grant yield 35, retaining assistance across locales, dates and reload", async ({
  page,
}) => {
  const observed = await installApiMock(page, { archive: true, loseFirstClue: true });
  await page.goto("./?case=2026-09-10");
  await chooseMove(page, "c4");
  await expect(page.locator(".score-attempt")).toHaveText("Attempt 2");
  await expect(page.locator(".score-potential")).toHaveText("Available: 70 points");
  await page.getByRole("button", { name: "Reveal clue · 70 → 35 points", exact: true }).click();
  await expect(page.getByRole("button", { name: "Retry clue", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Retry clue", exact: true }).click();
  await expect(page.locator(".unlocked-clue")).toHaveText("A pawn vanished");
  await expect(page.locator(".clue-prompt")).toHaveText(
    "The last move was a white pawn capture. Retract it.",
  );
  await expect(page.locator(".puzzle-prompt")).toHaveText("Reconstruct the last move.");
  await expect(page.locator(".score-potential")).toHaveText("Available: 35 points");
  expect(observed.clueRequests).toEqual([
    { caseId: "case-2026-09-10", puzzleId: "p-case-2026-09-10-1-v1" },
    { caseId: "case-2026-09-10", puzzleId: "p-case-2026-09-10-1-v1" },
  ]);
  await setLanguage(page, "ru");
  await expect(page.locator(".unlocked-clue")).toHaveText("Исчезнувшая пешка");
  await expect(page.locator(".clue-prompt")).toHaveText(
    "Последним ходом белых было взятие пешкой. Отмените его.",
  );
  await expect(page.locator(".puzzle-prompt")).toHaveText("Восстановите последний ход.");
  await expect(page.locator(".score-potential")).toHaveText("Доступно: 35 очков");
  await setLanguage(page, "zh");
  await expect(page.locator(".unlocked-clue")).toHaveText("一枚兵消失了");
  await expect(page.locator(".clue-prompt")).toHaveText("白方上一步用兵吃子。请撤回这一步。");
  await expect(page.locator(".puzzle-prompt")).toHaveText("还原上一步棋。");
  await expect(page.locator(".score-potential")).toHaveText("可得：35 分");
  await page.goto("./?case=2026-09-12");
  await expect(page.locator(".score-potential")).toHaveText("可得：100 分");
  await expect(page.locator(".clue-prompt")).toHaveCount(0);
  await page.goto("./?case=2026-09-10");
  await expect(page.locator(".unlocked-clue")).toHaveText("一枚兵消失了");
  await expect(page.locator(".clue-prompt")).toHaveText("白方上一步用兵吃子。请撤回这一步。");
  await expect(page.locator(".score-potential")).toHaveText("可得：35 分");
  await page.reload();
  await expect(page.locator(".score-potential")).toHaveText("可得：35 分");
  await expect(page.locator(".clue-prompt")).toHaveText("白方上一步用兵吃子。请撤回这一步。");
  expect(observed.clueRequests).toHaveLength(2);
  await page.getByRole("gridcell", { name: "d5, 白兵", exact: true }).click();
  await page.getByRole("gridcell", { name: "e4, 空格", exact: true }).click();
  await selectCapturedPiece(page, "p", "zh");
  await page.getByRole("button", { name: "检查走法", exact: true }).click();
  await expect(page.locator(".solution-reward strong")).toHaveText("已获得 +35 分");
  await page.getByRole("button", { name: "继续", exact: true }).click();
  await expect(page.locator(".personal-rating-total strong")).toHaveText("35");
});

test("distinct failed attempts reduce the reward to 70, 40 and 20", async ({ page }) => {
  const observed = await installApiMock(page);
  await page.goto("./?case=2026-08-03");
  await chooseMove(page, "c4");
  for (const [index, points] of [70, 40, 20].entries()) {
    await expect(page.locator(".score-attempt")).toHaveText(`Attempt ${index + 2}`);
    await expect(page.locator(".score-potential")).toHaveText(`Available: ${points} points`);
    if (index < 2) await page.getByRole("button", { name: "Check move", exact: true }).click();
  }
  expect(new Set(observed.attemptBodies.map((body) => body.attemptUuid)).size).toBe(3);
  await page.getByRole("button", { name: "Reset", exact: true }).click();
  await chooseMove(page, "e4");
  await expect(page.locator(".solution-reward strong")).toHaveText("+20 points earned");
});

test("guest points survive linking a Telegram identity and clear with profile deletion", async ({
  page,
}) => {
  await installApiMock(page);
  await page.goto("./?case=2026-08-03");
  await chooseMove(page, "e4");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.locator(".personal-rating-total strong")).toHaveText("100");
  await page.evaluate(async () => {
    const response = await fetch("https://api.test/v1/auth/telegram/mini-app", {
      method: "POST",
      headers: {
        authorization: `Bearer ${localStorage.getItem("amoveago.session.v1")}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ initData: "synthetic-consented-proof" }),
    });
    if (!response.ok) throw new Error("Synthetic identity exchange failed");
    const session = await response.json();
    localStorage.setItem("amoveago.session.v1", session.token);
  });
  await page.reload();
  await expect(page.locator(".personal-rating-total strong")).toHaveText("100");
  await page.getByRole("button", { name: "Progress", exact: true }).click();
  await expect(
    page.getByText("Connected as profile-deletion-e2e-marker", { exact: true }),
  ).toBeVisible();
  await expect(page.locator(".personal-rating-total strong")).toHaveText("100");
  await page.getByRole("button", { name: "Delete Telegram profile", exact: true }).click();
  await page.getByRole("button", { name: "Delete permanently", exact: true }).click();
  await expect(page.getByText("Playing as a guest", { exact: true })).toBeVisible();
  await expect(page.locator(".personal-rating-total strong")).toHaveText("0");
});
