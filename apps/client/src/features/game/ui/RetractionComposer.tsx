import type { Color, Retraction } from "@a-move-ago/api-contract";
import { type FenState, serializeFen } from "@a-move-ago/game-core";
import { useReducer } from "react";
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
  const preview = buildPreview(props.post, props.retractingColor, draft);
  const board = preview.ok ? preview.previous.board : props.post.board;
  const selectedSquare = draft.tag === "select-current" ? null : draft.currentSquare;
  const instruction =
    draft.tag === "select-current"
      ? "Choose the piece that moved last."
      : draft.tag === "select-previous"
        ? "Choose the square it came from."
        : "Add a captured piece or special move, then submit.";

  return (
    <section aria-labelledby="retraction-heading">
      <h2 id="retraction-heading">Reconstruct the previous position</h2>
      <p aria-live="polite">{instruction}</p>
      <Chessboard
        board={board}
        disabled={props.disabled}
        label="Interactive retraction board"
        onSelect={(square) => dispatch({ type: "select-square", square })}
        orientation={props.retractingColor === "w" ? "white" : "black"}
        selectedSquare={selectedSquare}
      />
      {draft.tag === "configure" ? (
        <fieldset disabled={props.disabled}>
          <legend>Retraction details</legend>
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
              value={draft.special}
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
              value={draft.captureType ?? ""}
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
      ) : null}
      {!preview.ok && draft.tag === "configure" ? <p role="alert">{preview.reason}</p> : null}
      <div>
        <button type="button" disabled={props.disabled} onClick={() => dispatch({ type: "reset" })}>
          Reset
        </button>
        <button
          type="button"
          disabled={props.disabled || !preview.ok}
          onClick={() => {
            if (preview.ok) props.onSubmit(preview.retraction);
          }}
        >
          Submit retraction
        </button>
      </div>
    </section>
  );
}
