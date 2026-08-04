export type AuthFlowChannel = "web" | "android";

export type AuthFlowRow = {
  id: string;
  guest_session_id: string;
  channel: AuthFlowChannel;
  nonce: string;
  pkce_verifier: string;
  expires_at: number;
  callback_claimed_at: number | null;
  player_id: string | null;
  handoff_expires_at: number | null;
};

export async function insertAuthFlow(
  db: D1Database,
  input: {
    id: string;
    stateHash: string;
    guestSessionId: string;
    channel: AuthFlowChannel;
    nonce: string;
    pkceVerifier: string;
    now: number;
    expiresAt: number;
  },
): Promise<{ created_at: number; expires_at: number } | null> {
  return await db
    .prepare(
      `INSERT INTO auth_flows
        (id, state_hash, guest_session_id, channel, nonce, pkce_verifier,
         expires_at, callback_claimed_at, player_id, handoff_hash,
         handoff_expires_at, handoff_consumed_at, handoff_session_id, created_at)
       SELECT ?, ?, s.id, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, ?
         FROM sessions s
        WHERE s.id = ?
          AND s.kind = 'guest'
          AND s.player_id IS NULL
          AND s.channel = ?
          AND s.revoked_at IS NULL
          AND s.expires_at > unixepoch()
       RETURNING created_at, expires_at`,
    )
    .bind(
      input.id,
      input.stateHash,
      input.channel,
      input.nonce,
      input.pkceVerifier,
      input.expiresAt,
      input.now,
      input.guestSessionId,
      input.channel,
    )
    .first<{ created_at: number; expires_at: number }>();
}

export async function claimAuthFlow(
  db: D1Database,
  stateHash: string,
  now: number,
): Promise<AuthFlowRow | null> {
  return await db
    .prepare(
      `UPDATE auth_flows
          SET callback_claimed_at = ?
        WHERE state_hash = ?
          AND callback_claimed_at IS NULL
          AND expires_at > ?
          AND EXISTS (
            SELECT 1
              FROM sessions original
             WHERE original.id = auth_flows.guest_session_id
               AND original.kind = 'guest'
               AND original.player_id IS NULL
               AND original.channel = auth_flows.channel
               AND original.revoked_at IS NULL
               AND original.expires_at > ?
          )
       RETURNING id, guest_session_id, channel, nonce, pkce_verifier, expires_at,
                 callback_claimed_at, player_id, handoff_expires_at`,
    )
    .bind(now, stateHash, now, now)
    .first<AuthFlowRow>();
}

export async function completeAuthFlow(
  db: D1Database,
  input: {
    flowId: string;
    playerId: string;
    handoffHash: string;
    handoffExpiresAt: number;
  },
): Promise<void> {
  const result = await db
    .prepare(
      `UPDATE auth_flows
          SET player_id = ?, handoff_hash = ?, handoff_expires_at = ?
        WHERE id = ?
          AND callback_claimed_at IS NOT NULL
          AND player_id IS NULL
          AND handoff_hash IS NULL
          AND handoff_expires_at IS NULL`,
    )
    .bind(input.playerId, input.handoffHash, input.handoffExpiresAt, input.flowId)
    .run();
  if (result.meta.changes !== 1) throw new Error("Auth flow completion failed.");
}

export async function findClaimableHandoff(
  db: D1Database,
  input: {
    handoffHash: string;
    guestSessionId: string;
    channel: AuthFlowChannel;
    now: number;
  },
): Promise<{ id: string; player_id: string } | null> {
  return await db
    .prepare(
      `SELECT flow.id, flow.player_id
         FROM auth_flows flow
         JOIN sessions original ON original.id = flow.guest_session_id
        WHERE flow.handoff_hash = ?
          AND flow.guest_session_id = ?
          AND flow.channel = ?
          AND flow.callback_claimed_at IS NOT NULL
          AND flow.handoff_consumed_at IS NULL
          AND flow.handoff_session_id IS NULL
          AND flow.handoff_expires_at > ?
          AND flow.player_id IS NOT NULL
          AND original.kind = 'guest'
          AND original.player_id IS NULL
          AND original.channel = flow.channel
          AND original.revoked_at IS NULL
          AND original.expires_at > ?
          AND NOT EXISTS (
            SELECT 1 FROM sessions successor
             WHERE successor.rotated_from_session_id = original.id
          )`,
    )
    .bind(input.handoffHash, input.guestSessionId, input.channel, input.now, input.now)
    .first<{ id: string; player_id: string }>();
}

export function claimHandoffForSession(
  db: D1Database,
  input: {
    flowId: string;
    handoffHash: string;
    guestSessionId: string;
    channel: AuthFlowChannel;
    replacementSessionId: string;
    now: number;
  },
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE auth_flows
          SET handoff_consumed_at = ?, handoff_session_id = ?
        WHERE id = ?
          AND handoff_hash = ?
          AND guest_session_id = ?
          AND channel = ?
          AND callback_claimed_at IS NOT NULL
          AND handoff_consumed_at IS NULL
          AND handoff_session_id IS NULL
          AND handoff_expires_at > ?
          AND player_id IS NOT NULL
          AND EXISTS (
            SELECT 1
              FROM sessions original
             WHERE original.id = auth_flows.guest_session_id
               AND original.kind = 'guest'
               AND original.player_id IS NULL
               AND original.channel = auth_flows.channel
               AND original.revoked_at IS NULL
               AND original.expires_at > ?
               AND NOT EXISTS (
                 SELECT 1 FROM sessions successor
                  WHERE successor.rotated_from_session_id = original.id
               )
          )`,
    )
    .bind(
      input.now,
      input.replacementSessionId,
      input.flowId,
      input.handoffHash,
      input.guestSessionId,
      input.channel,
      input.now,
      input.now,
    );
}
