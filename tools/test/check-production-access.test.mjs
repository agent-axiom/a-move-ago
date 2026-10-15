import assert from "node:assert/strict";
import test from "node:test";
import { checkProductionAccess, runCli } from "../scripts/check-production-access.mjs";

const env = {
  CLOUDFLARE_API_TOKEN: "cloudflare_private_token",
  CLOUDFLARE_ACCOUNT_ID: "a".repeat(32),
  D1_DATABASE_ID: "bbbbbbbb-cccc-dddd-eeee-ffffffffffff",
  TELEGRAM_BOT_TOKEN: "123456789:telegram_private_token",
};
const sensitive = "PRIVATE_RESPONSE_MUST_NOT_REACH_LOGS";
const now = () => new Date("2026-10-31T23:59:59.999Z");
const row = {
  date: "2026-10-31",
  status: "published",
  puzzle_count: 3,
  published_puzzle_count: 2,
};
const archivedRow = {
  date: "2026-09-10",
  status: "published",
  puzzle_count: 2,
  published_puzzle_count: 2,
};

function harness({ d1Rows = [row, archivedRow], override } = {}) {
  const requests = [];
  return {
    requests,
    run: (bindings = env) =>
      checkProductionAccess(bindings, {
        now,
        fetch: async (url, options) => {
          const service = new URL(url).hostname === "api.cloudflare.com" ? "d1" : "telegram";
          const request = { url, ...options, service };
          requests.push(request);
          const payload =
            service === "d1"
              ? { success: true, result: [{ success: true, results: d1Rows }] }
              : { ok: true, result: { is_bot: true, id: 123456789, username: "example_bot" } };
          return override
            ? await override(request, payload)
            : new Response(JSON.stringify(payload));
        },
      }),
  };
}

function assertSafe(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  for (const secret of [...Object.values(env), sensitive, "example_bot", "api.telegram.org/bot"]) {
    assert.equal(
      text.includes(secret),
      false,
      "diagnostics must not contain credentials or payloads",
    );
  }
}

test("both services confirm access and return only dates, statuses and aggregate counts", async () => {
  const check = harness();
  const result = await check.run();
  assert.equal(result.ok, true);
  assert.deepEqual(result.telegram, { ok: true });
  assert.equal(result.d1.coverage.length, 15);
  assert.deepEqual(result.d1.coverage[0], {
    date: "2026-10-31",
    status: "published",
    puzzleCount: 3,
    publishedPuzzleCount: 2,
  });
  assert.deepEqual(result.d1.coverage[14], {
    date: "2026-11-14",
    status: "missing",
    puzzleCount: 0,
    publishedPuzzleCount: 0,
  });
  assert.equal(result.d1.archiveCoverage.length, 35);
  assert.deepEqual(result.d1.archiveCoverage[0], {
    date: "2026-09-10",
    status: "published",
    puzzleCount: 2,
    publishedPuzzleCount: 2,
  });
  assert.deepEqual(result.d1.archiveCoverage[34], {
    date: "2026-10-14",
    status: "missing",
    puzzleCount: 0,
    publishedPuzzleCount: 0,
  });
  assertSafe(result);
  assert.equal(check.requests.length, 2);
  const [d1, telegram] = check.requests;
  assert.equal(d1.method, "POST");
  assert.equal(d1.headers.authorization, `Bearer ${env.CLOUDFLARE_API_TOKEN}`);
  const { sql, params } = JSON.parse(d1.body);
  assert.deepEqual(params, ["2026-10-31", "2026-11-14", "2026-09-10", "2026-10-14"]);
  assert.match(sql, /^SELECT /);
  assert.doesNotMatch(sql, /\b(INSERT|UPDATE|DELETE|REPLACE|DROP|ALTER|PRAGMA|ATTACH)\b|;/i);
  assert.doesNotMatch(
    sql,
    /\b(players|sessions|attempts|puzzle_solutions|solution_json|public_json)\b/i,
  );
  assert.match(sql, /LIMIT 50$/);
  assert.match(sql, /WHERE \(c.case_date >= \? AND c.case_date <= \?\)\n\s+OR \(/);
  assert.equal(telegram.method, "GET");
  assert.equal(telegram.url, `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getMe`);
  assert.equal(telegram.body, undefined);
  assert.equal(telegram.headers.authorization, undefined);
  for (const request of check.requests) {
    assert.equal(request.redirect, "error");
    assert.equal(request.cache, "no-store");
    assert.ok(request.signal instanceof AbortSignal);
  }
});

test("missing or invalid bindings fail before any requests", async (t) => {
  const cases = Object.keys(env).map((key) => [key, { ...env, [key]: "" }]);
  cases.push(
    ["unsafe Cloudflare token", { ...env, CLOUDFLARE_API_TOKEN: `${sensitive}\r\nLeak: value` }],
    ["invalid account", { ...env, CLOUDFLARE_ACCOUNT_ID: sensitive }],
    ["invalid database", { ...env, D1_DATABASE_ID: "bbbbbbbb-cccc-dddd-eeee-zzzzzzzzzzzz" }],
    ["unsafe bot token", { ...env, TELEGRAM_BOT_TOKEN: "123:token/../../malicious" }],
  );
  for (const [name, bindings] of cases) {
    await t.test(name, async () => {
      const check = harness();
      await assert.rejects(check.run(bindings), (error) => {
        assert.match(error.message, /^(MISSING_REQUIRED_BINDINGS|INVALID_[A-Z0-9_]+)$/);
        assertSafe(error.message);
        return true;
      });
      assert.equal(check.requests.length, 0);
    });
  }
});

test("32-character and UUID database IDs are both supported", async () => {
  assert.equal((await harness().run({ ...env, D1_DATABASE_ID: "b".repeat(32) })).ok, true);
});

test("service failures are fixed diagnostics and do not prevent the other access check", async (t) => {
  for (const service of ["d1", "telegram"]) {
    const prefix = service.toUpperCase();
    for (const [name, response, code] of [
      [
        "transport",
        () => Promise.reject(new Error(`${sensitive} ${env.TELEGRAM_BOT_TOKEN}`)),
        `${prefix}_TRANSPORT_FAILED`,
      ],
      ["HTTP", () => new Response(sensitive, { status: 403 }), `${prefix}_HTTP_FAILED`],
      ["invalid JSON", () => new Response(sensitive), `${prefix}_INVALID_JSON`],
      [
        "interrupted body",
        () => ({ status: 200, json: () => Promise.reject(new Error(sensitive)) }),
        `${prefix}_INVALID_JSON`,
      ],
      [
        "API rejection",
        () => new Response(JSON.stringify({ success: false, ok: false, errors: [sensitive] })),
        service === "d1" ? "D1_QUERY_FAILED" : "TELEGRAM_ACCESS_FAILED",
      ],
    ]) {
      await t.test(`${service} ${name}`, async () => {
        const check = harness({
          override: (request, payload) =>
            request.service === service ? response() : new Response(JSON.stringify(payload)),
        });
        const result = await check.run();
        assert.equal(result.ok, false);
        assert.deepEqual(result[service], { ok: false, code });
        assert.equal(result[service === "d1" ? "telegram" : "d1"].ok, true);
        assert.equal(check.requests.length, 2);
        assertSafe(result);
      });
    }
  }
});

test("malformed coverage cannot echo sensitive fields or misleading dates and counts", async (t) => {
  for (const [name, rows] of [
    ["invalid status", [{ ...row, status: sensitive }]],
    ["out of range date", [{ ...row, date: "2026-11-15" }]],
    ["date before archive", [{ ...row, date: "2026-09-09" }]],
    ["gap between archive and current coverage", [{ ...row, date: "2026-10-20" }]],
    ["duplicate date", [row, row]],
    ["invalid count", [{ ...row, puzzle_count: sensitive }]],
    ["negative count", [{ ...row, puzzle_count: -1 }]],
    ["excess published count", [{ ...row, published_puzzle_count: 4 }]],
    ["null row", [null]],
    ["malformed rows", { private: sensitive }],
  ]) {
    await t.test(name, async () => {
      const result = await harness({ d1Rows: rows }).run();
      assert.deepEqual(result.d1, { ok: false, code: "D1_INVALID_RESPONSE" });
      assertSafe(result);
    });
  }
  const result = await harness({ d1Rows: [{ ...row, solution: sensitive }] }).run();
  assert.equal(result.d1.ok, true);
  assertSafe(result);
});

test("CLI failures print only safe diagnostic codes", async () => {
  for (const args of [[], [sensitive]]) {
    const logs = [];
    const errors = [];
    const status = await runCli(
      args,
      { CLOUDFLARE_API_TOKEN: env.CLOUDFLARE_API_TOKEN },
      {
        log: (line) => logs.push(line),
        errorLog: (line) => errors.push(line),
      },
    );
    assert.equal(status, 1);
    assert.deepEqual(logs, []);
    assert.equal(errors.length, 1);
    assert.deepEqual(JSON.parse(errors[0]), {
      ok: false,
      code: args.length === 0 ? "MISSING_REQUIRED_BINDINGS" : "UNEXPECTED_ARGUMENTS",
    });
    assertSafe(errors[0]);
  }
});
