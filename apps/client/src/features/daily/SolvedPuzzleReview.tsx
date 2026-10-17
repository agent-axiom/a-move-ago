import type { AcceptedSolution, PuzzlePublic } from "@a-move-ago/api-contract";
import { useEffect, useState } from "react";
import { useRuntime } from "../../app/runtime";
import { useI18n } from "../../i18n";
import { continuationMessages } from "../../i18n/messages/continuation";
import { clearCompletedGame } from "../game/model/persistence";
import { RevealPlayer } from "../game/ui/RevealPlayer";

type ReviewState =
  | { tag: "loading" }
  | { tag: "ready"; solution: AcceptedSolution }
  | { tag: "error" };

export function SolvedPuzzleReview(props: {
  caseId: string;
  puzzle: PuzzlePublic;
  onClose(): void;
}) {
  const runtime = useRuntime();
  const { locale } = useI18n();
  const copy = continuationMessages[locale];
  const actorKey = runtime.draftActorKey?.();
  const [state, setState] = useState<ReviewState>({ tag: "loading" });
  const [revision, setRevision] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: revision explicitly retries the read.
  useEffect(() => {
    const controller = new AbortController();
    setState({ tag: "loading" });
    void runtime.api.getPuzzleReveal(props.caseId, props.puzzle.id, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) {
          clearCompletedGame(actorKey ? {
            actorKey,
            caseId: props.caseId,
            puzzleId: props.puzzle.id,
            puzzleVersion: props.puzzle.version,
          } : undefined);
          setState({ tag: "ready", solution: result.reveal });
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setState({ tag: "error" });
      });
    return () => controller.abort();
  }, [runtime, props.caseId, props.puzzle.id, props.puzzle.version, actorKey, revision]);

  return (
    <div className="solved-review">
      <button className="button-quiet review-back" type="button" onClick={props.onClose}>
        <span aria-hidden="true">← </span>{copy.back}
      </button>
      {state.tag === "ready" ? (
        <RevealPlayer
          postFen={props.puzzle.postFen}
          solution={state.solution}
          review
          onComplete={props.onClose}
        />
      ) : state.tag === "loading" ? (
        <p role="status">{copy.reviewLoading}</p>
      ) : (
        <div className="state-panel">
          <p role="alert">{copy.reviewError}</p>
          <button className="button-secondary" type="button" onClick={() => setRevision((value) => value + 1)}>
            {copy.retry}
          </button>
        </div>
      )}
    </div>
  );
}
