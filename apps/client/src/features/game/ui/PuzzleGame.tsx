import type { PuzzlePublic } from "@a-move-ago/api-contract";
import { parseFen } from "@a-move-ago/game-core";
import { useEffect, useMemo } from "react";
import { useRuntime } from "../../../app/runtime";
import { localizedText, type TranslationKey, useI18n } from "../../../i18n";
import type { ClientFailure } from "../../../shared/failure";
import { useAttempt } from "../model/attempt";
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

export function PuzzleGame(props: {
  caseId: string;
  caseTitle?: string;
  puzzle: PuzzlePublic;
  onSolved(): void;
}) {
  const runtime = useRuntime();
  const { locale, t } = useI18n();
  const post = useMemo(() => parseFen(props.puzzle.postFen), [props.puzzle.postFen]);
  const controller = useAttempt(props.caseId, props.puzzle.id);

  useEffect(() => {
    if (controller.attempt.tag === "solved") void runtime.platform.haptic("success");
    if (controller.attempt.tag === "incorrect") void runtime.platform.haptic("error");
  }, [controller.attempt.tag, runtime.platform]);

  if (controller.attempt.tag === "solved") {
    return (
      <RevealPlayer
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
    <section className="feedback-panel" aria-label={t("game.feedback")}>
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
          <p role="alert">{localizedText(controller.attempt.result.contradiction, "message", locale)}</p>
          {!exhausted &&
          hintItems.length < props.puzzle.maxHints &&
          controller.hints.tag !== "retry" ? (
            <button
              className="button-secondary"
              type="button"
              disabled={controller.hints.tag === "loading"}
              onClick={() => {
                void controller.requestHint();
              }}
            >
              {t(controller.hints.tag === "loading" ? "game.hint.loading" : "game.hint.get")}
            </button>
          ) : null}
          {controller.hints.tag === "retry" ? (
            <div>
              <p role="alert">
                {t(
                  controller.hints.failure.kind === "auth"
                    ? "game.retry.auth"
                    : controller.hints.failure.kind === "contract"
                      ? "game.retry.contract"
                      : "game.hint.error",
                )}
              </p>
              {needsReload(controller.hints.failure) ? (
                <ReloadButton failure={controller.hints.failure} />
              ) : (
                <button
                  className="button-secondary"
                  type="button"
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

  return (
    <article className="game-layout">
      <RetractionComposer
        disabled={controller.attempt.tag === "submitting" || controller.attempt.tag === "retry"}
        feedback={feedback}
        onSubmit={(retraction) => {
          void controller.submit(retraction);
        }}
        post={post}
        retractingColor={props.puzzle.retractingColor}
      >
        <div className="game-copy">
          <p className="game-eyebrow">{t("game.evidence")}</p>
          {props.puzzle.title !== props.caseTitle ? (
            <h2 className="clue-title">{localizedText(props.puzzle, "title", locale)}</h2>
          ) : null}
          <p className="puzzle-prompt">{localizedText(props.puzzle, "prompt", locale)}</p>
        </div>
      </RetractionComposer>
      <footer className="game-provenance">
        {localizedText(props.puzzle, "provenance", locale)} · {localizedText(props.puzzle, "license", locale)}
      </footer>
    </article>
  );
}
