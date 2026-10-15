import type { AcceptedSolution } from "@a-move-ago/api-contract";
import { parseFen } from "@a-move-ago/game-core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Chessboard } from "./Chessboard";

type RevealStage = "post" | "previous" | "forward" | "done";
interface RevealTimeline { key: string; stage: RevealStage }

export function RevealPlayer(props: {
  postFen: string;
  solution: AcceptedSolution;
  onComplete(): void;
}) {
  const revealKey = useMemo(() => JSON.stringify([props.postFen, props.solution]), [props.postFen, props.solution]);
  const [timeline, setTimeline] = useState<RevealTimeline>({ key: revealKey, stage: "post" });
  const [inspection, setInspection] = useState<"previous" | "post" | null>(null);
  const continued = useRef(false);
  const timers = useRef<Array<ReturnType<typeof setTimeout>>>([]);
  const previous = useMemo(() => parseFen(props.solution.previousFen), [props.solution.previousFen]);
  const post = useMemo(() => parseFen(props.postFen), [props.postFen]);

  const startReplay = useCallback(() => {
    for (const timer of timers.current) clearTimeout(timer);
    let active = true;
    const reduced = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    continued.current = false;
    setInspection(null);
    setTimeline({ key: revealKey, stage: reduced ? "done" : "post" });
    if (reduced) return;
    const advance = (stage: RevealStage) => {
      if (active) setTimeline((current) => current.key === revealKey ? { ...current, stage } : current);
    };
    timers.current = [
      setTimeout(() => advance("previous"), 50),
      setTimeout(() => advance("forward"), 800),
      setTimeout(() => advance("done"), 1_550),
    ];
    return () => {
      active = false;
      for (const timer of timers.current) clearTimeout(timer);
    };
  }, [revealKey]);

  useEffect(() => startReplay(), [startReplay]);

  function inspect(view: "previous" | "post") {
    for (const timer of timers.current) clearTimeout(timer);
    setInspection(view);
    setTimeline({ key: revealKey, stage: "done" });
  }

  const stage = timeline.key === revealKey ? timeline.stage : "post";
  const showingPrevious = inspection ? inspection === "previous" : stage === "previous";
  const announcement = inspection === "previous"
    ? "Previous position reconstructed."
    : inspection === "post"
      ? "Position after the move."
      : stage === "post"
        ? "Rewinding the last move."
        : stage === "previous"
          ? "Previous position reconstructed."
          : stage === "forward"
            ? `Playing ${props.solution.forwardSan} forward.`
            : "Solution replay complete.";

  return (
    <section className="reveal-layout" aria-labelledby="solution-heading">
      <div className="board-panel">
        <div className="board-toolbar">
          <span className="last-move-label">The true move</span>
          <div className="board-view-switch" role="group" aria-label="Solution position">
            <button type="button" aria-pressed={showingPrevious} onClick={() => inspect("previous")}>Before</button>
            <button type="button" aria-pressed={!showingPrevious} onClick={() => inspect("post")}>After</button>
          </div>
        </div>
        <div className={`reveal-board reveal-${stage}`}>
          <Chessboard
            board={showingPrevious ? previous.board : post.board}
            disabled
            destinationSquare={props.solution.retraction.previousSquare}
            label={showingPrevious ? "Reconstructed previous position" : "Position after the true move"}
            onSelect={() => undefined}
            orientation={props.solution.retraction.movedPiece.color === "w" ? "white" : "black"}
            selectedSquare={props.solution.retraction.currentSquare}
          />
        </div>
        <p className="board-caption" role="status" aria-live="polite">{announcement}</p>
      </div>
      <div className="solution-panel">
        <p className="game-eyebrow">The story, uncovered</p>
        <div className="solved-heading">
          <span className="solved-mark" aria-hidden="true">✓</span>
          <h2 id="solution-heading">Solved</h2>
        </div>
        <p className="solution-notation">{props.solution.forwardSan}</p>
        <p className="solution-explanation">{props.solution.explanation}</p>
        <p className="solution-inspect-copy">Explore both positions, or replay the move at your own pace.</p>
        <div className="solution-actions">
          <button className="button-secondary" type="button" disabled={stage !== "done"} onClick={() => { startReplay(); }}>Replay move</button>
          <button
            className="button-primary"
            type="button"
            disabled={stage !== "done"}
            onClick={() => {
              if (continued.current) return;
              continued.current = true;
              props.onComplete();
            }}
          >
            Continue
          </button>
        </div>
      </div>
    </section>
  );
}
