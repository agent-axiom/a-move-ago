import { useMemo, useState } from "react";
import { localizedText, useI18n } from "../../i18n";
import { PuzzleGame } from "../game/ui/PuzzleGame";
import { StatsPanel } from "../stats/StatsPanel";
import { nextUnsolvedIndex } from "./case-progress";
import type { DailyCase } from "./use-daily-case";

export function CaseGame({ daily, onToday }: { daily: DailyCase; onToday?: () => void }) {
  const { locale, intlLocale, t } = useI18n();
  const title = localizedText(daily, "title", locale);
  const [solved, setSolved] = useState<ReadonlySet<string>>(() => new Set(daily.solvedPuzzleIds));
  const puzzleIds = useMemo(() => daily.puzzles.map((puzzle) => puzzle.id), [daily.puzzles]);
  const index = nextUnsolvedIndex(puzzleIds, solved);
  const dateLabel = new Intl.DateTimeFormat(intlLocale, {
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
          <p className="eyebrow">{t("shell.completeEyebrow")}</p>
          <h1 id="case-title">{title}</h1>
          <p className="page-description">{t("shell.completeDescription")}</p>
        </header>
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
    );
  }
  const puzzle = daily.puzzles[index];
  if (!puzzle) return <p role="alert">{t("shell.invalidPuzzleOrder")}</p>;
  return (
    <section className="case-page" aria-labelledby="case-title">
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
      />
    </section>
  );
}
