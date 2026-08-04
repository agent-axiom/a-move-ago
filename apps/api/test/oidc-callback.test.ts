import {
  ErrorEnvelopeSchema,
  OidcStartResponseSchema,
  TelegramSessionIssuedSchema,
} from "@a-move-ago/api-contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app";
import { OidcProviderError, type TelegramOidcProvider } from "../src/auth/telegram-oidc";
import type { VerifiedTelegramIdentity } from "../src/auth/types";
import { hashOpaqueToken } from "../src/crypto/opaque-token";
import { claimAuthFlow } from "../src/db/auth-flows";
import type { Env } from "../src/env";
import { exchangeOidcHandoff } from "../src/services/oidc-service";
import { authenticatedJson, issueGuest, resetDatabase, seedAttempt, testEnv } from "./helpers/http";

const verifiedOidcIdentity = {
  telegramUserId: "987654321",
  displayName: "Ada Lovelace",
  username: "ada",
  avatarUrl: "https://cdn.example/avatar.jpg",
  oidc: {
    issuer: "https://oauth.telegram.org" as const,
    subject: "telegram-subject-987654321",
    audience: "123456789",
  },
} satisfies VerifiedTelegramIdentity;

type TestApp = ReturnType<typeof createApp>;
type Guest = Awaited<ReturnType<typeof issueGuest>>;

function overrideEnv(bindings: Partial<Env>): Env {
  const requestEnv = Object.create(testEnv) as Env;
  for (const [key, value] of Object.entries(bindings)) {
    Object.defineProperty(requestEnv, key, { configurable: true, enumerable: true, value });
  }
  return requestEnv;
}

function fakeProvider(identity: VerifiedTelegramIdentity = verifiedOidcIdentity) {
  return {
    exchangeAndVerify: vi.fn(async () => identity),
  } satisfies TelegramOidcProvider;
}

async function appRequest(
  app: TestApp,
  path: string,
  init: {
    method?: string;
    token?: string;
    body?: unknown;
    headers?: HeadersInit;
  } = {},
  requestEnv: Env = testEnv,
): Promise<Response> {
  const headers = new Headers(init.headers);
  if (init.token) headers.set("authorization", `Bearer ${init.token}`);
  const requestInit: RequestInit = { headers };
  if (init.method) requestInit.method = init.method;
  if (init.body !== undefined) {
    headers.set("content-type", "application/json");
    requestInit.body = typeof init.body === "string" ? init.body : JSON.stringify(init.body);
  }
  return await app.fetch(new Request(`https://api.test${path}`, requestInit), requestEnv);
}

async function appJson(
  app: TestApp,
  path: string,
  init: Parameters<typeof appRequest>[2] = {},
  requestEnv: Env = testEnv,
) {
  const response = await appRequest(app, path, init, requestEnv);
  return { response, body: (await response.json()) as unknown };
}

async function startFlow(app: TestApp, guest: Guest, channel: "web" | "android" = "web") {
  const started = await appJson(app, "/v1/auth/telegram/oidc/start", {
    method: "POST",
    token: guest.token,
    body: { channel },
  });
  expect(started.response.status).toBe(200);
  const body = OidcStartResponseSchema.parse(started.body);
  const authorizationUrl = new URL(body.authorizationUrl);
  const state = authorizationUrl.searchParams.get("state");
  if (!state) throw new Error("OIDC start did not return state.");
  return { state, authorizationUrl };
}

function callbackPath(state: string, suffix = "code=provider-code") {
  return `/v1/auth/telegram/oidc/callback?state=${encodeURIComponent(state)}&${suffix}`;
}

function expectCallbackHeaders(response: Response) {
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
}

async function expectApiError(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  expect(ErrorEnvelopeSchema.parse(await response.json()).error.code).toBe(code);
}

async function completeFlow(app: TestApp, guest: Guest, channel: "web" | "android" = "web") {
  const { state } = await startFlow(app, guest, channel);
  const response = await appRequest(app, callbackPath(state));
  expect(response.status).toBe(302);
  expectCallbackHeaders(response);
  const location = response.headers.get("location");
  if (!location) throw new Error("OIDC callback did not return a location.");
  const handoffCode = new URL(location).searchParams.get("handoff");
  if (!handoffCode) throw new Error("OIDC callback did not return a handoff.");
  return { state, response, location, handoffCode };
}

async function authFlowCount() {
  return (
    (
      await testEnv.DB.prepare("SELECT count(*) AS count FROM auth_flows").first<{
        count: number;
      }>()
    )?.count ?? -1
  );
}

async function seedPlayerMapping(existing: {
  telegramUserId: string;
  issuer: string;
  subject: string;
  audience: string;
}) {
  const now = Math.floor(Date.now() / 1000);
  await testEnv.DB.prepare(
    `INSERT INTO players
      (id, telegram_user_id, oidc_issuer, oidc_subject, oidc_audience,
       display_name, username, avatar_url, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'Existing', NULL, NULL, ?, ?)`,
  )
    .bind(
      crypto.randomUUID(),
      existing.telegramUserId,
      existing.issuer,
      existing.subject,
      existing.audience,
      now,
      now,
    )
    .run();
}

async function readAllPlayerMappings() {
  return (
    await testEnv.DB.prepare(
      `SELECT telegram_user_id, oidc_issuer, oidc_subject, oidc_audience,
              display_name, username, avatar_url
         FROM players ORDER BY telegram_user_id`,
    ).all()
  ).results;
}

async function completeCallbackForIdentity(identity: VerifiedTelegramIdentity) {
  const provider = fakeProvider(identity);
  const app = createApp({ oidcProvider: provider });
  const guest = await issueGuest("web");
  const { state } = await startFlow(app, guest);
  return await appRequest(app, callbackPath(state));
}

beforeEach(resetDatabase);

afterEach(async () => {
  vi.restoreAllMocks();
  await testEnv.DB.prepare("DROP TRIGGER IF EXISTS test_fail_handoff_session_insert").run();
  await testEnv.DB.prepare("DROP TRIGGER IF EXISTS test_ignore_handoff_session_insert").run();
  await testEnv.DB.prepare("DROP TRIGGER IF EXISTS test_ignore_handoff_revoke").run();
  await testEnv.DB.prepare("DROP TRIGGER IF EXISTS test_ignore_auth_flow_completion").run();
  await testEnv.DB.prepare("DROP TRIGGER IF EXISTS test_ignore_oidc_player_update").run();
});

describe("Telegram OIDC callback and handoff exchange", () => {
  it("completes a Web login without storing secrets and atomically migrates guest progress", async () => {
    const provider = fakeProvider();
    const app = createApp({ oidcProvider: provider });
    const guest = await issueGuest("web");
    await seedAttempt({ sessionId: guest.sessionId, attemptId: crypto.randomUUID() });
    const { state } = await startFlow(app, guest);

    const injectedReturn = await appRequest(
      app,
      `${callbackPath(state)}&returnUrl=https%3A%2F%2Fevil.test`,
    );
    await expectApiError(injectedReturn, 400, "OIDC_CALLBACK_INVALID");
    expectCallbackHeaders(injectedReturn);
    expect(provider.exchangeAndVerify).not.toHaveBeenCalled();

    const storedBefore = await testEnv.DB.prepare(
      "SELECT nonce, pkce_verifier, callback_claimed_at FROM auth_flows",
    ).first<{
      nonce: string;
      pkce_verifier: string;
      callback_claimed_at: number | null;
    }>();
    if (!storedBefore) throw new Error("Expected a stored OIDC flow.");
    expect(storedBefore.callback_claimed_at).toBeNull();

    const callback = await appRequest(app, callbackPath(state));
    expect(callback.status).toBe(302);
    expectCallbackHeaders(callback);
    const returnUrl = new URL(callback.headers.get("location") ?? "");
    expect(returnUrl.origin + returnUrl.pathname).toBe("https://agent-axiom.github.io/a-move-ago/");
    expect([...returnUrl.searchParams.keys()]).toEqual(["handoff"]);
    const handoffCode = returnUrl.searchParams.get("handoff");
    expect(handoffCode).toMatch(/^[A-Za-z0-9_-]{43}$/);
    if (!handoffCode) throw new Error("Expected handoff code.");

    expect(provider.exchangeAndVerify).toHaveBeenCalledTimes(1);
    expect(provider.exchangeAndVerify).toHaveBeenCalledWith({
      code: "provider-code",
      verifier: storedBefore.pkce_verifier,
      expectedNonce: storedBefore.nonce,
      clientId: testEnv.TELEGRAM_OIDC_CLIENT_ID,
      clientSecret: testEnv.TELEGRAM_OIDC_CLIENT_SECRET,
      redirectUri: testEnv.TELEGRAM_OIDC_CALLBACK_URL,
    });

    const persisted = await testEnv.DB.prepare(
      `SELECT state_hash, nonce, pkce_verifier, handoff_hash, handoff_consumed_at,
              handoff_session_id, player_id
         FROM auth_flows`,
    ).first<Record<string, string | number | null>>();
    expect(persisted?.handoff_hash).toBe(
      await hashOpaqueToken(handoffCode, testEnv.SESSION_PEPPER, "oidc-handoff"),
    );
    expect(persisted?.handoff_hash).not.toBe(handoffCode);
    expect(persisted?.handoff_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(persisted?.handoff_consumed_at).toBeNull();
    expect(JSON.stringify(persisted)).not.toContain(state);
    expect(JSON.stringify(persisted)).not.toContain(handoffCode);
    expect(JSON.stringify(persisted)).not.toContain("provider-code");

    const thief = await issueGuest("web");
    const stolen = await appJson(app, "/v1/auth/session/exchange", {
      method: "POST",
      token: thief.token,
      body: { handoffCode },
    });
    expect(stolen.response.headers.get("cache-control")).toBe("no-store");
    expect(stolen.response.status).toBe(401);
    expect(ErrorEnvelopeSchema.parse(stolen.body).error.code).toBe("HANDOFF_INVALID");
    expect(
      (
        await testEnv.DB.prepare("SELECT handoff_consumed_at FROM auth_flows").first<{
          handoff_consumed_at: number | null;
        }>()
      )?.handoff_consumed_at,
    ).toBeNull();

    const exchange = await appJson(app, "/v1/auth/session/exchange", {
      method: "POST",
      token: guest.token,
      body: { handoffCode },
    });
    expect(exchange.response.status).toBe(200);
    expect(exchange.response.headers.get("cache-control")).toBe("no-store");
    const issued = TelegramSessionIssuedSchema.parse(exchange.body);
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

    const attempt = await testEnv.DB.prepare("SELECT session_id, player_id FROM attempts").first<{
      session_id: string;
      player_id: string | null;
    }>();
    expect(attempt).toEqual({ session_id: guest.sessionId, player_id: persisted?.player_id });
    const completed = await testEnv.DB.prepare(
      "SELECT handoff_consumed_at, handoff_session_id FROM auth_flows",
    ).first<{ handoff_consumed_at: number | null; handoff_session_id: string | null }>();
    expect(completed?.handoff_consumed_at).not.toBeNull();
    expect(completed?.handoff_session_id).not.toBeNull();

    const oldMe = await authenticatedJson("/v1/me", guest.token);
    expect(oldMe.response.status).toBe(401);
    const newMe = await authenticatedJson("/v1/me", issued.token);
    expect(newMe.response.status).toBe(200);
    expect(newMe.body).toEqual({ kind: "telegram", profile: issued.profile });

    const replay = await appJson(app, "/v1/auth/session/exchange", {
      method: "POST",
      token: guest.token,
      body: { handoffCode },
    });
    expect(replay.response.status).toBe(401);
    const successors = await testEnv.DB.prepare(
      "SELECT id FROM sessions WHERE rotated_from_session_id = ?",
    )
      .bind(guest.sessionId)
      .all();
    expect(successors.results).toHaveLength(1);
  });

  it("owns only the exact public auth routes", async () => {
    const app = createApp({ oidcProvider: fakeProvider() });
    expect((await appRequest(app, "/v1/auth/start", { method: "POST" })).status).toBe(404);
    expect((await appRequest(app, "/v1/auth/callback")).status).toBe(404);
    expect(
      (
        await appRequest(app, "/v1/auth/telegram/oidc/session/exchange", {
          method: "POST",
        })
      ).status,
    ).toBe(404);
  });

  it("strictly rejects ambiguous callback queries without consuming state", async () => {
    const provider = fakeProvider();
    const app = createApp({ oidcProvider: provider });
    const guest = await issueGuest("web");
    const { state } = await startFlow(app, guest);
    const encoded = encodeURIComponent(state);
    const invalidQueries = [
      `state=${encoded}&code=provider-code&extra=1`,
      `state=${encoded}&state=${encoded}&code=provider-code`,
      `state=${encoded}&code=provider-code&code=second`,
      `state=${encoded}&code=provider-code&error=access_denied`,
      `state=${encoded}`,
      `code=provider-code`,
    ];
    for (const query of invalidQueries) {
      const response = await appRequest(app, `/v1/auth/telegram/oidc/callback?${query}`);
      await expectApiError(response, 400, "OIDC_CALLBACK_INVALID");
      expectCallbackHeaders(response);
    }
    expect(provider.exchangeAndVerify).not.toHaveBeenCalled();
    expect(
      (
        await testEnv.DB.prepare("SELECT callback_claimed_at FROM auth_flows").first<{
          callback_claimed_at: number | null;
        }>()
      )?.callback_claimed_at,
    ).toBeNull();
    expect((await appRequest(app, callbackPath(state))).status).toBe(302);
    expect(provider.exchangeAndVerify).toHaveBeenCalledTimes(1);
  });

  it("claims state atomically so parallel callbacks invoke the provider only once", async () => {
    const provider = fakeProvider();
    const app = createApp({ oidcProvider: provider });
    const guest = await issueGuest("web");
    const { state } = await startFlow(app, guest);

    const unknown = await appRequest(app, callbackPath("A".repeat(43)));
    await expectApiError(unknown, 400, "OIDC_STATE_INVALID");
    expectCallbackHeaders(unknown);

    const responses = await Promise.all([
      appRequest(app, callbackPath(state)),
      appRequest(app, callbackPath(state)),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([302, 400]);
    for (const response of responses) expectCallbackHeaders(response);
    const failed = responses.find((response) => response.status === 400);
    if (!failed) throw new Error("Expected a replay failure.");
    expect(ErrorEnvelopeSchema.parse(await failed.json()).error.code).toBe("OIDC_STATE_INVALID");
    expect(provider.exchangeAndVerify).toHaveBeenCalledTimes(1);
  });

  it("rejects expired state and state whose original guest is no longer active", async () => {
    const provider = fakeProvider();
    const app = createApp({ oidcProvider: provider });

    const expiredGuest = await issueGuest("web");
    const expired = await startFlow(app, expiredGuest);
    await testEnv.DB.prepare("UPDATE auth_flows SET expires_at = 0 WHERE guest_session_id = ?")
      .bind(expiredGuest.sessionId)
      .run();
    const expiredResponse = await appRequest(app, callbackPath(expired.state));
    await expectApiError(expiredResponse, 400, "OIDC_STATE_INVALID");
    expectCallbackHeaders(expiredResponse);

    const revokedGuest = await issueGuest("web");
    const revoked = await startFlow(app, revokedGuest);
    await testEnv.DB.prepare("UPDATE sessions SET revoked_at = unixepoch() WHERE id = ?")
      .bind(revokedGuest.sessionId)
      .run();
    const revokedResponse = await appRequest(app, callbackPath(revoked.state));
    await expectApiError(revokedResponse, 400, "OIDC_STATE_INVALID");
    expectCallbackHeaders(revokedResponse);
    expect(provider.exchangeAndVerify).not.toHaveBeenCalled();
  });

  it("uses the sampled request time at the exact state-expiry boundary", async () => {
    const app = createApp({ oidcProvider: fakeProvider() });
    const guest = await issueGuest("web");
    await startFlow(app, guest);
    const flow = await testEnv.DB.prepare("SELECT state_hash, expires_at FROM auth_flows").first<{
      state_hash: string;
      expires_at: number;
    }>();
    if (!flow) throw new Error("Expected an OIDC flow.");

    expect(await claimAuthFlow(testEnv.DB, flow.state_hash, flow.expires_at)).toBeNull();
    expect(
      (
        await testEnv.DB.prepare("SELECT callback_claimed_at FROM auth_flows").first<{
          callback_claimed_at: number | null;
        }>()
      )?.callback_claimed_at,
    ).toBeNull();
  });

  it("claims provider denial once and redirects only to the fixed target", async () => {
    const provider = fakeProvider();
    const app = createApp({ oidcProvider: provider });
    const guest = await issueGuest("web");
    const { state } = await startFlow(app, guest);
    const response = await appRequest(
      app,
      callbackPath(
        state,
        `error=temporarily_unavailable&error_description=${encodeURIComponent(
          "https://evil.test/?secret=provider-detail",
        )}`,
      ),
    );

    expect(response.status).toBe(302);
    expectCallbackHeaders(response);
    expect(response.headers.get("location")).toBe(
      "https://agent-axiom.github.io/a-move-ago/?authError=access_denied",
    );
    expect(response.headers.get("location")).not.toContain("provider-detail");
    expect(provider.exchangeAndVerify).not.toHaveBeenCalled();

    const replay = await appRequest(
      app,
      callbackPath(state, "error=access_denied&error_description=again"),
    );
    await expectApiError(replay, 400, "OIDC_STATE_INVALID");
    expectCallbackHeaders(replay);
  });

  it.each([
    { code: "OIDC_PROVIDER_ERROR" as const, status: 503 },
    { code: "OIDC_TOKEN_INVALID" as const, status: 401 },
  ])("maps $code to a sanitized callback error and consumes state", async ({ code, status }) => {
    const provider: TelegramOidcProvider = {
      exchangeAndVerify: vi.fn(async () => {
        throw new OidcProviderError(code);
      }),
    };
    const app = createApp({ oidcProvider: provider });
    const guest = await issueGuest("web");
    const { state } = await startFlow(app, guest);
    const failed = await appRequest(app, callbackPath(state));

    await expectApiError(failed, status, code);
    expectCallbackHeaders(failed);
    const replay = await appRequest(app, callbackPath(state));
    await expectApiError(replay, 400, "OIDC_STATE_INVALID");
    expectCallbackHeaders(replay);
    expect(provider.exchangeAndVerify).toHaveBeenCalledTimes(1);
  });

  it("rejects a verified identity without OIDC claims", async () => {
    const { oidc: _oidc, ...miniAppIdentity } = verifiedOidcIdentity;
    const provider = fakeProvider(miniAppIdentity);
    const app = createApp({ oidcProvider: provider });
    const guest = await issueGuest("web");
    const { state } = await startFlow(app, guest);
    const response = await appRequest(app, callbackPath(state));
    await expectApiError(response, 401, "OIDC_TOKEN_INVALID");
    expectCallbackHeaders(response);
    expect(await readAllPlayerMappings()).toEqual([]);
  });

  it("uses the fixed Android debug target and exchanges only on the original channel", async () => {
    const app = createApp({ oidcProvider: fakeProvider() });
    const android = await issueGuest("android");
    const completed = await completeFlow(app, android, "android");
    expect(completed.location).toBe(`amoveago-debug://auth?handoff=${completed.handoffCode}`);

    const webThief = await issueGuest("web");
    const wrongChannel = await appJson(app, "/v1/auth/session/exchange", {
      method: "POST",
      token: webThief.token,
      body: { handoffCode: completed.handoffCode },
    });
    expect(wrongChannel.response.status).toBe(401);
    expect(ErrorEnvelopeSchema.parse(wrongChannel.body).error.code).toBe("HANDOFF_INVALID");

    const exchange = await appJson(app, "/v1/auth/session/exchange", {
      method: "POST",
      token: android.token,
      body: { handoffCode: completed.handoffCode },
    });
    expect(exchange.response.status).toBe(200);
    expect(TelegramSessionIssuedSchema.parse(exchange.body).kind).toBe("telegram");
  });

  it("rejects malformed, expired, and non-guest handoff exchanges without consuming them", async () => {
    const app = createApp({ oidcProvider: fakeProvider() });
    const guest = await issueGuest("web");
    const completed = await completeFlow(app, guest);

    for (const body of [
      {},
      { handoffCode: "short" },
      { handoffCode: completed.handoffCode, extra: true },
    ]) {
      const malformed = await appJson(app, "/v1/auth/session/exchange", {
        method: "POST",
        token: guest.token,
        body,
      });
      expect(malformed.response.status).toBe(400);
      expect(malformed.response.headers.get("cache-control")).toBe("no-store");
      expect(ErrorEnvelopeSchema.parse(malformed.body).error.code).toBe("INVALID_REQUEST");
    }

    await testEnv.DB.prepare("UPDATE auth_flows SET handoff_expires_at = 0").run();
    const expired = await appJson(app, "/v1/auth/session/exchange", {
      method: "POST",
      token: guest.token,
      body: { handoffCode: completed.handoffCode },
    });
    expect(expired.response.status).toBe(401);
    expect(ErrorEnvelopeSchema.parse(expired.body).error.code).toBe("HANDOFF_INVALID");
    expect(
      (
        await testEnv.DB.prepare("SELECT handoff_consumed_at FROM auth_flows").first<{
          handoff_consumed_at: number | null;
        }>()
      )?.handoff_consumed_at,
    ).toBeNull();

    const telegramGuest = await issueGuest("telegram");
    const now = Math.floor(Date.now() / 1000);
    await testEnv.DB.prepare(
      `INSERT INTO players
        (id, telegram_user_id, display_name, username, avatar_url, created_at, updated_at)
       VALUES ('telegram-actor', '42', 'Actor', NULL, NULL, ?, ?)`,
    )
      .bind(now, now)
      .run();
    await testEnv.DB.prepare(
      "UPDATE sessions SET kind = 'telegram', player_id = 'telegram-actor' WHERE id = ?",
    )
      .bind(telegramGuest.sessionId)
      .run();
    const wrongActor = await appJson(app, "/v1/auth/session/exchange", {
      method: "POST",
      token: telegramGuest.token,
      body: { handoffCode: completed.handoffCode },
    });
    expect(wrongActor.response.status).toBe(409);
    expect(ErrorEnvelopeSchema.parse(wrongActor.body).error.code).toBe("AUTH_REQUIRES_GUEST");
  });

  it("uses the sampled request time at the exact handoff-expiry boundary", async () => {
    const app = createApp({ oidcProvider: fakeProvider() });
    const guest = await issueGuest("web");
    const completed = await completeFlow(app, guest);
    const flow = await testEnv.DB.prepare("SELECT handoff_expires_at FROM auth_flows").first<{
      handoff_expires_at: number;
    }>();
    if (!flow) throw new Error("Expected a completed OIDC flow.");

    await expect(
      exchangeOidcHandoff(
        testEnv,
        {
          sessionId: guest.sessionId,
          playerId: null,
          kind: "guest",
          channel: "web",
        },
        completed.handoffCode,
        flow.handoff_expires_at,
      ),
    ).rejects.toMatchObject({ status: 401, code: "HANDOFF_INVALID" });
    expect(
      (
        await testEnv.DB.prepare("SELECT handoff_consumed_at FROM auth_flows").first<{
          handoff_consumed_at: number | null;
        }>()
      )?.handoff_consumed_at,
    ).toBeNull();
  });

  it("rolls back handoff consumption, attempt linking, and revocation after an insert failure", async () => {
    const app = createApp({ oidcProvider: fakeProvider() });
    const guest = await issueGuest("web");
    await seedAttempt({ sessionId: guest.sessionId, attemptId: crypto.randomUUID() });
    const completed = await completeFlow(app, guest);
    await testEnv.DB.prepare(
      `CREATE TRIGGER test_fail_handoff_session_insert
       BEFORE INSERT ON sessions
       WHEN NEW.kind = 'telegram' AND NEW.rotated_from_session_id = '${guest.sessionId}'
       BEGIN
         SELECT RAISE(ABORT, 'secret injected handoff insert failure');
       END`,
    ).run();

    const failed = await appJson(app, "/v1/auth/session/exchange", {
      method: "POST",
      token: guest.token,
      body: { handoffCode: completed.handoffCode },
    });
    expect(failed.response.status).toBe(500);
    expect(ErrorEnvelopeSchema.parse(failed.body).error.code).toBe("INTERNAL_ERROR");
    expect(JSON.stringify(failed.body)).not.toContain("secret injected");
    const afterFailure = await testEnv.DB.prepare(
      `SELECT f.handoff_consumed_at, f.handoff_session_id,
              s.revoked_at, a.player_id
         FROM auth_flows f
         JOIN sessions s ON s.id = f.guest_session_id
         JOIN attempts a ON a.session_id = s.id`,
    ).first<{
      handoff_consumed_at: number | null;
      handoff_session_id: string | null;
      revoked_at: number | null;
      player_id: string | null;
    }>();
    expect(afterFailure).toEqual({
      handoff_consumed_at: null,
      handoff_session_id: null,
      revoked_at: null,
      player_id: null,
    });

    await testEnv.DB.prepare("DROP TRIGGER test_fail_handoff_session_insert").run();
    const retry = await appJson(app, "/v1/auth/session/exchange", {
      method: "POST",
      token: guest.token,
      body: { handoffCode: completed.handoffCode },
    });
    expect(retry.response.status).toBe(200);
    TelegramSessionIssuedSchema.parse(retry.body);
  });

  it("uses the in-batch guard when a replacement insert is silently ignored", async () => {
    const app = createApp({ oidcProvider: fakeProvider() });
    const guest = await issueGuest("web");
    await seedAttempt({ sessionId: guest.sessionId, attemptId: crypto.randomUUID() });
    const completed = await completeFlow(app, guest);
    await testEnv.DB.prepare(
      `CREATE TRIGGER test_ignore_handoff_session_insert
       BEFORE INSERT ON sessions
       WHEN NEW.kind = 'telegram' AND NEW.rotated_from_session_id = '${guest.sessionId}'
       BEGIN
         SELECT RAISE(IGNORE);
       END`,
    ).run();

    const failed = await appJson(app, "/v1/auth/session/exchange", {
      method: "POST",
      token: guest.token,
      body: { handoffCode: completed.handoffCode },
    });
    expect(failed.response.status).toBe(500);
    expect(
      await testEnv.DB.prepare(
        `SELECT f.handoff_consumed_at, f.handoff_session_id,
                s.revoked_at, a.player_id
           FROM auth_flows f
           JOIN sessions s ON s.id = f.guest_session_id
           JOIN attempts a ON a.session_id = s.id`,
      ).first(),
    ).toEqual({
      handoff_consumed_at: null,
      handoff_session_id: null,
      revoked_at: null,
      player_id: null,
    });

    await testEnv.DB.prepare("DROP TRIGGER test_ignore_handoff_session_insert").run();
    const retry = await appJson(app, "/v1/auth/session/exchange", {
      method: "POST",
      token: guest.token,
      body: { handoffCode: completed.handoffCode },
    });
    expect(retry.response.status).toBe(200);
  });

  it("uses an independent guard when guest revocation is silently ignored", async () => {
    const app = createApp({ oidcProvider: fakeProvider() });
    const guest = await issueGuest("web");
    await seedAttempt({ sessionId: guest.sessionId, attemptId: crypto.randomUUID() });
    const completed = await completeFlow(app, guest);
    await testEnv.DB.prepare(
      `CREATE TRIGGER test_ignore_handoff_revoke
       BEFORE UPDATE OF revoked_at ON sessions
       WHEN OLD.id = '${guest.sessionId}' AND NEW.revoked_at IS NOT NULL
       BEGIN
         SELECT RAISE(IGNORE);
       END`,
    ).run();

    const failed = await appJson(app, "/v1/auth/session/exchange", {
      method: "POST",
      token: guest.token,
      body: { handoffCode: completed.handoffCode },
    });
    expect(failed.response.status).toBe(500);
    expect(
      await testEnv.DB.prepare(
        `SELECT f.handoff_consumed_at, f.handoff_session_id,
                s.revoked_at, a.player_id
           FROM auth_flows f
           JOIN sessions s ON s.id = f.guest_session_id
           JOIN attempts a ON a.session_id = s.id`,
      ).first(),
    ).toEqual({
      handoff_consumed_at: null,
      handoff_session_id: null,
      revoked_at: null,
      player_id: null,
    });
    expect(
      (
        await testEnv.DB.prepare(
          "SELECT count(*) AS count FROM sessions WHERE rotated_from_session_id = ?",
        )
          .bind(guest.sessionId)
          .first<{ count: number }>()
      )?.count,
    ).toBe(0);

    await testEnv.DB.prepare("DROP TRIGGER test_ignore_handoff_revoke").run();
    const retry = await appJson(app, "/v1/auth/session/exchange", {
      method: "POST",
      token: guest.token,
      body: { handoffCode: completed.handoffCode },
    });
    expect(retry.response.status).toBe(200);
  });

  it("rejects a mismatched non-null attempt owner without consuming the handoff", async () => {
    const app = createApp({ oidcProvider: fakeProvider() });
    const guest = await issueGuest("web");
    await seedAttempt({ sessionId: guest.sessionId, attemptId: crypto.randomUUID() });
    const completed = await completeFlow(app, guest);
    const now = Math.floor(Date.now() / 1000);
    await testEnv.DB.prepare(
      `INSERT INTO players
        (id, telegram_user_id, display_name, username, avatar_url, created_at, updated_at)
       VALUES ('wrong-attempt-owner', '555', 'Wrong', NULL, NULL, ?, ?)`,
    )
      .bind(now, now)
      .run();
    await testEnv.DB.prepare("UPDATE attempts SET player_id = 'wrong-attempt-owner'").run();

    const failed = await appJson(app, "/v1/auth/session/exchange", {
      method: "POST",
      token: guest.token,
      body: { handoffCode: completed.handoffCode },
    });
    expect(failed.response.status).toBe(500);
    expect(
      (
        await testEnv.DB.prepare("SELECT handoff_consumed_at FROM auth_flows").first<{
          handoff_consumed_at: number | null;
        }>()
      )?.handoff_consumed_at,
    ).toBeNull();
    expect(
      (
        await testEnv.DB.prepare("SELECT revoked_at FROM sessions WHERE id = ?")
          .bind(guest.sessionId)
          .first<{ revoked_at: number | null }>()
      )?.revoked_at,
    ).toBeNull();

    await testEnv.DB.prepare("UPDATE attempts SET player_id = NULL").run();
    const retry = await appJson(app, "/v1/auth/session/exchange", {
      method: "POST",
      token: guest.token,
      body: { handoffCode: completed.handoffCode },
    });
    expect(retry.response.status).toBe(200);
  });

  it("allows exactly one concurrent handoff exchange", async () => {
    const app = createApp({ oidcProvider: fakeProvider() });
    const guest = await issueGuest("web");
    const completed = await completeFlow(app, guest);
    const requests = [0, 1].map(
      async () =>
        await appJson(app, "/v1/auth/session/exchange", {
          method: "POST",
          token: guest.token,
          body: { handoffCode: completed.handoffCode },
        }),
    );
    const results = await Promise.all(requests);
    expect(results.map(({ response }) => response.status).sort()).toEqual([200, 401]);
    const rows = await testEnv.DB.prepare(
      "SELECT id FROM sessions WHERE rotated_from_session_id = ?",
    )
      .bind(guest.sessionId)
      .all();
    expect(rows.results).toHaveLength(1);
  });

  it("serializes handoff exchange against logout without creating two successors", async () => {
    const app = createApp({ oidcProvider: fakeProvider() });
    const guest = await issueGuest("web");
    const completed = await completeFlow(app, guest);
    const [exchange, logout] = await Promise.all([
      appJson(app, "/v1/auth/session/exchange", {
        method: "POST",
        token: guest.token,
        body: { handoffCode: completed.handoffCode },
      }),
      appJson(app, "/v1/auth/logout", { method: "POST", token: guest.token }),
    ]);

    expect([exchange.response.status, logout.response.status].sort()).toEqual([200, 401]);
    const successors = await testEnv.DB.prepare(
      "SELECT id, kind FROM sessions WHERE rotated_from_session_id = ?",
    )
      .bind(guest.sessionId)
      .all<{ id: string; kind: string }>();
    expect(successors.results).toHaveLength(1);
    const flow = await testEnv.DB.prepare("SELECT handoff_consumed_at FROM auth_flows").first<{
      handoff_consumed_at: number | null;
    }>();
    if (exchange.response.status === 200) {
      expect(successors.results[0]?.kind).toBe("telegram");
      expect(flow?.handoff_consumed_at).not.toBeNull();
    } else {
      expect(successors.results[0]?.kind).toBe("guest");
      expect(flow?.handoff_consumed_at).toBeNull();
    }
  });

  it.each([
    {
      name: "subject already belongs to another Telegram player",
      existing: {
        telegramUserId: "111111111",
        issuer: "https://oauth.telegram.org",
        subject: "telegram-subject-987654321",
        audience: "123456789",
      },
    },
    {
      name: "Telegram player already has a different subject",
      existing: {
        telegramUserId: "987654321",
        issuer: "https://oauth.telegram.org",
        subject: "different-subject",
        audience: "123456789",
      },
    },
    {
      name: "Telegram player already has a different audience",
      existing: {
        telegramUserId: "987654321",
        issuer: "https://oauth.telegram.org",
        subject: "telegram-subject-987654321",
        audience: "other-client",
      },
    },
  ])("rejects when $name without changing the stored mapping", async ({ existing }) => {
    await seedPlayerMapping(existing);
    const before = await readAllPlayerMappings();
    const response = await completeCallbackForIdentity(verifiedOidcIdentity);
    await expectApiError(response, 409, "TELEGRAM_IDENTITY_CONFLICT");
    expectCallbackHeaders(response);
    expect(await readAllPlayerMappings()).toEqual(before);
  });

  it("links an unclaimed Mini App player once and accepts only the exact tuple later", async () => {
    const now = Math.floor(Date.now() / 1000);
    await testEnv.DB.prepare(
      `INSERT INTO players
        (id, telegram_user_id, oidc_issuer, oidc_subject, oidc_audience,
         display_name, username, avatar_url, created_at, updated_at)
       VALUES (?, '987654321', NULL, NULL, NULL, 'Ada', NULL, NULL, ?, ?)`,
    )
      .bind(crypto.randomUUID(), now, now)
      .run();
    expect((await completeCallbackForIdentity(verifiedOidcIdentity)).status).toBe(302);
    expect((await completeCallbackForIdentity(verifiedOidcIdentity)).status).toBe(302);
    expect(await readAllPlayerMappings()).toEqual([
      {
        telegram_user_id: "987654321",
        oidc_issuer: "https://oauth.telegram.org",
        oidc_subject: "telegram-subject-987654321",
        oidc_audience: "123456789",
        display_name: "Ada Lovelace",
        username: "ada",
        avatar_url: "https://cdn.example/avatar.jpg",
      },
    ]);
  });

  it("rolls back identity and profile changes when auth-flow completion is ignored", async () => {
    await seedPlayerMapping({
      telegramUserId: "987654321",
      issuer: "https://oauth.telegram.org",
      subject: "telegram-subject-987654321",
      audience: "123456789",
    });
    const before = await readAllPlayerMappings();
    const provider = fakeProvider();
    const app = createApp({ oidcProvider: provider });
    const guest = await issueGuest("web");
    const { state } = await startFlow(app, guest);
    await testEnv.DB.prepare(
      `CREATE TRIGGER test_ignore_auth_flow_completion
       BEFORE UPDATE OF handoff_hash ON auth_flows
       BEGIN
         SELECT RAISE(IGNORE);
       END`,
    ).run();

    const response = await appRequest(app, callbackPath(state));
    expect(response.status).toBe(500);
    expectCallbackHeaders(response);
    expect(await readAllPlayerMappings()).toEqual(before);
    expect(
      await testEnv.DB.prepare(
        "SELECT callback_claimed_at, player_id, handoff_hash FROM auth_flows",
      ).first(),
    ).toMatchObject({
      callback_claimed_at: expect.any(Number),
      player_id: null,
      handoff_hash: null,
    });
    expect(provider.exchangeAndVerify).toHaveBeenCalledTimes(1);
  });

  it("does not complete a flow when an existing player update is silently ignored", async () => {
    await seedPlayerMapping({
      telegramUserId: "987654321",
      issuer: "https://oauth.telegram.org",
      subject: "telegram-subject-987654321",
      audience: "123456789",
    });
    const before = await readAllPlayerMappings();
    const provider = fakeProvider();
    const app = createApp({ oidcProvider: provider });
    const guest = await issueGuest("web");
    const { state } = await startFlow(app, guest);
    await testEnv.DB.prepare(
      `CREATE TRIGGER test_ignore_oidc_player_update
       BEFORE UPDATE OF display_name ON players
       WHEN OLD.telegram_user_id = '987654321'
       BEGIN
         SELECT RAISE(IGNORE);
       END`,
    ).run();

    const response = await appRequest(app, callbackPath(state));
    expect(response.status).toBe(500);
    expectCallbackHeaders(response);
    expect(await readAllPlayerMappings()).toEqual(before);
    expect(
      await testEnv.DB.prepare(
        "SELECT callback_claimed_at, player_id, handoff_hash FROM auth_flows",
      ).first(),
    ).toMatchObject({
      callback_claimed_at: expect.any(Number),
      player_id: null,
      handoff_hash: null,
    });
    expect(provider.exchangeAndVerify).toHaveBeenCalledTimes(1);
  });

  it("fails unsafe return and handoff TTL configuration before irreversible state", async () => {
    const provider = fakeProvider();
    const app = createApp({ oidcProvider: provider });
    const webGuest = await issueGuest("web");
    const invalidReturn = await appJson(
      app,
      "/v1/auth/telegram/oidc/start",
      { method: "POST", token: webGuest.token, body: { channel: "web" } },
      overrideEnv({ WEB_AUTH_RETURN_URL: "https://evil.test/callback" }),
    );
    expect(invalidReturn.response.status).toBe(500);
    expect(await authFlowCount()).toBe(0);

    const androidGuest = await issueGuest("android");
    const invalidAndroid = await appJson(
      app,
      "/v1/auth/telegram/oidc/start",
      { method: "POST", token: androidGuest.token, body: { channel: "android" } },
      overrideEnv({ ANDROID_AUTH_RETURN_URL: "other-app://auth" }),
    );
    expect(invalidAndroid.response.status).toBe(500);
    expect(await authFlowCount()).toBe(0);

    const guest = await issueGuest("web");
    const { state } = await startFlow(app, guest);
    for (const HANDOFF_TTL_SECONDS of ["0", "-1", "1.5", "NaN", "8640000000000"]) {
      const failed = await appRequest(
        app,
        callbackPath(state),
        {},
        overrideEnv({ HANDOFF_TTL_SECONDS }),
      );
      expect(failed.status).toBe(500);
      expectCallbackHeaders(failed);
      expect(
        (
          await testEnv.DB.prepare(
            "SELECT callback_claimed_at FROM auth_flows WHERE guest_session_id = ?",
          )
            .bind(guest.sessionId)
            .first<{ callback_claimed_at: number | null }>()
        )?.callback_claimed_at,
      ).toBeNull();
    }
    const invalidCallbackReturn = await appRequest(
      app,
      callbackPath(state, "error=access_denied"),
      {},
      overrideEnv({ WEB_AUTH_RETURN_URL: "https://evil.test/callback" }),
    );
    expect(invalidCallbackReturn.status).toBe(500);
    expectCallbackHeaders(invalidCallbackReturn);
    expect(
      (
        await testEnv.DB.prepare(
          "SELECT callback_claimed_at FROM auth_flows WHERE guest_session_id = ?",
        )
          .bind(guest.sessionId)
          .first<{ callback_claimed_at: number | null }>()
      )?.callback_claimed_at,
    ).toBeNull();
    expect(provider.exchangeAndVerify).not.toHaveBeenCalled();
    expect((await appRequest(app, callbackPath(state))).status).toBe(302);
  });
});
