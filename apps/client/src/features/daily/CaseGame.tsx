import { useEffect, useMemo, useRef, useState } from "react";
import { localizedText, useI18n } from "../../i18n";
import { continuationMessages } from "../../i18n/messages/continuation";
import { PuzzleGame } from "../game/ui/PuzzleGame";
import { StatsPanel } from "../stats/StatsPanel";
import { nextUnsolvedIndex } from "./case-progress";
import { SolvedPuzzleReview } from "./SolvedPuzzleReview";
import type { DailyCase } from "./use-daily-case";
import "./continuation.css";

export function CaseGame({ daily, onToday, onNextUnsolved }: {
  daily: DailyCase;
  onToday?: () => void;
  onNextUnsolved?: () => Promise<boolean>;
}) {
  const { locale, intlLocale, t } = useI18n();
  const copy = continuationMessages[locale];
  const title = localizedText(daily, "title", locale);
  const [solved, setSolved] = useState<ReadonlySet<string>>(() => new Set(daily.solvedPuzzleIds));
  const [reviewId, setReviewId] = useState<string | null>(null);
  const [nextState, setNextState] = useState<"idle" | "loading" | "error" | "empty">("idle");
  const heading = useRef<HTMLHeadingElement>(null);
  const reviewActions = useRef<HTMLDivElement>(null);
  const previousReview = useRef<string | null>(null);
  const nextPending = useRef(false);
  const puzzleIds = useMemo(() => daily.puzzles.map((puzzle) => puzzle.id), [daily.puzzles]);
  const index = nextUnsolvedIndex(puzzleIds, solved);
  const reviewPuzzle = daily.puzzles.find((puzzle) => puzzle.id === reviewId && solved.has(puzzle.id));

  useEffect(() => {
    if (reviewId !== null) heading.current?.focus();
    else if (previousReview.current !== null) reviewActions.current?.querySelector("button")?.focus();
    previousReview.current = reviewId;
  }, [reviewId]);

  async function continuePlaying() {
    if (!onNextUnsolved || nextPending.current) return;
    nextPending.current = true;
    setNextState("loading");
    try {
      const found = await onNextUnsolved();
      setNextState(found ? "idle" : "empty");
    } catch {
      setNextState("error");
    } finally {
      nextPending.current = false;
    }
  }

  const dateLabel = new Intl.DateTimeFormat(intlLocale, {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${daily.date}T00:00:00Z`));

  const solvedReviews = solved.size > 0 ? (
    <section className="solved-puzzles" aria-label={copy.solvedPuzzles}>
      <p className="eyebrow">{copy.solvedPuzzles}</p>
      <div className="solved-puzzle-actions" ref={reviewActions}>
        {daily.puzzles.map((puzzle, puzzleIndex) => solved.has(puzzle.id) ? (
          <button className="button-secondary" type="button" key={puzzle.id} onClick={() => setReviewId(puzzle.id)}>
            {copy.review}{daily.puzzles.length > 1 ? ` · ${t("shell.act", { current: puzzleIndex + 1, total: daily.puzzles.length })}` : ""}
          </button>
        ) : null)}
      </div>
    </section>
  ) : null;

  const review = reviewPuzzle ? (
      <section className="case-page" aria-labelledby="review-case-title">
        <header className="case-header">
          <div className="case-meta">
            <p className="eyebrow">{copy.reviewTitle}</p>
            <time dateTime={daily.date}>{dateLabel}</time>
          </div>
          <h1 id="review-case-title" tabIndex={-1} ref={heading}>{title}</h1>
        </header>
        <SolvedPuzzleReview caseId={daily.id} puzzle={reviewPuzzle} key={reviewPuzzle.id} onClose={() => setReviewId(null)} />
      </section>
    ) : null;
  if (index === null) {
    return (
      <>
      {review}
      <section className="completion-page" aria-labelledby="case-title" hidden={reviewPuzzle !== undefined}>
        <header className="completion-header">
          <span className="completion-seal" aria-hidden="true">
            ✓
          </span>
          <p className="eyebrow">{t("shell.completeEyebrow")}</p>
          <h1 id="case-title">{title}</h1>
          <p className="page-description">{t("shell.completeDescription")}</p>
        </header>
        {onNextUnsolved ? (
          <div className="continue-playing" aria-live="polite">
            {nextState === "empty" ? (
              <p role="status">{copy.allSolved}</p>
            ) : (
              <>
                <button className="button-primary" type="button" disabled={nextState === "loading"} onClick={() => { void continuePlaying(); }}>
                  {nextState === "loading" ? copy.nextLoading : copy.next}
                  {nextState !== "loading" ? <span aria-hidden="true"> →</span> : null}
                </button>
                {nextState === "error" ? <p role="alert">{copy.nextError}</p> : null}
              </>
            )}
          </div>
        ) : null}
        {solvedReviews}
        <StatsPanel />
        <div className="completion-next">
          <span>{t("shell.newMystery")}</span>
          {daily.date !== new Date().toISOString().slice(0, 10) ? (
            onToday ? (
              <button className="button-quiet" type="button" onClick={onToday}>
                {t("shell.backTodayCase")} <span aria-hidden="true">↗</span>
              </button>
            ) : (
              <a href={window.location.pathname}>
                {t("shell.backTodayCase")} <span aria-hidden="true">↗</span>
              </a>
            )
          ) : (
            <span>{t("shell.comeTomorrow")}</span>
          )}
        </div>
      </section>
      </>
    );
  }
  const puzzle = daily.puzzles[index];
  if (!puzzle) return <p role="alert">{t("shell.invalidPuzzleOrder")}</p>;
  return (
    <>
    {review}
    <section className="case-page" aria-labelledby="case-title" hidden={reviewPuzzle !== undefined}>
      <header className="case-header">
        <div className="case-meta">
          <p className="eyebrow">{t("shell.dailyCase")}</p>
          <time dateTime={daily.date}>{dateLabel}</time>
        </div>
        <div className="case-title-row">
          <h1 id="case-title">{title}</h1>
          <p className="case-progress">
            {t("shell.act", { current: index + 1, total: daily.puzzles.length })}
          </p>
        </div>
        <p className="case-tagline">{t("shell.tagline")}</p>
      </header>
      <PuzzleGame
        caseId={daily.id}
        caseTitle={daily.title}
        key={puzzle.id}
        onSolved={() => setSolved((current) => new Set([...current, puzzle.id]))}
        puzzle={puzzle}
        progress={daily.progressStates?.[puzzle.id]}
      />
      {solvedReviews}
    </section>
    </>
  );
}
