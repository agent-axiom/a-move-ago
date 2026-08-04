import { useSession } from "./SessionProvider";

export function SaveProgressButton() {
  const { state, save, retryHandoff } = useSession();
  if (state.tag === "ready" && state.me.kind === "telegram") return null;
  const disabled =
    state.tag === "booting" || state.tag === "authenticating" || state.tag === "fatal";
  return (
    <div>
      <button
        type="button"
        disabled={disabled}
        onClick={() => {
          void (state.tag === "handoff-retry" ? retryHandoff() : save());
        }}
      >
        {state.tag === "authenticating"
          ? "Connecting…"
          : state.tag === "handoff-retry"
            ? "Retry Telegram return"
            : "Save progress with Telegram"}
      </button>
      {state.tag === "auth-error" || state.tag === "handoff-retry" ? (
        <p role="alert">{state.message}</p>
      ) : null}
      {state.tag === "auth-error" && state.requestId ? (
        <p>
          Request ID: <code>{state.requestId}</code>
        </p>
      ) : null}
    </div>
  );
}
