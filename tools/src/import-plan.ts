import type { PuzzlePrivate } from "@a-move-ago/api-contract";
import { canonicalJson, sha256Hex } from "./canonical-json";

export type D1Statement = {
  sql: string;
  params: string[];
};

export type ContentCaseSource = {
  case: {
    id: string;
    date: string;
    slug: string;
    title: string;
    generatedAt: number;
  };
  puzzles: PuzzlePrivate[];
};

export type ImportPlan = {
  digest: string;
  draftStatements: D1Statement[];
  publishStatements: D1Statement[];
};

export async function buildImportPlan(
  source: ContentCaseSource,
  digest: string,
): Promise<ImportPlan> {
  const metadata = source.case;
  const draftStatements: D1Statement[] = [
    {
      sql: `INSERT INTO daily_cases
        (id, case_date, slug, title, status, published_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'draft', NULL, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          title = CASE
            WHEN daily_cases.case_date = excluded.case_date
             AND daily_cases.slug = excluded.slug
             AND daily_cases.title = excluded.title
             AND daily_cases.created_at = excluded.created_at
            THEN daily_cases.title ELSE NULL END`,
      params: [
        metadata.id,
        metadata.date,
        metadata.slug,
        metadata.title,
        String(metadata.generatedAt),
        String(metadata.generatedAt),
      ],
    },
  ];

  for (const [puzzleIndex, puzzle] of source.puzzles.entries()) {
    const puzzleRowId = `${puzzle.public.id}:v${puzzle.public.version}`;
    const puzzleDigest = await sha256Hex(canonicalJson(puzzle));
    draftStatements.push({
      sql: `INSERT INTO puzzles
        (id, content_key, version, content_digest, status, public_json,
         provenance, license, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?)
        ON CONFLICT(content_key, version) DO UPDATE SET
          content_digest = CASE
            WHEN puzzles.id = excluded.id
             AND puzzles.content_digest = excluded.content_digest
             AND puzzles.status IN ('draft', 'published')
            THEN puzzles.content_digest ELSE NULL END`,
      params: [
        puzzleRowId,
        puzzle.public.id,
        String(puzzle.public.version),
        puzzleDigest,
        canonicalJson(puzzle.public),
        puzzle.public.provenance,
        puzzle.public.license,
        String(metadata.generatedAt),
        String(metadata.generatedAt),
      ],
    });

    puzzle.acceptedSolutions.forEach((solution, solutionIndex) => {
      draftStatements.push({
        sql: `INSERT INTO puzzle_solutions
          (id, puzzle_id, solution_key, solution_json, contradiction_json, sort_order)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(puzzle_id, solution_key) DO UPDATE SET
            solution_json = CASE
              WHEN puzzle_solutions.id = excluded.id
               AND puzzle_solutions.solution_json = excluded.solution_json
               AND puzzle_solutions.contradiction_json = excluded.contradiction_json
               AND puzzle_solutions.sort_order = excluded.sort_order
              THEN puzzle_solutions.solution_json ELSE NULL END`,
        params: [
          `${puzzleRowId}:solution:${solutionIndex + 1}`,
          puzzleRowId,
          `solution-${solutionIndex + 1}`,
          canonicalJson(solution),
          canonicalJson(puzzle.contradictionExplanations),
          String(solutionIndex + 1),
        ],
      });
    });

    puzzle.hints.forEach((hint, hintIndex) => {
      draftStatements.push({
        sql: `INSERT INTO puzzle_hints (puzzle_id, level, payload_json)
          VALUES (?, ?, ?)
          ON CONFLICT(puzzle_id, level) DO UPDATE SET
            payload_json = CASE
              WHEN puzzle_hints.payload_json = excluded.payload_json
              THEN puzzle_hints.payload_json ELSE NULL END`,
        params: [
          puzzleRowId,
          String(hintIndex + 1),
          canonicalJson({
            level: hintIndex + 1,
            text: hint,
            exhausted: hintIndex + 1 === puzzle.hints.length,
          }),
        ],
      });
    });

    draftStatements.push({
      sql: `INSERT INTO daily_case_puzzles (case_id, puzzle_id, position, act_json)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(case_id, position) DO UPDATE SET
          act_json = CASE
            WHEN daily_case_puzzles.puzzle_id = excluded.puzzle_id
             AND daily_case_puzzles.act_json = excluded.act_json
            THEN daily_case_puzzles.act_json ELSE NULL END`,
      params: [
        metadata.id,
        puzzleRowId,
        String(puzzleIndex + 1),
        canonicalJson({ index: puzzleIndex + 1, total: source.puzzles.length }),
      ],
    });
  }

  draftStatements.push({
    sql: `INSERT INTO content_imports (digest, case_id, source_name, imported_at, published_at)
      VALUES (?, ?, ?, ?, NULL)
      ON CONFLICT(digest) DO UPDATE SET
        case_id = CASE
          WHEN content_imports.case_id = excluded.case_id
           AND content_imports.source_name = excluded.source_name
           AND content_imports.imported_at = excluded.imported_at
          THEN content_imports.case_id ELSE NULL END`,
    params: [digest, metadata.id, metadata.slug, String(metadata.generatedAt)],
  });

  return {
    digest,
    draftStatements,
    publishStatements: [
      {
        sql: `UPDATE puzzles SET
          status = CASE
            WHEN status = 'draft' THEN 'published'
            WHEN status = 'published' THEN status
            ELSE NULL END,
          updated_at = CASE WHEN status = 'draft' THEN ? ELSE updated_at END
          WHERE id IN (SELECT puzzle_id FROM daily_case_puzzles WHERE case_id = ?)`,
        params: [String(metadata.generatedAt), metadata.id],
      },
      {
        sql: `UPDATE daily_cases SET
          status = CASE
            WHEN NOT EXISTS (
              SELECT 1 FROM daily_case_puzzles WHERE case_id = daily_cases.id
            ) THEN NULL
            WHEN status = 'draft' THEN 'published'
            WHEN status = 'published' THEN status
            ELSE NULL END,
          published_at = CASE WHEN status = 'draft' THEN ? ELSE published_at END,
          updated_at = CASE WHEN status = 'draft' THEN ? ELSE updated_at END
          WHERE id = ?`,
        params: [String(metadata.generatedAt), String(metadata.generatedAt), metadata.id],
      },
      {
        sql: "UPDATE content_imports SET published_at = ? WHERE digest = ? AND published_at IS NULL",
        params: [String(metadata.generatedAt), digest],
      },
    ],
  };
}
