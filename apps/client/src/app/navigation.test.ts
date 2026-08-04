import { describe, expect, it } from "vitest";
import { initialNavigation, navigationReducer } from "./navigation";

describe("memory navigation", () => {
  it("pushes a screen and returns to the case", () => {
    const initial = initialNavigation("2026-08-03");
    const profile = navigationReducer(initial, {
      type: "push",
      screen: { name: "profile" },
    });

    expect(profile.stack).toEqual([{ name: "case", caseDate: "2026-08-03" }, { name: "profile" }]);
    expect(navigationReducer(profile, { type: "back" }).stack).toEqual([
      { name: "case", caseDate: "2026-08-03" },
    ]);
    expect(initial.stack).toEqual([{ name: "case", caseDate: "2026-08-03" }]);
  });

  it("replaces only the current screen without mutating the prior stack", () => {
    const initial = initialNavigation(null);
    const hint = navigationReducer(initial, {
      type: "push",
      screen: { name: "hint", attemptId: "attempt-1" },
    });
    const priorStack = hint.stack;
    const result = navigationReducer(hint, {
      type: "replace",
      screen: { name: "result", puzzleId: "puzzle-1" },
    });

    expect(result.stack).toEqual([{ name: "case" }, { name: "result", puzzleId: "puzzle-1" }]);
    expect(hint.stack).toBe(priorStack);
    expect(hint.stack).toEqual([{ name: "case" }, { name: "hint", attemptId: "attempt-1" }]);
  });

  it("keeps the root state by identity when back cannot pop", () => {
    const initial = initialNavigation(null);

    expect(navigationReducer(initial, { type: "back" })).toBe(initial);
    expect(initial.stack).toEqual([{ name: "case" }]);
  });

  it("resets to one screen without mutating a frozen prior stack", () => {
    const initial = initialNavigation("2026-08-03");
    const profile = navigationReducer(initial, {
      type: "push",
      screen: { name: "profile" },
    });
    Object.freeze(profile.stack);
    Object.freeze(profile);

    const reset = navigationReducer(profile, {
      type: "reset",
      screen: { name: "case", caseDate: "2024-02-29" },
    });

    expect(reset).not.toBe(profile);
    expect(reset.stack).toEqual([{ name: "case", caseDate: "2024-02-29" }]);
    expect(profile.stack).toEqual([{ name: "case", caseDate: "2026-08-03" }, { name: "profile" }]);
  });
});
