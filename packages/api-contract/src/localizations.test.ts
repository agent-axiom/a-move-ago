import { describe, expect, it } from "vitest";
import { LocalizationBundleSchema, LocalizedPuzzlePublicSchema } from "./localizations";
import { PuzzlePublicSchema } from "./puzzles";

const publicTexts = { title: "Title", prompt: "Prompt", provenance: "Author", license: "License" };
const puzzle = {
  id: "puzzle-one",
  version: 1,
  ...publicTexts,
  hints: ["Hint"],
  explanations: ["Explanation"],
  contradictionExplanations: {},
};
const translatedCase = { title: "Case", puzzles: [puzzle] };
const bundle = {
  version: 1,
  cases: [
    {
      caseId: "case-one",
      sourceDigest: "a".repeat(64),
      translations: { ru: translatedCase, zh: translatedCase },
    },
  ],
};

describe("localized content contracts", () => {
  it("requires both translated languages and a bound lowercase source digest", () => {
    expect(LocalizationBundleSchema.safeParse(bundle).success).toBe(true);
    const item = bundle.cases[0];
    expect(
      LocalizationBundleSchema.safeParse({
        ...bundle,
        cases: [{ ...item, translations: { ru: translatedCase } }],
      }).success,
    ).toBe(false);
    expect(
      LocalizationBundleSchema.safeParse({
        ...bundle,
        cases: [{ ...item, sourceDigest: "A".repeat(64) }],
      }).success,
    ).toBe(false);
  });

  it("rejects chess mutations and private fields in translated public text", () => {
    expect(
      LocalizedPuzzlePublicSchema.safeParse({ ...publicTexts, explanations: ["secret"] }).success,
    ).toBe(false);
    expect(
      LocalizationBundleSchema.safeParse({
        ...bundle,
        cases: [
          {
            ...bundle.cases[0],
            translations: {
              ru: { ...translatedCase, puzzles: [{ ...puzzle, postFen: "changed" }] },
              zh: translatedCase,
            },
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      PuzzlePublicSchema.shape.localizations.safeParse({
        ru: publicTexts,
        zh: { ...publicTexts, hints: ["secret"] },
      }).success,
    ).toBe(false);
  });
});
