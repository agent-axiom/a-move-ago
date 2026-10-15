import type { ReactNode } from "react";
import { type DailyCase, useDailyCase } from "./use-daily-case";

function message(kind: "offline" | "auth" | "rate-limit" | "content" | "server" | "contract") {
  switch (kind) {
    case "offline":
      return "You appear to be offline. Your board has not been submitted.";
    case "auth":
      return "The guest session expired. Reload to start a new guest session.";
    case "rate-limit":
      return "Too many requests. Wait a moment and retry.";
    case "content":
      return "There is no published case for this date.";
    case "contract":
      return "The case response was not understood.";
    case "server":
      return "The case service is temporarily unavailable.";
  }
}

export function DailyCaseGate(props: {
  enabled: boolean;
  caseDate: string | null;
  children(daily: DailyCase): ReactNode;
}) {
  const { state, retry } = useDailyCase(props.enabled, props.caseDate);
  if (state.tag === "idle" || state.tag === "loading") {
    return (
      <section className="loading-case" aria-label="Loading case">
        <p className="eyebrow">A daily chess mystery</p>
        <p className="loading-title" role="status">Loading today’s case…</p>
        <div className="loading-layout" aria-hidden="true">
          <div className="loading-board" />
          <div className="loading-lines"><span /><span /><span /></div>
        </div>
      </section>
    );
  }
  if (state.tag === "error") {
    const requestId = "requestId" in state.failure ? state.failure.requestId : undefined;
    return (
      <section className="state-panel" aria-labelledby="daily-error-heading">
        <p className="eyebrow">Pause for a moment</p>
        <h1 id="daily-error-heading">Case unavailable</h1>
        <p role="alert">{message(state.failure.kind)}</p>
        {requestId ? (
          <p>
            Request ID: <code>{requestId}</code>
          </p>
        ) : null}
        {state.failure.kind === "auth" ? (
          <button type="button" onClick={() => window.location.reload()}>
            Restart guest session
          </button>
        ) : state.failure.kind === "contract" ? (
          <button type="button" onClick={() => window.location.reload()}>
            Reload application
          </button>
        ) : (
          <button type="button" onClick={retry}>
            Retry case
          </button>
        )}
      </section>
    );
  }
  return props.children(state.daily);
}
