import { localizedSystemMessage, useI18n } from "../../i18n";
import { useSession } from "./SessionProvider";

export function SaveProgressButton() {
  const { locale, t } = useI18n();
  const { state, save, retryHandoff } = useSession();
  if (state.tag === "ready" && state.me.kind === "telegram") return null;
  const disabled =
    state.tag === "booting" || state.tag === "authenticating" || state.tag === "fatal";
  return (
    <div className="save-progress">
      <button
        className="button-primary"
        type="button"
        disabled={disabled}
        onClick={() => {
          void (state.tag === "handoff-retry" ? retryHandoff() : save());
        }}
      >
        {state.tag === "authenticating"
          ? t("shell.connecting")
          : state.tag === "handoff-retry"
            ? t("shell.retryTelegram")
            : t("shell.saveTelegram")}
      </button>
      {state.tag === "auth-error" || state.tag === "handoff-retry" ? (
        <p role="alert">
          {localizedSystemMessage(
            state.message,
            locale,
            t,
            state.tag === "auth-error" ? state.errorCode : undefined,
          )}
        </p>
      ) : null}
      {state.tag === "auth-error" && state.requestId ? (
        <p>
          {t("shell.requestId")} <code>{state.requestId}</code>
        </p>
      ) : null}
    </div>
  );
}
