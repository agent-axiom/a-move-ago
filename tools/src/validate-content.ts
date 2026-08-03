import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type PuzzlePrivate,
  PuzzlePrivateSchema,
  type Retraction,
  type Square,
} from "@a-move-ago/api-contract";
import {
  applyRetraction,
  evaluateRetraction,
  parseFen,
  replayAcceptedSolution,
} from "@a-move-ago/game-core";
import { z } from "zod";

export const ContentCaseSchema = z
  .object({
    case: z
      .object({
        id: z.string().min(1),
        date: z.iso.date(),
        slug: z.string().min(1),
        title: z.string().min(1),
        generatedAt: z.int().nonnegative(),
      })
      .strict(),
    puzzles: z.array(PuzzlePrivateSchema).min(1),
  })
  .strict();

export type ContentCase = z.infer<typeof ContentCaseSchema>;
export interface ContentDirectorySummary {
  cases: number;
  puzzles: number;
}

function canonicalBoard(board: ReturnType<typeof parseFen>["board"]): string {
  return JSON.stringify(
    Object.entries(board)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([square, piece]) => {
        if (!piece) throw new Error(`Invalid board entry at ${square}`);
        return [square, piece.color, piece.type];
      }),
  );
}

function puzzleError(puzzle: PuzzlePrivate, message: string): Error {
  return new Error(`Puzzle ${puzzle.public.id}: ${message}`);
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

function hasPiece(
  state: ReturnType<typeof parseFen>,
  square: Square,
  color: "w" | "b",
  type: "p" | "r" | "k",
): boolean {
  const piece = state.board[square];
  return piece?.color === color && piece.type === type;
}

function validateFenMetadata(state: ReturnType<typeof parseFen>, name: string): void {
  const castlingRequirements = [
    ["K", "e1", "h1", "w"],
    ["Q", "e1", "a1", "w"],
    ["k", "e8", "h8", "b"],
    ["q", "e8", "a8", "b"],
  ] as const;
  for (const [right, kingSquare, rookSquare, color] of castlingRequirements) {
    if (
      state.castling.includes(right) &&
      (!hasPiece(state, kingSquare, color, "k") || !hasPiece(state, rookSquare, color, "r"))
    ) {
      throw new Error(
        `${name} has semantic castling metadata: ${right} requires the matching king and rook`,
      );
    }
  }

  const target = state.enPassant;
  if (target === "-") return;
  const file = target[0];
  if (!file) throw new Error(`${name} has semantic en-passant metadata: invalid target`);
  const expected =
    state.turn === "w"
      ? { rank: "6", pawn: `${file}5` as Square, origin: `${file}7` as Square, color: "b" as const }
      : {
          rank: "3",
          pawn: `${file}4` as Square,
          origin: `${file}2` as Square,
          color: "w" as const,
        };
  if (
    target[1] !== expected.rank ||
    !hasPiece(state, expected.pawn, expected.color, "p") ||
    state.board[expected.origin] ||
    state.board[target]
  ) {
    throw new Error(
      `${name} has semantic en-passant metadata: target must follow an unobstructed double pawn push`,
    );
  }
}

function parseDocument(source: string): ContentCase {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (error) {
    throw new Error(
      `Invalid content JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return ContentCaseSchema.parse(value);
}

function validatePuzzle(puzzle: PuzzlePrivate): void {
  let post: ReturnType<typeof parseFen>;
  try {
    post = parseFen(puzzle.public.postFen);
  } catch (error) {
    throw puzzleError(
      puzzle,
      `invalid postFen: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  try {
    validateFenMetadata(post, "postFen");
  } catch (error) {
    throw puzzleError(puzzle, error instanceof Error ? error.message : String(error));
  }

  const expectedPostTurn = puzzle.public.retractingColor === "w" ? "b" : "w";
  if (post.turn !== expectedPostTurn) {
    throw puzzleError(puzzle, "postFen turn must be the opponent of retractingColor");
  }

  const retractions = new Set<string>();
  for (const solution of puzzle.acceptedSolutions) {
    const key = retractionKey(solution.retraction);
    if (retractions.has(key)) {
      throw puzzleError(puzzle, "duplicate accepted retraction identity");
    }
    retractions.add(key);
    if (solution.retraction.movedPiece.color !== puzzle.public.retractingColor) {
      throw puzzleError(puzzle, "accepted solution movedPiece color must match retractingColor");
    }

    let evaluation: ReturnType<typeof evaluateRetraction>;
    try {
      evaluation = evaluateRetraction(puzzle, solution.retraction);
    } catch (error) {
      throw puzzleError(
        puzzle,
        `accepted solution could not be evaluated: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!evaluation.correct) {
      throw puzzleError(
        puzzle,
        `accepted solution is not correct: ${evaluation.contradiction.code}`,
      );
    }

    let previous: ReturnType<typeof parseFen>;
    try {
      previous = parseFen(solution.previousFen);
    } catch (error) {
      throw puzzleError(
        puzzle,
        `invalid previousFen: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    try {
      validateFenMetadata(previous, "previousFen");
    } catch (error) {
      throw puzzleError(puzzle, error instanceof Error ? error.message : String(error));
    }

    let reconstructed: ReturnType<typeof applyRetraction>;
    try {
      reconstructed = applyRetraction(post, solution.retraction);
    } catch (error) {
      throw puzzleError(
        puzzle,
        `accepted solution cannot be applied: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (canonicalBoard(reconstructed.board) !== canonicalBoard(previous.board)) {
      throw puzzleError(puzzle, "accepted solution board does not match previousFen");
    }

    const constraintKinds = new Set<string>();
    for (const constraint of solution.historyConstraints) {
      if (constraintKinds.has(constraint.kind)) {
        throw puzzleError(puzzle, "duplicate history constraint kind");
      }
      constraintKinds.add(constraint.kind);
      if (constraint.kind === "previous-castling" && previous.castling !== constraint.value) {
        throw puzzleError(puzzle, "previous castling constraint does not match previousFen");
      }
      if (constraint.kind === "previous-en-passant" && previous.enPassant !== constraint.value) {
        throw puzzleError(puzzle, "previous en-passant constraint does not match previousFen");
      }
    }

    try {
      replayAcceptedSolution(puzzle, solution);
    } catch (error) {
      throw puzzleError(puzzle, error instanceof Error ? error.message : String(error));
    }
  }

  if (puzzle.hints.length !== puzzle.public.maxHints) {
    throw puzzleError(puzzle, "hints length must match maxHints");
  }
}

export function validateContentDocument(source: string): ContentCase {
  const content = parseDocument(source);
  const ids = new Set<string>();
  for (const puzzle of content.puzzles) {
    if (ids.has(puzzle.public.id)) {
      throw puzzleError(puzzle, "duplicate puzzle id in content document");
    }
    ids.add(puzzle.public.id);
    validatePuzzle(puzzle);
  }
  return content;
}

function duplicateCorpusValue(
  values: Map<string, string>,
  kind: string,
  value: string,
  filename: string,
): void {
  const firstFilename = values.get(value);
  if (firstFilename) {
    throw new Error(`Duplicate ${kind} ${value} in ${firstFilename} and ${filename}`);
  }
  values.set(value, filename);
}

export async function validateContentDirectory(
  directory: string,
): Promise<ContentDirectorySummary> {
  const entries = (await readdir(directory, { withFileTypes: true })).sort((left, right) =>
    left.name.localeCompare(right.name),
  );
  const documents = entries.filter((entry) => entry.name.endsWith(".json"));
  if (documents.length === 0) {
    throw new Error(`Content directory ${directory} contains no regular JSON documents`);
  }

  for (const entry of documents) {
    if (!entry.isFile()) {
      throw new Error(
        `Content entry ${resolve(directory, entry.name)} must be a regular JSON file`,
      );
    }
  }

  const caseIds = new Map<string, string>();
  const caseDates = new Map<string, string>();
  const puzzleIds = new Map<string, string>();
  let puzzleCount = 0;
  for (const entry of documents) {
    const filename = resolve(directory, entry.name);
    let content: ContentCase;
    try {
      content = validateContentDocument(await readFile(filename, "utf8"));
    } catch (error) {
      throw new Error(
        `Content file ${filename}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    duplicateCorpusValue(caseIds, "case id", content.case.id, filename);
    duplicateCorpusValue(caseDates, "case date", content.case.date, filename);
    for (const puzzle of content.puzzles) {
      duplicateCorpusValue(puzzleIds, "puzzle id", puzzle.public.id, filename);
    }
    puzzleCount += content.puzzles.length;
  }
  if (puzzleCount === 0) {
    throw new Error(`Content directory ${directory} contains no puzzles`);
  }
  return { cases: documents.length, puzzles: puzzleCount };
}

const invokedPath = process.argv[1];
if (invokedPath && resolve(invokedPath) === fileURLToPath(import.meta.url)) {
  const directory = process.argv[2];
  if (!directory) {
    throw new Error("Usage: validate-content <directory>");
  }
  const summary = await validateContentDirectory(resolve(process.cwd(), directory));
  console.log(`Validated ${summary.cases} case(s), ${summary.puzzles} puzzle(s)`);
}
