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
