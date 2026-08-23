import { type ReactNode, useEffect, useMemo, useReducer } from "react";
import { parseEntryQuery } from "./app/entry-query";
import { initialNavigation, navigationReducer } from "./app/navigation";
import { useRuntime } from "./app/runtime";
import { useHostBack } from "./app/use-host-back";
import { CaseGame } from "./features/daily/CaseGame";
import { DailyCaseGate } from "./features/daily/DailyCaseGate";
import { ProfileDeletion } from "./features/session/ProfileDeletion";
import { SaveProgressButton } from "./features/session/SaveProgressButton";
import { SessionProvider, useSession } from "./features/session/SessionProvider";
import type { Me } from "./features/session/session-state";
import { StatsPanel } from "./features/stats/StatsPanel";

const runtimeIds = new WeakMap<object, number>();
let nextRuntimeId = 1;

function runtimeId(runtime: object): number {
  const existing = runtimeIds.get(runtime);
  if (existing !== undefined) return existing;
  const created = nextRuntimeId;
  nextRuntimeId += 1;
  runtimeIds.set(runtime, created);
  return created;
}

function sessionIdentity(runtime: object, me: Me | null): string {
  const identity =
    me?.kind === "telegram" ? `telegram:${me.profile.telegramUserId}` : (me?.kind ?? "pending");
  return `${runtimeId(runtime)}:${identity}`;
}

function AppContent() {
  const runtime = useRuntime();
  const { state } = useSession();
  const entry = useMemo(() => parseEntryQuery(new URL(window.location.href)), []);
  const [navigation, dispatch] = useReducer(navigationReducer, entry.caseDate, initialNavigation);
  useHostBack(navigation, dispatch);

  useEffect(() => {
    const disposeLayout = runtime.platform.installLayoutVars(document.documentElement);
    void runtime.platform.ready();
    return disposeLayout;
  }, [runtime.platform]);

  const screen = navigation.stack.at(-1) ?? { name: "case" as const };
  const sessionReady = state.tag !== "booting" && state.tag !== "fatal";
  const me = "me" in state ? state.me : null;
  const identity = sessionIdentity(runtime, me);

  let content: ReactNode;
  if (state.tag === "fatal") {
    content = (
      <section aria-labelledby="startup-error-heading">
        <h1 id="startup-error-heading">Startup unavailable</h1>
        <p role="alert">{state.message}</p>
        {state.requestId ? (
          <p>
            Request ID: <code>{state.requestId}</code>
          </p>
        ) : null}
        <button type="button" onClick={() => window.location.reload()}>
          Retry startup
        </button>
      </section>
    );
  } else if (screen.name === "profile") {
    content = (
      <section aria-labelledby="profile-heading">
        <h1 id="profile-heading">Progress</h1>
        <p>
          {me?.kind === "telegram"
            ? `Connected as ${me.profile.displayName}`
            : "Playing as a guest"}
        </p>
        <SaveProgressButton />
        {sessionReady ? <StatsPanel refreshKey={identity} title="Statistics" /> : null}
        <ProfileDeletion />
      </section>
    );
  } else {
    content = (
      <DailyCaseGate enabled={sessionReady} caseDate={entry.caseDate} key={identity}>
        {(daily) => <CaseGame daily={daily} key={daily.id} />}
      </DailyCaseGate>
    );
  }

  return (
    <main className="app-shell">
      <header>
        <strong>A MOVE AGO</strong>
        {screen.name === "profile" ? (
          <button type="button" onClick={() => dispatch({ type: "back" })}>
            Back to case
          </button>
        ) : (
          <button
            type="button"
            disabled={!sessionReady}
            onClick={() => dispatch({ type: "push", screen: { name: "profile" } })}
          >
            Progress
          </button>
        )}
      </header>
      {content}
    </main>
  );
}

export function App() {
  const runtime = useRuntime();
  return (
    <SessionProvider key={runtimeId(runtime)}>
      <AppContent />
    </SessionProvider>
  );
}
