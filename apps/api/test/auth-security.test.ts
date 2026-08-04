import {
  ErrorEnvelopeSchema,
  SessionIssuedSchema,
  TelegramSessionIssuedSchema,
} from "@a-move-ago/api-contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env, RateLimitBinding } from "../src/env";
import { cleanupExpired } from "../src/scheduled";
import { signedMiniAppData } from "./fixtures/telegram";
import {
  authenticatedJson,
  issueGuest,
  requestJson,
  resetDatabase,
  seedAttempt,
  testEnv,
} from "./helpers/http";

const allowedOrigin = "https://agent-axiom.github.io";
const deniedOrigin = "https://agent-axiom.github.io.evil.test";
const expectedProfile = {
  telegramUserId: "987654321",
  displayName: "Ada Lovelace",
  username: "ada",
  avatarUrl: "https://cdn.example/avatar.jpg",
};

function overrideEnv(bindings: Partial<Env>): Env {
  const requestEnv = Object.create(testEnv) as Env;
  for (const [key, value] of Object.entries(bindings)) {
    Object.defineProperty(requestEnv, key, { configurable: true, enumerable: true, value });
  }
  return requestEnv;
}

async function validInitData(): Promise<string> {
  return await signedMiniAppData({
    botToken: testEnv.TELEGRAM_BOT_TOKEN,
    authDate: Math.floor(Date.now() / 1_000),
  });
}

async function telegramLogin(guest: Awaited<ReturnType<typeof issueGuest>>) {
  const rawInitData = await validInitData();
  const response = await authenticatedJson("/v1/auth/telegram/mini-app", guest.token, {
    method: "POST",
    body: { initData: rawInitData },
  });
  expect(response.response.status).toBe(200);
  return { rawInitData, issued: TelegramSessionIssuedSchema.parse(response.body) };
}

async function expectError(
  result: Awaited<ReturnType<typeof authenticatedJson>>,
  status: number,
  code: string,
) {
  expect(result.response.status).toBe(status);
  expect(ErrorEnvelopeSchema.parse(result.body).error.code).toBe(code);
}

type MutationCase = {
  name: string;
  channel: "web" | "telegram";
  path: string;
  body: "mini-app" | "oidc-start" | "handoff" | "none";
  missingOriginStatus: number;
  missingOriginCode?: string;
};

const browserMutations: MutationCase[] = [
  {
    name: "Mini App login",
    channel: "telegram",
    path: "/v1/auth/telegram/mini-app",
    body: "mini-app",
    missingOriginStatus: 200,
  },
  {
    name: "OIDC start",
    channel: "web",
    path: "/v1/auth/telegram/oidc/start",
    body: "oidc-start",
    missingOriginStatus: 200,
  },
  {
    name: "handoff exchange",
    channel: "web",
    path: "/v1/auth/session/exchange",
    body: "handoff",
    missingOriginStatus: 401,
    missingOriginCode: "HANDOFF_INVALID",
  },
  {
    name: "logout",
    channel: "web",
    path: "/v1/auth/logout",
    body: "none",
    missingOriginStatus: 200,
  },
];

async function mutationBody(kind: MutationCase["body"]): Promise<unknown | undefined> {
  switch (kind) {
    case "mini-app":
      return { initData: await validInitData() };
    case "oidc-start":
      return { channel: "web" };
    case "handoff":
      return { handoffCode: "H".repeat(43) };
    case "none":
      return undefined;
  }
}

async function runMutation(testCase: MutationCase, origin?: string) {
  const guest = await issueGuest(testCase.channel);
  const body = await mutationBody(testCase.body);
  return {
    guest,
    result: await authenticatedJson(testCase.path, guest.token, {
      method: "POST",
      ...(origin ? { headers: { origin } } : {}),
      ...(body === undefined ? {} : { body }),
    }),
  };
}

async function seedAuthFlow(input: {
  id: string;
  guestSessionId: string;
  expiresAt: number;
  createdAt: number;
  playerId?: string;
  handoffExpiresAt?: number;
}) {
  const hasHandoff = input.handoffExpiresAt !== undefined;
  await testEnv.DB.prepare(
    `INSERT INTO auth_flows
      (id, state_hash, guest_session_id, channel, nonce, pkce_verifier,
       expires_at, callback_claimed_at, player_id, handoff_hash,
       handoff_expires_at, handoff_consumed_at, handoff_session_id, created_at)
     VALUES (?, ?, ?, 'web', ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)`,
  )
    .bind(
      input.id,
      `state-${input.id}`,
      input.guestSessionId,
      `nonce-${input.id}`,
      `verifier-${input.id}`,
      input.expiresAt,
      hasHandoff ? input.createdAt : null,
      hasHandoff ? input.playerId : null,
      hasHandoff ? `handoff-${input.id}` : null,
      input.handoffExpiresAt ?? null,
      input.createdAt,
    )
    .run();
}

beforeEach(resetDatabase);

afterEach(async () => {
  vi.restoreAllMocks();
  await testEnv.DB.prepare("DROP TRIGGER IF EXISTS test_ignore_logout_revoke").run();
});

describe("Telegram profile and logout isolation", () => {
  it("returns the verified profile and logs out to a new unlinked guest without deleting progress", async () => {
    const guest = await issueGuest("telegram");
    await seedAttempt({ sessionId: guest.sessionId, attemptId: "attempt-before-logout" });
    const { issued } = await telegramLogin(guest);

    const me = await authenticatedJson("/v1/me", issued.token);
    expect(me.body).toEqual({ kind: "telegram", profile: expectedProfile });
    expect(me.response.headers.get("cache-control")).toBe("no-store");

    const telegramSession = await testEnv.DB.prepare(
      `SELECT id, player_id FROM sessions
        WHERE rotated_from_session_id = ? AND kind = 'telegram'`,
    )
      .bind(guest.sessionId)
      .first<{ id: string; player_id: string }>();
    if (!telegramSession) throw new Error("Expected a Telegram replacement session.");

    const logout = await authenticatedJson("/v1/auth/logout", issued.token, { method: "POST" });
    expect(logout.body).toMatchObject({ kind: "guest" });
    const replacement = SessionIssuedSchema.parse(logout.body);
    expect((await authenticatedJson("/v1/me", issued.token)).response.status).toBe(401);
    expect((await authenticatedJson("/v1/me", replacement.token)).body).toEqual({
      kind: "guest",
      profile: null,
    });

    const newGuest = await testEnv.DB.prepare(
      `SELECT kind, player_id, rotated_from_session_id FROM sessions
        WHERE rotated_from_session_id = ?`,
    )
      .bind(telegramSession.id)
      .first<{ kind: string; player_id: string | null; rotated_from_session_id: string }>();
    expect(newGuest).toEqual({
      kind: "guest",
      player_id: null,
      rotated_from_session_id: telegramSession.id,
    });
    const attempt = await testEnv.DB.prepare(
      "SELECT player_id FROM attempts WHERE id = 'attempt-before-logout'",
    ).first<{ player_id: string | null }>();
    expect(attempt?.player_id).toBe(telegramSession.player_id);
  });

  it("rolls back a logout whose guest revocation is silently ignored, then retries", async () => {
    const guest = await issueGuest("web");
    await testEnv.DB.prepare(
      `CREATE TRIGGER test_ignore_logout_revoke
       BEFORE UPDATE OF revoked_at ON sessions
       WHEN OLD.id = '${guest.sessionId}' AND NEW.revoked_at IS NOT NULL
       BEGIN
         SELECT RAISE(IGNORE);
       END`,
    ).run();

    const failed = await authenticatedJson("/v1/auth/logout", guest.token, { method: "POST" });
    expect(failed.response.status).toBe(500);
    expect((await authenticatedJson("/v1/me", guest.token)).response.status).toBe(200);
    expect(
      (
        await testEnv.DB.prepare(
          "SELECT count(*) AS count FROM sessions WHERE rotated_from_session_id = ?",
        )
          .bind(guest.sessionId)
          .first<{ count: number }>()
      )?.count,
    ).toBe(0);

    await testEnv.DB.prepare("DROP TRIGGER test_ignore_logout_revoke").run();
    const retry = await authenticatedJson("/v1/auth/logout", guest.token, { method: "POST" });
    expect(retry.response.status).toBe(200);
    expect(SessionIssuedSchema.parse(retry.body).kind).toBe("guest");
  });
});

describe("browser auth mutation Origin checks", () => {
  it.each(browserMutations)("rejects a lookalike Origin on $name", async (testCase) => {
    const { guest, result } = await runMutation(testCase, deniedOrigin);

    await expectError(result, 403, "ORIGIN_NOT_ALLOWED");
    expect((await authenticatedJson("/v1/me", guest.token)).response.status).toBe(200);
  });

  it.each(browserMutations)("accepts a missing Origin on $name", async (testCase) => {
    const { result } = await runMutation(testCase);

    expect(result.response.status).toBe(testCase.missingOriginStatus);
    if (testCase.missingOriginCode) {
      expect(ErrorEnvelopeSchema.parse(result.body).error.code).toBe(testCase.missingOriginCode);
    }
  });

  it("accepts the exact configured Origin", async () => {
    const oidcStart = browserMutations.find((testCase) => testCase.body === "oidc-start");
    if (!oidcStart) throw new Error("Expected the OIDC start mutation case.");
    const { result } = await runMutation(oidcStart, allowedOrigin);
    expect(result.response.status).toBe(200);
  });

  it("does not apply mutation Origin checks to the top-level Telegram callback", async () => {
    const response = await requestJson(
      `/v1/auth/telegram/oidc/callback?state=${"S".repeat(43)}&code=provider-code`,
      { headers: { origin: deniedOrigin } },
    );

    expect(response.response.status).toBe(400);
    expect(ErrorEnvelopeSchema.parse(response.body).error.code).toBe("OIDC_STATE_INVALID");
  });
});

describe("auth limiting and safe structured logs", () => {
  it("returns RATE_LIMITED when the auth limiter denies the mutation", async () => {
    const guest = await issueGuest("web");
    const keys: string[] = [];
    const limiter: RateLimitBinding = {
      limit: async ({ key }) => {
        keys.push(key);
        return { success: false };
      },
    };

    const denied = await authenticatedJson(
      "/v1/auth/telegram/oidc/start",
      guest.token,
      { method: "POST", body: { channel: "web" } },
      overrideEnv({ AUTH_RATE_LIMITER: limiter }),
    );

    await expectError(denied, 429, "RATE_LIMITED");
    expect(keys).toEqual([`auth:${guest.sessionId}`]);
  });

  it("logs only safe fields without raw initData, tokens, handoffs, or query values", async () => {
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((value) => logs.push(String(value)));
    const telegramGuest = await issueGuest("telegram");
    const rawInitData = await validInitData();
    const miniApp = await authenticatedJson("/v1/auth/telegram/mini-app", telegramGuest.token, {
      method: "POST",
      body: { initData: rawInitData },
    });
    expect(miniApp.response.status).toBe(200);

    const webGuest = await issueGuest("web");
    const rawHandoff = "Q".repeat(43);
    const exchange = await authenticatedJson("/v1/auth/session/exchange", webGuest.token, {
      method: "POST",
      body: { handoffCode: rawHandoff },
    });
    expect(exchange.response.status).toBe(401);
    const queryMarker = "provider-query-secret-marker";
    const callback = await requestJson(
      `/v1/auth/telegram/oidc/callback?state=${"S".repeat(43)}&code=${queryMarker}&handoff=${rawHandoff}`,
    );
    expect(callback.response.status).toBe(400);

    expect(logs).toHaveLength(5);
    const entries = logs.map((line) => JSON.parse(line) as Record<string, unknown>);
    for (const entry of entries) {
      expect
        .soft(Object.keys(entry).sort())
        .toEqual(["method", "path", "requestId", "sessionKind", "status"].sort());
      expect.soft(entry.requestId).toMatch(/^[0-9a-f-]{36}$/);
      expect.soft(entry.method).toMatch(/^(GET|POST)$/);
      expect.soft(entry.path).toEqual(expect.any(String));
      expect.soft(entry.status).toEqual(expect.any(Number));
      expect.soft(entry.sessionKind).toMatch(/^(none|guest)$/);
    }
    expect
      .soft(entries.map((entry) => entry.path))
      .toEqual([
        "/v1/sessions/guest",
        "/v1/auth/telegram/mini-app",
        "/v1/sessions/guest",
        "/v1/auth/session/exchange",
        "/v1/auth/telegram/oidc/callback",
      ]);

    const serialized = logs.join("\n");
    for (const secret of [
      rawInitData,
      telegramGuest.token,
      webGuest.token,
      rawHandoff,
      queryMarker,
      "handoff=",
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });
});

describe("expired auth-flow cleanup", () => {
  it("deletes state or handoff expiry only after the one-day grace boundary", async () => {
    const now = Math.floor(Date.now() / 1_000);
    const graceBoundary = now - 86_400;
    const guest = await issueGuest("web");
    await testEnv.DB.prepare(
      `INSERT INTO players
        (id, telegram_user_id, display_name, created_at, updated_at)
       VALUES ('cleanup-player', '424242', 'Cleanup Player', ?, ?)`,
    )
      .bind(now, now)
      .run();

    const flows = [
      { id: "old-state", expiresAt: graceBoundary - 1 },
      { id: "state-boundary", expiresAt: graceBoundary },
      { id: "recent-state", expiresAt: now - 1 },
      {
        id: "old-handoff",
        expiresAt: now + 1_000,
        playerId: "cleanup-player",
        handoffExpiresAt: graceBoundary - 1,
      },
      {
        id: "handoff-boundary",
        expiresAt: now + 1_000,
        playerId: "cleanup-player",
        handoffExpiresAt: graceBoundary,
      },
    ];
    for (const flow of flows) {
      await seedAuthFlow({
        ...flow,
        guestSessionId: guest.sessionId,
        createdAt: now - 100,
      });
    }

    await cleanupExpired(testEnv, now);

    const remaining = await testEnv.DB.prepare("SELECT id FROM auth_flows ORDER BY id").all<{
      id: string;
    }>();
    expect(remaining.results.map((row) => row.id)).toEqual([
      "handoff-boundary",
      "recent-state",
      "state-boundary",
    ]);
  });
});
