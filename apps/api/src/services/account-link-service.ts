import { type TelegramSessionIssued, TelegramSessionIssuedSchema } from "@a-move-ago/api-contract";
import type { VerifiedTelegramIdentity } from "../auth/types";
import { hashSessionToken, newOpaqueToken } from "../crypto/opaque-token";
import {
  type AuthFlowChannel,
  claimHandoffForSession,
  findClaimableHandoff,
} from "../db/auth-flows";
import { findPlayer, prepareMiniAppPlayerUpsert, toTelegramProfile } from "../db/players";
import { transferClueStatement } from "../db/gameplay";
import type { Env, SessionActor } from "../env";
import { ApiError } from "../http/api-error";

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
      transferClueStatement(env.DB, guest.sessionId, sessionId, null),
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
            AND NOT EXISTS (
              SELECT 1 FROM gameplay_events WHERE kind = 'clue' AND clue_session_id = ?
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
        guest.sessionId,
      ),
    ]);

    if (results.length !== 6) {
      throw new Error("Account link transaction returned an unexpected result count.");
    }
    const playerResult = results[0];
    const insertResult = results[1];
    const revokeResult = results[4];
    const guardResult = results[5];
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

function invalidHandoff(): ApiError {
  return new ApiError(401, "HANDOFF_INVALID", "The login handoff is invalid or expired.");
}

async function classifyHandoffFailure(
  env: Env,
  input: {
    flowId: string;
    handoffHash: string;
    guestSessionId: string;
    channel: AuthFlowChannel;
    now: number;
  },
  error: unknown,
): Promise<never> {
  let claimable: { id: string } | null;
  let successor: { id: string } | null;
  try {
    claimable = await env.DB.prepare(
      `SELECT flow.id
         FROM auth_flows flow
         JOIN sessions original ON original.id = flow.guest_session_id
        WHERE flow.id = ?
          AND flow.handoff_hash = ?
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
            SELECT 1 FROM sessions replacement
             WHERE replacement.rotated_from_session_id = original.id
          )`,
    )
      .bind(
        input.flowId,
        input.handoffHash,
        input.guestSessionId,
        input.channel,
        input.now,
        input.now,
      )
      .first<{ id: string }>();
    successor = await env.DB.prepare("SELECT id FROM sessions WHERE rotated_from_session_id = ?")
      .bind(input.guestSessionId)
      .first<{ id: string }>();
  } catch {
    throw error;
  }
  if (!claimable || successor) throw invalidHandoff();
  throw error;
}

export async function exchangeHandoffAndLinkGuest(
  env: Env,
  guest: SessionActor,
  input: { handoffHash: string; channel: AuthFlowChannel },
  now: number,
): Promise<TelegramSessionIssued> {
  if (
    guest.kind !== "guest" ||
    guest.playerId !== null ||
    guest.channel === "telegram" ||
    guest.channel !== input.channel
  ) {
    throw new ApiError(409, "AUTH_REQUIRES_GUEST", "Exchange requires the original guest session.");
  }

  const expiresAt = sessionExpiry(env, now);
  const flow = await findClaimableHandoff(env.DB, {
    handoffHash: input.handoffHash,
    guestSessionId: guest.sessionId,
    channel: input.channel,
    now,
  });
  if (!flow) throw invalidHandoff();
  const player = await findPlayer(env.DB, flow.player_id);
  if (!player) throw invalidHandoff();

  const token = newOpaqueToken();
  const replacementSessionId = crypto.randomUUID();
  const tokenHash = await hashSessionToken(token, env.SESSION_PEPPER);
  const response = TelegramSessionIssuedSchema.parse({
    token,
    expiresAt: new Date(expiresAt * 1000).toISOString(),
    kind: "telegram",
    profile: toTelegramProfile(player),
  });
  const claim = claimHandoffForSession(env.DB, {
    flowId: flow.id,
    handoffHash: input.handoffHash,
    guestSessionId: guest.sessionId,
    channel: input.channel,
    replacementSessionId,
    now,
  });

  let results: D1Result[] | undefined;
  try {
    results = await env.DB.batch([
      claim,
      env.DB.prepare(
        `INSERT INTO sessions
          (id, player_id, token_hash, kind, channel, rotated_from_session_id,
           created_at, expires_at, revoked_at, last_seen_at)
         SELECT ?, flow.player_id, ?, 'telegram', flow.channel, original.id,
                ?, ?, NULL, ?
           FROM auth_flows flow
           JOIN sessions original ON original.id = flow.guest_session_id
          WHERE flow.id = ?
            AND flow.player_id = ?
            AND flow.handoff_hash = ?
            AND flow.handoff_session_id = ?
            AND flow.handoff_consumed_at IS NOT NULL
            AND flow.guest_session_id = ?
            AND flow.channel = ?
            AND original.kind = 'guest'
            AND original.player_id IS NULL
            AND original.channel = flow.channel
            AND original.revoked_at IS NULL
            AND original.expires_at > ?
            AND NOT EXISTS (
              SELECT 1 FROM sessions successor
               WHERE successor.rotated_from_session_id = original.id
            )`,
      ).bind(
        replacementSessionId,
        tokenHash,
        now,
        expiresAt,
        now,
        flow.id,
        player.id,
        input.handoffHash,
        replacementSessionId,
        guest.sessionId,
        input.channel,
        now,
      ),
      env.DB.prepare(
        `UPDATE attempts
            SET player_id = ?
          WHERE session_id = ?
            AND player_id IS NULL
            AND EXISTS (
              SELECT 1
                FROM sessions replacement
                JOIN auth_flows flow ON flow.handoff_session_id = replacement.id
               WHERE replacement.id = ?
                 AND replacement.rotated_from_session_id = ?
                 AND replacement.kind = 'telegram'
                 AND replacement.channel = ?
                 AND replacement.player_id = ?
                 AND flow.id = ?
                 AND flow.handoff_hash = ?
                 AND flow.guest_session_id = ?
                 AND flow.channel = ?
                 AND flow.player_id = replacement.player_id
                 AND flow.handoff_consumed_at IS NOT NULL
            )`,
      ).bind(
        player.id,
        guest.sessionId,
        replacementSessionId,
        guest.sessionId,
        input.channel,
        player.id,
        flow.id,
        input.handoffHash,
        guest.sessionId,
        input.channel,
      ),
      transferClueStatement(env.DB, guest.sessionId, replacementSessionId, player.id),
      env.DB.prepare(
        `UPDATE sessions
            SET revoked_at = ?,
                kind = CASE
                  WHEN kind = 'guest'
                   AND player_id IS NULL
                   AND channel = ?
                   AND revoked_at IS NULL
                   AND expires_at > ?
                   AND EXISTS (
                     SELECT 1
                       FROM sessions replacement
                       JOIN auth_flows flow ON flow.handoff_session_id = replacement.id
                      WHERE replacement.id = ?
                        AND replacement.rotated_from_session_id = sessions.id
                        AND replacement.kind = 'telegram'
                        AND replacement.channel = ?
                        AND replacement.player_id = ?
                        AND flow.id = ?
                        AND flow.handoff_hash = ?
                        AND flow.guest_session_id = sessions.id
                        AND flow.channel = ?
                        AND flow.player_id = replacement.player_id
                        AND flow.handoff_consumed_at IS NOT NULL
                   )
                   AND NOT EXISTS (
                     SELECT 1 FROM attempts
                      WHERE session_id = sessions.id
                        AND (player_id IS NULL OR player_id <> ?)
                   )
                  THEN 'guest'
                  ELSE 'handoff-transaction-guard'
                END
          WHERE id = ?`,
      ).bind(
        now,
        input.channel,
        now,
        replacementSessionId,
        input.channel,
        player.id,
        flow.id,
        input.handoffHash,
        input.channel,
        player.id,
        guest.sessionId,
      ),
      env.DB.prepare(
        `INSERT INTO sessions
          (id, player_id, token_hash, kind, channel,
           created_at, expires_at, revoked_at, last_seen_at)
         SELECT ?, NULL, ?, 'handoff-transaction-guard', ?, ?, ?, NULL, ?
          WHERE NOT (
            EXISTS (
              SELECT 1
                FROM auth_flows flow
                JOIN sessions replacement ON replacement.id = flow.handoff_session_id
               WHERE flow.id = ?
                 AND flow.handoff_hash = ?
                 AND flow.guest_session_id = ?
                 AND flow.channel = ?
                 AND flow.player_id = ?
                 AND flow.handoff_consumed_at = ?
                 AND replacement.id = ?
                 AND replacement.rotated_from_session_id = flow.guest_session_id
                 AND replacement.kind = 'telegram'
                 AND replacement.channel = flow.channel
                 AND replacement.player_id = flow.player_id
            )
            AND EXISTS (
              SELECT 1 FROM sessions original
               WHERE original.id = ?
                 AND original.kind = 'guest'
                 AND original.player_id IS NULL
                 AND original.channel = ?
                 AND original.revoked_at = ?
            )
            AND NOT EXISTS (
              SELECT 1 FROM attempts
               WHERE session_id = ?
                 AND (player_id IS NULL OR player_id <> ?)
            )
            AND NOT EXISTS (
              SELECT 1 FROM gameplay_events WHERE kind = 'clue' AND clue_session_id = ?
            )
          )`,
      ).bind(
        crypto.randomUUID(),
        `handoff-guard:${replacementSessionId}`,
        input.channel,
        now,
        expiresAt,
        now,
        flow.id,
        input.handoffHash,
        guest.sessionId,
        input.channel,
        player.id,
        now,
        replacementSessionId,
        guest.sessionId,
        input.channel,
        now,
        guest.sessionId,
        player.id,
        guest.sessionId,
      ),
    ]);
  } catch (error) {
    await classifyHandoffFailure(
      env,
      {
        flowId: flow.id,
        handoffHash: input.handoffHash,
        guestSessionId: guest.sessionId,
        channel: input.channel,
        now,
      },
      error,
    );
  }

  if (results?.length !== 6) {
    throw new Error("Handoff transaction returned an unexpected result count.");
  }
  const claimResult = results[0];
  const insertResult = results[1];
  const revokeResult = results[4];
  const guardResult = results[5];
  if (
    !claimResult ||
    !insertResult ||
    !revokeResult ||
    !guardResult ||
    claimResult.meta.changes !== 1 ||
    insertResult.meta.changes !== 1 ||
    revokeResult.meta.changes !== 1 ||
    guardResult.meta.changes !== 0
  ) {
    throw invalidHandoff();
  }

  return response;
}
