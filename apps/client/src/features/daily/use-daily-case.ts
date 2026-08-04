import type { DailyCaseResponseSchema } from "@a-move-ago/api-contract";
import { useCallback, useEffect, useState } from "react";
import type { z } from "zod";
import { useRuntime } from "../../app/runtime";
import { type ClientFailure, classifyFailure } from "../../shared/failure";
import { retryGet } from "../../shared/retry-get";

export type DailyCase = z.infer<typeof DailyCaseResponseSchema>;

export type DailyLoadState =
  | { tag: "idle" }
  | { tag: "loading" }
  | { tag: "ready"; daily: DailyCase }
  | { tag: "error"; failure: ClientFailure };

export function useDailyCase(enabled: boolean, caseDate: string | null) {
  const runtime = useRuntime();
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<DailyLoadState>({ tag: "idle" });

  // biome-ignore lint/correctness/useExhaustiveDependencies: revision intentionally retriggers explicit retries.
  useEffect(() => {
    if (!enabled) {
      setState({ tag: "idle" });
      return;
    }
    const controller = new AbortController();
    setState({ tag: "loading" });
    void retryGet(() => runtime.api.getDaily(caseDate ?? undefined, controller.signal), {
      maxAttempts: 3,
      baseDelayMs: 250,
      random: Math.random,
      sleep: runtime.sleep,
      signal: controller.signal,
    })
      .then((daily) => {
        if (!controller.signal.aborted) setState({ tag: "ready", daily });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setState({ tag: "error", failure: classifyFailure(error) });
        }
      });
    return () => controller.abort();
  }, [caseDate, enabled, revision, runtime]);

  const retry = useCallback(() => setRevision((value) => value + 1), []);
  return { state, retry };
}
