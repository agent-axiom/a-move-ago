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

  useEffect(() => {
    if (!enabled || caseDate !== null) return;
    let observedDate = new Date(runtime.now()).toISOString().slice(0, 10);
    let midnightTimer: ReturnType<typeof setTimeout> | undefined;

    const checkDate = () => {
      const now = runtime.now();
      const currentDate = new Date(now).toISOString().slice(0, 10);
      if (currentDate !== observedDate) {
        observedDate = currentDate;
        setRevision((value) => value + 1);
      }
      clearTimeout(midnightTimer);
      const midnight = new Date(now);
      midnight.setUTCHours(24, 0, 0, 0);
      midnightTimer = setTimeout(checkDate, midnight.valueOf() - now);
    };
    const checkVisibleDate = () => {
      if (document.visibilityState === "visible") checkDate();
    };

    checkDate();
    // Suspended tabs may miss the midnight timer; check again when the host resumes them.
    document.addEventListener("visibilitychange", checkVisibleDate);
    window.addEventListener("focus", checkDate);
    return () => {
      clearTimeout(midnightTimer);
      document.removeEventListener("visibilitychange", checkVisibleDate);
      window.removeEventListener("focus", checkDate);
    };
  }, [caseDate, enabled, runtime]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: revision retries or rolls over daily.
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
