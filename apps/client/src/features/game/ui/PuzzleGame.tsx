import type { PuzzleProgress, PuzzlePublic } from "@a-move-ago/api-contract";
import { parseFen } from "@a-move-ago/game-core";
import { useEffect, useMemo, useRef } from "react";
import { useRuntime } from "../../../app/runtime";
import { localizedText, type TranslationKey, useI18n } from "../../../i18n";
import type { ClientFailure } from "../../../shared/failure";
import { useAttempt } from "../model/attempt";
import type { GamePersistenceScope } from "../model/persistence";
import { RetractionComposer } from "./RetractionComposer";
import { RevealPlayer } from "./RevealPlayer";

function retryKey(kind: ClientFailure["kind"]): TranslationKey {
  switch (kind) {
    case "offline":
      return "game.retry.offline";
    case "auth":
      return "game.retry.auth";
    case "contract":
      return "game.retry.contract";
    default:
      return "game.retry.generic";
  }
}

function needsReload(failure: ClientFailure): boolean {
  return failure.kind === "auth" || failure.kind === "contract";
}

function ReloadButton({ failure }: { failure: ClientFailure }) {
  const { t } = useI18n();
  return (
    <button className="button-secondary" type="button" onClick={() => window.location.reload()}>
      {t(failure.kind === "auth" ? "game.restart" : "game.reload")}
    </button>
  );
}

function afterAssistance(points: number): number {
  return points === 0 ? 0 : Math.max(1, Math.floor(points / 2));
}

export function PuzzleGame(props: {
  caseId: string;
  caseTitle?: string;
  puzzle: PuzzlePublic;
  progress?: PuzzleProgress | undefined;
  onSolved(): void;
}) {
  const runtime = useRuntime();
  const { locale, t } = useI18n();
  const feedbackRef = useRef<HTMLElement>(null);
  const post = useMemo(() => parseFen(props.puzzle.postFen), [props.puzzle.postFen]);
  const actorKey = runtime.draftActorKey?.();
  const persistenceScope = useMemo<GamePersistenceScope | undefined>(
    () =>
      actorKey
        ? {
            actorKey,
            caseId: props.caseId,
            puzzleId: props.puzzle.id,
            puzzleVersion: props.puzzle.version,
          }
        : undefined,
    [actorKey, props.caseId, props.puzzle.id, props.puzzle.version],
  );
  const controller = useAttempt(props.caseId, props.puzzle.id, props.progress, persistenceScope);
  const progress = controller.progress;
  const alreadyScored = progress !== undefined && progress.earnedPoints !== null;

  useEffect(() => {
    if (controller.attempt.tag === "solved") void runtime.platform.haptic("success");
    if (controller.attempt.tag === "incorrect") void runtime.platform.haptic("error");
  }, [controller.attempt.tag, runtime.platform]);

  useEffect(() => {
    if (controller.attempt.tag !== "incorrect" && controller.attempt.tag !== "retry") return;
    feedbackRef.current?.focus({ preventScroll: true });
    feedbackRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [controller.attempt.tag]);

  if (controller.attempt.tag === "solved") {
    return (
      <RevealPlayer
        attemptId={controller.attempt.result.id}
        progress={controller.attempt.result.progress}
        onComplete={props.onSolved}
        postFen={props.puzzle.postFen}
        solution={controller.attempt.result.reveal}
      />
    );
  }

  const hintItems = controller.hints.items;
  const exhausted = hintItems.at(-1)?.exhausted ?? false;
  const hasFeedback = controller.attempt.tag !== "idle" || hintItems.length > 0;
  const feedback = hasFeedback ? (
    <section
      className="feedback-panel"
      aria-label={t("game.feedback")}
      ref={feedbackRef}
      tabIndex={-1}
    >
      {controller.attempt.tag === "submitting" ? <p role="status">{t("game.checking")}</p> : null}
      {controller.attempt.tag === "retry" ? (
        <div>
          <p role="alert">{t(retryKey(controller.attempt.failure.kind))}</p>
          {needsReload(controller.attempt.failure) ? (
            <ReloadButton failure={controller.attempt.failure} />
          ) : (
            <button
              className="button-secondary"
              type="button"
              disabled={controller.busy}
              onClick={() => {
                void controller.retryAttempt();
              }}
            >
              {t("game.retryAttempt")}
            </button>
          )}
        </div>
      ) : null}
      {controller.attempt.tag === "incorrect" ? (
        <div>
          <p className="feedback-label">{t("game.reconsider")}</p>
          <p role="alert">
            {localizedText(controller.attempt.result.contradiction, "message", locale)}
          </p>
          {!exhausted &&
          hintItems.length < props.puzzle.maxHints &&
          controller.hints.tag !== "retry" ? (
            <button
              className="button-secondary hint-request"
              type="button"
              disabled={controller.blocked || alreadyScored}
              onClick={() => {
                void controller.requestHint();
              }}
            >
              {controller.hints.tag === "loading"
                ? t("game.hint.loading")
                : progress
                  ? t("game.hint.cost", {
                      before: progress.nextAttemptPoints,
                      after: afterAssistance(progress.nextAttemptPoints),
                      count: afterAssistance(progress.nextAttemptPoints),
                    })
                  : t("game.hint.get")}
            </button>
          ) : null}
          {controller.hints.tag === "retry" ? (
            <div>
              <p role="alert">
                {t(
                  needsReload(controller.hints.failure)
                    ? retryKey(controller.hints.failure.kind)
                    : "game.hint.error",
                )}
              </p>
              {needsReload(controller.hints.failure) ? (
                <ReloadButton failure={controller.hints.failure} />
              ) : (
                <button
                  className="button-secondary"
                  type="button"
                  disabled={controller.busy}
                  onClick={() => {
                    void controller.retryHint();
                  }}
                >
                  {t("game.hint.retry")}
                </button>
              )}
            </div>
          ) : null}
        </div>
      ) : null}
      {hintItems.length ? (
        <ol className="hint-list" aria-label={t("game.hints")}>
          {hintItems.map((hint) => (
            <li key={hint.level}>{localizedText(hint, "text", locale)}</li>
          ))}
        </ol>
      ) : null}
    </section>
  ) : null;

  const clueContent = controller.clue.content ?? props.puzzle;
  const support = progress ? (
    <div className="game-support">
      <aside className="optional-clue">
        {progress.clueUnlocked ? (
          <>
            <p className="game-eyebrow">{t("game.clue.unlocked")}</p>
            <h2 className="clue-title unlocked-clue">
              {localizedText(clueContent, "title", locale)}
            </h2>
            <p className="clue-prompt">{localizedText(clueContent, "prompt", locale)}</p>
          </>
        ) : (
          <>
            <p>{t("game.clue.hidden")}</p>
            {controller.clue.tag !== "retry" ? (
              <button
                className="button-secondary clue-request"
                type="button"
                disabled={controller.blocked || alreadyScored}
                onClick={() => {
                  void controller.requestClue();
                }}
              >
                {controller.clue.tag === "loading"
                  ? t("game.clue.loading")
                  : t("game.clue.reveal", {
                      before: progress.nextAttemptPoints,
                      after: afterAssistance(progress.nextAttemptPoints),
                      count: afterAssistance(progress.nextAttemptPoints),
                    })}
              </button>
            ) : (
              <div>
                <p role="alert">
                  {t(
                    needsReload(controller.clue.failure)
                      ? retryKey(controller.clue.failure.kind)
                      : "game.clue.error",
                  )}
                </p>
                {needsReload(controller.clue.failure) ? (
                  <ReloadButton failure={controller.clue.failure} />
                ) : (
                  <button
                    className="button-secondary"
                    type="button"
                    disabled={controller.busy}
                    onClick={() => {
                      void controller.retryClue();
                    }}
                  >
                    {t("game.clue.retry")}
                  </button>
                )}
              </div>
            )}
          </>
        )}
      </aside>
      <details className="score-rules">
        <summary>{t("game.score.rules")}</summary>
        <p>{t("game.score.rulesCopy")}</p>
      </details>
    </div>
  ) : null;
  return (
    <article className="game-layout">
      <RetractionComposer
        disabled={controller.blocked}
        submitting={controller.attempt.tag === "submitting"}
        feedback={feedback}
        onSubmit={(retraction) => {
          void controller.submit(retraction);
        }}
        persistenceScope={persistenceScope}
        post={post}
        retractingColor={props.puzzle.retractingColor}
        support={support}
      >
        <div className="game-copy">
          <p className="game-eyebrow">{t("game.evidence")}</p>
          <p className="puzzle-prompt">{t("game.objective")}</p>
          {progress ? (
            <div
              className="puzzle-score"
              role="status"
              aria-label={t("game.score.label")}
              aria-live="polite"
            >
              <span className="score-attempt">
                {t("game.score.attempt", { number: progress.attemptCount + 1 })}
              </span>
              <strong className="score-potential">
                {t("game.score.available", {
                  points: progress.nextAttemptPoints,
                  count: progress.nextAttemptPoints,
                })}
              </strong>
              {controller.busy ? (
                <small className="score-updating">{t("game.score.sync")}</small>
              ) : null}
            </div>
          ) : null}
        </div>
      </RetractionComposer>
      <footer className="game-provenance">
        {localizedText(props.puzzle, "provenance", locale)} ·{" "}
        {localizedText(props.puzzle, "license", locale)}
      </footer>
    </article>
  );
}
