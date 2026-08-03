import type { AcceptedSolution, PuzzlePublic } from "@a-move-ago/api-contract";

export const contentDigest = "0123456789abcdef".repeat(4);
export const privateSolutionMarker = "reveal-secret";

export type PuzzleFixture = {
  rowId: string;
  contentKey: string;
  public: PuzzlePublic;
  solution: AcceptedSolution;
};

type PuzzleFixtureOptions = {
  rowId?: string;
  contentKey?: string;
  publicId?: string;
  version?: number;
  title?: string;
};

export function makePuzzleFixture(options: PuzzleFixtureOptions = {}): PuzzleFixture {
  const contentKey = options.contentKey ?? "opening-exd5";
  return {
    rowId: options.rowId ?? `${contentKey}:v1`,
    contentKey,
    public: {
      id: options.publicId ?? contentKey,
      version: options.version ?? 1,
      title: options.title ?? "The missing pawn",
      prompt: "What happened one move ago?",
      postFen: "rnbqkbnr/ppp1pppp/8/3P4/8/8/PPPP1PPP/RNBQKBNR b KQkq - 0 2",
      retractingColor: "w",
      maxHints: 2,
      provenance: "A MOVE AGO test fixture",
      license: "CC-BY-4.0",
    },
    solution: {
      retraction: {
        currentSquare: "d5",
        previousSquare: "e4",
        movedPiece: { color: "w", type: "p" },
        restoredPiece: { color: "b", type: "p", square: "d5" },
        special: "normal",
      },
      previousFen: privateSolutionMarker,
      forwardSan: "exd5",
      explanation: "Private explanation that must never be returned by the daily endpoint.",
      historyConstraints: [],
    },
  };
}

export const openingPuzzleFixture = makePuzzleFixture();

export async function seedPuzzle(
  db: D1Database,
  fixture: PuzzleFixture,
  options: { status?: "draft" | "published" | "retired"; publicJson?: string } = {},
): Promise<void> {
  const now = 1_785_715_200;
  await db
    .prepare(
      `INSERT INTO puzzles
        (id, content_key, version, content_digest, status, public_json,
         provenance, license, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      fixture.rowId,
      fixture.contentKey,
      fixture.public.version,
      contentDigest,
      options.status ?? "published",
      options.publicJson ?? JSON.stringify(fixture.public),
      fixture.public.provenance,
      fixture.public.license,
      now,
      now,
    )
    .run();
  await db
    .prepare(
      `INSERT INTO puzzle_solutions
        (id, puzzle_id, solution_key, solution_json, contradiction_json, sort_order)
       VALUES (?, ?, ?, ?, ?, 1)`,
    )
    .bind(
      `${fixture.rowId}:solution:1`,
      fixture.rowId,
      "primary",
      JSON.stringify(fixture.solution),
      JSON.stringify({ NOT_THE_LAST_MOVE: privateSolutionMarker }),
    )
    .run();
  await db
    .prepare(
      "INSERT INTO puzzle_hints (puzzle_id, level, payload_json) VALUES (?, 1, ?), (?, 2, ?)",
    )
    .bind(
      fixture.rowId,
      JSON.stringify({ level: 1, text: "A pawn changed files.", exhausted: false }),
      fixture.rowId,
      JSON.stringify({ level: 2, text: privateSolutionMarker, exhausted: true }),
    )
    .run();
}

type DailyCaseFixtureOptions = {
  id?: string;
  date?: string;
  slug?: string;
  title?: string;
  status?: "draft" | "published" | "retired";
};

export async function seedDailyCase(
  db: D1Database,
  options: DailyCaseFixtureOptions = {},
): Promise<{ id: string; date: string; title: string }> {
  const id = options.id ?? "case-2026-08-03";
  const date = options.date ?? "2026-08-03";
  const title = options.title ?? "The missing pawn";
  const status = options.status ?? "published";
  const now = 1_785_715_200;
  await db
    .prepare(
      `INSERT INTO daily_cases
        (id, case_date, slug, title, status, published_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      date,
      options.slug ?? `${id}-slug`,
      title,
      status,
      status === "draft" ? null : now,
      now,
      now,
    )
    .run();
  return { id, date, title };
}

export async function seedCasePuzzle(
  db: D1Database,
  caseId: string,
  puzzleRowId: string,
  position = 1,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO daily_case_puzzles (case_id, puzzle_id, position, act_json)
       VALUES (?, ?, ?, ?)`,
    )
    .bind(caseId, puzzleRowId, position, JSON.stringify({ privateAct: privateSolutionMarker }))
    .run();
}

export async function seedContentFixture(
  db: D1Database,
  options: DailyCaseFixtureOptions & {
    puzzle?: PuzzleFixture;
    puzzleStatus?: "draft" | "published" | "retired";
    position?: number;
  } = {},
): Promise<{ caseId: string; date: string; puzzle: PuzzleFixture }> {
  const puzzle = options.puzzle ?? openingPuzzleFixture;
  const dailyCase = await seedDailyCase(db, options);
  await seedPuzzle(db, puzzle, options.puzzleStatus ? { status: options.puzzleStatus } : {});
  await seedCasePuzzle(db, dailyCase.id, puzzle.rowId, options.position);
  return { caseId: dailyCase.id, date: dailyCase.date, puzzle };
}
