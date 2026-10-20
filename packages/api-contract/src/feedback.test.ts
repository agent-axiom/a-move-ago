import { describe, expect, it, vi } from "vitest";
import { ApiContractError, createApiClient } from "./client";
import { FeedbackRequestSchema, FeedbackResponseSchema } from "./feedback";

const report = {
  reportUuid: "22222222-2222-4222-8222-222222222222",
  caseId: "case-2026-08-03",
  puzzleId: "p-case-2026-08-03-1-v1",
  puzzleVersion: 1,
  locale: "en" as const,
  reason: "alternative_answer" as const,
  comment: "I think a different return square may work.",
};

describe("private puzzle feedback contract", () => {
  it("accepts only explicit report fields and bounded text in supported languages", () => {
    for (const locale of ["en", "ru", "zh"]) {
      expect(FeedbackRequestSchema.parse({ ...report, locale, comment: "  Note  " }).comment).toBe(
        "Note",
      );
    }
    expect(FeedbackRequestSchema.parse({ ...report, comment: undefined }).comment).toBeUndefined();
    for (const value of [
      { ...report, comment: "a".repeat(1_001) },
      { ...report, locale: "de" },
      { ...report, reason: "unknown" },
      { ...report, puzzleVersion: 0 },
      { ...report, reportUuid: "not-a-uuid" },
      { ...report, token: "must-not-be-a-payload-field" },
      { ...report, retraction: { currentSquare: "d5" } },
    ]) {
      expect(FeedbackRequestSchema.safeParse(value).success).toBe(false);
    }
  });

  it("sends the chosen report through an authenticated request with the same UUID", async () => {
    const fetch = vi.fn().mockResolvedValue(
      Response.json({ reportUuid: report.reportUuid, received: true }, { status: 201 }),
    );
    const api = createApiClient({
      baseUrl: "https://api.test",
      fetch,
      getToken: () => "guest-token",
    });
    await expect(api.submitPuzzleFeedback(report)).resolves.toEqual({
      reportUuid: report.reportUuid,
      received: true,
    });
    expect(fetch).toHaveBeenCalledWith(
      "https://api.test/v1/feedback",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ authorization: "Bearer guest-token" }),
        body: JSON.stringify(report),
      }),
    );
  });

  it("rejects mismatched receipts and never treats an unconfirmed report as received", async () => {
    const fetch = vi.fn().mockResolvedValue(
      Response.json({ reportUuid: "11111111-1111-4111-8111-111111111111", received: true }),
    );
    const api = createApiClient({
      baseUrl: "https://api.test",
      fetch,
      getToken: () => "guest-token",
    });
    await expect(api.submitPuzzleFeedback(report)).rejects.toBeInstanceOf(ApiContractError);
    expect(
      FeedbackResponseSchema.safeParse({ reportUuid: report.reportUuid, received: false }).success,
    ).toBe(false);
  });
});
