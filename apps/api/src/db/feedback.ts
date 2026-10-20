import type { PuzzleFeedbackRequest } from "@a-move-ago/api-contract";
import type { SessionActor } from "../env";

export interface FeedbackRow {
  report_uuid: string;
  case_id: string;
  client_puzzle_id: string;
  puzzle_version: number;
  locale: PuzzleFeedbackRequest["locale"];
  reason: PuzzleFeedbackRequest["reason"];
  comment: string;
}

export async function findFeedback(
  db: D1Database,
  actor: SessionActor,
  reportUuid: string,
  now: number,
): Promise<FeedbackRow | null> {
  return await db
    .prepare(
      `SELECT f.report_uuid, f.case_id, f.client_puzzle_id, f.puzzle_version,
              f.locale, f.reason, f.comment
         FROM puzzle_feedback f JOIN sessions s ON s.id = f.session_id
        WHERE f.session_id = ? AND f.report_uuid = ?
          AND s.kind = ? AND s.player_id IS ? AND s.channel = ?
          AND s.revoked_at IS NULL AND s.expires_at > ?
          AND f.player_id IS ?`,
    )
    .bind(
      actor.sessionId,
      reportUuid,
      actor.kind,
      actor.playerId,
      actor.channel,
      now,
      actor.playerId,
    )
    .first<FeedbackRow>();
}

export async function insertFeedback(
  db: D1Database,
  actor: SessionActor,
  input: PuzzleFeedbackRequest,
  puzzleRowId: string,
  now: number,
): Promise<boolean> {
  const today = new Date(now * 1_000).toISOString().slice(0, 10);
  // One statement makes quota enforcement, session/publication checks and insertion atomic.
  // The player quota also spans different Telegram sessions for the same profile.
  const result = await db
    .prepare(
      `INSERT INTO puzzle_feedback
         (session_id, report_uuid, player_id, case_id, puzzle_id, client_puzzle_id,
          puzzle_version, locale, reason, comment, created_at)
       SELECT s.id, ?, s.player_id, dc.id, p.id, ?, ?, ?, ?, ?, ?
         FROM sessions s
         JOIN daily_cases dc ON dc.id = ?
         JOIN daily_case_puzzles dcp ON dcp.case_id = dc.id
         JOIN puzzles p ON p.id = dcp.puzzle_id
        WHERE s.id = ? AND s.kind = ? AND s.player_id IS ? AND s.channel = ?
          AND s.revoked_at IS NULL AND s.expires_at > ?
          AND p.id = ? AND p.version = ?
          AND dc.case_date <= ? AND dc.status = 'published' AND p.status = 'published'
          AND NOT EXISTS (
            SELECT 1 FROM daily_case_puzzles sibling
            JOIN puzzles required ON required.id = sibling.puzzle_id
            WHERE sibling.case_id = dc.id AND required.status <> 'published'
          )
          AND (
            SELECT count(*) FROM puzzle_feedback f
            WHERE (f.session_id = s.id OR (s.player_id IS NOT NULL AND f.player_id = s.player_id))
              AND f.created_at > ?
          ) < 5
       ON CONFLICT(session_id, report_uuid) DO NOTHING`,
    )
    .bind(
      input.reportUuid,
      input.puzzleId,
      input.puzzleVersion,
      input.locale,
      input.reason,
      input.comment ?? "",
      now,
      input.caseId,
      actor.sessionId,
      actor.kind,
      actor.playerId,
      actor.channel,
      now,
      puzzleRowId,
      input.puzzleVersion,
      today,
      now - 86_400,
    )
    .run();
  return result.meta.changes === 1;
}
