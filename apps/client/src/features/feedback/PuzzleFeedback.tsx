import { ApiError, type FeedbackReason, type PuzzleFeedbackRequest } from "@a-move-ago/api-contract";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useOverlayDismiss } from "../../app/overlays";
import { useRuntime } from "../../app/runtime";
import { useI18n } from "../../i18n";
import { feedbackMessages } from "../../i18n/messages/feedback";
import "./feedback.css";

const reasons = [
  "unclear_condition",
  "alternative_answer",
  "explanation_error",
  "other",
] as const satisfies readonly FeedbackReason[];

type View = "idle" | "sending" | "received" | "failed" | "rateLimited" | "unavailable" | "expired";

export function PuzzleFeedback({
  caseId,
  caseDate,
  puzzleId,
  puzzleVersion,
}: {
  caseId: string;
  caseDate: string;
  puzzleId: string;
  puzzleVersion: number;
}) {
  const runtime = useRuntime();
  const { locale, intlLocale } = useI18n();
  const copy = feedbackMessages[locale];
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<FeedbackReason | "">("");
  const [comment, setComment] = useState("");
  const [view, setView] = useState<View>("idle");
  const dialogRef = useRef<HTMLDialogElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const successRef = useRef<HTMLHeadingElement>(null);
  const requestRef = useRef<PuzzleFeedbackRequest | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const titleId = useId();
  const introductionId = useId();
  const commentId = useId();
  const privacyId = useId();
  const reasonName = useId();
  const pending = view === "sending";
  const failed = view !== "idle" && view !== "sending" && view !== "received";

  const close = useCallback(() => {
    if (controllerRef.current) {
      controllerRef.current.abort();
      controllerRef.current = null;
      setView("failed");
    }
    setOpen(false);
  }, []);
  useOverlayDismiss(close, open);

  useEffect(() => {
    if (!open) return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const previousFocus = document.activeElement;
    dialog.showModal();
    (successRef.current ?? headingRef.current)?.focus();
    return () => {
      dialog.close();
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) {
        previousFocus.focus();
      }
    };
  }, [open]);

  useEffect(() => {
    if (view === "received" && open) successRef.current?.focus();
  }, [open, view]);

  useEffect(() => () => controllerRef.current?.abort(), []);

  function changed() {
    setView("idle");
  }

  async function send() {
    if (!reason || controllerRef.current || view === "received") return;
    const trimmedComment = comment.trim();
    let request = requestRef.current;
    if (
      !request ||
      request.locale !== locale ||
      request.reason !== reason ||
      (request.comment ?? "") !== trimmedComment
    ) {
      request = {
        reportUuid: runtime.attemptUuid(),
        caseId,
        puzzleId,
        puzzleVersion,
        locale,
        reason,
        ...(trimmedComment ? { comment: trimmedComment } : {}),
      };
      requestRef.current = request;
    }
    const controller = new AbortController();
    controllerRef.current = controller;
    setView("sending");
    try {
      await runtime.api.submitPuzzleFeedback(request, controller.signal);
      if (controllerRef.current === controller && !controller.signal.aborted) setView("received");
    } catch (error) {
      if (controllerRef.current !== controller || controller.signal.aborted) return;
      setView(
        error instanceof ApiError && error.status === 429
          ? "rateLimited"
          : error instanceof ApiError && error.status === 404
            ? "unavailable"
            : error instanceof ApiError && error.status === 401
              ? "expired"
              : "failed",
      );
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null;
    }
  }

  const dateLabel = new Intl.DateTimeFormat(intlLocale, {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${caseDate}T00:00:00Z`));

  return (
    <div className="puzzle-feedback">
      <button className="button-quiet feedback-trigger" onClick={() => setOpen(true)} type="button">
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path d="M5 21V4m0 0c4-4 10 4 14 0v10c-4 4-10-4-14 0" />
        </svg>
        {view === "received" ? copy.successTitle : copy.trigger}
      </button>
      {open ? <dialog
        aria-labelledby={titleId}
        aria-describedby={introductionId}
        className="feedback-dialog"
        onCancel={(event) => {
          event.preventDefault();
          close();
        }}
        ref={dialogRef}
      >
        <header className="feedback-header">
          <div>
            <time className="eyebrow" dateTime={caseDate}>{dateLabel}</time>
            <h2 id={titleId} ref={headingRef} tabIndex={-1}>{copy.title}</h2>
          </div>
          <button aria-label={copy.close} className="button-quiet feedback-close" onClick={close} type="button">
            <span aria-hidden="true">×</span>
          </button>
        </header>
        <p id={introductionId} className="feedback-introduction">{copy.introduction}</p>
        {view === "received" ? (
          <div className="feedback-success" role="status">
            <span className="feedback-success-mark" aria-hidden="true">✓</span>
            <h3 ref={successRef} tabIndex={-1}>{copy.successTitle}</h3>
            <p>{copy.successBody}</p>
            <p className="feedback-reference">{copy.reference}: <code>{requestRef.current?.reportUuid}</code></p>
            <button className="button-primary" onClick={close} type="button">{copy.done}</button>
          </div>
        ) : (
          <form onSubmit={(event) => { event.preventDefault(); void send(); }}>
            <fieldset className="feedback-reasons" disabled={pending}>
              <legend>{copy.reason}</legend>
              {reasons.map((value) => (
                <label key={value}>
                  <input
                    checked={reason === value}
                    name={reasonName}
                    onChange={() => { setReason(value); changed(); }}
                    required
                    type="radio"
                    value={value}
                  />
                  <span>{copy[value]}</span>
                </label>
              ))}
            </fieldset>
            <div className="feedback-comment">
              <label htmlFor={commentId}>{copy.comment}</label>
              <textarea
                aria-describedby={privacyId}
                disabled={pending}
                id={commentId}
                maxLength={1000}
                onChange={(event) => { setComment(event.target.value); changed(); }}
                placeholder={copy.placeholder}
                rows={3}
                value={comment}
              />
              <span className="feedback-count" aria-hidden="true">{comment.length} / 1000</span>
            </div>
            <p className="feedback-privacy" id={privacyId}>{copy.privacy}</p>
            {failed ? <p className="feedback-error" role="alert">{copy[view]}</p> : null}
            <div className="feedback-actions">
              <button className="button-primary" disabled={!reason || pending} type="submit">
                {pending ? copy.sending : failed ? copy.retry : copy.send}
              </button>
              <button className="button-quiet" onClick={close} type="button">{copy.cancel}</button>
            </div>
          </form>
        )}
      </dialog> : null}
    </div>
  );
}
