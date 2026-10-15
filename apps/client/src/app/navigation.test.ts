import { describe, expect, it } from "vitest";
import {
  initialNavigation,
  initialNavigationFromUrl,
  navigationReducer,
  navigationUrl,
} from "./navigation";

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

  it("restores an archive stack without mutating it", () => {
    const saved = { stack: [{ name: "case" }, { name: "archive" }] } as const;
    Object.freeze(saved.stack);
    Object.freeze(saved);

    expect(navigationReducer(initialNavigation(null), { type: "restore", state: saved })).toBe(
      saved,
    );
    expect(navigationReducer(saved, { type: "back" }).stack).toEqual([{ name: "case" }]);
    expect(navigationReducer(saved, { type: "restore", state: { stack: [] } }).stack).toEqual([
      { name: "case" },
    ]);
  });
});

describe("navigation URLs", () => {
  it.each([
    ["?view=archive", [{ name: "case" }, { name: "archive" }]],
    [
      "?view=archive&month=2026-09",
      [{ name: "case" }, { name: "archive", month: "2026-09" }],
    ],
    ["?view=archive&month=2026-13", [{ name: "case" }, { name: "archive" }]],
    [
      "?view=archive&month=2026-09&month=2026-10",
      [{ name: "case" }, { name: "archive" }],
    ],
    ["?view=profile", [{ name: "case" }, { name: "profile" }]],
    ["?case=2024-02-29", [{ name: "case" }, { name: "case", caseDate: "2024-02-29" }]],
    ["?view=archive&case=2024-02-29", [{ name: "case" }, { name: "archive" }]],
    ["?case=2025-02-29", [{ name: "case" }]],
    ["?case=2024-02-29&case=2024-03-01", [{ name: "case" }]],
    ["?view=archive&view=profile", [{ name: "case" }]],
  ])("derives the initial route from %s", (query, stack) => {
    expect(initialNavigationFromUrl(new URL(`https://app.test/a-move-ago/${query}`)).stack).toEqual(
      stack,
    );
  });

  it("maps each route while preserving entry parameters and the Telegram hash", () => {
    const source = new URL(
      "https://app.test/a-move-ago/?case=2026-08-03&view=profile&campaign=summer" +
        "&handoff=raw%2Bproof&authError=access_denied#tgWebAppData=kept%2Braw",
    );
    for (const [screen, query] of [
      [{ name: "archive" }, "view=archive"],
      [{ name: "case", caseDate: "2024-02-29" }, "case=2024-02-29"],
      [{ name: "profile" }, "view=profile"],
      [{ name: "case" }, ""],
    ] as const) {
      const result = new URL(navigationUrl({ stack: [screen] }, source), source);
      expect(result.pathname).toBe("/a-move-ago/");
      expect(result.searchParams.get("campaign")).toBe("summer");
      expect(result.searchParams.get("handoff")).toBe("raw+proof");
      expect(result.searchParams.get("authError")).toBe("access_denied");
      expect(result.hash).toBe("#tgWebAppData=kept%2Braw");
      expect(result.searchParams.get("view")).toBe(new URLSearchParams(query).get("view"));
      expect(result.searchParams.get("case")).toBe(new URLSearchParams(query).get("case"));
    }
    expect(source.searchParams.get("case")).toBe("2026-08-03");
  });

  it("keeps the selected archive month in its route and clears it on case and profile routes", () => {
    const source = new URL(
      "https://app.test/a-move-ago/?view=archive&month=2026-10&keep=1#tgWebAppData=raw%2Bproof",
    );
    const selected = navigationUrl(
      { stack: [{ name: "case" }, { name: "archive", month: "2026-09" }] },
      source,
    );
    expect(selected).toBe(
      "/a-move-ago/?keep=1&view=archive&month=2026-09#tgWebAppData=raw%2Bproof",
    );
    for (const screen of [{ name: "case", caseDate: "2026-09-10" }, { name: "profile" }] as const) {
      const target = new URL(navigationUrl({ stack: [screen] }, source), source);
      expect(target.searchParams.has("month")).toBe(false);
    }
  });
});
