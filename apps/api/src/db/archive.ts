import type { SessionActor } from "../env";

export interface ArchiveCaseRow {
  id: string;
  case_date: string;
  slug: string;
  title: string;
  puzzle_count: number;
  solved_puzzles: number;
}

export async function readArchiveCases(
  db: D1Database,
  actor: SessionActor,
  today: string,
): Promise<ArchiveCaseRow[]> {
  if (actor.kind === "telegram" && actor.playerId === null) {
    throw new Error("Telegram archive actor has no player");
  }
  const scope =
    actor.kind === "guest" ? "session_id = ? AND player_id IS NULL" : "player_id = ?";
  const actorId = actor.kind === "guest" ? actor.sessionId : actor.playerId;
  const result = await db
    .prepare(
      `WITH actor_solved AS MATERIALIZED (
         SELECT DISTINCT case_id, puzzle_id
           FROM attempts
          WHERE ${scope} AND correct = 1
       )
       SELECT dc.id, dc.case_date, dc.slug, dc.title,
              count(*) AS puzzle_count,
              count(solved.puzzle_id) AS solved_puzzles
         FROM daily_cases dc
         JOIN daily_case_puzzles dcp ON dcp.case_id = dc.id
         JOIN puzzles p ON p.id = dcp.puzzle_id
         LEFT JOIN actor_solved solved
           ON solved.case_id = dc.id AND solved.puzzle_id = p.id
        WHERE dc.case_date <= ?
          AND dc.status = 'published'
        GROUP BY dc.id, dc.case_date, dc.slug, dc.title
       HAVING count(*) > 0
          AND sum(CASE WHEN p.status = 'published' THEN 0 ELSE 1 END) = 0
        ORDER BY dc.case_date DESC`,
    )
    .bind(actorId, today)
    .all<ArchiveCaseRow>();
  return result.results;
}
