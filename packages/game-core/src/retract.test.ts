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

function expectRetractionErrorCode(
  postFen: string,
  move: Parameters<typeof applyRetraction>[1],
  code: RetractionError["code"],
): void {
  let error: unknown;
  try {
    applyRetraction(parseFen(postFen), move);
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(RetractionError);
  expect(error).toMatchObject({ name: "RetractionError", code, message: code });
}

function cloneMove(
  move: Parameters<typeof applyRetraction>[1],
): Parameters<typeof applyRetraction>[1] {
  return {
    currentSquare: move.currentSquare,
    previousSquare: move.previousSquare,
    movedPiece: { ...move.movedPiece },
    restoredPiece: move.restoredPiece ? { ...move.restoredPiece } : null,
    special: move.special,
  };
}

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

  it("retracts castling for both colors and sides without mutating the post state", () => {
    const cases = [
      {
        postFen: "r3k2r/8/8/8/8/8/8/R4RK1 b kq - 1 1",
        move: {
          currentSquare: "g1",
          previousSquare: "e1",
          movedPiece: { color: "w", type: "k" },
          restoredPiece: null,
          special: "castle-kingside",
        },
        kingStart: "e1",
        rookStart: "h1",
        rookPost: "f1",
      },
      {
        postFen: "4k3/8/8/8/8/8/8/2KR4 b - - 0 1",
        move: {
          currentSquare: "c1",
          previousSquare: "e1",
          movedPiece: { color: "w", type: "k" },
          restoredPiece: null,
          special: "castle-queenside",
        },
        kingStart: "e1",
        rookStart: "a1",
        rookPost: "d1",
      },
      {
        postFen: "5rk1/8/8/8/8/8/8/4K3 w - - 0 1",
        move: {
          currentSquare: "g8",
          previousSquare: "e8",
          movedPiece: { color: "b", type: "k" },
          restoredPiece: null,
          special: "castle-kingside",
        },
        kingStart: "e8",
        rookStart: "h8",
        rookPost: "f8",
      },
      {
        postFen: "2kr4/8/8/8/8/8/8/4K3 w - - 0 1",
        move: {
          currentSquare: "c8",
          previousSquare: "e8",
          movedPiece: { color: "b", type: "k" },
          restoredPiece: null,
          special: "castle-queenside",
        },
        kingStart: "e8",
        rookStart: "a8",
        rookPost: "d8",
      },
    ] as const;

    for (const testCase of cases) {
      const post = parseFen(testCase.postFen);
      const snapshot = JSON.parse(JSON.stringify(post));
      const move = cloneMove(testCase.move);
      const moveSnapshot = JSON.parse(JSON.stringify(move));
      const prior = applyRetraction(post, move);

      expect(prior.board[testCase.kingStart]).toEqual(move.movedPiece);
      expect(prior.board[testCase.rookStart]).toEqual({
        color: move.movedPiece.color,
        type: "r",
      });
      expect(prior.board[testCase.rookPost]).toBeUndefined();

      if (move.movedPiece.color === "w" && move.special === "castle-kingside") {
        const king = prior.board.e1;
        const rook = prior.board.h1;
        if (!king || !rook) throw new Error("expected castled pieces to be present");
        king.type = "q";
        rook.type = "n";
        expect(post).toEqual(snapshot);
        expect(move).toEqual(moveSnapshot);

        move.movedPiece.type = "n";
        expect(prior.board.e1).toEqual({ color: "w", type: "q" });
      }
    }
  });

  it("rejects invalid castling metadata and board state", () => {
    const cases: Array<{
      postFen: string;
      move: Parameters<typeof applyRetraction>[1];
    }> = [
      {
        postFen: "4k3/8/8/8/8/8/8/5RK1 b - - 0 1",
        move: {
          currentSquare: "g1",
          previousSquare: "d1",
          movedPiece: { color: "w", type: "k" },
          restoredPiece: null,
          special: "castle-kingside",
        },
      },
      {
        postFen: "4k3/8/8/8/8/8/8/6K1 b - - 0 1",
        move: {
          currentSquare: "g1",
          previousSquare: "e1",
          movedPiece: { color: "w", type: "k" },
          restoredPiece: null,
          special: "castle-kingside",
        },
      },
      {
        postFen: "4k3/8/8/8/8/8/8/5NK1 b - - 0 1",
        move: {
          currentSquare: "g1",
          previousSquare: "e1",
          movedPiece: { color: "w", type: "k" },
          restoredPiece: null,
          special: "castle-kingside",
        },
      },
      {
        postFen: "4k3/8/8/8/8/8/8/5rK1 b - - 0 1",
        move: {
          currentSquare: "g1",
          previousSquare: "e1",
          movedPiece: { color: "w", type: "k" },
          restoredPiece: null,
          special: "castle-kingside",
        },
      },
      {
        postFen: "4k3/8/8/8/8/8/8/R1KR4 b - - 0 1",
        move: {
          currentSquare: "c1",
          previousSquare: "e1",
          movedPiece: { color: "w", type: "k" },
          restoredPiece: null,
          special: "castle-queenside",
        },
      },
    ];

    for (const testCase of cases) {
      expectRetractionErrorCode(testCase.postFen, testCase.move, "INVALID_SPECIAL_MOVE");
    }
  });

  it("retracts en passant for both colors without mutating the post state", () => {
    const cases = [
      {
        postFen: "4k3/8/3P4/8/8/8/8/4K3 b - - 0 1",
        move: {
          currentSquare: "d6",
          previousSquare: "e5",
          movedPiece: { color: "w", type: "p" },
          restoredPiece: { color: "b", type: "p", square: "d5" },
          special: "en-passant",
        },
      },
      {
        postFen: "4k3/8/8/8/8/3p4/8/4K3 w - - 0 1",
        move: {
          currentSquare: "d3",
          previousSquare: "e4",
          movedPiece: { color: "b", type: "p" },
          restoredPiece: { color: "w", type: "p", square: "d4" },
          special: "en-passant",
        },
      },
    ] as const;

    for (const testCase of cases) {
      const post = parseFen(testCase.postFen);
      const snapshot = JSON.parse(JSON.stringify(post));
      const move = cloneMove(testCase.move);
      const moveSnapshot = JSON.parse(JSON.stringify(move));
      const prior = applyRetraction(post, move);

      if (!move.restoredPiece) throw new Error("expected en-passant restoration");
      expect(prior.board[move.previousSquare]).toEqual(move.movedPiece);
      expect(prior.board[move.restoredPiece.square]).toEqual({
        color: move.restoredPiece.color,
        type: "p",
      });

      if (move.movedPiece.color === "w") {
        const pawn = prior.board.e5;
        const restoredPawn = prior.board.d5;
        if (!pawn || !restoredPawn) throw new Error("expected en-passant pieces to be present");
        pawn.type = "q";
        restoredPawn.type = "n";
        expect(post).toEqual(snapshot);
        expect(move).toEqual(moveSnapshot);

        move.movedPiece.type = "b";
        move.restoredPiece.type = "r";
        expect(prior.board.e5).toEqual({ color: "w", type: "q" });
        expect(prior.board.d5).toEqual({ color: "b", type: "n" });
      }
    }
  });

  it("rejects invalid en-passant restored pieces before restore-square collisions", () => {
    const cases: Array<{
      postFen: string;
      move: Parameters<typeof applyRetraction>[1];
      code: RetractionError["code"];
    }> = [
      {
        postFen: "4k3/8/3P4/8/8/8/8/4K3 b - - 0 1",
        move: {
          currentSquare: "d6",
          previousSquare: "e5",
          movedPiece: { color: "w", type: "p" },
          restoredPiece: null,
          special: "en-passant",
        },
        code: "INVALID_SPECIAL_MOVE",
      },
      {
        postFen: "4k3/8/3P4/8/8/8/8/4K3 b - - 0 1",
        move: {
          currentSquare: "d6",
          previousSquare: "e5",
          movedPiece: { color: "w", type: "p" },
          restoredPiece: { color: "b", type: "n", square: "d5" },
          special: "en-passant",
        },
        code: "INVALID_SPECIAL_MOVE",
      },
      {
        postFen: "4k3/8/3P4/3r4/8/8/8/4K3 b - - 0 1",
        move: {
          currentSquare: "d6",
          previousSquare: "e5",
          movedPiece: { color: "w", type: "p" },
          restoredPiece: { color: "b", type: "p", square: "d5" },
          special: "en-passant",
        },
        code: "RESTORE_SQUARE_OCCUPIED",
      },
      {
        postFen: "4k3/8/3P4/3r4/8/8/8/4K3 b - - 0 1",
        move: {
          currentSquare: "d6",
          previousSquare: "e5",
          movedPiece: { color: "w", type: "p" },
          restoredPiece: { color: "b", type: "n", square: "d5" },
          special: "en-passant",
        },
        code: "INVALID_SPECIAL_MOVE",
      },
    ];

    for (const testCase of cases) {
      expectRetractionErrorCode(testCase.postFen, testCase.move, testCase.code);
    }
  });

  it("retracts quiet and capture unpromotions without mutating the post state", () => {
    const cases = [
      {
        postFen: "Q3k3/8/8/8/8/8/8/4K3 b - - 0 1",
        move: {
          currentSquare: "a8",
          previousSquare: "a7",
          movedPiece: { color: "w", type: "q" },
          restoredPiece: null,
          special: "unpromotion",
        },
      },
      {
        postFen: "4k3/8/8/8/8/8/8/q3K3 w - - 0 1",
        move: {
          currentSquare: "a1",
          previousSquare: "a2",
          movedPiece: { color: "b", type: "q" },
          restoredPiece: null,
          special: "unpromotion",
        },
      },
      {
        postFen: "k2Q4/8/8/8/8/8/8/4K3 b - - 0 1",
        move: {
          currentSquare: "d8",
          previousSquare: "c7",
          movedPiece: { color: "w", type: "q" },
          restoredPiece: { color: "b", type: "r", square: "d8" },
          special: "unpromotion",
        },
      },
    ] as const;

    for (const testCase of cases) {
      const post = parseFen(testCase.postFen);
      const snapshot = JSON.parse(JSON.stringify(post));
      const move = cloneMove(testCase.move);
      const moveSnapshot = JSON.parse(JSON.stringify(move));
      const prior = applyRetraction(post, move);

      expect(prior.board[move.previousSquare]).toEqual({
        color: move.movedPiece.color,
        type: "p",
      });
      if (move.restoredPiece) {
        expect(prior.board[move.restoredPiece.square]).toEqual({
          color: move.restoredPiece.color,
          type: move.restoredPiece.type,
        });
        const pawn = prior.board.c7;
        const restoredPiece = prior.board.d8;
        if (!pawn || !restoredPiece)
          throw new Error("expected unpromotion capture pieces to be present");
        pawn.type = "q";
        restoredPiece.type = "n";
        expect(post).toEqual(snapshot);
        expect(move).toEqual(moveSnapshot);

        move.movedPiece.type = "b";
        move.restoredPiece.type = "q";
        expect(prior.board.c7).toEqual({ color: "w", type: "q" });
        expect(prior.board.d8).toEqual({ color: "b", type: "n" });
      }
    }
  });

  it("rejects unpromotions from invalid prior ranks and piece types", () => {
    const cases: Array<{
      postFen: string;
      move: Parameters<typeof applyRetraction>[1];
    }> = [
      {
        postFen: "Q3k3/8/8/8/8/8/8/4K3 b - - 0 1",
        move: {
          currentSquare: "a8",
          previousSquare: "a6",
          movedPiece: { color: "w", type: "q" },
          restoredPiece: null,
          special: "unpromotion",
        },
      },
      {
        postFen: "4k3/8/8/8/8/8/8/q3K3 w - - 0 1",
        move: {
          currentSquare: "a1",
          previousSquare: "a3",
          movedPiece: { color: "b", type: "q" },
          restoredPiece: null,
          special: "unpromotion",
        },
      },
      {
        postFen: "4k3/8/P7/8/8/8/8/4K3 b - - 0 1",
        move: {
          currentSquare: "a6",
          previousSquare: "a7",
          movedPiece: { color: "w", type: "p" },
          restoredPiece: null,
          special: "unpromotion",
        },
      },
      {
        postFen: "6K1/8/8/8/8/8/8/k7 b - - 0 1",
        move: {
          currentSquare: "g8",
          previousSquare: "g7",
          movedPiece: { color: "w", type: "k" },
          restoredPiece: null,
          special: "unpromotion",
        },
      },
    ];

    for (const testCase of cases) {
      expectRetractionErrorCode(testCase.postFen, testCase.move, "INVALID_SPECIAL_MOVE");
    }
  });
});
