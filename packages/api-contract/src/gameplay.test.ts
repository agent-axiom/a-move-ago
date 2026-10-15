import { describe, expect, it } from "vitest";
import { ClueResponseSchema, PuzzleProgressSchema } from "./api";

const progress = {
  attemptCount: 2, assistanceCount: 1, clueUnlocked: true, highestHintLevel: 0,
  earnedPoints: 35, nextAttemptPoints: 0, legacySolved: false,
  awardAttemptId: "33333333-3333-4333-8333-333333333333", earnedHints: [],
};

describe("game progress contracts", () => {
  it("validates a settled award and nonrecursive earned hints", () => {
    expect(PuzzleProgressSchema.safeParse(progress).success).toBe(true);
    expect(PuzzleProgressSchema.safeParse({ ...progress, earnedHints: [{ level: 1, text: "Hint", exhausted: false, progress }] }).success).toBe(false);
    expect(PuzzleProgressSchema.safeParse({ ...progress, earnedPoints: -1 }).success).toBe(false);
    expect(PuzzleProgressSchema.safeParse({ ...progress, awardAttemptId: "not-an-id" }).success).toBe(false);
  });

  it("requires recorded progress with the disclosed clue", () => {
    expect(ClueResponseSchema.safeParse({ title: "Clue", prompt: "Conditions", progress }).success).toBe(true);
    expect(ClueResponseSchema.safeParse({ title: "Clue", prompt: "Conditions" }).success).toBe(false);
  });
});
