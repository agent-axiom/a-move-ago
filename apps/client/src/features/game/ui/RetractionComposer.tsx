import type { Color, Retraction } from "@a-move-ago/api-contract";
import { type FenState, serializeFen } from "@a-move-ago/game-core";
import { type ReactNode, useReducer, useState } from "react";
import { useI18n } from "../../../i18n";
import { buildPreview, type CapturePieceType, draftReducer, initialDraft } from "../model/draft";
import { Chessboard } from "./Chessboard";

const captureOptions: ReadonlyArray<CapturePieceType> = ["p", "n", "b", "r", "q"];

interface RetractionComposerProps {
  post: FenState;
  retractingColor: Color;
  disabled: boolean;
  children?: ReactNode;
  feedback?: ReactNode;
  onSubmit(retraction: Retraction): void;
}

export function RetractionComposer(props: RetractionComposerProps) {
  const positionKey = `${serializeFen(props.post)}:${props.retractingColor}`;
  return <RetractionComposerForm {...props} key={positionKey} />;
}

function RetractionComposerForm(props: RetractionComposerProps) {
  const { t } = useI18n();
  const [draft, dispatch] = useReducer(
    (
      state: typeof initialDraft | ReturnType<typeof draftReducer>,
      event: Parameters<typeof draftReducer>[3],
    ) => draftReducer(props.post, props.retractingColor, state, event),
    initialDraft,
  );
  const [view, setView] = useState<"now" | "before">("now");
  const preview = buildPreview(props.post, props.retractingColor, draft, (code) =>
    t(`game.preview.${code}`),
  );
  const showingPreview = view === "before" && preview.ok;
  const selectedSquare = draft.tag === "select-current" ? null : draft.currentSquare;
  const previousSquare = draft.tag === "configure" ? draft.previousSquare : null;
  const step = draft.tag === "select-current" ? 1 : draft.tag === "select-previous" ? 2 : 3;
  const instruction =
    step === 1
      ? t("game.instruction.piece")
      : step === 2
        ? t("game.instruction.square")
        : t("game.instruction.details");

  return (
    <section className="retraction-workspace" aria-labelledby="retraction-heading">
      <div className="clue-panel">{props.children}</div>
      <div className="board-panel">
        <div className="board-toolbar">
          <span className="last-move-label">
            <span className={`side-marker side-marker-${props.retractingColor}`} />
            {t(`game.lastMove.${props.retractingColor}`)}
          </span>
          <fieldset className="board-view-switch" aria-label={t("game.boardView")}>
            <button type="button" aria-pressed={!showingPreview} onClick={() => setView("now")}>
              {t("game.now")}
            </button>
            <button
              type="button"
              aria-pressed={showingPreview}
              disabled={!preview.ok}
              onClick={() => setView("before")}
            >
              {t("game.before")}
            </button>
          </fieldset>
        </div>
        <Chessboard
          board={showingPreview && preview.ok ? preview.previous.board : props.post.board}
          disabled={props.disabled || showingPreview}
          destinationSquare={previousSquare}
          label={showingPreview ? t("game.board.preview") : t("game.board.interactive")}
          onSelect={(square) => dispatch({ type: "select-square", square })}
          orientation={props.retractingColor === "w" ? "white" : "black"}
          selectedSquare={selectedSquare}
        />
        <p className="board-caption" aria-live="polite">
          {showingPreview ? t("game.preview.caption") : instruction}
        </p>
      </div>
      <div className="retraction-panel">
        <div className="composer-heading">
          <p className="game-eyebrow">{t("game.reverseEyebrow")}</p>
          <h2 id="retraction-heading">{t("game.reconstruct")}</h2>
        </div>
        <ol className="retraction-steps" aria-label={t("game.steps")}>
          {(["game.step.piece", "game.step.square", "game.step.details"] as const).map(
            (label, index) => (
              <li
                aria-current={step === index + 1 ? "step" : undefined}
                className={step > index + 1 ? "step-complete" : ""}
                key={label}
              >
                <span aria-hidden="true" className="step-number">
                  {index + 1}
                </span>
                <span>{t(label)}</span>
              </li>
            ),
          )}
        </ol>
        <p className="composer-instruction">{instruction}</p>
        {draft.tag === "configure" ? (
          <output className="move-summary" aria-label={t("game.selected")}>
            <span>{draft.currentSquare}</span>
            <span aria-hidden="true" className="move-arrow">
              →
            </span>
            <span className="sr-only">{t("game.backTo")}</span>
            <span>{draft.previousSquare}</span>
            <small>{t("game.oneMoveAgo")}</small>
          </output>
        ) : null}
        <fieldset
          className="retraction-details"
          disabled={props.disabled || draft.tag !== "configure"}
        >
          <legend>{t("game.details")}</legend>
          <label>
            {t("game.special")}
            <select
              aria-label={t("game.special")}
              onChange={(event) =>
                dispatch({
                  type: "set-special",
                  special: event.currentTarget.value as Retraction["special"],
                })
              }
              value={draft.tag === "configure" ? draft.special : "normal"}
            >
              <option value="normal">{t("game.special.normal")}</option>
              <option value="castle-kingside">{t("game.special.kingside")}</option>
              <option value="castle-queenside">{t("game.special.queenside")}</option>
              <option value="en-passant">{t("game.special.enPassant")}</option>
              <option value="unpromotion">{t("game.special.unpromotion")}</option>
            </select>
          </label>
          <label>
            {t("game.captured")}
            <select
              aria-label={t("game.captured")}
              disabled={
                props.disabled ||
                draft.tag !== "configure" ||
                draft.special.startsWith("castle") ||
                draft.special === "en-passant"
              }
              onChange={(event) =>
                dispatch({
                  type: "set-capture",
                  pieceType:
                    event.currentTarget.value === ""
                      ? null
                      : (event.currentTarget.value as CapturePieceType),
                })
              }
              value={draft.tag === "configure" ? (draft.captureType ?? "") : ""}
            >
              <option value="">{t("game.none")}</option>
              {captureOptions.map((option) => (
                <option key={option} value={option}>
                  {t(`game.capture.${option}`)}
                </option>
              ))}
            </select>
          </label>
        </fieldset>
        <p className="move-details-help">
          {t("game.promotionHelp.before")}
          <strong>{t("game.special.unpromotion")}</strong>
          {t("game.promotionHelp.after")}
        </p>
        {!preview.ok && draft.tag === "configure" ? (
          <p className="composer-error" role="alert">
            {preview.reason}
          </p>
        ) : null}
        <div className="composer-actions">
          <button
            className="button-primary"
            type="button"
            disabled={props.disabled || !preview.ok}
            onClick={() => {
              if (preview.ok) props.onSubmit(preview.retraction);
            }}
          >
            {t("game.check")}
          </button>
          <button
            className="button-quiet"
            type="button"
            disabled={props.disabled || draft.tag === "select-current"}
            onClick={() => {
              dispatch({ type: "reset" });
              setView("now");
            }}
          >
            {t("game.reset")}
          </button>
        </div>
        {props.feedback}
      </div>
    </section>
  );
}
