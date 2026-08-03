export type SessionRow = {
  id: string;
  player_id: string | null;
  kind: "guest" | "telegram";
  channel: "web" | "telegram" | "android";
  expires_at: number;
  revoked_at: number | null;
};

export async function insertGuestSession(
  db: D1Database,
  input: {
    id: string;
    tokenHash: string;
    channel: SessionRow["channel"];
    now: number;
    expiresAt: number;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO sessions
        (id, player_id, token_hash, kind, channel, created_at, expires_at, revoked_at, last_seen_at)
       VALUES (?, NULL, ?, 'guest', ?, ?, ?, NULL, ?)`,
    )
    .bind(input.id, input.tokenHash, input.channel, input.now, input.expiresAt, input.now)
    .run();
}

export async function findActiveSession(db: D1Database, tokenHash: string, now: number) {
  return db
    .prepare(
      `SELECT id, player_id, kind, channel, expires_at, revoked_at
         FROM sessions
        WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?`,
    )
    .bind(tokenHash, now)
    .first<SessionRow>();
}
