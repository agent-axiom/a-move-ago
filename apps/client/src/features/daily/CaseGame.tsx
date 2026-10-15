import { useMemo, useState } from "react";
import { PuzzleGame } from "../game/ui/PuzzleGame";
import { StatsPanel } from "../stats/StatsPanel";
import { nextUnsolvedIndex } from "./case-progress";
import type { DailyCase } from "./use-daily-case";

export function CaseGame({ daily }: { daily: DailyCase }) {
  const [solved, setSolved] = useState<ReadonlySet<string>>(() => new Set(daily.solvedPuzzleIds));
  const puzzleIds = useMemo(() => daily.puzzles.map((puzzle) => puzzle.id), [daily.puzzles]);
  const index = nextUnsolvedIndex(puzzleIds, solved);
  const dateLabel = new Intl.DateTimeFormat("en", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${daily.date}T00:00:00Z`));
  if (index === null) {
    return (
      <section className="completion-page" aria-labelledby="case-title">
        <header className="completion-header">
          <span className="completion-seal" aria-hidden="true">
            ✓
          </span>
          <p className="eyebrow">A mystery, made clear</p>
          <h1 id="case-title">{daily.title}</h1>
          <p className="page-description">You saw what came before. Nicely reasoned.</p>
        </header>
        <StatsPanel />
        <div className="completion-next">
          <span>A new mystery every day, at 00:00 UTC.</span>
          {daily.date !== new Date().toISOString().slice(0, 10) ? (
            <a href={window.location.pathname}>
              Back to today’s case <span aria-hidden="true">↗</span>
            </a>
          ) : (
            <span>Come back tomorrow for the next case.</span>
          )}
        </div>
      </section>
    );
  }
  const puzzle = daily.puzzles[index];
  if (!puzzle) return <p role="alert">Case puzzle order is invalid.</p>;
  return (
    <section className="case-page" aria-labelledby="case-title">
      <header className="case-header">
        <div className="case-meta">
          <p className="eyebrow">The daily case</p>
          <time dateTime={daily.date}>{dateLabel}</time>
        </div>
        <div className="case-title-row">
          <h1 id="case-title">{daily.title}</h1>
          <p className="case-progress">
            Act {index + 1} of {daily.puzzles.length}
          </p>
        </div>
        <p className="case-tagline">The move is over. The mystery is yours.</p>
      </header>
      <PuzzleGame
        caseId={daily.id}
        caseTitle={daily.title}
        key={puzzle.id}
        onSolved={() => setSolved((current) => new Set([...current, puzzle.id]))}
        puzzle={puzzle}
      />
    </section>
  );
}
