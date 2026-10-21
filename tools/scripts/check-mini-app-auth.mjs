import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const worker = "a-move-ago-api";
const route = "/v1/auth/telegram/mini-app";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const sessionKinds = new Set(["none", "guest", "telegram"]);
const proofStages = new Set([
  "configuration",
  "input",
  "signature",
  "future",
  "expired",
  "profile",
  "unknown",
]);
const errorCodes = new Set([
  "TELEGRAM_PROOF_INVALID",
  "TELEGRAM_PROOF_EXPIRED",
  "AUTH_CHANNEL_MISMATCH",
  "AUTH_REQUIRES_GUEST",
  "INVALID_SESSION",
  "INVALID_REQUEST",
  "ORIGIN_NOT_ALLOWED",
  "RATE_LIMITED",
  "INTERNAL_ERROR",
]);
const maxResponseBytes = 1_048_576;

class DiagnosticError extends Error {}

function ensure(condition, code) {
  if (!condition) throw new DiagnosticError(code);
}

async function boundedJson(response, limit = maxResponseBytes) {
  const length = response.headers.get("content-length");
  ensure(
    length === null || (/^\d+$/.test(length) && Number(length) <= limit),
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
      if (size > limit) {
        await reader.cancel();
        throw new DiagnosticError("RESPONSE_TOO_LARGE");
      }
      chunks.push(value);
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
  } catch (error) {
    if (error instanceof DiagnosticError) throw error;
    throw new DiagnosticError("RESPONSE_INVALID_JSON");
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
      if (source.path === undefined && typeof source.message === "string") {
        if (source.message.length > 8192) return null;
        source = JSON.parse(source.message);
      }
    }
    if (!source || Array.isArray(source) || typeof source !== "object") return null;
    if (
      source.path !== route ||
      typeof source.requestId !== "string" ||
      !uuid.test(source.requestId) ||
      !Number.isInteger(source.status) ||
      source.status < 100 ||
      source.status > 599 ||
      !sessionKinds.has(source.sessionKind)
    ) {
      return null;
    }
    const code = source.code ?? source.errorCode;
    return {
      requestId: source.requestId,
      route,
      status: source.status,
      sessionKind: source.sessionKind,
      ...(errorCodes.has(code) ? { code } : {}),
      ...(proofStages.has(source.stage) ? { stage: source.stage } : {}),
    };
  } catch {
    return null;
  }
}

/** Read-only telemetry query. Raw logs and Cloudflare errors never leave this function. */
export async function checkMiniAppAuthLogs(
  { accountId, apiToken } = {},
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
        !/[\r\n]/.test(apiToken),
      "INVALID_CONFIGURATION",
    );
    const to = now();
    ensure(Number.isSafeInteger(to) && to > 3_600_000, "INVALID_TIMEFRAME");
    const from = to - 3_600_000;
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
        throw new DiagnosticError("TRANSPORT_FAILED");
      }
      if (response.status === 401 || response.status === 403) {
        await response.body?.cancel();
        throw new DiagnosticError("NOT_AUTHORIZED");
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new DiagnosticError("QUERY_HTTP_FAILED");
      }
      const payload = await boundedJson(response);
      ensure(payload?.success === true, "QUERY_REJECTED");
      return payload.result;
    }

    // Discover the service field type before constructing its filter.
    const keys = await call("keys", {
      from,
      to,
      keyNeedle: { value: "$metadata.", isRegex: false, matchCase: false },
      limit: 100,
    });
    ensure(
      Array.isArray(keys) &&
        keys.some(
          (candidate) => candidate?.key === "$metadata.service" && candidate.type === "string",
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
        filters: [{ key: "$metadata.service", operation: "eq", type: "string", value: worker }],
        needle: { value: route, isRegex: false, matchCase: true },
      },
    });
    const events = result?.events?.events;
    ensure(Array.isArray(events) && events.length <= 50, "QUERY_RESPONSE_INVALID");
    const entries = [];
    let matchedService = 0;
    let parsedDiagnostics = 0;
    for (const event of events) {
      if (event?.$metadata?.service !== worker) continue;
      matchedService += 1;
      const diagnostic = parseSource(event.source);
      if (diagnostic) parsedDiagnostics += 1;
      if (diagnostic) entries.push(diagnostic);
    }
    return {
      ok: true,
      count: entries.length,
      queriedEvents: events.length,
      matchedService,
      parsedDiagnostics,
      entries,
    };
  } catch (error) {
    return { ok: false, code: error instanceof DiagnosticError ? error.message : "CHECK_FAILED" };
  }
}

/** Read-only getMe check; never returns the bot token, URL or Telegram response body. */
export async function verifyBotIdentity(
  { botToken, clientId } = {},
  { fetch: request = globalThis.fetch, timeoutMs = 15_000 } = {},
) {
  try {
    ensure(
      typeof botToken === "string" &&
        /^[1-9][0-9]{0,19}:[A-Za-z0-9_-]{10,256}$/.test(botToken) &&
        typeof clientId === "string" &&
        /^[1-9][0-9]{0,19}$/.test(clientId),
      "INVALID_CONFIGURATION",
    );
    let response;
    try {
      response = await request(`https://api.telegram.org/bot${botToken}/getMe`, {
        method: "GET",
        redirect: "error",
        cache: "no-store",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new DiagnosticError("TRANSPORT_FAILED");
    }
    if (!response.ok) {
      await response.body?.cancel();
      return { ok: false, code: "BOT_HTTP_FAILED", status: response.status };
    }
    const payload = await boundedJson(response, 65_536);
    ensure(payload?.ok === true, "BOT_REJECTED");
    const identity = payload.result;
    ensure(
      identity?.is_bot === true &&
        Number.isSafeInteger(identity.id) &&
        identity.id > 0 &&
        typeof identity.username === "string",
      "BOT_RESPONSE_INVALID",
    );
    const idMatches = String(identity.id) === clientId;
    const usernameMatches = identity.username === "a_move_ago_bot";
    return {
      ok: idMatches && usernameMatches,
      status: response.status,
      idMatches,
      usernameMatches,
      ...(!idMatches || !usernameMatches ? { code: "BOT_IDENTITY_MISMATCH" } : {}),
    };
  } catch (error) {
    return { ok: false, code: error instanceof DiagnosticError ? error.message : "CHECK_FAILED" };
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [logs, bot] = await Promise.all([
    checkMiniAppAuthLogs({
      accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
      apiToken: process.env.CLOUDFLARE_API_TOKEN,
    }),
    verifyBotIdentity({
      botToken: process.env.TELEGRAM_BOT_TOKEN,
      clientId: process.env.TELEGRAM_OIDC_CLIENT_ID,
    }),
  ]);
  console.log(JSON.stringify({ logs, bot }));
  if (!logs.ok || !bot.ok) process.exitCode = 1;
}
