import { ErrorEnvelopeSchema, OidcStartResponseSchema } from "@a-move-ago/api-contract";
import { beforeEach, describe, expect, it } from "vitest";
import { hashOpaqueToken } from "../src/crypto/opaque-token";
import { pkceChallenge } from "../src/crypto/pkce";
import type { Env, RateLimitBinding, SessionActor } from "../src/env";
import { startOidcFlow } from "../src/services/oidc-service";
import { authenticatedJson, issueGuest, resetDatabase, testEnv } from "./helpers/http";

function overrideEnv(bindings: Partial<Env>): Env {
  const requestEnv = Object.create(testEnv) as Env;
  for (const [key, value] of Object.entries(bindings)) {
    Object.defineProperty(requestEnv, key, { configurable: true, enumerable: true, value });
  }
  return requestEnv;
}

function authEnv(limiter: RateLimitBinding): Env {
  return overrideEnv({ AUTH_RATE_LIMITER: limiter });
}

async function flowCount(): Promise<number> {
  return (
    (
      await testEnv.DB.prepare("SELECT count(*) AS count FROM auth_flows").first<{
        count: number;
      }>()
    )?.count ?? -1
  );
}

describe("Telegram OIDC start", () => {
  beforeEach(resetDatabase);

  it("matches the RFC 7636 S256 vector", async () => {
    await expect(pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).resolves.toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });

  it("stores only hashed state and returns the exact fixed Telegram authorization URL", async () => {
    const guest = await issueGuest("web");
    const before = Math.floor(Date.now() / 1000);
    const response = await authenticatedJson("/v1/auth/telegram/oidc/start", guest.token, {
      method: "POST",
      body: { channel: "web" },
    });
    const after = Math.floor(Date.now() / 1000);

    expect(response.response.status).toBe(200);
    expect(response.response.headers.get("cache-control")).toBe("no-store");
    const body = OidcStartResponseSchema.parse(response.body);
    const url = new URL(body.authorizationUrl);
    expect(`${url.origin}${url.pathname}`).toBe("https://oauth.telegram.org/auth");
    expect([...url.searchParams.keys()].sort()).toEqual(
      [
        "client_id",
        "code_challenge",
        "code_challenge_method",
        "nonce",
        "redirect_uri",
        "response_type",
        "scope",
        "state",
      ].sort(),
    );
    expect(url.searchParams.get("client_id")).toBe(testEnv.TELEGRAM_OIDC_CLIENT_ID);
    expect(url.searchParams.get("redirect_uri")).toBe(testEnv.TELEGRAM_OIDC_CALLBACK_URL);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("scope")).toBe("openid profile");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("state")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url.searchParams.get("nonce")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const flow = await testEnv.DB.prepare(
      `SELECT id, state_hash, guest_session_id, channel, nonce, pkce_verifier,
              expires_at, callback_claimed_at, player_id, handoff_hash,
              handoff_expires_at, handoff_consumed_at, created_at
         FROM auth_flows`,
    ).first<Record<string, string | number | null>>();
    const rawState = url.searchParams.get("state");
    if (!rawState) throw new Error("Expected state in authorization URL.");
    expect(flow).toMatchObject({
      guest_session_id: guest.sessionId,
      channel: "web",
      nonce: url.searchParams.get("nonce"),
      callback_claimed_at: null,
      player_id: null,
      handoff_hash: null,
      handoff_expires_at: null,
      handoff_consumed_at: null,
    });
    expect(flow?.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(flow?.state_hash).toBe(
      await hashOpaqueToken(rawState, testEnv.SESSION_PEPPER, "oidc-state"),
    );
    expect(flow?.state_hash).not.toBe(rawState);
    expect(JSON.stringify(flow)).not.toContain(rawState);
    expect(flow?.pkce_verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url.searchParams.get("code_challenge")).toBe(
      await pkceChallenge(String(flow?.pkce_verifier)),
    );
    expect(flow?.created_at).toBeGreaterThanOrEqual(before);
    expect(flow?.created_at).toBeLessThanOrEqual(after);
    expect(flow?.expires_at).toBe(Number(flow?.created_at) + Number(testEnv.OIDC_FLOW_TTL_SECONDS));
    expect(body.expiresAt).toBe(new Date(Number(flow?.expires_at) * 1000).toISOString());
  });

  it("rejects channel substitution, Telegram guests, and arbitrary return URLs", async () => {
    const android = await issueGuest("android");
    const mismatch = await authenticatedJson("/v1/auth/telegram/oidc/start", android.token, {
      method: "POST",
      body: { channel: "web" },
    });
    const injected = await authenticatedJson("/v1/auth/telegram/oidc/start", android.token, {
      method: "POST",
      body: { channel: "android", returnUrl: "https://evil.test" },
    });
    const telegram = await issueGuest("telegram");
    const telegramStart = await authenticatedJson("/v1/auth/telegram/oidc/start", telegram.token, {
      method: "POST",
      body: { channel: "web" },
    });

    expect(mismatch.response.status).toBe(409);
    expect(ErrorEnvelopeSchema.parse(mismatch.body).error.code).toBe("AUTH_CHANNEL_MISMATCH");
    expect(injected.response.status).toBe(400);
    expect(ErrorEnvelopeSchema.parse(injected.body).error.code).toBe("INVALID_REQUEST");
    expect(telegramStart.response.status).toBe(409);
    expect(ErrorEnvelopeSchema.parse(telegramStart.body).error.code).toBe("AUTH_CHANNEL_MISMATCH");
    expect(await flowCount()).toBe(0);
  });

  it("limits by internal session id before parsing and does not persist denied requests", async () => {
    const guest = await issueGuest("web");
    const keys: string[] = [];
    const response = await authenticatedJson(
      "/v1/auth/telegram/oidc/start",
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
    expect(await flowCount()).toBe(0);
  });

  it("strictly rejects malformed request bodies after consuming the auth limiter", async () => {
    const guest = await issueGuest("web");
    for (const body of ["{", {}, { channel: "telegram" }, { channel: "web", extra: true }]) {
      const keys: string[] = [];
      const response = await authenticatedJson(
        "/v1/auth/telegram/oidc/start",
        guest.token,
        { method: "POST", body },
        authEnv({
          limit: async ({ key }) => {
            keys.push(key);
            return { success: true };
          },
        }),
      );
      expect(response.response.status).toBe(400);
      expect(ErrorEnvelopeSchema.parse(response.body).error.code).toBe("INVALID_REQUEST");
      expect(keys).toEqual([`auth:${guest.sessionId}`]);
    }
    expect(await flowCount()).toBe(0);
  });

  it("fails closed on invalid TTL and provider configuration before inserting a flow", async () => {
    const invalidBindings: Partial<Env>[] = [
      { OIDC_FLOW_TTL_SECONDS: "0" },
      { OIDC_FLOW_TTL_SECONDS: "-1" },
      { OIDC_FLOW_TTL_SECONDS: "1.5" },
      { OIDC_FLOW_TTL_SECONDS: "NaN" },
      { OIDC_FLOW_TTL_SECONDS: "8640000000000" },
      { TELEGRAM_OIDC_CLIENT_ID: "" },
      { TELEGRAM_OIDC_CALLBACK_URL: "javascript:alert(1)" },
      { TELEGRAM_OIDC_CALLBACK_URL: "http://api.test/v1/auth/telegram/oidc/callback" },
      { TELEGRAM_OIDC_CALLBACK_URL: "https://api.test" },
      { TELEGRAM_OIDC_CALLBACK_URL: "https://user:pass@api.test/callback" },
    ];
    for (const bindings of invalidBindings) {
      await resetDatabase();
      const guest = await issueGuest("web");
      const response = await authenticatedJson(
        "/v1/auth/telegram/oidc/start",
        guest.token,
        { method: "POST", body: { channel: "web" } },
        overrideEnv(bindings),
      );
      expect(response.response.status).toBe(500);
      expect(ErrorEnvelopeSchema.parse(response.body).error.code).toBe("INTERNAL_ERROR");
      expect(JSON.stringify(response.body)).not.toContain("OIDC_FLOW_TTL_SECONDS");
      expect(await flowCount()).toBe(0);
    }
  });

  it("revalidates the authoritative guest expiry against the database clock", async () => {
    const guest = await issueGuest("web");
    const databaseNow = Math.floor(Date.now() / 1000);
    await testEnv.DB.prepare("UPDATE sessions SET expires_at = ? WHERE id = ?")
      .bind(databaseNow - 1, guest.sessionId)
      .run();
    const actor: SessionActor = {
      sessionId: guest.sessionId,
      playerId: null,
      kind: "guest",
      channel: "web",
    };

    await expect(startOidcFlow(testEnv, actor, "web", databaseNow - 60)).rejects.toMatchObject({
      status: 401,
      code: "INVALID_SESSION",
    });
    expect(await flowCount()).toBe(0);
  });

  it("returns a sanitized error and no authorization URL when D1 insertion fails", async () => {
    const guest = await issueGuest("web");
    await testEnv.DB.prepare(
      `CREATE TRIGGER test_fail_auth_flow_insert
       BEFORE INSERT ON auth_flows
       BEGIN
         SELECT RAISE(ABORT, 'secret auth flow insert failure');
       END`,
    ).run();
    const response = await authenticatedJson("/v1/auth/telegram/oidc/start", guest.token, {
      method: "POST",
      body: { channel: "web" },
    });
    await testEnv.DB.prepare("DROP TRIGGER test_fail_auth_flow_insert").run();

    expect(response.response.status).toBe(500);
    expect(ErrorEnvelopeSchema.parse(response.body).error.code).toBe("INTERNAL_ERROR");
    expect(JSON.stringify(response.body)).not.toContain("secret auth flow");
    expect(JSON.stringify(response.body)).not.toContain("authorizationUrl");
    expect(await flowCount()).toBe(0);
  });

  it("creates independent one-time state, nonce, and verifier values for repeated starts", async () => {
    const guest = await issueGuest("android");
    const responses = await Promise.all([
      authenticatedJson("/v1/auth/telegram/oidc/start", guest.token, {
        method: "POST",
        body: { channel: "android" },
      }),
      authenticatedJson("/v1/auth/telegram/oidc/start", guest.token, {
        method: "POST",
        body: { channel: "android" },
      }),
    ]);
    expect(responses.map(({ response }) => response.status)).toEqual([200, 200]);
    const urls = responses.map(
      ({ body }) => new URL(OidcStartResponseSchema.parse(body).authorizationUrl),
    );
    expect(new Set(urls.map((url) => url.searchParams.get("state"))).size).toBe(2);
    expect(new Set(urls.map((url) => url.searchParams.get("nonce"))).size).toBe(2);
    const flows = await testEnv.DB.prepare(
      "SELECT state_hash, nonce, pkce_verifier FROM auth_flows",
    ).all<{ state_hash: string; nonce: string; pkce_verifier: string }>();
    expect(flows.results).toHaveLength(2);
    expect(new Set(flows.results.map((flow) => flow.state_hash)).size).toBe(2);
    expect(new Set(flows.results.map((flow) => flow.nonce)).size).toBe(2);
    expect(new Set(flows.results.map((flow) => flow.pkce_verifier)).size).toBe(2);
  });
});
