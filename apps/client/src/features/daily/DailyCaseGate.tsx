import type { ReactNode } from "react";
import { type Translate, useI18n } from "../../i18n";
import { type DailyCase, useDailyCase } from "./use-daily-case";

function message(kind: "offline" | "auth" | "rate-limit" | "content" | "server" | "contract", t: Translate) {
  switch (kind) {
    case "offline":
      return t("shell.dailyOffline");
    case "auth":
      return t("shell.dailyAuth");
    case "rate-limit":
      return t("shell.dailyRateLimit");
    case "content":
      return t("shell.dailyContent");
    case "contract":
      return t("shell.dailyContract");
    case "server":
      return t("shell.dailyServer");
  }
}

export function DailyCaseGate(props: {
  enabled: boolean;
  caseDate: string | null;
  children(daily: DailyCase): ReactNode;
}) {
  const { t } = useI18n();
  const { state, retry } = useDailyCase(props.enabled, props.caseDate);
  if (state.tag === "idle" || state.tag === "loading") {
    return (
      <section className="loading-case" aria-label={t("shell.loadingCase")}>
        <p className="eyebrow">{t("shell.caption")}</p>
        <p className="loading-title" role="status">
          {props.caseDate ? t("shell.openingSelected") : t("shell.loadingToday")}
        </p>
        <div className="loading-layout" aria-hidden="true">
          <div className="loading-board" />
          <div className="loading-lines">
            <span />
            <span />
            <span />
          </div>
        </div>
      </section>
    );
  }
  if (state.tag === "error") {
    const requestId = "requestId" in state.failure ? state.failure.requestId : undefined;
    return (
      <section className="state-panel" aria-labelledby="daily-error-heading">
        <p className="eyebrow">{t("shell.pause")}</p>
        <h1 id="daily-error-heading">{t("shell.caseUnavailable")}</h1>
        <p role="alert">{message(state.failure.kind, t)}</p>
        {requestId ? (
          <p>
            {t("shell.requestId")} <code>{requestId}</code>
          </p>
        ) : null}
        {state.failure.kind === "auth" ? (
          <button type="button" onClick={() => window.location.reload()}>
            {t("shell.restartGuest")}
          </button>
        ) : state.failure.kind === "contract" ? (
          <button type="button" onClick={() => window.location.reload()}>
            {t("shell.reload")}
          </button>
        ) : (
          <button type="button" onClick={retry}>
            {t("shell.retryCase")}
          </button>
        )}
      </section>
    );
  }
  return props.children(state.daily);
}
