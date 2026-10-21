import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const webOrigin = "https://chess.kosarevsky.dev";
const opaqueToken = /^[A-Za-z0-9_-]{43}$/;
const requestIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const maxResponseBytes = 65_536;

class CallbackCheckError extends Error {}

function ensure(condition, code) {
  if (!condition) throw new CallbackCheckError(code);
}

async function boundedJson(response) {
  const length = response.headers.get("content-length");
  ensure(
    length === null || (/^\d+$/.test(length) && Number(length) <= maxResponseBytes),
    "RESPONSE_TOO_LARGE",
  );
  ensure(
    response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() ===
      "application/json",
    "RESPONSE_CONTENT_TYPE",
  );
  ensure(response.body, "RESPONSE_EMPTY");
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
        throw new CallbackCheckError("RESPONSE_TOO_LARGE");
      }
      chunks.push(value);
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
  } catch (error) {
    if (error instanceof CallbackCheckError) throw error;
    throw new CallbackCheckError("RESPONSE_INVALID_JSON");
  } finally {
    reader.releaseLock();
  }
}

/** Checks recovery using an owned guest and synthetic invalid code, never real login proof. */
export async function checkOidcCallbackProduction(
  { apiOrigin },
  { fetch: request = globalThis.fetch, timeoutMs = 15_000 } = {},
) {
  let stage = "configuration";
  let requestId;
  try {
    let api;
    try {
      api = new URL(apiOrigin);
    } catch {
      throw new CallbackCheckError("INVALID_API_ORIGIN");
    }
    ensure(api.protocol === "https:" && api.origin === apiOrigin, "INVALID_API_ORIGIN");

    async function call(path, { body, token, manual = false } = {}) {
      const headers = { accept: "application/json" };
      if (body !== undefined || token) headers.origin = webOrigin;
      if (body !== undefined) headers["content-type"] = "application/json";
      if (token) headers.authorization = `Bearer ${token}`;
      try {
        return await request(`${apiOrigin}${path}`, {
          method: body === undefined ? "GET" : "POST",
          headers,
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          redirect: manual ? "manual" : "error",
          cache: "no-store",
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch {
        throw new CallbackCheckError("TRANSPORT_FAILED");
      }
    }

    stage = "guest";
    const guestResponse = await call("/v1/sessions/guest", { body: { channel: "web" } });
    ensure(guestResponse.status === 201, "GUEST_HTTP_FAILED");
    const guest = await boundedJson(guestResponse);
    ensure(
      guest?.kind === "guest" && typeof guest.token === "string" && opaqueToken.test(guest.token),
      "GUEST_RESPONSE_INVALID",
    );

    stage = "start";
    const startResponse = await call("/v1/auth/telegram/oidc/start", {
      token: guest.token,
      body: { channel: "web" },
    });
    ensure(startResponse.status === 200, "START_HTTP_FAILED");
    const start = await boundedJson(startResponse);
    let authorization;
    try {
      authorization = new URL(start?.authorizationUrl);
    } catch {
      throw new CallbackCheckError("AUTHORIZATION_URL_INVALID");
    }
    const callbackPath = "/v1/auth/telegram/oidc/callback";
    const state = authorization.searchParams.get("state");
    const nonce = authorization.searchParams.get("nonce");
    ensure(
      authorization.origin === "https://oauth.telegram.org" &&
        authorization.pathname === "/auth" &&
        authorization.username === "" &&
        authorization.password === "" &&
        authorization.hash === "" &&
        authorization.searchParams.get("redirect_uri") === `${apiOrigin}${callbackPath}` &&
        authorization.searchParams.get("response_type") === "code" &&
        authorization.searchParams.get("code_challenge_method") === "S256" &&
        typeof state === "string" &&
        opaqueToken.test(state) &&
        typeof nonce === "string" &&
        opaqueToken.test(nonce),
      "AUTHORIZATION_URL_INVALID",
    );
    // Never visit Telegram's authorization URL or use a code from an actual user login.
    const query = new URLSearchParams({
      state,
      code: `invalid${randomBytes(15).toString("base64url")}`,
    });
    const callback = `${callbackPath}?${query}`;

    stage = "callback";
    const callbackResponse = await call(callback, { manual: true });
    const responseId = callbackResponse.headers.get("x-request-id");
    if (responseId && requestIdPattern.test(responseId)) requestId = responseId;
    ensure(callbackResponse.status === 302, "CALLBACK_HTTP_FAILED");
    ensure(
      callbackResponse.headers.get("location") === `${webOrigin}/?authError=login_failed`,
      "CALLBACK_RETURN_INVALID",
    );
    ensure(
      callbackResponse.headers.get("cache-control") === "no-store" &&
        callbackResponse.headers.get("referrer-policy") === "no-referrer",
      "CALLBACK_PRIVACY_HEADERS_INVALID",
    );
    ensure(requestId, "CALLBACK_REQUEST_ID_INVALID");
    await callbackResponse.body?.cancel();

    stage = "guest_preserved";
    const meResponse = await call("/v1/me", { token: guest.token });
    ensure(meResponse.status === 200, "GUEST_ME_HTTP_FAILED");
    const me = await boundedJson(meResponse);
    ensure(me?.kind === "guest" && me.profile === null, "GUEST_NOT_PRESERVED");

    stage = "replay";
    const replayResponse = await call(callback, { manual: true });
    ensure(replayResponse.status === 400, "STATE_REPLAY_HTTP_FAILED");
    const replay = await boundedJson(replayResponse);
    ensure(replay?.error?.code === "OIDC_STATE_INVALID", "STATE_REPLAY_NOT_REJECTED");

    return {
      ok: true,
      returnOrigin: webOrigin,
      guestPreserved: true,
      stateReplayRejected: true,
      requestId,
    };
  } catch (error) {
    return {
      ok: false,
      stage,
      code: error instanceof CallbackCheckError ? error.message : "CHECK_FAILED",
      ...(requestId ? { requestId } : {}),
    };
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await checkOidcCallbackProduction({ apiOrigin: process.env.API_ORIGIN });
  console.log(JSON.stringify(result));
  if (!result.ok) process.exitCode = 1;
}
