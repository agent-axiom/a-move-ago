import { ApiTransportError } from "@a-move-ago/api-contract";
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

function setup() {
  const runtime = runtimeFixture({ storedToken: "guest-token", platformKind: "web" });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <RuntimeProvider runtime={runtime}>{children}</RuntimeProvider>
  );
  const hook = renderHook(() => useAttempt("case-2026-08-03", "opening-exd5"), { wrapper });
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

it("discards a late hint response after a newer submit", async () => {
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
  expect(vi.mocked(runtime.api.requestHint).mock.calls[0]?.[2]?.aborted).toBe(true);
  expect(result.current.hints).toEqual({ tag: "idle", items: [] });

  await act(async () => {
    resolveOldHint?.({ level: 1, text: "This response is stale.", exhausted: false });
    await Promise.resolve();
  });
  expect(result.current.hints).toEqual({ tag: "idle", items: [] });
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
