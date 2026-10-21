import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const worker = "a-move-ago-api";
const eventName = "telegram_oidc_failure";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const stages = new Set([
  "unknown",
  "input",
  "token_network",
  "token_http",
  "token_size",
  "token_content_type",
  "token_read",
  "token_json",
  "token_schema",
  "jwks",
]);
const oauthErrors = new Set([
  "invalid_client",
  "invalid_grant",
  "invalid_request",
  "unauthorized_client",
  "unsupported_grant_type",
  "invalid_scope",
  "server_error",
  "temporarily_unavailable",
]);
const diagnosticKeys = new Set(["event", "code", "requestId", "stage", "status", "oauthError"]);
const maxResponseBytes = 1_048_576;

class LogCheckError extends Error {}

function ensure(condition, code) {
  if (!condition) throw new LogCheckError(code);
}

async function boundedJson(response) {
  const length = response.headers.get("content-length");
  ensure(
    length === null || (/^\d+$/.test(length) && Number(length) <= maxResponseBytes),
    "RESPONSE_TOO_LARGE",
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
        throw new LogCheckError("RESPONSE_TOO_LARGE");
      }
      chunks.push(value);
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
  } catch (error) {
    if (error instanceof LogCheckError) throw error;
    throw new LogCheckError("RESPONSE_INVALID_JSON");
  } finally {
    reader.releaseLock();
  }
}

function parseSource(source) {
  try {
    if (typeof source === "string") {
      if (source.length > 8192) return null;
      source = JSON.parse(source);
    }
    if (source && !Array.isArray(source) && typeof source === "object") {
      // console.log(JSON.stringify(...)) can be stored as a message string.
      if (source.event === undefined && typeof source.message === "string") {
        if (source.message.length > 8192) return null;
        source = JSON.parse(source.message);
      }
    }
    if (!source || Array.isArray(source) || typeof source !== "object") return null;
    if (
      Object.keys(source).some((key) => !diagnosticKeys.has(key)) ||
      source.event !== eventName ||
      !["OIDC_PROVIDER_ERROR", "OIDC_TOKEN_INVALID"].includes(source.code) ||
      !stages.has(source.stage) ||
      typeof source.requestId !== "string" ||
      !uuid.test(source.requestId) ||
      (source.status !== undefined &&
        (!Number.isInteger(source.status) || source.status < 100 || source.status > 599)) ||
      (source.oauthError !== undefined && !oauthErrors.has(source.oauthError))
    ) {
      return null;
    }
    return {
      requestId: source.requestId,
      stage: source.stage,
      ...(source.status === undefined ? {} : { status: source.status }),
      ...(source.oauthError === undefined ? {} : { oauthError: source.oauthError }),
    };
  } catch {
    return null;
  }
}

/** Read-only telemetry query. Raw logs and Cloudflare errors never leave this function. */
export async function checkOidcProviderLogs(
  { accountId, apiToken, requestId } = {},
  { fetch: request = globalThis.fetch, now = () => Date.now(), timeoutMs = 15_000 } = {},
) {
  try {
    ensure(
      typeof accountId === "string" &&
        /^[0-9a-f]{32}$/i.test(accountId) &&
        typeof apiToken === "string" &&
        apiToken.length > 0 &&
        apiToken.length <= 4096 &&
        apiToken === apiToken.trim() &&
        !/[\r\n]/.test(apiToken) &&
        (requestId === undefined || (typeof requestId === "string" && uuid.test(requestId))),
      "INVALID_CONFIGURATION",
    );
    const to = now();
    ensure(Number.isSafeInteger(to) && to > 1_800_000, "INVALID_TIMEFRAME");
    const from = to - 1_800_000;
    const origin = `https://api.cloudflare.com/client/v4/accounts/${accountId}`;

    async function call(path, body) {
      let response;
      try {
        response = await request(`${origin}/workers/observability/telemetry/${path}`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${apiToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
          redirect: "error",
          cache: "no-store",
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch {
        throw new LogCheckError("TRANSPORT_FAILED");
      }
      if (response.status === 401 || response.status === 403) {
        await response.body?.cancel();
        throw new LogCheckError("NOT_AUTHORIZED");
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new LogCheckError("QUERY_HTTP_FAILED");
      }
      const payload = await boundedJson(response);
      ensure(payload?.success === true, "QUERY_REJECTED");
      return payload.result;
    }

    // Discover field types before constructing filters; only retain the two required names.
    const keys = await call("keys", {
      from,
      to,
      keyNeedle: { value: "$metadata.", isRegex: false, matchCase: false },
      limit: 100,
    });
    ensure(
      Array.isArray(keys) &&
        ["$metadata.service", "$metadata.message"].every((key) =>
          keys.some((candidate) => candidate?.key === key && candidate.type === "string"),
        ),
      "QUERY_KEYS_UNAVAILABLE",
    );
    const result = await call("query", {
      queryId: randomUUID(),
      timeframe: { from, to },
      dry: true,
      view: "events",
      limit: 50,
      parameters: {
        filterCombination: "and",
        filters: [
          { key: "$metadata.service", operation: "eq", type: "string", value: worker },
          { key: "$metadata.message", operation: "includes", type: "string", value: eventName },
        ],
        needle: { value: requestId ?? eventName, isRegex: false, matchCase: true },
      },
    });
    const events = result?.events?.events;
    ensure(Array.isArray(events) && events.length <= 50, "QUERY_RESPONSE_INVALID");
    const failures = [];
    for (const event of events) {
      if (event?.$metadata?.service !== worker) continue;
      const diagnostic = parseSource(event.source);
      if (diagnostic && (requestId === undefined || diagnostic.requestId === requestId)) {
        failures.push(diagnostic);
      }
    }
    return { ok: true, count: failures.length, failures };
  } catch (error) {
    return { ok: false, code: error instanceof LogCheckError ? error.message : "CHECK_FAILED" };
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await checkOidcProviderLogs({
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
    apiToken: process.env.CLOUDFLARE_API_TOKEN,
    requestId: process.env.OIDC_REQUEST_ID,
  });
  console.log(JSON.stringify(result));
  if (!result.ok) process.exitCode = 1;
}
