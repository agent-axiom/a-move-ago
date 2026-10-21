import { createRemoteJWKSet, type JWTVerifyGetKey, errors as joseErrors, jwtVerify } from "jose";
import { z } from "zod";
import { utf8 } from "../crypto/encoding";
import type { VerifiedTelegramIdentity } from "./types";

const issuer = "https://oauth.telegram.org" as const;
const tokenEndpoint = "https://oauth.telegram.org/token" as const;
const remoteJwks = createRemoteJWKSet(new URL("https://oauth.telegram.org/.well-known/jwks.json"));
const maxProviderResponseBytes = 65_536;
const maxFutureIssuedAtSeconds = 60;

const ExchangeInputSchema = z
  .object({
    code: z.string().min(1).max(4096),
    verifier: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9._~-]+$/),
    expectedNonce: z.string().min(1).max(512),
    clientId: z.string().min(1).max(256),
    clientSecret: z.string().min(1).max(1024),
    redirectUri: z
      .httpUrl()
      .max(2048)
      .refine((value) => {
        const parsed = new URL(value);
        return (
          parsed.protocol === "https:" &&
          parsed.username === "" &&
          parsed.password === "" &&
          parsed.search === "" &&
          parsed.hash === "" &&
          parsed.toString() === value
        );
      }),
  })
  .strict();

const TokenResponseSchema = z
  .object({
    id_token: z.string().min(1).max(32_768),
    access_token: z.string().max(32_768).optional(),
    token_type: z.string().max(64).optional(),
    expires_in: z.number().int().safe().nonnegative().optional(),
  })
  .passthrough();

const maxSignedInt64 = 9_223_372_036_854_775_807n;
const TelegramIdSchema = z
  .union([
    z.number().int().safe().positive(),
    z
      .string()
      .min(1)
      .max(20)
      .regex(/^[1-9]\d*$/),
  ])
  .refine((value) => BigInt(value) <= maxSignedInt64);

const TelegramClaimsSchema = z
  .object({
    sub: z.string().min(1).max(512),
    exp: z.number().int().safe().nonnegative(),
    iat: z.number().int().safe().nonnegative(),
    nonce: z.string().min(1).max(512),
    id: TelegramIdSchema,
    name: z.string().min(1).max(256),
    preferred_username: z.string().min(1).max(64).optional(),
    picture: z.httpUrl().max(2048).optional(),
  })
  .passthrough();

type WorkerdSubtleCrypto = SubtleCrypto & {
  timingSafeEqual(left: ArrayBufferView<ArrayBuffer>, right: ArrayBufferView<ArrayBuffer>): boolean;
};

export class OidcProviderError extends Error {
  constructor(
    readonly code: "OIDC_PROVIDER_ERROR" | "OIDC_TOKEN_INVALID",
    readonly diagnostic: {
      stage: "unknown" | "input" | "token_network" | "token_http" | "token_size" |
        "token_content_type" | "token_read" | "token_json" | "token_schema" | "jwks";
      status?: number;
      oauthError?: "invalid_client" | "invalid_grant" | "invalid_request" |
        "unauthorized_client" | "unsupported_grant_type" | "invalid_scope" |
        "server_error" | "temporarily_unavailable";
    } = { stage: "unknown" },
  ) {
    super(code);
    this.name = "OidcProviderError";
  }
}

export interface TelegramOidcProvider {
  exchangeAndVerify(input: {
    code: string;
    verifier: string;
    expectedNonce: string;
    clientId: string;
    clientSecret: string;
    redirectUri: string;
  }): Promise<VerifiedTelegramIdentity>;
}

function providerError(
  stage: OidcProviderError["diagnostic"]["stage"],
  details: Omit<OidcProviderError["diagnostic"], "stage"> = {},
): OidcProviderError {
  return new OidcProviderError("OIDC_PROVIDER_ERROR", { stage, ...details });
}

function invalidToken(): OidcProviderError {
  return new OidcProviderError("OIDC_TOKEN_INVALID");
}

function formComponent(value: string): string {
  const encoded = new URLSearchParams({ value }).toString();
  return encoded.slice("value=".length);
}

function clientSecretBasic(clientId: string, clientSecret: string): string {
  const credentials = `${formComponent(clientId)}:${formComponent(clientSecret)}`;
  return `Basic ${btoa(String.fromCharCode(...utf8.encode(credentials)))}`;
}

function isJsonContentType(value: string | null): boolean {
  if (!value) return false;
  const mediaType = value.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return (
    mediaType === "application/json" || /^application\/[a-z0-9!#$&^_.+-]+\+json$/.test(mediaType)
  );
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const rawLength = response.headers.get("content-length");
  if (rawLength !== null) {
    if (!/^\d+$/.test(rawLength) || Number(rawLength) > maxProviderResponseBytes) {
      throw providerError("token_size");
    }
  }
  if (!isJsonContentType(response.headers.get("content-type")) || !response.body) {
    throw providerError("token_content_type");
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > maxProviderResponseBytes) {
        await reader.cancel();
        throw providerError("token_size");
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof OidcProviderError) throw error;
    throw providerError("token_read");
  }

  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw providerError("token_json");
  }
}

function nonceMatches(actual: string, expected: string): boolean {
  const actualBytes = utf8.encode(actual);
  const expectedBytes = utf8.encode(expected);
  return (
    actualBytes.byteLength === expectedBytes.byteLength &&
    (crypto.subtle as WorkerdSubtleCrypto).timingSafeEqual(actualBytes, expectedBytes)
  );
}

function isRemoteKeyFailure(error: unknown): boolean {
  return (
    error instanceof joseErrors.JWKSTimeout ||
    error instanceof joseErrors.JWKSInvalid ||
    error instanceof joseErrors.JWKInvalid ||
    (error instanceof joseErrors.JOSEError && error.code === "ERR_JOSE_GENERIC") ||
    !(error instanceof joseErrors.JOSEError)
  );
}

export async function exchangeAndVerifyTelegramCode(
  input: Parameters<TelegramOidcProvider["exchangeAndVerify"]>[0],
  dependencies: { fetch: typeof fetch; jwks: JWTVerifyGetKey } = {
    fetch,
    jwks: remoteJwks,
  },
): Promise<VerifiedTelegramIdentity> {
  const parsedInput = ExchangeInputSchema.safeParse(input);
  if (!parsedInput.success) throw providerError("input");

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: parsedInput.data.code,
    redirect_uri: parsedInput.data.redirectUri,
    client_id: parsedInput.data.clientId,
    code_verifier: parsedInput.data.verifier,
  });
  let response: Response;
  try {
    response = await dependencies.fetch(tokenEndpoint, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
      headers: {
        authorization: clientSecretBasic(parsedInput.data.clientId, parsedInput.data.clientSecret),
        "content-type": "application/x-www-form-urlencoded",
      },
      body,
    });
  } catch {
    throw providerError("token_network");
  }
  if (!response.ok) {
    const oauthErrorSchema = z.object({
      error: z.enum([
        "invalid_client", "invalid_grant", "invalid_request", "unauthorized_client",
        "unsupported_grant_type", "invalid_scope", "server_error", "temporarily_unavailable",
      ]),
    });
    let oauthError: OidcProviderError["diagnostic"]["oauthError"];
    try {
      const parsed = oauthErrorSchema.safeParse(await readBoundedJson(response));
      if (parsed.success) oauthError = parsed.data.error;
    } catch {
      // Never retain or log the provider's body, descriptions, tokens or headers.
    }
    throw providerError("token_http", {
      status: response.status,
      ...(oauthError ? { oauthError } : {}),
    });
  }
  const tokens = TokenResponseSchema.safeParse(await readBoundedJson(response));
  if (!tokens.success) throw providerError("token_schema");

  let verified: Awaited<ReturnType<typeof jwtVerify>>;
  try {
    verified = await jwtVerify(tokens.data.id_token, dependencies.jwks, {
      algorithms: ["RS256"],
      issuer,
      audience: parsedInput.data.clientId,
      requiredClaims: ["exp", "iat", "sub", "nonce"],
    });
  } catch (error) {
    if (isRemoteKeyFailure(error)) throw providerError("jwks");
    throw invalidToken();
  }

  try {
    const claims = TelegramClaimsSchema.parse(verified.payload);
    const now = Math.floor(Date.now() / 1000);
    if (
      verified.payload.iss !== issuer ||
      verified.payload.aud !== parsedInput.data.clientId ||
      claims.iat > now + maxFutureIssuedAtSeconds ||
      !nonceMatches(claims.nonce, parsedInput.data.expectedNonce)
    ) {
      throw invalidToken();
    }
    return {
      telegramUserId: String(claims.id),
      displayName: claims.name,
      username: claims.preferred_username ?? null,
      avatarUrl: claims.picture ?? null,
      oidc: {
        issuer,
        subject: claims.sub,
        audience: parsedInput.data.clientId,
      },
    };
  } catch {
    throw invalidToken();
  }
}

export const telegramOidcProvider: TelegramOidcProvider = {
  exchangeAndVerify: async (input) => await exchangeAndVerifyTelegramCode(input),
};
