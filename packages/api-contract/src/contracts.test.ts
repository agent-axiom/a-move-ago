import { describe, expect, it } from "vitest";
import {
  AttemptRequestSchema,
  PuzzlePrivateSchema,
  PuzzlePublicSchema,
  RetractionSchema,
  SquareSchema,
  TelegramProfileSchema,
} from "./index";

describe("shared contracts", () => {
  it("accepts a capture retraction", () => {
    expect(
      RetractionSchema.parse({
        currentSquare: "d5",
        previousSquare: "e4",
        movedPiece: { color: "w", type: "p" },
        restoredPiece: { color: "b", type: "p", square: "d5" },
        special: "normal",
      }),
    ).toMatchObject({ currentSquare: "d5", previousSquare: "e4" });
  });

  it("rejects non-board coordinates", () => {
    expect(SquareSchema.safeParse("i9").success).toBe(false);
  });

  it("keeps accepted solutions private", () => {
    const parsed = PuzzlePrivateSchema.parse(samplePuzzle);
    expect(parsed.acceptedSolutions).toHaveLength(1);
    expect("acceptedSolutions" in parsed.public).toBe(false);
    expect(
      PuzzlePublicSchema.safeParse({
        ...samplePuzzle.public,
        acceptedSolutions: samplePuzzle.acceptedSolutions,
      }).success,
    ).toBe(false);
  });

  it("requires separate client idempotency and puzzle ids", () => {
    expect(
      AttemptRequestSchema.safeParse({
        attemptUuid: crypto.randomUUID(),
        caseId: "case-2026-08-03",
        puzzleId: "opening-exd5",
        retraction: samplePuzzle.acceptedSolutions[0]?.retraction,
      }).success,
    ).toBe(true);

    const profile = {
      telegramUserId: "123456789",
      displayName: "A Move Ago",
      username: "a_move_ago",
      avatarUrl: "https://example.com/avatar.png",
    };
    expect(TelegramProfileSchema.safeParse(profile).success).toBe(true);
    expect(
      TelegramProfileSchema.safeParse({ ...profile, avatarUrl: "javascript:alert(1)" }).success,
    ).toBe(false);
    expect(
      TelegramProfileSchema.safeParse({ ...profile, avatarUrl: "data:image/png;base64,AAAA" })
        .success,
    ).toBe(false);
  });

  it("rejects impossible restored-piece and special-move metadata", () => {
    // biome-ignore lint/style/noNonNullAssertion: the sample fixture defines its first solution.
    const base = samplePuzzle.acceptedSolutions[0]!.retraction;
    expect(
      RetractionSchema.safeParse({
        ...base,
        restoredPiece: { color: "b", type: "k", square: "d5" },
      }).success,
    ).toBe(false);
    expect(
      RetractionSchema.safeParse({
        ...base,
        restoredPiece: { color: "w", type: "p", square: "d5" },
      }).success,
    ).toBe(false);
    expect(
      RetractionSchema.safeParse({
        ...base,
        restoredPiece: { color: "b", type: "p", square: "d4" },
      }).success,
    ).toBe(false);
    expect(
      RetractionSchema.safeParse({
        currentSquare: "d6",
        previousSquare: "e5",
        movedPiece: { color: "w", type: "p" },
        restoredPiece: { color: "b", type: "p", square: "d5" },
        special: "normal",
      }).success,
    ).toBe(false);

    const retractionCases: Array<[string, unknown, boolean]> = [
      [
        "white en-passant",
        {
          currentSquare: "d6",
          previousSquare: "e5",
          movedPiece: { color: "w", type: "p" },
          restoredPiece: { color: "b", type: "p", square: "d5" },
          special: "en-passant",
        },
        true,
      ],
      [
        "black en-passant",
        {
          currentSquare: "e3",
          previousSquare: "d4",
          movedPiece: { color: "b", type: "p" },
          restoredPiece: { color: "w", type: "p", square: "e4" },
          special: "en-passant",
        },
        true,
      ],
      [
        "en-passant wrong direction",
        {
          currentSquare: "d4",
          previousSquare: "e5",
          movedPiece: { color: "w", type: "p" },
          restoredPiece: { color: "b", type: "p", square: "d5" },
          special: "en-passant",
        },
        false,
      ],
      [
        "en-passant without a restored pawn",
        {
          currentSquare: "d6",
          previousSquare: "e5",
          movedPiece: { color: "w", type: "p" },
          restoredPiece: null,
          special: "en-passant",
        },
        false,
      ],
      [
        "castling king without a restored piece",
        {
          currentSquare: "g1",
          previousSquare: "e1",
          movedPiece: { color: "w", type: "k" },
          restoredPiece: null,
          special: "castle-kingside",
        },
        true,
      ],
      [
        "castling requires a king",
        {
          currentSquare: "g1",
          previousSquare: "e1",
          movedPiece: { color: "w", type: "r" },
          restoredPiece: null,
          special: "castle-kingside",
        },
        false,
      ],
      [
        "castling cannot restore a piece",
        {
          currentSquare: "c8",
          previousSquare: "e8",
          movedPiece: { color: "b", type: "k" },
          restoredPiece: { color: "w", type: "r", square: "c8" },
          special: "castle-queenside",
        },
        false,
      ],
      [
        "white quiet unpromotion",
        {
          currentSquare: "a8",
          previousSquare: "a7",
          movedPiece: { color: "w", type: "q" },
          restoredPiece: null,
          special: "unpromotion",
        },
        true,
      ],
      [
        "white capture unpromotion",
        {
          currentSquare: "b8",
          previousSquare: "a7",
          movedPiece: { color: "w", type: "q" },
          restoredPiece: { color: "b", type: "p", square: "b8" },
          special: "unpromotion",
        },
        true,
      ],
      [
        "black quiet unpromotion",
        {
          currentSquare: "a1",
          previousSquare: "a2",
          movedPiece: { color: "b", type: "r" },
          restoredPiece: null,
          special: "unpromotion",
        },
        true,
      ],
      [
        "black capture unpromotion",
        {
          currentSquare: "b1",
          previousSquare: "a2",
          movedPiece: { color: "b", type: "r" },
          restoredPiece: { color: "w", type: "n", square: "b1" },
          special: "unpromotion",
        },
        true,
      ],
      [
        "unpromotion requires the pre-promotion rank",
        {
          currentSquare: "a8",
          previousSquare: "a6",
          movedPiece: { color: "w", type: "q" },
          restoredPiece: null,
          special: "unpromotion",
        },
        false,
      ],
      [
        "quiet unpromotion cannot restore a piece",
        {
          currentSquare: "a1",
          previousSquare: "a2",
          movedPiece: { color: "b", type: "n" },
          restoredPiece: { color: "w", type: "p", square: "a1" },
          special: "unpromotion",
        },
        false,
      ],
    ];

    for (const [description, retraction, expected] of retractionCases) {
      expect(RetractionSchema.safeParse(retraction).success, description).toBe(expected);
    }
  });
});

const samplePuzzle = {
  public: {
    id: "opening-exd5",
    version: 1,
    title: "The missing pawn",
    prompt: "What happened one move ago?",
    postFen: "rnbqkbnr/ppp1pppp/8/3P4/8/8/PPPP1PPP/RNBQKBNR b KQkq - 0 2",
    retractingColor: "w",
    maxHints: 2,
    provenance: "Original A MOVE AGO sample",
    license: "CC-BY-4.0",
  },
  acceptedSolutions: [
    {
      retraction: {
        currentSquare: "d5",
        previousSquare: "e4",
        movedPiece: { color: "w", type: "p" },
        restoredPiece: { color: "b", type: "p", square: "d5" },
        special: "normal",
      },
      previousFen: "rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq d6 0 2",
      forwardSan: "exd5",
      explanation: "The white e-pawn captured the black pawn on d5.",
      historyConstraints: [
        { kind: "previous-castling", value: "KQkq" },
        { kind: "previous-en-passant", value: "d6" },
      ],
    },
  ],
  hints: ["A pawn changed files.", "Restore the pawn that disappeared from d5."],
  contradictionExplanations: {
    NOT_THE_LAST_MOVE: "That reconstruction does not fit the case evidence.",
  },
};
