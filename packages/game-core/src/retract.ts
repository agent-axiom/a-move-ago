import type { Piece, Retraction, Square } from "@a-move-ago/api-contract";
import type { Board, FenState } from "./fen";

export type RetractionErrorCode =
  | "NO_PIECE_ON_CURRENT_SQUARE"
  | "WRONG_COLOR"
  | "PREVIOUS_SQUARE_OCCUPIED"
  | "RESTORE_SQUARE_OCCUPIED"
  | "INVALID_SPECIAL_MOVE";

export class RetractionError extends Error {
  constructor(readonly code: RetractionErrorCode) {
    super(code);
    this.name = "RetractionError";
  }
}

function cloneBoard(board: Board): Board {
  const copy: Board = {};
  for (const [square, piece] of Object.entries(board) as [Square, Piece][]) {
    copy[square] = { ...piece };
  }
  return copy;
}

function retractCastle(board: FenState["board"], move: Retraction): void {
  const rank = move.movedPiece.color === "w" ? "1" : "8";
  const kingSide = move.special === "castle-kingside";
  const expectedCurrent = `${kingSide ? "g" : "c"}${rank}`;
  const expectedPrevious = `e${rank}`;
  const rookCurrent = `${kingSide ? "f" : "d"}${rank}` as keyof typeof board;
  const rookPrevious = `${kingSide ? "h" : "a"}${rank}` as keyof typeof board;
  if (move.currentSquare !== expectedCurrent || move.previousSquare !== expectedPrevious) {
    throw new RetractionError("INVALID_SPECIAL_MOVE");
  }
  const rook = board[rookCurrent];
  if (rook?.type !== "r" || rook.color !== move.movedPiece.color || board[rookPrevious]) {
    throw new RetractionError("INVALID_SPECIAL_MOVE");
  }
  delete board[rookCurrent];
  board[rookPrevious] = rook;
}

function priorMovedPiece(move: Retraction) {
  if (move.special !== "unpromotion") return { ...move.movedPiece };
  const targetRank = move.movedPiece.color === "w" ? "7" : "2";
  if (
    !move.previousSquare.endsWith(targetRank) ||
    move.movedPiece.type === "p" ||
    move.movedPiece.type === "k"
  ) {
    throw new RetractionError("INVALID_SPECIAL_MOVE");
  }
  return { color: move.movedPiece.color, type: "p" as const };
}

export function applyRetraction(post: FenState, move: Retraction): FenState {
  const board = cloneBoard(post.board);
  const current = board[move.currentSquare];
  if (!current) throw new RetractionError("NO_PIECE_ON_CURRENT_SQUARE");
  if (current.color !== move.movedPiece.color || current.type !== move.movedPiece.type) {
    throw new RetractionError("WRONG_COLOR");
  }
  if (board[move.previousSquare]) throw new RetractionError("PREVIOUS_SQUARE_OCCUPIED");

  delete board[move.currentSquare];
  board[move.previousSquare] = priorMovedPiece(move);
  if (move.special === "castle-kingside" || move.special === "castle-queenside") {
    retractCastle(board, move);
  }
  if (move.special === "en-passant" && move.restoredPiece?.type !== "p") {
    throw new RetractionError("INVALID_SPECIAL_MOVE");
  }

  if (move.restoredPiece) {
    if (board[move.restoredPiece.square]) throw new RetractionError("RESTORE_SQUARE_OCCUPIED");
    board[move.restoredPiece.square] = {
      color: move.restoredPiece.color,
      type: move.restoredPiece.type,
    };
  }
  return { ...post, board, turn: move.movedPiece.color };
}
