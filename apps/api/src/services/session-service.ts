import { SessionIssuedSchema } from "@a-move-ago/api-contract";
import type { z } from "zod";
import { hashSessionToken, newOpaqueToken } from "../crypto/opaque-token";
import { insertGuestSession, type SessionRow } from "../db/sessions";
import type { Env, SessionActor } from "../env";
import { ApiError } from "../http/api-error";

type SessionIssued = z.infer<typeof SessionIssuedSchema>;
const maxIsoDateSeconds = 253_402_300_799;

function sessionExpiry(env: Env, now: number): number {
  const ttl = Number(env.SESSION_TTL_SECONDS);
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new Error("Session time must be a non-negative safe integer.");
  }
  if (!Number.isSafeInteger(ttl) || ttl <= 0) {
    throw new Error("SESSION_TTL_SECONDS must be a positive integer.");
  }
  const expiresAt = now + ttl;
  if (!Number.isSafeInteger(expiresAt) || expiresAt > maxIsoDateSeconds) {
    throw new Error("SESSION_TTL_SECONDS produces an unrepresentable expiry.");
  }
  return expiresAt;
}

function issuedGuest(token: string, expiresAt: number): SessionIssued {
  return SessionIssuedSchema.parse({
    token,
    expiresAt: new Date(expiresAt * 1000).toISOString(),
    kind: "guest",
  });
}

function invalidSession(): ApiError {
  return new ApiError(401, "INVALID_SESSION", "The session is no longer active.");
}

async function classifyLogoutFailure(
  env: Env,
  actor: SessionActor,
  now: number,
  error: unknown,
): Promise<never> {
  let successor: { id: string } | null;
  let original: { id: string } | null;
  try {
    successor = await env.DB.prepare("SELECT id FROM sessions WHERE rotated_from_session_id = ?")
      .bind(actor.sessionId)
      .first<{ id: string }>();
    original = await env.DB.prepare(
      `SELECT id FROM sessions
        WHERE id = ?
          AND kind = ?
          AND player_id IS ?
          AND channel = ?
          AND revoked_at IS NULL
          AND expires_at > ?`,
    )
      .bind(actor.sessionId, actor.kind, actor.playerId, actor.channel, now)
      .first<{ id: string }>();
  } catch {
    throw error;
  }
  if (successor || !original) throw invalidSession();
  throw error;
}

export async function issueGuest(
  env: Env,
  channel: SessionRow["channel"],
  now: number,
): Promise<SessionIssued> {
  const expiresAt = sessionExpiry(env, now);
  const token = newOpaqueToken();
  await insertGuestSession(env.DB, {
    id: crypto.randomUUID(),
    tokenHash: await hashSessionToken(token, env.SESSION_PEPPER),
    channel,
    now,
    expiresAt,
  });
  return issuedGuest(token, expiresAt);
}

export async function logoutToGuest(
  env: Env,
  actor: SessionActor,
  now: number,
): Promise<SessionIssued> {
  const expiresAt = sessionExpiry(env, now);
  const token = newOpaqueToken();
  const tokenHash = await hashSessionToken(token, env.SESSION_PEPPER);
  const replacementId = crypto.randomUUID();
  const response = issuedGuest(token, expiresAt);

  let results: D1Result[] | undefined;
  try {
    results = await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO sessions
          (id, player_id, token_hash, kind, channel, rotated_from_session_id,
           created_at, expires_at, revoked_at, last_seen_at)
         SELECT ?, NULL, ?, 'guest', ?, ?, ?, ?, NULL, ?
           FROM sessions
          WHERE id = ?
            AND kind = ?
            AND player_id IS ?
            AND channel = ?
            AND revoked_at IS NULL
            AND expires_at > ?`,
      ).bind(
        replacementId,
        tokenHash,
        actor.channel,
        actor.sessionId,
        now,
        expiresAt,
        now,
        actor.sessionId,
        actor.kind,
        actor.playerId,
        actor.channel,
        now,
      ),
      env.DB.prepare(
        `UPDATE sessions
            SET revoked_at = ?
          WHERE id = ?
            AND kind = ?
            AND player_id IS ?
            AND channel = ?
            AND revoked_at IS NULL
            AND expires_at > ?`,
      ).bind(now, actor.sessionId, actor.kind, actor.playerId, actor.channel, now),
      env.DB.prepare(
        `INSERT INTO sessions
          (id, player_id, token_hash, kind, channel,
           created_at, expires_at, revoked_at, last_seen_at)
         SELECT ?, NULL, ?, 'logout-transaction-guard', ?, ?, ?, NULL, ?
          WHERE NOT (
            EXISTS (
              SELECT 1 FROM sessions replacement
               WHERE replacement.id = ?
                 AND replacement.kind = 'guest'
                 AND replacement.player_id IS NULL
                 AND replacement.channel = ?
                 AND replacement.rotated_from_session_id = ?
            )
            AND EXISTS (
              SELECT 1 FROM sessions original
               WHERE original.id = ?
                 AND original.kind = ?
                 AND original.player_id IS ?
                 AND original.channel = ?
                 AND original.revoked_at = ?
            )
          )`,
      ).bind(
        crypto.randomUUID(),
        `logout-guard:${replacementId}`,
        actor.channel,
        now,
        expiresAt,
        now,
        replacementId,
        actor.channel,
        actor.sessionId,
        actor.sessionId,
        actor.kind,
        actor.playerId,
        actor.channel,
        now,
      ),
    ]);
  } catch (error) {
    await classifyLogoutFailure(env, actor, now, error);
  }
  if (results?.length !== 3) {
    throw new Error("Session rotation returned an unexpected result count.");
  }
  const insertResult = results[0];
  const revokeResult = results[1];
  const guardResult = results[2];
  if (
    !insertResult ||
    !revokeResult ||
    !guardResult ||
    insertResult.meta.changes !== 1 ||
    revokeResult.meta.changes !== 1 ||
    guardResult.meta.changes !== 0
  ) {
    throw new Error("Session rotation changed an unexpected number of rows.");
  }

  return response;
}
