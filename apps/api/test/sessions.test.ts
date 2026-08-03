import { env, exports } from "cloudflare:workers";
import { ErrorEnvelopeSchema, SessionIssuedSchema } from "@a-move-ago/api-contract";
import { beforeEach, describe, expect, it } from "vitest";
import { app } from "../src/app";
import { hashSessionToken, newOpaqueToken } from "../src/crypto/opaque-token";
import type { Env } from "../src/env";
import { logoutToGuest } from "../src/services/session-service";

const testEnv = env as Env;
const sessionPepper = "test-session-pepper-at-least-32-bytes";
const sessionTtlSeconds = 7_776_000;

type JsonRequestInit = {
  method?: string;
  headers?: HeadersInit;
  body?: unknown;
};

async function requestJson(path: string, init: JsonRequestInit = {}) {
  const headers = new Headers(init.headers);
  const requestInit: RequestInit = { headers };
  if (init.method !== undefined) requestInit.method = init.method;
  if (init.body !== undefined) {
    headers.set("content-type", "application/json");
    requestInit.body = JSON.stringify(init.body);
  }
  const response = await exports.default.fetch(new Request(`https://api.test${path}`, requestInit));
  return { response, body: (await response.json()) as unknown };
}

async function authenticatedJson(path: string, token: string, init: JsonRequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  return await requestJson(path, { ...init, headers });
}

async function issueGuest(channel: "web" | "telegram" | "android" = "web") {
  const result = await requestJson("/v1/sessions/guest", {
    method: "POST",
    body: { channel },
  });
  return { ...result, issued: SessionIssuedSchema.parse(result.body) };
}

async function hmacSessionToken(token: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(sessionPepper),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign("HMAC", key, encoder.encode(`session\0${token}`));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function expectInvalidSession(result: Awaited<ReturnType<typeof requestJson>>) {
  expect(result.response.status).toBe(401);
  expect(result.response.headers.get("cache-control")).toBe("no-store");
  expect(ErrorEnvelopeSchema.parse(result.body).error.code).toBe("INVALID_SESSION");
}

beforeEach(async () => {
  await testEnv.DB.prepare("DROP TRIGGER IF EXISTS test_fail_session_revoke").run();
  await testEnv.DB.prepare("DELETE FROM sessions").run();
  await testEnv.DB.prepare("DELETE FROM players").run();
});

describe("opaque session tokens", () => {
  it("uses a fixed purpose-separated HMAC vector and emits exact 43-character tokens", async () => {
    expect(await hashSessionToken("token", sessionPepper)).toBe(
      "09b878d09b6d9b75b27dcaf5a8230d7985fe102b4b9d505fa68faff475a1591c",
    );
    for (let index = 0; index < 16; index += 1) {
      expect(newOpaqueToken()).toMatch(/^[A-Za-z0-9_-]{43}$/);
    }
  });
});

describe("guest session lifecycle", () => {
  it("issues an opaque 32-byte guest token and persists only its purpose-separated HMAC", async () => {
    const before = Math.floor(Date.now() / 1000);
    const issued = await issueGuest("web");
    const after = Math.floor(Date.now() / 1000);

    expect(issued.response.status).toBe(201);
    expect(issued.response.headers.get("cache-control")).toBe("no-store");
    expect(issued.issued.kind).toBe("guest");
    const paddedToken = issued.issued.token
      .replaceAll("-", "+")
      .replaceAll("_", "/")
      .padEnd(44, "=");
    expect(atob(paddedToken)).toHaveLength(32);

    const row = await testEnv.DB.prepare(
      `SELECT id, player_id, token_hash, kind, channel, rotated_from_session_id,
              created_at, expires_at, revoked_at, last_seen_at
         FROM sessions`,
    ).first<{
      id: string;
      player_id: string | null;
      token_hash: string;
      kind: string;
      channel: string;
      rotated_from_session_id: string | null;
      created_at: number;
      expires_at: number;
      revoked_at: number | null;
      last_seen_at: number;
    }>();

    expect(row).not.toBeNull();
    expect(row?.token_hash).not.toBe(issued.issued.token);
    expect(row?.token_hash).toBe(await hmacSessionToken(issued.issued.token));
    expect(row?.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(row)).not.toContain(issued.issued.token);
    expect(row).toMatchObject({
      player_id: null,
      kind: "guest",
      channel: "web",
      rotated_from_session_id: null,
      revoked_at: null,
    });
    expect(row?.created_at).toBeGreaterThanOrEqual(before);
    expect(row?.created_at).toBeLessThanOrEqual(after);
    expect(row?.last_seen_at).toBe(row?.created_at);
    expect(row?.expires_at).toBeGreaterThanOrEqual(before + sessionTtlSeconds);
    expect(row?.expires_at).toBeLessThanOrEqual(after + sessionTtlSeconds);
    expect(new Date((row?.expires_at ?? 0) * 1000).toISOString()).toBe(issued.issued.expiresAt);
  });

  it("supports every strict client channel and creates distinct sessions", async () => {
    const issued = await Promise.all(
      (["web", "telegram", "android"] as const).map(async (channel) => await issueGuest(channel)),
    );
    const rows = await testEnv.DB.prepare(
      "SELECT id, token_hash, channel FROM sessions ORDER BY channel",
    ).all<{ id: string; token_hash: string; channel: string }>();

    expect(issued.every((result) => result.response.status === 201)).toBe(true);
    expect(new Set(issued.map((result) => result.issued.token)).size).toBe(3);
    expect(new Set(rows.results.map((row) => row.id)).size).toBe(3);
    expect(new Set(rows.results.map((row) => row.token_hash)).size).toBe(3);
    expect(rows.results.map((row) => row.channel).sort()).toEqual(["android", "telegram", "web"]);
  });

  it("rejects malformed JSON and non-strict guest request bodies without inserting sessions", async () => {
    const malformed = await exports.default.fetch("https://api.test/v1/sessions/guest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    const invalidBodies = [
      {},
      { channel: "desktop" },
      { channel: "WEB" },
      { channel: "web", unexpected: true },
    ];

    expect(malformed.status).toBe(400);
    expect(malformed.headers.get("cache-control")).toBe("no-store");
    expect(ErrorEnvelopeSchema.parse(await malformed.json()).error.code).toBe("INVALID_REQUEST");
    for (const body of invalidBodies) {
      const result = await requestJson("/v1/sessions/guest", { method: "POST", body });
      expect(result.response.status).toBe(400);
      expect(result.response.headers.get("cache-control")).toBe("no-store");
      expect(ErrorEnvelopeSchema.parse(result.body).error.code).toBe("INVALID_REQUEST");
    }
    const count = await testEnv.DB.prepare("SELECT count(*) AS count FROM sessions").first<{
      count: number;
    }>();
    expect(count?.count).toBe(0);
  });

  it("returns the guest identity for an exact Bearer token", async () => {
    const issued = await issueGuest();
    const me = await authenticatedJson("/v1/me", issued.issued.token);

    expect(me.response.status).toBe(200);
    expect(me.response.headers.get("cache-control")).toBe("no-store");
    expect(me.body).toEqual({ kind: "guest", profile: null });
  });

  it("returns the exact Telegram profile for an authenticated Telegram session", async () => {
    const issued = await issueGuest("telegram");
    const row = await testEnv.DB.prepare("SELECT id FROM sessions").first<{ id: string }>();
    if (!row) throw new Error("Expected issued session row");
    await testEnv.DB.prepare(
      `INSERT INTO players
        (id, telegram_user_id, display_name, username, avatar_url, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, 1)`,
    )
      .bind("player-1", "424242", "Ada Lovelace", "ada", "https://cdn.example.test/ada.png")
      .run();
    await testEnv.DB.prepare("UPDATE sessions SET player_id = ?, kind = 'telegram' WHERE id = ?")
      .bind("player-1", row.id)
      .run();

    const me = await authenticatedJson("/v1/me", issued.issued.token);

    expect(me.response.status).toBe(200);
    expect(me.response.headers.get("cache-control")).toBe("no-store");
    expect(me.body).toEqual({
      kind: "telegram",
      profile: {
        telegramUserId: "424242",
        displayName: "Ada Lovelace",
        username: "ada",
        avatarUrl: "https://cdn.example.test/ada.png",
      },
    });
  });

  it("rejects absent, malformed, and unknown Bearer credentials", async () => {
    const issued = await issueGuest();
    const malformedHeaders = [
      undefined,
      "Bearer",
      `bearer ${issued.issued.token}`,
      `Basic ${issued.issued.token}`,
      `Bearer  ${issued.issued.token}`,
      `Bearer ${issued.issued.token} extra`,
      "Bearer too-short",
    ];

    for (const authorization of malformedHeaders) {
      const init = authorization === undefined ? {} : { headers: { authorization } };
      await expectInvalidSession(await requestJson("/v1/me", init));
    }
    await expectInvalidSession(await authenticatedJson("/v1/me", "A".repeat(43)));
  });

  it("rejects expired and revoked sessions", async () => {
    const expired = await issueGuest();
    await testEnv.DB.prepare("UPDATE sessions SET expires_at = 0").run();
    await expectInvalidSession(await authenticatedJson("/v1/me", expired.issued.token));

    await testEnv.DB.prepare("DELETE FROM sessions").run();
    const revoked = await issueGuest();
    await testEnv.DB.prepare("UPDATE sessions SET revoked_at = 1").run();
    await expectInvalidSession(await authenticatedJson("/v1/me", revoked.issued.token));
  });

  it("rejects invalid session TTL configuration without persisting a token", async () => {
    for (const ttl of ["0", "-1", "1.5", "NaN", "8640000000000"]) {
      const request = new Request("https://api.test/v1/sessions/guest", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ channel: "web" }),
      });
      const response = await app.fetch(request, {
        DB: testEnv.DB,
        ENVIRONMENT: testEnv.ENVIRONMENT,
        ALLOWED_ORIGINS: testEnv.ALLOWED_ORIGINS,
        SESSION_TTL_SECONDS: ttl,
        SESSION_PEPPER: testEnv.SESSION_PEPPER,
      });

      expect(response.status).toBe(500);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(ErrorEnvelopeSchema.parse(await response.json()).error.code).toBe("INTERNAL_ERROR");
    }
    const count = await testEnv.DB.prepare("SELECT count(*) AS count FROM sessions").first<{
      count: number;
    }>();
    expect(count?.count).toBe(0);
  });

  it("does not replace a session revoked after authentication", async () => {
    await issueGuest("android");
    const now = Math.floor(Date.now() / 1000);
    const row = await testEnv.DB.prepare("SELECT id, channel FROM sessions").first<{
      id: string;
      channel: "web" | "telegram" | "android";
    }>();
    if (!row) throw new Error("Expected issued session row");
    await testEnv.DB.prepare("UPDATE sessions SET revoked_at = ? WHERE id = ?")
      .bind(now, row.id)
      .run();

    await expect(
      logoutToGuest(
        testEnv,
        { sessionId: row.id, playerId: null, kind: "guest", channel: row.channel },
        now,
      ),
    ).rejects.toMatchObject({ status: 401, code: "INVALID_SESSION" });
    const rows = await testEnv.DB.prepare("SELECT id, rotated_from_session_id FROM sessions").all<{
      id: string;
      rotated_from_session_id: string | null;
    }>();
    expect(rows.results).toEqual([{ id: row.id, rotated_from_session_id: null }]);
  });

  it("does not replace a session expired after authentication", async () => {
    await issueGuest("telegram");
    const now = Math.floor(Date.now() / 1000);
    const row = await testEnv.DB.prepare("SELECT id, channel FROM sessions").first<{
      id: string;
      channel: "web" | "telegram" | "android";
    }>();
    if (!row) throw new Error("Expected issued session row");
    await testEnv.DB.prepare("UPDATE sessions SET expires_at = ? WHERE id = ?")
      .bind(now, row.id)
      .run();

    await expect(
      logoutToGuest(
        testEnv,
        { sessionId: row.id, playerId: null, kind: "guest", channel: row.channel },
        now,
      ),
    ).rejects.toMatchObject({ status: 401, code: "INVALID_SESSION" });
    const rows = await testEnv.DB.prepare("SELECT id, rotated_from_session_id FROM sessions").all<{
      id: string;
      rotated_from_session_id: string | null;
    }>();
    expect(rows.results).toEqual([{ id: row.id, rotated_from_session_id: null }]);
  });

  it("does not replace a session deleted after authentication", async () => {
    await issueGuest("web");
    const now = Math.floor(Date.now() / 1000);
    const row = await testEnv.DB.prepare("SELECT id, channel FROM sessions").first<{
      id: string;
      channel: "web" | "telegram" | "android";
    }>();
    if (!row) throw new Error("Expected issued session row");
    await testEnv.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(row.id).run();

    await expect(
      logoutToGuest(
        testEnv,
        { sessionId: row.id, playerId: null, kind: "guest", channel: row.channel },
        now,
      ),
    ).rejects.toMatchObject({ status: 401, code: "INVALID_SESSION" });
    const rows = await testEnv.DB.prepare("SELECT id FROM sessions").all<{ id: string }>();
    expect(rows.results).toEqual([]);
  });

  it("atomically logs out to a distinct guest on the same channel and revokes the old token", async () => {
    const issued = await issueGuest("android");
    const oldRow = await testEnv.DB.prepare("SELECT id FROM sessions").first<{ id: string }>();
    const logout = await authenticatedJson("/v1/auth/logout", issued.issued.token, {
      method: "POST",
    });
    const replacement = SessionIssuedSchema.parse(logout.body);

    expect(logout.response.status).toBe(200);
    expect(logout.response.headers.get("cache-control")).toBe("no-store");
    expect(replacement.kind).toBe("guest");
    expect(replacement.token).not.toBe(issued.issued.token);
    await expectInvalidSession(await authenticatedJson("/v1/me", issued.issued.token));
    expect((await authenticatedJson("/v1/me", replacement.token)).body).toEqual({
      kind: "guest",
      profile: null,
    });

    const rows = await testEnv.DB.prepare(
      `SELECT id, channel, revoked_at, rotated_from_session_id
         FROM sessions
        ORDER BY created_at, id`,
    ).all<{
      id: string;
      channel: string;
      revoked_at: number | null;
      rotated_from_session_id: string | null;
    }>();
    expect(rows.results).toHaveLength(2);
    expect(rows.results.find((row) => row.id === oldRow?.id)?.revoked_at).not.toBeNull();
    expect(rows.results.find((row) => row.id !== oldRow?.id)).toMatchObject({
      channel: "android",
      revoked_at: null,
      rotated_from_session_id: oldRow?.id,
    });
  });

  it("allows only one concurrent logout replacement", async () => {
    const issued = await issueGuest("telegram");
    const oldRow = await testEnv.DB.prepare("SELECT id FROM sessions").first<{ id: string }>();
    if (!oldRow) throw new Error("Expected issued session row");

    const results = await Promise.all([
      authenticatedJson("/v1/auth/logout", issued.issued.token, { method: "POST" }),
      authenticatedJson("/v1/auth/logout", issued.issued.token, { method: "POST" }),
    ]);

    expect(results.map((result) => result.response.status).sort()).toEqual([200, 401]);
    const successful = results.find((result) => result.response.status === 200);
    if (!successful) throw new Error("Expected one successful logout");
    const replacement = SessionIssuedSchema.parse(successful.body);
    expect((await authenticatedJson("/v1/me", replacement.token)).response.status).toBe(200);
    const rows = await testEnv.DB.prepare(
      "SELECT id, revoked_at, rotated_from_session_id FROM sessions ORDER BY id",
    ).all<{
      id: string;
      revoked_at: number | null;
      rotated_from_session_id: string | null;
    }>();
    expect(rows.results).toHaveLength(2);
    expect(rows.results.filter((row) => row.rotated_from_session_id === oldRow.id)).toHaveLength(1);
    expect(rows.results.find((row) => row.id === oldRow.id)?.revoked_at).not.toBeNull();
  });

  it("classifies a losing replacement as invalid and rolls back its revocation", async () => {
    const issued = await issueGuest();
    const oldRow = await testEnv.DB.prepare("SELECT id FROM sessions").first<{ id: string }>();
    if (!oldRow) throw new Error("Expected issued session row");
    await testEnv.DB.prepare(
      `INSERT INTO sessions
        (id, player_id, token_hash, kind, channel, rotated_from_session_id,
         created_at, expires_at, revoked_at, last_seen_at)
       VALUES (?, NULL, ?, 'guest', 'web', ?, 1, 9999999999, NULL, 1)`,
    )
      .bind(crypto.randomUUID(), "f".repeat(64), oldRow.id)
      .run();

    const failedLogout = await authenticatedJson("/v1/auth/logout", issued.issued.token, {
      method: "POST",
    });

    await expectInvalidSession(failedLogout);
    const persisted = await testEnv.DB.prepare("SELECT revoked_at FROM sessions WHERE id = ?")
      .bind(oldRow.id)
      .first<{ revoked_at: number | null }>();
    expect(persisted?.revoked_at).toBeNull();
    expect((await authenticatedJson("/v1/me", issued.issued.token)).response.status).toBe(200);
  });

  it("rolls back an inserted replacement when revocation fails, then allows a clean retry", async () => {
    const issued = await issueGuest();
    const oldRow = await testEnv.DB.prepare("SELECT id FROM sessions").first<{ id: string }>();
    if (!oldRow) throw new Error("Expected issued session row");
    await testEnv.DB.prepare(
      `CREATE TRIGGER test_fail_session_revoke
       BEFORE UPDATE OF revoked_at ON sessions
       WHEN OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL
       BEGIN
         SELECT RAISE(ABORT, 'injected revoke failure');
       END`,
    ).run();

    try {
      const failedLogout = await authenticatedJson("/v1/auth/logout", issued.issued.token, {
        method: "POST",
      });

      expect(failedLogout.response.status).toBe(500);
      expect(ErrorEnvelopeSchema.parse(failedLogout.body).error).toMatchObject({
        code: "INTERNAL_ERROR",
        message: "Unexpected server error.",
      });
      expect(JSON.stringify(failedLogout.body)).not.toContain("injected revoke failure");
      const rows = await testEnv.DB.prepare(
        "SELECT id, revoked_at, rotated_from_session_id FROM sessions",
      ).all<{
        id: string;
        revoked_at: number | null;
        rotated_from_session_id: string | null;
      }>();
      expect(rows.results).toEqual([
        { id: oldRow.id, revoked_at: null, rotated_from_session_id: null },
      ]);
      expect((await authenticatedJson("/v1/me", issued.issued.token)).response.status).toBe(200);
    } finally {
      await testEnv.DB.prepare("DROP TRIGGER IF EXISTS test_fail_session_revoke").run();
    }

    const retry = await authenticatedJson("/v1/auth/logout", issued.issued.token, {
      method: "POST",
    });
    const replacement = SessionIssuedSchema.parse(retry.body);
    expect(retry.response.status).toBe(200);
    await expectInvalidSession(await authenticatedJson("/v1/me", issued.issued.token));
    expect((await authenticatedJson("/v1/me", replacement.token)).response.status).toBe(200);
    const rows = await testEnv.DB.prepare(
      "SELECT id, revoked_at, rotated_from_session_id FROM sessions ORDER BY id",
    ).all<{
      id: string;
      revoked_at: number | null;
      rotated_from_session_id: string | null;
    }>();
    expect(rows.results).toHaveLength(2);
    expect(rows.results.filter((row) => row.rotated_from_session_id === oldRow.id)).toHaveLength(1);
    expect(rows.results.find((row) => row.id === oldRow.id)?.revoked_at).not.toBeNull();
  });

  it("does not expose temporary auth route aliases", async () => {
    const guestAlias = await requestJson("/v1/auth/guest", {
      method: "POST",
      body: { channel: "web" },
    });
    const logoutAlias = await requestJson("/v1/sessions/logout", { method: "POST" });

    expect(guestAlias.response.status).toBe(404);
    expect(logoutAlias.response.status).toBe(404);
  });
});
