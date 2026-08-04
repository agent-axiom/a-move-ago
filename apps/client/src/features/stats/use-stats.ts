import type { StatsResponseSchema } from "@a-move-ago/api-contract";
import { useCallback, useEffect, useState } from "react";
import type { z } from "zod";
import { type AppRuntime, useRuntime } from "../../app/runtime";
import { type ClientFailure, classifyFailure } from "../../shared/failure";
import { retryGet } from "../../shared/retry-get";

type Stats = z.infer<typeof StatsResponseSchema>;
type StatsState =
  | { tag: "loading" }
  | { tag: "ready"; stats: Stats }
  | { tag: "error"; failure: ClientFailure };

interface StatsSnapshot {
  enabled: boolean;
  refreshKey: string;
  revision: number;
  runtime: AppRuntime;
  state: StatsState;
}

const loadingState = { tag: "loading" } as const satisfies StatsState;

export function useStats(enabled: boolean, refreshKey = "default") {
  const runtime = useRuntime();
  const [revision, setRevision] = useState(0);
  const [snapshot, setSnapshot] = useState<StatsSnapshot>(() => ({
    enabled,
    refreshKey,
    revision,
    runtime,
    state: loadingState,
  }));
  useEffect(() => {
    const identity = { enabled, refreshKey, revision, runtime };
    setSnapshot({ ...identity, state: loadingState });
    if (!enabled) return;
    const controller = new AbortController();
    void retryGet(() => runtime.api.getStats(controller.signal), {
      maxAttempts: 3,
      baseDelayMs: 250,
      random: Math.random,
      sleep: runtime.sleep,
      signal: controller.signal,
    })
      .then((stats) => {
        if (!controller.signal.aborted) {
          setSnapshot({ ...identity, state: { tag: "ready", stats } });
        }
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setSnapshot({
            ...identity,
            state: { tag: "error", failure: classifyFailure(error) },
          });
        }
      });
    return () => controller.abort();
  }, [enabled, refreshKey, revision, runtime]);
  const state =
    snapshot.enabled === enabled &&
    snapshot.refreshKey === refreshKey &&
    snapshot.revision === revision &&
    snapshot.runtime === runtime
      ? snapshot.state
      : loadingState;
  return { state, retry: useCallback(() => setRevision((value) => value + 1), []) };
}
