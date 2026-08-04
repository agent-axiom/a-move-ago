import { type TelegramSessionIssued, TelegramSessionIssuedSchema } from "@a-move-ago/api-contract";
import type { VerifiedTelegramIdentity } from "../auth/types";
import { hashSessionToken, newOpaqueToken } from "../crypto/opaque-token";
import { prepareMiniAppPlayerUpsert } from "../db/players";
import type { Env, SessionActor } from "../env";
import { ApiError } from "../http/api-error";

const maxIsoDateSeconds = 253_402_300_799;

function sessionExpiry(env: Env, now: number): number {
  const ttl = Number(env.SESSION_TTL_SECONDS);
  if (!Number.isSafeInteger(ttl) || ttl <= 0) {
    throw new Error("SESSION_TTL_SECONDS must be a positive integer.");
  }
  const expiresAt = now + ttl;
  if (!Number.isSafeInteger(expiresAt) || expiresAt > maxIsoDateSeconds) {
    throw new Error("SESSION_TTL_SECONDS produces an unrepresentable expiry.");
  }
  return expiresAt;
}

function invalidSession(): ApiError {
  return new ApiError(401, "INVALID_SESSION", "The guest session is no longer active.");
}

async function classifyRotationFailure(
  env: Env,
  guest: SessionActor,
  error: unknown,
): Promise<never> {
  let successor: { id: string } | null;
  let original: { id: string } | null;
  try {
    successor = await env.DB.prepare("SELECT id FROM sessions WHERE rotated_from_session_id = ?")
      .bind(guest.sessionId)
      .first<{ id: string }>();
    original = await env.DB.prepare(
      `SELECT id FROM sessions
        WHERE id = ? AND kind = 'guest' AND player_id IS NULL AND channel = ?
          AND revoked_at IS NULL AND expires_at > unixepoch()`,
    )
      .bind(guest.sessionId, guest.channel)
      .first<{ id: string }>();
  } catch {
    throw error;
  }
  if (successor) throw invalidSession();
  if (!original) throw invalidSession();
  throw error;
}

export async function linkGuestToPlayer(
  env: Env,
  guest: SessionActor,
  identity: VerifiedTelegramIdentity,
  now: number,
): Promise<TelegramSessionIssued> {
  if (guest.kind !== "guest" || guest.playerId !== null || guest.channel !== "telegram") {
    throw new ApiError(409, "AUTH_REQUIRES_GUEST", "Start login from a Telegram guest session.");
  }

  const expiresAt = sessionExpiry(env, now);
  const token = newOpaqueToken();
  const sessionId = crypto.randomUUID();
  const candidatePlayerId = crypto.randomUUID();
  const tokenHash = await hashSessionToken(token, env.SESSION_PEPPER);
  const response = TelegramSessionIssuedSchema.parse({
    token,
    expiresAt: new Date(expiresAt * 1000).toISOString(),
    kind: "telegram",
    profile: {
      telegramUserId: identity.telegramUserId,
      displayName: identity.displayName,
      username: identity.username,
      avatarUrl: identity.avatarUrl,
    },
  });

  try {
    const results = await env.DB.batch([
      prepareMiniAppPlayerUpsert(env.DB, identity, candidatePlayerId, now),
      env.DB.prepare(
        `INSERT INTO sessions
          (id, player_id, token_hash, kind, channel, rotated_from_session_id,
           created_at, expires_at, revoked_at, last_seen_at)
         SELECT ?, p.id, ?, 'telegram', s.channel, s.id, ?, ?, NULL, ?
           FROM sessions s
           JOIN players p ON p.telegram_user_id = ?
          WHERE s.id = ?
            AND s.kind = 'guest'
            AND s.player_id IS NULL
            AND s.channel = 'telegram'
            AND s.revoked_at IS NULL
            AND s.expires_at > unixepoch()`,
      ).bind(sessionId, tokenHash, now, expiresAt, now, identity.telegramUserId, guest.sessionId),
      env.DB.prepare(
        `UPDATE attempts
            SET player_id = (SELECT id FROM players WHERE telegram_user_id = ?)
          WHERE session_id = ?
            AND player_id IS NULL
            AND EXISTS (
              SELECT 1 FROM sessions replacement
               WHERE replacement.id = ?
                 AND replacement.rotated_from_session_id = ?
                 AND replacement.player_id = (
                   SELECT id FROM players WHERE telegram_user_id = ?
                 )
            )`,
      ).bind(
        identity.telegramUserId,
        guest.sessionId,
        sessionId,
        guest.sessionId,
        identity.telegramUserId,
      ),
      env.DB.prepare(
        `UPDATE sessions
            SET revoked_at = ?
          WHERE id = ?
            AND kind = 'guest'
            AND player_id IS NULL
            AND channel = 'telegram'
            AND revoked_at IS NULL
            AND expires_at > unixepoch()
            AND EXISTS (
              SELECT 1 FROM sessions replacement
               WHERE replacement.id = ?
                 AND replacement.rotated_from_session_id = sessions.id
                 AND replacement.kind = 'telegram'
                 AND replacement.player_id = (
                   SELECT id FROM players WHERE telegram_user_id = ?
                 )
            )`,
      ).bind(now, guest.sessionId, sessionId, identity.telegramUserId),
      env.DB.prepare(
        `INSERT INTO sessions
          (id, player_id, token_hash, kind, channel, created_at, expires_at, last_seen_at)
         SELECT ?, NULL, ?, 'mini-app-transaction-guard', 'telegram', ?, ?, ?
          WHERE NOT (
            EXISTS (
              SELECT 1 FROM sessions original
               WHERE original.id = ?
                 AND original.kind = 'guest'
                 AND original.player_id IS NULL
                 AND original.channel = 'telegram'
                 AND original.revoked_at = ?
            )
            AND EXISTS (
              SELECT 1 FROM sessions replacement
               WHERE replacement.id = ?
                 AND replacement.rotated_from_session_id = ?
                 AND replacement.kind = 'telegram'
                 AND replacement.channel = 'telegram'
                 AND replacement.player_id = (
                   SELECT id FROM players WHERE telegram_user_id = ?
                 )
            )
            AND NOT EXISTS (
              SELECT 1 FROM attempts
               WHERE session_id = ? AND player_id IS NULL
            )
          )`,
      ).bind(
        crypto.randomUUID(),
        `guard:${sessionId}`,
        now,
        expiresAt,
        now,
        guest.sessionId,
        now,
        sessionId,
        guest.sessionId,
        identity.telegramUserId,
        guest.sessionId,
      ),
    ]);

    if (results.length !== 5) {
      throw new Error("Account link transaction returned an unexpected result count.");
    }
    const playerResult = results[0];
    const insertResult = results[1];
    const revokeResult = results[3];
    const guardResult = results[4];
    if (
      !playerResult ||
      !insertResult ||
      !revokeResult ||
      !guardResult ||
      playerResult.meta.changes !== 1 ||
      insertResult.meta.changes !== 1 ||
      revokeResult.meta.changes !== 1 ||
      guardResult.meta.changes !== 0
    ) {
      throw new Error("Account link transaction changed an unexpected number of rows.");
    }
  } catch (error) {
    await classifyRotationFailure(env, guest, error);
  }

  return response;
}
