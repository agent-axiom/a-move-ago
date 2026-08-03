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

export function applyRetraction(post: FenState, move: Retraction): FenState {
  const board = cloneBoard(post.board);
  const current = board[move.currentSquare];
  if (!current) throw new RetractionError("NO_PIECE_ON_CURRENT_SQUARE");
  if (current.color !== move.movedPiece.color || current.type !== move.movedPiece.type) {
    throw new RetractionError("WRONG_COLOR");
  }
  if (board[move.previousSquare]) throw new RetractionError("PREVIOUS_SQUARE_OCCUPIED");

  delete board[move.currentSquare];
  board[move.previousSquare] = current;

  if (move.restoredPiece) {
    if (board[move.restoredPiece.square]) throw new RetractionError("RESTORE_SQUARE_OCCUPIED");
    board[move.restoredPiece.square] = {
      color: move.restoredPiece.color,
      type: move.restoredPiece.type,
    };
  }
  return { ...post, board, turn: move.movedPiece.color };
}
