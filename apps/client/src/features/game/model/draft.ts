import {
  type Color,
  type PieceType,
  type Retraction,
  RetractionSchema,
  type Square,
} from "@a-move-ago/api-contract";
import {
  applyRetraction,
  type FenState,
  RetractionError,
  type RetractionErrorCode,
} from "@a-move-ago/game-core";

export type CapturePieceType = Exclude<PieceType, "k">;

export type DraftState =
  | { tag: "select-current" }
  | { tag: "select-previous"; currentSquare: Square }
  | {
      tag: "configure";
      currentSquare: Square;
      previousSquare: Square;
      special: Retraction["special"];
      captureType: CapturePieceType | null;
    };

export type DraftEvent =
  | { type: "select-square"; square: Square }
  | { type: "set-special"; special: Retraction["special"] }
  | { type: "set-capture"; pieceType: CapturePieceType | null }
  | { type: "reset" };

export const initialDraft: DraftState = { tag: "select-current" };

export function draftReducer(
  post: FenState,
  retractingColor: Color,
  state: DraftState,
  event: DraftEvent,
): DraftState {
  if (event.type === "reset") return initialDraft;
  if (event.type === "select-square") {
    if (state.tag === "select-current") {
      return post.board[event.square]?.color === retractingColor
        ? { tag: "select-previous", currentSquare: event.square }
        : state;
    }
    if (state.tag === "select-previous") {
      if (event.square === state.currentSquare || post.board[event.square]) return state;
      return {
        tag: "configure",
        currentSquare: state.currentSquare,
        previousSquare: event.square,
        special: "normal",
        captureType: null,
      };
    }
    return post.board[event.square]?.color === retractingColor
      ? { tag: "select-previous", currentSquare: event.square }
      : state;
  }
  if (state.tag !== "configure") return state;
  if (event.type === "set-capture") {
    if (state.special.startsWith("castle") || state.special === "en-passant") return state;
    return { ...state, captureType: event.pieceType };
  }
  if (event.type === "set-special") {
    return {
      ...state,
      special: event.special,
      captureType:
        event.special === "en-passant"
          ? "p"
          : event.special.startsWith("castle")
            ? null
            : state.captureType,
    };
  }
  return state;
}

function opponent(color: Color): Color {
  return color === "w" ? "b" : "w";
}

function restoreSquare(state: Extract<DraftState, { tag: "configure" }>): Square {
  return state.special === "en-passant"
    ? (`${state.currentSquare[0]}${state.previousSquare[1]}` as Square)
    : state.currentSquare;
}

export type DraftPreview =
  | { ok: true; retraction: Retraction; previous: FenState }
  | { ok: false; reason: string };

const retractionErrorMessage: Record<RetractionErrorCode, string> = {
  NO_PIECE_ON_CURRENT_SQUARE: "The selected piece is no longer on that square.",
  WRONG_COLOR: "Choose a piece belonging to the side that moved last.",
  PREVIOUS_SQUARE_OCCUPIED: "The square the piece came from must be empty.",
  RESTORE_SQUARE_OCCUPIED: "The captured piece cannot be restored on an occupied square.",
  INVALID_SPECIAL_MOVE: "That special move does not match the selected squares.",
};

export type DraftPreviewErrorCode =
  | RetractionErrorCode
  | "SELECT_SQUARES"
  | "CANNOT_RETRACT"
  | "INVALID_DETAILS"
  | "UNAVAILABLE";

const previewErrorMessage: Record<DraftPreviewErrorCode, string> = {
  ...retractionErrorMessage,
  SELECT_SQUARES: "Choose current and previous squares.",
  CANNOT_RETRACT: "The selected piece cannot be retracted.",
  INVALID_DETAILS: "The retraction details do not match the selected squares.",
  UNAVAILABLE: "This retraction cannot be previewed.",
};

export function buildPreview(
  post: FenState,
  retractingColor: Color,
  state: DraftState,
  formatError: (code: DraftPreviewErrorCode) => string = (code) => previewErrorMessage[code],
): DraftPreview {
  if (state.tag !== "configure") {
    return { ok: false, reason: formatError("SELECT_SQUARES") };
  }
  const movedPiece = post.board[state.currentSquare];
  if (!movedPiece || movedPiece.color !== retractingColor) {
    return { ok: false, reason: formatError("CANNOT_RETRACT") };
  }
  const restoredPiece = state.captureType
    ? { color: opponent(retractingColor), type: state.captureType, square: restoreSquare(state) }
    : null;
  const parsed = RetractionSchema.safeParse({
    currentSquare: state.currentSquare,
    previousSquare: state.previousSquare,
    movedPiece,
    restoredPiece,
    special: state.special,
  });
  if (!parsed.success) {
    return {
      ok: false,
      reason: formatError("INVALID_DETAILS"),
    };
  }
  const retraction = parsed.data;
  try {
    return { ok: true, retraction, previous: applyRetraction(post, retraction) };
  } catch (error) {
    return {
      ok: false,
      reason: formatError(error instanceof RetractionError ? error.code : "UNAVAILABLE"),
    };
  }
}
