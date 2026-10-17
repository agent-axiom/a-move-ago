import type { SessionActor } from "../env";
import { puzzleAliasSql } from "./puzzle-identity";

export interface SolvedPuzzleRevealRow {
  puzzle_row_id: string;
  puzzle_content_key: string;
  response_json: string;
}

// Read a response already earned by this actor. This also supports legacy solves
// and player-owned attempts whose original session has since been removed.
export async function readSolvedPuzzleReveal(
  db: D1Database,
  actor: SessionActor,
  caseId: string,
  puzzleId: string,
  today: string,
  now: number,
): Promise<SolvedPuzzleRevealRow | null> {
  return await db
    .prepare(
      `SELECT p.id AS puzzle_row_id, p.content_key AS puzzle_content_key, a.response_json
         FROM attempts a
         JOIN daily_cases dc ON dc.id = a.case_id
         JOIN daily_case_puzzles dcp ON dcp.case_id = dc.id AND dcp.puzzle_id = a.puzzle_id
         JOIN puzzles p ON p.id = dcp.puzzle_id
         CROSS JOIN sessions s
        WHERE dc.id = ?
          AND (p.content_key = ? OR ${puzzleAliasSql("dc.id", "dcp.position", "p.version")} = ?)
          AND dc.case_date <= ?
          AND dc.status = 'published' AND p.status = 'published'
          AND NOT EXISTS (
            SELECT 1 FROM daily_case_puzzles sibling_dcp
            JOIN puzzles sibling_p ON sibling_p.id = sibling_dcp.puzzle_id
            WHERE sibling_dcp.case_id = dc.id AND sibling_p.status <> 'published'
          )
          AND s.id = ? AND s.revoked_at IS NULL AND s.expires_at > ?
          AND s.kind = ? AND s.player_id IS ?
          AND a.correct = 1
          AND ((s.kind = 'guest' AND a.session_id = s.id AND a.player_id IS NULL)
            OR (s.kind = 'telegram' AND a.player_id = s.player_id))
        ORDER BY a.submitted_at, a.id
        LIMIT 1`,
    )
    .bind(caseId, puzzleId, puzzleId, today, actor.sessionId, now, actor.kind, actor.playerId)
    .first<SolvedPuzzleRevealRow>();
}
