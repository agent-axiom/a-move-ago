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
      return "No response was received. Retry sends the same attempt UUID.";
    case "auth":
      return "The guest session expired. Restart to continue.";
    case "contract":
      return "This version could not read the attempt response. Reload to continue.";
    default:
      return "The attempt could not be confirmed. Retry the same attempt.";
  }
}

function requestId(failure: ClientFailure): string | null {
  return "requestId" in failure && typeof failure.requestId === "string" ? failure.requestId : null;
}

function needsReload(failure: ClientFailure): boolean {
  return failure.kind === "auth" || failure.kind === "contract";
}

function reloadButton(failure: ClientFailure) {
  return (
    <button type="button" onClick={() => window.location.reload()}>
      {failure.kind === "auth" ? "Restart guest session" : "Reload application"}
    </button>
  );
}

export function PuzzleGame(props: { caseId: string; puzzle: PuzzlePublic; onSolved(): void }) {
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
  const attemptRequestId =
    controller.attempt.tag === "retry" ? requestId(controller.attempt.failure) : null;
  const hintRequestId =
    controller.hints.tag === "retry" ? requestId(controller.hints.failure) : null;
  return (
    <article className="game-layout">
      <div className="game-copy">
        <h2>{props.puzzle.title}</h2>
        <p>{props.puzzle.prompt}</p>
      </div>
      <RetractionComposer
        disabled={controller.attempt.tag === "submitting" || controller.attempt.tag === "retry"}
        onSubmit={(retraction) => {
          void controller.submit(retraction);
        }}
        post={post}
        retractingColor={props.puzzle.retractingColor}
      />
      <section className="feedback-panel" aria-label="Attempt feedback">
        {controller.attempt.tag === "submitting" ? <p role="status">Checking retraction…</p> : null}
        {controller.attempt.tag === "retry" ? (
          <div>
            <p role="alert">{retryCopy(controller.attempt.failure.kind)}</p>
            {attemptRequestId ? (
              <p>
                Request ID: <code>{attemptRequestId}</code>
              </p>
            ) : null}
            {needsReload(controller.attempt.failure) ? (
              reloadButton(controller.attempt.failure)
            ) : (
              <button
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
            <p role="alert">{controller.attempt.result.contradiction.message}</p>
            {!exhausted &&
            hintItems.length < props.puzzle.maxHints &&
            controller.hints.tag !== "retry" ? (
              <button
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
                    ? "The guest session expired. Restart to continue."
                    : controller.hints.failure.kind === "contract"
                      ? "This version could not read the hint response. Reload to continue."
                      : "Hint was not received. Retry requests the same level."}
                </p>
                {hintRequestId ? (
                  <p>
                    Request ID: <code>{hintRequestId}</code>
                  </p>
                ) : null}
                {needsReload(controller.hints.failure) ? (
                  reloadButton(controller.hints.failure)
                ) : (
                  <button
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
      <footer>
        {props.puzzle.provenance} · {props.puzzle.license}
      </footer>
    </article>
  );
}
