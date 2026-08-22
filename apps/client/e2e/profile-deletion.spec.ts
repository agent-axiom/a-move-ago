import { expect, test } from "@playwright/test";
import { installApiMock } from "./api-mock";

const storageKey = "amoveago.session.v1";
const telegramToken = "t".repeat(43);

async function installTelegramToken(page: import("@playwright/test").Page) {
  await page.addInitScript(({ key, token }) => localStorage.setItem(key, token), {
    key: storageKey,
    token: telegramToken,
  });
}

test("deletes a restored Telegram profile, preserves its token, and continues as a guest", async ({
  page,
}) => {
  await installTelegramToken(page);
  const observed = await installApiMock(page, { initialIdentity: "telegram" });

  await page.goto("./?case=2026-08-03");
  await expect(page.getByRole("heading", { name: "The missing pawn" })).toBeVisible();
  expect(observed.guestChannels).toEqual([]);
  expect(observed.dailyIdentities).toEqual(["telegram"]);

  await page.getByRole("button", { name: "Progress" }).click();
  await expect(page.getByText("Connected as profile-deletion-e2e-marker")).toBeVisible();
  await expect.poll(() => observed.statsIdentities.slice()).toEqual(["telegram"]);
  await expect(
    page.getByText("Current streak", { exact: true }).locator("xpath=following-sibling::dd[1]"),
  ).toHaveText("4");

  await page.getByRole("button", { name: "Delete Telegram profile" }).click();
  expect(observed.profileDeleteRequests).toEqual([]);
  await expect(
    page.getByText(/This permanently deletes your A MOVE AGO Telegram profile/),
  ).toBeVisible();

  await page.getByRole("button", { name: "Delete permanently" }).click();
  const success = page
    .getByRole("status")
    .filter({ hasText: "Telegram profile deleted. You are now playing as a guest." });
  await expect(success).toBeVisible();
  await expect(success).toBeFocused();
  await expect(page.getByText("Playing as a guest", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Save progress with Telegram" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Delete Telegram profile" })).toHaveCount(0);
  await expect(page.getByText("Connected as profile-deletion-e2e-marker")).toHaveCount(0);
  await expect(
    page.getByText("Current streak", { exact: true }).locator("xpath=following-sibling::dd[1]"),
  ).toHaveText("0");
  await expect.poll(() => observed.statsIdentities.slice()).toEqual(["telegram", "guest"]);
  expect(observed.profileDeleteRequests).toEqual([
    { authorization: `Bearer ${telegramToken}`, body: null },
  ]);
  expect(await page.evaluate((key) => localStorage.getItem(key), storageKey)).toBe(telegramToken);

  await page.getByRole("button", { name: "Back to case" }).click();
  await expect(page.getByRole("heading", { name: "A pawn vanished" })).toBeVisible();
  await expect.poll(() => observed.dailyIdentities.slice()).toEqual(["telegram", "guest"]);

  await page.getByRole("gridcell", { name: "d5, white pawn" }).click();
  await page.getByRole("gridcell", { name: "e4, empty" }).click();
  await page.getByLabel("Captured piece").selectOption("p");
  await page.getByRole("button", { name: "Submit retraction" }).click();
  await expect(page.getByRole("heading", { name: "Solved" })).toBeVisible();
});

test("retries safely after the first committed deletion response is lost", async ({ page }) => {
  await installTelegramToken(page);
  const observed = await installApiMock(page, {
    initialIdentity: "telegram",
    loseFirstProfileDeletionResponse: true,
  });
  const expectedRequest = { authorization: `Bearer ${telegramToken}`, body: null };

  await page.goto("./?case=2026-08-03");
  await page.getByRole("button", { name: "Progress" }).click();
  await expect(page.getByText("Connected as profile-deletion-e2e-marker")).toBeVisible();
  await page.getByRole("button", { name: "Delete Telegram profile" }).click();
  await page.getByRole("button", { name: "Delete permanently" }).click();

  await expect(page.getByRole("alert")).toHaveText(/could not be confirmed.*Retry/);
  await expect(page.getByText("Connected as profile-deletion-e2e-marker")).toBeVisible();
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "Telegram profile deleted. You are now playing as a guest." }),
  ).toHaveCount(0);
  const retry = page.getByRole("button", { name: "Delete permanently" });
  await expect(retry).toBeEnabled();
  expect(observed.profileDeleteRequests).toEqual([expectedRequest]);

  await retry.click();
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "Telegram profile deleted. You are now playing as a guest." }),
  ).toBeVisible();
  expect(observed.profileDeleteRequests).toEqual([expectedRequest, expectedRequest]);
  await expect.poll(() => observed.statsIdentities.slice()).toEqual(["telegram", "guest"]);
  expect(await page.evaluate((key) => localStorage.getItem(key), storageKey)).toBe(telegramToken);
});
