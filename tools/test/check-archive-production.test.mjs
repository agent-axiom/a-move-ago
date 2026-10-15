import assert from "node:assert/strict";
import test from "node:test";
import { checkArchiveCoverage } from "../scripts/check-archive-production.mjs";

const options = { apiOrigin: "https://api.example.test", webOrigin: "https://game.example.test",
  from: "2026-09-10", through: "2026-09-11" };
const token = "a".repeat(43);
const secret = "PRIVATE_RESPONSE_MUST_STAY_PRIVATE";
const now = () => new Date("2026-10-15T12:00:00Z");

function harness(mutate = () => {}, override) {
  const cases = ["2026-09-11", "2026-09-10"].map((date) => ({
    id: `case-${date}`, date, slug: `case-${date}`, title: "A synthetic case",
    puzzleCount: 1, solvedPuzzles: 0, completed: false,
  }));
  const catalog = { today: "2026-10-15", startsOn: "2026-09-10", cases };
  const payloads = {
    "/v1/sessions/guest": { kind: "guest", token, expiresAt: "2026-10-16T00:00:00Z" },
    "/v1/archive": catalog,
  };
  for (const item of cases) {
    payloads[`/v1/daily?date=${item.date}`] = {
      id: item.id, date: item.date, title: item.title, solvedPuzzleIds: [],
      puzzles: [{ id: "synthetic", version: 1, title: "A synthetic puzzle", prompt: "Find the move.",
        postFen: "8/8/8/8/8/8/8/K6k w - - 0 1", retractingColor: "b", maxHints: 0,
        provenance: "Synthetic diagnostic fixture", license: "CC0-1.0" }],
    };
  }
  mutate(payloads);
  const requests = [];
  return {
    requests,
    run: (input = options) => checkArchiveCoverage(input, { now, fetch: async (url, init) => {
      const path = new URL(url).pathname + new URL(url).search;
      requests.push({ path, ...init });
      const response = new Response(JSON.stringify(payloads[path]), {
        status: init.method === "POST" ? 201 : 200,
        headers: { "access-control-allow-origin": options.webOrigin, "cache-control": "no-store" },
      });
      return override ? override(path, response) : response;
    } }),
  };
}

test("archive release verifies the catalog and every date without returning content or credentials", async () => {
  const check = harness();
  assert.deepEqual(await check.run(), { ok: true, from: options.from, through: options.through,
    cases: 2, puzzles: 2 });
  assert.deepEqual(check.requests.map((request) => request.path), [
    "/v1/sessions/guest", "/v1/archive", "/v1/daily?date=2026-09-10", "/v1/daily?date=2026-09-11",
  ]);
  for (const request of check.requests) {
    assert.equal(request.headers.authorization, request.method === "POST" ? undefined : `Bearer ${token}`);
    assert.equal(request.headers.origin, options.webOrigin);
    assert.equal(request.redirect, "error");
    assert.equal(request.cache, "no-store");
    assert.ok(request.signal instanceof AbortSignal);
  }
});

test("archive dates and destination are validated before creating a session", async (t) => {
  for (const patch of [
    { from: "2026-09-31" }, { through: "2026-10-15" }, { from: "2026-09-12" },
    { from: "2026-01-01" }, { apiOrigin: "https://api.example.test/other" },
  ]) await t.test(JSON.stringify(patch), async () => {
    const check = harness();
    await assert.rejects(() => check.run({ ...options, ...patch }));
    assert.equal(check.requests.length, 0);
  });
});

test("missing, future, personal or private responses cannot pass archive publication", async (t) => {
  const changes = [
    ["missing day", (p) => { p["/v1/archive"].cases.pop(); }, "ARCHIVE_CATALOG_FAILED"],
    ["missing coverage", (p) => { p["/v1/archive"].cases.shift(); }, "ARCHIVE_MISSING_DATES"],
    ["future day", (p) => { p["/v1/archive"].cases[0].date = "2026-10-16"; }, "ARCHIVE_CATALOG_FAILED"],
    ["inherited progress", (p) => { p["/v1/archive"].cases[0].solvedPuzzles = 1; }, "ARCHIVE_CATALOG_FAILED"],
    ["wrong daily", (p) => { p["/v1/daily?date=2026-09-10"].date = "2026-09-11"; }, "ARCHIVE_DAILY_FAILED"],
    ["private daily", (p) => { p["/v1/daily?date=2026-09-10"].puzzles[0].acceptedSolutions = secret; }, "ARCHIVE_PRIVATE_FIELDS"],
    ["nested private catalog", (p) => { p["/v1/archive"].debug = { previousFen: secret }; }, "ARCHIVE_PRIVATE_FIELDS"],
    ["expired guest", (p) => { p["/v1/sessions/guest"].expiresAt = "2026-01-01"; }, "ARCHIVE_SESSION_FAILED"],
  ];
  for (const [name, change, expected] of changes) await t.test(name, async () => {
    await assert.rejects(harness(change).run, (error) => {
      assert.equal(error.message, expected);
      assert.equal(error.message.includes(secret), false);
      assert.equal(error.message.includes(token), false);
      return true;
    });
  });
});

test("upstream failures remain fixed diagnostics", async (t) => {
  for (const [name, override, code] of [
    ["transport", () => { throw new Error(secret); }, "ARCHIVE_TRANSPORT_FAILED"],
    ["body", (_path, response) => ({ ...response, status: response.status, headers: response.headers,
      json: () => { throw new Error(secret); } }), "ARCHIVE_JSON_FAILED"],
    ["CORS", (_path, response) => { response.headers.delete("access-control-allow-origin"); return response; }, "ARCHIVE_CORS_FAILED"],
    ["cache", (_path, response) => { response.headers.set("cache-control", "public"); return response; }, "ARCHIVE_CACHE_FAILED"],
    ["HTTP", (_path, response) => new Response(secret, { status: 500, headers: response.headers }), "ARCHIVE_HTTP_FAILED"],
  ]) await t.test(name, async () => {
    await assert.rejects(harness(undefined, override).run, { message: code });
  });
});
