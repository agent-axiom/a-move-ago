import { expect, test } from "@playwright/test";
import { installApiMock } from "./api-mock";

test("archive dates retain progress, deep links and browser navigation", async ({ page }) => {
  const observed = await installApiMock(page, { archive: true });
  await page.goto("./");
  await expect(
    page.getByRole("heading", { name: "Daily case", exact: true }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Archive", exact: true }).click();
  await expect(page.getByRole("heading", { name: "The archive", exact: true })).toBeVisible();
  await expect(page).toHaveURL(/[?&]view=archive(?:&|$)/);
  await page.getByLabel("Archive month", { exact: true }).selectOption({ label: "September 2026" });
  const firstCase = page.getByRole("button", {
    name: "Open case for 10 September 2026: Daily case",
    exact: true,
  });
  await expect(firstCase).toContainText("Not started");
  await expect(
    page.getByRole("button", { name: /^Open case for 11 September 2026:/ }),
  ).toContainText("Completed");
  await firstCase.click();
  await expect(page.getByRole("heading", { name: "Daily case", exact: true })).toBeVisible();
  await expect(page).toHaveURL(/[?&]case=2026-09-10(?:&|$)/);
  expect(observed.dailyDates).toContain("2026-09-10");

  await page.reload();
  await expect(page.getByRole("heading", { name: "Daily case", exact: true })).toBeVisible();
  await expect(page).toHaveURL(/[?&]case=2026-09-10(?:&|$)/);
  await page.goBack();
  await expect(page.getByRole("heading", { name: "The archive", exact: true })).toBeVisible();
  await expect(page.getByLabel("Archive month", { exact: true })).toHaveValue("2026-09");
  await page.getByLabel("Archive month", { exact: true }).selectOption({ label: "October 2026" });
  const recentCase = page.getByRole("button", {
    name: "Open case for 14 October 2026: Daily case",
    exact: true,
  });
  await expect(recentCase).toContainText("In progress");
  await expect(recentCase).toContainText(/1\s*(?:of|\/)\s*2/);
  await recentCase.click();
  await expect(page.getByRole("heading", { name: "Daily case", exact: true })).toBeVisible();
  await expect(page).toHaveURL(/[?&]case=2026-10-14(?:&|$)/);
  expect(observed.dailyDates).toContain("2026-10-14");

  await page.getByRole("button", { name: "Progress", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Progress", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Back to case", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Daily case", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Back to today", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Daily case", exact: true }),
  ).toBeVisible();
  await expect.poll(() => new URL(page.url()).searchParams.has("case")).toBe(false);
  expect(observed.guestChannels).toEqual(["web"]);
  expect(observed.archiveRequests).toBeGreaterThan(0);
});

test("archive and daily deep links do not expose future cases", async ({ page }) => {
  await installApiMock(page, { archive: true });
  await page.goto("./?view=archive");
  await expect(page.getByRole("heading", { name: "The archive", exact: true })).toBeVisible();
  await page.getByLabel("Archive month", { exact: true }).selectOption({ label: "October 2026" });
  const futureCase = page.getByRole("button", { name: /^Open case for 16 October 2026:/ });
  await expect(futureCase).toHaveCount(0);
  await expect(page.getByText("Future synthetic case", { exact: true })).toHaveCount(0);

  await page.goto("./?case=2026-10-16");
  await expect(page.getByRole("heading", { name: "Case unavailable", exact: true })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveText("There is no published case for this date.");
  await expect(page.getByRole("grid")).toHaveCount(0);
});
