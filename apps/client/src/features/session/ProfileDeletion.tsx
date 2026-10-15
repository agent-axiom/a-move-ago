import { ApiError } from "@a-move-ago/api-contract";
import { useEffect, useRef, useState } from "react";
import { localizedSystemMessage, useI18n } from "../../i18n";
import { useSession } from "./SessionProvider";

type DeletionView =
  | { tag: "closed" }
  | { tag: "confirming" }
  | { tag: "pending" }
  | {
      tag: "error";
      message: string;
      requestId?: string;
      reloadToReauthenticate?: true;
    }
  | { tag: "success" };

const confirmationId = "profile-deletion-confirmation";
const headingId = "profile-deletion-heading";
const warningId = "profile-deletion-warning";

const unconfirmedMessage =
  "Telegram profile deletion could not be confirmed. Retry to check the current profile state.";
const inactiveSessionMessage =
  "Profile deletion could not be confirmed because this app session is no longer active. Reload, then choose Save progress with Telegram to verify the profile.";

function classifyFailure(error: unknown): Extract<DeletionView, { tag: "error" }> {
  if (error instanceof ApiError) {
    if (error.status === 401) {
      return {
        tag: "error",
        message: inactiveSessionMessage,
        requestId: error.requestId,
        reloadToReauthenticate: true,
      };
    }
    return { tag: "error", message: error.message, requestId: error.requestId };
  }
  return { tag: "error", message: unconfirmedMessage };
}

export function ProfileDeletion() {
  const { locale, t } = useI18n();
  const { state, deleteProfile } = useSession();
  const [view, setView] = useState<DeletionView>({ tag: "closed" });
  const openerRef = useRef<HTMLButtonElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const successRef = useRef<HTMLParagraphElement>(null);
  const mountedRef = useRef(false);
  const inFlightRef = useRef(false);
  const returnFocusRef = useRef(false);
  const telegramReady = state.tag === "ready" && state.me.kind === "telegram";
  const guestReady = state.tag === "ready" && state.me.kind === "guest";

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (view.tag === "confirming") {
      headingRef.current?.focus();
      return;
    }
    if (view.tag === "closed" && returnFocusRef.current) {
      returnFocusRef.current = false;
      openerRef.current?.focus();
      return;
    }
    if (view.tag === "success" && guestReady) successRef.current?.focus();
  }, [guestReady, view.tag]);

  async function confirmDeletion() {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setView({ tag: "pending" });
    try {
      const confirmed = await deleteProfile();
      if (!mountedRef.current) return;
      setView(confirmed ? { tag: "success" } : { tag: "confirming" });
    } catch (error) {
      if (mountedRef.current) setView(classifyFailure(error));
    } finally {
      inFlightRef.current = false;
    }
  }

  if (view.tag === "success" && guestReady) {
    return (
      <div className="profile-deletion">
        <p ref={successRef} role="status" tabIndex={-1}>
          {t("shell.deleted")}
        </p>
      </div>
    );
  }
  if (!telegramReady) return null;

  const visibleView: DeletionView = view.tag === "success" ? { tag: "closed" } : view;
  const expanded = visibleView.tag !== "closed";
  const pending = visibleView.tag === "pending";

  return (
    <div className="profile-deletion">
      <button
        ref={openerRef}
        type="button"
        aria-expanded={expanded}
        aria-controls={confirmationId}
        disabled={pending}
        onClick={() => {
          setView(expanded ? { tag: "closed" } : { tag: "confirming" });
        }}
      >
        {t("shell.deleteProfile")}
      </button>
      {expanded ? (
        <section
          id={confirmationId}
          className="profile-deletion__confirmation"
          aria-labelledby={headingId}
          aria-describedby={warningId}
        >
          <h2 ref={headingRef} id={headingId} tabIndex={-1}>
            {t("shell.deleteProfileQuestion")}
          </h2>
          <p id={warningId}>
            {t("shell.deleteWarning")}
          </p>
          {pending ? <p role="status">{t("shell.deletingProfile")}</p> : null}
          {visibleView.tag === "error" ? (
            <>
              <p role="alert">
                {localizedSystemMessage(visibleView.message, locale, t)}
                {visibleView.requestId ? (
                  <>
                    {" "}
                    {t("shell.requestId")} <code>{visibleView.requestId}</code>
                  </>
                ) : null}
              </p>
              {visibleView.reloadToReauthenticate ? (
                <button type="button" onClick={() => window.location.reload()}>
                  {t("shell.reloadSignIn")}
                </button>
              ) : null}
            </>
          ) : null}
          <div className="profile-deletion__actions">
            <button
              type="button"
              disabled={pending}
              onClick={() => {
                returnFocusRef.current = true;
                setView({ tag: "closed" });
              }}
            >
              {t("shell.cancel")}
            </button>
            <button
              type="button"
              className="profile-deletion__danger"
              disabled={pending}
              onClick={() => void confirmDeletion()}
            >
              {pending ? t("shell.deleting") : t("shell.deletePermanently")}
            </button>
          </div>
        </section>
      ) : null}
    </div>
  );
}
