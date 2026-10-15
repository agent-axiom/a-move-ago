import { useI18n } from "../../i18n";
import { useStats } from "./use-stats";
import "./stats.css";

export function StatsPanel(props: { title?: string; refreshKey?: string }) {
  const { intlLocale, t } = useI18n();
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
      {state.stats.points !== undefined ? (
        <section className="personal-rating" aria-labelledby="personal-rating-heading">
          <div className="personal-rating-value">
            <h3 id="personal-rating-heading">{t("shell.ratingTitle")}</h3>
            <p className="personal-rating-total">
              <strong>{new Intl.NumberFormat(intlLocale).format(state.stats.points)}</strong>{" "}
              <span>{t("shell.ratingUnit", { count: state.stats.points })}</span>
            </p>
            <p className="personal-rating-caption">{t("shell.ratingStart")}</p>
          </div>
          <div className="personal-rating-rules">
            <h4>{t("shell.ratingRules")}</h4>
            <dl className="personal-rating-scale">
              <div><dt>{t("shell.ratingTry1")}</dt><dd>100</dd></div>
              <div><dt>{t("shell.ratingTry2")}</dt><dd>70</dd></div>
              <div><dt>{t("shell.ratingTry3")}</dt><dd>40</dd></div>
              <div><dt>{t("shell.ratingTry4")}</dt><dd>20</dd></div>
            </dl>
            <p>{t("shell.ratingHints")}</p>
          </div>
        </section>
      ) : null}
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
