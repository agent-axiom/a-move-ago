import type { ArchiveCase } from "@a-move-ago/api-contract";
import { expect, it, vi } from "vitest";
import { findNextUnsolvedCase } from "./next-unsolved";

function entry(date: string, completed = false): ArchiveCase {
  return { id: `case-${date}`, date, slug: `case-${date}`, title: "Daily case",
    puzzleCount: 1, solvedPuzzles: completed ? 1 : 0, completed };
}

it("finds the most recent unsolved case across months and skips current, solved and future dates", async () => {
  const api = { getArchive: vi.fn().mockResolvedValue({
    today: "2026-10-17", startsOn: "2026-09-10",
    cases: [entry("2026-09-10"), entry("2026-09-30"), entry("2026-10-16", true),
      entry("2026-10-17"), entry("2026-10-18")],
  }) };
  const signal = new AbortController().signal;
  expect(await findNextUnsolvedCase(api, "2026-10-17", signal)).toBe("2026-09-30");
  expect(api.getArchive).toHaveBeenCalledExactlyOnceWith(signal);
});

it("returns null after the last available case and propagates failures for retry", async () => {
  const api = { getArchive: vi.fn().mockResolvedValue({
    today: "2026-10-17", startsOn: "2026-10-16",
    cases: [entry("2026-10-17"), entry("2026-10-16", true)],
  }) };
  expect(await findNextUnsolvedCase(api, "2026-10-17")).toBeNull();
  api.getArchive.mockRejectedValueOnce(new Error("offline"));
  await expect(findNextUnsolvedCase(api, "2026-10-17")).rejects.toThrow("offline");
});
