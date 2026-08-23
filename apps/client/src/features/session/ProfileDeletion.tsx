import { ApiError } from "@a-move-ago/api-contract";
import { useEffect, useRef, useState } from "react";
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
          Telegram profile deleted. You are now playing as a guest.
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
        Delete Telegram profile
      </button>
      {expanded ? (
        <section
          id={confirmationId}
          className="profile-deletion__confirmation"
          aria-labelledby={headingId}
          aria-describedby={warningId}
        >
          <h2 ref={headingRef} id={headingId} tabIndex={-1}>
            Delete Telegram profile?
          </h2>
          <p id={warningId}>
            This permanently deletes your A MOVE AGO Telegram profile and all saved attempts, hints,
            and statistics on every device. It does not delete your Telegram account. This cannot be
            undone.
          </p>
          {pending ? <p role="status">Deleting Telegram profile…</p> : null}
          {visibleView.tag === "error" ? (
            <>
              <p role="alert">
                {visibleView.message}
                {visibleView.requestId ? (
                  <>
                    {" "}
                    Request ID: <code>{visibleView.requestId}</code>
                  </>
                ) : null}
              </p>
              {visibleView.reloadToReauthenticate ? (
                <button type="button" onClick={() => window.location.reload()}>
                  Reload to sign in again
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
              Cancel
            </button>
            <button
              type="button"
              className="profile-deletion__danger"
              disabled={pending}
              onClick={() => void confirmDeletion()}
            >
              {pending ? "Deleting…" : "Delete permanently"}
            </button>
          </div>
        </section>
      ) : null}
    </div>
  );
}
