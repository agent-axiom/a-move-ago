import type { TelegramProfile } from "@a-move-ago/api-contract";
import type { VerifiedTelegramIdentity } from "../auth/types";
import { ApiError } from "../http/api-error";

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

export type VerifiedOidcIdentity = VerifiedTelegramIdentity & {
  oidc: NonNullable<VerifiedTelegramIdentity["oidc"]>;
};

async function findPlayerByTelegramId(
  db: D1Database,
  telegramUserId: string,
): Promise<PlayerRow | null> {
  return await db
    .prepare(`SELECT ${returnedPlayerColumns} FROM players WHERE telegram_user_id = ?`)
    .bind(telegramUserId)
    .first<PlayerRow>();
}

async function findPlayerByOidcSubject(
  db: D1Database,
  issuer: string,
  subject: string,
): Promise<PlayerRow | null> {
  return await db
    .prepare(
      `SELECT ${returnedPlayerColumns}
         FROM players
        WHERE oidc_issuer = ? AND oidc_subject = ?`,
    )
    .bind(issuer, subject)
    .first<PlayerRow>();
}

function mappingMatches(row: PlayerRow, identity: VerifiedOidcIdentity): boolean {
  return (
    row.telegram_user_id === identity.telegramUserId &&
    row.oidc_issuer === identity.oidc.issuer &&
    row.oidc_subject === identity.oidc.subject &&
    row.oidc_audience === identity.oidc.audience
  );
}

function identityConflict(): never {
  throw new ApiError(409, "TELEGRAM_IDENTITY_CONFLICT", "Telegram identity is already linked.");
}

export async function upsertOidcPlayer(
  db: D1Database,
  identity: VerifiedOidcIdentity,
  now: number,
): Promise<PlayerRow> {
  const byTelegram = await findPlayerByTelegramId(db, identity.telegramUserId);
  const bySubject = await findPlayerByOidcSubject(db, identity.oidc.issuer, identity.oidc.subject);

  if (byTelegram && bySubject && byTelegram.id !== bySubject.id) identityConflict();
  if (bySubject && bySubject.telegram_user_id !== identity.telegramUserId) identityConflict();

  if (byTelegram) {
    const hasStoredOidc =
      byTelegram.oidc_issuer !== null ||
      byTelegram.oidc_subject !== null ||
      byTelegram.oidc_audience !== null;
    if (hasStoredOidc && !mappingMatches(byTelegram, identity)) identityConflict();

    let row: PlayerRow | null;
    try {
      row = await db
        .prepare(
          `UPDATE players
              SET oidc_issuer = ?, oidc_subject = ?, oidc_audience = ?,
                  display_name = ?, username = ?, avatar_url = ?, updated_at = ?
            WHERE id = ?
              AND (
                (oidc_issuer IS NULL AND oidc_subject IS NULL AND oidc_audience IS NULL)
                OR (oidc_issuer = ? AND oidc_subject = ? AND oidc_audience = ?)
              )
         RETURNING ${returnedPlayerColumns}`,
        )
        .bind(
          identity.oidc.issuer,
          identity.oidc.subject,
          identity.oidc.audience,
          identity.displayName,
          identity.username,
          identity.avatarUrl,
          now,
          byTelegram.id,
          identity.oidc.issuer,
          identity.oidc.subject,
          identity.oidc.audience,
        )
        .first<PlayerRow>();
    } catch (error) {
      const concurrentSubject = await findPlayerByOidcSubject(
        db,
        identity.oidc.issuer,
        identity.oidc.subject,
      );
      if (concurrentSubject && concurrentSubject.id !== byTelegram.id) identityConflict();
      throw error;
    }
    if (!row) identityConflict();
    return row;
  }

  if (bySubject) identityConflict();
  try {
    const row = await db
      .prepare(
        `INSERT INTO players
          (id, telegram_user_id, oidc_issuer, oidc_subject, oidc_audience,
           display_name, username, avatar_url, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         RETURNING ${returnedPlayerColumns}`,
      )
      .bind(
        crypto.randomUUID(),
        identity.telegramUserId,
        identity.oidc.issuer,
        identity.oidc.subject,
        identity.oidc.audience,
        identity.displayName,
        identity.username,
        identity.avatarUrl,
        now,
        now,
      )
      .first<PlayerRow>();
    if (!row) throw new Error("Player upsert returned no row.");
    return row;
  } catch (error) {
    const concurrentByTelegram = await findPlayerByTelegramId(db, identity.telegramUserId);
    const concurrentBySubject = await findPlayerByOidcSubject(
      db,
      identity.oidc.issuer,
      identity.oidc.subject,
    );
    if (
      concurrentByTelegram &&
      mappingMatches(concurrentByTelegram, identity) &&
      (!concurrentBySubject || concurrentBySubject.id === concurrentByTelegram.id)
    ) {
      return concurrentByTelegram;
    }
    if (concurrentByTelegram || concurrentBySubject) identityConflict();
    throw error;
  }
}

export async function completeOidcPlayerAndAuthFlow(
  db: D1Database,
  identity: VerifiedOidcIdentity,
  now: number,
  completion: {
    flowId: string;
    handoffHash: string;
    handoffExpiresAt: number;
  },
): Promise<PlayerRow> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const byTelegram = await findPlayerByTelegramId(db, identity.telegramUserId);
    const bySubject = await findPlayerByOidcSubject(
      db,
      identity.oidc.issuer,
      identity.oidc.subject,
    );
    if (byTelegram && bySubject && byTelegram.id !== bySubject.id) identityConflict();
    if (bySubject && bySubject.telegram_user_id !== identity.telegramUserId) identityConflict();

    let playerId: string;
    let playerMutation: D1PreparedStatement;
    if (byTelegram) {
      const hasStoredOidc =
        byTelegram.oidc_issuer !== null ||
        byTelegram.oidc_subject !== null ||
        byTelegram.oidc_audience !== null;
      if (hasStoredOidc && !mappingMatches(byTelegram, identity)) identityConflict();
      playerId = byTelegram.id;
      playerMutation = db
        .prepare(
          `UPDATE players
              SET oidc_issuer = ?, oidc_subject = ?, oidc_audience = ?,
                  display_name = ?, username = ?, avatar_url = ?, updated_at = ?
            WHERE id = ?
              AND telegram_user_id = ?
              AND (
                (oidc_issuer IS NULL AND oidc_subject IS NULL AND oidc_audience IS NULL)
                OR (oidc_issuer = ? AND oidc_subject = ? AND oidc_audience = ?)
              )`,
        )
        .bind(
          identity.oidc.issuer,
          identity.oidc.subject,
          identity.oidc.audience,
          identity.displayName,
          identity.username,
          identity.avatarUrl,
          now,
          playerId,
          identity.telegramUserId,
          identity.oidc.issuer,
          identity.oidc.subject,
          identity.oidc.audience,
        );
    } else {
      if (bySubject) identityConflict();
      playerId = crypto.randomUUID();
      playerMutation = db
        .prepare(
          `INSERT INTO players
            (id, telegram_user_id, oidc_issuer, oidc_subject, oidc_audience,
             display_name, username, avatar_url, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          playerId,
          identity.telegramUserId,
          identity.oidc.issuer,
          identity.oidc.subject,
          identity.oidc.audience,
          identity.displayName,
          identity.username,
          identity.avatarUrl,
          now,
          now,
        );
    }

    try {
      const results = await db.batch([
        playerMutation,
        db
          .prepare(
            `UPDATE auth_flows
                SET player_id = ?, handoff_hash = ?, handoff_expires_at = ?
              WHERE id = ?
                AND changes() = 1
                AND callback_claimed_at IS NOT NULL
                AND player_id IS NULL
                AND handoff_hash IS NULL
                AND handoff_expires_at IS NULL
                AND EXISTS (
                  SELECT 1 FROM players
                   WHERE id = ?
                     AND telegram_user_id = ?
                     AND oidc_issuer = ?
                     AND oidc_subject = ?
                     AND oidc_audience = ?
                )`,
          )
          .bind(
            playerId,
            completion.handoffHash,
            completion.handoffExpiresAt,
            completion.flowId,
            playerId,
            identity.telegramUserId,
            identity.oidc.issuer,
            identity.oidc.subject,
            identity.oidc.audience,
          ),
        db
          .prepare(
            `UPDATE players
                SET telegram_user_id = CASE
                  WHEN telegram_user_id = ?
                   AND oidc_issuer = ?
                   AND oidc_subject = ?
                   AND oidc_audience = ?
                   AND EXISTS (
                     SELECT 1 FROM auth_flows
                      WHERE id = ?
                        AND callback_claimed_at IS NOT NULL
                        AND player_id = players.id
                        AND handoff_hash = ?
                        AND handoff_expires_at = ?
                   )
                  THEN telegram_user_id
                  ELSE NULL
                END
              WHERE id = ?`,
          )
          .bind(
            identity.telegramUserId,
            identity.oidc.issuer,
            identity.oidc.subject,
            identity.oidc.audience,
            completion.flowId,
            completion.handoffHash,
            completion.handoffExpiresAt,
            playerId,
          ),
        db
          .prepare(
            `INSERT INTO sessions
              (id, player_id, token_hash, kind, channel,
               created_at, expires_at, revoked_at, last_seen_at)
             SELECT ?, NULL, ?, 'oidc-identity-transaction-guard', 'web',
                    ?, ?, NULL, ?
              WHERE NOT EXISTS (
                SELECT 1
                  FROM players player
                  JOIN auth_flows flow ON flow.player_id = player.id
                 WHERE player.id = ?
                   AND player.telegram_user_id = ?
                   AND player.oidc_issuer = ?
                   AND player.oidc_subject = ?
                   AND player.oidc_audience = ?
                   AND player.display_name = ?
                   AND player.username IS ?
                   AND player.avatar_url IS ?
                   AND player.updated_at = ?
                   AND flow.id = ?
                   AND flow.callback_claimed_at IS NOT NULL
                   AND flow.handoff_hash = ?
                   AND flow.handoff_expires_at = ?
              )`,
          )
          .bind(
            crypto.randomUUID(),
            `oidc-guard:${completion.flowId}:${attempt}`,
            now,
            completion.handoffExpiresAt,
            now,
            playerId,
            identity.telegramUserId,
            identity.oidc.issuer,
            identity.oidc.subject,
            identity.oidc.audience,
            identity.displayName,
            identity.username,
            identity.avatarUrl,
            now,
            completion.flowId,
            completion.handoffHash,
            completion.handoffExpiresAt,
          ),
      ]);
      const playerResult = results[0];
      const flowResult = results[1];
      const playerGuardResult = results[2];
      const transactionGuardResult = results[3];
      if (
        results.length === 4 &&
        playerResult?.meta.changes === 1 &&
        flowResult?.meta.changes === 1 &&
        playerGuardResult?.meta.changes === 1 &&
        transactionGuardResult?.meta.changes === 0
      ) {
        return {
          id: playerId,
          telegram_user_id: identity.telegramUserId,
          oidc_issuer: identity.oidc.issuer,
          oidc_subject: identity.oidc.subject,
          oidc_audience: identity.oidc.audience,
          display_name: identity.displayName,
          username: identity.username,
          avatar_url: identity.avatarUrl,
        };
      }
      lastError = new Error("OIDC identity transaction changed an unexpected number of rows.");
    } catch (error) {
      lastError = error;
    }

    const concurrentByTelegram = await findPlayerByTelegramId(db, identity.telegramUserId);
    const concurrentBySubject = await findPlayerByOidcSubject(
      db,
      identity.oidc.issuer,
      identity.oidc.subject,
    );
    const exactConvergence =
      concurrentByTelegram &&
      mappingMatches(concurrentByTelegram, identity) &&
      (!concurrentBySubject || concurrentBySubject.id === concurrentByTelegram.id);
    const unchangedUnclaimedPlayer =
      byTelegram !== null &&
      concurrentByTelegram?.id === byTelegram.id &&
      concurrentByTelegram.oidc_issuer === null &&
      concurrentByTelegram.oidc_subject === null &&
      concurrentByTelegram.oidc_audience === null &&
      concurrentBySubject === null;
    const deletedBeforeCompletion =
      byTelegram !== null && concurrentByTelegram === null && concurrentBySubject === null;
    if ((exactConvergence || unchangedUnclaimedPlayer || deletedBeforeCompletion) && attempt === 0)
      continue;
    if (exactConvergence || unchangedUnclaimedPlayer) throw lastError;
    if (concurrentByTelegram || concurrentBySubject) identityConflict();
    throw lastError;
  }
  throw lastError ?? new Error("OIDC identity transaction failed.");
}
