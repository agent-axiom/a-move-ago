import { expect, it } from "vitest";
import { nextUnsolvedIndex } from "./case-progress";

it("preserves server puzzle order across multiple acts", () => {
  const ids = ["act-1", "act-2", "act-3"];
  expect(nextUnsolvedIndex(ids, new Set())).toBe(0);
  expect(nextUnsolvedIndex(ids, new Set(["act-1"]))).toBe(1);
  expect(nextUnsolvedIndex(ids, new Set(["act-1", "act-2"]))).toBe(2);
  expect(nextUnsolvedIndex(ids, new Set(ids))).toBeNull();
});
