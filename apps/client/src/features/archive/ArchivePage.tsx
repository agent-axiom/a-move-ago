import type { ArchiveResponse } from "@a-move-ago/api-contract";
import { useState } from "react";
import { useArchive } from "./use-archive";

export function archiveDateLabel(date: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${date}T00:00:00Z`));
}

function monthLabel(month: string): string {
  return new Intl.DateTimeFormat("en", {
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
  const cases = props.archive.cases
    .filter((item) => item.date <= props.archive.today)
    .toSorted((left, right) => right.date.localeCompare(left.date));
  const months = [...new Set(cases.map((item) => item.date.slice(0, 7)))];
  const month = props.selectedMonth && months.includes(props.selectedMonth)
    ? props.selectedMonth
    : months[0];
  const visibleCases = cases.filter((item) => item.date.startsWith(month ?? ""));
  const completed = cases.filter((item) => item.completed).length;

  if (cases.length === 0) {
    return (
      <div className="archive-empty">
        <h2>The collection is just beginning.</h2>
        <p>Published cases will appear here. Today’s case is a good place to start.</p>
      </div>
    );
  }

  return (
    <>
      <div className="archive-summary">
        <p>
          <strong>{cases.length}</strong> {cases.length === 1 ? "case" : "cases"} to explore
          <span aria-hidden="true"> · </span>
          <span>{completed} completed</span>
        </p>
        {props.archive.startsOn ? (
          <p>Since {archiveDateLabel(props.archive.startsOn)}</p>
        ) : null}
      </div>
      <div className="archive-toolbar">
        <div>
          <p className="eyebrow">Choose your next mystery</p>
          <h2 id="archive-month-heading">{month ? monthLabel(month) : "Published cases"}</h2>
        </div>
        <label>
          <span>Browse month</span>
          <select
            aria-label="Archive month"
            value={month}
            onChange={(event) => props.onMonthChange(event.currentTarget.value)}
          >
            {months.map((value) => (
              <option key={value} value={value}>
                {monthLabel(value)}
              </option>
            ))}
          </select>
        </label>
      </div>
      <ul className="archive-cases" aria-labelledby="archive-month-heading">
        {visibleCases.map((item) => {
          const date = archiveDateLabel(item.date);
          const status = item.completed
            ? "Completed"
            : item.solvedPuzzles > 0
              ? "In progress"
              : "Not started";
          return (
            <li key={item.id}>
              <button
                className={`archive-case${item.completed ? " archive-case-completed" : ""}`}
                type="button"
                aria-label={`Open case for ${date}: ${item.title}`}
                aria-describedby={`archive-progress-${item.date}`}
                onClick={() => props.onSelect(item.date)}
              >
                <span className="archive-date" aria-hidden="true">
                  <span>{new Date(`${item.date}T00:00:00Z`).toLocaleDateString("en", {
                    month: "short",
                    timeZone: "UTC",
                  })}</span>
                  <strong>{Number(item.date.slice(8))}</strong>
                </span>
                <span className="archive-case-copy">
                  <span className="archive-case-meta">
                    <time dateTime={item.date}>{date}</time>
                    {item.date === props.archive.today ? <span className="archive-today">Today</span> : null}
                  </span>
                  <strong className="archive-case-title">{item.title}</strong>
                  <span className="archive-case-status" id={`archive-progress-${item.date}`}>
                    <span>{item.completed ? "✓ " : ""}{status}</span>{" "}
                    <span>{item.solvedPuzzles} / {item.puzzleCount} solved</span>
                  </span>
                </span>
                <span className="archive-case-arrow" aria-hidden="true">↗</span>
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
  const { state, retry } = useArchive(props.enabled);
  const [localMonth, setLocalMonth] = useState<string | null>(null);
  const reload = state.tag === "error" &&
    (state.failure.kind === "auth" || state.failure.kind === "contract");
  const requestId = state.tag === "error" && "requestId" in state.failure
    ? state.failure.requestId
    : null;

  return (
    <section className="archive-page" aria-labelledby="archive-heading">
      <header className="archive-heading page-heading">
        <div>
          <p className="eyebrow">One move back, any day</p>
          <h1 id="archive-heading">The archive</h1>
          <p className="page-description">
            There’s always another perspective. Revisit a daily mystery, at your own pace.
          </p>
        </div>
        <button className="button-secondary" type="button" onClick={props.onToday}>
          Back to today
        </button>
      </header>
      {state.tag === "loading" ? <p role="status">Opening the archive…</p> : null}
      {state.tag === "error" ? (
        <div className="archive-empty">
          <h2>The archive is unavailable.</h2>
          <p role="alert">
            {state.failure.kind === "offline"
              ? "You appear to be offline. Reconnect to explore past cases."
              : state.failure.kind === "auth"
                ? "Your session expired. Reload to continue."
                : "We couldn’t load the collection. Please try again."}
          </p>
          {requestId ? <p>Request ID: <code>{requestId}</code></p> : null}
          <button type="button" onClick={reload ? () => window.location.reload() : retry}>
            {reload ? "Reload application" : "Retry archive"}
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
