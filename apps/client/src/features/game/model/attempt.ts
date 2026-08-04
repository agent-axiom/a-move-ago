import type {
  AttemptRequestSchema,
  AttemptResultSchema,
  HintResponseSchema,
  Retraction,
} from "@a-move-ago/api-contract";
import { useCallback, useEffect, useRef, useState } from "react";
import type { z } from "zod";
import { useRuntime } from "../../../app/runtime";
import { type ClientFailure, classifyFailure } from "../../../shared/failure";

type AttemptRequest = z.infer<typeof AttemptRequestSchema>;
type AttemptResult = z.infer<typeof AttemptResultSchema>;
type IncorrectResult = Extract<AttemptResult, { correct: false }>;
type CorrectResult = Extract<AttemptResult, { correct: true }>;
type Hint = z.infer<typeof HintResponseSchema>;

export type AttemptState =
  | { tag: "idle" }
  | { tag: "submitting"; request: AttemptRequest }
  | { tag: "retry"; request: AttemptRequest; failure: ClientFailure }
  | { tag: "incorrect"; request: AttemptRequest; result: IncorrectResult }
  | { tag: "solved"; request: AttemptRequest; result: CorrectResult };

interface HintRequest {
  attemptId: string;
  level: number;
}

export type HintState =
  | { tag: "idle"; items: readonly Hint[] }
  | { tag: "loading"; items: readonly Hint[]; request: HintRequest }
  | { tag: "retry"; items: readonly Hint[]; request: HintRequest; failure: ClientFailure };

function frozenRetraction(value: Retraction): Retraction {
  return Object.freeze({
    ...value,
    movedPiece: Object.freeze({ ...value.movedPiece }),
    restoredPiece: value.restoredPiece ? Object.freeze({ ...value.restoredPiece }) : null,
  });
}

export function useAttempt(caseId: string, puzzleId: string) {
  const runtime = useRuntime();
  const [attempt, setAttempt] = useState<AttemptState>({ tag: "idle" });
  const [hints, setHints] = useState<HintState>({ tag: "idle", items: [] });
  const attemptAbort = useRef<AbortController | null>(null);
  const hintAbort = useRef<AbortController | null>(null);
  const activeLifecycle = useRef({ caseId, puzzleId, runtime });

  useEffect(() => {
    activeLifecycle.current = { caseId, puzzleId, runtime };
    attemptAbort.current?.abort();
    hintAbort.current?.abort();
    attemptAbort.current = null;
    hintAbort.current = null;
    setAttempt({ tag: "idle" });
    setHints({ tag: "idle", items: [] });

    return () => {
      attemptAbort.current?.abort();
      hintAbort.current?.abort();
    };
  }, [caseId, puzzleId, runtime]);

  const sendAttempt = useCallback(
    async (request: AttemptRequest) => {
      if (attemptAbort.current) return;
      const controller = new AbortController();
      attemptAbort.current = controller;
      setAttempt({ tag: "submitting", request });
      try {
        const result = await runtime.api.submitAttempt(request, controller.signal);
        if (
          controller.signal.aborted ||
          activeLifecycle.current.runtime !== runtime ||
          activeLifecycle.current.caseId !== request.caseId ||
          activeLifecycle.current.puzzleId !== request.puzzleId
        ) {
          return;
        }
        setAttempt(
          result.correct
            ? { tag: "solved", request, result }
            : { tag: "incorrect", request, result },
        );
      } catch (error) {
        if (
          !controller.signal.aborted &&
          activeLifecycle.current.runtime === runtime &&
          activeLifecycle.current.caseId === request.caseId &&
          activeLifecycle.current.puzzleId === request.puzzleId
        ) {
          setAttempt({ tag: "retry", request, failure: classifyFailure(error) });
        }
      } finally {
        if (attemptAbort.current === controller) attemptAbort.current = null;
      }
    },
    [runtime],
  );

  const submit = useCallback(
    async (retraction: Retraction) => {
      if (attempt.tag === "submitting" || attemptAbort.current) return;
      const request = Object.freeze({
        attemptUuid: runtime.attemptUuid(),
        caseId,
        puzzleId,
        retraction: frozenRetraction(retraction),
      }) satisfies AttemptRequest;
      hintAbort.current?.abort();
      hintAbort.current = null;
      setHints({ tag: "idle", items: [] });
      await sendAttempt(request);
    },
    [attempt.tag, caseId, puzzleId, runtime, sendAttempt],
  );

  const retryAttempt = useCallback(async () => {
    if (attempt.tag === "retry") await sendAttempt(attempt.request);
  }, [attempt, sendAttempt]);

  const sendHint = useCallback(
    async (request: HintRequest, items: readonly Hint[]) => {
      if (hintAbort.current) return;
      const controller = new AbortController();
      hintAbort.current = controller;
      setHints({ tag: "loading", items, request });
      try {
        const hint = await runtime.api.requestHint(
          request.attemptId,
          request.level,
          controller.signal,
        );
        if (controller.signal.aborted || activeLifecycle.current.runtime !== runtime) return;
        const next = items.some((item) => item.level === hint.level) ? items : [...items, hint];
        setHints({ tag: "idle", items: next });
      } catch (error) {
        if (!controller.signal.aborted && activeLifecycle.current.runtime === runtime) {
          setHints({ tag: "retry", items, request, failure: classifyFailure(error) });
        }
      } finally {
        if (hintAbort.current === controller) hintAbort.current = null;
      }
    },
    [runtime],
  );

  const requestHint = useCallback(async () => {
    if (attempt.tag !== "incorrect" || hints.tag !== "idle") return;
    await sendHint({ attemptId: attempt.result.id, level: hints.items.length + 1 }, hints.items);
  }, [attempt, hints, sendHint]);

  const retryHint = useCallback(async () => {
    if (hints.tag === "retry") await sendHint(hints.request, hints.items);
  }, [hints, sendHint]);

  return { attempt, hints, submit, retryAttempt, requestHint, retryHint };
}
