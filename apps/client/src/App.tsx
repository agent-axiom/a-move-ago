import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { useRuntime } from "./app/runtime";
import { useAppNavigation } from "./app/use-app-navigation";
import { useHostBack } from "./app/use-host-back";
import { ArchivePage, archiveDateLabel } from "./features/archive/ArchivePage";
import { CaseGame } from "./features/daily/CaseGame";
import { DailyCaseGate } from "./features/daily/DailyCaseGate";
import { findNextUnsolvedCase } from "./features/daily/next-unsolved";
import { ProfileDeletion } from "./features/session/ProfileDeletion";
import { SaveProgressButton } from "./features/session/SaveProgressButton";
import { SessionProvider, useSession } from "./features/session/SessionProvider";
import type { Me } from "./features/session/session-state";
import { StatsPanel } from "./features/stats/StatsPanel";
import { FirstMoveTutorial } from "./features/tutorial/FirstMoveTutorial";
import {
  dismissTutorialInvitation,
  shouldOfferTutorial,
} from "./features/tutorial/tutorial-preference";
import { I18nProvider, LanguageSwitcher, localizedSystemMessage, useI18n } from "./i18n";
import { tutorialCopy } from "./i18n/messages/tutorial";
import { BrandMark } from "./shared/BrandMark";
import "./i18n/language.css";
import "./features/archive/archive.css";

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
  const { locale, intlLocale, t } = useI18n();
  const runtime = useRuntime();
  const { state } = useSession();
  const { navigation, dispatch } = useAppNavigation();
  const [tutorialOpen, setTutorialOpen] = useState(false);
  const [tutorialOffered, setTutorialOffered] = useState(shouldOfferTutorial);
  const nextCaseRequest = useRef<AbortController | null>(null);
  const tutorial = tutorialCopy[locale];
  const closeTutorial = useCallback(() => setTutorialOpen(false), []);
  useHostBack(navigation, dispatch, tutorialOpen ? closeTutorial : undefined);

  useEffect(() => {
    const disposeLayout = runtime.platform.installLayoutVars(document.documentElement);
    void runtime.platform.ready();
    return disposeLayout;
  }, [runtime.platform]);

  const screen = navigation.stack.at(-1) ?? { name: "case" as const };
  const caseDate = screen.name === "case" ? (screen.caseDate ?? null) : null;
  const showToday = () => dispatch({ type: "reset", screen: { name: "case" } });
  const sessionReady = state.tag !== "booting" && state.tag !== "fatal";
  const me = "me" in state ? state.me : null;
  const identity = sessionIdentity(runtime, me);

  useEffect(() => () => nextCaseRequest.current?.abort(), [identity, screen.name, caseDate]);

  function openTutorial() {
    dismissTutorialInvitation();
    setTutorialOffered(false);
    setTutorialOpen(true);
  }

  async function openNextUnsolved(currentDate: string): Promise<boolean> {
    nextCaseRequest.current?.abort();
    const controller = new AbortController();
    nextCaseRequest.current = controller;
    const date = await findNextUnsolvedCase(runtime.api, currentDate, controller.signal);
    controller.signal.throwIfAborted();
    if (!date) return false;
    dispatch({ type: "push", screen: { name: "case", caseDate: date } });
    return true;
  }

  let content: ReactNode;
  if (state.tag === "fatal") {
    content = (
      <section className="state-panel" aria-labelledby="startup-error-heading">
        <p className="eyebrow">{t("shell.startupEyebrow")}</p>
        <h1 id="startup-error-heading">{t("shell.startupUnavailable")}</h1>
        <p role="alert">{localizedSystemMessage(state.message, locale, t)}</p>
        {state.requestId ? (
          <p>
            {t("shell.requestId")} <code>{state.requestId}</code>
          </p>
        ) : null}
        <button type="button" onClick={() => window.location.reload()}>
          {t("shell.retryStartup")}
        </button>
      </section>
    );
  } else if (screen.name === "profile") {
    content = (
      <section className="profile-page" aria-labelledby="profile-heading">
        <header className="page-heading">
          <p className="eyebrow">{t("shell.journal")}</p>
          <h1 id="profile-heading">{t("shell.progress")}</h1>
          <p className="page-description">{t("shell.progressDescription")}</p>
        </header>
        {sessionReady ? <StatsPanel refreshKey={identity} title={t("shell.statistics")} /> : null}
        <div className="profile-connection">
          <span className="connection-mark" aria-hidden="true">
            {me?.kind === "telegram" ? "✓" : "↗"}
          </span>
          <div className="profile-connection-copy">
            <h2>
              {me?.kind === "telegram"
                ? t("shell.connectedAs", { name: me.profile.displayName })
                : t("shell.guest")}
            </h2>
            <p>
              {me?.kind === "telegram"
                ? t("shell.connectedDescription")
                : t("shell.guestDescription")}
            </p>
            <SaveProgressButton />
          </div>
        </div>
        <ProfileDeletion />
      </section>
    );
  } else if (screen.name === "archive") {
    content = (
      <ArchivePage
        enabled={sessionReady}
        key={identity}
        month={screen.month ?? null}
        onMonthChange={(month) => dispatch({ type: "replace", screen: { name: "archive", month } })}
        onSelect={(date) => dispatch({ type: "push", screen: { name: "case", caseDate: date } })}
        onToday={showToday}
      />
    );
  } else {
    content = (
      <>
        {caseDate ? (
          <section className="archive-case-context" aria-label={t("shell.selectedArchive")}>
            <p>
              {t("shell.fromArchive")} ·{" "}
              <time dateTime={caseDate}>{archiveDateLabel(caseDate, intlLocale)}</time>
            </p>
            <div>
              <button
                className="button-quiet"
                type="button"
                onClick={() => dispatch({ type: "push", screen: { name: "archive" } })}
              >
                {t("shell.browseArchive")}
              </button>
              <button className="button-secondary" type="button" onClick={showToday}>
                {t("shell.backToday")}
              </button>
            </div>
          </section>
        ) : null}
        <DailyCaseGate
          enabled={sessionReady}
          caseDate={caseDate}
          key={`${identity}:${caseDate ?? "today"}`}
        >
          {(daily) => (
            <CaseGame
              daily={daily}
              key={daily.id}
              onToday={showToday}
              onNextUnsolved={() => openNextUnsolved(daily.date)}
            />
          )}
        </DailyCaseGate>
      </>
    );
  }

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        {t("shell.skip")}
      </a>
      <header className="app-header">
        <div className="brand">
          <BrandMark />
          <div>
            <strong className="brand-wordmark">A MOVE AGO</strong>
            <span className="brand-caption">{t("shell.caption")}</span>
          </div>
        </div>
        <nav className="app-nav" aria-label={t("shell.mainNavigation")}>
          {screen.name === "profile" ? (
            <button
              className="button-quiet nav-button"
              type="button"
              onClick={() => dispatch({ type: "back" })}
            >
              {navigation.stack.at(-2)?.name === "archive"
                ? t("shell.backArchive")
                : t("shell.backCase")}
            </button>
          ) : (
            <button
              className="button-quiet nav-button"
              type="button"
              disabled={!sessionReady}
              onClick={() => dispatch({ type: "push", screen: { name: "profile" } })}
            >
              {t("shell.progress")} <span aria-hidden="true">↗</span>
            </button>
          )}
          <button
            className="button-quiet nav-button"
            type="button"
            disabled={!sessionReady}
            aria-current={screen.name === "archive" ? "page" : undefined}
            onClick={() => {
              if (screen.name !== "archive")
                dispatch({ type: "push", screen: { name: "archive" } });
            }}
          >
            {t("shell.archive")}
          </button>
          <LanguageSwitcher />
          <details className="how-to-play">
            <summary aria-label={t("shell.howToPlay")}>
              <span className="help-icon" aria-hidden="true">
                ?
              </span>
              <span className="help-label">{t("shell.howToPlay")}</span>
            </summary>
            <div className="help-panel">
              <p className="eyebrow">{t("shell.helpEyebrow")}</p>
              <h2>{t("shell.helpTitle")}</h2>
              <p>{t("shell.helpIntro")}</p>
              <ol>
                <li>
                  <strong>{t("shell.helpChoose")}</strong> {t("shell.helpChooseText")}
                </li>
                <li>
                  <strong>{t("shell.helpMove")}</strong> {t("shell.helpMoveText")}
                </li>
                <li>
                  <strong>{t("shell.helpComplete")}</strong> {t("shell.helpCompleteText")}
                </li>
              </ol>
              <p className="help-note">{t("shell.helpNote")}</p>
              <button type="button" onClick={openTutorial}>
                {tutorial.learnButton}
              </button>
            </div>
          </details>
        </nav>
      </header>
      <main className="app-body" id="main-content" tabIndex={-1}>
        {sessionReady && screen.name === "case" && tutorialOffered ? (
          <aside className="tutorial-invitation" aria-labelledby="tutorial-invitation-title">
            <div>
              <h2 id="tutorial-invitation-title">{tutorial.invitationTitle}</h2>
              <p>{tutorial.invitationBody}</p>
            </div>
            <div className="tutorial-invitation-actions">
              <button type="button" onClick={openTutorial}>
                {tutorial.invitationStart}
              </button>
              <button
                type="button"
                className="button-quiet tutorial-invitation-dismiss"
                aria-label={tutorial.invitationDismiss}
                onClick={() => {
                  dismissTutorialInvitation();
                  setTutorialOffered(false);
                }}
              >
                <span aria-hidden="true">×</span>
              </button>
            </div>
          </aside>
        ) : null}
        {content}
      </main>
      {tutorialOpen ? <FirstMoveTutorial locale={locale} onClose={closeTutorial} /> : null}
      <footer className="app-footer">
        <span>{t("shell.footer")}</span>
        <div>
          <span>{t("shell.newCaseTime")}</span>
          <a
            href="https://github.com/agent-axiom/a-move-ago/blob/main/PRIVACY.md"
            target="_blank"
            rel="noreferrer"
          >
            {t("shell.privacy")}
          </a>
        </div>
      </footer>
    </div>
  );
}

export function App() {
  const runtime = useRuntime();
  return (
    <I18nProvider>
      <SessionProvider key={runtimeId(runtime)}>
        <AppContent />
      </SessionProvider>
    </I18nProvider>
  );
}
