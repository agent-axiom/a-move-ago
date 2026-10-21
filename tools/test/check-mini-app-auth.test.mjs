import assert from "node:assert/strict";
import test from "node:test";
import { checkMiniAppAuthLogs, verifyBotIdentity } from "../scripts/check-mini-app-auth.mjs";

const sensitive = "PRIVATE_VALUE_MUST_NOT_LEAK";
const config = { accountId: "a".repeat(32), apiToken: sensitive };
const botConfig = { botToken: `123456789:${sensitive}`, clientId: "123456789" };
const requestId = "f9b759fd-b52b-4d9f-8694-f693b3ff4942";
const time = Date.parse("2026-10-21T20:00:00Z");
const route = "/v1/auth/telegram/mini-app";
const diagnostic = { requestId, method: "POST", path: route, status: 401, sessionKind: "guest" };

function event(source, service = "a-move-ago-api") {
  return { $metadata: { service, url: `https://private.test/?token=${sensitive}` }, source };
}

function harness({ events = [event(diagnostic)], override } = {}) {
  const requests = [];
  const fetch = async (url, options) => {
    requests.push({ url, ...options, payload: JSON.parse(options.body) });
    const custom = await override?.(url, options);
    if (custom) return custom;
    if (url.endsWith("/keys")) {
      return Response.json({
        success: true,
        result: [{ key: "$metadata.service", type: "string" }],
      });
    }
    return Response.json({ success: true, result: { events: { events } } });
  };
  return {
    requests,
    run: (input = config) =>
      checkMiniAppAuthLogs(input, { fetch, now: () => time, timeoutMs: 500 }),
  };
}

function assertSafe(result) {
  const output = JSON.stringify(result);
  for (const forbidden of [sensitive, "private.test", "$metadata", botConfig.botToken]) {
    assert.equal(output.includes(forbidden), false);
  }
}

test("queries only recent Mini App records and projects validated fields", async () => {
  const check = harness();
  const result = await check.run();
  assert.deepEqual(result, {
    ok: true,
    count: 1,
    queriedEvents: 1,
    matchedService: 1,
    parsedDiagnostics: 1,
    entries: [{ requestId, route, status: 401, sessionKind: "guest" }],
  });
  assertSafe(result);
  assert.equal(check.requests.length, 2);
  for (const request of check.requests) {
    assert.equal(new URL(request.url).origin, "https://api.cloudflare.com");
    assert.equal(request.method, "POST");
    assert.equal(request.redirect, "error");
    assert.equal(request.cache, "no-store");
    assert.equal(request.headers.authorization, `Bearer ${sensitive}`);
    assert.ok(request.signal instanceof AbortSignal);
  }
  const query = check.requests[1].payload;
  assert.deepEqual(query.timeframe, { from: time - 3_600_000, to: time });
  assert.equal(query.dry, true);
  assert.equal(query.limit, 50);
  assert.deepEqual(query.parameters.needle, { value: route, isRegex: false, matchCase: true });
  assert.deepEqual(query.parameters.filters, [
    { key: "$metadata.service", operation: "eq", type: "string", value: "a-move-ago-api" },
  ]);
});

test("supports JSON wrappers and discards all unrelated or sensitive fields", async () => {
  const result = await harness({
    events: [
      event({ ...diagnostic, code: "TELEGRAM_PROOF_EXPIRED", initData: sensitive }),
      event(JSON.stringify({ ...diagnostic, profile: { name: sensitive } })),
      event({ message: JSON.stringify(diagnostic), [sensitive]: sensitive }),
      event({ ...diagnostic, errorCode: "AUTH_CHANNEL_MISMATCH", sessionKind: "none" }),
      event({ ...diagnostic, code: sensitive }),
    ],
  }).run();
  assert.equal(result.count, 5);
  assert.equal(result.entries[0].code, "TELEGRAM_PROOF_EXPIRED");
  assert.equal(result.entries[3].code, "AUTH_CHANNEL_MISMATCH");
  assert.equal(Object.hasOwn(result.entries[4], "code"), false);
  assertSafe(result);
});

test("rejects foreign workers, other routes and malformed diagnostic fields", async () => {
  const result = await harness({
    events: [
      event(diagnostic, "other-worker"),
      event({ ...diagnostic, path: `${route}?initData=${sensitive}` }),
      event({ ...diagnostic, requestId: sensitive }),
      event({ ...diagnostic, status: 999 }),
      event({ ...diagnostic, status: "401" }),
      event({ ...diagnostic, sessionKind: sensitive }),
      event([diagnostic]),
      event(null),
      event(sensitive),
      event({ message: sensitive }),
    ],
  }).run();
  assert.equal(result.count, 0);
  assert.equal(result.queriedEvents, 10);
  assert.equal(result.matchedService, 9);
  assertSafe(result);
});

test("rejects invalid telemetry configuration before network access", async () => {
  for (const input of [{}, { ...config, accountId: "../escape" }, { ...config, apiToken: "" }]) {
    const check = harness();
    assert.deepEqual(await check.run(input), { ok: false, code: "INVALID_CONFIGURATION" });
    assert.equal(check.requests.length, 0);
  }
});

test("never exposes telemetry provider error payloads", async () => {
  for (const [override, code] of [
    [() => Promise.reject(new Error(sensitive)), "TRANSPORT_FAILED"],
    [() => new Response(sensitive, { status: 403 }), "NOT_AUTHORIZED"],
    [() => new Response(sensitive, { status: 502 }), "QUERY_HTTP_FAILED"],
    [() => Response.json({ success: false, errors: [sensitive] }), "QUERY_REJECTED"],
    [() => new Response(sensitive), "RESPONSE_INVALID_JSON"],
    [() => Response.json({ value: sensitive.repeat(60_000) }), "RESPONSE_TOO_LARGE"],
    [() => Response.json({ success: true, result: [] }), "QUERY_KEYS_UNAVAILABLE"],
  ]) {
    const result = await harness({ override }).run();
    assert.deepEqual(result, { ok: false, code });
    assertSafe(result);
  }
});

const validBot = { id: 123456789, is_bot: true, username: "a_move_ago_bot", first_name: sensitive };

test("checks the bot identity without returning private data", async () => {
  const result = await verifyBotIdentity(botConfig, {
    fetch: async (url, options) => {
      assert.equal(url, `https://api.telegram.org/bot${botConfig.botToken}/getMe`);
      assert.equal(options.method, "GET");
      assert.equal(options.redirect, "error");
      assert.equal(options.cache, "no-store");
      assert.ok(options.signal instanceof AbortSignal);
      return Response.json({ ok: true, result: validBot });
    },
  });
  assert.deepEqual(result, { ok: true, status: 200, idMatches: true, usernameMatches: true });
  assertSafe(result);
});

test("reports a different bot without exposing its identity", async () => {
  for (const identity of [
    { ...validBot, id: 999 },
    { ...validBot, username: sensitive },
    { ...validBot, id: 999, username: sensitive },
  ]) {
    const result = await verifyBotIdentity(botConfig, {
      fetch: async () => Response.json({ ok: true, result: identity }),
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, "BOT_IDENTITY_MISMATCH");
    assertSafe(result);
  }
});

test("refuses unsafe bot token paths and client IDs before issuing a request", async () => {
  for (const input of [
    {},
    { ...botConfig, botToken: `${botConfig.botToken}/../getUpdates` },
    { ...botConfig, botToken: `${botConfig.botToken}\n` },
    { ...botConfig, clientId: sensitive },
  ]) {
    let requested = false;
    const result = await verifyBotIdentity(input, {
      fetch: async () => {
        requested = true;
        throw new Error(sensitive);
      },
    });
    assert.equal(requested, false);
    assert.deepEqual(result, { ok: false, code: "INVALID_CONFIGURATION" });
    assertSafe(result);
  }
});

test("sanitizes all bot transport, parsing, identity and authentication failures", async () => {
  for (const [fetch, code] of [
    [async () => Promise.reject(new Error(botConfig.botToken)), "TRANSPORT_FAILED"],
    [async () => new Response(sensitive, { status: 401 }), "BOT_HTTP_FAILED"],
    [async () => Response.json({ ok: false, description: sensitive }), "BOT_REJECTED"],
    [
      async () => Response.json({ ok: true, result: { ...validBot, id: "123" } }),
      "BOT_RESPONSE_INVALID",
    ],
    [
      async () => Response.json({ ok: true, result: { ...validBot, is_bot: false } }),
      "BOT_RESPONSE_INVALID",
    ],
    [async () => new Response(sensitive), "RESPONSE_INVALID_JSON"],
    [async () => Response.json({ value: sensitive.repeat(3000) }), "RESPONSE_TOO_LARGE"],
  ]) {
    const result = await verifyBotIdentity(botConfig, { fetch });
    assert.equal(result.code, code);
    assert.equal(result.ok, false);
    assertSafe(result);
  }
});
