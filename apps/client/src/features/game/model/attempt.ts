import type {
  AttemptRequestSchema,
  AttemptResultSchema,
  ClueResponse,
  HintResponseSchema,
  PuzzleProgress,
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

export type ClueState =
  | { tag: "idle"; content: ClueResponse | null }
  | { tag: "loading"; content: null }
  | { tag: "retry"; content: null; failure: ClientFailure };

function frozenRetraction(value: Retraction): Retraction {
  return Object.freeze({
    ...value,
    movedPiece: Object.freeze({ ...value.movedPiece }),
    restoredPiece: value.restoredPiece ? Object.freeze({ ...value.restoredPiece }) : null,
  });
}

export function useAttempt(caseId: string, puzzleId: string, initialProgress?: PuzzleProgress) {
  const runtime = useRuntime();
  const [attempt, setAttempt] = useState<AttemptState>({ tag: "idle" });
  const [progress, setProgress] = useState(initialProgress);
  const [hints, setHints] = useState<HintState>({
    tag: "idle",
    items: initialProgress?.earnedHints ?? [],
  });
  const [clue, setClue] = useState<ClueState>({ tag: "idle", content: null });
  const seed = useRef(initialProgress);
  seed.current = initialProgress;
  const attemptAbort = useRef<AbortController | null>(null);
  const hintAbort = useRef<AbortController | null>(null);
  const clueAbort = useRef<AbortController | null>(null);
  const activeLifecycle = useRef({ caseId, puzzleId, runtime });

  useEffect(() => {
    activeLifecycle.current = { caseId, puzzleId, runtime };
    attemptAbort.current?.abort();
    hintAbort.current?.abort();
    clueAbort.current?.abort();
    attemptAbort.current = null;
    hintAbort.current = null;
    clueAbort.current = null;
    setAttempt({ tag: "idle" });
    setProgress(seed.current);
    setHints({ tag: "idle", items: seed.current?.earnedHints ?? [] });
    setClue({ tag: "idle", content: null });

    return () => {
      attemptAbort.current?.abort();
      hintAbort.current?.abort();
      clueAbort.current?.abort();
    };
  }, [caseId, puzzleId, runtime]);

  const sendAttempt = useCallback(
    async (request: AttemptRequest) => {
      if (attemptAbort.current || hintAbort.current || clueAbort.current) return;
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
        if (result.progress) {
          setProgress(result.progress);
          setHints({ tag: "idle", items: result.progress.earnedHints });
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
      if (
        attempt.tag === "submitting" ||
        attempt.tag === "retry" ||
        attempt.tag === "solved" ||
        hints.tag !== "idle" ||
        clue.tag !== "idle" ||
        attemptAbort.current ||
        hintAbort.current ||
        clueAbort.current
      ) return;
      const request = Object.freeze({
        attemptUuid: runtime.attemptUuid(),
        caseId,
        puzzleId,
        retraction: frozenRetraction(retraction),
      }) satisfies AttemptRequest;
      await sendAttempt(request);
    },
    [attempt.tag, caseId, clue.tag, hints.tag, puzzleId, runtime, sendAttempt],
  );

  const retryAttempt = useCallback(async () => {
    if (attempt.tag === "retry") await sendAttempt(attempt.request);
  }, [attempt, sendAttempt]);

  const sendHint = useCallback(
    async (request: HintRequest, items: readonly Hint[]) => {
      if (attemptAbort.current || hintAbort.current || clueAbort.current) return;
      const controller = new AbortController();
      hintAbort.current = controller;
      setHints({ tag: "loading", items, request });
      try {
        const hint = await runtime.api.requestHint(
          request.attemptId,
          request.level,
          controller.signal,
        );
        if (
          controller.signal.aborted ||
          activeLifecycle.current.runtime !== runtime ||
          activeLifecycle.current.caseId !== caseId ||
          activeLifecycle.current.puzzleId !== puzzleId
        ) return;
        if (hint.progress) setProgress(hint.progress);
        const next = hint.progress?.earnedHints ??
          (items.some((item) => item.level === hint.level) ? items : [...items, hint]);
        setHints({ tag: "idle", items: next });
      } catch (error) {
        if (!controller.signal.aborted && activeLifecycle.current.runtime === runtime) {
          setHints({ tag: "retry", items, request, failure: classifyFailure(error) });
        }
      } finally {
        if (hintAbort.current === controller) hintAbort.current = null;
      }
    },
    [caseId, puzzleId, runtime],
  );

  const requestHint = useCallback(async () => {
    if (attempt.tag !== "incorrect" || hints.tag !== "idle" || clue.tag !== "idle") return;
    const highest = Math.max(progress?.highestHintLevel ?? 0, hints.items.at(-1)?.level ?? 0);
    await sendHint({ attemptId: attempt.result.id, level: highest + 1 }, hints.items);
  }, [attempt, clue.tag, hints, progress?.highestHintLevel, sendHint]);

  const retryHint = useCallback(async () => {
    if (hints.tag === "retry") await sendHint(hints.request, hints.items);
  }, [hints, sendHint]);

  const sendClue = useCallback(async () => {
    if (attemptAbort.current || hintAbort.current || clueAbort.current) return;
    const controller = new AbortController();
    clueAbort.current = controller;
    setClue({ tag: "loading", content: null });
    try {
      const result = await runtime.api.requestClue(caseId, puzzleId, controller.signal);
      if (
        controller.signal.aborted ||
        activeLifecycle.current.runtime !== runtime ||
        activeLifecycle.current.caseId !== caseId ||
        activeLifecycle.current.puzzleId !== puzzleId
      ) return;
      setProgress(result.progress);
      setHints({ tag: "idle", items: result.progress.earnedHints });
      setClue({ tag: "idle", content: result });
    } catch (error) {
      if (!controller.signal.aborted && activeLifecycle.current.runtime === runtime) {
        setClue({ tag: "retry", content: null, failure: classifyFailure(error) });
      }
    } finally {
      if (clueAbort.current === controller) clueAbort.current = null;
    }
  }, [caseId, puzzleId, runtime]);

  const requestClue = useCallback(async () => {
    if (
      progress?.clueUnlocked ||
      clue.content ||
      clue.tag !== "idle" ||
      hints.tag !== "idle" ||
      attempt.tag === "submitting" ||
      attempt.tag === "retry" ||
      attempt.tag === "solved"
    ) return;
    await sendClue();
  }, [attempt.tag, clue, hints.tag, progress?.clueUnlocked, sendClue]);

  const retryClue = useCallback(async () => {
    if (clue.tag === "retry") await sendClue();
  }, [clue.tag, sendClue]);

  const busy = attempt.tag === "submitting" || hints.tag === "loading" || clue.tag === "loading";
  const blocked = busy || attempt.tag === "retry" || hints.tag === "retry" || clue.tag === "retry";
  return {
    attempt, hints, clue, progress, busy, blocked,
    submit, retryAttempt, requestHint, retryHint, requestClue, retryClue,
  };
}
