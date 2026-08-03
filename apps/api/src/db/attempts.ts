import type { SessionActor } from "../env";

export interface AttemptReplayRow {
  id: string;
  case_id: string;
  puzzle_content_key: string;
  normalized_answer_json: string;
  correct: number;
  response_json: string;
}

export interface AttemptPuzzleRow {
  case_id: string;
  puzzle_row_id: string;
  puzzle_content_key: string;
  puzzle_version: number;
  public_json: string;
  solution_json: string | null;
  contradiction_json: string | null;
  sort_order: number | null;
}

export interface AttemptInsert {
  id: string;
  attemptUuid: string;
  sessionId: string;
  sessionKind: "guest" | "telegram";
  playerId: string | null;
  caseId: string;
  puzzleId: string;
  answerJson: string;
  correct: boolean;
  responseJson: string;
  submittedAt: number;
}

export async function findAttemptReplay(
  db: D1Database,
  sessionId: string,
  attemptUuid: string,
): Promise<AttemptReplayRow | null> {
  return await db
    .prepare(
      `SELECT a.id, a.case_id, p.content_key AS puzzle_content_key,
              a.normalized_answer_json, a.correct, a.response_json
         FROM attempts a
         JOIN puzzles p ON p.id = a.puzzle_id
        WHERE a.session_id = ? AND a.attempt_uuid = ?`,
    )
    .bind(sessionId, attemptUuid)
    .first<AttemptReplayRow>();
}

export async function findAttemptReplayForActor(
  db: D1Database,
  actor: SessionActor,
  attemptUuid: string,
  now: number,
): Promise<AttemptReplayRow | null> {
  return await db
    .prepare(
      `SELECT a.id, a.case_id, p.content_key AS puzzle_content_key,
              a.normalized_answer_json, a.correct, a.response_json
         FROM attempts a
         JOIN puzzles p ON p.id = a.puzzle_id
         JOIN sessions s ON s.id = a.session_id
        WHERE a.session_id = ?
          AND a.attempt_uuid = ?
          AND ${actorPredicate()}
          AND a.player_id IS ?`,
    )
    .bind(actor.sessionId, attemptUuid, ...sessionActorBindings(actor, now), actor.playerId)
    .first<AttemptReplayRow>();
}

export async function findAttemptPuzzle(
  db: D1Database,
  caseId: string,
  puzzleContentKey: string,
  today: string,
): Promise<AttemptPuzzleRow[]> {
  const result = await db
    .prepare(
      `SELECT dc.id AS case_id,
              p.id AS puzzle_row_id,
              p.content_key AS puzzle_content_key,
              p.version AS puzzle_version,
              p.public_json,
              ps.solution_json,
              ps.contradiction_json,
              ps.sort_order
         FROM daily_cases dc
         JOIN daily_case_puzzles dcp ON dcp.case_id = dc.id
         JOIN puzzles p ON p.id = dcp.puzzle_id
         LEFT JOIN puzzle_solutions ps ON ps.puzzle_id = p.id
        WHERE dc.id = ?
          AND p.content_key = ?
          AND dc.case_date <= ?
          AND dc.status = 'published'
          AND p.status = 'published'
          AND NOT EXISTS (
            SELECT 1
              FROM daily_case_puzzles sibling_dcp
              JOIN puzzles sibling_p ON sibling_p.id = sibling_dcp.puzzle_id
             WHERE sibling_dcp.case_id = dc.id
               AND sibling_p.status <> 'published'
          )
        ORDER BY p.id, ps.sort_order`,
    )
    .bind(caseId, puzzleContentKey, today)
    .all<AttemptPuzzleRow>();
  return result.results;
}

function actorPredicate(): string {
  return `s.id = ?
      AND s.revoked_at IS NULL
      AND s.expires_at > ?
      AND s.kind = ?
      AND s.player_id IS ?`;
}

function actorBindings(row: AttemptInsert): [string, number, "guest" | "telegram", string | null] {
  return [row.sessionId, row.submittedAt, row.sessionKind, row.playerId];
}

function sessionActorBindings(
  actor: SessionActor,
  now: number,
): [string, number, "guest" | "telegram", string | null] {
  return [actor.sessionId, now, actor.kind, actor.playerId];
}

export async function insertAttempt(db: D1Database, row: AttemptInsert): Promise<boolean> {
  const inserted = await db
    .prepare(
      `INSERT INTO attempts
        (id, attempt_uuid, session_id, player_id, case_id, puzzle_id,
         normalized_answer_json, correct, response_json, submitted_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
         FROM sessions s
        WHERE ${actorPredicate()}
       ON CONFLICT(session_id, attempt_uuid) DO NOTHING
       RETURNING id`,
    )
    .bind(
      row.id,
      row.attemptUuid,
      row.sessionId,
      row.playerId,
      row.caseId,
      row.puzzleId,
      row.answerJson,
      row.correct ? 1 : 0,
      row.responseJson,
      row.submittedAt,
      ...actorBindings(row),
    )
    .first<{ id: string }>();
  return inserted?.id === row.id;
}

export async function isAttemptActorActive(db: D1Database, row: AttemptInsert): Promise<boolean> {
  const active = await db
    .prepare(`SELECT 1 AS active FROM sessions s WHERE ${actorPredicate()}`)
    .bind(...actorBindings(row))
    .first<{ active: number }>();
  return active?.active === 1;
}

export async function isSessionActorActive(
  db: D1Database,
  actor: SessionActor,
  now: number,
): Promise<boolean> {
  const active = await db
    .prepare(`SELECT 1 AS active FROM sessions s WHERE ${actorPredicate()}`)
    .bind(...sessionActorBindings(actor, now))
    .first<{ active: number }>();
  return active?.active === 1;
}
