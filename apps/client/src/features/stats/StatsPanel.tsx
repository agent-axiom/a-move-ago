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
    <section aria-labelledby="stats-heading">
      <h2 id="stats-heading">{title}</h2>
      <dl>
        <dt>Current streak</dt>
        <dd>{state.stats.currentStreak}</dd>
        <dt>Best streak</dt>
        <dd>{state.stats.bestStreak}</dd>
        <dt>Solved puzzles</dt>
        <dd>{state.stats.solvedPuzzles}</dd>
        <dt>Hints used</dt>
        <dd>{state.stats.hintsUsed}</dd>
      </dl>
    </section>
  );
}
