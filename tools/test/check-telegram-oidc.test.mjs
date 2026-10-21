import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { checkTelegramOidc } from "../scripts/check-telegram-oidc.mjs";

const issuer = "https://oauth.telegram.org";
const sensitive = "PRIVATE_DATA_MUST_NOT_LEAK";
const credentials = {
  clientId: "123456789",
  clientSecret: sensitive,
  apiOrigin: "https://api.example.test",
};
const discovery = {
  issuer,
  authorization_endpoint: `${issuer}/auth`,
  token_endpoint: `${issuer}/token`,
  jwks_uri: `${issuer}/.well-known/jwks.json`,
  id_token_signing_alg_values_supported: ["RS256"],
  token_endpoint_auth_methods_supported: ["client_secret_basic"],
};
const key = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({ format: "jwk" });
const keys = [{ ...key, kid: "test-key", use: "sig", alg: "RS256" }];

function harness(override) {
  const requests = [];
  const fetch = async (url, options) => {
    requests.push({ url, options });
    const custom = await override?.(url, options);
    if (custom) return custom;
    if (url.endsWith("openid-configuration")) return Response.json(discovery);
    if (url.endsWith("jwks.json")) return Response.json({ keys });
    if (url.endsWith("/token")) {
      return Response.json(
        { error: "invalid_grant", error_description: sensitive },
        { status: 400 },
      );
    }
    throw new Error(sensitive);
  };
  return { requests, run: (input) => checkTelegramOidc(input, { fetch, timeoutMs: 500 }) };
}

test("public preflight checks fixed discovery and usable RS256 keys without credentials", async () => {
  const check = harness();
  const result = await check.run();
  assert.equal(result.ok, true);
  assert.equal(result.credentialProbe, "not_requested");
  assert.equal(check.requests.length, 2);
  for (const { url, options } of check.requests) {
    assert.equal(new URL(url).origin, issuer);
    assert.equal(options.method, "GET");
    assert.equal(options.redirect, "error");
    assert.equal(options.cache, "no-store");
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(options.headers, undefined);
  }
});

test("credential probe uses only a synthetic invalid code and the provider's Basic request shape", async () => {
  const check = harness();
  const result = await check.run(credentials);
  assert.equal(result.ok, true);
  assert.equal(result.credentialProbe, "invalid_grant");
  assert.equal(check.requests.length, 3);
  const { url, options } = check.requests[2];
  assert.equal(url, `${issuer}/token`);
  assert.equal(options.method, "POST");
  assert.equal(
    options.headers.authorization,
    `Basic ${Buffer.from(`${credentials.clientId}:${credentials.clientSecret}`).toString("base64")}`,
  );
  const body = new URLSearchParams(options.body);
  assert.equal(body.get("client_id"), credentials.clientId);
  assert.equal(body.get("redirect_uri"), `${credentials.apiOrigin}/v1/auth/telegram/oidc/callback`);
  assert.equal(body.get("grant_type"), "authorization_code");
  assert.match(body.get("code"), /^invalid[A-Za-z0-9_-]{20}$/);
  assert.match(body.get("code_verifier"), /^[A-Za-z0-9_-]{43}$/);
  assert.equal(body.has("client_secret"), false);
  assert.equal(JSON.stringify(result).includes(sensitive), false);
  assert.equal(JSON.stringify(result).includes(body.get("code")), false);
});

test("never sends credentials to endpoints supplied by discovery", async () => {
  const check = harness((url) =>
    url.endsWith("openid-configuration")
      ? Response.json({ ...discovery, token_endpoint: `https://evil.test/${sensitive}` })
      : undefined,
  );
  const result = await check.run(credentials);
  assert.equal(result.code, "DISCOVERY_CONTRACT_CHANGED");
  assert.equal(check.requests.length, 1);
  assert.equal(JSON.stringify(result).includes(sensitive), false);
});

test("rejects missing, malformed and unusable keys", async (t) => {
  for (const payload of [null, { keys: [] }, { keys: [{ kty: "RSA", n: sensitive, e: "AQAB" }] }]) {
    await t.test(JSON.stringify(payload), async () => {
      const result = await harness((url) =>
        url.endsWith("jwks.json") ? Response.json(payload) : undefined,
      ).run();
      assert.equal(result.code, "JWKS_NO_USABLE_RS256_KEY");
      assert.equal(JSON.stringify(result).includes(sensitive), false);
    });
  }
});

test("distinguishes rejected clients and unexpected OAuth errors without logging descriptions", async (t) => {
  for (const [error, status, expected] of [
    ["invalid_client", 401, "OIDC_CLIENT_REJECTED"],
    ["invalid_request", 400, "TOKEN_PROBE_UNEXPECTED_RESPONSE"],
    [sensitive, 400, "TOKEN_PROBE_UNEXPECTED_RESPONSE"],
  ]) {
    await t.test(expected, async () => {
      const result = await harness((url) =>
        url.endsWith("/token")
          ? Response.json({ error, error_description: sensitive }, { status })
          : undefined,
      ).run(credentials);
      assert.equal(result.ok, false);
      assert.equal(result.stage, "token_probe");
      assert.equal(result.code, expected);
      assert.equal(result.oauthError, error === sensitive ? "unrecognized" : error);
      assert.equal(JSON.stringify(result).includes(sensitive), false);
    });
  }
});

test("never treats a token response to an invalid code as successful authentication", async () => {
  const result = await harness((url) =>
    url.endsWith("/token")
      ? Response.json({ access_token: sensitive, id_token: sensitive })
      : undefined,
  ).run(credentials);
  assert.equal(result.code, "TOKEN_PROBE_UNEXPECTED_RESPONSE");
  assert.equal(JSON.stringify(result).includes(sensitive), false);
});

test("sanitizes network, HTTP, content type, invalid JSON and oversized responses", async (t) => {
  const cases = [
    [() => Promise.reject(new Error(sensitive)), "TRANSPORT_FAILED"],
    [() => new Response(sensitive, { status: 502 }), "HTTP_FAILED"],
    [() => new Response(sensitive), "RESPONSE_CONTENT_TYPE"],
    [
      () => new Response(sensitive, { headers: { "content-type": "application/json" } }),
      "RESPONSE_INVALID_JSON",
    ],
    [() => Response.json({}, { headers: { "content-length": "65537" } }), "RESPONSE_TOO_LARGE"],
    [() => Response.json({ data: "x".repeat(65_536) }), "RESPONSE_TOO_LARGE"],
  ];
  for (const [response, expected] of cases) {
    await t.test(expected, async () => {
      const result = await harness(response).run(credentials);
      assert.equal(result.ok, false);
      assert.equal(result.code, expected);
      assert.equal(JSON.stringify(result).includes(sensitive), false);
    });
  }
});

test("rejects partial credentials and noncanonical callback origins before any request", async () => {
  for (const input of [
    { clientId: "123" },
    { ...credentials, clientSecret: "" },
    { ...credentials, apiOrigin: "http://api.example.test" },
    { ...credentials, apiOrigin: `https://${sensitive}@api.example.test` },
    { ...credentials, apiOrigin: "https://api.example.test/path" },
  ]) {
    const check = harness();
    const result = await check.run(input);
    assert.equal(result.code, "INVALID_CONFIGURATION");
    assert.equal(check.requests.length, 0);
    assert.equal(JSON.stringify(result).includes(sensitive), false);
  }
});
