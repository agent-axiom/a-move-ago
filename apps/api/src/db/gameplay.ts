import type { SessionActor } from "../env";

export interface GameProgressRow {
  attemptCount: number;
  assistanceCount: number;
  clueUnlocked: boolean;
  highestHintLevel: number;
  earnedPoints: number | null;
  nextAttemptPoints: number;
  legacySolved: boolean;
  awardAttemptId: string | null;
}

interface ProgressQueryRow {
  puzzle_id: string;
  attempt_count: number;
  assistance_count: number;
  clue_unlocked: number;
  highest_hint_level: number;
  earned_points: number | null;
  next_attempt_points: number;
  legacy_solved: number;
  award_attempt_id: string | null;
}

interface ActorEventScope {
  sql: string;
  attemptSql: string;
  clueSql: string;
  bindings: string[];
}

function actorEventScope(actor: SessionActor): ActorEventScope {
  if (actor.kind === "guest" && actor.playerId === null) {
    return {
      sql: `(a.session_id = ? AND a.player_id IS NULL)
        OR (e.kind = 'clue' AND e.clue_session_id = ? AND e.clue_player_id IS NULL)`,
      attemptSql: "a.session_id = ? AND a.player_id IS NULL",
      clueSql: "e.clue_session_id = ? AND e.clue_player_id IS NULL",
      bindings: [actor.sessionId, actor.sessionId],
    };
  }
  if (actor.kind !== "telegram" || actor.playerId === null) {
    throw new Error("Gameplay actor is invalid");
  }
  return {
    sql: `a.player_id = ? OR (e.kind = 'clue' AND e.clue_player_id = ?)`,
    attemptSql: "a.player_id = ?",
    clueSql: "e.clue_player_id = ?",
    bindings: [actor.playerId, actor.playerId],
  };
}

// A single statement supplies a consistent snapshot. seq fixes the award at the first
// committed correct attempt; later hints, attempts and UUID replays cannot change it.
function progressQuery(scope: ActorEventScope, puzzlePredicate: string): string {
  return `WITH owned_attempts AS MATERIALIZED (
    SELECT a.id, a.correct FROM attempts a WHERE ${scope.attemptSql}
  ), all_owned_events AS MATERIALIZED (
    SELECT e.seq, e.puzzle_id, e.attempt_id, e.kind, e.hint_level, e.legacy, a.correct
      FROM gameplay_events e
      JOIN owned_attempts a ON a.id = e.attempt_id
    UNION ALL
    SELECT e.seq, e.puzzle_id, e.attempt_id, e.kind, e.hint_level, e.legacy, NULL
      FROM gameplay_events e WHERE e.kind = 'clue' AND ${scope.clueSql}
  ), owned_events AS MATERIALIZED (
    SELECT * FROM all_owned_events e WHERE ${puzzlePredicate}
  ), first_solves AS MATERIALIZED (
    SELECT puzzle_id, MIN(seq) AS solve_seq
      FROM owned_events WHERE kind = 'attempt' AND correct = 1 GROUP BY puzzle_id
  ), measurements AS (
    SELECT e.puzzle_id,
           COUNT(CASE WHEN e.kind = 'attempt'
             AND (s.solve_seq IS NULL OR e.seq <= s.solve_seq) THEN 1 END) AS attempt_count,
           COUNT(DISTINCT CASE WHEN e.kind = 'hint'
             AND (s.solve_seq IS NULL OR e.seq < s.solve_seq) THEN e.hint_level END)
             + MAX(CASE WHEN (e.kind = 'clue' OR (e.kind = 'attempt' AND e.legacy = 1))
                 AND (s.solve_seq IS NULL OR e.seq <= s.solve_seq) THEN 1 ELSE 0 END)
             AS assistance_count,
           MAX(CASE WHEN e.kind = 'clue' OR (e.kind = 'attempt' AND e.legacy = 1)
             THEN 1 ELSE 0 END) AS clue_unlocked,
           MAX(CASE WHEN e.kind = 'hint' THEN e.hint_level ELSE 0 END) AS highest_hint_level,
           MAX(CASE WHEN e.seq = s.solve_seq THEN e.legacy ELSE 0 END) AS legacy_solved,
           MAX(CASE WHEN e.seq = s.solve_seq THEN e.attempt_id END) AS award_attempt_id
      FROM owned_events e LEFT JOIN first_solves s ON s.puzzle_id = e.puzzle_id
     GROUP BY e.puzzle_id
  ), priced AS (
    SELECT *,
      CASE attempt_count WHEN 1 THEN 100 WHEN 2 THEN 70 WHEN 3 THEN 40 ELSE 20 END
        AS solved_base,
      CASE attempt_count WHEN 0 THEN 100 WHEN 1 THEN 70 WHEN 2 THEN 40 ELSE 20 END
        AS next_base
      FROM measurements
  )
  SELECT puzzle_id, attempt_count, assistance_count, clue_unlocked, highest_hint_level,
         legacy_solved, award_attempt_id,
         CASE WHEN award_attempt_id IS NULL THEN NULL
              WHEN legacy_solved = 1 THEN 0
              ELSE MAX(1, solved_base >> MIN(assistance_count, 7)) END AS earned_points,
         CASE WHEN award_attempt_id IS NOT NULL THEN 0
              ELSE MAX(1, next_base >> MIN(assistance_count, 7)) END AS next_attempt_points
    FROM priced`;
}

function zeroProgress(): GameProgressRow {
  return {
    attemptCount: 0,
    assistanceCount: 0,
    clueUnlocked: false,
    highestHintLevel: 0,
    earnedPoints: null,
    nextAttemptPoints: 100,
    legacySolved: false,
    awardAttemptId: null,
  };
}

function resolvedProgressQuery(
  scope: ActorEventScope,
  puzzlePredicate: string,
  linked: boolean,
): string {
  const query = progressQuery(scope, puzzlePredicate);
  if (!linked) return query;
  // Player scopes bind the player ID first. Reuse ?1 to retain the 100-parameter limit.
  const better = "m.earned_points >= COALESCE(p.earned_points, -1)";
  return `SELECT p.puzzle_id,
    CASE WHEN ${better} THEN m.attempt_count ELSE p.attempt_count END AS attempt_count,
    CASE WHEN ${better} THEN m.assistance_count ELSE p.assistance_count END AS assistance_count,
    p.clue_unlocked, p.highest_hint_level,
    CASE WHEN ${better} THEN m.earned_points ELSE p.earned_points END AS earned_points,
    CASE WHEN ${better} THEN 0 ELSE p.next_attempt_points END AS next_attempt_points,
    CASE WHEN ${better} THEN m.legacy_solved ELSE p.legacy_solved END AS legacy_solved,
    CASE WHEN ${better} THEN m.award_attempt_id ELSE p.award_attempt_id END AS award_attempt_id
    FROM (${query}) p
    LEFT JOIN merged_puzzle_awards m ON m.player_id = ?1 AND m.puzzle_id = p.puzzle_id`;
}

// Run after the replacement session is inserted and BEFORE moving attempts or clues,
// inside the same guarded D1 batch. Otherwise each side's earned score is lost on merge.
export function preserveMergeAwardsStatement(
  db: D1Database,
  guestSessionId: string,
  replacementSessionId: string,
): D1PreparedStatement {
  const guestScope: ActorEventScope = {
    sql: "",
    attemptSql: "a.session_id = ? AND a.player_id IS NULL",
    clueSql: "e.clue_session_id = ? AND e.clue_player_id IS NULL",
    bindings: [guestSessionId, guestSessionId],
  };
  const playerScope: ActorEventScope = {
    sql: "",
    attemptSql: "a.player_id = (SELECT player_id FROM sessions WHERE id = ?)",
    clueSql: "e.clue_player_id = (SELECT player_id FROM sessions WHERE id = ?)",
    bindings: [replacementSessionId, replacementSessionId],
  };
  return db
    .prepare(`WITH candidates AS MATERIALIZED (
      SELECT * FROM (${progressQuery(playerScope, "1 = 1")})
      UNION ALL
      SELECT * FROM (${progressQuery(guestScope, "1 = 1")})
    )
    INSERT INTO merged_puzzle_awards
      (player_id, puzzle_id, award_attempt_id, earned_points,
       attempt_count, assistance_count, legacy_solved)
    SELECT r.player_id, c.puzzle_id, c.award_attempt_id, c.earned_points,
           c.attempt_count, c.assistance_count, c.legacy_solved
      FROM candidates c
      JOIN sessions r ON r.id = ?
      JOIN sessions original ON original.id = r.rotated_from_session_id
     WHERE original.id = ? AND original.kind = 'guest' AND original.player_id IS NULL
       AND original.revoked_at IS NULL AND original.expires_at > unixepoch()
       AND r.kind = 'telegram' AND r.player_id IS NOT NULL
       AND r.channel = original.channel AND r.revoked_at IS NULL
       AND r.expires_at > unixepoch() AND c.award_attempt_id IS NOT NULL
    ON CONFLICT(player_id, puzzle_id) DO UPDATE SET
      award_attempt_id = excluded.award_attempt_id,
      earned_points = excluded.earned_points,
      attempt_count = excluded.attempt_count,
      assistance_count = excluded.assistance_count,
      legacy_solved = excluded.legacy_solved
    WHERE excluded.earned_points > merged_puzzle_awards.earned_points`)
    .bind(...playerScope.bindings, ...guestScope.bindings, replacementSessionId, guestSessionId);
}

function toProgress(row: ProgressQueryRow): GameProgressRow {
  return {
    attemptCount: row.attempt_count,
    assistanceCount: row.assistance_count,
    clueUnlocked: row.clue_unlocked === 1,
    highestHintLevel: row.highest_hint_level,
    earnedPoints: row.earned_points,
    nextAttemptPoints: row.next_attempt_points,
    legacySolved: row.legacy_solved === 1,
    awardAttemptId: row.award_attempt_id,
  };
}

export async function readGameProgress(
  db: D1Database,
  actor: SessionActor,
  puzzleRowIds: string[],
): Promise<Map<string, GameProgressRow>> {
  if (
    puzzleRowIds.length > 98 ||
    puzzleRowIds.some((id) => typeof id !== "string" || id.length === 0 || id.length > 512)
  ) {
    throw new Error("Gameplay puzzle IDs are invalid");
  }
  const ids = [...new Set(puzzleRowIds)];
  const progress = new Map(ids.map((id) => [id, zeroProgress()]));
  if (ids.length === 0) return progress;
  const scope = actorEventScope(actor);
  const result = await db
    .prepare(
      resolvedProgressQuery(
        scope,
        `e.puzzle_id IN (${ids.map(() => "?").join(", ")})`,
        actor.kind === "telegram",
      ),
    )
    .bind(...scope.bindings, ...ids)
    .all<ProgressQueryRow>();
  for (const row of result.results) progress.set(row.puzzle_id, toProgress(row));
  return progress;
}

export async function readTotalPoints(db: D1Database, actor: SessionActor): Promise<number> {
  const scope = actorEventScope(actor);
  const row = await db
    .prepare(
      `SELECT COALESCE(SUM(earned_points), 0) AS total_points
         FROM (${resolvedProgressQuery(scope, "1 = 1", actor.kind === "telegram")})`,
    )
    .bind(...scope.bindings)
    .first<{ total_points: number }>();
  if (!row) throw new Error("Gameplay total returned no row");
  return row.total_points;
}

export async function grantPuzzleClue(
  db: D1Database,
  actor: SessionActor,
  input: { caseId: string; puzzleId: string; today: string; now: number },
): Promise<void> {
  const scope = actorEventScope(actor);
  await db
    .prepare(
      `INSERT INTO gameplay_events (puzzle_id, kind, clue_session_id, clue_player_id)
       SELECT p.id, 'clue', CASE WHEN s.kind = 'guest' THEN s.id END, s.player_id
         FROM sessions s
         JOIN daily_cases dc ON dc.id = ?
         JOIN daily_case_puzzles dcp ON dcp.case_id = dc.id
         JOIN puzzles p ON p.id = dcp.puzzle_id AND p.id = ?
        WHERE s.id = ? AND s.kind = ? AND s.player_id IS ? AND s.channel = ?
          AND s.revoked_at IS NULL AND s.expires_at > ?
          AND dc.case_date <= ? AND dc.status = 'published' AND p.status = 'published'
          AND NOT EXISTS (
            SELECT 1 FROM daily_case_puzzles sibling
            JOIN puzzles sibling_p ON sibling_p.id = sibling.puzzle_id
            WHERE sibling.case_id = dc.id AND sibling_p.status <> 'published'
          )
          AND NOT EXISTS (
            SELECT 1 FROM gameplay_events e LEFT JOIN attempts a ON a.id = e.attempt_id
             WHERE e.puzzle_id = p.id AND (${scope.sql})
               AND (e.kind = 'clue' OR (e.kind = 'attempt' AND e.legacy = 1))
          )`,
    )
    .bind(
      input.caseId,
      input.puzzleId,
      actor.sessionId,
      actor.kind,
      actor.playerId,
      actor.channel,
      input.now,
      input.today,
      ...scope.bindings,
    )
    .run();
}

export function transferClueStatement(
  db: D1Database,
  guestSessionId: string,
  replacementSessionId: string,
  playerId: string | null,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE gameplay_events
          SET clue_session_id = NULL,
              clue_player_id = (SELECT player_id FROM sessions WHERE id = ?)
        WHERE kind = 'clue' AND clue_session_id = ? AND clue_player_id IS NULL
          AND EXISTS (
            SELECT 1 FROM sessions replacement
            JOIN sessions original ON original.id = replacement.rotated_from_session_id
             WHERE replacement.id = ? AND replacement.rotated_from_session_id = ?
               AND replacement.kind = 'telegram'
               AND (? IS NULL OR replacement.player_id = ?)
               AND replacement.revoked_at IS NULL AND replacement.expires_at > unixepoch()
               AND original.kind = 'guest' AND original.player_id IS NULL
               AND original.channel = replacement.channel
               AND original.revoked_at IS NULL AND original.expires_at > unixepoch()
          )`,
    )
    .bind(
      replacementSessionId,
      guestSessionId,
      replacementSessionId,
      guestSessionId,
      playerId,
      playerId,
    );
}
