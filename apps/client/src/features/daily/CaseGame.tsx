import { useMemo, useState } from "react";
import { PuzzleGame } from "../game/ui/PuzzleGame";
import { StatsPanel } from "../stats/StatsPanel";
import { nextUnsolvedIndex } from "./case-progress";
import type { DailyCase } from "./use-daily-case";

export function CaseGame({ daily }: { daily: DailyCase }) {
  const [solved, setSolved] = useState<ReadonlySet<string>>(() => new Set(daily.solvedPuzzleIds));
  const puzzleIds = useMemo(() => daily.puzzles.map((puzzle) => puzzle.id), [daily.puzzles]);
  const index = nextUnsolvedIndex(puzzleIds, solved);
  if (index === null) {
    return (
      <section aria-labelledby="case-title">
        <h1 id="case-title">{daily.title}</h1>
        <StatsPanel />
      </section>
    );
  }
  const puzzle = daily.puzzles[index];
  if (!puzzle) return <p role="alert">Case puzzle order is invalid.</p>;
  return (
    <section aria-labelledby="case-title">
      <header>
        <h1 id="case-title">{daily.title}</h1>
        <p>
          Act {index + 1} of {daily.puzzles.length}
        </p>
      </header>
      <PuzzleGame
        caseId={daily.id}
        key={puzzle.id}
        onSolved={() => setSolved((current) => new Set([...current, puzzle.id]))}
        puzzle={puzzle}
      />
    </section>
  );
}
