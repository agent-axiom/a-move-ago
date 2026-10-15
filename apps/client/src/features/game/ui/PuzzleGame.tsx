import type { PuzzlePublic } from "@a-move-ago/api-contract";
import { parseFen } from "@a-move-ago/game-core";
import { useEffect, useMemo } from "react";
import { useRuntime } from "../../../app/runtime";
import type { ClientFailure } from "../../../shared/failure";
import { useAttempt } from "../model/attempt";
import { RetractionComposer } from "./RetractionComposer";
import { RevealPlayer } from "./RevealPlayer";

function retryCopy(kind: ClientFailure["kind"]): string {
  switch (kind) {
    case "offline":
      return "Connection interrupted. Try again to check the same move.";
    case "auth":
      return "Your session has expired. Restart to continue.";
    case "contract":
      return "Please reload to continue with the latest version.";
    default:
      return "We couldn't check that move. Please try again.";
  }
}

function needsReload(failure: ClientFailure): boolean {
  return failure.kind === "auth" || failure.kind === "contract";
}

function reloadButton(failure: ClientFailure) {
  return (
    <button className="button-secondary" type="button" onClick={() => window.location.reload()}>
      {failure.kind === "auth" ? "Restart guest session" : "Reload application"}
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
    <section className="feedback-panel" aria-label="Attempt feedback">
      {controller.attempt.tag === "submitting" ? <p role="status">Checking your move…</p> : null}
      {controller.attempt.tag === "retry" ? (
        <div>
          <p role="alert">{retryCopy(controller.attempt.failure.kind)}</p>
          {needsReload(controller.attempt.failure) ? (
            reloadButton(controller.attempt.failure)
          ) : (
            <button
              className="button-secondary"
              type="button"
              onClick={() => {
                void controller.retryAttempt();
              }}
            >
              Retry attempt
            </button>
          )}
        </div>
      ) : null}
      {controller.attempt.tag === "incorrect" ? (
        <div>
          <p className="feedback-label">A clue to reconsider</p>
          <p role="alert">{controller.attempt.result.contradiction.message}</p>
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
              {controller.hints.tag === "loading" ? "Requesting hint…" : "Get hint"}
            </button>
          ) : null}
          {controller.hints.tag === "retry" ? (
            <div>
              <p role="alert">
                {controller.hints.failure.kind === "auth"
                  ? "Your session has expired. Restart to continue."
                  : controller.hints.failure.kind === "contract"
                    ? "Please reload to continue with the latest version."
                    : "Your hint couldn't be loaded. Please try again."}
              </p>
              {needsReload(controller.hints.failure) ? (
                reloadButton(controller.hints.failure)
              ) : (
                <button
                  className="button-secondary"
                  type="button"
                  onClick={() => {
                    void controller.retryHint();
                  }}
                >
                  Retry hint
                </button>
              )}
            </div>
          ) : null}
        </div>
      ) : null}
      {hintItems.length ? (
        <ol className="hint-list" aria-label="Hints">
          {hintItems.map((hint) => (
            <li key={hint.level}>{hint.text}</li>
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
          <p className="game-eyebrow">The evidence</p>
          {props.puzzle.title !== props.caseTitle ? (
            <h2 className="clue-title">{props.puzzle.title}</h2>
          ) : null}
          <p className="puzzle-prompt">{props.puzzle.prompt}</p>
        </div>
      </RetractionComposer>
      <footer className="game-provenance">
        {props.puzzle.provenance} · {props.puzzle.license}
      </footer>
    </article>
  );
}
