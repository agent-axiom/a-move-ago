import { expect, test } from "@playwright/test";
import { installApiMock } from "./api-mock";
import { selectCapturedPiece } from "./game-controls";

test("a private report retries safely and leaves the selected move and reward unchanged", async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 640 });
  const observed = await installApiMock(page, { loseFirstFeedbackResponse: true });
  await page.goto("./?case=2026-08-03");
  await page.getByRole("button", { name: "Dismiss introduction", exact: true }).click();
  await page.getByRole("gridcell", { name: "d5, white pawn", exact: true }).click();
  await page.getByRole("gridcell", { name: "e4, empty", exact: true }).click();
  await selectCapturedPiece(page, "p");

  const opener = page.getByRole("button", { name: "Report a problem", exact: true });
  await opener.click();
  const dialog = page.getByRole("dialog", { name: "Help improve this puzzle", exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("radio", { name: "Another answer may be valid", exact: true }).check();
  await dialog
    .getByLabel("Tell us more (optional)", { exact: true })
    .fill("  Synthetic alternative for editorial review.  ");
  await dialog.getByRole("button", { name: "Send report", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Try again", exact: true })).toBeVisible();
  expect(observed.feedbackBodies).toHaveLength(1);
  expect(observed.attemptBodies).toEqual([]);

  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();
  await expect(page.locator(".move-summary")).toContainText("e4");
  await expect(page.locator(".score-potential")).toHaveText("Available: 100 points");
  await opener.click();
  await dialog.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(dialog.getByRole("heading", { name: "Report received", exact: true })).toBeVisible();
  expect(observed.feedbackBodies).toHaveLength(2);
  expect(observed.feedbackBodies[1]).toEqual(observed.feedbackBodies[0]);
  expect(observed.feedbackBodies[0]).toEqual({
    reportUuid: expect.any(String),
    caseId: "case-2026-08-03",
    puzzleId: "p-case-2026-08-03-1-v1",
    puzzleVersion: 1,
    locale: "en",
    reason: "alternative_answer",
    comment: "Synthetic alternative for editorial review.",
  });
  await dialog.getByRole("button", { name: "Back to the puzzle", exact: true }).click();
  await page.getByRole("button", { name: "Check move", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Solved", exact: true })).toBeVisible();
  await expect(page.locator(".solution-reward strong")).toHaveText("+100 points earned");
  expect(observed.attemptBodies).toHaveLength(1);
  expect(observed.clueRequests).toEqual([]);
  expect(observed.hintRequests).toEqual([]);
});
