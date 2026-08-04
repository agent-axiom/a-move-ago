import { ApiTransportError } from "@a-move-ago/api-contract";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { type AppRuntime, RuntimeProvider } from "../../app/runtime";
import { runtimeFixture } from "../../test/runtime-fixture";
import { useStats } from "./use-stats";

const firstStats = {
  attempts: 5,
  hintsUsed: 2,
  solvedPuzzles: 3,
  completedCases: 1,
  currentStreak: 1,
  bestStreak: 2,
  lastCompletedDate: "2026-08-03",
};

const refreshedStats = {
  ...firstStats,
  attempts: 6,
  solvedPuzzles: 4,
  currentStreak: 2,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function runtimeWrapper(runtime: AppRuntime) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <RuntimeProvider runtime={runtime}>{children}</RuntimeProvider>;
  };
}

afterEach(cleanup);

it("waits for its gate and retries a transient stats GET", async () => {
  const runtime = runtimeFixture({ storedToken: "guest-token", platformKind: "web" });
  runtime.api.getStats = vi
    .fn()
    .mockRejectedValueOnce(new ApiTransportError(new TypeError("offline")))
    .mockResolvedValueOnce(firstStats);
  const view = renderHook(({ enabled }) => useStats(enabled), {
    initialProps: { enabled: false },
    wrapper: runtimeWrapper(runtime),
  });

  expect(runtime.api.getStats).not.toHaveBeenCalled();
  view.rerender({ enabled: true });

  await waitFor(() =>
    expect(view.result.current.state).toEqual({ tag: "ready", stats: firstStats }),
  );
  expect(runtime.api.getStats).toHaveBeenCalledTimes(2);
  expect(runtime.api.getStats).toHaveBeenNthCalledWith(1, expect.any(AbortSignal));
  expect(runtime.api.getStats).toHaveBeenNthCalledWith(2, expect.any(AbortSignal));
  expect(runtime.sleep).toHaveBeenCalledOnce();
});

it("aborts an obsolete refresh and ignores its late response", async () => {
  const runtime = runtimeFixture({ storedToken: "guest-token", platformKind: "web" });
  const first = deferred<typeof firstStats>();
  const second = deferred<typeof refreshedStats>();
  const signals: AbortSignal[] = [];
  runtime.api.getStats = vi.fn((signal?: AbortSignal) => {
    if (signal) signals.push(signal);
    return signals.length === 1 ? first.promise : second.promise;
  });
  const view = renderHook(({ refreshKey }) => useStats(true, refreshKey), {
    initialProps: { refreshKey: "first" },
    wrapper: runtimeWrapper(runtime),
  });
  await waitFor(() => expect(runtime.api.getStats).toHaveBeenCalledOnce());

  view.rerender({ refreshKey: "second" });
  await waitFor(() => expect(runtime.api.getStats).toHaveBeenCalledTimes(2));
  expect(signals[0]?.aborted).toBe(true);

  await act(async () => {
    second.resolve(refreshedStats);
    await second.promise;
  });
  await waitFor(() =>
    expect(view.result.current.state).toEqual({ tag: "ready", stats: refreshedStats }),
  );

  await act(async () => {
    first.resolve(firstStats);
    await first.promise;
  });
  expect(view.result.current.state).toEqual({ tag: "ready", stats: refreshedStats });
});

it("does not expose a resolved stats snapshot under a new refresh identity", async () => {
  const runtime = runtimeFixture({ storedToken: "guest-token", platformKind: "web" });
  runtime.api.getStats = vi.fn().mockResolvedValue(firstStats);
  const renderedTags: string[] = [];
  const view = renderHook(
    ({ refreshKey }) => {
      const result = useStats(true, refreshKey);
      renderedTags.push(result.state.tag);
      return result;
    },
    {
      initialProps: { refreshKey: "guest" },
      wrapper: runtimeWrapper(runtime),
    },
  );
  await waitFor(() => expect(view.result.current.state.tag).toBe("ready"));

  renderedTags.length = 0;
  view.rerender({ refreshKey: "telegram" });

  expect(renderedTags[0]).toBe("loading");
  await waitFor(() => expect(runtime.api.getStats).toHaveBeenCalledTimes(2));
});
