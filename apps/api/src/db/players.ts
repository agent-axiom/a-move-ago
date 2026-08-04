import type { TelegramProfile } from "@a-move-ago/api-contract";
import type { VerifiedTelegramIdentity } from "../auth/types";

export type PlayerRow = {
  id: string;
  telegram_user_id: string;
  oidc_issuer: string | null;
  oidc_subject: string | null;
  oidc_audience: string | null;
  display_name: string;
  username: string | null;
  avatar_url: string | null;
};

const returnedPlayerColumns = `id, telegram_user_id, oidc_issuer, oidc_subject, oidc_audience,
  display_name, username, avatar_url`;

export function toTelegramProfile(row: PlayerRow): TelegramProfile {
  return {
    telegramUserId: row.telegram_user_id,
    displayName: row.display_name,
    username: row.username,
    avatarUrl: row.avatar_url,
  };
}

export function prepareMiniAppPlayerUpsert(
  db: D1Database,
  identity: VerifiedTelegramIdentity,
  playerId: string,
  now: number,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO players
        (id, telegram_user_id, oidc_issuer, oidc_subject, oidc_audience,
         display_name, username, avatar_url, created_at, updated_at)
       VALUES (?, ?, NULL, NULL, NULL, ?, ?, ?, ?, ?)
       ON CONFLICT(telegram_user_id) DO UPDATE SET
         display_name = excluded.display_name,
         username = excluded.username,
         avatar_url = excluded.avatar_url,
         updated_at = excluded.updated_at
       RETURNING ${returnedPlayerColumns}`,
    )
    .bind(
      playerId,
      identity.telegramUserId,
      identity.displayName,
      identity.username,
      identity.avatarUrl,
      now,
      now,
    );
}

export async function upsertMiniAppPlayer(
  db: D1Database,
  identity: VerifiedTelegramIdentity,
  now: number,
): Promise<PlayerRow> {
  const row = await prepareMiniAppPlayerUpsert(
    db,
    identity,
    crypto.randomUUID(),
    now,
  ).first<PlayerRow>();
  if (!row) throw new Error("Player upsert returned no row.");
  return row;
}

export async function findPlayer(db: D1Database, playerId: string): Promise<PlayerRow | null> {
  return await db
    .prepare(`SELECT ${returnedPlayerColumns} FROM players WHERE id = ?`)
    .bind(playerId)
    .first<PlayerRow>();
}
