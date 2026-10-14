import { DailyCaseResponseSchema, StatsResponseSchema } from "@a-move-ago/api-contract";
import { expect, test } from "@playwright/test";

test.skip(process.env.LIVE_API_E2E !== "true", "Requires the seeded local Worker on port 8787.");

test("guest solves the seeded case through Worker and retains D1 progress after reload", async ({
  page,
}) => {
  // Keep host detection deterministic; every API request still reaches the real Worker.
  await page.route("https://telegram.org/js/telegram-web-app.js?63", (route) =>
    route.fulfill({ contentType: "application/javascript", body: "" }),
  );
  let guestRequests = 0;
  let statsRequests = 0;
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (request.method() === "POST" && path === "/v1/sessions/guest") guestRequests += 1;
    if (request.method() === "GET" && path === "/v1/me/stats") statsRequests += 1;
  });

  const dailyResponsePromise = page.waitForResponse(
    (response) =>
      response.request().method() === "GET" && new URL(response.url()).pathname === "/v1/daily",
  );
  await page.goto("./");
  const dailyResponse = await dailyResponsePromise;
  expect(new URL(dailyResponse.url()).origin).toMatch(/^http:\/\/(?:localhost|127\.0\.0\.1):8787$/);
  expect(dailyResponse.status()).toBe(200);
  const daily = DailyCaseResponseSchema.parse(await dailyResponse.json());
  expect(daily.id).toBe(`dev-sample-${daily.date}`);
  expect(daily.puzzles.map((puzzle) => puzzle.id)).toEqual([
    `dev-sample-${daily.date}-opening-exd5`,
  ]);
  expect(daily.solvedPuzzleIds).toEqual([]);
  await expect(
    page.getByRole("heading", { level: 1, name: "Development sample: The missing pawn", exact: true }),
  ).toBeVisible();
  expect(guestRequests).toBe(1);

  await page.getByRole("gridcell", { name: "d5, white pawn" }).click();
  await page.getByRole("gridcell", { name: "e4, empty" }).click();
  await page.getByLabel("Captured piece").selectOption("p");
  const attemptResponsePromise = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" && new URL(response.url()).pathname === "/v1/attempts",
  );
  await page.getByRole("button", { name: "Submit retraction" }).click();
  const attemptResponse = await attemptResponsePromise;
  expect(attemptResponse.status()).toBe(201);
  expect(await attemptResponse.json()).toMatchObject({
    correct: true,
    reveal: { forwardSan: "exd5" },
  });
  await expect(page.getByRole("heading", { name: "Solved", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue", exact: true })).toBeEnabled();
  expect(statsRequests).toBe(0);

  const statsResponsePromise = page.waitForResponse(
    (response) =>
      response.request().method() === "GET" && new URL(response.url()).pathname === "/v1/me/stats",
  );
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  const statsResponse = await statsResponsePromise;
  expect(statsResponse.status()).toBe(200);
  const stats = StatsResponseSchema.parse(await statsResponse.json());
  expect(stats).toEqual({
    attempts: 1,
    hintsUsed: 0,
    solvedPuzzles: 1,
    completedCases: 1,
    currentStreak: 1,
    bestStreak: 1,
    lastCompletedDate: daily.date,
  });
  await expect(page.getByRole("heading", { name: "Case complete", exact: true })).toBeVisible();
  await expect(page.locator("dt", { hasText: "Current streak" }).locator("+ dd")).toHaveText("1");

  const restoredDailyPromise = page.waitForResponse(
    (response) =>
      response.request().method() === "GET" && new URL(response.url()).pathname === "/v1/daily",
  );
  const restoredStatsPromise = page.waitForResponse(
    (response) =>
      response.request().method() === "GET" && new URL(response.url()).pathname === "/v1/me/stats",
  );
  await page.reload();
  const restoredDailyResponse = await restoredDailyPromise;
  expect(restoredDailyResponse.status()).toBe(200);
  const restoredDaily = DailyCaseResponseSchema.parse(await restoredDailyResponse.json());
  expect(restoredDaily.solvedPuzzleIds).toEqual(daily.puzzles.map((puzzle) => puzzle.id));
  const restoredStatsResponse = await restoredStatsPromise;
  expect(restoredStatsResponse.status()).toBe(200);
  expect(StatsResponseSchema.parse(await restoredStatsResponse.json())).toEqual(stats);
  await expect(page.getByRole("heading", { name: "Case complete", exact: true })).toBeVisible();
  expect(guestRequests).toBe(1);
  expect(statsRequests).toBe(2);
});
