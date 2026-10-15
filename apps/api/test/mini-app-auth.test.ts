import { ErrorEnvelopeSchema, TelegramSessionIssuedSchema } from "@a-move-ago/api-contract";
import { beforeEach, describe, expect, it } from "vitest";
import type { Env, RateLimitBinding } from "../src/env";
import { linkGuestToPlayer } from "../src/services/account-link-service";
import { signedMiniAppData } from "./fixtures/telegram";
import { authenticatedJson, issueGuest, resetDatabase, seedAttempt, testEnv } from "./helpers/http";

function authEnv(limiter: RateLimitBinding): Env {
  return overrideEnv({ AUTH_RATE_LIMITER: limiter });
}

function overrideEnv(bindings: Partial<Env>): Env {
  const requestEnv = Object.create(testEnv) as Env;
  for (const [key, value] of Object.entries(bindings)) {
    Object.defineProperty(requestEnv, key, { configurable: true, enumerable: true, value });
  }
  return requestEnv;
}

async function validInitData(user?: Record<string, unknown>) {
  return await signedMiniAppData({
    botToken: testEnv.TELEGRAM_BOT_TOKEN,
    authDate: Math.floor(Date.now() / 1000),
    ...(user ? { user } : {}),
  });
}

describe("POST /v1/auth/telegram/mini-app", () => {
  beforeEach(resetDatabase);

  it("links verified progress, returns the profile, and revokes the guest token", async () => {
    const guest = await issueGuest("telegram");
    await seedAttempt({ sessionId: guest.sessionId, attemptId: "attempt-before-login" });

    const login = await authenticatedJson("/v1/auth/telegram/mini-app", guest.token, {
      method: "POST",
      body: { initData: await validInitData() },
    });

    expect(login.response.status).toBe(200);
    expect(login.response.headers.get("cache-control")).toBe("no-store");
    const issued = TelegramSessionIssuedSchema.parse(login.body);
    expect(issued).toMatchObject({
      kind: "telegram",
      profile: {
        telegramUserId: "987654321",
        displayName: "Ada Lovelace",
        username: "ada",
        avatarUrl: "https://cdn.example/avatar.jpg",
      },
    });
    expect(issued.token).not.toBe(guest.token);

    const attempt = await testEnv.DB.prepare(
      "SELECT session_id, player_id FROM attempts WHERE id = ?",
    )
      .bind("attempt-before-login")
      .first<{ session_id: string | null; player_id: string | null }>();
    expect(attempt?.session_id).toBe(guest.sessionId);
    expect(attempt?.player_id).toMatch(/^[0-9a-f-]{36}$/);
    expect((await authenticatedJson("/v1/me", guest.token)).response.status).toBe(401);
    expect((await authenticatedJson("/v1/me", issued.token)).body).toEqual({
      kind: "telegram",
      profile: issued.profile,
    });

    const sessions = await testEnv.DB.prepare(
      `SELECT id, player_id, kind, channel, rotated_from_session_id, revoked_at
         FROM sessions ORDER BY created_at`,
    ).all<{
      id: string;
      player_id: string | null;
      kind: string;
      channel: string;
      rotated_from_session_id: string | null;
      revoked_at: number | null;
    }>();
    expect(sessions.results).toHaveLength(2);
    expect(sessions.results[0]).toMatchObject({
      id: guest.sessionId,
      player_id: null,
      kind: "guest",
      channel: "telegram",
    });
    expect(sessions.results[0]?.revoked_at).not.toBeNull();
    expect(sessions.results[1]).toMatchObject({
      player_id: attempt?.player_id,
      kind: "telegram",
      channel: "telegram",
      rotated_from_session_id: guest.sessionId,
      revoked_at: null,
    });
  });

  it("keeps the guest session and database intact when proof verification fails", async () => {
    const guest = await issueGuest("telegram");
    const login = await authenticatedJson("/v1/auth/telegram/mini-app", guest.token, {
      method: "POST",
      body: { initData: "auth_date=1&hash=00" },
    });

    expect(login.response.status).toBe(401);
    expect(ErrorEnvelopeSchema.parse(login.body).error.code).toBe("TELEGRAM_PROOF_INVALID");
    expect((await authenticatedJson("/v1/me", guest.token)).response.status).toBe(200);
    expect(
      (await testEnv.DB.prepare("SELECT count(*) AS count FROM players").first<{ count: number }>())
        ?.count,
    ).toBe(0);
    expect(
      (
        await testEnv.DB.prepare("SELECT count(*) AS count FROM sessions").first<{
          count: number;
        }>()
      )?.count,
    ).toBe(1);
  });

  it("rejects a non-Telegram guest channel before parsing or rate limiting", async () => {
    const guest = await issueGuest("web");
    const keys: string[] = [];
    const response = await authenticatedJson(
      "/v1/auth/telegram/mini-app",
      guest.token,
      { method: "POST", body: "{" },
      authEnv({
        limit: async ({ key }) => {
          keys.push(key);
          return { success: true };
        },
      }),
    );

    expect(response.response.status).toBe(409);
    expect(ErrorEnvelopeSchema.parse(response.body).error.code).toBe("AUTH_CHANNEL_MISMATCH");
    expect(keys).toEqual([]);
  });

  it("uses an internal session identifier for auth limiting and denies before parsing", async () => {
    const guest = await issueGuest("telegram");
    const keys: string[] = [];
    const response = await authenticatedJson(
      "/v1/auth/telegram/mini-app",
      guest.token,
      { method: "POST", body: "{" },
      authEnv({
        limit: async ({ key }) => {
          keys.push(key);
          return { success: false };
        },
      }),
    );

    expect(response.response.status).toBe(429);
    expect(ErrorEnvelopeSchema.parse(response.body).error.code).toBe("RATE_LIMITED");
    expect(keys).toEqual([`auth:${guest.sessionId}`]);
    expect(keys[0]).not.toContain(guest.token);
    expect((await authenticatedJson("/v1/me", guest.token)).response.status).toBe(200);
  });

  it("strictly rejects malformed bodies without mutating the guest or player state", async () => {
    const guest = await issueGuest("telegram");
    for (const body of ["{", {}, { initData: "" }, { initData: "unused", extra: true }]) {
      const response = await authenticatedJson("/v1/auth/telegram/mini-app", guest.token, {
        method: "POST",
        body,
      });
      expect(response.response.status).toBe(400);
      expect(ErrorEnvelopeSchema.parse(response.body).error.code).toBe("INVALID_REQUEST");
    }
    expect((await authenticatedJson("/v1/me", guest.token)).response.status).toBe(200);
    expect(
      (await testEnv.DB.prepare("SELECT count(*) AS count FROM players").first<{ count: number }>())
        ?.count,
    ).toBe(0);
  });

  it("updates Mini App profile fields without overwriting an existing OIDC tuple", async () => {
    const guest = await issueGuest("telegram");
    await testEnv.DB.prepare(
      `INSERT INTO players
        (id, telegram_user_id, oidc_issuer, oidc_subject, oidc_audience,
         display_name, username, avatar_url, created_at, updated_at)
       VALUES ('existing-player', '987654321', 'https://oauth.telegram.org',
               'oidc-subject', 'oidc-audience', 'Old Name', 'old', NULL, 1, 1)`,
    ).run();
    const initData = await validInitData({
      id: 987654321,
      first_name: "Grace",
      last_name: "Hopper",
      username: "grace",
      photo_url: "https://cdn.example/grace.jpg",
    });

    const login = await authenticatedJson("/v1/auth/telegram/mini-app", guest.token, {
      method: "POST",
      body: { initData },
    });

    expect(login.response.status).toBe(200);
    expect(TelegramSessionIssuedSchema.parse(login.body).profile).toEqual({
      telegramUserId: "987654321",
      displayName: "Grace Hopper",
      username: "grace",
      avatarUrl: "https://cdn.example/grace.jpg",
    });
    const player = await testEnv.DB.prepare(
      "SELECT * FROM players WHERE id = 'existing-player'",
    ).first<Record<string, unknown>>();
    expect(player).toMatchObject({
      telegram_user_id: "987654321",
      oidc_issuer: "https://oauth.telegram.org",
      oidc_subject: "oidc-subject",
      oidc_audience: "oidc-audience",
      display_name: "Grace Hopper",
      username: "grace",
      avatar_url: "https://cdn.example/grace.jpg",
    });
    expect(
      (await testEnv.DB.prepare("SELECT count(*) AS count FROM players").first<{ count: number }>())
        ?.count,
    ).toBe(1);
  });

  it("allows exactly one concurrent replacement and never leaks the losing token", async () => {
    const guest = await issueGuest("telegram");
    await seedAttempt({ sessionId: guest.sessionId, attemptId: "concurrent-attempt" });
    const body = { initData: await validInitData() };

    const results = await Promise.all([
      authenticatedJson("/v1/auth/telegram/mini-app", guest.token, { method: "POST", body }),
      authenticatedJson("/v1/auth/telegram/mini-app", guest.token, { method: "POST", body }),
    ]);
    const winner = results.find((result) => result.response.status === 200);
    const loser = results.find((result) => result.response.status === 401);

    expect(winner).toBeDefined();
    expect(loser).toBeDefined();
    expect(ErrorEnvelopeSchema.parse(loser?.body).error.code).toBe("INVALID_SESSION");
    expect(JSON.stringify(loser?.body)).not.toMatch(/[A-Za-z0-9_-]{43}/);
    expect(
      (
        await testEnv.DB.prepare(
          "SELECT count(*) AS count FROM sessions WHERE rotated_from_session_id = ?",
        )
          .bind(guest.sessionId)
          .first<{ count: number }>()
      )?.count,
    ).toBe(1);
    const owner = await testEnv.DB.prepare(
      "SELECT player_id FROM attempts WHERE id = 'concurrent-attempt'",
    ).first<{ player_id: string | null }>();
    expect(owner?.player_id).not.toBeNull();
  });

  it("rolls back the replacement, attempt transfer, and revoke on a late D1 failure", async () => {
    const guest = await issueGuest("telegram");
    await seedAttempt({ sessionId: guest.sessionId, attemptId: "rollback-attempt" });
    await testEnv.DB.prepare(
      `CREATE TRIGGER test_fail_mini_app_revoke
       BEFORE UPDATE OF revoked_at ON sessions
       WHEN OLD.id = '${guest.sessionId}' AND NEW.revoked_at IS NOT NULL
       BEGIN
         SELECT RAISE(ABORT, 'test late Mini App failure');
       END`,
    ).run();

    const response = await authenticatedJson("/v1/auth/telegram/mini-app", guest.token, {
      method: "POST",
      body: { initData: await validInitData() },
    });

    expect(response.response.status).toBe(500);
    expect(ErrorEnvelopeSchema.parse(response.body).error.code).toBe("INTERNAL_ERROR");
    const original = await testEnv.DB.prepare("SELECT revoked_at FROM sessions WHERE id = ?")
      .bind(guest.sessionId)
      .first<{ revoked_at: number | null }>();
    const attempt = await testEnv.DB.prepare("SELECT player_id FROM attempts WHERE id = ?")
      .bind("rollback-attempt")
      .first<{ player_id: string | null }>();
    expect(original?.revoked_at).toBeNull();
    expect(attempt?.player_id).toBeNull();
    expect(
      (
        await testEnv.DB.prepare(
          "SELECT count(*) AS count FROM sessions WHERE rotated_from_session_id = ?",
        )
          .bind(guest.sessionId)
          .first<{ count: number }>()
      )?.count,
    ).toBe(0);
    expect(
      (await testEnv.DB.prepare("SELECT count(*) AS count FROM players").first<{ count: number }>())
        ?.count,
    ).toBe(0);
    expect((await authenticatedJson("/v1/me", guest.token)).response.status).toBe(200);

    await testEnv.DB.prepare("DROP TRIGGER test_fail_mini_app_revoke").run();
    const retry = await authenticatedJson("/v1/auth/telegram/mini-app", guest.token, {
      method: "POST",
      body: { initData: await validInitData() },
    });
    expect(retry.response.status).toBe(200);
  });

  it("turns a silent zero-row revoke into a transaction rollback", async () => {
    const guest = await issueGuest("telegram");
    await seedAttempt({ sessionId: guest.sessionId, attemptId: "ignored-revoke-attempt" });
    await testEnv.DB.prepare(
      `CREATE TRIGGER test_ignore_mini_app_revoke
       BEFORE UPDATE OF revoked_at ON sessions
       WHEN OLD.id = '${guest.sessionId}' AND NEW.revoked_at IS NOT NULL
       BEGIN
         SELECT RAISE(IGNORE);
       END`,
    ).run();

    const response = await authenticatedJson("/v1/auth/telegram/mini-app", guest.token, {
      method: "POST",
      body: { initData: await validInitData() },
    });

    expect(response.response.status).toBe(500);
    expect(ErrorEnvelopeSchema.parse(response.body).error.code).toBe("INTERNAL_ERROR");
    const original = await testEnv.DB.prepare("SELECT revoked_at FROM sessions WHERE id = ?")
      .bind(guest.sessionId)
      .first<{ revoked_at: number | null }>();
    const attempt = await testEnv.DB.prepare("SELECT player_id FROM attempts WHERE id = ?")
      .bind("ignored-revoke-attempt")
      .first<{ player_id: string | null }>();
    expect(original?.revoked_at).toBeNull();
    expect(attempt?.player_id).toBeNull();
    expect(
      (await testEnv.DB.prepare("SELECT count(*) AS count FROM players").first<{ count: number }>())
        ?.count,
    ).toBe(0);
    expect(
      (
        await testEnv.DB.prepare(
          "SELECT count(*) AS count FROM sessions WHERE rotated_from_session_id = ?",
        )
          .bind(guest.sessionId)
          .first<{ count: number }>()
      )?.count,
    ).toBe(0);
  });

  it("fails closed on invalid session TTL configuration without changing any row", async () => {
    for (const ttl of ["0", "-1", "1.5", "NaN", "Infinity", "8640000000000"]) {
      await resetDatabase();
      const guest = await issueGuest("telegram");
      await seedAttempt({ sessionId: guest.sessionId, attemptId: `ttl-attempt-${ttl}` });
      const response = await authenticatedJson(
        "/v1/auth/telegram/mini-app",
        guest.token,
        { method: "POST", body: { initData: await validInitData() } },
        overrideEnv({ SESSION_TTL_SECONDS: ttl }),
      );

      expect(response.response.status).toBe(500);
      expect(ErrorEnvelopeSchema.parse(response.body).error.code).toBe("INTERNAL_ERROR");
      expect(JSON.stringify(response.body)).not.toContain("SESSION_TTL_SECONDS");
      const session = await testEnv.DB.prepare("SELECT revoked_at FROM sessions WHERE id = ?")
        .bind(guest.sessionId)
        .first<{ revoked_at: number | null }>();
      const attempt = await testEnv.DB.prepare("SELECT player_id FROM attempts WHERE id = ?")
        .bind(`ttl-attempt-${ttl}`)
        .first<{ player_id: string | null }>();
      expect(session?.revoked_at).toBeNull();
      expect(attempt?.player_id).toBeNull();
      expect(
        (
          await testEnv.DB.prepare("SELECT count(*) AS count FROM players").first<{
            count: number;
          }>()
        )?.count,
      ).toBe(0);
    }
  });

  it("does not verify, rate-limit, or mutate revoked, expired, and deleted guests", async () => {
    for (const state of ["revoked", "expired", "deleted"] as const) {
      await resetDatabase();
      const guest = await issueGuest("telegram");
      if (state === "revoked") {
        await testEnv.DB.prepare("UPDATE sessions SET revoked_at = 1 WHERE id = ?")
          .bind(guest.sessionId)
          .run();
      } else if (state === "expired") {
        await testEnv.DB.prepare("UPDATE sessions SET expires_at = 0 WHERE id = ?")
          .bind(guest.sessionId)
          .run();
      } else {
        await testEnv.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(guest.sessionId).run();
      }
      const keys: string[] = [];
      const response = await authenticatedJson(
        "/v1/auth/telegram/mini-app",
        guest.token,
        { method: "POST", body: { initData: await validInitData() } },
        authEnv({
          limit: async ({ key }) => {
            keys.push(key);
            return { success: true };
          },
        }),
      );

      expect(response.response.status).toBe(401);
      expect(ErrorEnvelopeSchema.parse(response.body).error.code).toBe("INVALID_SESSION");
      expect(keys).toEqual([]);
      expect(
        (
          await testEnv.DB.prepare("SELECT count(*) AS count FROM players").first<{
            count: number;
          }>()
        )?.count,
      ).toBe(0);
    }
  });

  it("rechecks expiry against the database clock after asynchronous proof work", async () => {
    const guest = await issueGuest("telegram");
    const databaseNow = Math.floor(Date.now() / 1000);
    await testEnv.DB.prepare("UPDATE sessions SET expires_at = ? WHERE id = ?")
      .bind(databaseNow - 1, guest.sessionId)
      .run();

    await expect(
      linkGuestToPlayer(
        testEnv,
        {
          sessionId: guest.sessionId,
          playerId: null,
          kind: "guest",
          channel: "telegram",
        },
        {
          telegramUserId: "987654321",
          displayName: "Ada Lovelace",
          username: "ada",
          avatarUrl: "https://cdn.example/avatar.jpg",
        },
        databaseNow - 60,
      ),
    ).rejects.toMatchObject({ status: 401, code: "INVALID_SESSION" });
    expect(
      (await testEnv.DB.prepare("SELECT count(*) AS count FROM players").first<{ count: number }>())
        ?.count,
    ).toBe(0);
    expect(
      (
        await testEnv.DB.prepare(
          "SELECT count(*) AS count FROM sessions WHERE rotated_from_session_id = ?",
        )
          .bind(guest.sessionId)
          .first<{ count: number }>()
      )?.count,
    ).toBe(0);
  });

  it("links two distinct guests to one Telegram player without crossing attempt ownership", async () => {
    const first = await issueGuest("telegram");
    const second = await issueGuest("telegram");
    await seedAttempt({ sessionId: first.sessionId, attemptId: "first-guest-attempt" });
    const secondFixture = await testEnv.DB.prepare(
      `INSERT INTO attempts
        (id, attempt_uuid, session_id, player_id, case_id, puzzle_id,
         normalized_answer_json, correct, response_json, hints_used, submitted_at)
       SELECT 'second-guest-attempt', 'second-uuid', ?, NULL, case_id, puzzle_id,
              '{}', 0, '{}', 0, submitted_at
         FROM attempts WHERE id = 'first-guest-attempt' RETURNING id`,
    )
      .bind(second.sessionId)
      .first<{ id: string }>();
    expect(secondFixture?.id).toBe("second-guest-attempt");
    const body = { initData: await validInitData() };

    const [firstLogin, secondLogin] = await Promise.all([
      authenticatedJson("/v1/auth/telegram/mini-app", first.token, { method: "POST", body }),
      authenticatedJson("/v1/auth/telegram/mini-app", second.token, { method: "POST", body }),
    ]);

    expect(firstLogin.response.status).toBe(200);
    expect(secondLogin.response.status).toBe(200);
    expect(
      (await testEnv.DB.prepare("SELECT count(*) AS count FROM players").first<{ count: number }>())
        ?.count,
    ).toBe(1);
    const attempts = await testEnv.DB.prepare(
      "SELECT id, session_id, player_id FROM attempts ORDER BY id",
    ).all<{ id: string; session_id: string | null; player_id: string | null }>();
    expect(attempts.results.map((row) => row.session_id)).toEqual([
      first.sessionId,
      second.sessionId,
    ]);
    expect(new Set(attempts.results.map((row) => row.player_id)).size).toBe(1);
    expect(attempts.results[0]?.player_id).not.toBeNull();
  });

  it("uses the shared rotation guard when Mini App login races logout", async () => {
    const guest = await issueGuest("telegram");
    const [login, logout] = await Promise.all([
      authenticatedJson("/v1/auth/telegram/mini-app", guest.token, {
        method: "POST",
        body: { initData: await validInitData() },
      }),
      authenticatedJson("/v1/auth/logout", guest.token, { method: "POST", body: {} }),
    ]);

    expect([login.response.status, logout.response.status].sort()).toEqual([200, 401]);
    const loser = login.response.status === 401 ? login : logout;
    expect(ErrorEnvelopeSchema.parse(loser.body).error.code).toBe("INVALID_SESSION");
    expect(
      (
        await testEnv.DB.prepare(
          "SELECT count(*) AS count FROM sessions WHERE rotated_from_session_id = ?",
        )
          .bind(guest.sessionId)
          .first<{ count: number }>()
      )?.count,
    ).toBe(1);
  });
});
