import assert from "node:assert/strict";
import test from "node:test";
import { checkOidcProviderLogs } from "../scripts/check-oidc-provider-logs.mjs";

const sensitive = "PRIVATE_LOG_OR_SECRET_MUST_NOT_LEAK";
const config = { accountId: "a".repeat(32), apiToken: sensitive };
const requestId = "f9b759fd-b52b-4d9f-8694-f693b3ff4942";
const otherRequestId = "028da486-b3fa-4d10-82f0-6ea89c1d6689";
const time = Date.parse("2026-10-21T20:00:00Z");
const diagnostic = {
  event: "telegram_oidc_failure",
  code: "OIDC_PROVIDER_ERROR",
  requestId,
  stage: "token_http",
  status: 401,
  oauthError: "invalid_client",
};

function event(source, service = "a-move-ago-api") {
  return {
    $metadata: { service, url: `https://api.test/callback?code=${sensitive}` },
    source,
  };
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
        result: [
          { key: "$metadata.service", type: "string" },
          { key: "$metadata.message", type: "string" },
          { key: sensitive, type: "string" },
        ],
      });
    }
    return Response.json({ success: true, result: { events: { events } } });
  };
  return {
    requests,
    run: (input = config) =>
      checkOidcProviderLogs(input, { fetch, now: () => time, timeoutMs: 500 }),
  };
}

function assertSafe(result) {
  const output = JSON.stringify(result);
  assert.equal(output.includes(sensitive), false);
  assert.equal(output.includes("$metadata"), false);
  assert.equal(output.includes("callback?"), false);
}

test("queries a bounded recent window without persisting and emits only safe fields", async () => {
  const check = harness();
  const result = await check.run();
  assert.deepEqual(result, {
    ok: true,
    count: 1,
    failures: [{ requestId, stage: "token_http", status: 401, oauthError: "invalid_client" }],
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
    assert.equal(request.url.includes(sensitive), false);
    assert.equal(request.body.includes(sensitive), false);
  }
  const query = check.requests[1].payload;
  assert.deepEqual(query.timeframe, { from: time - 1_800_000, to: time });
  assert.equal(query.dry, true);
  assert.equal(query.view, "events");
  assert.equal(query.limit, 50);
  assert.deepEqual(query.parameters.needle, {
    value: "telegram_oidc_failure",
    isRegex: false,
    matchCase: true,
  });
  assert.equal(query.parameters.filters[0].key, "$metadata.service");
  assert.equal(query.parameters.filters[0].value, "a-move-ago-api");
});

test("supports JSON strings, structured objects and JSON message wrappers", async () => {
  const result = await harness({
    events: [
      event(diagnostic),
      event(JSON.stringify(diagnostic)),
      event({ message: JSON.stringify(diagnostic) }),
    ],
  }).run();
  assert.equal(result.count, 3);
  assertSafe(result);
});

test("rejects foreign workers, unknown fields, invalid enums and malformed source", async () => {
  const result = await harness({
    events: [
      event(diagnostic, "other-worker"),
      event({ ...diagnostic, event: "other_event" }),
      event({ ...diagnostic, profile: sensitive }),
      event({ ...diagnostic, stage: sensitive }),
      event({ ...diagnostic, oauthError: sensitive }),
      event({ ...diagnostic, status: sensitive }),
      event({ ...diagnostic, status: 999 }),
      event({ ...diagnostic, requestId: sensitive }),
      event({ ...diagnostic, code: sensitive }),
      event(sensitive),
      event({ message: sensitive }),
      event([diagnostic]),
      event(null),
    ],
  }).run();
  assert.deepEqual(result, { ok: true, count: 0, failures: [] });
  assertSafe(result);
});

test("optional request ID is used as exact query needle and checked again in memory", async () => {
  const check = harness({
    events: [event(diagnostic), event({ ...diagnostic, requestId: otherRequestId })],
  });
  const result = await check.run({ ...config, requestId });
  assert.equal(result.count, 1);
  assert.equal(result.failures[0].requestId, requestId);
  assert.deepEqual(check.requests[1].payload.parameters.needle, {
    value: requestId,
    isRegex: false,
    matchCase: true,
  });
});

test("rejects unsafe configuration before querying", async () => {
  for (const input of [
    {},
    { ...config, accountId: `../${sensitive}` },
    { ...config, apiToken: "" },
    { ...config, requestId: `https://api.test/?code=${sensitive}` },
  ]) {
    const check = harness();
    const result = await check.run(input);
    assert.equal(result.code, "INVALID_CONFIGURATION");
    assert.equal(check.requests.length, 0);
    assertSafe(result);
  }
});

test("permission failures never read or print raw error payloads", async () => {
  for (const status of [401, 403]) {
    const result = await harness({
      override: () => new Response(sensitive, { status }),
    }).run();
    assert.deepEqual(result, { ok: false, code: "NOT_AUTHORIZED" });
    assertSafe(result);
  }
});

test("refuses filters when field discovery does not confirm required string keys", async () => {
  const check = harness({
    override: () => Response.json({ success: true, result: [{ key: sensitive, type: "string" }] }),
  });
  const result = await check.run();
  assert.equal(result.code, "QUERY_KEYS_UNAVAILABLE");
  assert.equal(check.requests.length, 1);
  assertSafe(result);
});

test("sanitizes network, HTTP, malformed and oversized payload errors", async (t) => {
  for (const [override, expected] of [
    [() => Promise.reject(new Error(sensitive)), "TRANSPORT_FAILED"],
    [() => new Response(sensitive, { status: 502 }), "QUERY_HTTP_FAILED"],
    [() => Response.json({ success: false, errors: [sensitive] }), "QUERY_REJECTED"],
    [() => new Response(sensitive), "RESPONSE_INVALID_JSON"],
    [() => Response.json({ data: sensitive.repeat(32_768) }), "RESPONSE_TOO_LARGE"],
  ]) {
    await t.test(expected, async () => {
      const result = await harness({ override }).run();
      assert.equal(result.code, expected);
      assertSafe(result);
    });
  }
});
