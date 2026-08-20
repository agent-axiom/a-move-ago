import { type GuestMeResponse, GuestMeResponseSchema } from "@a-move-ago/api-contract";
import type { Env, SessionActor } from "../env";
import { ApiError } from "../http/api-error";

type DeletionState = {
  kind: "guest" | "telegram";
  player_id: string | null;
  channel: SessionActor["channel"];
  rotated_from_session_id: string | null;
  revoked_at: number | null;
  expires_at: number;
  player_exists: number;
  linked_sessions_exist: number;
  linked_attempts_exist: number;
  linked_auth_flows_exist: number;
};

const guestResponse = (): GuestMeResponse =>
  GuestMeResponseSchema.parse({ kind: "guest", profile: null });

function invalidSession(): ApiError {
  return new ApiError(401, "INVALID_SESSION", "The session is no longer active.");
}

async function activeGuest(env: Env, actor: SessionActor, now: number): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT id FROM sessions
      WHERE id = ?
        AND kind = 'guest'
        AND player_id IS NULL
        AND channel = ?
        AND revoked_at IS NULL
        AND expires_at > ?`,
  )
    .bind(actor.sessionId, actor.channel, now)
    .first<{ id: string }>();
  return row !== null;
}

async function classifyDeletionOutcome(
  env: Env,
  actor: SessionActor & { playerId: string },
  now: number,
  failure: unknown,
): Promise<GuestMeResponse> {
  let state: DeletionState | null;
  try {
    state = await env.DB.prepare(
      `SELECT current.kind,
              current.player_id,
              current.channel,
              current.rotated_from_session_id,
              current.revoked_at,
              current.expires_at,
              EXISTS (SELECT 1 FROM players WHERE id = ?) AS player_exists,
              EXISTS (SELECT 1 FROM sessions WHERE player_id = ?) AS linked_sessions_exist,
              EXISTS (SELECT 1 FROM attempts WHERE player_id = ?) AS linked_attempts_exist,
              EXISTS (SELECT 1 FROM auth_flows WHERE player_id = ?) AS linked_auth_flows_exist
         FROM sessions current
        WHERE current.id = ?`,
    )
      .bind(actor.playerId, actor.playerId, actor.playerId, actor.playerId, actor.sessionId)
      .first<DeletionState>();
  } catch {
    throw failure;
  }
  if (!state || state.revoked_at !== null || state.expires_at <= now) throw invalidSession();
  if (
    state.kind === "guest" &&
    state.player_id === null &&
    state.channel === actor.channel &&
    state.rotated_from_session_id === null &&
    state.player_exists === 0 &&
    state.linked_sessions_exist === 0 &&
    state.linked_attempts_exist === 0 &&
    state.linked_auth_flows_exist === 0
  )
    return guestResponse();
  throw failure;
}

// Real D1 metadata can include cascade changes in the DELETE count. This fast-path stays
// conservative; classifyDeletionOutcome performs the exact post-state re-read on rejection.
function expectedBatchResults(results: D1Result[]): boolean {
  if (results.length !== 3) return false;
  const update = results[0]?.meta.changes;
  const deletePlayer = results[1]?.meta.changes;
  const guard = results[2]?.meta.changes;
  return (
    guard === 0 && ((update === 1 && deletePlayer === 1) || (update === 0 && deletePlayer === 0))
  );
}

export async function deleteProfileForActor(
  env: Env,
  actor: SessionActor,
  now: number,
): Promise<GuestMeResponse> {
  if (actor.kind === "guest" && actor.playerId === null) {
    if (!(await activeGuest(env, actor, now))) throw invalidSession();
    return guestResponse();
  }
  if (actor.kind !== "telegram" || actor.playerId === null) throw invalidSession();
  const telegramActor: SessionActor & { playerId: string } = {
    ...actor,
    playerId: actor.playerId,
  };

  const guardId = crypto.randomUUID();
  const guardTokenHash = crypto.randomUUID();
  let results: D1Result[];
  try {
    results = await env.DB.batch([
      env.DB.prepare(
        `UPDATE sessions
            SET kind = 'guest',
                player_id = NULL,
                rotated_from_session_id = NULL,
                last_seen_at = ?
          WHERE id = ?
            AND kind = ?
            AND player_id IS ?
            AND channel = ?
            AND revoked_at IS NULL
            AND expires_at > ?`,
      ).bind(now, actor.sessionId, actor.kind, actor.playerId, actor.channel, now),
      env.DB.prepare(
        `DELETE FROM players
          WHERE id = ?
            AND changes() = 1
            AND EXISTS (
              SELECT 1 FROM sessions current
               WHERE current.id = ?
                 AND current.kind = 'guest'
                 AND current.player_id IS NULL
                 AND current.channel = ?
                 AND current.rotated_from_session_id IS NULL
                 AND current.revoked_at IS NULL
                 AND current.expires_at > ?
            )`,
      ).bind(actor.playerId, actor.sessionId, actor.channel, now),
      env.DB.prepare(
        `INSERT INTO sessions
          (id, player_id, token_hash, kind, channel, rotated_from_session_id,
           created_at, expires_at, revoked_at, last_seen_at)
         SELECT ?, NULL, ?, 'profile-delete-transaction-guard', ?, NULL, ?, ?, NULL, ?
          WHERE NOT (
            EXISTS (
              SELECT 1 FROM sessions current
               WHERE current.id = ?
                 AND current.kind = 'guest'
                 AND current.player_id IS NULL
                 AND current.channel = ?
                 AND current.rotated_from_session_id IS NULL
                 AND current.revoked_at IS NULL
                 AND current.expires_at > ?
            )
            AND NOT EXISTS (SELECT 1 FROM players WHERE id = ?)
            AND NOT EXISTS (SELECT 1 FROM sessions WHERE player_id = ?)
            AND NOT EXISTS (SELECT 1 FROM attempts WHERE player_id = ?)
            AND NOT EXISTS (SELECT 1 FROM auth_flows WHERE player_id = ?)
          )`,
      ).bind(
        guardId,
        guardTokenHash,
        actor.channel,
        now,
        now + 1,
        now,
        actor.sessionId,
        actor.channel,
        now,
        actor.playerId,
        actor.playerId,
        actor.playerId,
        actor.playerId,
      ),
    ]);
  } catch (failure) {
    return await classifyDeletionOutcome(env, telegramActor, now, failure);
  }

  if (expectedBatchResults(results)) return guestResponse();

  const failure = new Error("Profile deletion changed an unexpected number of rows.");
  return await classifyDeletionOutcome(env, telegramActor, now, failure);
}
