import assert from "node:assert/strict";
import test from "node:test";
import { checkOidcCallbackProduction } from "../scripts/check-oidc-callback-production.mjs";

const apiOrigin = "https://api.example.test";
const webOrigin = "https://chess.kosarevsky.dev";
const token = "t".repeat(43);
const state = "s".repeat(43);
const nonce = "n".repeat(43);
const requestId = "f9b759fd-b52b-4d9f-8694-f693b3ff4942";
const sensitive = "PRIVATE_UPSTREAM_DETAIL";

function authorizationUrl(overrides = {}) {
  const url = new URL("https://oauth.telegram.org/auth");
  url.search = new URLSearchParams({
    client_id: "123456789",
    redirect_uri: `${apiOrigin}/v1/auth/telegram/oidc/callback`,
    response_type: "code",
    code_challenge_method: "S256",
    state,
    nonce,
    ...overrides,
  }).toString();
  return url.href;
}

function harness(override) {
  const requests = [];
  let callbacks = 0;
  const fetch = async (url, options) => {
    const path = new URL(url).pathname;
    const recorded = { url, path, ...options };
    requests.push(recorded);
    const custom = await override?.(recorded);
    if (custom) return custom;
    if (path === "/v1/sessions/guest") {
      return Response.json({ kind: "guest", token }, { status: 201 });
    }
    if (path === "/v1/auth/telegram/oidc/start") {
      return Response.json({ authorizationUrl: authorizationUrl() });
    }
    if (path === "/v1/auth/telegram/oidc/callback") {
      if (callbacks++ === 0) {
        return new Response(null, {
          status: 302,
          headers: {
            location: `${webOrigin}/?authError=login_failed`,
            "cache-control": "no-store",
            "referrer-policy": "no-referrer",
            "x-request-id": requestId,
          },
        });
      }
      return Response.json({ error: { code: "OIDC_STATE_INVALID" } }, { status: 400 });
    }
    if (path === "/v1/me") return Response.json({ kind: "guest", profile: null });
    throw new Error(sensitive);
  };
  return {
    requests,
    run: (origin = apiOrigin) =>
      checkOidcCallbackProduction({ apiOrigin: origin }, { fetch, timeoutMs: 500 }),
  };
}

function assertSafe(result) {
  const output = JSON.stringify(result);
  for (const secret of [token, state, nonce, sensitive, "?code=", "?state="]) {
    assert.equal(output.includes(secret), false);
  }
}

test("checks invalid-code recovery, preserved guest and rejected replay", async () => {
  const check = harness();
  const result = await check.run();
  assert.deepEqual(result, {
    ok: true,
    returnOrigin: webOrigin,
    guestPreserved: true,
    stateReplayRejected: true,
    requestId,
  });
  assertSafe(result);
  assert.deepEqual(
    check.requests.map(({ method, path }) => `${method} ${path}`),
    [
      "POST /v1/sessions/guest",
      "POST /v1/auth/telegram/oidc/start",
      "GET /v1/auth/telegram/oidc/callback",
      "GET /v1/me",
      "GET /v1/auth/telegram/oidc/callback",
    ],
  );
  for (const request of check.requests) {
    assert.equal(new URL(request.url).origin, apiOrigin);
    assert.ok(request.signal instanceof AbortSignal);
    assert.equal(request.cache, "no-store");
    if (request.path.endsWith("/callback")) {
      assert.equal(request.redirect, "manual");
      assert.equal(request.headers.authorization, undefined);
      assert.equal(request.headers.origin, undefined);
      assert.equal(new URL(request.url).searchParams.get("state"), state);
      assert.match(new URL(request.url).searchParams.get("code"), /^invalid[A-Za-z0-9_-]{20}$/);
    } else {
      assert.equal(request.redirect, "error");
      assert.equal(request.headers.origin, webOrigin);
      assert.equal(
        request.headers.authorization,
        request.path.endsWith("/guest") ? undefined : `Bearer ${token}`,
      );
    }
  }
  assert.equal(check.requests[2].url, check.requests[4].url);
  assert.deepEqual(JSON.parse(check.requests[0].body), { channel: "web" });
  assert.deepEqual(JSON.parse(check.requests[1].body), { channel: "web" });
});

test("rejects untrusted authorization targets before callback", async (t) => {
  const urls = [
    `https://evil.test/${sensitive}`,
    authorizationUrl({ redirect_uri: `https://evil.test/${sensitive}` }),
    authorizationUrl({ state: "short" }),
    authorizationUrl({ nonce: "short" }),
    authorizationUrl({ code_challenge_method: "plain" }),
  ];
  for (const url of urls) {
    await t.test("invalid start URL", async () => {
      const check = harness((request) =>
        request.path.endsWith("/start") ? Response.json({ authorizationUrl: url }) : undefined,
      );
      const result = await check.run();
      assert.equal(result.code, "AUTHORIZATION_URL_INVALID");
      assert.equal(check.requests.length, 2);
      assertSafe(result);
    });
  }
});

test("rejects unsafe return URLs, missing privacy headers and invalid request IDs", async (t) => {
  for (const headers of [
    { location: `https://evil.test/${sensitive}` },
    { location: `${webOrigin}/?handoff=${sensitive}` },
    { "cache-control": "public" },
    { "referrer-policy": "unsafe-url" },
    { "x-request-id": sensitive },
  ]) {
    await t.test("invalid callback response", async () => {
      const result = await harness((request) =>
        request.path.endsWith("/callback")
          ? new Response(null, {
              status: 302,
              headers: {
                location: `${webOrigin}/?authError=login_failed`,
                "cache-control": "no-store",
                "referrer-policy": "no-referrer",
                "x-request-id": requestId,
                ...headers,
              },
            })
          : undefined,
      ).run();
      assert.equal(result.ok, false);
      assert.equal(result.stage, "callback");
      assertSafe(result);
    });
  }
});

test("does not accept a linked or invalidated guest after failed login", async () => {
  const result = await harness((request) =>
    request.path === "/v1/me"
      ? Response.json({ kind: "player", profile: { name: sensitive } })
      : undefined,
  ).run();
  assert.equal(result.code, "GUEST_NOT_PRESERVED");
  assertSafe(result);
});

test("does not accept state reuse", async () => {
  let callbacks = 0;
  const result = await harness((request) => {
    if (request.path.endsWith("/callback") && callbacks++ === 1) {
      return Response.json({ error: { code: sensitive } }, { status: 400 });
    }
  }).run();
  assert.equal(result.code, "STATE_REPLAY_NOT_REJECTED");
  assertSafe(result);
});

test("sanitizes transport and response failures", async (t) => {
  for (const [response, expected] of [
    [() => Promise.reject(new Error(sensitive)), "TRANSPORT_FAILED"],
    [() => new Response(sensitive, { status: 503 }), "GUEST_HTTP_FAILED"],
    [() => new Response(sensitive, { status: 201 }), "RESPONSE_CONTENT_TYPE"],
    [
      () =>
        new Response(sensitive, { status: 201, headers: { "content-type": "application/json" } }),
      "RESPONSE_INVALID_JSON",
    ],
    [() => Response.json({ data: "x".repeat(65_536) }, { status: 201 }), "RESPONSE_TOO_LARGE"],
  ]) {
    await t.test(expected, async () => {
      const result = await harness(response).run();
      assert.equal(result.code, expected);
      assertSafe(result);
    });
  }
});

test("rejects noncanonical API origins before creating a guest", async () => {
  for (const origin of ["", "http://api.example.test", `${apiOrigin}/`, `${apiOrigin}/path`]) {
    const check = harness();
    const result = await check.run(origin);
    assert.equal(result.code, "INVALID_API_ORIGIN");
    assert.equal(check.requests.length, 0);
  }
});
