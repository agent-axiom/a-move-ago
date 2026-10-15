import { useI18n } from "../../i18n";
import { useStats } from "./use-stats";

export function StatsPanel(props: { title?: string; refreshKey?: string }) {
  const { t } = useI18n();
  const { title = t("shell.caseComplete"), refreshKey = "default" } = props;
  const { state, retry } = useStats(true, refreshKey);
  if (state.tag === "loading") return <p role="status">{t("shell.statsLoading")}</p>;
  if (state.tag === "error") {
    const requestId = "requestId" in state.failure ? state.failure.requestId : null;
    const reload = state.failure.kind === "auth" || state.failure.kind === "contract";
    return (
      <section>
        <p role="alert">
          {state.failure.kind === "auth"
            ? t("shell.statsAuth")
            : state.failure.kind === "contract"
              ? t("shell.statsContract")
              : t("shell.statsFailure")}
        </p>
        {requestId ? (
          <p>
            {t("shell.requestId")} <code>{requestId}</code>
          </p>
        ) : null}
        {reload ? (
          <button type="button" onClick={() => window.location.reload()}>
            {state.failure.kind === "auth" ? t("shell.restartGuest") : t("shell.reload")}
          </button>
        ) : (
          <button type="button" onClick={retry}>
            {t("shell.retryStats")}
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
          <dt>{t("shell.currentStreak")}</dt>
          <dd>{state.stats.currentStreak}</dd>
          <span>{t("shell.discoveryDays", { count: state.stats.currentStreak })}</span>
        </div>
        <div className="stat-tile">
          <dt>{t("shell.bestStreak")}</dt>
          <dd>{state.stats.bestStreak}</dd>
          <span>{t("shell.consecutiveDays", { count: state.stats.bestStreak })}</span>
        </div>
        <div className="stat-tile">
          <dt>{t("shell.solvedPuzzles")}</dt>
          <dd>{state.stats.solvedPuzzles}</dd>
          <span>{t("shell.mysteriesClear", { count: state.stats.solvedPuzzles })}</span>
        </div>
        <div className="stat-tile">
          <dt>{t("shell.hintsUsed")}</dt>
          <dd>{state.stats.hintsUsed}</dd>
          <span>{t("shell.hintNudge")}</span>
        </div>
      </dl>
    </section>
  );
}
