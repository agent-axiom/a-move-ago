import type { ArchiveResponse } from "@a-move-ago/api-contract";
import { useState } from "react";
import { localizedText, useI18n } from "../../i18n";
import { useArchive } from "./use-archive";

export function archiveDateLabel(date: string, locale = "en"): string {
  return new Intl.DateTimeFormat(locale === "en" ? "en-GB" : locale, {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${date}T00:00:00Z`));
}

function monthLabel(month: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${month}-01T00:00:00Z`));
}

function ArchiveCases(props: {
  archive: ArchiveResponse;
  selectedMonth: string | null;
  onMonthChange(month: string): void;
  onSelect(date: string): void;
}) {
  const { locale, intlLocale, t } = useI18n();
  const cases = props.archive.cases
    .filter((item) => item.date <= props.archive.today)
    .toSorted((left, right) => right.date.localeCompare(left.date));
  const months = [...new Set(cases.map((item) => item.date.slice(0, 7)))];
  const month =
    props.selectedMonth && months.includes(props.selectedMonth) ? props.selectedMonth : months[0];
  const visibleCases = cases.filter((item) => item.date.startsWith(month ?? ""));
  const completed = cases.filter((item) => item.completed).length;

  if (cases.length === 0) {
    return (
      <div className="archive-empty">
        <h2>{t("shell.archiveEmptyTitle")}</h2>
        <p>{t("shell.archiveEmptyDescription")}</p>
      </div>
    );
  }

  return (
    <>
      <div className="archive-summary">
        <p>
          <strong>{cases.length}</strong> {t("shell.archiveExplore", { count: cases.length })}
          <span aria-hidden="true"> · </span>
          <span>{t("shell.archiveCompleted", { count: completed })}</span>
        </p>
        {props.archive.startsOn ? <p>{t("shell.archiveSince", { date: archiveDateLabel(props.archive.startsOn, intlLocale) })}</p> : null}
      </div>
      <div className="archive-toolbar">
        <div>
          <p className="eyebrow">{t("shell.archiveChoose")}</p>
          <h2 id="archive-month-heading">{month ? monthLabel(month, intlLocale) : t("shell.archivePublished")}</h2>
        </div>
        <label>
          <span>{t("shell.browseMonth")}</span>
          <select
            aria-label={t("shell.archiveMonth")}
            value={month}
            onChange={(event) => props.onMonthChange(event.currentTarget.value)}
          >
            {months.map((value) => (
              <option key={value} value={value}>
                {monthLabel(value, intlLocale)}
              </option>
            ))}
          </select>
        </label>
      </div>
      <ul className="archive-cases" aria-labelledby="archive-month-heading">
        {visibleCases.map((item) => {
          const date = archiveDateLabel(item.date, intlLocale);
          const title = localizedText(item, "title", locale);
          const status = item.completed
            ? t("shell.completed")
            : item.solvedPuzzles > 0
              ? t("shell.inProgress")
              : t("shell.notStarted");
          return (
            <li key={item.id}>
              <button
                className={`archive-case${item.completed ? " archive-case-completed" : ""}`}
                type="button"
                aria-label={t("shell.openCase", { date, title })}
                aria-describedby={`archive-progress-${item.date}`}
                onClick={() => props.onSelect(item.date)}
              >
                <span className="archive-date" aria-hidden="true">
                  <span>
                    {new Date(`${item.date}T00:00:00Z`).toLocaleDateString(intlLocale, {
                      month: "short",
                      timeZone: "UTC",
                    })}
                  </span>
                  <strong>{Number(item.date.slice(8))}</strong>
                </span>
                <span className="archive-case-copy">
                  <span className="archive-case-meta">
                    <time dateTime={item.date}>{date}</time>
                    {item.date === props.archive.today ? (
                      <span className="archive-today">{t("shell.today")}</span>
                    ) : null}
                  </span>
                  <strong className="archive-case-title">{title}</strong>
                  <span className="archive-case-status" id={`archive-progress-${item.date}`}>
                    <span>
                      {item.completed ? "✓ " : ""}
                      {status}
                    </span>{" "}
                    <span>
                      {t("shell.solvedCount", { solved: item.solvedPuzzles, total: item.puzzleCount })}
                    </span>
                  </span>
                </span>
                <span className="archive-case-arrow" aria-hidden="true">
                  ↗
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </>
  );
}

export function ArchivePage(props: {
  enabled: boolean;
  month?: string | null;
  onMonthChange?(month: string): void;
  onSelect(date: string): void;
  onToday(): void;
}) {
  const { t } = useI18n();
  const { state, retry } = useArchive(props.enabled);
  const [localMonth, setLocalMonth] = useState<string | null>(null);
  const reload =
    state.tag === "error" && (state.failure.kind === "auth" || state.failure.kind === "contract");
  const requestId =
    state.tag === "error" && "requestId" in state.failure ? state.failure.requestId : null;

  return (
    <section className="archive-page" aria-labelledby="archive-heading">
      <header className="archive-heading page-heading">
        <div>
          <p className="eyebrow">{t("shell.archiveEyebrow")}</p>
          <h1 id="archive-heading">{t("shell.archiveTitle")}</h1>
          <p className="page-description">
            {t("shell.archiveDescription")}
          </p>
        </div>
        <button className="button-secondary" type="button" onClick={props.onToday}>
          {t("shell.backToday")}
        </button>
      </header>
      {state.tag === "loading" ? <p role="status">{t("shell.archiveLoading")}</p> : null}
      {state.tag === "error" ? (
        <div className="archive-empty">
          <h2>{t("shell.archiveUnavailable")}</h2>
          <p role="alert">
            {state.failure.kind === "offline"
              ? t("shell.archiveOffline")
              : state.failure.kind === "auth"
                ? t("shell.sessionExpired")
                : t("shell.archiveFailure")}
          </p>
          {requestId ? (
            <p>
              {t("shell.requestId")} <code>{requestId}</code>
            </p>
          ) : null}
          <button type="button" onClick={reload ? () => window.location.reload() : retry}>
            {reload ? t("shell.reload") : t("shell.retryArchive")}
          </button>
        </div>
      ) : null}
      {state.tag === "ready" ? (
        <ArchiveCases
          archive={state.archive}
          selectedMonth={props.month !== undefined ? props.month : localMonth}
          onMonthChange={(month) => {
            setLocalMonth(month);
            props.onMonthChange?.(month);
          }}
          onSelect={props.onSelect}
        />
      ) : null}
    </section>
  );
}
