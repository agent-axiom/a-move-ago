import type { AcceptedSolution, PuzzleProgress } from "@a-move-ago/api-contract";
import { parseFen } from "@a-move-ago/game-core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { localizedText, useI18n } from "../../../i18n";
import { Chessboard } from "./Chessboard";

type RevealStage = "post" | "previous" | "forward" | "done";
interface RevealTimeline {
  key: string;
  stage: RevealStage;
}

export function RevealPlayer(props: {
  postFen: string;
  solution: AcceptedSolution;
  progress?: PuzzleProgress;
  attemptId?: string;
  onComplete(): void;
}) {
  const { locale, t } = useI18n();
  const revealKey = useMemo(
    () => JSON.stringify([props.postFen, props.solution]),
    [props.postFen, props.solution],
  );
  const [timeline, setTimeline] = useState<RevealTimeline>({ key: revealKey, stage: "post" });
  const [inspection, setInspection] = useState<"previous" | "post" | null>(null);
  const continued = useRef(false);
  const timers = useRef<Array<ReturnType<typeof setTimeout>>>([]);
  const previous = useMemo(
    () => parseFen(props.solution.previousFen),
    [props.solution.previousFen],
  );
  const post = useMemo(() => parseFen(props.postFen), [props.postFen]);
  const awardedHere = props.progress?.awardAttemptId != null &&
    props.progress.awardAttemptId === props.attemptId;

  const startReplay = useCallback(() => {
    for (const timer of timers.current) clearTimeout(timer);
    const reduced = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    continued.current = false;
    setInspection(null);
    setTimeline({ key: revealKey, stage: reduced ? "done" : "post" });
    if (reduced) return;
    const advance = (stage: RevealStage) => {
      setTimeline((current) => (current.key === revealKey ? { ...current, stage } : current));
    };
    timers.current = [
      setTimeout(() => advance("previous"), 50),
      setTimeout(() => advance("forward"), 800),
      setTimeout(() => advance("done"), 1_550),
    ];
  }, [revealKey]);

  useEffect(() => {
    startReplay();
    return () => {
      for (const timer of timers.current) clearTimeout(timer);
    };
  }, [startReplay]);

  function inspect(view: "previous" | "post") {
    for (const timer of timers.current) clearTimeout(timer);
    setInspection(view);
    setTimeline({ key: revealKey, stage: "done" });
  }

  const stage = timeline.key === revealKey ? timeline.stage : "post";
  const showingPrevious = inspection ? inspection === "previous" : stage === "previous";
  const announcement =
    inspection === "previous"
      ? t("game.reveal.previous")
      : inspection === "post"
        ? t("game.reveal.post")
        : stage === "post"
          ? t("game.reveal.rewind")
          : stage === "previous"
            ? t("game.reveal.previous")
            : stage === "forward"
              ? t("game.reveal.forward", { san: props.solution.forwardSan })
              : t("game.reveal.done");

  return (
    <section className="reveal-layout" aria-labelledby="solution-heading">
      <div className="board-panel">
        <div className="board-toolbar">
          <span className="last-move-label">{t("game.reveal.trueMove")}</span>
          <fieldset className="board-view-switch" aria-label={t("game.reveal.position")}>
            <button
              type="button"
              aria-pressed={showingPrevious}
              onClick={() => inspect("previous")}
            >
              {t("game.before")}
            </button>
            <button type="button" aria-pressed={!showingPrevious} onClick={() => inspect("post")}>
              {t("game.after")}
            </button>
          </fieldset>
        </div>
        <div className={`reveal-board reveal-${stage}`}>
          <Chessboard
            board={showingPrevious ? previous.board : post.board}
            disabled
            destinationSquare={props.solution.retraction.previousSquare}
            label={showingPrevious ? t("game.reveal.boardBefore") : t("game.reveal.boardAfter")}
            onSelect={() => undefined}
            orientation={props.solution.retraction.movedPiece.color === "w" ? "white" : "black"}
            selectedSquare={props.solution.retraction.currentSquare}
          />
        </div>
        <p className="board-caption" role="status" aria-live="polite">
          {announcement}
        </p>
      </div>
      <div className="solution-panel">
        <p className="game-eyebrow">{t("game.reveal.eyebrow")}</p>
        <div className="solved-heading">
          <span className="solved-mark" aria-hidden="true">
            ✓
          </span>
          <h2 id="solution-heading">{t("game.solved")}</h2>
        </div>
        {props.progress && props.progress.earnedPoints !== null ? (
          <aside className="solution-reward" aria-live="polite">
            <strong>{props.progress.legacySolved
              ? t("game.score.legacy")
              : t(awardedHere ? "game.score.awarded" : "game.score.already", {
                points: props.progress.earnedPoints,
              })}</strong>
            <p>{props.progress.legacySolved
              ? t("game.score.legacyCopy")
              : awardedHere
                ? t("game.score.awardAttempt", { number: props.progress.attemptCount })
                : t("game.score.alreadyCopy")}</p>
          </aside>
        ) : null}
        <p className="solution-notation">{props.solution.forwardSan}</p>
        <p className="solution-explanation">
          {localizedText(props.solution, "explanation", locale)}
        </p>
        <p className="solution-inspect-copy">{t("game.reveal.inspect")}</p>
        <div className="solution-actions">
          <button
            className="button-secondary"
            type="button"
            disabled={stage !== "done"}
            onClick={() => {
              startReplay();
            }}
          >
            {t("game.reveal.replay")}
          </button>
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
            {t("game.continue")}
          </button>
        </div>
      </div>
    </section>
  );
}
