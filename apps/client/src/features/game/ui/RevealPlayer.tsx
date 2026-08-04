import type { AcceptedSolution } from "@a-move-ago/api-contract";
import { parseFen } from "@a-move-ago/game-core";
import { useEffect, useMemo, useRef, useState } from "react";
import { Chessboard } from "./Chessboard";

type RevealStage = "post" | "previous" | "forward" | "done";

interface RevealTimeline {
  key: string;
  stage: RevealStage;
}

export function RevealPlayer(props: {
  postFen: string;
  solution: AcceptedSolution;
  onComplete(): void;
}) {
  const revealKey = useMemo(
    () => JSON.stringify([props.postFen, props.solution]),
    [props.postFen, props.solution],
  );
  const [timeline, setTimeline] = useState<RevealTimeline>({ key: revealKey, stage: "post" });
  const complete = useRef(props.onComplete);
  complete.current = props.onComplete;
  const previous = useMemo(
    () => parseFen(props.solution.previousFen),
    [props.solution.previousFen],
  );
  const post = useMemo(() => parseFen(props.postFen), [props.postFen]);

  useEffect(() => {
    let active = true;
    const reduced = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    const rewindAt = reduced ? 0 : 50;
    const forwardAt = reduced ? 0 : 800;
    const doneAt = reduced ? 0 : 1_550;

    const advance = (stage: RevealStage) => {
      if (!active) return;
      setTimeline((current) => (current.key === revealKey ? { ...current, stage } : current));
    };

    setTimeline({ key: revealKey, stage: "post" });
    const rewind = setTimeout(() => advance("previous"), rewindAt);
    const forward = setTimeout(() => advance("forward"), forwardAt);
    const done = setTimeout(() => {
      if (!active) return;
      active = false;
      setTimeline((current) =>
        current.key === revealKey ? { ...current, stage: "done" } : current,
      );
      complete.current();
    }, doneAt);
    return () => {
      active = false;
      clearTimeout(rewind);
      clearTimeout(forward);
      clearTimeout(done);
    };
  }, [revealKey]);

  const stage = timeline.key === revealKey ? timeline.stage : "post";
  const showingPrevious = stage === "previous";
  const announcement =
    stage === "post"
      ? "Rewinding the last move."
      : stage === "previous"
        ? "Previous position reconstructed."
        : stage === "forward"
          ? `Playing ${props.solution.forwardSan} forward.`
          : "Solution replay complete.";
  return (
    <section aria-labelledby="solution-heading">
      <h2 id="solution-heading">Solved</h2>
      <p role="status" aria-live="polite">
        {announcement}
      </p>
      <div className={`reveal-board reveal-${stage}`}>
        <Chessboard
          board={showingPrevious ? previous.board : post.board}
          disabled
          label={
            showingPrevious ? "Reconstructed previous position" : "Position after the true move"
          }
          onSelect={() => undefined}
          orientation={props.solution.retraction.movedPiece.color === "w" ? "white" : "black"}
          selectedSquare={null}
        />
      </div>
      <p>
        <strong>{props.solution.forwardSan}</strong> — {props.solution.explanation}
      </p>
    </section>
  );
}
