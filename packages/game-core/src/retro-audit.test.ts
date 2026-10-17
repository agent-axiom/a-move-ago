import type { PuzzlePrivate } from "@a-move-ago/api-contract";
import { Chess } from "chess.js";
import { describe, expect, it } from "vitest";
import { parseFen } from "./fen";
import {
  auditRetroCompleteness,
  enumerateRetroCandidates,
  retroMaterialFeasible,
} from "./retro-audit";

function gameAfterMoves(moves: string[]): Chess {
  const game = new Chess();
  for (const move of moves) game.move(move);
  return game;
}

describe("board-only predecessor audit", () => {
  it("does not use hidden halfmove, en-passant or castling metadata to invent uniqueness", () => {
    const game = gameAfterMoves(["e4"]);
    const answers = enumerateRetroCandidates(game.fen(), "w");
    expect(answers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          retraction: expect.objectContaining({ currentSquare: "e4", previousSquare: "e2" }),
        }),
        expect.objectContaining({
          retraction: expect.objectContaining({ currentSquare: "e4", previousSquare: "e3" }),
        }),
      ]),
    );
    const changed = `${game.fen().split(" ")[0]} b - - 37 80`;
    expect(enumerateRetroCandidates(changed, "w").map((answer) => answer.retraction)).toEqual(
      answers.map((answer) => answer.retraction),
    );
  });

  it("proves a reachable unique pawn advance using check and visible material", () => {
    // Public synthetic fixture; this position is excluded from the private corpus.
    const game = gameAfterMoves(["c4", "d5", "a3", "d4", "a4", "Kd7", "h3", "Kd6", "c5+"]);
    const answers = enumerateRetroCandidates(game.fen(), "w");
    expect(answers).toHaveLength(1);
    expect(answers[0]?.retraction).toEqual({
      currentSquare: "c5",
      previousSquare: "c4",
      movedPiece: { color: "w", type: "p" },
      restoredPiece: null,
      special: "normal",
    });
    const replay = new Chess(answers[0]?.previousFen);
    replay.move({ from: "c4", to: "c5" });
    expect(replay.fen().split(" ")[0]).toBe(game.fen().split(" ")[0]);
  });

  it("finds missing accepted alternatives without exposing them in its summary", () => {
    const game = gameAfterMoves(["e4"]);
    const answer = enumerateRetroCandidates(game.fen(), "w")[0];
    if (!answer) throw new Error("fixture has no predecessor");
    const puzzle: PuzzlePrivate = {
      public: {
        id: "retro-audit-fixture",
        version: 1,
        title: "Audit fixture",
        prompt: "Reconstruct the last move.",
        postFen: game.fen(),
        retractingColor: "w",
        maxHints: 0,
        provenance: "Original synthetic fixture",
        license: "CC-BY-4.0",
      },
      acceptedSolutions: [
        {
          retraction: answer.retraction,
          previousFen: answer.previousFen,
          forwardSan: answer.forwardSan,
          explanation: "Synthetic verification.",
          historyConstraints: [],
        },
      ],
      hints: [],
      contradictionExplanations: {},
    };
    const audit = auditRetroCompleteness(puzzle);
    expect(audit.missing).toBeGreaterThan(0);
    expect(audit.impossible).toBe(0);
    expect(audit.unique).toBe(false);
    expect(Object.keys(audit).sort()).toEqual([
      "accepted",
      "candidates",
      "impossible",
      "missing",
      "unique",
    ]);
  });

  it("searches all restored piece types where material permits them", () => {
    const answers = enumerateRetroCandidates("4k3/8/8/3N4/8/8/8/4K3 b - - 0 1", "w");
    const restores = answers
      .filter((a) => a.retraction.currentSquare === "d5" && a.retraction.previousSquare === "f4")
      .map((a) => a.retraction.restoredPiece?.type)
      .filter(Boolean)
      .sort();
    expect(restores).toEqual(["b", "n", "p", "q", "r"]);
  });

  it("includes en passant with the pawn restored away from its destination", () => {
    const answers = enumerateRetroCandidates("4k3/8/3P4/8/8/8/8/4K3 b - - 0 1", "w");
    expect(answers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          retraction: {
            currentSquare: "d6",
            previousSquare: "e5",
            movedPiece: { color: "w", type: "p" },
            restoredPiece: { color: "b", type: "p", square: "d5" },
            special: "en-passant",
          },
        }),
      ]),
    );
  });

  it("includes both castling directions despite invisible current rights", () => {
    for (const [fen, special] of [
      ["4k3/8/8/8/8/8/8/5RK1 b - - 1 1", "castle-kingside"],
      ["4k3/8/8/8/8/8/8/2KR4 b - - 1 1", "castle-queenside"],
    ] as const) {
      const answers = enumerateRetroCandidates(fen, "w");
      expect(answers.some((answer) => answer.retraction.special === special)).toBe(true);
    }
  });

  it("rejects castling through an attacked square or an occupied rook path", () => {
    const throughCheck = enumerateRetroCandidates("4kr2/8/8/8/8/8/8/5RK1 b - - 1 1", "w");
    expect(throughCheck.some((answer) => answer.retraction.special === "castle-kingside")).toBe(
      false,
    );
    const blocked = enumerateRetroCandidates("4k3/8/8/8/8/8/8/1NKR4 b - - 1 1", "w");
    expect(blocked.some((answer) => answer.retraction.special === "castle-queenside")).toBe(false);
  });

  it("includes unpromotion for each promotion piece and color", () => {
    for (const type of ["q", "r", "b", "n"]) {
      const white = enumerateRetroCandidates(
        `${type.toUpperCase()}3k3/8/8/8/8/8/8/4K3 b - - 0 1`,
        "w",
      );
      expect(
        white.some(
          (a) => a.retraction.special === "unpromotion" && a.retraction.previousSquare === "a7",
        ),
      ).toBe(true);
      const black = enumerateRetroCandidates(`4k3/8/8/8/8/8/8/${type}3K3 w - - 0 1`, "b");
      expect(
        black.some(
          (a) => a.retraction.special === "unpromotion" && a.retraction.previousSquare === "a2",
        ),
      ).toBe(true);
    }
  });

  it("enforces bishop-color promotion and pawn capture budgets", () => {
    expect(retroMaterialFeasible(parseFen("4k3/8/8/8/8/8/PPPPPPPP/2B1K1B1 w - - 0 1").board)).toBe(
      false,
    );
    expect(retroMaterialFeasible(parseFen("4k3/8/8/8/8/8/PPPPPPPP/2B1KB2 w - - 0 1").board)).toBe(
      true,
    );
    expect(
      retroMaterialFeasible(
        parseFen("rnbqkbnr/pppppppp/8/8/8/2P5/PP1PPPPP/RNBQKBNR w - - 0 1").board,
      ),
    ).toBe(true);
    expect(
      retroMaterialFeasible(
        parseFen("rnbqkbnr/pppppppp/8/8/8/3P4/PP1PPPPP/RNBQKBNR w - - 0 1").board,
      ),
    ).toBe(false);
  });

  it("rejects a mismatched side instead of silently evaluating another puzzle", () => {
    expect(() => enumerateRetroCandidates(new Chess().fen(), "w")).toThrow("RETRO_TURN_MISMATCH");
  });
});
