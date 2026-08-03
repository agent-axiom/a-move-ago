import type { SessionActor } from "../env";

export interface PublishedDailyRow {
  case_id: string;
  case_date: string;
  title: string;
  position: number;
  puzzle_row_id: string;
  content_key: string;
  version: number;
  public_json: string;
}

export interface SolvedPuzzleRow {
  puzzle_row_id: string;
  content_key: string;
}

export async function findPublishedDaily(
  db: D1Database,
  date: string,
  today: string,
): Promise<PublishedDailyRow[]> {
  const result = await db
    .prepare(
      `SELECT dc.id AS case_id, dc.case_date, dc.title,
              dcp.position, p.id AS puzzle_row_id, p.content_key, p.version, p.public_json
         FROM daily_cases dc
         JOIN daily_case_puzzles dcp ON dcp.case_id = dc.id
         JOIN puzzles p ON p.id = dcp.puzzle_id
        WHERE dc.case_date = ?
          AND dc.case_date <= ?
          AND dc.status = 'published'
          AND p.status = 'published'
          AND NOT EXISTS (
            SELECT 1
              FROM daily_case_puzzles required_dcp
              JOIN puzzles required_p ON required_p.id = required_dcp.puzzle_id
             WHERE required_dcp.case_id = dc.id
               AND required_p.status <> 'published'
          )
        ORDER BY dcp.position`,
    )
    .bind(date, today)
    .all<PublishedDailyRow>();
  return result.results;
}

export async function findSolvedPuzzleRows(
  db: D1Database,
  caseId: string,
  actor: SessionActor,
): Promise<SolvedPuzzleRow[]> {
  if (actor.kind === "telegram") {
    if (actor.playerId === null) throw new Error("Telegram session has no player");
    const result = await db
      .prepare(
        `SELECT DISTINCT p.id AS puzzle_row_id, p.content_key
           FROM attempts a
           JOIN puzzles p ON p.id = a.puzzle_id
          WHERE a.case_id = ? AND a.correct = 1 AND a.player_id = ?`,
      )
      .bind(caseId, actor.playerId)
      .all<SolvedPuzzleRow>();
    return result.results;
  }

  const result = await db
    .prepare(
      `SELECT DISTINCT p.id AS puzzle_row_id, p.content_key
         FROM attempts a
         JOIN puzzles p ON p.id = a.puzzle_id
        WHERE a.case_id = ? AND a.correct = 1 AND a.session_id = ?`,
    )
    .bind(caseId, actor.sessionId)
    .all<SolvedPuzzleRow>();
  return result.results;
}
