import assert from "node:assert/strict";
import test from "node:test";
import { checkProductionPlay, runCli } from "../scripts/check-production-play.mjs";

const env = {
  CLOUDFLARE_API_TOKEN: "private_cloudflare_token",
  CLOUDFLARE_ACCOUNT_ID: "a".repeat(32),
  D1_DATABASE_ID: "bbbbbbbb-cccc-dddd-eeee-ffffffffffff",
  API_ORIGIN: "https://api.example.test",
};
const token = "t".repeat(43);
const secret = "PRIVATE_SOLUTION_MUST_NOT_BE_PRINTED";
const date = "2026-10-15";
const attemptUuid = "22222222-2222-4222-8222-222222222222";
function solution() {
  return {
    retraction: {
      currentSquare: "f3",
      previousSquare: "g1",
      movedPiece: { color: "w", type: "n" },
      restoredPiece: null,
      special: "normal",
    },
    previousFen: secret,
    forwardSan: "Nf3",
    explanation: secret,
    historyConstraints: [],
  };
}
function daily(solved = false, count = 2) {
  return {
    id: "synthetic-case",
    date,
    title: "Synthetic",
    puzzles: Array.from({ length: count }, (_, i) => ({
      id: `synthetic-puzzle-${i}`,
      version: 1,
      title: "Synthetic",
      prompt: "Synthetic",
      postFen: "synthetic-fen",
      retractingColor: "w",
      maxHints: 2,
      provenance: "Synthetic fixture",
      license: "Test fixture only",
    })),
    solvedPuzzleIds: solved ? ["synthetic-puzzle-0"] : [],
  };
}
function expectedStats(attempts = 0, count = 2) {
  const completed = attempts && count === 1 ? 1 : 0;
  return {
    attempts,
    hintsUsed: 0,
    solvedPuzzles: attempts ? 1 : 0,
    completedCases: completed,
    currentStreak: completed,
    bestStreak: completed,
    lastCompletedDate: completed ? date : null,
  };
}
function harness({ override, count = 2 } = {}) {
  const requests = [];
  let attempts = 0;
  let submissions = 0;
  const deps = {
    now: () => new Date(`${date}T12:00:00Z`),
    uuid: () => attemptUuid,
    fetch: async (url, options) => {
      const path = new URL(url).pathname;
      const isD1 = new URL(url).hostname === "api.cloudflare.com";
      const request = { url, path, isD1, ...options };
      requests.push(request);
      let status = 200;
      let payload;
      const headers = { "access-control-allow-origin": "https://agent-axiom.github.io" };
      if (isD1)
        payload = {
          success: true,
          result: [
            {
              success: true,
              results: [
                {
                  case_id: "synthetic-case",
                  puzzle_id: "synthetic-puzzle-0",
                  solution_json: JSON.stringify(solution()),
                },
              ],
            },
          ],
        };
      else if (path === "/v1/sessions/guest") {
        status = 201;
        payload = { kind: "guest", token, expiresAt: "2027-01-01T00:00:00Z" };
      } else if (path === "/v1/me") payload = { kind: "guest", profile: null };
      else if (path === "/v1/daily") payload = daily(attempts > 0, count);
      else if (path === "/v1/me/stats") payload = expectedStats(attempts, count);
      else if (path === "/v1/attempts") {
        status = submissions++ === 0 ? 201 : 200;
        attempts = 1;
        if (status === 200) headers["idempotency-replayed"] = "true";
        payload = {
          id: "33333333-3333-4333-8333-333333333333",
          attemptUuid,
          correct: true,
          reveal: solution(),
        };
      } else throw new Error("Unexpected request");
      return override
        ? override(request, payload, status, headers)
        : new Response(JSON.stringify(payload), { status, headers });
    },
  };
  return { requests, deps, run: (bindings = env) => checkProductionPlay(bindings, deps) };
}
function assertSafe(value) {
  const text = JSON.stringify(value);
  for (const privateValue of [
    token,
    secret,
    attemptUuid,
    env.CLOUDFLARE_API_TOKEN,
    env.CLOUDFLARE_ACCOUNT_ID,
    env.D1_DATABASE_ID,
    "synthetic-puzzle",
    "previousFen",
    "retraction",
  ]) {
    assert.equal(text.includes(privateValue), false);
  }
}

test("synthetic guest solve and replay preserve progress without private output", async () => {
  const check = harness();
  const result = await check.run();
  assert.deepEqual(result, {
    ok: true,
    date,
    puzzlesSolved: 1,
    attempts: 1,
    idempotencyVerified: true,
  });
  assertSafe(result);
  assert.equal(check.requests.length, 10);
  const d1 = check.requests.find((r) => r.isD1);
  const query = JSON.parse(d1.body);
  assert.match(query.sql, /^SELECT /);
  assert.match(query.sql, /cp.position = 1 AND s.sort_order = 1/);
  assert.match(query.sql, /LIMIT 1$/);
  assert.doesNotMatch(
    query.sql,
    /\b(INSERT|UPDATE|DELETE|REPLACE|DROP|PRAGMA|players|sessions|attempts)\b|;/i,
  );
  assert.deepEqual(query.params, [date]);
  const posts = check.requests.filter((r) => r.path === "/v1/attempts");
  assert.equal(posts.length, 2);
  assert.equal(posts[0].body, posts[1].body);
  assert.deepEqual(JSON.parse(posts[0].body).retraction, solution().retraction);
  for (const request of check.requests) {
    assert.equal(request.redirect, "error");
    assert.ok(request.signal instanceof AbortSignal);
    if (request.isD1) {
      assert.equal(request.headers.authorization, `Bearer ${env.CLOUDFLARE_API_TOKEN}`);
    } else if (request.path !== "/v1/sessions/guest") {
      assert.equal(request.headers.authorization, `Bearer ${token}`);
    }
    assert.equal(request.url.includes(token), false);
  }
});
test("a one-puzzle case also verifies completion and streak statistics", async () => {
  assert.equal((await harness({ count: 1 }).run()).ok, true);
});
test("bindings and destinations are rejected before creating a guest", async (t) => {
  for (const patch of [
    { API_ORIGIN: "http://api.example.test" },
    { API_ORIGIN: "https://user:secret@api.test" },
    { API_ORIGIN: "https://api.test/path" },
    { CLOUDFLARE_API_TOKEN: "" },
    { CLOUDFLARE_ACCOUNT_ID: secret },
    { D1_DATABASE_ID: secret },
  ]) {
    await t.test(Object.keys(patch)[0], async () => {
      const check = harness();
      await assert.rejects(check.run({ ...env, ...patch }));
      assert.equal(check.requests.length, 0);
    });
  }
});
test("upstream errors, daily leakage and replay regressions have safe failures", async (t) => {
  const cases = [
    [
      "transport",
      () => {
        throw new Error(`${secret} ${token}`);
      },
      "API_TRANSPORT_FAILED",
    ],
    ["HTTP", () => new Response(secret, { status: 500 }), "API_HTTP_FAILED"],
    [
      "JSON",
      (_request, _payload, status, headers) => new Response(secret, { status, headers }),
      "API_INVALID_JSON",
    ],
    [
      "private daily",
      (r, p, status, headers) => {
        if (r.path === "/v1/daily") p.puzzles[0].acceptedSolutions = [solution()];
        return new Response(JSON.stringify(p), { status, headers });
      },
      "PUBLIC_DAILY_FAILED",
    ],
    [
      "D1 failure",
      (r, p, status, headers) => {
        if (r.isD1) p = { success: false, errors: [secret] };
        return new Response(JSON.stringify(p), { status, headers });
      },
      "D1_SOLUTION_FAILED",
    ],
    [
      "wrong reveal",
      (r, p, status, headers) => {
        if (r.path === "/v1/attempts") p.reveal.explanation = "wrong";
        return new Response(JSON.stringify(p), { status, headers });
      },
      "CORRECT_ATTEMPT_FAILED",
    ],
    [
      "replay duplicates stats",
      (r, p, status, headers) => {
        if (r.path === "/v1/me/stats" && p.attempts === 1) p.attempts = 2;
        return new Response(JSON.stringify(p), { status, headers });
      },
      "GUEST_STATS_FAILED",
    ],
    [
      "replay header",
      (r, p, status, headers) => {
        if (r.path === "/v1/attempts" && status === 200) delete headers["idempotency-replayed"];
        return new Response(JSON.stringify(p), { status, headers });
      },
      "IDEMPOTENCY_FAILED",
    ],
  ];
  for (const [name, override, code] of cases) {
    await t.test(name, async () => {
      const output = [];
      const check = harness({ override });
      const status = await runCli([], env, {
        ...check.deps,
        log: (v) => output.push(v),
        errorLog: (v) => output.push(v),
      });
      assert.equal(status, 1);
      assert.equal(output.length, 1);
      assert.deepEqual(JSON.parse(output[0]), { ok: false, code });
      assertSafe(output[0]);
      if (name === "private daily")
        assert.equal(
          check.requests.some((r) => r.isD1),
          false,
        );
    });
  }
});
