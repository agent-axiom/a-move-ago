import { describe, expect, it } from "vitest";
import { applyRetraction, parseFen, RetractionError } from "./index";

const postFen = "rnbqkbnr/ppp1pppp/8/3P4/8/8/PPPP1PPP/RNBQKBNR b KQkq - 0 2";
const capture = {
  currentSquare: "d5",
  previousSquare: "e4",
  movedPiece: { color: "w", type: "p" },
  restoredPiece: { color: "b", type: "p", square: "d5" },
  special: "normal",
} as const;

describe("applyRetraction", () => {
  it("reconstructs capture and quiet moves without mutating the post state", () => {
    const post = parseFen(postFen);
    const snapshot = JSON.parse(JSON.stringify(post));
    const prior = applyRetraction(post, capture);

    expect(prior.board.e4).toEqual({ color: "w", type: "p" });
    expect(prior.board.d5).toEqual({ color: "b", type: "p" });
    expect(prior.turn).toBe("w");
    expect(prior.castling).toBe(post.castling);
    expect(prior.enPassant).toBe(post.enPassant);
    expect(prior.halfmove).toBe(post.halfmove);
    expect(prior.fullmove).toBe(post.fullmove);
    expect(post).toEqual(snapshot);

    const movedPiece = prior.board.e4;
    const unaffectedPiece = prior.board.a8;
    if (!movedPiece || !unaffectedPiece) throw new Error("expected pieces to be present");
    movedPiece.type = "q";
    unaffectedPiece.type = "p";
    expect(post.board.d5).toEqual({ color: "w", type: "p" });
    expect(post.board.a8).toEqual({ color: "b", type: "r" });

    const quiet = applyRetraction(parseFen(postFen), { ...capture, restoredPiece: null });
    expect(quiet.board.e4).toEqual({ color: "w", type: "p" });
    expect(quiet.board.d5).toBeUndefined();
  });
  it("reports implemented errors in precedence order", () => {
    const cases = [
      {
        move: {
          ...capture,
          currentSquare: "e5",
          previousSquare: "d2",
          movedPiece: { color: "b", type: "p" },
        },
        code: "NO_PIECE_ON_CURRENT_SQUARE",
      },
      {
        move: { ...capture, previousSquare: "d2", movedPiece: { color: "b", type: "p" } },
        code: "WRONG_COLOR",
      },
      {
        move: { ...capture, previousSquare: "d2" },
        code: "PREVIOUS_SQUARE_OCCUPIED",
      },
      {
        move: { ...capture, restoredPiece: { color: "b", type: "p", square: "a8" } },
        code: "RESTORE_SQUARE_OCCUPIED",
      },
    ] as const;

    for (const { move, code } of cases) {
      let error: unknown;
      try {
        applyRetraction(parseFen(postFen), move);
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(RetractionError);
      expect(error).toMatchObject({ name: "RetractionError", code, message: code });
    }
  });
});
