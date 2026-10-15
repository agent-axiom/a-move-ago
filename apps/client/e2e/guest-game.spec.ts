import { expect, test } from "@playwright/test";
import { installApiMock } from "./api-mock";

async function chooseCorrectRetraction(page: import("@playwright/test").Page) {
  await page.getByRole("gridcell", { name: "d5, white pawn" }).click();
  await page.getByRole("gridcell", { name: "e4, empty" }).click();
  await page.getByLabel("Captured piece").selectOption("p");
  await page.getByRole("button", { name: "Submit retraction" }).click();
}

test("guest survives a lost success response and retries the exact UUID", async ({ page }) => {
  const observed = await installApiMock(page, { loseFirstAttempt: true });
  const dailyPayloads: unknown[] = [];
  page.on("response", (response) => {
    if (new URL(response.url()).pathname === "/v1/daily") {
      void response.json().then((body) => dailyPayloads.push(body));
    }
  });
  await page.goto("./?case=2026-08-03");
  await expect(page.getByRole("heading", { name: "The missing pawn" })).toBeVisible();
  await expect.poll(() => dailyPayloads.length).toBe(1);
  const dailyPayload = JSON.stringify(dailyPayloads[0]);
  expect(dailyPayload).not.toContain("acceptedSolutions");
  expect(dailyPayload).not.toContain("previousFen");
  expect(observed.guestChannels).toEqual(["web"]);

  await chooseCorrectRetraction(page);
  await expect(page.getByRole("button", { name: "Retry attempt" })).toBeVisible();
  await page.getByRole("button", { name: "Retry attempt" }).click();
  await expect.poll(() => observed.attemptBodies.length).toBe(2);
  expect(observed.attemptBodies[1]?.attemptUuid).toBe(observed.attemptBodies[0]?.attemptUuid);
  expect(observed.attemptBodies[1]).toEqual(observed.attemptBodies[0]);
  await expect(page.getByRole("heading", { name: "Solved" })).toBeVisible();
  expect(observed.statsRequests).toBe(0);
  await expect(page.getByRole("button", { name: "Continue" })).toBeEnabled();
  expect(observed.statsRequests).toBe(0);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: "Case complete" })).toBeVisible();
  await expect.poll(() => observed.statsRequests).toBe(1);
  await expect(page.getByText("Current streak")).toBeVisible();
});

test("incorrect attempt retries the same hint level, then solves", async ({ page }) => {
  const observed = await installApiMock(page, { loseFirstHint: true });
  await page.goto("./?case=2026-08-03");
  await page.getByRole("gridcell", { name: "d5, white pawn" }).click();
  await page.getByRole("gridcell", { name: "c4, empty" }).click();
  await page.getByRole("button", { name: "Submit retraction" }).click();
  await expect(page.getByText("That does not explain the missing pawn.")).toBeVisible();
  await page.getByRole("button", { name: "Get hint" }).click();
  await expect(page.getByRole("button", { name: "Retry hint" })).toBeVisible();
  await page.getByRole("button", { name: "Retry hint" }).click();
  await expect
    .poll(() => observed.hintRequests)
    .toEqual([
      { attemptId: "33333333-3333-4333-8333-333333333333", level: 1 },
      { attemptId: "33333333-3333-4333-8333-333333333333", level: 1 },
    ]);
  await expect(page.getByText("A pawn changed files.")).toBeVisible();

  await page.getByRole("button", { name: "Reset" }).click();
  await chooseCorrectRetraction(page);
  await expect(page.getByRole("button", { name: "Continue" })).toBeEnabled();
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: "Case complete" })).toBeVisible();
});
