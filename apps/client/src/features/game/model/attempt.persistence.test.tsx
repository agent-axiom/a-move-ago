import {
  ApiTransportError,
  type AttemptRequestSchema,
  type AttemptResultSchema,
} from "@a-move-ago/api-contract";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type { z } from "zod";
import { type AppRuntime, RuntimeProvider } from "../../../app/runtime";
import { runtimeFixture } from "../../../test/runtime-fixture";
import { useAttempt } from "./attempt";
import {
  clearGamePersistence,
  type GamePersistenceScope,
  readGameDraft,
  readPendingAttempt,
} from "./persistence";

const scope: GamePersistenceScope = {
  actorKey: "opaque-guest-key",
  caseId: "case-2026-08-03",
  puzzleId: "opening-exd5",
  puzzleVersion: 1,
};
const retraction = {
  currentSquare: "d5",
  previousSquare: "e4",
  movedPiece: { color: "w", type: "p" },
  restoredPiece: { color: "b", type: "p", square: "d5" },
  special: "normal",
} as const;
const incorrect = {
  id: "11111111-1111-4111-8111-111111111111",
  attemptUuid: "22222222-2222-4222-8222-222222222222",
  correct: false,
  contradiction: { code: "NOT_THE_LAST_MOVE", message: "Try another move." },
} satisfies z.infer<typeof AttemptResultSchema>;
const correct = {
  id: incorrect.id,
  attemptUuid: incorrect.attemptUuid,
  correct: true,
  reveal: {
    retraction,
    previousFen: "rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq d6 0 2",
    forwardSan: "exd5",
    explanation: "The white e-pawn captured the black pawn on d5.",
    historyConstraints: [
      { kind: "previous-castling", value: "KQkq" },
      { kind: "previous-en-passant", value: "d6" },
    ],
  },
} satisfies z.infer<typeof AttemptResultSchema>;

function wrapperFor(runtime: AppRuntime) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <RuntimeProvider runtime={runtime}>{children}</RuntimeProvider>;
  };
}

afterEach(() => {
  cleanup();
  clearGamePersistence();
});

it("restores an attempt interrupted by process shutdown and retries the exact persisted UUID", async () => {
  const firstRuntime = runtimeFixture({ storedToken: "guest-token", platformKind: "web" });
  firstRuntime.api.submitAttempt = vi.fn((request: z.infer<typeof AttemptRequestSchema>) => {
    expect(readPendingAttempt(scope)).toEqual(request);
    return new Promise<z.infer<typeof AttemptResultSchema>>(() => undefined);
  });
  const first = renderHook(() => useAttempt(scope.caseId, scope.puzzleId, undefined, scope), {
    wrapper: wrapperFor(firstRuntime),
  });
  await act(async () => {
    void first.result.current.submit(retraction);
    await Promise.resolve();
  });
  const request = vi.mocked(firstRuntime.api.submitAttempt).mock.calls[0]?.[0];
  const signal = vi.mocked(firstRuntime.api.submitAttempt).mock.calls[0]?.[1];
  first.unmount();
  expect(signal?.aborted).toBe(true);
  expect(readPendingAttempt(scope)).toEqual(request);

  const nextRuntime = runtimeFixture({ storedToken: "guest-token", platformKind: "web" });
  nextRuntime.attemptUuid = vi.fn(() => "44444444-4444-4444-8444-444444444444");
  nextRuntime.api.submitAttempt = vi.fn().mockResolvedValue(incorrect);
  const next = renderHook(() => useAttempt(scope.caseId, scope.puzzleId, undefined, { ...scope }), {
    wrapper: wrapperFor(nextRuntime),
  });
  expect(next.result.current.attempt.tag).toBe("retry");
  expect(next.result.current.blocked).toBe(true);
  expect(nextRuntime.api.submitAttempt).not.toHaveBeenCalled();
  await act(() => next.result.current.submit(retraction));
  expect(nextRuntime.api.submitAttempt).not.toHaveBeenCalled();
  await act(() => next.result.current.retryAttempt());
  expect(vi.mocked(nextRuntime.api.submitAttempt).mock.calls[0]?.[0]).toEqual(request);
  expect(nextRuntime.attemptUuid).not.toHaveBeenCalled();
  expect(next.result.current.attempt.tag).toBe("incorrect");
  expect(next.result.current.blocked).toBe(false);
  expect(readPendingAttempt(scope)).toBeNull();
  expect(readGameDraft(scope)).toMatchObject({
    currentSquare: "d5",
    previousSquare: "e4",
    captureType: "p",
  });
});

it("keeps a lost-response request through remount and clears all draft work only after the solve is confirmed", async () => {
  const runtime = runtimeFixture({ storedToken: "guest-token", platformKind: "web" });
  runtime.api.submitAttempt = vi
    .fn()
    .mockRejectedValueOnce(new ApiTransportError(new TypeError("offline")))
    .mockResolvedValueOnce(correct);
  const first = renderHook(() => useAttempt(scope.caseId, scope.puzzleId, undefined, scope), {
    wrapper: wrapperFor(runtime),
  });
  await act(() => first.result.current.submit(retraction));
  expect(first.result.current.attempt.tag).toBe("retry");
  first.unmount();
  const next = renderHook(() => useAttempt(scope.caseId, scope.puzzleId, undefined, scope), {
    wrapper: wrapperFor(runtime),
  });
  await act(() => next.result.current.retryAttempt());
  expect(next.result.current.attempt.tag).toBe("solved");
  expect(vi.mocked(runtime.api.submitAttempt).mock.calls[1]?.[0]).toEqual(
    vi.mocked(runtime.api.submitAttempt).mock.calls[0]?.[0],
  );
  expect(readPendingAttempt(scope)).toBeNull();
  expect(readGameDraft(scope)).toBeNull();
});

it("aborts an unresolved request when the actor changes and ignores its late result", async () => {
  const runtime = runtimeFixture({ storedToken: "guest-token", platformKind: "web" });
  let finish: ((value: typeof incorrect) => void) | undefined;
  runtime.api.submitAttempt = vi.fn(
    () =>
      new Promise<typeof incorrect>((resolve) => {
        finish = resolve;
      }),
  );
  const hook = renderHook(
    ({ actorKey }) => useAttempt(scope.caseId, scope.puzzleId, undefined, { ...scope, actorKey }),
    {
      initialProps: { actorKey: scope.actorKey },
      wrapper: wrapperFor(runtime),
    },
  );
  await act(async () => {
    void hook.result.current.submit(retraction);
    await Promise.resolve();
  });
  const signal = vi.mocked(runtime.api.submitAttempt).mock.calls[0]?.[1];
  hook.rerender({ actorKey: "another-player" });
  expect(signal?.aborted).toBe(true);
  expect(hook.result.current.attempt.tag).toBe("idle");
  await act(async () => {
    finish?.(incorrect);
    await Promise.resolve();
  });
  expect(hook.result.current.attempt.tag).toBe("idle");
  expect(readPendingAttempt({ ...scope, actorKey: "another-player" })).toBeNull();
});

it("does not reset an active attempt when the same scope is reconstructed on rerender", async () => {
  const runtime = runtimeFixture({ storedToken: "guest-token", platformKind: "web" });
  runtime.api.submitAttempt = vi
    .fn()
    .mockRejectedValue(new ApiTransportError(new TypeError("offline")));
  const hook = renderHook(() => useAttempt(scope.caseId, scope.puzzleId, undefined, { ...scope }), {
    wrapper: wrapperFor(runtime),
  });
  await act(() => hook.result.current.submit(retraction));
  const request =
    hook.result.current.attempt.tag === "retry" ? hook.result.current.attempt.request : null;
  hook.rerender();
  expect(hook.result.current.attempt.tag).toBe("retry");
  if (hook.result.current.attempt.tag === "retry")
    expect(hook.result.current.attempt.request).toBe(request);
});
