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

  let results: D1Result[];
  try {
    results = await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO sessions
          (id, player_id, token_hash, kind, channel, rotated_from_session_id,
           created_at, expires_at, revoked_at, last_seen_at)
         SELECT ?, NULL, ?, 'guest', ?, ?, ?, ?, NULL, ?
           FROM sessions
          WHERE id = ? AND revoked_at IS NULL AND expires_at > ?`,
      ).bind(
        replacementId,
        tokenHash,
        actor.channel,
        actor.sessionId,
        now,
        expiresAt,
        now,
        actor.sessionId,
        now,
      ),
      env.DB.prepare(
        "UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL AND expires_at > ?",
      ).bind(now, actor.sessionId, now),
    ]);
  } catch (error) {
    const successor = await env.DB.prepare(
      "SELECT id FROM sessions WHERE rotated_from_session_id = ?",
    )
      .bind(actor.sessionId)
      .first<{ id: string }>()
      .catch(() => null);
    if (successor) {
      throw new ApiError(401, "INVALID_SESSION", "The session is no longer active.");
    }
    throw error;
  }
  const insertResult = results[0];
  const revokeResult = results[1];
  if (!insertResult || !revokeResult) {
    throw new Error("Session rotation did not return both statement results.");
  }
  if (insertResult.meta.changes === 0 && revokeResult.meta.changes === 0) {
    throw new ApiError(401, "INVALID_SESSION", "The session is invalid or expired.");
  }
  if (insertResult.meta.changes !== 1 || revokeResult.meta.changes !== 1) {
    throw new Error("Session rotation changed an unexpected number of rows.");
  }

  return issuedGuest(token, expiresAt);
}
