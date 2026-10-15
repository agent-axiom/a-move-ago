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
import { BrandMark } from "./shared/BrandMark";

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
      <section className="state-panel" aria-labelledby="startup-error-heading">
        <p className="eyebrow">A moment before the next move</p>
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
      <section className="profile-page" aria-labelledby="profile-heading">
        <header className="page-heading">
          <p className="eyebrow">Your chess journal</p>
          <h1 id="profile-heading">Progress</h1>
          <p className="page-description">Good discoveries deserve to be remembered.</p>
        </header>
        {sessionReady ? <StatsPanel refreshKey={identity} title="Statistics" /> : null}
        <div className="profile-connection">
          <span className="connection-mark" aria-hidden="true">
            {me?.kind === "telegram" ? "✓" : "↗"}
          </span>
          <div className="profile-connection-copy">
            <h2>
              {me?.kind === "telegram"
                ? `Connected as ${me.profile.displayName}`
                : "Playing as a guest"}
            </h2>
            <p>
              {me?.kind === "telegram"
                ? "Your discoveries follow you across devices."
                : "No account needed. Connect Telegram to keep your progress across devices."}
            </p>
            <SaveProgressButton />
          </div>
        </div>
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
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <header className="app-header">
        <div className="brand">
          <BrandMark />
          <div>
            <strong className="brand-wordmark">A MOVE AGO</strong>
            <span className="brand-caption">A daily chess mystery</span>
          </div>
        </div>
        <nav className="app-nav" aria-label="Main navigation">
          {screen.name === "profile" ? (
            <button
              className="button-quiet nav-button"
              type="button"
              onClick={() => dispatch({ type: "back" })}
            >
              Back to case
            </button>
          ) : (
            <button
              className="button-quiet nav-button"
              type="button"
              disabled={!sessionReady}
              onClick={() => dispatch({ type: "push", screen: { name: "profile" } })}
            >
              Progress <span aria-hidden="true">↗</span>
            </button>
          )}
          <details className="how-to-play">
            <summary aria-label="How to play">
              <span className="help-icon" aria-hidden="true">
                ?
              </span>
              <span className="help-label">How to play</span>
            </summary>
            <div className="help-panel">
              <p className="eyebrow">A different way to play</p>
              <h2>Think one move back.</h2>
              <p>The last move has already happened. Can you work out what it was?</p>
              <ol>
                <li>
                  <strong>Choose a piece.</strong> Pick a piece of the side that moved last.
                </li>
                <li>
                  <strong>Move it back.</strong> Choose the empty square it came from.
                </li>
                <li>
                  <strong>Complete the story.</strong> Restore a capture or choose a special move,
                  then check your move.
                </li>
              </ol>
              <p className="help-note">
                Tap or use the arrow keys and Enter. Take your time — there is no clock.
              </p>
            </div>
          </details>
        </nav>
      </header>
      <main className="app-body" id="main-content" tabIndex={-1}>
        {content}
      </main>
      <footer className="app-footer">
        <span>A new perspective, every day.</span>
        <div>
          <span>New case at 00:00 UTC</span>
          <a
            href="https://github.com/agent-axiom/a-move-ago/blob/main/PRIVACY.md"
            target="_blank"
            rel="noreferrer"
          >
            Privacy
          </a>
        </div>
      </footer>
    </div>
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
