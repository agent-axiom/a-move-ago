import { createPublicKey, randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const issuer = "https://oauth.telegram.org";
const discoveryUrl = `${issuer}/.well-known/openid-configuration`;
const jwksUrl = `${issuer}/.well-known/jwks.json`;
const tokenUrl = `${issuer}/token`;
const maxResponseBytes = 65_536;
const oauthErrors = new Set([
  "invalid_request",
  "invalid_client",
  "invalid_grant",
  "unauthorized_client",
  "unsupported_grant_type",
  "invalid_scope",
  "server_error",
  "temporarily_unavailable",
]);

class PreflightError extends Error {
  constructor(stage, code, details = {}) {
    super(code);
    this.summary = { ok: false, stage, code, ...details };
  }
}

function ensure(condition, stage, code, details) {
  if (!condition) throw new PreflightError(stage, code, details);
}

function responseDetails(response) {
  const mediaType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  const knownTypes = ["application/json", "application/problem+json", "text/html", "text/plain"];
  return {
    httpStatus: response.status,
    contentType: knownTypes.includes(mediaType) ? mediaType : mediaType ? "other" : "missing",
  };
}

async function boundedJson(response, stage) {
  const details = responseDetails(response);
  const length = response.headers.get("content-length");
  ensure(
    length === null || (/^\d+$/.test(length) && Number(length) <= maxResponseBytes),
    stage,
    "RESPONSE_TOO_LARGE",
    details,
  );
  ensure(
    ["application/json", "application/problem+json"].includes(details.contentType),
    stage,
    "RESPONSE_CONTENT_TYPE",
    details,
  );
  ensure(response.body, stage, "RESPONSE_EMPTY", details);
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxResponseBytes) {
        await reader.cancel();
        throw new PreflightError(stage, "RESPONSE_TOO_LARGE", details);
      }
      chunks.push(value);
    }
    const bytes = Buffer.concat(chunks);
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    if (error instanceof PreflightError) throw error;
    throw new PreflightError(stage, "RESPONSE_INVALID_JSON", details);
  } finally {
    reader.releaseLock();
  }
}

function isUsableRsaKey(key) {
  if (
    !key ||
    key.kty !== "RSA" ||
    (key.use !== undefined && key.use !== "sig") ||
    (key.alg !== undefined && key.alg !== "RS256") ||
    (key.key_ops !== undefined &&
      (!Array.isArray(key.key_ops) || !key.key_ops.includes("verify"))) ||
    typeof key.kid !== "string" ||
    key.kid.length === 0 ||
    typeof key.n !== "string" ||
    typeof key.e !== "string"
  ) {
    return false;
  }
  try {
    const publicKey = createPublicKey({ key: { kty: "RSA", n: key.n, e: key.e }, format: "jwk" });
    return publicKey.asymmetricKeyDetails?.modulusLength >= 2048;
  } catch {
    return false;
  }
}

function clientSecretBasic(clientId, clientSecret) {
  const encode = (value) => new URLSearchParams({ value }).toString().slice("value=".length);
  return `Basic ${Buffer.from(`${encode(clientId)}:${encode(clientSecret)}`).toString("base64")}`;
}

function containsToken(payload) {
  return (
    payload !== null &&
    typeof payload === "object" &&
    (Object.hasOwn(payload, "access_token") || Object.hasOwn(payload, "id_token"))
  );
}

/** Public checks never use user proof. The optional probe submits a synthetic invalid code.
 * An invalid_grant reply is evidence about this request, not an end-to-end login guarantee.
 */
export async function checkTelegramOidc(
  { clientId, clientSecret, apiOrigin } = {},
  { fetch: request = globalThis.fetch, timeoutMs = 10_000 } = {},
) {
  let stage = "configuration";
  try {
    const probeRequested = [clientId, clientSecret, apiOrigin].some((value) => value !== undefined);
    if (probeRequested) {
      ensure(
        typeof clientId === "string" &&
          clientId.length > 0 &&
          clientId.length <= 256 &&
          typeof clientSecret === "string" &&
          clientSecret.length > 0 &&
          clientSecret.length <= 1024 &&
          typeof apiOrigin === "string",
        stage,
        "INVALID_CONFIGURATION",
      );
      let origin;
      try {
        origin = new URL(apiOrigin);
      } catch {
        throw new PreflightError(stage, "INVALID_CONFIGURATION");
      }
      ensure(
        origin.protocol === "https:" && origin.origin === apiOrigin,
        stage,
        "INVALID_CONFIGURATION",
      );
    }

    async function call(url, options = {}) {
      try {
        return await request(url, {
          method: "GET",
          ...options,
          redirect: "error",
          cache: "no-store",
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch {
        throw new PreflightError(stage, "TRANSPORT_FAILED");
      }
    }

    stage = "discovery";
    const discoveryResponse = await call(discoveryUrl);
    const discoveryDetails = responseDetails(discoveryResponse);
    ensure(discoveryResponse.ok, stage, "HTTP_FAILED", discoveryDetails);
    const discovery = await boundedJson(discoveryResponse, stage);
    ensure(
      discovery?.issuer === issuer &&
        discovery.authorization_endpoint === `${issuer}/auth` &&
        discovery.token_endpoint === tokenUrl &&
        discovery.jwks_uri === jwksUrl &&
        discovery.id_token_signing_alg_values_supported?.includes("RS256") &&
        discovery.token_endpoint_auth_methods_supported?.includes("client_secret_basic"),
      stage,
      "DISCOVERY_CONTRACT_CHANGED",
      discoveryDetails,
    );

    stage = "jwks";
    const jwksResponse = await call(jwksUrl);
    const jwksDetails = responseDetails(jwksResponse);
    ensure(jwksResponse.ok, stage, "HTTP_FAILED", jwksDetails);
    const jwks = await boundedJson(jwksResponse, stage);
    ensure(
      Array.isArray(jwks?.keys) && jwks.keys.some(isUsableRsaKey),
      stage,
      "JWKS_NO_USABLE_RS256_KEY",
      jwksDetails,
    );

    let credentialProbe = "not_requested";
    let tokenDetails;
    let controlDetails;
    if (probeRequested) {
      stage = "token_probe";
      // This code has no corresponding login flow and cannot identify or authenticate a user.
      const code = `invalid${randomBytes(15).toString("base64url")}`;
      const body = new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: `${apiOrigin}/v1/auth/telegram/oidc/callback`,
        client_id: clientId,
        code_verifier: randomBytes(32).toString("base64url"),
      });
      const probe = (secret) =>
        call(tokenUrl, {
          method: "POST",
          headers: {
            authorization: clientSecretBasic(clientId, secret),
            "content-type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams(body),
        });
      const response = await probe(clientSecret);
      tokenDetails = responseDetails(response);
      const payload = await boundedJson(response, stage);
      const oauthError = oauthErrors.has(payload?.error) ? payload.error : "unrecognized";
      const details = { ...tokenDetails, oauthError };
      ensure(oauthError !== "invalid_client", stage, "OIDC_CLIENT_REJECTED", details);
      ensure(
        [200, 400].includes(response.status) &&
          oauthError === "invalid_grant" &&
          !containsToken(payload),
        stage,
        "TOKEN_PROBE_UNEXPECTED_RESPONSE",
        details,
      );
      // Telegram can return OAuth errors with HTTP 200. A different response with a
      // deliberately wrong secret distinguishes client validation from code-only rejection.
      stage = "token_control";
      let wrongSecret;
      do {
        wrongSecret = `preflight-invalid-${randomBytes(32).toString("base64url")}`;
      } while (wrongSecret === clientSecret);
      const control = await probe(wrongSecret);
      const controlPayload = await boundedJson(control, stage);
      const controlError = oauthErrors.has(controlPayload?.error)
        ? controlPayload.error
        : "unrecognized";
      controlDetails = { ...responseDetails(control), oauthError: controlError };
      ensure(
        !containsToken(controlPayload),
        stage,
        "TOKEN_CLIENT_CONTROL_UNCONFIRMED",
        controlDetails,
      );
      if ([200, 400].includes(control.status) && controlError === "invalid_grant") {
        // Some providers validate codes before credentials; this cannot confirm the secret.
        credentialProbe = "unconfirmed";
      } else {
        ensure(
          [200, 400, 401].includes(control.status) && controlError === "invalid_client",
          stage,
          "TOKEN_CLIENT_CONTROL_UNCONFIRMED",
          controlDetails,
        );
        credentialProbe = "confirmed";
      }
    }
    return {
      ok: true,
      discovery: discoveryDetails,
      jwks: jwksDetails,
      credentialProbe,
      ...(tokenDetails ? { token: tokenDetails } : {}),
      ...(controlDetails ? { clientControl: controlDetails } : {}),
    };
  } catch (error) {
    if (error instanceof PreflightError) return error.summary;
    return { ok: false, stage, code: "CHECK_FAILED" };
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await checkTelegramOidc({
    clientId: process.env.TELEGRAM_OIDC_CLIENT_ID,
    clientSecret: process.env.TELEGRAM_OIDC_CLIENT_SECRET,
    apiOrigin: process.env.API_ORIGIN,
  });
  console.log(JSON.stringify(result));
  if (!result.ok) process.exitCode = 1;
}
