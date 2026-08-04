import { env } from "cloudflare:workers";
import {
  AttemptResultSchema,
  ErrorEnvelopeSchema,
  type Retraction,
  SessionIssuedSchema,
} from "@a-move-ago/api-contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app";
import { hashSessionToken } from "../src/crypto/opaque-token";
import type { Env } from "../src/env";
import worker from "../src/index";
import { openingPuzzleFixture, seedContentFixture } from "./fixtures/content";

type LimitResult = { success: boolean };
type LimitInput = { key: string };

class FakeLimiter {
  readonly keys: string[] = [];

  constructor(private readonly result: (key: string, count: number) => LimitResult) {}

  async limit(input: LimitInput): Promise<LimitResult> {
    this.keys.push(input.key);
    return this.result(input.key, this.keys.length);
  }
}

type TestEnv = Env & {
  GUEST_RATE_LIMITER: FakeLimiter;
  ATTEMPT_RATE_LIMITER: FakeLimiter;
  HINT_RATE_LIMITER: FakeLimiter;
  AUTH_RATE_LIMITER: FakeLimiter;
};

const workerEnv = env as Env;
const injectedNow = new Date("2026-08-03T23:30:00.000Z");
const app = createApp({ now: () => injectedNow });
const allow = () => ({ success: true });

function testEnv(overrides: Partial<Pick<TestEnv, keyof TestEnv>> = {}): TestEnv {
  return {
    DB: workerEnv.DB,
    ENVIRONMENT: workerEnv.ENVIRONMENT,
    ALLOWED_ORIGINS: workerEnv.ALLOWED_ORIGINS,
    SESSION_TTL_SECONDS: workerEnv.SESSION_TTL_SECONDS,
    SESSION_PEPPER: workerEnv.SESSION_PEPPER,
    TELEGRAM_BOT_TOKEN: workerEnv.TELEGRAM_BOT_TOKEN,
    TELEGRAM_OIDC_CLIENT_ID: workerEnv.TELEGRAM_OIDC_CLIENT_ID,
    TELEGRAM_OIDC_CLIENT_SECRET: workerEnv.TELEGRAM_OIDC_CLIENT_SECRET,
    TELEGRAM_OIDC_CALLBACK_URL: workerEnv.TELEGRAM_OIDC_CALLBACK_URL,
    API_ORIGIN: workerEnv.API_ORIGIN,
    WEB_AUTH_RETURN_URL: workerEnv.WEB_AUTH_RETURN_URL,
    ANDROID_AUTH_RETURN_URL: workerEnv.ANDROID_AUTH_RETURN_URL,
    ANDROID_PACKAGE_NAME: workerEnv.ANDROID_PACKAGE_NAME,
    ANDROID_SHA256_CERT_FINGERPRINTS: workerEnv.ANDROID_SHA256_CERT_FINGERPRINTS,
    TELEGRAM_INIT_DATA_MAX_AGE_SECONDS: workerEnv.TELEGRAM_INIT_DATA_MAX_AGE_SECONDS,
    TELEGRAM_INIT_DATA_FUTURE_SKEW_SECONDS: workerEnv.TELEGRAM_INIT_DATA_FUTURE_SKEW_SECONDS,
    OIDC_FLOW_TTL_SECONDS: workerEnv.OIDC_FLOW_TTL_SECONDS,
    HANDOFF_TTL_SECONDS: workerEnv.HANDOFF_TTL_SECONDS,
    GUEST_RATE_LIMITER: new FakeLimiter(allow),
    ATTEMPT_RATE_LIMITER: new FakeLimiter(allow),
    HINT_RATE_LIMITER: new FakeLimiter(allow),
    AUTH_RATE_LIMITER: new FakeLimiter(allow),
    ...overrides,
  };
}

type JsonRequestInit = {
  method?: string;
  headers?: HeadersInit;
  body?: unknown;
};

async function request(path: string, requestEnv: TestEnv, init: JsonRequestInit = {}) {
  const headers = new Headers(init.headers);
  const requestInit: RequestInit = { headers };
  if (init.method !== undefined) requestInit.method = init.method;
  if (init.body !== undefined) {
    headers.set("content-type", "application/json");
    requestInit.body = JSON.stringify(init.body);
  }
  return await app.fetch(new Request(`https://api.test${path}`, requestInit), requestEnv);
}

async function requestJson(path: string, requestEnv: TestEnv, init: JsonRequestInit = {}) {
  const response = await request(path, requestEnv, init);
  return { response, body: (await response.json()) as unknown };
}

async function issueGuest(requestEnv: TestEnv, ip = "203.0.113.42") {
  const result = await requestJson("/v1/sessions/guest", requestEnv, {
    method: "POST",
    headers: { "cf-connecting-ip": ip },
    body: { channel: "web" },
  });
  expect(result.response.status).toBe(201);
  return SessionIssuedSchema.parse(result.body);
}

async function sessionIdFor(token: string): Promise<string> {
  const row = await workerEnv.DB.prepare("SELECT id FROM sessions WHERE token_hash = ?")
    .bind(await hashSessionToken(token, workerEnv.SESSION_PEPPER))
    .first<{ id: string }>();
  if (!row) throw new Error("Expected issued session");
  return row.id;
}

const incorrectRetraction: Retraction = {
  currentSquare: "d5",
  previousSquare: "d4",
  movedPiece: { color: "w", type: "p" },
  restoredPiece: null,
  special: "normal",
};

async function seedSession(input: {
  id: string;
  token: string;
  kind?: "guest" | "telegram";
  playerId?: string | null;
  expiresAt: number;
  revokedAt?: number | null;
}): Promise<void> {
  await workerEnv.DB.prepare(
    `INSERT INTO sessions
      (id, player_id, token_hash, kind, channel, created_at, expires_at, revoked_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      input.id,
      input.playerId ?? null,
      await hashSessionToken(input.token, workerEnv.SESSION_PEPPER),
      input.kind ?? "guest",
      input.kind === "telegram" ? "telegram" : "web",
      1,
      input.expiresAt,
      input.revokedAt ?? null,
      1,
    )
    .run();
}

async function seedAttempt(input: {
  id: string;
  sessionId: string;
  playerId?: string | null;
  correct?: boolean;
  hintsUsed?: number;
}): Promise<void> {
  await workerEnv.DB.prepare(
    `INSERT INTO attempts
      (id, attempt_uuid, session_id, player_id, case_id, puzzle_id,
       normalized_answer_json, correct, response_json, hints_used, submitted_at)
     VALUES (?, ?, ?, ?, 'case-2026-08-03', ?, '{}', ?, '{}', ?, 1)`,
  )
    .bind(
      input.id,
      crypto.randomUUID(),
      input.sessionId,
      input.playerId ?? null,
      openingPuzzleFixture.rowId,
      input.correct === true ? 1 : 0,
      input.hintsUsed ?? 0,
    )
    .run();
}

type ScheduledEntry = (
  event: unknown,
  requestEnv: TestEnv,
  context: { waitUntil(promise: Promise<unknown>): void },
) => unknown;

function scheduledEntry(): ScheduledEntry {
  const scheduled = (worker as unknown as { scheduled?: ScheduledEntry }).scheduled;
  expect(scheduled).toBeTypeOf("function");
  if (!scheduled) throw new Error("Expected scheduled Worker entrypoint");
  return scheduled;
}

async function runScheduled(requestEnv: TestEnv): Promise<void> {
  const pending: Promise<unknown>[] = [];
  const result = scheduledEntry()({}, requestEnv, {
    waitUntil: (promise) => pending.push(promise),
  });
  expect(result).toBeUndefined();
  expect(pending).toHaveLength(1);
  const cleanup = pending[0];
  if (!cleanup) throw new Error("Expected scheduled cleanup promise");
  await cleanup;
}

beforeEach(async () => {
  for (const table of [
    "hint_events",
    "attempts",
    "content_imports",
    "daily_case_puzzles",
    "puzzle_hints",
    "puzzle_solutions",
    "sessions",
    "daily_cases",
    "puzzles",
    "players",
  ]) {
    await workerEnv.DB.prepare(`DELETE FROM ${table}`).run();
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("security boundary", () => {
  it("matches CORS origins exactly and terminates protected preflight without authentication", async () => {
    const requestEnv = testEnv();
    const allowed = await request("/v1/daily?private=query", requestEnv, {
      method: "OPTIONS",
      headers: { origin: "https://agent-axiom.github.io" },
    });
    const lookalike = await request("/v1/daily?private=query", requestEnv, {
      method: "OPTIONS",
      headers: { origin: "https://agent-axiom.github.io.evil.test" },
    });

    for (const response of [allowed, lookalike]) {
      expect(response.status).toBe(204);
      await expect(response.text()).resolves.toBe("");
      expect(response.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
    }
    expect(allowed.headers.get("access-control-allow-origin")).toBe(
      "https://agent-axiom.github.io",
    );
    expect(lookalike.headers.get("access-control-allow-origin")).toBeNull();
    expect(requestEnv.ATTEMPT_RATE_LIMITER.keys).toEqual([]);
    expect(requestEnv.HINT_RATE_LIMITER.keys).toEqual([]);
  });

  it("returns the exact rate-limit envelope at the guest ten-per-minute boundary", async () => {
    const counts = new Map<string, number>();
    const guestLimiter = new FakeLimiter((key) => {
      const count = (counts.get(key) ?? 0) + 1;
      counts.set(key, count);
      return { success: count <= 10 };
    });
    const requestEnv = testEnv({ GUEST_RATE_LIMITER: guestLimiter });
    const responses: Response[] = [];

    for (let index = 0; index < 11; index += 1) {
      responses.push(
        await request("/v1/sessions/guest", requestEnv, {
          method: "POST",
          headers: { "cf-connecting-ip": `203.0.113.${index + 1}` },
          body: { channel: "web" },
        }),
      );
    }

    expect(responses.slice(0, 10).map((response) => response.status)).toEqual(
      Array.from({ length: 10 }, () => 201),
    );
    const limited = responses[10];
    if (!limited) throw new Error("Expected the boundary response");
    const requestId = limited.headers.get("x-request-id");
    expect(limited.status).toBe(429);
    expect(limited.headers.get("cache-control")).toBe("no-store");
    await expect(limited.json()).resolves.toEqual({
      error: {
        code: "RATE_LIMITED",
        message: "Too many requests.",
        requestId,
      },
    });
    expect(new Set(guestLimiter.keys)).toHaveLength(1);
    const count = await workerEnv.DB.prepare("SELECT count(*) AS count FROM sessions").first<{
      count: number;
    }>();
    expect(count?.count).toBe(10);
  });

  it("uses only a canonical coarse purpose-separated HMAC of the client IP for guest keys", async () => {
    const guestLimiter = new FakeLimiter(allow);
    const requestEnv = testEnv({ GUEST_RATE_LIMITER: guestLimiter });
    const bearer = "S".repeat(43);

    for (const ip of [
      "203.0.113.7",
      "203.0.113.249",
      "203.0.114.7",
      "2001:db8:abcd:12::1",
      "2001:0db8:abcd:0012:ffff::2",
      "2001:db8:abcd:13::1",
      "not-an-ip",
      "0.0.0.1",
      "::1",
      "192.0.2.9",
      "::ffff:192.0.2.1",
      "::192.0.2.1",
      "::c000:201",
    ]) {
      const response = await request("/v1/sessions/guest", requestEnv, {
        method: "POST",
        headers: {
          authorization: `Bearer ${bearer}`,
          "cf-connecting-ip": ip,
        },
        body: { channel: "web" },
      });
      expect(response.status).toBe(201);
    }
    const missingIp = await request("/v1/sessions/guest", requestEnv, {
      method: "POST",
      headers: { authorization: `Bearer ${bearer}` },
      body: { channel: "web" },
    });
    expect(missingIp.status).toBe(201);

    expect(guestLimiter.keys).toHaveLength(14);
    expect(guestLimiter.keys[0]).toBe(guestLimiter.keys[1]);
    expect(guestLimiter.keys[0]).not.toBe(guestLimiter.keys[2]);
    expect(guestLimiter.keys[3]).toBe(guestLimiter.keys[4]);
    expect(guestLimiter.keys[3]).not.toBe(guestLimiter.keys[5]);
    expect(guestLimiter.keys[6]).toBe(guestLimiter.keys[13]);
    expect(guestLimiter.keys[7]).not.toBe(guestLimiter.keys[8]);
    expect(guestLimiter.keys[9]).toBe(guestLimiter.keys[10]);
    expect(guestLimiter.keys[11]).toBe(guestLimiter.keys[12]);
    for (const key of guestLimiter.keys) expect(key).toMatch(/^guest:[0-9a-f]{64}$/);
    const serialized = guestLimiter.keys.join("\n");
    expect(serialized).not.toContain("203.0.113");
    expect(serialized).not.toContain("203.0.114");
    expect(serialized).not.toContain("2001:db8");
    expect(serialized).not.toContain("not-an-ip");
    expect(serialized).not.toContain(bearer);
    expect(guestLimiter.keys[0]).not.toBe(
      `guest:${await hashSessionToken("203.0.113.0/24", workerEnv.SESSION_PEPPER)}`,
    );
  });

  it("allows only a literal success result and applies the limiter before body parsing", async () => {
    const malformedLimiter = new FakeLimiter(() => ({ success: "yes" }) as unknown as LimitResult);
    const requestEnv = testEnv({ GUEST_RATE_LIMITER: malformedLimiter });

    const response = await requestJson("/v1/sessions/guest", requestEnv, {
      method: "POST",
      headers: { "cf-connecting-ip": "203.0.113.90" },
      body: { privateMalformedBody: true },
    });

    expect(response.response.status).toBe(429);
    expect(ErrorEnvelopeSchema.parse(response.body).error.code).toBe("RATE_LIMITED");
    expect(malformedLimiter.keys).toHaveLength(1);
    const count = await workerEnv.DB.prepare("SELECT count(*) AS count FROM sessions").first<{
      count: number;
    }>();
    expect(count?.count).toBe(0);
  });

  it("sanitizes a rejected limiter call and does not mutate state", async () => {
    const rejectingLimiter = new FakeLimiter(() => {
      throw new Error("private limiter backend detail");
    });
    const requestEnv = testEnv({ GUEST_RATE_LIMITER: rejectingLimiter });

    const response = await requestJson("/v1/sessions/guest", requestEnv, {
      method: "POST",
      headers: { "cf-connecting-ip": "203.0.113.91" },
      body: { channel: "web" },
    });

    expect(response.response.status).toBe(500);
    const serialized = JSON.stringify(response.body);
    expect(ErrorEnvelopeSchema.parse(response.body).error.code).toBe("INTERNAL_ERROR");
    expect(serialized).not.toContain("private limiter backend detail");
    const count = await workerEnv.DB.prepare("SELECT count(*) AS count FROM sessions").first<{
      count: number;
    }>();
    expect(count?.count).toBe(0);
  });

  it("keys attempt and hint limiters by internal session id and fails closed before mutation", async () => {
    await seedContentFixture(workerEnv.DB);
    const attemptLimiter = new FakeLimiter(allow);
    const hintLimiter = new FakeLimiter(() => ({ success: false }));
    const requestEnv = testEnv({
      ATTEMPT_RATE_LIMITER: attemptLimiter,
      HINT_RATE_LIMITER: hintLimiter,
    });
    const issued = await issueGuest(requestEnv, "198.51.100.77");
    const sessionId = await sessionIdFor(issued.token);
    const attempt = await requestJson("/v1/attempts", requestEnv, {
      method: "POST",
      headers: {
        authorization: `Bearer ${issued.token}`,
        "cf-connecting-ip": "198.51.100.77",
      },
      body: {
        attemptUuid: crypto.randomUUID(),
        caseId: "case-2026-08-03",
        puzzleId: openingPuzzleFixture.contentKey,
        retraction: incorrectRetraction,
      },
    });
    const attemptBody = AttemptResultSchema.parse(attempt.body);
    expect(attempt.response.status).toBe(201);

    const hint = await requestJson(`/v1/attempts/${attemptBody.id}/hints`, requestEnv, {
      method: "POST",
      headers: {
        authorization: `Bearer ${issued.token}`,
        "cf-connecting-ip": "198.51.100.77",
      },
      body: { level: 1 },
    });

    expect(attemptLimiter.keys).toEqual([`attempt:${sessionId}`]);
    expect(hintLimiter.keys).toEqual([`hint:${sessionId}`]);
    expect([...attemptLimiter.keys, ...hintLimiter.keys].join("\n")).not.toContain(issued.token);
    expect([...attemptLimiter.keys, ...hintLimiter.keys].join("\n")).not.toContain("198.51.100.77");
    expect(hint.response.status).toBe(429);
    expect(hint.response.headers.get("cache-control")).toBe("no-store");
    const requestId = hint.response.headers.get("x-request-id");
    expect(ErrorEnvelopeSchema.parse(hint.body)).toEqual({
      error: {
        code: "RATE_LIMITED",
        message: "Too many requests.",
        requestId,
      },
    });
    const hints = await workerEnv.DB.prepare("SELECT count(*) AS count FROM hint_events").first<{
      count: number;
    }>();
    expect(hints?.count).toBe(0);
  });

  it("limits authenticated attempt and hint routes before parsing private request bodies", async () => {
    const attemptLimiter = new FakeLimiter(() => ({ success: false }));
    const hintLimiter = new FakeLimiter(() => ({ success: false }));
    const requestEnv = testEnv({
      ATTEMPT_RATE_LIMITER: attemptLimiter,
      HINT_RATE_LIMITER: hintLimiter,
    });
    const issued = await issueGuest(requestEnv);
    const sessionId = await sessionIdFor(issued.token);

    const attempt = await requestJson("/v1/attempts", requestEnv, {
      method: "POST",
      headers: { authorization: `Bearer ${issued.token}` },
      body: { privateMalformedAttempt: true },
    });
    const hint = await requestJson(`/v1/attempts/${crypto.randomUUID()}/hints`, requestEnv, {
      method: "POST",
      headers: { authorization: `Bearer ${issued.token}` },
      body: { privateMalformedHint: true },
    });

    expect(attempt.response.status).toBe(429);
    expect(hint.response.status).toBe(429);
    expect(ErrorEnvelopeSchema.parse(attempt.body).error.code).toBe("RATE_LIMITED");
    expect(ErrorEnvelopeSchema.parse(hint.body).error.code).toBe("RATE_LIMITED");
    expect(attemptLimiter.keys).toEqual([`attempt:${sessionId}`]);
    expect(hintLimiter.keys).toEqual([`hint:${sessionId}`]);
    const count = await workerEnv.DB.prepare("SELECT count(*) AS count FROM attempts").first<{
      count: number;
    }>();
    expect(count?.count).toBe(0);
  });

  it("logs only safe structured fields for success, errors, dynamic routes, and preflight", async () => {
    await seedContentFixture(workerEnv.DB);
    const requestEnv = testEnv();
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((value) => logs.push(String(value)));
    const rawIp = "192.0.2.193";
    const queryMarker = "query-secret-marker";
    const bodyMarker = "body-secret-marker";
    const pathMarker = "path-secret-marker";
    const issued = await issueGuest(requestEnv, rawIp);

    const daily = await request(`/v1/daily?date=2026-08-03&marker=${queryMarker}`, requestEnv, {
      headers: { authorization: `Bearer ${issued.token}`, "cf-connecting-ip": rawIp },
    });
    expect(daily.status).toBe(400);
    const dynamicError = await request(
      `/v1/attempts/${pathMarker}/hints?marker=${queryMarker}`,
      requestEnv,
      {
        method: "POST",
        headers: { authorization: `Bearer ${issued.token}`, "cf-connecting-ip": rawIp },
        body: { level: 1, privateValue: bodyMarker },
      },
    );
    expect(dynamicError.status).toBe(400);
    const preflight = await request(
      `/v1/attempts/${pathMarker}/hints?marker=${queryMarker}`,
      requestEnv,
      {
        method: "OPTIONS",
        headers: {
          authorization: `Bearer ${issued.token}`,
          "cf-connecting-ip": rawIp,
          origin: "https://agent-axiom.github.io",
        },
      },
    );
    expect(preflight.status).toBe(204);

    expect(logs).toHaveLength(4);
    const entries = logs.map((line) => JSON.parse(line) as Record<string, unknown>);
    for (const entry of entries) {
      expect(Object.keys(entry).sort()).toEqual(
        ["method", "path", "requestId", "sessionKind", "status"].sort(),
      );
      expect(entry.requestId).toMatch(/^[0-9a-f-]{36}$/);
      expect(entry.method).toMatch(/^(GET|POST|OPTIONS)$/);
      expect(entry.path).toEqual(expect.any(String));
      expect(entry.status).toEqual(expect.any(Number));
      expect(entry.sessionKind).toMatch(/^(none|guest|telegram)$/);
    }
    expect(entries.map((entry) => entry.path)).toEqual([
      "/v1/sessions/guest",
      "/v1/daily",
      `/v1/attempts/${pathMarker}/hints`,
      `/v1/attempts/${pathMarker}/hints`,
    ]);
    expect(entries.map((entry) => entry.status)).toEqual([201, 400, 400, 204]);
    expect(entries.map((entry) => entry.sessionKind)).toEqual(["none", "guest", "guest", "none"]);
    const serialized = logs.join("\n");
    for (const secret of [issued.token, rawIp, queryMarker, bodyMarker, "authorization"]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("does not let a logging failure break a request", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {
      throw new Error("logging backend unavailable");
    });

    const response = await request("/v1/healthz", testEnv());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(response.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("scheduled retention cleanup", () => {
  it("exports fetch and delegates cleanup exactly once through waitUntil", async () => {
    const now = 1_800_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now * 1_000);
    await seedSession({
      id: "expired-empty-session",
      token: "Z".repeat(43),
      expiresAt: now - 1,
    });

    expect((worker as unknown as { fetch?: unknown }).fetch).toBeTypeOf("function");
    await runScheduled(testEnv());

    const session = await workerEnv.DB.prepare("SELECT id FROM sessions WHERE id = ?")
      .bind("expired-empty-session")
      .first<{ id: string }>();
    expect(session).toBeNull();
  });

  it("uses strict session and hint boundaries while preserving player-linked history", async () => {
    const now = 1_800_000_000;
    const revokedGrace = 2_592_000;
    const hintRetention = 31_536_000;
    vi.spyOn(Date, "now").mockReturnValue(now * 1_000);
    await seedContentFixture(workerEnv.DB);
    await workerEnv.DB.prepare(
      `INSERT INTO players
        (id, telegram_user_id, display_name, created_at, updated_at)
       VALUES ('retained-player', '424242', 'Retained Player', 1, 1)`,
    ).run();

    await seedSession({
      id: "expired-guest",
      token: "A".repeat(43),
      expiresAt: now - 1,
    });
    await seedSession({
      id: "expiry-boundary-guest",
      token: "B".repeat(43),
      expiresAt: now,
    });
    await seedSession({
      id: "old-revoked-guest",
      token: "C".repeat(43),
      expiresAt: now + 10_000,
      revokedAt: now - revokedGrace - 1,
    });
    await seedSession({
      id: "revoke-boundary-guest",
      token: "D".repeat(43),
      expiresAt: now + 10_000,
      revokedAt: now - revokedGrace,
    });
    await seedSession({
      id: "expired-player-origin",
      token: "E".repeat(43),
      kind: "telegram",
      playerId: "retained-player",
      expiresAt: now - 1,
    });
    const activePlayerToken = "F".repeat(43);
    await seedSession({
      id: "active-player-session",
      token: activePlayerToken,
      kind: "telegram",
      playerId: "retained-player",
      expiresAt: now + 10_000,
    });

    await seedAttempt({ id: "expired-guest-attempt", sessionId: "expired-guest" });
    await seedAttempt({ id: "expiry-boundary-attempt", sessionId: "expiry-boundary-guest" });
    await seedAttempt({ id: "old-revoked-attempt", sessionId: "old-revoked-guest" });
    await seedAttempt({ id: "revoke-boundary-attempt", sessionId: "revoke-boundary-guest" });
    await seedAttempt({
      id: "retained-player-attempt",
      sessionId: "expired-player-origin",
      playerId: "retained-player",
      correct: true,
    });
    await workerEnv.DB.prepare(
      `INSERT INTO hint_events (attempt_id, hint_level, hint_json, created_at)
       VALUES ('expiry-boundary-attempt', 1, '{"level":1}', ?),
              ('expiry-boundary-attempt', 2, '{"level":2}', ?)`,
    )
      .bind(now - hintRetention - 1, now - hintRetention)
      .run();

    await runScheduled(testEnv());

    const sessions = await workerEnv.DB.prepare("SELECT id FROM sessions ORDER BY id").all<{
      id: string;
    }>();
    expect(sessions.results.map((row) => row.id)).toEqual([
      "active-player-session",
      "expiry-boundary-guest",
      "revoke-boundary-guest",
    ]);
    const attempts = await workerEnv.DB.prepare(
      "SELECT id, session_id, player_id FROM attempts ORDER BY id",
    ).all<{ id: string; session_id: string | null; player_id: string | null }>();
    expect(attempts.results).toEqual([
      {
        id: "expiry-boundary-attempt",
        session_id: "expiry-boundary-guest",
        player_id: null,
      },
      {
        id: "retained-player-attempt",
        session_id: null,
        player_id: "retained-player",
      },
      {
        id: "revoke-boundary-attempt",
        session_id: "revoke-boundary-guest",
        player_id: null,
      },
    ]);
    const hints = await workerEnv.DB.prepare(
      "SELECT hint_level, created_at FROM hint_events ORDER BY hint_level",
    ).all<{ hint_level: number; created_at: number }>();
    expect(hints.results).toEqual([{ hint_level: 2, created_at: now - hintRetention }]);

    const stats = await requestJson("/v1/me/stats", testEnv(), {
      headers: { authorization: `Bearer ${activePlayerToken}` },
    });
    expect(stats.response.status).toBe(200);
    expect(stats.body).toMatchObject({
      attempts: 1,
      solvedPuzzles: 1,
      completedCases: 1,
      lastCompletedDate: "2026-08-03",
    });

    await workerEnv.DB.prepare("DELETE FROM players WHERE id = ?").bind("retained-player").run();
    const linked = await workerEnv.DB.prepare("SELECT id FROM attempts WHERE id = ?")
      .bind("retained-player-attempt")
      .first<{ id: string }>();
    expect(linked).toBeNull();
  });
});
