import type { ArchiveResponse } from "@a-move-ago/api-contract";
import { useCallback, useEffect, useState } from "react";
import { useRuntime } from "../../app/runtime";
import { type ClientFailure, classifyFailure } from "../../shared/failure";
import { retryGet } from "../../shared/retry-get";

export type ArchiveState =
  | { tag: "loading" }
  | { tag: "ready"; archive: ArchiveResponse }
  | { tag: "error"; failure: ClientFailure };

export function useArchive(enabled: boolean) {
  const runtime = useRuntime();
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<ArchiveState>({ tag: "loading" });

  useEffect(() => {
    if (!enabled) return;
    let observedDate = new Date(runtime.now()).toISOString().slice(0, 10);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const checkDate = () => {
      const now = runtime.now();
      const date = new Date(now).toISOString().slice(0, 10);
      if (date !== observedDate) {
        observedDate = date;
        setRevision((value) => value + 1);
      }
      clearTimeout(timer);
      const midnight = new Date(now);
      midnight.setUTCHours(24, 0, 0, 0);
      timer = setTimeout(checkDate, midnight.valueOf() - now);
    };
    const checkVisibleDate = () => {
      if (document.visibilityState === "visible") checkDate();
    };
    checkDate();
    window.addEventListener("focus", checkDate);
    document.addEventListener("visibilitychange", checkVisibleDate);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("focus", checkDate);
      document.removeEventListener("visibilitychange", checkVisibleDate);
    };
  }, [enabled, runtime]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: revision triggers explicit retries.
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    setState({ tag: "loading" });
    void retryGet(() => runtime.api.getArchive(controller.signal), {
      maxAttempts: 3,
      baseDelayMs: 250,
      random: Math.random,
      sleep: runtime.sleep,
      signal: controller.signal,
    })
      .then((archive) => {
        if (!controller.signal.aborted) setState({ tag: "ready", archive });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setState({ tag: "error", failure: classifyFailure(error) });
        }
      });
    return () => controller.abort();
  }, [enabled, revision, runtime]);

  return { state, retry: useCallback(() => setRevision((value) => value + 1), []) };
}
