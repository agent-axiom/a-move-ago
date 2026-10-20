import { useCallback, useEffect, useId, useRef, useState } from "react";
import { LanguageSwitcher, useI18n } from "../i18n";
import { tutorialCopy } from "../i18n/messages/tutorial";
import { useOverlayDismiss } from "./overlays";
import "./app-menu.css";

export function AppMenu({ onTutorial }: { onTutorial(): void }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  return (
    <>
      <button
        aria-label={t("shell.menu")}
        aria-haspopup="dialog"
        className="button-quiet app-menu-trigger"
        onClick={() => setOpen(true)}
        type="button"
      >
        <svg aria-hidden="true" viewBox="0 0 24 24" fill="none">
          <path d="M5 7h14M5 12h14M5 17h14" stroke="currentColor" strokeWidth="1.6" />
        </svg>
      </button>
      {open ? (
        <AppMenuDialog
          onClose={close}
          onTutorial={() => {
            close();
            onTutorial();
          }}
        />
      ) : null}
    </>
  );
}

function AppMenuDialog({ onClose, onTutorial }: { onClose(): void; onTutorial(): void }) {
  const { locale, t } = useI18n();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useOverlayDismiss(onClose);

  useEffect(() => {
    const dialog = dialogRef.current;
    const previousFocus = document.activeElement;
    dialog?.showModal();
    return () => {
      dialog?.close();
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
    };
  }, []);

  return (
    <dialog
      aria-labelledby={titleId}
      className="app-menu-dialog"
      ref={dialogRef}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <header className="app-menu-heading">
        <h2 id={titleId}>{t("shell.menu")}</h2>
        <button
          aria-label={t("shell.closeMenu")}
          className="button-quiet app-menu-close"
          onClick={onClose}
          type="button"
        >
          <span aria-hidden="true">×</span>
        </button>
      </header>
      <LanguageSwitcher />
      <details className="how-to-play">
        <summary>{t("shell.howToPlay")}</summary>
        <div className="help-panel">
          <h3>{t("shell.helpTitle")}</h3>
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
        </div>
      </details>
      <button className="button-primary app-menu-learn" onClick={onTutorial} type="button">
        {tutorialCopy[locale].invitationStart}
        <span aria-hidden="true">↗</span>
      </button>
      <a
        className="app-menu-privacy"
        href="https://github.com/agent-axiom/a-move-ago/blob/main/PRIVACY.md"
        target="_blank"
        rel="noreferrer"
      >
        {t("shell.privacy")}
      </a>
    </dialog>
  );
}
