import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type JWTVerifyGetKey,
  errors as joseErrors,
  SignJWT,
} from "jose";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { exchangeAndVerifyTelegramCode, OidcProviderError } from "../src/auth/telegram-oidc";

const issuer = "https://oauth.telegram.org";
const clientId = "123456789";
const nonce = "n".repeat(43);
const validInput = {
  code: "authorization-code",
  verifier: "verifier",
  expectedNonce: nonce,
  clientId,
  clientSecret: "test-client-secret",
  redirectUri: "https://api.test/v1/auth/telegram/oidc/callback",
};

let privateKey: CryptoKey;
let wrongAlgorithmKey: CryptoKey;
let jwks: JWTVerifyGetKey;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256", { extractable: true });
  privateKey = pair.privateKey;
  wrongAlgorithmKey = (await generateKeyPair("ES256")).privateKey;
  const publicJwk = await exportJWK(pair.publicKey);
  jwks = createLocalJWKSet({
    keys: [{ ...publicJwk, alg: "RS256", kid: "test-key", use: "sig" }],
  });
});

async function token(
  overrides: Record<string, unknown> = {},
  signing: { algorithm: "RS256" | "ES256"; key: CryptoKey } = {
    algorithm: "RS256",
    key: privateKey,
  },
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return await new SignJWT({
    iss: issuer,
    aud: clientId,
    sub: "telegram-subject-987654321",
    iat: now,
    exp: now + 300,
    nonce,
    id: 987654321,
    name: "Ada Lovelace",
    preferred_username: "ada",
    picture: "https://cdn.example/avatar.jpg",
    ...overrides,
  })
    .setProtectedHeader({
      alg: signing.algorithm,
      kid: signing.algorithm === "RS256" ? "test-key" : "wrong-alg-key",
    })
    .sign(signing.key);
}

function jsonTokens(idToken: string, init: ResponseInit = {}): Response {
  return Response.json(
    {
      access_token: "discarded-access-token",
      token_type: "Bearer",
      expires_in: 3600,
      id_token: idToken,
    },
    init,
  );
}

describe("Telegram OIDC provider", () => {
  it("uses the fixed token endpoint and client_secret_basic, then discards the access token", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
      expect(url).toBe("https://oauth.telegram.org/token");
      expect(init?.method).toBe("POST");
      expect(init?.redirect).toBe("error");
      expect(init?.headers).toMatchObject({
        authorization: `Basic ${btoa(`${clientId}:test-client-secret`)}`,
        "content-type": "application/x-www-form-urlencoded",
      });
      const body = new URLSearchParams(String(init?.body));
      expect([...body.keys()].sort()).toEqual(
        ["client_id", "code", "code_verifier", "grant_type", "redirect_uri"].sort(),
      );
      expect(Object.fromEntries(body)).toEqual({
        grant_type: "authorization_code",
        code: "authorization-code",
        redirect_uri: validInput.redirectUri,
        client_id: clientId,
        code_verifier: "verifier",
      });
      return jsonTokens(await token());
    });

    await expect(
      exchangeAndVerifyTelegramCode(validInput, { fetch: fetchMock, jwks }),
    ).resolves.toEqual({
      telegramUserId: "987654321",
      displayName: "Ada Lovelace",
      username: "ada",
      avatarUrl: "https://cdn.example/avatar.jpg",
      oidc: { issuer, subject: "telegram-subject-987654321", audience: clientId },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(
      JSON.stringify(await exchangeAndVerifyTelegramCode(validInput, { fetch: fetchMock, jwks })),
    ).not.toContain("discarded-access-token");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("form-encodes special and Unicode client credentials before Basic base64", async () => {
    const specialClientId = "client:id space";
    const specialClientSecret = "s:ë% cret";
    const fetchMock = vi.fn<typeof fetch>(async (_url, init) => {
      expect(init?.headers).toMatchObject({
        authorization: `Basic ${btoa("client%3Aid+space:s%3A%C3%AB%25+cret")}`,
      });
      const body = new URLSearchParams(String(init?.body));
      expect(body.get("client_id")).toBe(specialClientId);
      expect(String(init?.body)).not.toContain(specialClientSecret);
      return jsonTokens(await token({ aud: specialClientId }));
    });

    await expect(
      exchangeAndVerifyTelegramCode(
        { ...validInput, clientId: specialClientId, clientSecret: specialClientSecret },
        { fetch: fetchMock, jwks },
      ),
    ).resolves.toMatchObject({ oidc: { audience: specialClientId } });
  });

  it.each([
    ["nonce", { nonce: "wrong" }],
    ["missing expiration", { exp: undefined }],
    ["missing issued-at", { iat: undefined }],
    ["profile id", { id: undefined }],
    ["unsafe profile id", { id: Number.MAX_SAFE_INTEGER + 1 }],
    ["oversized string profile id", { id: "99999999999999999999" }],
    ["subject", { sub: undefined }],
    ["display name", { name: "" }],
    ["username", { preferred_username: "" }],
    ["non-HTTP picture", { picture: "javascript:alert(1)" }],
  ])("rejects an invalid %s claim", async (_name, overrides) => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonTokens(await token(overrides)));
    await expect(
      exchangeAndVerifyTelegramCode(validInput, { fetch: fetchMock, jwks }),
    ).rejects.toMatchObject({ code: "OIDC_TOKEN_INVALID" });
  });

  it("rejects issuer, audience, expiry, future nbf, algorithm, and signature changes", async () => {
    const now = Math.floor(Date.now() / 1000);
    const invalidTokens = [
      await token({ iss: "https://evil.test" }),
      await token({ aud: "other-client" }),
      await token({ exp: 1 }),
      await token({ nbf: now + 3600 }),
      await token({ iat: now + 3600, exp: now + 7200 }),
      await token({ aud: [clientId, "other-client"] }),
      await token({}, { algorithm: "ES256", key: wrongAlgorithmKey }),
      `${await token()}x`,
    ];
    for (const idToken of invalidTokens) {
      const fetchMock = vi.fn<typeof fetch>(async () => jsonTokens(idToken));
      await expect(
        exchangeAndVerifyTelegramCode(validInput, { fetch: fetchMock, jwks }),
      ).rejects.toMatchObject({ code: "OIDC_TOKEN_INVALID" });
    }
  });

  it("classifies a generic remote-JWKS failure as a retryable provider error", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonTokens(await token()));
    const failingJwks: JWTVerifyGetKey = async () => {
      throw new joseErrors.JOSEError("secret remote JWKS response detail");
    };

    const failure = exchangeAndVerifyTelegramCode(validInput, {
      fetch: fetchMock,
      jwks: failingJwks,
    });
    await expect(failure).rejects.toMatchObject({ code: "OIDC_PROVIDER_ERROR" });
    await expect(failure).rejects.not.toHaveProperty("cause");
  });

  it.each([
    ["network failure", async () => Promise.reject(new Error("secret network detail"))],
    ["HTTP failure", async () => new Response("secret upstream detail", { status: 502 })],
    [
      "wrong content type",
      async () => new Response(JSON.stringify({ id_token: await token() }), { status: 200 }),
    ],
    [
      "oversized response",
      async () =>
        new Response(JSON.stringify({ id_token: await token() }), {
          status: 200,
          headers: { "content-length": "1000000", "content-type": "application/json" },
        }),
    ],
    [
      "malformed JSON",
      async () =>
        new Response("{", { status: 200, headers: { "content-type": "application/json" } }),
    ],
    ["missing id_token", async () => Response.json({ access_token: "secret" })],
  ])("maps %s to a sanitized provider error", async (_name, responseFactory) => {
    const fetchMock = vi.fn<typeof fetch>(responseFactory);
    const failure = exchangeAndVerifyTelegramCode(validInput, { fetch: fetchMock, jwks });
    await expect(failure).rejects.toBeInstanceOf(OidcProviderError);
    await expect(failure).rejects.toMatchObject({ code: "OIDC_PROVIDER_ERROR" });
    await expect(failure).rejects.not.toHaveProperty("cause");
  });

  it.each([
    ["code", { code: "" }],
    ["verifier", { verifier: "" }],
    ["nonce", { expectedNonce: "" }],
    ["client id", { clientId: "" }],
    ["client secret", { clientSecret: "" }],
    ["redirect URI", { redirectUri: "javascript:alert(1)" }],
    ["oversized code", { code: "a".repeat(4097) }],
  ])("rejects invalid %s before contacting Telegram", async (_name, override) => {
    const fetchMock = vi.fn<typeof fetch>();
    await expect(
      exchangeAndVerifyTelegramCode({ ...validInput, ...override }, { fetch: fetchMock, jwks }),
    ).rejects.toMatchObject({ code: "OIDC_PROVIDER_ERROR" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("retains only an allowlisted OAuth error and HTTP status for diagnostics", async () => {
    for (const oauthError of ["invalid_client", "invalid_grant", "secret-provider-detail"]) {
      const fetchMock = vi.fn<typeof fetch>(async () =>
        Response.json(
          {
            error: oauthError,
            error_description: "secret-provider-detail",
            id_token: "secret-token",
          },
          { status: 401 },
        ),
      );
      const failure = exchangeAndVerifyTelegramCode(validInput, { fetch: fetchMock, jwks });
      await expect(failure).rejects.toMatchObject({
        code: "OIDC_PROVIDER_ERROR",
        diagnostic: {
          stage: "token_http",
          status: 401,
          ...(oauthError === "secret-provider-detail" ? {} : { oauthError }),
        },
      });
      try {
        await failure;
      } catch (error) {
        expect(JSON.stringify(error)).not.toContain("secret-provider-detail");
        expect(JSON.stringify(error)).not.toContain("secret-token");
        expect(JSON.stringify(error)).not.toContain(validInput.clientSecret);
      }
    }
  });

  it("distinguishes transport, response parsing and JWKS failure stages", async () => {
    const cases: [typeof fetch, JWTVerifyGetKey, string][] = [
      [
        async () => {
          throw new Error("private network detail");
        },
        jwks,
        "token_network",
      ],
      [async () => new Response("private HTML"), jwks, "token_content_type"],
      [
        async () => new Response("{", { headers: { "content-type": "application/json" } }),
        jwks,
        "token_json",
      ],
      [async () => Response.json({ access_token: "private token" }), jwks, "token_schema"],
      [
        async () => jsonTokens(await token()),
        async () => {
          throw new joseErrors.JWKSTimeout();
        },
        "jwks",
      ],
    ];
    for (const [fetchMock, getKey, stage] of cases) {
      await expect(
        exchangeAndVerifyTelegramCode(validInput, { fetch: fetchMock, jwks: getKey }),
      ).rejects.toMatchObject({
        code: "OIDC_PROVIDER_ERROR",
        diagnostic: { stage },
      });
    }
  });
});
