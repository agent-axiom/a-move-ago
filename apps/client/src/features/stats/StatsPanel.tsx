import { useStats } from "./use-stats";

export function StatsPanel(props: { title?: string; refreshKey?: string }) {
  const { title = "Case complete", refreshKey = "default" } = props;
  const { state, retry } = useStats(true, refreshKey);
  if (state.tag === "loading") return <p role="status">Updating statistics…</p>;
  if (state.tag === "error") {
    const requestId = "requestId" in state.failure ? state.failure.requestId : null;
    const reload = state.failure.kind === "auth" || state.failure.kind === "contract";
    return (
      <section>
        <p role="alert">
          {state.failure.kind === "auth"
            ? "The guest session expired. Restart to continue."
            : state.failure.kind === "contract"
              ? "This version could not read the statistics response. Reload to continue."
              : "Statistics could not be refreshed."}
        </p>
        {requestId ? (
          <p>
            Request ID: <code>{requestId}</code>
          </p>
        ) : null}
        {reload ? (
          <button type="button" onClick={() => window.location.reload()}>
            {state.failure.kind === "auth" ? "Restart guest session" : "Reload application"}
          </button>
        ) : (
          <button type="button" onClick={retry}>
            Retry statistics
          </button>
        )}
      </section>
    );
  }
  return (
    <section className="stats-panel" aria-labelledby="stats-heading">
      <h2 id="stats-heading">{title}</h2>
      <dl className="stats-grid">
        <div className="stat-tile stat-tile-accent">
          <dt>Current streak</dt>
          <dd>{state.stats.currentStreak}</dd>
          <span>{state.stats.currentStreak === 1 ? "day of discovery" : "days of discovery"}</span>
        </div>
        <div className="stat-tile">
          <dt>Best streak</dt>
          <dd>{state.stats.bestStreak}</dd>
          <span>{state.stats.bestStreak === 1 ? "day in a row" : "days in a row"}</span>
        </div>
        <div className="stat-tile">
          <dt>Solved puzzles</dt>
          <dd>{state.stats.solvedPuzzles}</dd>
          <span>
            {state.stats.solvedPuzzles === 1 ? "mystery made clear" : "mysteries made clear"}
          </span>
        </div>
        <div className="stat-tile">
          <dt>Hints used</dt>
          <dd>{state.stats.hintsUsed}</dd>
          <span>A little nudge, when needed</span>
        </div>
      </dl>
    </section>
  );
}
