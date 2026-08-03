import type { AcceptedSolution, PuzzlePrivate, Retraction } from "@a-move-ago/api-contract";
import { describe, expect, it } from "vitest";
import { evaluateRetraction, replayAcceptedSolution } from "./evaluate";

const acceptedRetraction: Retraction = {
  currentSquare: "d5",
  previousSquare: "e4",
  movedPiece: { color: "w", type: "p" },
  restoredPiece: { color: "b", type: "p", square: "d5" },
  special: "normal",
};

const puzzle: PuzzlePrivate = {
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
      retraction: acceptedRetraction,
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
const [acceptedSolution] = puzzle.acceptedSolutions;
if (!acceptedSolution) throw new Error("Puzzle fixture needs an accepted solution");

type ContradictionCode =
  | "NO_PIECE_ON_CURRENT_SQUARE"
  | "WRONG_COLOR"
  | "PREVIOUS_SQUARE_OCCUPIED"
  | "RESTORE_SQUARE_OCCUPIED"
  | "INVALID_SPECIAL_MOVE"
  | "OPPONENT_KING_IN_CHECK"
  | "NOT_THE_LAST_MOVE";

type ContradictionCase = {
  code: ContradictionCode;
  message: string;
  postFen?: string;
  retraction: Retraction;
};

const contradictionCases: ContradictionCase[] = [
  {
    code: "NO_PIECE_ON_CURRENT_SQUARE",
    message: "There is no piece to move back from that square.",
    retraction: { ...acceptedRetraction, currentSquare: "a3" },
  },
  {
    code: "WRONG_COLOR",
    message: "That piece could not have made the last move.",
    retraction: { ...acceptedRetraction, movedPiece: { color: "b", type: "p" } },
  },
  {
    code: "PREVIOUS_SQUARE_OCCUPIED",
    message: "The proposed previous square was occupied.",
    retraction: { ...acceptedRetraction, previousSquare: "d2" },
  },
  {
    code: "RESTORE_SQUARE_OCCUPIED",
    message: "The captured piece cannot be restored on an occupied square.",
    retraction: {
      ...acceptedRetraction,
      restoredPiece: { color: "b", type: "p", square: "d2" },
    },
  },
  {
    code: "INVALID_SPECIAL_MOVE",
    message: "That special move cannot be retracted from this position.",
    retraction: { ...acceptedRetraction, special: "castle-kingside" },
  },
  {
    code: "OPPONENT_KING_IN_CHECK",
    message: "The previous position leaves the side not to move in check.",
    postFen: "4k3/8/8/8/8/8/1R6/4K3 b - - 1 1",
    retraction: {
      currentSquare: "b2",
      previousSquare: "e2",
      movedPiece: { color: "w", type: "r" },
      restoredPiece: null,
      special: "normal",
    },
  },
  {
    code: "NOT_THE_LAST_MOVE",
    message: "The position is legal, but the evidence does not support that last move.",
    retraction: {
      currentSquare: "d5",
      previousSquare: "d4",
      movedPiece: { color: "w", type: "p" },
      restoredPiece: null,
      special: "normal",
    },
  },
];

function contradictionPuzzle(
  testCase: ContradictionCase,
  contradictionExplanations: PuzzlePrivate["contradictionExplanations"] = {},
): PuzzlePrivate {
  return {
    ...puzzle,
    public: {
      ...puzzle.public,
      ...(testCase.postFen ? { postFen: testCase.postFen } : {}),
    },
    contradictionExplanations,
  };
}

function replayFixture(
  previousFen: string,
  postFen: string,
  retraction: Retraction,
  forwardSan: string,
): [PuzzlePrivate, AcceptedSolution] {
  const solution: AcceptedSolution = {
    retraction,
    previousFen,
    forwardSan,
    explanation: "Replay fixture.",
    historyConstraints: [],
  };
  return [
    {
      public: { ...puzzle.public, id: `replay-${forwardSan}`, postFen },
      acceptedSolutions: [solution],
      hints: [],
      contradictionExplanations: {},
    },
    solution,
  ];
}

describe("evaluateRetraction", () => {
  it("reveals the exact accepted solution", () => {
    expect(evaluateRetraction(puzzle, acceptedRetraction)).toEqual({
      correct: true,
      reveal: acceptedSolution,
    });
  });

  it("returns a reveal isolated from the puzzle in both directions", () => {
    const localPuzzle = structuredClone(puzzle);
    const originalSolution = structuredClone(localPuzzle.acceptedSolutions[0]);
    const first = evaluateRetraction(localPuzzle, acceptedRetraction);
    if (!first.correct) throw new Error("Expected accepted solution");

    first.reveal.explanation = "Mutated reveal";
    first.reveal.retraction.movedPiece.type = "q";
    first.reveal.historyConstraints.push({ kind: "previous-castling", value: "-" });
    expect(localPuzzle.acceptedSolutions[0]).toEqual(originalSolution);

    const [localSolution] = localPuzzle.acceptedSolutions;
    if (!localSolution) throw new Error("Puzzle fixture needs an accepted solution");
    localSolution.explanation = "Mutated puzzle";
    expect(first.reveal.explanation).toBe("Mutated reveal");
    expect(evaluateRetraction(localPuzzle, acceptedRetraction)).toMatchObject({ correct: true });
  });

  it("throws for invalid trusted puzzle content", () => {
    expect(() =>
      evaluateRetraction(
        { ...puzzle, public: { ...puzzle.public, postFen: "not a FEN" } },
        acceptedRetraction,
      ),
    ).toThrow("Invalid FEN");
  });

  it("propagates unexpected malformed-retraction errors", () => {
    expect(() =>
      evaluateRetraction(puzzle, { ...acceptedRetraction, movedPiece: null } as never),
    ).toThrow(TypeError);
  });

  it("reports an occupied proposed previous square", () => {
    expect(
      evaluateRetraction(puzzle, { ...acceptedRetraction, previousSquare: "d2" }),
    ).toMatchObject({
      correct: false,
      contradiction: { code: "PREVIOUS_SQUARE_OCCUPIED" },
    });
  });

  it("rejects a legal reconstruction that is not an accepted last move", () => {
    expect(
      evaluateRetraction(puzzle, {
        currentSquare: "d5",
        previousSquare: "d4",
        movedPiece: { color: "w", type: "p" },
        restoredPiece: null,
        special: "normal",
      }),
    ).toEqual({
      correct: false,
      contradiction: {
        code: "NOT_THE_LAST_MOVE",
        message: "That reconstruction does not fit the case evidence.",
      },
    });
  });

  it("rejects runtime-invalid restoration metadata", () => {
    expect(
      evaluateRetraction(puzzle, {
        ...acceptedRetraction,
        restoredPiece: { color: "b", type: "k", square: "d5" } as never,
      }),
    ).toMatchObject({
      correct: false,
      contradiction: { code: "INVALID_SPECIAL_MOVE" },
    });
  });

  it("rejects a previous position where the opponent is in check", () => {
    const checkPuzzle: PuzzlePrivate = {
      ...puzzle,
      public: {
        ...puzzle.public,
        postFen: "4k3/8/8/8/8/8/1R6/4K3 b - - 1 1",
      },
    };
    expect(
      evaluateRetraction(checkPuzzle, {
        currentSquare: "b2",
        previousSquare: "e2",
        movedPiece: { color: "w", type: "r" },
        restoredPiece: null,
        special: "normal",
      }),
    ).toMatchObject({
      correct: false,
      contradiction: { code: "OPPONENT_KING_IN_CHECK" },
    });
  });

  it("uses the exact default message for every contradiction code", () => {
    for (const testCase of contradictionCases) {
      expect(evaluateRetraction(contradictionPuzzle(testCase), testCase.retraction)).toEqual({
        correct: false,
        contradiction: { code: testCase.code, message: testCase.message },
      });
    }
  });

  it("prefers a code-specific custom override for every contradiction", () => {
    const overrides = Object.fromEntries(
      contradictionCases.map((testCase) => [testCase.code, `Custom ${testCase.code}`]),
    ) as PuzzlePrivate["contradictionExplanations"];

    for (const testCase of contradictionCases) {
      expect(
        evaluateRetraction(contradictionPuzzle(testCase, overrides), testCase.retraction),
      ).toEqual({
        correct: false,
        contradiction: { code: testCase.code, message: `Custom ${testCase.code}` },
      });
    }
  });

  it("rejects matcher-reaching canonical-field differences", () => {
    const rookRetraction: Retraction = {
      currentSquare: "a2",
      previousSquare: "a1",
      movedPiece: { color: "w", type: "r" },
      restoredPiece: null,
      special: "normal",
    };
    const rookSolution: AcceptedSolution = {
      ...acceptedSolution,
      retraction: rookRetraction,
      previousFen: "4k3/8/8/8/8/8/1R6/R3K3 w - - 1 1",
      forwardSan: "Raa2",
    };
    const rookPuzzle: PuzzlePrivate = {
      ...puzzle,
      public: {
        ...puzzle.public,
        postFen: "4k3/8/8/8/8/8/RR6/4K3 b - - 1 1",
      },
      acceptedSolutions: [rookSolution],
      contradictionExplanations: {},
    };
    const castleRetraction: Retraction = {
      currentSquare: "g1",
      previousSquare: "e1",
      movedPiece: { color: "w", type: "k" },
      restoredPiece: null,
      special: "castle-kingside",
    };
    const castleSolution: AcceptedSolution = {
      ...acceptedSolution,
      retraction: castleRetraction,
      previousFen: "r3k2r/8/8/8/8/8/8/R3K2R w kq - 1 1",
      forwardSan: "O-O",
    };
    const castlePuzzle: PuzzlePrivate = {
      ...puzzle,
      public: {
        ...puzzle.public,
        postFen: "r3k2r/8/8/8/8/8/8/R4RK1 b kq - 1 1",
      },
      acceptedSolutions: [castleSolution],
      contradictionExplanations: {},
    };
    const inconsistentCandidate: AcceptedSolution = {
      ...acceptedSolution,
      retraction: { ...acceptedRetraction, movedPiece: { color: "w", type: "r" } },
    };
    const inconsistentPuzzle: PuzzlePrivate = {
      ...puzzle,
      acceptedSolutions: [inconsistentCandidate],
    };
    const variants: [string, PuzzlePrivate, Retraction][] = [
      ["currentSquare", rookPuzzle, { ...rookRetraction, currentSquare: "b2" }],
      ["movedPiece", inconsistentPuzzle, acceptedRetraction],
      ["restoredPiece", puzzle, { ...acceptedRetraction, restoredPiece: null }],
      ["special", castlePuzzle, { ...castleRetraction, special: "normal" }],
    ];

    for (const [, targetPuzzle, retraction] of variants) {
      expect(evaluateRetraction(targetPuzzle, retraction)).toMatchObject({
        correct: false,
        contradiction: { code: "NOT_THE_LAST_MOVE" },
      });
    }
  });
});

describe("replayAcceptedSolution", () => {
  it("replays the curated solution to the exact post FEN", () => {
    expect(replayAcceptedSolution(puzzle, acceptedSolution)).toBe(puzzle.public.postFen);
  });

  it("replays quiet, capture, castling, en-passant, and promotion solutions", () => {
    const replayCases: [string, PuzzlePrivate, AcceptedSolution][] = [
      ["capture", puzzle, acceptedSolution],
      [
        "quiet",
        ...replayFixture(
          "4k3/8/8/8/8/8/8/R3K3 w - - 0 1",
          "4k3/8/8/8/8/8/R7/4K3 b - - 1 1",
          {
            currentSquare: "a2",
            previousSquare: "a1",
            movedPiece: { color: "w", type: "r" },
            restoredPiece: null,
            special: "normal",
          },
          "Ra2",
        ),
      ],
      [
        "castling",
        ...replayFixture(
          "r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1",
          "r3k2r/8/8/8/8/8/8/R4RK1 b kq - 1 1",
          {
            currentSquare: "g1",
            previousSquare: "e1",
            movedPiece: { color: "w", type: "k" },
            restoredPiece: null,
            special: "castle-kingside",
          },
          "O-O",
        ),
      ],
      [
        "en-passant",
        ...replayFixture(
          "4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 2",
          "4k3/8/3P4/8/8/8/8/4K3 b - - 0 2",
          {
            currentSquare: "d6",
            previousSquare: "e5",
            movedPiece: { color: "w", type: "p" },
            restoredPiece: { color: "b", type: "p", square: "d5" },
            special: "en-passant",
          },
          "exd6",
        ),
      ],
      [
        "promotion",
        ...replayFixture(
          "7k/P7/8/8/8/8/8/4K3 w - - 0 1",
          "Q6k/8/8/8/8/8/8/4K3 b - - 0 1",
          {
            currentSquare: "a8",
            previousSquare: "a7",
            movedPiece: { color: "w", type: "q" },
            restoredPiece: null,
            special: "unpromotion",
          },
          "a8=Q+",
        ),
      ],
    ];

    for (const [, targetPuzzle, solution] of replayCases) {
      expect(replayAcceptedSolution(targetPuzzle, solution)).toBe(targetPuzzle.public.postFen);
    }
  });

  it("rejects a solution whose SAN does not match its replay", () => {
    expect(() => replayAcceptedSolution(puzzle, { ...acceptedSolution, forwardSan: "d5" })).toThrow(
      "forwardSan",
    );
  });

  it("rejects invalid previous FEN content", () => {
    expect(() =>
      replayAcceptedSolution(puzzle, { ...acceptedSolution, previousFen: "not a FEN" }),
    ).toThrow("previousFen");
  });

  it("rejects an illegal forward replay", () => {
    expect(() =>
      replayAcceptedSolution(puzzle, {
        ...acceptedSolution,
        previousFen: "4k3/8/8/8/8/8/8/4K3 w - - 0 1",
      }),
    ).toThrow("Forward replay mismatch");
  });

  it("rejects a replay whose final FEN does not match the puzzle", () => {
    expect(() =>
      replayAcceptedSolution(
        { ...puzzle, public: { ...puzzle.public, postFen: "4k3/8/8/8/8/8/8/4K3 b - - 0 1" } },
        acceptedSolution,
      ),
    ).toThrow("Forward replay mismatch");
  });
});

describe("multiple accepted equivalents", () => {
  const twoRoads: PuzzlePrivate = {
    public: {
      id: "two-roads",
      version: 1,
      title: "Two roads",
      prompt: "What happened one move ago?",
      postFen: "4k3/8/8/8/8/8/R7/4K3 b - - 1 1",
      retractingColor: "w",
      maxHints: 0,
      provenance: "Original A MOVE AGO test",
      license: "CC-BY-4.0",
    },
    acceptedSolutions: [
      {
        retraction: {
          currentSquare: "a2",
          previousSquare: "a1",
          movedPiece: { color: "w", type: "r" },
          restoredPiece: null,
          special: "normal",
        },
        previousFen: "4k3/8/8/8/8/8/8/R3K3 w - - 0 1",
        forwardSan: "Ra2",
        explanation: "The rook came up from a1.",
        historyConstraints: [
          { kind: "previous-castling", value: "-" },
          { kind: "previous-en-passant", value: "-" },
        ],
      },
      {
        retraction: {
          currentSquare: "a2",
          previousSquare: "b2",
          movedPiece: { color: "w", type: "r" },
          restoredPiece: null,
          special: "normal",
        },
        previousFen: "4k3/8/8/8/8/8/1R6/4K3 w - - 0 1",
        forwardSan: "Ra2",
        explanation: "The rook came across from b2.",
        historyConstraints: [
          { kind: "previous-castling", value: "-" },
          { kind: "previous-en-passant", value: "-" },
        ],
      },
    ],
    hints: [],
    contradictionExplanations: {},
  };

  it("reveals the matching accepted equivalent for each exact retraction", () => {
    for (const solution of twoRoads.acceptedSolutions) {
      expect(evaluateRetraction(twoRoads, solution.retraction)).toEqual({
        correct: true,
        reveal: solution,
      });
    }
  });
});
