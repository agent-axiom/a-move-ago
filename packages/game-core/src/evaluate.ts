import type { AcceptedSolution, PuzzlePrivate, Retraction } from "@a-move-ago/api-contract";
import { Chess, validateFen } from "chess.js";
import { type FenState, parseFen, serializeFen } from "./fen";
import { applyRetraction, RetractionError, type RetractionErrorCode } from "./retract";

type ContradictionCode = RetractionErrorCode | "OPPONENT_KING_IN_CHECK" | "NOT_THE_LAST_MOVE";

const defaultMessages: Record<ContradictionCode, string> = {
  NO_PIECE_ON_CURRENT_SQUARE: "There is no piece to move back from that square.",
  WRONG_COLOR: "That piece could not have made the last move.",
  PREVIOUS_SQUARE_OCCUPIED: "The proposed previous square was occupied.",
  RESTORE_SQUARE_OCCUPIED: "The captured piece cannot be restored on an occupied square.",
  INVALID_SPECIAL_MOVE: "That special move cannot be retracted from this position.",
  OPPONENT_KING_IN_CHECK: "The previous position leaves the side not to move in check.",
  NOT_THE_LAST_MOVE: "The position is legal, but the evidence does not support that last move.",
};

export type EvaluationResult =
  | { correct: true; reveal: AcceptedSolution }
  | { correct: false; contradiction: { code: ContradictionCode; message: string } };

function contradiction(puzzle: PuzzlePrivate, code: ContradictionCode): EvaluationResult {
  return {
    correct: false,
    contradiction: {
      code,
      message: puzzle.contradictionExplanations[code] ?? defaultMessages[code],
    },
  };
}

function retractionKey(retraction: Retraction): string {
  return JSON.stringify({
    currentSquare: retraction.currentSquare,
    previousSquare: retraction.previousSquare,
    movedPiece: {
      color: retraction.movedPiece.color,
      type: retraction.movedPiece.type,
    },
    restoredPiece: retraction.restoredPiece
      ? {
          color: retraction.restoredPiece.color,
          type: retraction.restoredPiece.type,
          square: retraction.restoredPiece.square,
        }
      : null,
    special: retraction.special,
  });
}

function reconstructedFen(previous: FenState, retraction: Retraction): string {
  const opponent: FenState["turn"] = retraction.movedPiece.color === "w" ? "b" : "w";
  return serializeFen({ ...previous, turn: opponent });
}

export function evaluateRetraction(
  puzzle: PuzzlePrivate,
  retraction: Retraction,
): EvaluationResult {
  const post = parseFen(puzzle.public.postFen);
  let previous: FenState;
  try {
    previous = applyRetraction(post, retraction);
  } catch (error) {
    if (error instanceof RetractionError) return contradiction(puzzle, error.code);
    throw error;
  }

  const priorFen = reconstructedFen(previous, retraction);
  if (!validateFen(priorFen).ok) {
    return contradiction(puzzle, "INVALID_SPECIAL_MOVE");
  }
  if (new Chess(priorFen).isCheck()) return contradiction(puzzle, "OPPONENT_KING_IN_CHECK");

  const key = retractionKey(retraction);
  const accepted = puzzle.acceptedSolutions.find(
    (solution) => retractionKey(solution.retraction) === key,
  );
  return accepted
    ? { correct: true, reveal: structuredClone(accepted) }
    : contradiction(puzzle, "NOT_THE_LAST_MOVE");
}

export function replayAcceptedSolution(puzzle: PuzzlePrivate, solution: AcceptedSolution): string {
  let game: Chess;
  try {
    game = new Chess(solution.previousFen);
  } catch (error) {
    throw new Error(
      `Invalid previousFen: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const move = (() => {
    try {
      return game.move({
        from: solution.retraction.previousSquare,
        to: solution.retraction.currentSquare,
        ...(solution.retraction.special === "unpromotion"
          ? { promotion: solution.retraction.movedPiece.type }
          : {}),
      });
    } catch (error) {
      throw new Error(
        `Forward replay mismatch: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  })();

  if (move.san !== solution.forwardSan) {
    throw new Error(`forwardSan mismatch: expected ${solution.forwardSan}, got ${move.san}`);
  }
  const afterFen = game.fen();
  if (afterFen !== puzzle.public.postFen) {
    throw new Error(`Forward replay mismatch: expected ${puzzle.public.postFen}, got ${afterFen}`);
  }
  return afterFen;
}
