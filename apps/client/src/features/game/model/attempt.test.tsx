import { ApiTransportError, type PuzzleProgress } from "@a-move-ago/api-contract";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { expect, it, vi } from "vitest";
import { RuntimeProvider } from "../../../app/runtime";
import { runtimeFixture } from "../../../test/runtime-fixture";
import { useAttempt } from "./attempt";

const retraction = {
  currentSquare: "d5",
  previousSquare: "e4",
  movedPiece: { color: "w", type: "p" },
  restoredPiece: { color: "b", type: "p", square: "d5" },
  special: "normal",
} as const;

function setup(progress?: PuzzleProgress) {
  const runtime = runtimeFixture({ storedToken: "guest-token", platformKind: "web" });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <RuntimeProvider runtime={runtime}>{children}</RuntimeProvider>
  );
  const hook = renderHook(() => useAttempt("case-2026-08-03", "opening-exd5", progress), { wrapper });
  return { runtime, ...hook };
}

it("retries a lost attempt response with the same object and UUID", async () => {
  const { runtime, result } = setup();
  runtime.api.submitAttempt = vi
    .fn()
    .mockRejectedValueOnce(new ApiTransportError(new TypeError("offline")))
    .mockResolvedValueOnce({
      id: "11111111-1111-4111-8111-111111111111",
      attemptUuid: "22222222-2222-4222-8222-222222222222",
      correct: false,
      contradiction: { code: "NOT_THE_LAST_MOVE", message: "The pawn came from another square." },
    });

  await act(() => result.current.submit(retraction));
  expect(result.current.attempt.tag).toBe("retry");
  expect(runtime.api.submitAttempt).toHaveBeenCalledOnce();
  await act(() => result.current.retryAttempt());

  const first = vi.mocked(runtime.api.submitAttempt).mock.calls[0]?.[0];
  const second = vi.mocked(runtime.api.submitAttempt).mock.calls[1]?.[0];
  expect(second).toBe(first);
  expect(first?.attemptUuid).toBe("22222222-2222-4222-8222-222222222222");
  expect(result.current.attempt.tag).toBe("incorrect");
});

it("uses the server attempt ID and same requested hint level on explicit retry", async () => {
  const { runtime, result } = setup();
  runtime.api.submitAttempt = vi.fn().mockResolvedValue({
    id: "11111111-1111-4111-8111-111111111111",
    attemptUuid: "22222222-2222-4222-8222-222222222222",
    correct: false,
    contradiction: { code: "NOT_THE_LAST_MOVE", message: "Try another move." },
  });
  runtime.api.requestHint = vi
    .fn()
    .mockRejectedValueOnce(new ApiTransportError(new TypeError("offline")))
    .mockResolvedValueOnce({ level: 1, text: "A pawn changed files.", exhausted: false });

  await act(() => result.current.submit(retraction));
  await act(() => result.current.requestHint());
  expect(result.current.hints.tag).toBe("retry");
  await act(() => result.current.retryHint());
  expect(
    vi.mocked(runtime.api.requestHint).mock.calls.map(([attemptId, level]) => [attemptId, level]),
  ).toEqual([
    ["11111111-1111-4111-8111-111111111111", 1],
    ["11111111-1111-4111-8111-111111111111", 1],
  ]);
  expect(result.current.hints).toMatchObject({
    tag: "idle",
    items: [{ level: 1, text: "A pawn changed files.", exhausted: false }],
  });
});

it("serializes hint and attempt requests and keeps earned hints for the next attempt", async () => {
  const { runtime, result } = setup();
  runtime.api.submitAttempt = vi
    .fn()
    .mockResolvedValueOnce({
      id: "11111111-1111-4111-8111-111111111111",
      attemptUuid: "22222222-2222-4222-8222-222222222222",
      correct: false,
      contradiction: { code: "NOT_THE_LAST_MOVE", message: "Try another move." },
    })
    .mockResolvedValueOnce({
      id: "44444444-4444-4444-8444-444444444444",
      attemptUuid: "22222222-2222-4222-8222-222222222222",
      correct: false,
      contradiction: { code: "NOT_THE_LAST_MOVE", message: "Still not the last move." },
    });

  let resolveOldHint:
    | ((hint: { level: number; text: string; exhausted: boolean }) => void)
    | undefined;
  runtime.api.requestHint = vi.fn(
    () =>
      new Promise<{ level: number; text: string; exhausted: boolean }>((resolve) => {
        resolveOldHint = resolve;
      }),
  );

  await act(() => result.current.submit(retraction));
  await act(async () => {
    void result.current.requestHint();
    await Promise.resolve();
  });
  expect(result.current.hints.tag).toBe("loading");

  await act(() => result.current.submit(retraction));
  expect(runtime.api.submitAttempt).toHaveBeenCalledOnce();
  expect(vi.mocked(runtime.api.requestHint).mock.calls[0]?.[2]?.aborted).toBe(false);
  expect(result.current.hints.tag).toBe("loading");

  await act(async () => {
    resolveOldHint?.({ level: 1, text: "An earned clue.", exhausted: false });
    await Promise.resolve();
  });
  await act(() => result.current.submit(retraction));
  expect(runtime.api.submitAttempt).toHaveBeenCalledTimes(2);
  expect(result.current.hints).toMatchObject({
    tag: "idle", items: [{ level: 1, text: "An earned clue.", exhausted: false }],
  });
});

it("aborts and discards an in-flight attempt when puzzle identity changes", async () => {
  const runtime = runtimeFixture({ storedToken: "guest-token", platformKind: "web" });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <RuntimeProvider runtime={runtime}>{children}</RuntimeProvider>
  );
  const lateAttempt = {
    id: "11111111-1111-4111-8111-111111111111",
    attemptUuid: "22222222-2222-4222-8222-222222222222",
    correct: false,
    contradiction: { code: "NOT_THE_LAST_MOVE", message: "This response is stale." },
  } as const;
  let resolveOldAttempt: ((attempt: typeof lateAttempt) => void) | undefined;
  runtime.api.submitAttempt = vi.fn(
    () =>
      new Promise<typeof lateAttempt>((resolve) => {
        resolveOldAttempt = resolve;
      }),
  );
  const { result, rerender } = renderHook(({ caseId, puzzleId }) => useAttempt(caseId, puzzleId), {
    initialProps: { caseId: "case-2026-08-03", puzzleId: "opening-exd5" },
    wrapper,
  });

  await act(async () => {
    void result.current.submit(retraction);
    await Promise.resolve();
  });
  const oldSignal = vi.mocked(runtime.api.submitAttempt).mock.calls[0]?.[1];
  expect(result.current.attempt.tag).toBe("submitting");
  expect(oldSignal?.aborted).toBe(false);

  rerender({ caseId: "case-2026-08-03", puzzleId: "middlegame-pin" });
  expect(oldSignal?.aborted).toBe(true);
  expect(result.current.attempt).toEqual({ tag: "idle" });
  expect(result.current.hints).toEqual({ tag: "idle", items: [] });

  await act(async () => {
    resolveOldAttempt?.(lateAttempt);
    await Promise.resolve();
  });
  expect(result.current.attempt).toEqual({ tag: "idle" });

  runtime.api.submitAttempt = vi.fn().mockResolvedValue({
    id: "44444444-4444-4444-8444-444444444444",
    attemptUuid: "22222222-2222-4222-8222-222222222222",
    correct: false,
    contradiction: { code: "NOT_THE_LAST_MOVE", message: "Try another move." },
  });
  await act(() => result.current.submit(retraction));
  expect(vi.mocked(runtime.api.submitAttempt).mock.calls[0]?.[0]).toMatchObject({
    caseId: "case-2026-08-03",
    puzzleId: "middlegame-pin",
  });
});

it("aborts and discards in-flight work when the runtime is replaced", async () => {
  const firstRuntime = runtimeFixture({ storedToken: "first-token", platformKind: "web" });
  const secondRuntime = runtimeFixture({ storedToken: "second-token", platformKind: "web" });
  let currentRuntime = firstRuntime;
  const wrapper = ({ children }: { children: ReactNode }) => (
    <RuntimeProvider runtime={currentRuntime}>{children}</RuntimeProvider>
  );
  const lateAttempt = {
    id: "11111111-1111-4111-8111-111111111111",
    attemptUuid: "22222222-2222-4222-8222-222222222222",
    correct: false,
    contradiction: { code: "NOT_THE_LAST_MOVE", message: "This response is stale." },
  } as const;
  let resolveOldAttempt: ((attempt: typeof lateAttempt) => void) | undefined;
  firstRuntime.api.submitAttempt = vi.fn(
    () =>
      new Promise<typeof lateAttempt>((resolve) => {
        resolveOldAttempt = resolve;
      }),
  );
  secondRuntime.api.submitAttempt = vi.fn().mockResolvedValue({
    id: "44444444-4444-4444-8444-444444444444",
    attemptUuid: "22222222-2222-4222-8222-222222222222",
    correct: false,
    contradiction: { code: "NOT_THE_LAST_MOVE", message: "Try another move." },
  });
  const { result, rerender } = renderHook(() => useAttempt("case-2026-08-03", "opening-exd5"), {
    wrapper,
  });

  await act(async () => {
    void result.current.submit(retraction);
    await Promise.resolve();
  });
  const oldSignal = vi.mocked(firstRuntime.api.submitAttempt).mock.calls[0]?.[1];
  expect(result.current.attempt.tag).toBe("submitting");

  currentRuntime = secondRuntime;
  rerender();
  expect(oldSignal?.aborted).toBe(true);
  expect(result.current.attempt).toEqual({ tag: "idle" });
  expect(result.current.hints).toEqual({ tag: "idle", items: [] });

  await act(async () => {
    resolveOldAttempt?.(lateAttempt);
    await Promise.resolve();
  });
  expect(result.current.attempt).toEqual({ tag: "idle" });

  await act(() => result.current.submit(retraction));
  expect(firstRuntime.api.submitAttempt).toHaveBeenCalledOnce();
  expect(secondRuntime.api.submitAttempt).toHaveBeenCalledOnce();
});

it("allocates and freezes one request for synchronous duplicate submits", async () => {
  const { runtime, result } = setup();
  runtime.attemptUuid = vi.fn(() => "22222222-2222-4222-8222-222222222222");
  const response = {
    id: "11111111-1111-4111-8111-111111111111",
    attemptUuid: "22222222-2222-4222-8222-222222222222",
    correct: false,
    contradiction: { code: "NOT_THE_LAST_MOVE", message: "Try another move." },
  } as const;
  let resolveAttempt: ((value: typeof response) => void) | undefined;
  runtime.api.submitAttempt = vi.fn(
    () =>
      new Promise<typeof response>((resolve) => {
        resolveAttempt = resolve;
      }),
  );

  await act(async () => {
    void result.current.submit(retraction);
    void result.current.submit(retraction);
    await Promise.resolve();
  });

  expect(runtime.attemptUuid).toHaveBeenCalledOnce();
  expect(runtime.api.submitAttempt).toHaveBeenCalledOnce();
  const request = vi.mocked(runtime.api.submitAttempt).mock.calls[0]?.[0];
  expect(Object.isFrozen(request)).toBe(true);
  expect(Object.isFrozen(request?.retraction)).toBe(true);
  expect(Object.isFrozen(request?.retraction.movedPiece)).toBe(true);
  expect(Object.isFrozen(request?.retraction.restoredPiece)).toBe(true);

  await act(async () => {
    resolveAttempt?.(response);
    await Promise.resolve();
  });
});

function progressState(overrides: Partial<PuzzleProgress> = {}): PuzzleProgress {
  return {
    attemptCount: 0,
    assistanceCount: 0,
    clueUnlocked: false,
    highestHintLevel: 0,
    earnedPoints: null,
    nextAttemptPoints: 100,
    legacySolved: false,
    awardAttemptId: null,
    earnedHints: [],
    ...overrides,
  };
}

it("restores earned hints from the server and requests the next level after another attempt", async () => {
  const earnedHint = { level: 1, text: "An existing hint.", exhausted: false };
  const restored = progressState({
    attemptCount: 1, assistanceCount: 1, highestHintLevel: 1,
    nextAttemptPoints: 35, earnedHints: [earnedHint],
  });
  const { runtime, result } = setup(restored);
  expect(result.current.progress).toEqual(restored);
  expect(result.current.hints.items).toEqual([earnedHint]);
  runtime.api.submitAttempt = vi.fn().mockResolvedValue({
    id: "11111111-1111-4111-8111-111111111111",
    attemptUuid: "22222222-2222-4222-8222-222222222222",
    correct: false,
    contradiction: { code: "NOT_THE_LAST_MOVE", message: "Try another move." },
    progress: { ...restored, attemptCount: 2, nextAttemptPoints: 20 },
  });
  const secondHint = { level: 2, text: "The next hint.", exhausted: true };
  runtime.api.requestHint = vi.fn().mockResolvedValue({
    ...secondHint,
    progress: progressState({
      attemptCount: 2, assistanceCount: 2, highestHintLevel: 2,
      nextAttemptPoints: 10, earnedHints: [earnedHint, secondHint],
    }),
  });
  await act(() => result.current.submit(retraction));
  expect(result.current.hints.items).toEqual([earnedHint]);
  await act(() => result.current.requestHint());
  expect(runtime.api.requestHint).toHaveBeenCalledWith(
    "11111111-1111-4111-8111-111111111111", 2, expect.any(AbortSignal),
  );
  expect(result.current.progress?.nextAttemptPoints).toBe(10);
  expect(result.current.hints.items).toEqual([earnedHint, secondHint]);
});

it("retries an ambiguous clue response before allowing a scored attempt", async () => {
  const { runtime, result } = setup(progressState());
  runtime.api.requestClue = vi.fn()
    .mockRejectedValueOnce(new ApiTransportError(new TypeError("offline")))
    .mockResolvedValueOnce({
      title: "A hidden title clue", prompt: "Mandatory conditions.",
      progress: progressState({ clueUnlocked: true, assistanceCount: 1, nextAttemptPoints: 50 }),
    });
  await act(() => result.current.requestClue());
  expect(result.current.clue.tag).toBe("retry");
  expect(result.current.progress?.nextAttemptPoints).toBe(100);
  await act(() => result.current.submit(retraction));
  expect(runtime.api.submitAttempt).not.toHaveBeenCalled();
  await act(() => result.current.retryClue());
  expect(vi.mocked(runtime.api.requestClue).mock.calls.map(([caseId, puzzleId]) => [caseId, puzzleId]))
    .toEqual([
      ["case-2026-08-03", "opening-exd5"],
      ["case-2026-08-03", "opening-exd5"],
    ]);
  expect(result.current.progress).toMatchObject({ clueUnlocked: true, assistanceCount: 1, nextAttemptPoints: 50 });
  expect(result.current.clue.content?.title).toBe("A hidden title clue");
  await act(() => result.current.requestClue());
  expect(runtime.api.requestClue).toHaveBeenCalledTimes(2);
});

it("allows one clue request at a time and discards a late unlock after changing puzzles", async () => {
  const runtime = runtimeFixture({ storedToken: "guest-token", platformKind: "web" });
  const wrapper = ({ children }: { children: ReactNode }) => <RuntimeProvider runtime={runtime}>{children}</RuntimeProvider>;
  const clue = { title: "A hidden title", prompt: "Conditions.", progress: progressState({ clueUnlocked: true, assistanceCount: 1, nextAttemptPoints: 50 }) };
  let resolveClue: ((value: typeof clue) => void) | undefined;
  runtime.api.requestClue = vi.fn(() => new Promise<typeof clue>((resolve) => { resolveClue = resolve; }));
  const { result, rerender } = renderHook(({ puzzleId }) => useAttempt("case-2026-08-03", puzzleId, progressState()), {
    initialProps: { puzzleId: "first-puzzle" }, wrapper,
  });
  await act(async () => {
    void result.current.requestClue();
    void result.current.requestClue();
    void result.current.submit(retraction);
    await Promise.resolve();
  });
  expect(runtime.api.requestClue).toHaveBeenCalledOnce();
  expect(runtime.api.submitAttempt).not.toHaveBeenCalled();
  const signal = vi.mocked(runtime.api.requestClue).mock.calls[0]?.[2];
  rerender({ puzzleId: "second-puzzle" });
  expect(signal?.aborted).toBe(true);
  await act(async () => { resolveClue?.(clue); await Promise.resolve(); });
  expect(result.current.clue).toEqual({ tag: "idle", content: null });
  expect(result.current.progress?.clueUnlocked).toBe(false);
  expect(result.current.progress?.nextAttemptPoints).toBe(100);
});
