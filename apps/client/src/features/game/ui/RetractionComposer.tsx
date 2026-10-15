import type { Color, Retraction } from "@a-move-ago/api-contract";
import { type FenState, serializeFen } from "@a-move-ago/game-core";
import { type ReactNode, useReducer, useState } from "react";
import { buildPreview, type CapturePieceType, draftReducer, initialDraft } from "../model/draft";
import { Chessboard } from "./Chessboard";

const captureOptions: ReadonlyArray<{ value: CapturePieceType; label: string }> = [
  { value: "p", label: "Pawn" },
  { value: "n", label: "Knight" },
  { value: "b", label: "Bishop" },
  { value: "r", label: "Rook" },
  { value: "q", label: "Queen" },
];

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
  const [draft, dispatch] = useReducer(
    (
      state: typeof initialDraft | ReturnType<typeof draftReducer>,
      event: Parameters<typeof draftReducer>[3],
    ) => draftReducer(props.post, props.retractingColor, state, event),
    initialDraft,
  );
  const [view, setView] = useState<"now" | "before">("now");
  const preview = buildPreview(props.post, props.retractingColor, draft);
  const showingPreview = view === "before" && preview.ok;
  const selectedSquare = draft.tag === "select-current" ? null : draft.currentSquare;
  const previousSquare = draft.tag === "configure" ? draft.previousSquare : null;
  const step = draft.tag === "select-current" ? 1 : draft.tag === "select-previous" ? 2 : 3;
  const instruction =
    step === 1
      ? "Choose the piece that moved last."
      : step === 2
        ? "Choose the square it came from."
        : "Add any capture or special move, then check your reconstruction.";

  return (
    <section className="retraction-workspace" aria-labelledby="retraction-heading">
      <div className="board-panel">
        <div className="board-toolbar">
          <span className="last-move-label">
            <span className={`side-marker side-marker-${props.retractingColor}`} />
            {props.retractingColor === "w" ? "White" : "Black"} moved last
          </span>
          <div className="board-view-switch" role="group" aria-label="Board view">
            <button
              type="button"
              aria-pressed={!showingPreview}
              onClick={() => setView("now")}
            >
              Now
            </button>
            <button
              type="button"
              aria-pressed={showingPreview}
              disabled={!preview.ok}
              onClick={() => setView("before")}
            >
              Before
            </button>
          </div>
        </div>
        <Chessboard
          board={showingPreview && preview.ok ? preview.previous.board : props.post.board}
          disabled={props.disabled || showingPreview}
          destinationSquare={previousSquare}
          label={
            showingPreview ? "Your reconstruction, read-only preview" : "Interactive retraction board"
          }
          onSelect={(square) => dispatch({ type: "select-square", square })}
          orientation={props.retractingColor === "w" ? "white" : "black"}
          selectedSquare={selectedSquare}
        />
        <p className="board-caption">
          {showingPreview
            ? "Your reconstruction · switch to Now to edit"
            : "The position after the last move · tap a piece to begin"}
        </p>
      </div>
      <div className="retraction-panel">
        {props.children}
        <div className="composer-heading">
          <p className="game-eyebrow">Your move, in reverse</p>
          <h2 id="retraction-heading">Reconstruct the move</h2>
        </div>
        <ol className="retraction-steps" aria-label="Reconstruction steps">
          {["Choose a piece", "Choose its previous square", "Add the details"].map((label, index) => (
            <li
              aria-current={step === index + 1 ? "step" : undefined}
              className={step > index + 1 ? "step-complete" : ""}
              key={label}
            >
              <span aria-hidden="true" className="step-number">{index + 1}</span>
              <span>{label}</span>
            </li>
          ))}
        </ol>
        <p className="composer-instruction" aria-live="polite">{instruction}</p>
        {draft.tag === "configure" ? (
          <div className="move-summary" aria-label="Selected retraction">
            <span>{draft.currentSquare}</span>
            <span aria-hidden="true" className="move-arrow">→</span>
            <span className="sr-only">back to</span>
            <span>{draft.previousSquare}</span>
            <small>one move ago</small>
          </div>
        ) : null}
        <fieldset className="retraction-details" disabled={props.disabled || draft.tag !== "configure"}>
          <legend>Move details</legend>
          <label>
            Special move
            <select
              aria-label="Special move"
              onChange={(event) =>
                dispatch({
                  type: "set-special",
                  special: event.currentTarget.value as Retraction["special"],
                })
              }
              value={draft.tag === "configure" ? draft.special : "normal"}
            >
              <option value="normal">Normal move</option>
              <option value="castle-kingside">Castle kingside</option>
              <option value="castle-queenside">Castle queenside</option>
              <option value="en-passant">En passant</option>
              <option value="unpromotion">Reverse promotion</option>
            </select>
          </label>
          <label>
            Captured piece
            <select
              aria-label="Captured piece"
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
              value={draft.tag === "configure" ? draft.captureType ?? "" : ""}
            >
              <option value="">None</option>
              {captureOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        </fieldset>
        <p className="move-details-help">
          Undoing a promotion? Choose <strong>Reverse promotion</strong> to turn the piece back into a pawn.
        </p>
        {!preview.ok && draft.tag === "configure" ? (
          <p className="composer-error" role="alert">{preview.reason}</p>
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
            Check move
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
            Reset
          </button>
        </div>
        {props.feedback}
      </div>
    </section>
  );
}
