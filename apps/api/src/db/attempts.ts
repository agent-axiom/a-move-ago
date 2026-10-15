import type { SessionActor } from "../env";
import { puzzleAliasSql } from "./puzzle-identity";

export interface AttemptReplayRow {
  id: string;
  case_id: string;
  puzzle_row_id: string;
  puzzle_alias: string;
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

export interface HintAttemptRow {
  id: string;
  puzzle_id: string;
  correct: number;
  max_hint_level: number;
}

export interface HintEventRow {
  hint_json: string;
}

export interface PuzzleHintRow {
  payload_json: string;
}

export async function findAttemptReplay(
  db: D1Database,
  sessionId: string,
  attemptUuid: string,
): Promise<AttemptReplayRow | null> {
  return await db
    .prepare(
      `SELECT a.id, a.case_id, p.id AS puzzle_row_id, p.content_key AS puzzle_content_key,
              ${puzzleAliasSql("a.case_id", "dcp.position", "p.version")} AS puzzle_alias,
              a.normalized_answer_json, a.correct, a.response_json
         FROM attempts a
         JOIN puzzles p ON p.id = a.puzzle_id
         JOIN daily_case_puzzles dcp ON dcp.case_id = a.case_id AND dcp.puzzle_id = p.id
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
      `SELECT a.id, a.case_id, p.id AS puzzle_row_id, p.content_key AS puzzle_content_key,
              ${puzzleAliasSql("a.case_id", "dcp.position", "p.version")} AS puzzle_alias,
              a.normalized_answer_json, a.correct, a.response_json
         FROM attempts a
         JOIN puzzles p ON p.id = a.puzzle_id
         JOIN daily_case_puzzles dcp ON dcp.case_id = a.case_id AND dcp.puzzle_id = p.id
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
          AND (p.content_key = ? OR ${puzzleAliasSql("dc.id", "dcp.position", "p.version")} = ?)
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
    .bind(caseId, puzzleContentKey, puzzleContentKey, today)
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

function hintOwnershipPredicate(attemptAlias: string): string {
  return `(
    (s.kind = 'guest'
      AND ${attemptAlias}.session_id = s.id
      AND ${attemptAlias}.player_id IS NULL)
    OR
    (s.kind = 'telegram'
      AND ${attemptAlias}.player_id IS s.player_id)
  )`;
}

export async function findHintAttemptForActor(
  db: D1Database,
  actor: SessionActor,
  attemptId: string,
  now: number,
): Promise<HintAttemptRow | null> {
  return await db
    .prepare(
      `SELECT a.id, a.puzzle_id, a.correct,
              COALESCE(
                (SELECT MAX(he.hint_level) FROM hint_events he WHERE he.attempt_id = a.id),
                0
              ) AS max_hint_level
         FROM attempts a
         CROSS JOIN sessions s
        WHERE a.id = ?
          AND ${actorPredicate()}
          AND ${hintOwnershipPredicate("a")}`,
    )
    .bind(attemptId, ...sessionActorBindings(actor, now))
    .first<HintAttemptRow>();
}

export async function findHintForActor(
  db: D1Database,
  actor: SessionActor,
  attemptId: string,
  hintLevel: number,
  now: number,
): Promise<HintEventRow | null> {
  return await db
    .prepare(
      `SELECT he.hint_json
         FROM hint_events he
         JOIN attempts a ON a.id = he.attempt_id
         CROSS JOIN sessions s
        WHERE he.attempt_id = ?
          AND he.hint_level = ?
          AND ${actorPredicate()}
          AND ${hintOwnershipPredicate("a")}`,
    )
    .bind(attemptId, hintLevel, ...sessionActorBindings(actor, now))
    .first<HintEventRow>();
}

export async function findPuzzleHint(
  db: D1Database,
  puzzleId: string,
  hintLevel: number,
): Promise<PuzzleHintRow | null> {
  return await db
    .prepare("SELECT payload_json FROM puzzle_hints WHERE puzzle_id = ? AND level = ?")
    .bind(puzzleId, hintLevel)
    .first<PuzzleHintRow>();
}

export async function persistHintForActor(
  db: D1Database,
  actor: SessionActor,
  input: {
    attemptId: string;
    hintLevel: number;
    hintJson: string;
    now: number;
  },
): Promise<void> {
  await db.batch([
    db
      .prepare(
        `INSERT INTO hint_events (attempt_id, hint_level, hint_json, created_at)
         SELECT a.id, ?, ?, ?
           FROM attempts a
           CROSS JOIN sessions s
          WHERE a.id = ?
            AND a.correct = 0
            AND ${actorPredicate()}
            AND ${hintOwnershipPredicate("a")}
            AND ? = COALESCE(
              (SELECT MAX(earned.hint_level)
                 FROM gameplay_events earned
                 JOIN attempts earned_attempt ON earned_attempt.id = earned.attempt_id
                WHERE earned.kind = 'hint' AND earned.puzzle_id = a.puzzle_id
                  AND ${hintOwnershipPredicate("earned_attempt")}),
              0
            ) + 1
         ON CONFLICT(attempt_id, hint_level) DO NOTHING`,
      )
      .bind(
        input.hintLevel,
        input.hintJson,
        input.now,
        input.attemptId,
        ...sessionActorBindings(actor, input.now),
        input.hintLevel,
      ),
    db
      .prepare(
        `UPDATE attempts
            SET hints_used = hints_used + 1
          WHERE attempts.id = ?
            AND changes() = 1
            AND attempts.correct = 0
            AND EXISTS (
              SELECT 1
                FROM sessions s
               WHERE ${actorPredicate()}
                 AND ${hintOwnershipPredicate("attempts")}
            )
            AND EXISTS (
              SELECT 1
                FROM hint_events he
               WHERE he.attempt_id = attempts.id AND he.hint_level = ?
            )`,
      )
      .bind(input.attemptId, ...sessionActorBindings(actor, input.now), input.hintLevel),
  ]);
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
