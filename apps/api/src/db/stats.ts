import type { SessionActor } from "../env";

interface StatsQueryRow {
  attempts: number;
  hints_used: number;
  solved_puzzles: number;
  completed_date: string | null;
}

export interface StatsSnapshot {
  attempts: number;
  hintsUsed: number;
  solvedPuzzles: number;
  completedDates: string[];
}

function actorScope(actor: SessionActor): { predicate: string; binding: string } {
  if (actor.kind === "guest") {
    return {
      predicate: "session_id = ? AND player_id IS NULL",
      binding: actor.sessionId,
    };
  }
  if (!actor.playerId) throw new Error("Telegram stats actor has no player");
  return { predicate: "player_id = ?", binding: actor.playerId };
}

export async function readStatsSnapshot(
  db: D1Database,
  actor: SessionActor,
): Promise<StatsSnapshot> {
  const scope = actorScope(actor);
  const result = await db
    .prepare(
      `WITH actor_attempts AS MATERIALIZED (
         SELECT case_id, puzzle_id, correct, hints_used
           FROM attempts
          WHERE ${scope.predicate}
       ),
       actor_solved AS MATERIALIZED (
         SELECT DISTINCT case_id, puzzle_id
           FROM actor_attempts
          WHERE correct = 1
       ),
       totals AS (
         SELECT count(*) AS attempts,
                COALESCE(sum(hints_used), 0) AS hints_used,
                count(DISTINCT CASE WHEN correct = 1 THEN puzzle_id END) AS solved_puzzles
           FROM actor_attempts
       ),
       completed_cases AS (
         SELECT dc.id, dc.case_date
           FROM (SELECT DISTINCT case_id FROM actor_solved) candidates
           JOIN daily_cases dc ON dc.id = candidates.case_id
          WHERE EXISTS (
                  SELECT 1
                    FROM daily_case_puzzles required
                   WHERE required.case_id = dc.id
                )
            AND NOT EXISTS (
                  SELECT 1
                    FROM daily_case_puzzles required
                   WHERE required.case_id = dc.id
                     AND NOT EXISTS (
                           SELECT 1
                             FROM actor_solved solved
                            WHERE solved.case_id = required.case_id
                              AND solved.puzzle_id = required.puzzle_id
                         )
                )
       )
       SELECT totals.attempts,
              totals.hints_used,
              totals.solved_puzzles,
              completed_cases.case_date AS completed_date
         FROM totals
         LEFT JOIN completed_cases ON 1 = 1
        ORDER BY completed_cases.case_date`,
    )
    .bind(scope.binding)
    .all<StatsQueryRow>();
  const first = result.results[0];
  if (!first) throw new Error("Stats aggregate returned no row");

  return {
    attempts: first.attempts,
    hintsUsed: first.hints_used,
    solvedPuzzles: first.solved_puzzles,
    completedDates: result.results.flatMap((row) =>
      row.completed_date === null ? [] : [row.completed_date],
    ),
  };
}
