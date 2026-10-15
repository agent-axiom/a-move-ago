export interface CaseLocalizationRow {
  case_id: string;
  locale: string;
  title: string;
}

export interface PublicPuzzleLocalizationRow {
  puzzle_id: string;
  locale: string;
  public_json: string;
}

// Deliberately separate public projections from private text queries.
export async function readCaseLocalizations(db: D1Database, caseId?: string) {
  const query = db.prepare(
    `SELECT cl.case_id, cl.locale, cl.title
       FROM case_localizations cl
       JOIN content_imports ci ON ci.case_id = cl.case_id AND ci.digest = cl.source_digest
      ${caseId === undefined ? "" : "WHERE cl.case_id = ?"}
      ORDER BY cl.case_id, cl.locale`,
  );
  return (await (caseId === undefined ? query : query.bind(caseId)).all<CaseLocalizationRow>())
    .results;
}

export async function readPublicPuzzleLocalizations(db: D1Database, caseId: string) {
  return (
    await db
      .prepare(
        `SELECT pl.puzzle_id, pl.locale, pl.public_json
           FROM puzzle_localizations pl
           JOIN daily_case_puzzles dcp ON dcp.puzzle_id = pl.puzzle_id
           JOIN content_imports ci ON ci.case_id = dcp.case_id AND ci.digest = pl.source_digest
          WHERE dcp.case_id = ?
          ORDER BY pl.puzzle_id, pl.locale`,
      )
      .bind(caseId)
      .all<PublicPuzzleLocalizationRow>()
  ).results;
}

export async function readHintLocalizations(db: D1Database, puzzleRowId: string, level: number) {
  return (
    await db
      .prepare(
        `SELECT DISTINCT pl.locale,
                json_extract(pl.private_json, '$.hints[' || (CAST(? AS INTEGER) - 1) || ']') AS text
           FROM puzzle_localizations pl
           JOIN daily_case_puzzles dcp ON dcp.puzzle_id = pl.puzzle_id
           JOIN content_imports ci ON ci.case_id = dcp.case_id AND ci.digest = pl.source_digest
          WHERE pl.puzzle_id = ?
          ORDER BY pl.locale`,
      )
      .bind(level, puzzleRowId)
      .all<{ locale: string; text: string | null }>()
  ).results;
}

export async function readSolutionLocalizations(db: D1Database, caseId: string, puzzleId: string) {
  return (
    await db
      .prepare(
        `SELECT pl.locale, ps.solution_json,
                json_extract(pl.private_json, '$.explanations[' || (ps.sort_order - 1) || ']') AS explanation
           FROM puzzle_localizations pl
           JOIN puzzles p ON p.id = pl.puzzle_id
           JOIN daily_case_puzzles dcp ON dcp.puzzle_id = p.id
           JOIN content_imports ci ON ci.case_id = dcp.case_id AND ci.digest = pl.source_digest
           JOIN puzzle_solutions ps ON ps.puzzle_id = p.id
          WHERE dcp.case_id = ? AND p.content_key = ?
          ORDER BY pl.locale, ps.sort_order`,
      )
      .bind(caseId, puzzleId)
      .all<{ locale: string; solution_json: string; explanation: string | null }>()
  ).results;
}

export async function readContradictionLocalizations(
  db: D1Database,
  caseId: string,
  puzzleId: string,
) {
  return (
    await db
      .prepare(
        `SELECT pl.locale,
                json_extract(pl.private_json, '$.contradictionExplanations') AS contradiction_json
           FROM puzzle_localizations pl
           JOIN puzzles p ON p.id = pl.puzzle_id
           JOIN daily_case_puzzles dcp ON dcp.puzzle_id = p.id
           JOIN content_imports ci ON ci.case_id = dcp.case_id AND ci.digest = pl.source_digest
          WHERE dcp.case_id = ? AND p.content_key = ?
          ORDER BY pl.locale`,
      )
      .bind(caseId, puzzleId)
      .all<{ locale: string; contradiction_json: string }>()
  ).results;
}
