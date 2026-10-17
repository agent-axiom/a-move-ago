import { afterEach, expect, it, vi } from "vitest";
import {
  clearGameDraft,
  clearGamePersistence,
  clearPendingAttempt,
  type GamePersistenceScope,
  gamePersistenceKey,
  readGameDraft,
  readPendingAttempt,
  writeGameDraft,
  writePendingAttempt,
} from "./persistence";

const scope: GamePersistenceScope = {
  actorKey: "opaque-guest-key",
  caseId: "case-2026-08-03",
  puzzleId: "opening-exd5",
  puzzleVersion: 1,
};
const draft = {
  tag: "configure",
  currentSquare: "d5",
  previousSquare: "e4",
  special: "normal",
  captureType: "p",
} as const;
const request = {
  attemptUuid: "22222222-2222-4222-8222-222222222222",
  caseId: scope.caseId,
  puzzleId: scope.puzzleId,
  retraction: {
    currentSquare: "d5",
    previousSquare: "e4",
    movedPiece: { color: "w", type: "p" },
    restoredPiece: { color: "b", type: "p", square: "d5" },
    special: "normal",
  },
} as const;

afterEach(() => {
  vi.restoreAllMocks();
  clearGamePersistence();
  localStorage.removeItem("unrelated-setting");
});

it("isolates saved work by actor, case, puzzle, and content version", () => {
  writeGameDraft(scope, draft);
  expect(readGameDraft({ ...scope })).toEqual(draft);
  for (const other of [
    { ...scope, actorKey: "another-player" },
    { ...scope, caseId: "another-case" },
    { ...scope, puzzleId: "another-puzzle" },
    { ...scope, puzzleVersion: 2 },
  ])
    expect(readGameDraft(other)).toBeNull();
  expect(readGameDraft()).toBeNull();
  expect(readGameDraft({ ...scope, actorKey: "" })).toBeNull();
});

it("keeps an unresolved request across draft reset and removes only its matching UUID", () => {
  writePendingAttempt(scope, request);
  expect(readGameDraft(scope)).toEqual(draft);
  clearGameDraft(scope);
  expect(readGameDraft(scope)).toBeNull();
  expect(readPendingAttempt(scope)).toEqual(request);
  clearPendingAttempt(scope, "another-request");
  expect(readPendingAttempt(scope)).toEqual(request);
  clearPendingAttempt(scope, request.attemptUuid);
  expect(readPendingAttempt(scope)).toBeNull();
  expect(localStorage.getItem(gamePersistenceKey(scope) ?? "")).toBeNull();
});

it("clears account-owned drafts without touching other settings", () => {
  localStorage.setItem("unrelated-setting", "ru");
  writeGameDraft(scope, draft);
  writePendingAttempt({ ...scope, actorKey: "another-player" }, request);
  clearGamePersistence();
  expect(readGameDraft(scope)).toBeNull();
  expect(readPendingAttempt({ ...scope, actorKey: "another-player" })).toBeNull();
  expect(localStorage.getItem("unrelated-setting")).toBe("ru");
});

it.each([
  "not json",
  JSON.stringify({ schema: 2, updatedAt: Date.now(), draft }),
  JSON.stringify({ schema: 1, updatedAt: Date.now(), draft: { ...draft, currentSquare: "z9" } }),
  JSON.stringify({ schema: 1, updatedAt: Date.now(), draft: { ...draft, captureType: "k" } }),
  JSON.stringify({ schema: 1, updatedAt: 0, draft }),
  JSON.stringify({
    schema: 1,
    updatedAt: Date.now(),
    pending: { ...request, puzzleId: "another-puzzle" },
  }),
])("discards corrupt, expired, unsupported, or mismatched persisted data", (raw) => {
  const key = gamePersistenceKey(scope) ?? "";
  localStorage.setItem(key, raw);
  expect(readGameDraft(scope)).toBeNull();
  expect(readPendingAttempt(scope)).toBeNull();
  expect(localStorage.getItem(key)).toBeNull();
});

it("bounds the number of saved positions and retains the newest work", () => {
  const clock = vi.spyOn(Date, "now");
  const start = Date.now();
  for (let index = 0; index < 40; index += 1) {
    clock.mockReturnValue(start + index);
    writeGameDraft({ ...scope, puzzleId: `puzzle-${index}` }, draft);
  }
  expect(readGameDraft({ ...scope, puzzleId: "puzzle-0" })).toBeNull();
  expect(readGameDraft({ ...scope, puzzleId: "puzzle-39" })).toEqual(draft);
  const keys = Object.keys(localStorage).filter((key) => key.startsWith("a-move-ago:game:"));
  expect(keys).toHaveLength(32);
});

it("keeps unresolved attempts when older editor drafts are pruned", () => {
  writePendingAttempt(scope, request);
  for (let index = 0; index < 40; index += 1) {
    writeGameDraft({ ...scope, puzzleId: `puzzle-${index}` }, draft);
  }
  expect(readPendingAttempt(scope)).toEqual(request);
});

it("continues safely when local storage access is denied or full", () => {
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("denied");
  });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("quota");
  });
  vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
    throw new Error("denied");
  });
  expect(() => {
    writeGameDraft(scope, draft);
    writePendingAttempt(scope, request);
    clearGameDraft(scope);
    clearGamePersistence();
  }).not.toThrow();
  expect(readGameDraft(scope)).toBeNull();
  expect(readPendingAttempt(scope)).toBeNull();
});
